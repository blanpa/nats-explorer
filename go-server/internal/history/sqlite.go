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

	"nats-explorer/internal/filter"
	"nats-explorer/internal/message"
)

// DB persists messages to SQLite so history survives restarts and reaches
// back further than memory. Writes are asynchronous and batched: the hot
// path only enqueues, a writer goroutine inserts in transactions, and a
// full queue drops rather than blocks. Rows older than the retention are
// deleted once a minute.
type DB struct {
	db   *sql.DB
	path string
	// retention is atomic: the UI can change it while the writer runs.
	retention atomic.Int64
	// fullText says whether the index behind the word search is being filled.
	// Off, the writer is several times faster and a search falls back to a
	// scan; the flag is read on the search path, so it is atomic.
	fullText atomic.Bool
	// rollupRetention outlives the messages: buckets are small.
	rollupKeep time.Duration
	queue      chan *queued
	// queued bytes and their budget: the queue is bounded by memory, not by
	// the number of messages in it.
	queueBytes  atomic.Int64
	queueBudget atomic.Int64
	dropped     atomic.Int64
	filtered    atomic.Int64
	written     atomic.Int64
	count       atomic.Int64
	stop        chan struct{}
	done        sync.WaitGroup
}

type queued struct {
	conn string
	rec  *message.Record
	// size is what this entry counts against the queue budget.
	size int64
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
	Dropped int64 `json:"dropped"`
	// Filtered is what the persist filter excluded on purpose. It is
	// counted apart from Dropped: one is a choice, the other is a loss,
	// and a status that mixes them cannot be read.
	Filtered int64 `json:"filtered"`
	// Queued is what is waiting to be written, out of QueueBytes.
	Queued     int64  `json:"queued"`
	QueueBytes int64  `json:"queueBytes"`
	Retention  string `json:"retention"`
}

const (
	// dbQueue is the number of pending records the channel can hold. The
	// real limit is DefaultQueueBytes: counting messages says nothing about
	// how much memory they are, and the two workloads that matter -- a
	// firehose of small messages and a trickle of large ones -- sit at
	// opposite ends of that.
	dbQueue      = 1 << 20
	dbBatch      = 2000
	dbFlushEvery = 250 * time.Millisecond
)

// DefaultQueueBytes is how much of a burst the writer buffers before it
// starts dropping. Disk is slower than the wire, so this is what decides
// whether a burst reaches the database or only a part of it: 64 MB is about
// 300 000 messages of 200 bytes, several seconds of a firehose. Beyond a
// burst nothing helps -- a queue that keeps growing only postpones the loss
// and pays for it in memory.
const DefaultQueueBytes = 64 << 20

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
	d := &DB{db: db, path: path, rollupKeep: rollupRetention(os.Getenv), queue: make(chan *queued, dbQueue), stop: make(chan struct{})}
	d.retention.Store(int64(retention))
	d.queueBudget.Store(DefaultQueueBytes)
	d.fullText.Store(true)
	var n int64
	db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n)
	d.count.Store(n)
	d.done.Add(1)
	go d.writer()
	return d, nil
}

// Enqueue hands a record to the writer. A full queue drops it rather than
// blocking: the alternative is to stall the live feed and the tree for
// everyone because a disk cannot keep up, and a dropped copy is counted and
// shown while a stalled connection is not.
func (d *DB) Enqueue(connID string, rec *message.Record) {
	size := int64(len(rec.Data)) + int64(len(rec.Subject)) + queuedOverhead
	if d.queueBytes.Add(size) > d.queueBudget.Load() {
		d.queueBytes.Add(-size)
		d.dropped.Add(1)
		return
	}
	select {
	case d.queue <- &queued{connID, rec, size}:
	default:
		d.queueBytes.Add(-size)
		d.dropped.Add(1)
	}
}

// queuedOverhead is what a pending record costs beyond its payload: the
// record itself, the queue entry and the pointer in the channel.
const queuedOverhead = 128

// QueueBytesLimit is the budget the queue is bounded by.
func (d *DB) QueueBytesLimit() int64 { return d.queueBudget.Load() }

// SetQueueBytes changes how much of a burst is buffered. For tests and
// benchmarks; the default suits the memory the history already uses.
func (d *DB) SetQueueBytes(n int64) { d.queueBudget.Store(n) }

// QueuedBytes is what is waiting to be written.
func (d *DB) QueuedBytes() int64 { return d.queueBytes.Load() }

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
			// The entry leaves the queue's budget only once it is written,
			// so a slow writer cannot be handed more than it can hold.
			d.queueBytes.Add(-batch[i].size)
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
			d.cleanup()
		}
	}
}

// cleanup deletes what has aged out. A zero retention is Forever: nothing
// is deleted by age, and the database grows until the disk does not allow
// it -- which is the point of asking for it.
func (d *DB) cleanup() {
	if keep := d.Retention(); keep > 0 {
		if res, err := d.db.Exec(`DELETE FROM messages WHERE ts < ?`, time.Now().Add(-keep).UnixMilli()); err == nil {
			if n, _ := res.RowsAffected(); n > 0 {
				d.count.Add(-n)
			}
		}
	}
	if d.rollupKeep > 0 {
		d.db.Exec(`DELETE FROM rollups WHERE minute < ?`, time.Now().Add(-d.rollupKeep).UnixMilli())
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
	return d.RangePage(ctx, connID, subject, branch, from, to, 0, 0, limit)
}

// RangePage is Range with a cursor: only messages older than (beforeTS,
// beforeSeq) are returned, so a view can page backwards through a range
// instead of asking for one ever larger limit. A zero beforeTS starts at the
// newest message.
func (d *DB) RangePage(ctx context.Context, connID, subject string, branch bool, from, to, beforeTS int64, beforeSeq uint64, limit int) ([]message.NatsMessage, error) {
	where := `conn = ? AND ts BETWEEN ? AND ?`
	args := []interface{}{connID, from, to}
	if beforeTS > 0 {
		// The rows are ordered by (ts, seq); the cursor is that pair, so
		// messages sharing a millisecond are paged through and not skipped.
		where += ` AND (ts < ? OR (ts = ? AND seq < ?))`
		args = append(args, beforeTS, beforeTS, int64(beforeSeq))
	}
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
	return d.SearchPage(ctx, connID, subject, q, from, to, 0, 0, limit)
}

// SearchPage is Search with a cursor, so the results page backwards the way
// a range does.
func (d *DB) SearchPage(ctx context.Context, connID, subject, q string, from, to, beforeTS int64, beforeSeq uint64, limit int) ([]message.NatsMessage, error) {
	// Without the index the table holds whatever was written while it was on:
	// asking it would answer with half the truth, which is worse than the
	// scan below.
	// The index has no cursor of its own, so a paged search scans -- which
	// is the path a fragment takes anyway.
	if d.fullText.Load() && beforeTS == 0 && strings.TrimSpace(q) != "" {
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
	if beforeTS > 0 {
		where += ` AND (ts < ? OR (ts = ? AND seq < ?))`
		args = append(args, beforeTS, beforeTS, int64(beforeSeq))
	}
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

// RecordedSubject is a subject the database holds messages for, with its
// newest message. The message matters as much as the count: it is what the
// tree shows as the preview and what the payload filter judges a subject by,
// so a tree restored without it looks like one with missing data.
type RecordedSubject struct {
	Subject string
	Count   int
	// Last is the newest message, or nil when its payload was larger than
	// MaxRestoredPayload -- the tree then knows the subject but not its value.
	Last *message.Record
}

// MaxRestoredPayload bounds what a restore pulls back into memory per
// subject. The tree keeps the newest message of every subject anyway; this
// only stops a namespace of large payloads from being read in one go.
const MaxRestoredPayload = 4 << 10

// SubjectLoader is a history that can name the subjects it recorded for a
// connection. The Tee implements it whenever a database is attached.
type SubjectLoader interface {
	RecordedSubjects(ctx context.Context, connID string, limit int) ([]RecordedSubject, error)
}

// RecordedSubjects lists the subjects of a connection with how many messages
// each has, the largest first. It is what brings the subject tree back after
// a restart: the messages are still on disk, so the tree should not start
// empty and the counters should not start over.
func (d *DB) RecordedSubjects(ctx context.Context, connID string, limit int) ([]RecordedSubject, error) {
	// MAX(ts) picks the newest row per subject; the bare columns beside it
	// come from that same row, which is what SQLite guarantees for a bare
	// column next to min() or max().
	rows, err := d.db.QueryContext(ctx, `SELECT subject, COUNT(*) AS n, MAX(ts) AS ts, seq,
			CASE WHEN length(data) <= ? THEN data END AS data, headers
		FROM messages WHERE conn = ? GROUP BY subject ORDER BY n DESC LIMIT ?`,
		MaxRestoredPayload, connID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecordedSubject{}
	for rows.Next() {
		var (
			rs      RecordedSubject
			ts, seq int64
			data    []byte
			headers sql.NullString
		)
		if err := rows.Scan(&rs.Subject, &rs.Count, &ts, &seq, &data, &headers); err != nil {
			return nil, err
		}
		if data != nil {
			rec := &message.Record{Subject: rs.Subject, Data: data, Timestamp: ts, Sequence: uint64(seq)}
			if headers.Valid {
				json.Unmarshal([]byte(headers.String), &rec.Header)
			}
			rs.Last = rec
		}
		out = append(out, rs)
	}
	return out, rows.Err()
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
	st := DBStats{
		Path:       d.path,
		Dropped:    d.dropped.Load(),
		Filtered:   d.filtered.Load(),
		Queued:     d.queueBytes.Load(),
		QueueBytes: d.queueBudget.Load(),
		Retention:  d.Retention().String(),
		Messages:   d.count.Load(),
	}
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

// Path is the file the database lives in.
func (d *DB) Path() string { return d.path }

// Retention is how far back the database is kept.
func (d *DB) Retention() time.Duration { return time.Duration(d.retention.Load()) }

// SetRetention changes it; the writer applies it on its next cleanup tick,
// so nothing has to be reopened.
func (d *DB) SetRetention(keep time.Duration) { d.retention.Store(int64(keep)) }

// FullText reports whether the word index is being filled.
func (d *DB) FullText() bool { return d.fullText.Load() }

// SetFullText turns the index on or off. Turning it on rebuilds it from the
// messages already stored; turning it off empties it, because a half-filled
// index would answer searches with a subset and call it the result.
func (d *DB) SetFullText(on bool) error {
	if d.fullText.Load() == on {
		return nil
	}
	// Nothing may be written while the index changes underneath.
	d.Flush()
	if err := setFTSTrigger(d.db, on); err != nil {
		return err
	}
	stmt := `INSERT INTO messages_fts(messages_fts) VALUES ('delete-all')`
	if on {
		stmt = `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`
	}
	if _, err := d.db.Exec(stmt); err != nil {
		return err
	}
	d.fullText.Store(on)
	return nil
}

// Tee is a Store that keeps the in-memory store as the live source and
// copies every record to the database. The database is optional and can be
// opened and closed while the server runs (it is a setting, not only an
// environment variable), so it sits behind an atomic pointer that the hot
// path reads without a lock.
type Tee struct {
	*MemStore
	db atomic.Pointer[DB]
	// persist decides what reaches the database. Nil means everything, and
	// that is the only state in which the hot path pays nothing for it. The
	// memory store is never filtered: the live feed and the tree have to
	// show what actually arrives, whatever is kept on disk.
	persist atomic.Pointer[filter.Program]
}

// NewTee wraps a memory store; without a database it behaves like one.
func NewTee(mem *MemStore) *Tee { return &Tee{MemStore: mem} }

// DB returns the database messages are copied to, or nil when the history
// is memory-only.
func (t *Tee) DB() *DB { return t.db.Load() }

// SetDB installs db (nil detaches) and returns what was there before. The
// caller closes the old one.
func (t *Tee) SetDB(db *DB) *DB { return t.db.Swap(db) }

func (t *Tee) Append(connID string, rec *message.Record) {
	t.MemStore.Append(connID, rec)
	db := t.db.Load()
	if db == nil {
		return
	}
	// The filter runs before the queue, not in the writer: the point of it
	// is that what it excludes never takes up queue budget, so a burst of
	// uninteresting subjects cannot push out the ones being kept.
	if p := t.persist.Load(); p != nil && !p.Match(rec) {
		db.filtered.Add(1)
		return
	}
	db.Enqueue(connID, rec)
}

// SetPersistFilter installs the expression that decides what is written to
// disk; nil or an empty program keeps everything.
func (t *Tee) SetPersistFilter(p *filter.Program) { t.persist.Store(p) }

// PersistFilter is the installed expression, empty when everything is kept.
func (t *Tee) PersistFilter() string {
	if p := t.persist.Load(); p != nil {
		return p.Expr
	}
	return ""
}

// RecordedSubjects answers from the database; without one the history is
// memory-only and there is nothing to bring back.
func (t *Tee) RecordedSubjects(ctx context.Context, connID string, limit int) ([]RecordedSubject, error) {
	db := t.db.Load()
	if db == nil {
		return nil, nil
	}
	return db.RecordedSubjects(ctx, connID, limit)
}

func (t *Tee) Stats(connID string) Stats {
	st := t.MemStore.Stats(connID)
	if db := t.db.Load(); db != nil {
		s := db.Stats()
		st.DB = &s
	}
	return st
}
