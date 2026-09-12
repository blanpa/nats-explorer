package subscription

import (
	"time"

	"github.com/nats-io/nats.go"
)

// Changing the subscriptions of a running connection used to stop the
// manager and start it over, which threw away the subject tree, the counters
// and the recorded history of everything, including the patterns that did
// not change.
//
// Nothing is thrown away now. The tree is what this connection has seen, not
// what it is listening to at this instant: a subject that arrived is a fact,
// and narrowing the patterns is not a statement that it never happened.
// Subjects no longer covered simply stop growing -- their rate falls to zero
// and their messages stay readable. Emptying the tree is its own action, and
// asks first.

// SetSubjects replaces the subscribed patterns on a running manager. Every
// subject keeps its history, counters and tree node, covered or not. A
// manager that is not running is started instead.
func (m *Manager) SetSubjects(nc *nats.Conn, subjects []string) error {
	// No patterns means no subscriptions: everything collected so far is
	// forgotten below and nothing new arrives until one is added.
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return m.Start(nc, subjects)
	}
	old := m.subs
	oldPatterns := m.patternList()
	m.subs = nil
	stopCh := m.stopCh

	// Counters of a pattern that stays survive the change.
	byPattern := make(map[string]*patternStat, len(oldPatterns))
	for _, p := range oldPatterns {
		byPattern[p.pattern] = p
	}
	m.Subjects = subjects
	patterns := make([]*patternStat, len(subjects))
	for i, subj := range subjects {
		if kept := byPattern[subj]; kept != nil {
			patterns[i] = kept
		} else {
			patterns[i] = &patternStat{pattern: subj}
		}
	}
	m.patterns.Store(&patterns)
	m.mu.Unlock()

	// Unsubscribe first: a message that arrives in between would be counted
	// against a pattern that is about to disappear.
	for _, sub := range old {
		sub.Unsubscribe()
	}

	var subs []*nats.Subscription
	for i, subj := range subjects {
		ps := patterns[i]
		sub, err := nc.Subscribe(subj, func(msg *nats.Msg) {
			m.shardOf(msg.Subject).enqueue(delivery{msg: msg, ps: ps, seq: uint64(m.totalRecv.Add(1)), now: time.Now().UnixMilli()}, stopCh)
		})
		if err != nil {
			for _, s := range subs {
				s.Unsubscribe()
			}
			return err
		}
		subs = append(subs, sub)
	}
	m.mu.Lock()
	m.subs = subs
	m.mu.Unlock()

	m.emitTree()
	return nil
}

// Forget drops named subjects from the shards, the tree and the counters,
// without touching the history; the caller has already cleared that. Used
// when someone clears the history of a subject: the tree should start over
// with it as well.
func (m *Manager) Forget(subjects []string) {
	if len(subjects) == 0 {
		return
	}
	wanted := make(map[string]struct{}, len(subjects))
	for _, s := range subjects {
		wanted[s] = struct{}{}
	}
	var gone []string
	for _, sh := range m.shards {
		sh.mu.Lock()
		for subject := range sh.subjects {
			if _, ok := wanted[subject]; !ok {
				continue
			}
			gone = append(gone, subject)
			delete(sh.subjects, subject)
			delete(sh.active, subject)
		}
		if len(gone) > 0 && len(sh.dirty) > 0 {
			kept := sh.dirty[:0]
			for _, subject := range sh.dirty {
				if _, isGone := wanted[subject]; !isGone {
					kept = append(kept, subject)
				}
			}
			sh.dirty = kept
		}
		sh.mu.Unlock()
	}
	if len(gone) == 0 {
		return
	}
	m.recountSubjects()
	m.mu.Lock()
	for _, subject := range gone {
		m.tree.remove(subject)
	}
	for _, cl := range m.clients {
		cl.view.dirty = true
	}
	m.mu.Unlock()
	m.emitTree()
}

// recountSubjects sets the counter from what the shards actually hold.
// Subtracting is easy to get wrong when subjects come back between two
// removals, and the count is read once a second, not per message.
func (m *Manager) recountSubjects() {
	var n int64
	for _, sh := range m.shards {
		sh.mu.Lock()
		n += int64(len(sh.subjects))
		sh.mu.Unlock()
	}
	m.subjectCount.Store(n)
}

// ForgetAll empties the tree, the per-subject counters and the pattern
// counters of a running connection, as if it had just been opened. Clearing
// the recorded history has to take the tree with it: a row that says three
// thousand messages with nothing behind it is worse than an empty tree.
// The subscriptions stay, so the next message rebuilds what still sends.
func (m *Manager) ForgetAll() {
	for _, sh := range m.shards {
		sh.mu.Lock()
		sh.subjects = make(map[string]*SubjectStats)
		sh.dirty = nil
		sh.active = make(map[string]struct{})
		sh.mu.Unlock()
	}
	m.subjectCount.Store(0)
	for _, p := range m.patternList() {
		p.subjects.Store(0)
	}

	m.mu.Lock()
	m.tree = newTree()
	for _, cl := range m.clients {
		// Everything the tab knows is gone, so it is told from scratch
		// instead of being sent a removal per subject.
		cl.view.needFull = true
	}
	m.mu.Unlock()
	m.emitTree()
}
