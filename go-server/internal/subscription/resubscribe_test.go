package subscription

import (
	"testing"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
)

// feed pushes one message through the shard path, as a subscription would.
func feedManager(t *testing.T, m *Manager, subject, payload string, seq uint64) {
	t.Helper()
	ps := m.patternList()[0]
	sh := m.shardOf(subject)
	m.process(sh, delivery{msg: &nats.Msg{Subject: subject, Data: []byte(payload)}, ps: ps, seq: seq, now: 1000})
}

// Changing the subscriptions must only cost the subjects that no pattern
// covers any more: adding one keeps everything, removing one takes its own.
// Narrowing the patterns must not erase what was already seen. The tree is
// what this connection has received, not what it is listening to at this
// instant: a subject that arrived is a fact, and unsubscribing is not a
// statement that it never happened.
func TestSetSubjectsKeepsWhatWasSeen(t *testing.T) {
	m := NewManager("c1")
	m.History = history.NewMemStore(0, 0)
	m.mu.Lock()
	m.running = true
	m.stopCh = make(chan struct{})
	m.Subjects = []string{"orders.>", "temp.>"}
	patterns := []*patternStat{{pattern: "orders.>"}, {pattern: "temp.>"}}
	m.patterns.Store(&patterns)
	m.mu.Unlock()

	feedManager(t, m, "orders.new", `{"id":1}`, 1)
	feedManager(t, m, "orders.paid", `{"id":2}`, 2)
	feedManager(t, m, "temp.line1", `{"c":21}`, 3)
	m.mu.Lock()
	m.syncTree(1000)
	m.tree.refresh()
	m.mu.Unlock()

	has := func(subject string) bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		_, ok := m.tree.nodes[subject]
		return ok
	}
	messages := func(subject string) int { return len(m.History.Subject("c1", subject, 10, 0)) }

	if messages("orders.new") != 1 || !has("temp.line1") {
		t.Fatal("the manager did not collect what the test needs")
	}

	ns := startNATS(t)
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()

	// Dropping temp.> leaves everything it collected in place.
	if err := m.SetSubjects(nc, []string{"orders.>"}); err != nil {
		t.Fatal(err)
	}
	if got := messages("temp.line1"); got != 1 {
		t.Errorf("unsubscribing dropped the history of temp.line1 (%d left)", got)
	}
	if !has("temp.line1") || !has("temp") {
		t.Error("unsubscribing removed the subject from the tree")
	}
	if !has("orders.new") {
		t.Error("a subject that is still subscribed left the tree")
	}
	if n := m.subjectCount.Load(); n != 3 {
		t.Errorf("subject count = %d, want all 3 that were seen", n)
	}

	// And removing every pattern keeps the lot.
	if err := m.SetSubjects(nc, nil); err != nil {
		t.Fatal(err)
	}
	if !has("orders.new") || !has("temp.line1") || messages("orders.new") != 1 {
		t.Error("removing every pattern emptied the tree")
	}
}

// A pattern that stays keeps the counters it collected.
func TestSetSubjectsKeepsPatternCounters(t *testing.T) {
	m := NewManager("c1")
	m.mu.Lock()
	m.running = true
	m.stopCh = make(chan struct{})
	m.Subjects = []string{"orders.>"}
	patterns := []*patternStat{{pattern: "orders.>"}}
	m.patterns.Store(&patterns)
	kept := patterns[0]
	m.mu.Unlock()
	kept.received.Add(42)
	kept.subjects.Add(3)

	// The same swap SetSubjects performs, without a NATS connection.
	m.mu.Lock()
	byPattern := map[string]*patternStat{}
	for _, p := range m.patternList() {
		byPattern[p.pattern] = p
	}
	next := []string{"orders.>", "alarms.>"}
	swapped := make([]*patternStat, len(next))
	for i, subj := range next {
		if p := byPattern[subj]; p != nil {
			swapped[i] = p
		} else {
			swapped[i] = &patternStat{pattern: subj}
		}
	}
	m.patterns.Store(&swapped)
	m.Subjects = next
	stats := m.statsLocked()
	m.mu.Unlock()

	if len(stats.Patterns) != 2 {
		t.Fatalf("patterns = %+v", stats.Patterns)
	}
	for _, p := range stats.Patterns {
		switch p.Pattern {
		case "orders.>":
			if p.Received != 42 {
				t.Errorf("a pattern that stays lost its counter: %+v", p)
			}
		case "alarms.>":
			if p.Received != 0 {
				t.Errorf("a new pattern starts at zero, got %+v", p)
			}
		}
	}
}

func TestTreeRemove(t *testing.T) {
	tr := newTree()
	tr.observe("a.b.c", 1, 0, &message.Record{Subject: "a.b.c"})
	tr.observe("a.b.d", 1, 0, &message.Record{Subject: "a.b.d"})
	tr.observe("x", 1, 0, &message.Record{Subject: "x"})

	// A leaf goes; its branch stays as long as a sibling needs it.
	tr.remove("a.b.c")
	if _, ok := tr.nodes["a.b.c"]; ok {
		t.Error("the leaf is still there")
	}
	if _, ok := tr.nodes["a.b"]; !ok {
		t.Error("a branch with another child must stay")
	}
	// The last child takes the empty branches with it.
	tr.remove("a.b.d")
	for _, subject := range []string{"a.b.d", "a.b", "a"} {
		if _, ok := tr.nodes[subject]; ok {
			t.Errorf("%s should be gone", subject)
		}
	}
	if _, ok := tr.roots["a"]; ok {
		t.Error("the empty root is still listed")
	}
	if _, ok := tr.nodes["x"]; !ok {
		t.Error("an unrelated subject was removed")
	}
	tr.remove("nothing.here") // must not panic
}
