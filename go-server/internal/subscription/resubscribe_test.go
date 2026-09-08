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
func TestForgetUnmatchedKeepsTheRest(t *testing.T) {
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

	if got := len(m.History.Subject("c1", "orders.new", 10, 0)); got != 1 {
		t.Fatalf("history before the change = %d", got)
	}

	// Adding a pattern keeps everything.
	m.mu.Lock()
	m.Subjects = []string{"orders.>", "temp.>", "alarms.>"}
	m.mu.Unlock()
	m.forgetUnmatched(m.Subjects)
	if got := len(m.History.Subject("c1", "orders.new", 10, 0)); got != 1 {
		t.Fatalf("adding a pattern dropped the history of orders.new (%d left)", got)
	}
	if got := len(m.History.Subject("c1", "temp.line1", 10, 0)); got != 1 {
		t.Fatalf("adding a pattern dropped the history of temp.line1 (%d left)", got)
	}
	m.mu.Lock()
	_, treeHasTemp := m.tree.nodes["temp.line1"]
	m.mu.Unlock()
	if !treeHasTemp {
		t.Fatal("adding a pattern removed a subject from the tree")
	}

	// Removing one takes its subjects and nothing else.
	m.forgetUnmatched([]string{"orders.>"})
	if got := len(m.History.Subject("c1", "temp.line1", 10, 0)); got != 0 {
		t.Errorf("temp.line1 should be gone, %d messages left", got)
	}
	if got := len(m.History.Subject("c1", "orders.new", 10, 0)); got != 1 {
		t.Errorf("orders.new must survive, %d messages left", got)
	}
	m.mu.Lock()
	_, stillThere := m.tree.nodes["temp.line1"]
	_, rootGone := m.tree.nodes["temp"]
	_, ordersThere := m.tree.nodes["orders.new"]
	m.mu.Unlock()
	if stillThere || rootGone {
		t.Error("the tree still carries the dropped subject or its empty branch")
	}
	if !ordersThere {
		t.Error("the tree lost a subject that is still subscribed")
	}
	if n := m.subjectCount.Load(); n != 2 {
		t.Errorf("subject count = %d, want 2", n)
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
