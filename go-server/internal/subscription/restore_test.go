package subscription

import (
	"path/filepath"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"

	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
)

func startNATS(t *testing.T) *natsserver.Server {
	t.Helper()
	ns, err := natsserver.NewServer(&natsserver.Options{Host: "127.0.0.1", Port: -1, NoLog: true, NoSigs: true})
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats-server did not start")
	}
	t.Cleanup(ns.Shutdown)
	return ns
}

// teeWith returns a history with a database holding the given messages, as a
// previous run would have left it behind.
func teeWith(t *testing.T, connID string, recorded map[string]int) *history.Tee {
	t.Helper()
	db, err := history.OpenDB(filepath.Join(t.TempDir(), "history.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	tee := history.NewTee(history.NewMemStore(0, 0))
	tee.SetDB(db)
	var seq uint64
	for subject, n := range recorded {
		for i := 0; i < n; i++ {
			seq++
			db.Enqueue(connID, &message.Record{Subject: subject, Data: []byte(`{"v":1}`), Timestamp: time.Now().UnixMilli(), Sequence: seq})
		}
	}
	db.Flush()
	return tee
}

func treeCounts(m *Manager) map[string]int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := map[string]int{}
	for subject, n := range m.tree.nodes {
		out[subject] = n.count
	}
	return out
}

// A restart starts with an empty tree, even though the messages are still on
// disk. The manager brings the recorded subjects back on connect, so the
// tree is there before the first message arrives and the counters continue
// instead of starting over.
func TestManagerRestoresSubjectsFromHistory(t *testing.T) {
	ns := startNATS(t)
	tee := teeWith(t, "c1", map[string]int{"a.x": 3, "a.y": 2, "b.z": 5})

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()

	m := NewManager("c1")
	m.History = tee
	if err := m.Start(nc, []string{">"}); err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	counts := treeCounts(m)
	if counts["a.x"] != 3 || counts["a.y"] != 2 || counts["b.z"] != 5 {
		t.Fatalf("restored counts = %v", counts)
	}
	// The branches are there too, with the subtree aggregates.
	m.mu.Lock()
	m.tree.refresh()
	total := m.tree.nodes["a"].total
	m.mu.Unlock()
	if total != 5 {
		t.Fatalf("branch a total = %d, want 5", total)
	}
	if got := m.GetStats().Subjects; got != 3 {
		t.Fatalf("subjects = %d, want 3", got)
	}
	// Nothing was received on this connection yet.
	if got := m.GetStats().Received; got != 0 {
		t.Fatalf("received = %d, want 0", got)
	}
	// The newest message comes back too: without it the tree shows a count
	// with nothing behind it, and the payload filter cannot judge the
	// subject at all.
	m.mu.RLock()
	last := m.tree.nodes["a.x"].last
	m.mu.RUnlock()
	if last == nil || string(last.Data) != `{"v":1}` {
		t.Fatalf("last message of a.x = %+v", last)
	}

	// A new message continues the count instead of restarting it.
	nc.Publish("a.x", []byte(`{"v":2}`))
	nc.Flush()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && treeCounts(m)["a.x"] < 4 {
		time.Sleep(20 * time.Millisecond)
	}
	if got := treeCounts(m)["a.x"]; got != 4 {
		t.Fatalf("a.x after one more message = %d, want 4", got)
	}
}

// Only what the subscription covers comes back: the database outlives the
// patterns a connection currently listens to.
func TestManagerRestoresOnlyCoveredSubjects(t *testing.T) {
	ns := startNATS(t)
	tee := teeWith(t, "c1", map[string]int{"a.x": 3, "b.z": 5})

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()

	m := NewManager("c1")
	m.History = tee
	if err := m.Start(nc, []string{"a.>"}); err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	counts := treeCounts(m)
	if counts["a.x"] != 3 {
		t.Fatalf("a.x not restored: %v", counts)
	}
	if _, ok := counts["b.z"]; ok {
		t.Fatalf("b.z is not covered by a.> but was restored: %v", counts)
	}
	if got := m.GetStats().Subjects; got != 1 {
		t.Fatalf("subjects = %d, want 1", got)
	}
	// The pattern's own counter knows about it.
	if p := m.GetStats().Patterns; len(p) != 1 || p[0].Subjects != 1 {
		t.Fatalf("pattern stats = %+v", p)
	}
}

// A memory-only history has nothing to bring back and must not break the connect.
func TestManagerWithoutDatabaseStartsEmpty(t *testing.T) {
	ns := startNATS(t)
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()

	m := NewManager("c1")
	m.History = history.NewTee(history.NewMemStore(0, 0))
	if err := m.Start(nc, []string{">"}); err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if got := m.GetStats().Subjects; got != 0 {
		t.Fatalf("subjects = %d, want 0", got)
	}
}
