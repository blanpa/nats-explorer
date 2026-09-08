package history

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// Minute rollups of the numeric fields of JSON payloads. A chart over a week
// must not read a week of messages: the writer keeps min, max, sum and count
// per subject, field and minute while it stores the messages anyway.

const (
	// rollupMaxFields bounds what one message contributes, so a document with
	// hundreds of numbers cannot blow up the table.
	rollupMaxFields = 16
	// rollupRetentionDefault is how long buckets are kept; they are tiny
	// compared to the messages, so they outlive them by default.
	rollupRetentionDefault = 90 * 24 * time.Hour
)

func ensureRollups(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS rollups (
			conn    TEXT NOT NULL,
			subject TEXT NOT NULL,
			field   TEXT NOT NULL,
			minute  INTEGER NOT NULL,
			min     REAL NOT NULL,
			max     REAL NOT NULL,
			sum     REAL NOT NULL,
			count   INTEGER NOT NULL,
			PRIMARY KEY (conn, subject, field, minute)
		) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS rollups_minute ON rollups (minute);`)
	return err
}

// RollupPoint is one minute of one field.
type RollupPoint struct {
	T     int64   `json:"t"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Avg   float64 `json:"avg"`
	Count int64   `json:"count"`
}

// numericFields extracts the numbers of a JSON document: the top level and
// one level below it, as dotted paths, in key order, at most a few.
func numericFields(data []byte) map[string]float64 {
	if len(data) == 0 || (data[0] != '{' && data[0] != '[') {
		return nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil
	}
	keys := make([]string, 0, len(doc))
	for k := range doc {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]float64, min(len(keys), rollupMaxFields))
	for _, k := range keys {
		if len(out) >= rollupMaxFields {
			break
		}
		raw := doc[k]
		if n, ok := asNumber(raw); ok {
			out[k] = n
			continue
		}
		if len(raw) == 0 || raw[0] != '{' {
			continue
		}
		var nested map[string]json.RawMessage
		if json.Unmarshal(raw, &nested) != nil {
			continue
		}
		sub := make([]string, 0, len(nested))
		for k2 := range nested {
			sub = append(sub, k2)
		}
		sort.Strings(sub)
		for _, k2 := range sub {
			if len(out) >= rollupMaxFields {
				break
			}
			if n, ok := asNumber(nested[k2]); ok {
				out[k+"."+k2] = n
			}
		}
	}
	return out
}

func asNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	c := raw[0]
	if c != '-' && (c < '0' || c > '9') {
		return 0, false
	}
	var n float64
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	return n, true
}

// rollupBatch folds a batch of records into minute buckets and upserts them.
func (d *DB) rollupBatch(tx *sql.Tx, batch []*queued) error {
	type key struct {
		conn, subject, field string
		minute               int64
	}
	agg := make(map[key]*RollupPoint)
	for _, q := range batch {
		if q.rec.Kind() != "json" {
			continue
		}
		fields := numericFields(q.rec.Data)
		if len(fields) == 0 {
			continue
		}
		minute := q.rec.Timestamp / 60000 * 60000
		for name, v := range fields {
			k := key{q.conn, q.rec.Subject, name, minute}
			p := agg[k]
			if p == nil {
				agg[k] = &RollupPoint{Min: v, Max: v, Avg: v, Count: 1}
				continue
			}
			if v < p.Min {
				p.Min = v
			}
			if v > p.Max {
				p.Max = v
			}
			p.Avg += v // sum until it is written
			p.Count++
		}
	}
	if len(agg) == 0 {
		return nil
	}
	stmt, err := tx.Prepare(`INSERT INTO rollups (conn, subject, field, minute, min, max, sum, count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (conn, subject, field, minute) DO UPDATE SET
			min = MIN(min, excluded.min),
			max = MAX(max, excluded.max),
			sum = sum + excluded.sum,
			count = count + excluded.count`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for k, p := range agg {
		if _, err := stmt.Exec(k.conn, k.subject, k.field, k.minute, p.Min, p.Max, p.Avg, p.Count); err != nil {
			return err
		}
	}
	return nil
}

// SeriesRollup reads the minute buckets of one field, oldest first.
func (d *DB) SeriesRollup(ctx context.Context, connID, subject, field string, from, to int64) ([]RollupPoint, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT minute, min, max, sum, count FROM rollups
		WHERE conn = ? AND subject = ? AND field = ? AND minute BETWEEN ? AND ?
		ORDER BY minute ASC`, connID, subject, field, from/60000*60000, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RollupPoint
	for rows.Next() {
		var p RollupPoint
		var sum float64
		if err := rows.Scan(&p.T, &p.Min, &p.Max, &sum, &p.Count); err != nil {
			return nil, err
		}
		if p.Count > 0 {
			p.Avg = sum / float64(p.Count)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// RollupFields lists the numeric fields known for a subject, so a chart over
// a long range can offer them without reading messages.
func (d *DB) RollupFields(ctx context.Context, connID, subject string) ([]string, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT DISTINCT field FROM rollups WHERE conn = ? AND subject = ? ORDER BY field`, connID, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// rollupRetention reads ROLLUP_RETENTION, falling back to the default.
func rollupRetention(env func(string) string) time.Duration {
	if v := strings.TrimSpace(env("ROLLUP_RETENTION")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return rollupRetentionDefault
}
