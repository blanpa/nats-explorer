package history

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"nats-explorer/internal/message"
)

// DB persists messages to SQLite so history survives restarts and reaches
// back further than memory. Writes are asynchronous and batched: the hot
// path only enqueues, a writer goroutine inserts in transactions, and a
// full queue drops rather than blocks. Rows older than the retention are
// deleted once a minute.
type DB struct {
	db        *sql.DB
	path      string
	retention time.Duration
	// rollupRetention outlives the messages: buckets are small.
	rollupKeep time.Duration
	queue      chan *queued
	dropped    atomic.Int64
	written    atomic.Int64
	count      atomic.Int64
	stop       chan struct{}
	done       sync.WaitGroup
}

type queued struct {
	conn string
	rec  *message.Record
}

// DBStats describes the persistent history.
type DBStats struct {
	Path string `json:"path"`
	// Messages in the database and its size on disk.
	Messages int64 `json:"messages"`
	Bytes    int64 `json:"bytes"`
	// Oldest message kept, unix ms; 0 when empty.
	Oldest int64 `json:"oldest"`
	// Messages not persisted because the writer fell behind.
	Dropped   int64  `json:"dropped"`
	Retention string `json:"retention"`
}

const (
	dbQueue      = 1 << 16
	dbBatch      = 2000
	dbFlushEvery = 250 * time.Millisecond
)

// OpenDB opens or creates the database and starts the writer.
func OpenDB(path string, retention time.Duration) (*DB, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id      INTEGER PRIMARY KEY,
			conn    TEXT NOT NULL,
			subject TEXT NOT NULL,
			ts      INTEGER NOT NULL,
			seq     INTEGER NOT NULL,
			kind    TEXT NOT NULL,
			data    BLOB NOT NULL,
			headers TEXT
		);
		CREATE INDEX IF NOT EXISTS messages_subject_ts ON messages (conn, subject, ts);
		CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);`); err != nil {
		db.Close()
		return nil, err
	}
	if err := ensureFTS(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := ensureRollups(db); err != nil {
		db.Close()
		return nil, err
	}
	d := &DB{db: db, path: path, retention: retention, rollupKeep: rollupRetention(os.Getenv), queue: make(chan *queued, dbQueue), stop: make(chan struct{})}
	var n int64
	db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n)
	d.count.Store(n)
	d.done.Add(1)
	go d.writer()
	return d, nil
}

// Enqueue hands a record to the writer; a full queue drops it.
func (d *DB) Enqueue(connID string, rec *message.Record) {
	select {
	case d.queue <- &queued{connID, rec}:
	default:
		d.dropped.Add(1)
	}
}

func (d *DB) writer() {
	defer d.done.Done()
	ticker := time.NewTicker(dbFlushEvery)
	defer ticker.Stop()
	cleanup := time.NewTicker(time.Minute)
	defer cleanup.Stop()
	batch := make([]*queued, 0, dbBatch)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := d.insert(batch); err != nil {
			d.dropped.Add(int64(len(batch)))
			fmt.Fprintf(os.Stderr, "history db: %v\n", err)
		} else {
			d.written.Add(int64(len(batch)))
			d.count.Add(int64(len(batch)))
		}
		for i := range batch {
			batch[i] = nil
		}
		batch = batch[:0]
	}
	for {
		select {
		case <-d.stop:
			// Drain what is queued, then leave.
			for {
				select {
				case q := <-d.queue:
					batch = append(batch, q)
					if len(batch) == dbBatch {
						flush()
					}
				default:
					flush()
					return
				}
			}
		case q := <-d.queue:
			batch = append(batch, q)
			if len(batch) == dbBatch {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-cleanup.C:
			flush()
			if d.retention > 0 {
				if res, err := d.db.Exec(`DELETE FROM messages WHERE ts < ?`, time.Now().Add(-d.retention).UnixMilli()); err == nil {
					if n, _ := res.RowsAffected(); n > 0 {
						d.count.Add(-n)
					}
				}
			}
			if d.rollupKeep > 0 {
				d.db.Exec(`DELETE FROM rollups WHERE minute < ?`, time.Now().Add(-d.rollupKeep).UnixMilli())
			}
		}
	}
}

func (d *DB) insert(batch []*queued) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO messages (conn, subject, ts, seq, kind, data, headers) VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	for _, q := range batch {
		var headers []byte
		if len(q.rec.Header) > 0 {
			headers, _ = json.Marshal(q.rec.Header)
		}
		if _, err := stmt.Exec(q.conn, q.rec.Subject, q.rec.Timestamp, int64(q.rec.Sequence), q.rec.Kind(), q.rec.Data, nullable(headers)); err != nil {
			stmt.Close()
			tx.Rollback()
			return err
		}
	}
	stmt.Close()
	// Minute buckets of the numeric fields, in the same transaction, so a
	// chart over days never has to read the messages again.
	if err := d.rollupBatch(tx, batch); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func nullable(b []byte) interface{} {
	if b == nil {
		return nil
	}
	return string(b)
}

// Flush blocks until everything queued so far has been written. For tests
// and shutdown.
func (d *DB) Flush() {
	for len(d.queue) > 0 {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(dbFlushEvery + 50*time.Millisecond)
}

// Close stops the writer after draining the queue.
func (d *DB) Close() error {
	close(d.stop)
	d.done.Wait()
	return d.db.Close()
}

// Range returns messages of a subject (and, with branch, everything below
// it) between from and to (unix ms, inclusive), newest first, at most limit.
func (d *DB) Range(ctx context.Context, connID, subject string, branch bool, from, to int64, limit int) ([]message.NatsMessage, error) {
	where := `conn = ? AND ts BETWEEN ? AND ?`
	args := []interface{}{connID, from, to}
	if branch {
		where += ` AND (subject = ? OR subject LIKE ? ESCAPE '\')`
		args = append(args, subject, likePrefix(subject)+".%")
	} else {
		where += ` AND subject = ?`
		args = append(args, subject)
	}
	args = append(args, limit)
	rows, err := d.db.QueryContext(ctx, `SELECT subject, ts, seq, kind, data, headers FROM messages WHERE `+where+` ORDER BY ts DESC, seq DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scan(rows, connID)
}

// Search finds recorded messages whose subject or payload matches q, newest
// first. An empty subject searches every subject of the connection. The
// full-text index answers word queries; anything it cannot express (a
// fragment, punctuation only) falls back to a LIKE scan.
func (d *DB) Search(ctx context.Context, connID, subject, q string, from, to int64, limit int) ([]message.NatsMessage, error) {
	if strings.TrimSpace(q) != "" {
		msgs, err := d.searchFTS(ctx, connID, subject, q, from, to, limit)
		switch {
		case err == nil && len(msgs) > 0:
			return msgs, nil
		case err != nil:
			if _, unusable := err.(errFTS); !unusable {
				// A real database error is worth reporting; an unusable query is not.
				return nil, err
			}
		}
		// The index indexes words. A fragment ("elsiu" in "celsius") finds
		// nothing there, so the scan below still gets its turn; it only runs
		// when the fast path came back empty.
	}
	needle := "%" + likePrefix(strings.ToLower(q)) + "%"
	args := []interface{}{connID, from, to}
	where := `conn = ? AND ts BETWEEN ? AND ?`
	if subject != "" {
		where += ` AND (subject = ? OR subject LIKE ? ESCAPE '\')`
		args = append(args, subject, likePrefix(subject)+".%")
	}
	if q != "" {
		where += ` AND (lower(subject) LIKE ? ESCAPE '\' OR (kind != 'binary' AND lower(CAST(data AS TEXT)) LIKE ? ESCAPE '\'))`
		args = append(args, needle, needle)
	}
	args = append(args, limit)
	rows, err := d.db.QueryContext(ctx, `SELECT subject, ts, seq, kind, data, headers FROM messages
		WHERE `+where+` ORDER BY ts DESC, seq DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scan(rows, connID)
}

// Series returns the JSON messages of a subject in a time range, oldest
// first, for the series endpoint to extract a field from.
func (d *DB) Series(ctx context.Context, connID, subject string, from, to int64, limit int) ([]message.NatsMessage, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT subject, ts, seq, kind, data, headers FROM messages
		WHERE conn = ? AND subject = ? AND kind = 'json' AND ts BETWEEN ? AND ? ORDER BY ts ASC, seq ASC LIMIT ?`, connID, subject, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scan(rows, connID)
}

func likePrefix(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func scan(rows *sql.Rows, connID string) ([]message.NatsMessage, error) {
	out := []message.NatsMessage{}
	for rows.Next() {
		var subject, kind string
		var ts, seq int64
		var data []byte
		var headers sql.NullString
		if err := rows.Scan(&subject, &ts, &seq, &kind, &data, &headers); err != nil {
			return nil, err
		}
		rec := &message.Record{Subject: subject, Data: data, Timestamp: ts, Sequence: uint64(seq)}
		if headers.Valid {
			json.Unmarshal([]byte(headers.String), &rec.Header)
		}
		out = append(out, rec.Wire(connID))
	}
	return out, rows.Err()
}

// Stats reports the database size.
func (d *DB) Stats() DBStats {
	st := DBStats{Path: d.path, Dropped: d.dropped.Load(), Retention: d.retention.String(), Messages: d.count.Load()}
	d.db.QueryRow(`SELECT COALESCE(MIN(ts), 0) FROM messages`).Scan(&st.Oldest)
	if fi, err := os.Stat(d.path); err == nil {
		st.Bytes = fi.Size()
		if wal, err := os.Stat(d.path + "-wal"); err == nil {
			st.Bytes += wal.Size()
		}
	}
	return st
}

// Written reports how many messages the writer has committed.
func (d *DB) Written() int64 { return d.written.Load() }

// Tee is a Store that keeps the in-memory store as the live source and
// copies every record to the database.
type Tee struct {
	*MemStore
	DB *DB
}

func (t *Tee) Append(connID string, rec *message.Record) {
	t.MemStore.Append(connID, rec)
	t.DB.Enqueue(connID, rec)
}

func (t *Tee) Stats(connID string) Stats {
	st := t.MemStore.Stats(connID)
	db := t.DB.Stats()
	st.DB = &db
	return st
}
