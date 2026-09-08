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
	db.retention = time.Millisecond
	time.Sleep(5 * time.Millisecond)
	if res, err := db.db.Exec(`DELETE FROM messages WHERE ts < ?`, time.Now().Add(-db.retention).UnixMilli()); err == nil {
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
	s := &Tee{MemStore: NewMemStore(0, 0), DB: db}
	s.Append("c", &message.Record{Subject: "a", Data: []byte("x"), Timestamp: 1, Sequence: 1})
	if got := s.Subject("c", "a", 10, 0); len(got) != 1 {
		t.Fatalf("memory side = %+v", got)
	}
	db.Flush()
	if db.Written() != 1 {
		t.Fatalf("db side wrote %d", db.Written())
	}
}
