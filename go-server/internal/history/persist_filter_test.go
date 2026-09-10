package history

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

// The filter decides what reaches the disk, never what the live view shows:
// a message it excludes still has to be in memory, because the tree and the
// feed describe what actually arrived.
func TestPersistFilterNarrowsDiskNotMemory(t *testing.T) {
	tee, p := persisting(t, PersistenceRequest{
		Enabled: true, Retention: time.Hour, FullText: true,
		Filter: `subject.startsWith("keep.")`,
	})
	defer p.Close()

	tee.Append("c1", rec("keep.a", `{"v":1}`, 1))
	tee.Append("c1", rec("drop.a", `{"v":2}`, 2))
	tee.Append("c1", rec("keep.b", `{"v":3}`, 3))

	for _, subject := range []string{"keep.a", "drop.a", "keep.b"} {
		if got := len(tee.Subject("c1", subject, 10, 0)); got != 1 {
			t.Fatalf("memory holds %d messages on %s, want the one that arrived", got, subject)
		}
	}
	db := tee.DB()
	db.Flush()
	msgs, err := db.RangeAll(context.Background(), "c1", 0, time.Now().Add(time.Minute).UnixMilli(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("persisted %d messages, want the 2 matching ones: %+v", len(msgs), msgs)
	}
	for _, m := range msgs {
		if m.Subject == "drop.a" {
			t.Fatalf("persisted %s, which the filter excludes", m.Subject)
		}
	}
	// What the filter left out is counted apart from what was dropped
	// because the writer fell behind: one is a choice, the other a loss.
	st := db.Stats()
	if st.Filtered != 1 || st.Dropped != 0 {
		t.Fatalf("stats filtered=%d dropped=%d, want 1 and 0", st.Filtered, st.Dropped)
	}
	if s := p.Status(); s.Filter != `subject.startsWith("keep.")` {
		t.Fatalf("status filter = %q", s.Filter)
	}
}

// An expression that does not compile leaves the setting as it was. It would
// be worse to switch the database off over a typo than to refuse the change.
func TestPersistFilterRejectsBadExpression(t *testing.T) {
	tee, p := persisting(t, PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true})
	defer p.Close()

	err := p.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true, Filter: "subject ==="})
	if err == nil {
		t.Fatal("a broken expression was accepted")
	}
	if tee.DB() == nil {
		t.Fatal("the database was closed by a rejected change")
	}
	if got := tee.PersistFilter(); got != "" {
		t.Fatalf("filter = %q after a rejected change, want none", got)
	}
	tee.Append("c1", rec("a.b", "1", 1))
	tee.DB().Flush()
	if n := tee.DB().Stats().Messages; n != 1 {
		t.Fatalf("messages = %d, want the append still persisted", n)
	}
}

// Clearing the expression puts the database back to keeping everything.
func TestPersistFilterCleared(t *testing.T) {
	tee, p := persisting(t, PersistenceRequest{
		Enabled: true, Retention: time.Hour, FullText: true, Filter: `subject.startsWith("keep.")`,
	})
	defer p.Close()

	if err := p.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true, Filter: "  "}); err != nil {
		t.Fatal(err)
	}
	tee.Append("c1", rec("drop.a", "1", 1))
	tee.DB().Flush()
	if n := tee.DB().Stats().Messages; n != 1 {
		t.Fatalf("messages = %d, want the message persisted after the filter was cleared", n)
	}
	if s := p.Status(); s.Filter != "" {
		t.Fatalf("status filter = %q, want empty", s.Filter)
	}
}

// The write buffer is a setting too: it is what decides whether a burst
// reaches the database, and it survives a restart with the rest of them.
func TestQueueBytesIsASetting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	tee := NewTee(NewMemStore(0, 0))
	var saved PersistenceConfig
	p, err := NewPersistence(tee, PersistenceOptions{
		Path: path, Retention: time.Hour, Enabled: true, FullText: true,
		Save: func(c PersistenceConfig) error { saved = c; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if got := tee.DB().QueueBytesLimit(); got != DefaultQueueBytes {
		t.Fatalf("initial budget = %d, want the default %d", got, DefaultQueueBytes)
	}
	if err := p.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true, QueueBytes: 8 << 20}); err != nil {
		t.Fatal(err)
	}
	if got := tee.DB().QueueBytesLimit(); got != 8<<20 {
		t.Fatalf("budget = %d, want 8 MB", got)
	}
	if saved.QueueBytes != 8<<20 {
		t.Fatalf("saved budget = %d", saved.QueueBytes)
	}
	if err := p.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true, QueueBytes: 1024}); err == nil {
		t.Fatal("a budget below the minimum was accepted")
	}
	if got := tee.DB().QueueBytesLimit(); got != 8<<20 {
		t.Fatalf("budget = %d after a rejected change, want it unchanged", got)
	}

	// A stored choice comes back the next time the server starts.
	var opts PersistenceOptions
	opts.ParseConfig(mustJSON(t, saved))
	if opts.QueueBytes != 8<<20 || opts.Filter != "" {
		t.Fatalf("parsed options = %+v", opts)
	}
}

// persisting builds a Tee with the database switched on as the request says.
func persisting(t *testing.T, req PersistenceRequest) (*Tee, *Persistence) {
	t.Helper()
	tee := NewTee(NewMemStore(0, 0))
	p, err := NewPersistence(tee, PersistenceOptions{
		Path:      filepath.Join(t.TempDir(), "history.db"),
		Retention: req.Retention,
		Enabled:   req.Enabled,
		FullText:  req.FullText,
		Filter:    req.Filter,
	})
	if err != nil {
		t.Fatal(err)
	}
	return tee, p
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
