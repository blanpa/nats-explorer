package history

import (
	"container/heap"
	"context"
	"sort"

	"nats-explorer/internal/message"
)

// Dump returns the recorded messages of a connection across every subject,
// newest first. Used to write a support bundle from what is in memory.
func (s *MemStore) Dump(connID string, limit int) []message.NatsMessage {
	if limit <= 0 {
		return nil
	}
	for _, sh := range s.shards {
		sh.mu.Lock()
	}
	defer func() {
		for _, sh := range s.shards {
			sh.mu.Unlock()
		}
	}()
	h := cursorHeap{}
	for _, sh := range s.shards {
		ch := sh.conns[connID]
		if ch == nil {
			continue
		}
		for _, buf := range ch.subjects {
			if buf.len() > 0 {
				h = append(h, &cursor{buf: buf, i: buf.len() - 1})
			}
		}
	}
	if len(h) == 0 {
		return nil
	}
	heap.Init(&h)
	out := make([]message.NatsMessage, 0, limit)
	for h.Len() > 0 && len(out) < limit {
		c := h[0]
		out = append(out, c.cur().rec.Wire(connID))
		if c.i--; c.i >= 0 {
			heap.Fix(&h, 0)
		} else {
			heap.Pop(&h)
		}
	}
	return out
}

// RangeAll reads every subject of a connection in a time range, newest
// first. The bundle export uses it when a persistent history is configured.
func (d *DB) RangeAll(ctx context.Context, connID string, from, to int64, limit int) ([]message.NatsMessage, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT subject, ts, seq, kind, data, headers FROM messages
		WHERE conn = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC, seq DESC LIMIT ?`, connID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scan(rows, connID)
}

// Oldest sorts messages the way a bundle stores them: oldest first, so
// ingesting the file replays them in the order they arrived.
func Oldest(msgs []message.NatsMessage) {
	sort.SliceStable(msgs, func(i, j int) bool {
		if msgs[i].Timestamp != msgs[j].Timestamp {
			return msgs[i].Timestamp < msgs[j].Timestamp
		}
		return msgs[i].Sequence < msgs[j].Sequence
	})
}
