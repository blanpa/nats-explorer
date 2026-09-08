// Package history keeps recent messages per connection and subject so the
// browser can pull what it looks at instead of receiving everything.
//
// Store is the seam for a persistent backend (SQLite, DuckDB, JetStream):
// the in-memory implementation below is bounded by a byte budget and a
// per-subject count and is what the server uses today.
package history

import (
	"container/heap"
	"runtime"
	"sort"
	"strings"
	"sync"

	"nats-explorer/internal/message"
)

// Store records every message a subscription manager sees and answers the
// queries the UI needs: the history of one subject and the newest messages
// below a branch.
type Store interface {
	Append(connID string, rec *message.Record)
	// Subject returns up to limit messages received on exactly subject,
	// oldest first. With beforeSeq > 0 only messages with a smaller sequence
	// are returned, which pages backwards through the history.
	Subject(connID, subject string, limit int, beforeSeq uint64) []message.NatsMessage
	// Branch returns up to limit of the newest messages on subjects strictly
	// below prefix (prefix + "."), newest first.
	Branch(connID, prefix string, limit int) []message.NatsMessage
	// Search returns up to limit of the newest messages on subject or below
	// it whose subject or payload text contains q (case-insensitive, ASCII).
	Search(connID, subject, q string, limit int) []message.NatsMessage
	// Drop forgets everything recorded for a connection.
	Drop(connID string)
	// Clear forgets everything.
	Clear()
	// Stats reports the size of the history; an empty connID means all.
	Stats(connID string) Stats
}

// Stats describes how much history is held in memory, and on disk when a
// database is configured.
type Stats struct {
	Messages int      `json:"messages"`
	Bytes    int      `json:"bytes"`
	Subjects int      `json:"subjects"`
	DB       *DBStats `json:"db,omitempty"`
}

const (
	DefaultMaxBytes      = 256 << 20
	DefaultMaxPerSubject = 10000
)

type entry struct {
	rec  *message.Record
	size int
	dead bool
	buf  *subjectBuf
	conn *connHist
}

// connHist is everything one shard holds for a connection, with counters so
// stats do not walk the messages.
type connHist struct {
	subjects map[string]*subjectBuf
	count    int
	bytes    int
}

// subjectBuf is a ring of one subject's messages: pushes and pops never
// move entries, only the indexes. It grows by doubling and shrinks when it
// is mostly empty.
type subjectBuf struct {
	items []*entry
	head  int
	n     int
}

func (b *subjectBuf) len() int { return b.n }

// at returns the i-th live entry, oldest first.
func (b *subjectBuf) at(i int) *entry { return b.items[(b.head+i)%len(b.items)] }

func (b *subjectBuf) resize(capacity int) {
	items := make([]*entry, capacity)
	for i := 0; i < b.n; i++ {
		items[i] = b.at(i)
	}
	b.items = items
	b.head = 0
}

func (b *subjectBuf) push(e *entry) {
	if b.n == len(b.items) {
		b.resize(max(8, 2*len(b.items)))
	}
	b.items[(b.head+b.n)%len(b.items)] = e
	b.n++
}

func (b *subjectBuf) popHead() *entry {
	e := b.items[b.head]
	b.items[b.head] = nil
	b.head = (b.head + 1) % len(b.items)
	b.n--
	if len(b.items) > 64 && b.n < len(b.items)/4 {
		b.resize(len(b.items) / 2)
	}
	return e
}

// shard holds the subjects whose hash lands on it. Messages of all
// connections share one arrival-ordered FIFO that enforces the shard's byte
// budget; each subject also keeps its own FIFO capped at maxPerSubject.
// Because both orders are arrival order, the oldest live message of the
// FIFO is always the head of its subject FIFO, so eviction is O(1).
type shard struct {
	mu            sync.Mutex
	maxBytes      int
	maxPerSubject int
	bytes         int
	count         int
	fifo          []*entry
	fifoHead      int
	conns         map[string]*connHist
}

// MemStore is an in-memory Store split into shards by subject, so
// connections with hundreds of thousands of messages per second do not
// serialise on one lock.
type MemStore struct {
	shards []*shard
}

// NewMemStore creates a store with one shard per CPU (at most 16); zero
// values pick the defaults.
func NewMemStore(maxBytes, maxPerSubject int) *MemStore {
	return NewMemStoreShards(maxBytes, maxPerSubject, min(16, max(1, runtime.NumCPU())))
}

// NewMemStoreShards creates a store with a fixed number of shards. The byte
// budget is split evenly between them.
func NewMemStoreShards(maxBytes, maxPerSubject, shards int) *MemStore {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if maxPerSubject <= 0 {
		maxPerSubject = DefaultMaxPerSubject
	}
	if shards <= 0 {
		shards = 1
	}
	s := &MemStore{shards: make([]*shard, shards)}
	for i := range s.shards {
		s.shards[i] = &shard{maxBytes: maxBytes / shards, maxPerSubject: maxPerSubject, conns: make(map[string]*connHist)}
	}
	return s
}

func (s *MemStore) shardOf(subject string, hash uint32) *shard {
	if len(s.shards) == 1 {
		return s.shards[0]
	}
	if hash == 0 {
		hash = message.SubjectHash(subject)
	}
	return s.shards[hash%uint32(len(s.shards))]
}

func (s *MemStore) Append(connID string, rec *message.Record) {
	sh := s.shardOf(rec.Subject, rec.Hash)
	sh.mu.Lock()
	defer sh.mu.Unlock()

	ch := sh.conns[connID]
	if ch == nil {
		ch = &connHist{subjects: make(map[string]*subjectBuf)}
		sh.conns[connID] = ch
	}
	buf := ch.subjects[rec.Subject]
	if buf == nil {
		buf = &subjectBuf{}
		ch.subjects[rec.Subject] = buf
	}

	e := &entry{rec: rec, size: rec.Bytes(), buf: buf, conn: ch}
	buf.push(e)
	sh.fifo = append(sh.fifo, e)
	sh.bytes += e.size
	sh.count++
	ch.bytes += e.size
	ch.count++

	if buf.len() > sh.maxPerSubject {
		sh.kill(buf.popHead())
	}
	for sh.bytes > sh.maxBytes && sh.fifoHead < len(sh.fifo) {
		old := sh.fifo[sh.fifoHead]
		sh.fifo[sh.fifoHead] = nil
		sh.fifoHead++
		if old.dead {
			continue
		}
		if old.buf.popHead() != old {
			panic("history: global FIFO out of step with subject FIFO")
		}
		sh.kill(old)
	}
	if sh.fifoHead > 4096 && sh.fifoHead > len(sh.fifo)/2 {
		sh.fifo = append(sh.fifo[:0], sh.fifo[sh.fifoHead:]...)
		sh.fifoHead = 0
	}
}

// kill releases a live entry's accounting and payload. Callers hold sh.mu.
func (sh *shard) kill(e *entry) {
	if e.dead {
		return
	}
	e.dead = true
	sh.bytes -= e.size
	sh.count--
	e.conn.bytes -= e.size
	e.conn.count--
	e.rec = nil
}

func (s *MemStore) Subject(connID, subject string, limit int, beforeSeq uint64) []message.NatsMessage {
	sh := s.shardOf(subject, 0)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	ch := sh.conns[connID]
	if ch == nil || limit <= 0 {
		return nil
	}
	buf := ch.subjects[subject]
	if buf == nil {
		return nil
	}
	end := buf.len()
	if beforeSeq > 0 {
		end = sort.Search(buf.len(), func(i int) bool { return buf.at(i).rec.Sequence >= beforeSeq })
	}
	start := max(0, end-limit)
	out := make([]message.NatsMessage, 0, end-start)
	for i := start; i < end; i++ {
		out = append(out, buf.at(i).rec.Wire(connID))
	}
	return out
}

// cursor walks one subject ring from newest to oldest.
type cursor struct {
	buf *subjectBuf
	i   int
}

func (c *cursor) cur() *entry { return c.buf.at(c.i) }

type cursorHeap []*cursor

func (h cursorHeap) Len() int { return len(h) }
func (h cursorHeap) Less(a, b int) bool {
	ma, mb := h[a].cur().rec, h[b].cur().rec
	if ma.Timestamp != mb.Timestamp {
		return ma.Timestamp > mb.Timestamp
	}
	return ma.Sequence > mb.Sequence
}
func (h cursorHeap) Swap(a, b int)       { h[a], h[b] = h[b], h[a] }
func (h *cursorHeap) Push(x interface{}) { *h = append(*h, x.(*cursor)) }
func (h *cursorHeap) Pop() interface{} {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

func (s *MemStore) Branch(connID, prefix string, limit int) []message.NatsMessage {
	if limit <= 0 {
		return nil
	}
	// All shards stay locked while merging so the snapshot is consistent.
	for _, sh := range s.shards {
		sh.mu.Lock()
	}
	defer func() {
		for _, sh := range s.shards {
			sh.mu.Unlock()
		}
	}()
	p := prefix + "."
	h := cursorHeap{}
	for _, sh := range s.shards {
		ch := sh.conns[connID]
		if ch == nil {
			continue
		}
		for subject, buf := range ch.subjects {
			if !strings.HasPrefix(subject, p) {
				continue
			}
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

// containsFold is an allocation-free, ASCII case-insensitive substring test;
// needle must already be lower case.
func containsFold(hay []byte, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	if len(hay) < len(needle) {
		return false
	}
	first := needle[0]
outer:
	for i := 0; i+len(needle) <= len(hay); i++ {
		c := hay[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != first {
			continue
		}
		for j := 1; j < len(needle); j++ {
			c := hay[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != needle[j] {
				continue outer
			}
		}
		return true
	}
	return false
}

func (s *MemStore) Search(connID, subject, q string, limit int) []message.NatsMessage {
	if limit <= 0 {
		return nil
	}
	// A trailing * is prefix syntax of the indexed search; in memory every
	// match is a substring anyway.
	needle := strings.ToLower(strings.TrimSuffix(q, "*"))
	for _, sh := range s.shards {
		sh.mu.Lock()
	}
	defer func() {
		for _, sh := range s.shards {
			sh.mu.Unlock()
		}
	}()
	// An empty subject searches everything the connection recorded.
	all := subject == ""
	p := subject + "."
	h := cursorHeap{}
	for _, sh := range s.shards {
		ch := sh.conns[connID]
		if ch == nil {
			continue
		}
		for subj, buf := range ch.subjects {
			if !all && subj != subject && !strings.HasPrefix(subj, p) {
				continue
			}
			if buf.len() > 0 {
				h = append(h, &cursor{buf: buf, i: buf.len() - 1})
			}
		}
	}
	if len(h) == 0 {
		return nil
	}
	heap.Init(&h)
	out := make([]message.NatsMessage, 0, min(limit, 64))
	for h.Len() > 0 && len(out) < limit {
		c := h[0]
		rec := c.cur().rec
		if containsFold([]byte(rec.Subject), needle) || (rec.Kind() != "binary" && containsFold(rec.Data, needle)) {
			out = append(out, rec.Wire(connID))
		}
		if c.i--; c.i >= 0 {
			heap.Fix(&h, 0)
		} else {
			heap.Pop(&h)
		}
	}
	return out
}

// DropSubjects forgets the recorded messages of individual subjects, used
// when a subscription no longer covers them.
func (s *MemStore) DropSubjects(connID string, subjects []string) {
	if len(subjects) == 0 {
		return
	}
	want := make(map[string]struct{}, len(subjects))
	for _, subject := range subjects {
		want[subject] = struct{}{}
	}
	for _, sh := range s.shards {
		sh.mu.Lock()
		if ch := sh.conns[connID]; ch != nil {
			for subject, buf := range ch.subjects {
				if _, ok := want[subject]; !ok {
					continue
				}
				for i := 0; i < buf.len(); i++ {
					sh.kill(buf.at(i))
				}
				delete(ch.subjects, subject)
			}
			if len(ch.subjects) == 0 {
				delete(sh.conns, connID)
			}
		}
		sh.mu.Unlock()
	}
}

func (s *MemStore) Drop(connID string) {
	for _, sh := range s.shards {
		sh.mu.Lock()
		if ch := sh.conns[connID]; ch != nil {
			for _, buf := range ch.subjects {
				for i := 0; i < buf.len(); i++ {
					sh.kill(buf.at(i))
				}
			}
			delete(sh.conns, connID)
		}
		sh.mu.Unlock()
	}
}

func (s *MemStore) Clear() {
	for _, sh := range s.shards {
		sh.mu.Lock()
		sh.conns = make(map[string]*connHist)
		sh.fifo = nil
		sh.fifoHead = 0
		sh.bytes = 0
		sh.count = 0
		sh.mu.Unlock()
	}
}

func (s *MemStore) Stats(connID string) Stats {
	var st Stats
	for _, sh := range s.shards {
		sh.mu.Lock()
		if connID == "" {
			st.Messages += sh.count
			st.Bytes += sh.bytes
			for _, ch := range sh.conns {
				st.Subjects += len(ch.subjects)
			}
		} else if ch := sh.conns[connID]; ch != nil {
			st.Messages += ch.count
			st.Bytes += ch.bytes
			st.Subjects += len(ch.subjects)
		}
		sh.mu.Unlock()
	}
	return st
}
