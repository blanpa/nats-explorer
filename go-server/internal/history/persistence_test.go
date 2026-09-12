package history

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nats-explorer/internal/message"
)

func rec(subject, data string, seq uint64) *message.Record {
	return &message.Record{Subject: subject, Data: []byte(data), Timestamp: time.Now().UnixMilli(), Sequence: seq}
}

// The database can be opened and closed while the server runs, and what was
// written before it was closed is still there after it is opened again.
func TestPersistenceToggle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	tee := NewTee(NewMemStore(0, 0))
	var saved PersistenceConfig
	p, err := NewPersistence(tee, PersistenceOptions{
		Path:      path,
		Retention: time.Hour,
		Save:      func(c PersistenceConfig) error { saved = c; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	// Off by default: appends only reach memory.
	tee.Append("c1", rec("a.b", `{"v":1}`, 1))
	if st := p.Status(); st.Enabled || !st.Supported || st.Managed {
		t.Fatalf("initial status = %+v", st)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("database created while switched off: %v", err)
	}

	if err := p.Set(PersistenceRequest{Enabled: true, Retention: 2 * time.Hour, FullText: true, Purge: false}); err != nil {
		t.Fatal(err)
	}
	if !saved.Enabled || saved.Retention != "2h0m0s" || saved.FullText == nil || !*saved.FullText {
		t.Fatalf("saved = %+v", saved)
	}
	tee.Append("c1", rec("a.b", `{"v":2}`, 2))
	db := tee.DB()
	if db == nil {
		t.Fatal("no database after switching on")
	}
	db.Flush()
	from := time.Now().Add(-time.Minute).UnixMilli()
	msgs, err := db.Range(context.Background(), "c1", "a.b", false, from, time.Now().UnixMilli(), 10)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("range = %v %v (only what arrived after switching on is persisted)", msgs, err)
	}

	// Changing the retention keeps the same database.
	if err := p.Set(PersistenceRequest{Enabled: true, Retention: 30 * time.Minute, FullText: true, Purge: false}); err != nil {
		t.Fatal(err)
	}
	if tee.DB() != db || db.Retention() != 30*time.Minute {
		t.Fatalf("retention change reopened or did not apply: %s", db.Retention())
	}

	// Off again: the file stays, appends keep working.
	if err := p.Set(PersistenceRequest{Enabled: false, Retention: 30 * time.Minute, FullText: true, Purge: false}); err != nil {
		t.Fatal(err)
	}
	tee.Append("c1", rec("a.b", `{"v":3}`, 3))
	if tee.DB() != nil {
		t.Fatal("database still attached after switching off")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file removed without purge: %v", err)
	}
	if st := p.Status(); st.Enabled || st.DB != nil {
		t.Fatalf("status after switching off = %+v", st)
	}

	// On again: what was written before is still there.
	if err := p.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true, Purge: false}); err != nil {
		t.Fatal(err)
	}
	msgs, err = tee.DB().Range(context.Background(), "c1", "a.b", false, from, time.Now().UnixMilli(), 10)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("range after reopen = %v %v", msgs, err)
	}
}

// Switching off with purge removes the payloads from disk.
func TestPersistencePurge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	tee := NewTee(NewMemStore(0, 0))
	p, err := NewPersistence(tee, PersistenceOptions{Path: path, Retention: time.Hour, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	tee.Append("c1", rec("a.b", "x", 1))
	tee.DB().Flush()
	if err := p.Set(PersistenceRequest{Enabled: false, Retention: time.Hour, FullText: true, Purge: true}); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if _, err := os.Stat(path + suffix); !os.IsNotExist(err) {
			t.Fatalf("%s%s survived the purge: %v", path, suffix, err)
		}
	}
}

// HISTORY_DB owns the setting: the UI may look but not touch. An
// installation with nowhere to put a file says so instead of failing later.
func TestPersistenceNotEditable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	tee := NewTee(NewMemStore(0, 0))
	p, err := NewPersistence(tee, PersistenceOptions{Path: path, Retention: time.Hour, Managed: true, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if err := p.Set(PersistenceRequest{Enabled: false, Retention: time.Hour, FullText: true, Purge: false}); err != ErrManaged {
		t.Fatalf("managed Set = %v", err)
	}
	if st := p.Status(); !st.Managed || !st.Enabled || st.DB == nil {
		t.Fatalf("managed status = %+v", st)
	}

	none, err := NewPersistence(NewTee(NewMemStore(0, 0)), PersistenceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if st := none.Status(); st.Supported || st.Reason == "" {
		t.Fatalf("unsupported status = %+v", st)
	}
	if err := none.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true, Purge: false}); err != ErrUnsupported {
		t.Fatalf("unsupported Set = %v", err)
	}
}

// A stored choice overrides the defaults; a broken or out-of-range one is ignored.
func TestPersistenceParseConfig(t *testing.T) {
	base := PersistenceOptions{Retention: time.Hour}
	o := base
	o.ParseConfig(json.RawMessage(`{"enabled":true,"retention":"6h"}`))
	if !o.Enabled || o.Retention != 6*time.Hour {
		t.Fatalf("parsed = %+v", o)
	}
	o = base
	o.ParseConfig(json.RawMessage(`{"enabled":true,"retention":"nonsense"}`))
	if !o.Enabled || o.Retention != time.Hour {
		t.Fatalf("bad retention should keep the default: %+v", o)
	}
	o = base
	o.ParseConfig(json.RawMessage(`not json`))
	if o.Enabled || o.Retention != time.Hour {
		t.Fatalf("broken entry should change nothing: %+v", o)
	}
	o = base
	o.ParseConfig(json.RawMessage(`{"enabled":true,"retention":"1s"}`))
	if o.Retention != time.Hour {
		t.Fatalf("retention below the minimum should be ignored: %+v", o)
	}
}

// Retention outside the bounds is refused instead of emptying the database
// on the next cleanup tick.
func TestPersistenceRetentionBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	p, err := NewPersistence(NewTee(NewMemStore(0, 0)), PersistenceOptions{Path: path, Retention: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	for _, d := range []time.Duration{time.Second, 2 * MaxRetention} {
		if err := p.Set(PersistenceRequest{Enabled: true, Retention: d, FullText: true, Purge: false}); err == nil {
			t.Fatalf("retention %s accepted", d)
		}
	}
}

// The word index is what a search over the persistent history uses and what
// most of the write cost goes into. Switching it off must not leave a
// half-filled index answering searches with a subset.
func TestFullTextCanBeSwitched(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	tee := NewTee(NewMemStore(0, 0))
	p, err := NewPersistence(tee, PersistenceOptions{Path: path, Retention: time.Hour, Enabled: true, FullText: true})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	db := tee.DB()
	if !db.FullText() {
		t.Fatal("the index is on by default")
	}

	tee.Append("c1", rec("a.b", `{"note":"kalibriert"}`, 1))
	db.Flush()
	from, to := time.Now().Add(-time.Minute).UnixMilli(), time.Now().UnixMilli()
	found, err := db.Search(context.Background(), "c1", "", "kalibriert", from, to, 10)
	if err != nil || len(found) != 1 {
		t.Fatalf("indexed search = %v %v", found, err)
	}

	// Off: the message written afterwards is not indexed, so the search has
	// to scan -- and still find both.
	if err := p.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: false, Purge: false}); err != nil {
		t.Fatal(err)
	}
	if db.FullText() {
		t.Fatal("index still reported as on")
	}
	tee.Append("c1", rec("a.b", `{"note":"nachkalibriert"}`, 2))
	db.Flush()
	found, err = db.Search(context.Background(), "c1", "", "kalibriert", from, time.Now().UnixMilli(), 10)
	if err != nil || len(found) != 2 {
		t.Fatalf("scan search without the index = %d messages, %v", len(found), err)
	}

	// On again: the index is rebuilt from what is stored, including what
	// arrived while it was off.
	if err := p.Set(PersistenceRequest{Enabled: true, Retention: time.Hour, FullText: true, Purge: false}); err != nil {
		t.Fatal(err)
	}
	found, err = db.Search(context.Background(), "c1", "", "nachkalibriert", from, time.Now().UnixMilli(), 10)
	if err != nil || len(found) != 1 {
		t.Fatalf("rebuilt index = %d messages, %v", len(found), err)
	}
	if st := p.Status(); !st.FullText {
		t.Fatalf("status = %+v", st)
	}
}

// A subject whose newest payload is larger than the cap comes back as a
// count without a value: the tree knows the subject, and the next message
// fills the rest in.
func TestRecordedSubjectsCarryTheNewestMessage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	db, err := OpenDB(path, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.Enqueue("c1", &message.Record{Subject: "a.small", Data: []byte(`{"v":1}`), Timestamp: 100, Sequence: 1})
	db.Enqueue("c1", &message.Record{Subject: "a.small", Data: []byte(`{"v":2}`), Timestamp: 200, Sequence: 2})
	db.Enqueue("c1", &message.Record{Subject: "a.big", Data: make([]byte, MaxRestoredPayload+1), Timestamp: 300, Sequence: 3})
	db.Flush()

	list, err := db.RecordedSubjects(context.Background(), "c1", 100)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]RecordedSubject{}
	for _, rs := range list {
		by[rs.Subject] = rs
	}
	small := by["a.small"]
	if small.Count != 2 || small.Last == nil {
		t.Fatalf("a.small = %+v", small)
	}
	// The newest of the two, not the first.
	if string(small.Last.Data) != `{"v":2}` || small.Last.Timestamp != 200 {
		t.Fatalf("a.small last = %s @ %d", small.Last.Data, small.Last.Timestamp)
	}
	if big := by["a.big"]; big.Count != 1 || big.Last != nil {
		t.Fatalf("a payload over the cap must come back without its value: %+v", big)
	}
}

// Clearing a subject deletes its rows; with the index off the delete trigger
// must be gone too, or FTS5 refuses to forget a row it never indexed and
// takes the delete down with it.
func TestClearWorksWithoutTheIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	tee := NewTee(NewMemStore(0, 0))
	p, err := NewPersistence(tee, PersistenceOptions{Path: path, Retention: time.Hour, Enabled: true, FullText: false})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	db := tee.DB()
	for i := 1; i <= 5; i++ {
		tee.Append("c1", rec("a.b", `{"v":1}`, uint64(i)))
	}
	db.Flush()
	if err := db.DeleteSubject(context.Background(), "c1", "a.b", false); err != nil {
		t.Fatalf("delete with the index off: %v", err)
	}
	msgs, err := db.Range(context.Background(), "c1", "a.b", false, 0, time.Now().UnixMilli()+1000, 10)
	if err != nil || len(msgs) != 0 {
		t.Fatalf("after the delete: %d messages, %v", len(msgs), err)
	}
}

// The writer buffers a burst in memory, and that buffer is bounded by bytes
// rather than by the number of messages: a firehose of small messages and a
// trickle of large ones are the same problem measured differently.
func TestWriterQueueIsBoundedByBytes(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "history.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// A budget of a few kilobytes, so the bound is reached deliberately.
	db.SetQueueBytes(4 << 10)

	big := make([]byte, 8<<10)
	db.Enqueue("c1", &message.Record{Subject: "a.big", Data: big, Timestamp: 1, Sequence: 1})
	if got := db.dropped.Load(); got != 1 {
		t.Fatalf("a message larger than the whole budget must be dropped, dropped = %d", got)
	}
	if q := db.QueuedBytes(); q != 0 {
		t.Fatalf("a dropped message must not stay charged to the queue: %d bytes", q)
	}

	// Small ones fit, and what is written gives its budget back, so a burst
	// larger than the buffer still lands in full when it arrives slowly.
	for i := 0; i < 200; i++ {
		db.Enqueue("c1", &message.Record{Subject: "a.small", Data: []byte(`{"v":1}`), Timestamp: int64(i), Sequence: uint64(i + 2)})
		if i%20 == 0 {
			db.Flush()
		}
	}
	db.Flush()
	if q := db.QueuedBytes(); q != 0 {
		t.Fatalf("the queue should be empty after a flush, %d bytes charged", q)
	}
	if got := db.Written(); got < 150 {
		t.Fatalf("written = %d of 200; the budget is not being released", got)
	}
}
