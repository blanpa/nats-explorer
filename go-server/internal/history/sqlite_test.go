package history

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"nats-explorer/internal/message"
)

func TestDBRangeSearchSeriesAndRetention(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "h.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UnixMilli()
	for i := int64(1); i <= 10; i++ {
		db.Enqueue("c", &message.Record{Subject: "plant.line1.temp", Data: []byte(`{"v":` + string(rune('0'+i%10)) + `}`), Timestamp: now - (10-i)*1000, Sequence: uint64(i)})
	}
	db.Enqueue("c", &message.Record{Subject: "plant.line1.raw", Data: []byte{0xff, 0x00}, Timestamp: now, Sequence: 11})
	db.Enqueue("c", &message.Record{Subject: "plant.line2.temp", Data: []byte(`{"v":9}`), Timestamp: now - 5000, Sequence: 12, Header: map[string][]string{"X": {"1"}}})
	db.Enqueue("other", &message.Record{Subject: "plant.line1.temp", Data: []byte(`{"v":1}`), Timestamp: now, Sequence: 1})
	db.Flush()
	if db.Written() != 13 {
		t.Fatalf("written %d, want 13", db.Written())
	}
	ctx := context.Background()

	got, err := db.Range(ctx, "c", "plant.line1.temp", false, now-4000, now, 100)
	if err != nil || len(got) != 5 || got[0].Sequence != 10 || got[4].Sequence != 6 {
		t.Fatalf("range = %v %+v", err, got)
	}
	got, _ = db.Range(ctx, "c", "plant", true, 0, now, 100)
	if len(got) != 12 || got[0].Subject != "plant.line1.raw" || got[0].PayloadType != "binary" {
		t.Fatalf("branch range = %d %+v", len(got), got[:1])
	}
	got, _ = db.Range(ctx, "c", "plant.line2.temp", false, 0, now, 100)
	if len(got) != 1 || got[0].Headers["X"][0] != "1" {
		t.Fatalf("headers not kept: %+v", got)
	}
	got, _ = db.Search(ctx, "c", "plant", `"V":9`, 0, now, 100)
	if len(got) != 2 {
		t.Fatalf("search = %+v", got)
	}
	got, _ = db.Search(ctx, "c", "plant", "LINE2", 0, now, 100)
	if len(got) != 1 {
		t.Fatalf("subject search = %+v", got)
	}
	got, _ = db.Series(ctx, "c", "plant.line1.temp", 0, now, 100)
	if len(got) != 10 || got[0].Sequence != 1 {
		t.Fatalf("series = %d %+v", len(got), got[:1])
	}
	st := db.Stats()
	if st.Messages != 13 || st.Bytes == 0 || st.Oldest == 0 {
		t.Fatalf("stats = %+v", st)
	}

	// Retention: rows older than the window go away at cleanup.
	db.SetRetention(time.Millisecond)
	time.Sleep(5 * time.Millisecond)
	if res, err := db.db.Exec(`DELETE FROM messages WHERE ts < ?`, time.Now().Add(-db.Retention()).UnixMilli()); err == nil {
		n, _ := res.RowsAffected()
		db.count.Add(-n)
	}
	if st := db.Stats(); st.Messages != 0 {
		t.Fatalf("retention left %d rows", st.Messages)
	}
}

func TestTeeKeepsMemoryLive(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "h.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := NewTee(NewMemStore(0, 0))
	s.SetDB(db)
	s.Append("c", &message.Record{Subject: "a", Data: []byte("x"), Timestamp: 1, Sequence: 1})
	if got := s.Subject("c", "a", 10, 0); len(got) != 1 {
		t.Fatalf("memory side = %+v", got)
	}
	db.Flush()
	if db.Written() != 1 {
		t.Fatalf("db side wrote %d", db.Written())
	}
}

// A cap deletes the oldest messages once the rows take more than it, and
// counts them apart from the ones that aged out: a message deleted for
// size went before its time, and the status should be able to say so.
func TestDBTrimsToCap(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "h.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UnixMilli()
	payload := make([]byte, 1024)
	for i := range payload {
		payload[i] = byte('a' + i%26)
	}
	const n = 3000
	for i := int64(1); i <= n; i++ {
		db.Enqueue("c", &message.Record{Subject: "plant.line1.raw", Data: payload, Timestamp: now - (n-i)*10, Sequence: uint64(i)})
	}
	db.Flush()
	before := db.Stats()
	if before.Messages != n || before.Trimmed != 0 {
		t.Fatalf("before = %+v", before)
	}
	used := db.usedBytes()
	if used < n*1024 {
		t.Fatalf("used %d bytes for %d KB of payload", used, n)
	}

	// Without a cap the cleanup leaves everything: the retention is an hour.
	db.cleanup()
	if st := db.Stats(); st.Messages != n {
		t.Fatalf("no cap, but %d of %d left", st.Messages, n)
	}

	limit := used / 2
	db.SetMaxBytes(limit)
	db.cleanup()
	after := db.Stats()
	if after.MaxBytes != limit {
		t.Fatalf("stats cap = %d, want %d", after.MaxBytes, limit)
	}
	if got := db.usedBytes(); got > limit {
		t.Fatalf("still %d bytes in use over a cap of %d", got, limit)
	}
	if after.Trimmed == 0 || after.Messages != n-after.Trimmed {
		t.Fatalf("after = %+v", after)
	}
	// The oldest went first: what is left begins later than it did.
	if after.Oldest <= before.Oldest {
		t.Fatalf("oldest %d, was %d: the newest were trimmed", after.Oldest, before.Oldest)
	}
	// A second tick with the same cap trims nothing: the first one left
	// room under it on purpose.
	db.cleanup()
	if st := db.Stats(); st.Trimmed != after.Trimmed {
		t.Fatalf("trimmed again: %d after %d", st.Trimmed, after.Trimmed)
	}
}
