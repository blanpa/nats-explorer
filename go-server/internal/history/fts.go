package history

import (
	"context"
	"database/sql"
	"strings"

	"nats-explorer/internal/message"
)

// Full-text search over the persisted history. An external-content FTS5
// table indexes subject and payload of `messages`; triggers keep it in step.
// A database written before this existed is indexed once on open.
//
// Without a query the search is a plain listing, so the index only matters
// when there are words to look for.

// ftsSchemaVersion is raised whenever the index definition changes; an
// older database drops its index and builds the new one.
const ftsSchemaVersion = 2

// ensureFTS creates the index and, on an existing database, fills it once.
func ensureFTS(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version < ftsSchemaVersion {
		// Version 1 indexed the messages table directly, whose payload column
		// is named differently; that definition cannot be rebuilt.
		for _, stmt := range []string{
			`DROP TRIGGER IF EXISTS messages_ai`,
			`DROP TRIGGER IF EXISTS messages_ad`,
			`DROP TABLE IF EXISTS messages_fts`,
			`DROP VIEW IF EXISTS messages_fts_src`,
		} {
			if _, err := db.Exec(stmt); err != nil {
				return err
			}
		}
	}
	// External content needs a source whose columns match the index. The
	// messages table stores the payload as a BLOB in `data`, so a view
	// renames it and drops binary payloads, which have no words to find.
	if _, err := db.Exec(`
		CREATE VIEW IF NOT EXISTS messages_fts_src AS
			SELECT id, subject, CASE WHEN kind = 'binary' THEN '' ELSE CAST(data AS TEXT) END AS body FROM messages;
		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
			subject, body, content='messages_fts_src', content_rowid='id', tokenize='unicode61'
		);
		CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO messages_fts(rowid, subject, body)
			VALUES (new.id, new.subject, CASE WHEN new.kind = 'binary' THEN '' ELSE CAST(new.data AS TEXT) END);
		END;
		CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO messages_fts(messages_fts, rowid, subject, body) VALUES ('delete', old.id, old.subject, '');
		END;`); err != nil {
		return err
	}
	if version >= ftsSchemaVersion {
		return nil
	}
	// The table is new; anything already in `messages` is not indexed yet.
	var rows int64
	db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&rows)
	if rows > 0 {
		if _, err := db.Exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`); err != nil {
			return err
		}
	}
	_, err := db.Exec(`PRAGMA user_version = ` + itoa(ftsSchemaVersion))
	return err
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// ftsQuery turns what a user typed into an FTS5 expression: every word is a
// phrase, all of them must appear, and a trailing * stays a prefix search.
// Returns "" when nothing usable is left, and the caller falls back to LIKE.
func ftsQuery(q string) string {
	var parts []string
	for _, field := range strings.Fields(q) {
		prefix := strings.HasSuffix(field, "*")
		word := strings.TrimSuffix(field, "*")
		// FTS5 tokenizes on non-word characters anyway; quoting makes the
		// user's punctuation harmless instead of a syntax error.
		word = strings.ReplaceAll(word, `"`, `""`)
		if strings.TrimSpace(strings.Map(keepWordChars, word)) == "" {
			continue
		}
		if prefix {
			parts = append(parts, `"`+word+`"*`)
		} else {
			parts = append(parts, `"`+word+`"`)
		}
	}
	return strings.Join(parts, " AND ")
}

func keepWordChars(r rune) rune {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return r
	case r > 127:
		return r
	default:
		return -1
	}
}

// searchFTS runs the indexed search. subject "" searches every subject of
// the connection. A query the index rejects returns errFTS so the caller
// can fall back.
func (d *DB) searchFTS(ctx context.Context, connID, subject, q string, from, to int64, limit int) ([]message.NatsMessage, error) {
	match := ftsQuery(q)
	if match == "" {
		return nil, errFTSUnusable
	}
	args := []interface{}{match, connID, from, to}
	where := `m.conn = ? AND m.ts BETWEEN ? AND ?`
	if subject != "" {
		where += ` AND (m.subject = ? OR m.subject LIKE ? ESCAPE '\')`
		args = append(args, subject, likePrefix(subject)+".%")
	}
	args = append(args, limit)
	rows, err := d.db.QueryContext(ctx, `
		SELECT m.subject, m.ts, m.seq, m.kind, m.data, m.headers
		FROM messages_fts f JOIN messages m ON m.id = f.rowid
		WHERE messages_fts MATCH ? AND `+where+`
		ORDER BY m.ts DESC, m.seq DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scan(rows, connID)
}

// errFTSUnusable means the query cannot be expressed as an FTS match.
var errFTSUnusable = errFTS("query not usable as full-text search")

type errFTS string

func (e errFTS) Error() string { return string(e) }
