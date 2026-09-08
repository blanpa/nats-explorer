package history

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"nats-explorer/internal/message"
)

// FTS5 must be compiled into the pure-Go driver, otherwise the search falls
// back to LIKE.
func TestFTS5Available(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "probe.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE VIRTUAL TABLE probe USING fts5(x)`); err != nil {
		t.Fatalf("FTS5 not available: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO probe(x) VALUES ('hello brave world')`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM probe WHERE probe MATCH '"brave"'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("phrase match = %d, %v", n, err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM probe WHERE probe MATCH 'wor*'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("prefix match = %d, %v", n, err)
	}
}

// A database written before the index existed is indexed on the next open.
func TestFTSRebuildsExistingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	// Write messages with the index in place, then drop it to look like an
	// older database, and reopen.
	db, err := OpenDB(path, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		db.Enqueue("c1", &message.Record{Subject: "old.subject", Data: []byte(`{"note": "conveyor healthy"}`), Timestamp: time.Now().UnixMilli(), Sequence: uint64(i + 1)})
	}
	db.Flush()
	db.Close()

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	// Leave behind what an older version wrote: an index over the messages
	// table itself, which cannot be rebuilt because the payload column has
	// another name there.
	for _, stmt := range []string{
		`DROP TRIGGER messages_ai`, `DROP TRIGGER messages_ad`, `DROP TABLE messages_fts`, `DROP VIEW messages_fts_src`,
		`CREATE VIRTUAL TABLE messages_fts USING fts5(subject, body, content='messages', content_rowid='id')`,
		`PRAGMA user_version = 1`,
	} {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	raw.Close()

	db, err = OpenDB(path, time.Hour)
	if err != nil {
		t.Fatalf("reopening a database without the index: %v", err)
	}
	defer db.Close()
	msgs, err := db.Search(context.Background(), "c1", "", "conveyor", 0, time.Now().UnixMilli()+1000, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 3 {
		t.Fatalf("search after the rebuild = %d messages, want 3", len(msgs))
	}
}
