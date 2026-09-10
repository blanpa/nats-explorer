package subscription

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
)

const (
	// MaxMsgsPerSecondPerSubject caps the live feed per subject and browser
	// tab. The history keeps every message; the feed only carries what the
	// browser renders as it arrives.
	MaxMsgsPerSecondPerSubject = 50
	// MaxMsgsPerSecondPerClient bounds one browser tab's feed across all
	// subjects of the branch it looks at. Within the budget the first message
	// of a subject per second has priority over repeats, so a wide branch
	// keeps every subject fresh instead of a few hot ones.
	MaxMsgsPerSecondPerClient = 2000
	BatchInterval             = 100 * time.Millisecond
	TreeUpdateInterval        = 500 * time.Millisecond
	StatsInterval             = time.Second
	// rateSamples is how many one-second counts the reported rate averages.
	rateSamples = 3
	// shardQueue is the hand-off buffer (in batches) between a subscription's
	// delivery goroutine and a shard worker; batchSize messages travel per
	// hand-off, and a flusher sends partial batches every flushInterval so
	// low rates keep their latency.
	shardQueue    = 64
	batchSize     = 128
	flushInterval = 5 * time.Millisecond
)

// SubjectStats is what a shard keeps per subject: count, last message and
// the per-second buckets its rate is computed from.
type SubjectStats struct {
	Count int
	Last  *message.Record
	rate  rateBuckets
}

// Stats is a snapshot of the manager counters, sent to the browser once a
// second.
type Stats struct {
	Received int64 `json:"received"`
	// Throttled counts messages of a focused subject that did not fit a
	// browser tab's feed budget. They are still counted and kept in history.
	Throttled int64 `json:"throttled"`
	Subjects  int   `json:"subjects"`
	// Rate is the number of messages received per second, averaged over the
	// last few seconds.
	Rate    float64       `json:"rate"`
	History history.Stats `json:"history"`
	// Patterns are the counters per subscribed pattern.
	Patterns []PatternStats `json:"patterns"`
}

// client is what one browser tab receives: the messages of the subjects or
// branches it watches, within its budget. Its own lock keeps the feed off
// the manager lock.
type client struct {
	mu         sync.Mutex
	focus      []string
	batch      []*message.Record
	sent       int
	perSubject map[string]int
	view       *clientView
}

func newClient() *client {
	return &client{perSubject: make(map[string]int), view: newClientView()}
}

func (c *client) wants(subject string) bool {
	for _, f := range c.focus {
		if subject == f || (len(subject) > len(f) && subject[len(f)] == '.' && subject[:len(f)] == f) {
			return true
		}
	}
	return false
}

// admit decides whether a message joins the client's feed and charges its
// budgets. Callers hold c.mu.
func (c *client) admit(subject string) bool {
	n := c.perSubject[subject]
	if n >= MaxMsgsPerSecondPerSubject || c.sent >= MaxMsgsPerSecondPerClient {
		return false
	}
	if n > 0 && c.sent >= MaxMsgsPerSecondPerClient/2 {
		return false
	}
	c.perSubject[subject] = n + 1
	c.sent++
	return true
}

// resetSecond starts the budgets over. Callers hold c.mu.
func (c *client) resetSecond() {
	c.sent = 0
	clear(c.perSubject)
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// delivery is one message on its way from nats.go to a shard worker. The
// sequence and time are taken on arrival, so they reflect the order in
// which nats.go delivered, not the order in which shards got to work.
type delivery struct {
	msg *nats.Msg
	ps  *patternStat
	seq uint64
	now int64
}

// shard owns the subjects whose hash lands on it. Its worker is the only
// goroutine that touches its map, and the tree learns about changes at
// tick time, so the hot path never takes the manager lock.
type shard struct {
	mu       sync.Mutex
	subjects map[string]*SubjectStats
	// subjects with new messages since the last tick, and every subject
	// whose rate window is still non-empty (their rates decay)
	dirty  []string
	active map[string]struct{}

	// hand-off: deliveries collect in pend and travel as batches
	pendMu sync.Mutex
	pend   []delivery
	in     chan []delivery
}

func newShard() *shard {
	return &shard{subjects: make(map[string]*SubjectStats), active: make(map[string]struct{}), in: make(chan []delivery, shardQueue)}
}

// enqueue adds a delivery to the shard's pending batch and hands a full
// batch over. Called on nats.go's delivery goroutine.
func (sh *shard) enqueue(d delivery, stopCh <-chan struct{}) {
	sh.pendMu.Lock()
	if sh.pend == nil {
		sh.pend = make([]delivery, 0, batchSize)
	}
	sh.pend = append(sh.pend, d)
	if len(sh.pend) < batchSize {
		sh.pendMu.Unlock()
		return
	}
	batch := sh.pend
	sh.pend = nil
	sh.pendMu.Unlock()
	sh.send(batch, stopCh)
}

// flush hands over whatever is pending.
func (sh *shard) flush(stopCh <-chan struct{}) {
	sh.pendMu.Lock()
	batch := sh.pend
	sh.pend = nil
	sh.pendMu.Unlock()
	if len(batch) > 0 {
		sh.send(batch, stopCh)
	}
}

// send blocks rather than drops, so pressure lands in nats.go's pending
// buffer; a stopping manager releases the sender.
func (sh *shard) send(batch []delivery, stopCh <-chan struct{}) {
	select {
	case sh.in <- batch:
	case <-stopCh:
	}
}

type Manager struct {
	ConnID   string
	Subjects []string
	// History records every message when set. Stop drops the connection's
	// history again.
	History history.Store

	// hot path, lock-free from the manager's point of view
	shards         []*shard
	totalRecv      atomic.Int64
	totalThrottled atomic.Int64
	subjectCount   atomic.Int64
	focused        atomic.Pointer[[]*client] // clients with a focus, replaced on change

	// control plane
	mu      sync.RWMutex
	tree    *tree
	subs    []*nats.Subscription
	clients map[any]*client
	// patterns is read on the hot path by process() under the shard lock, so
	// it is swapped atomically instead of being guarded by m.mu; writers hold
	// m.mu as well, readers elsewhere go through patternList().
	patterns atomic.Pointer[[]*patternStat]
	lastRecv int64
	rateRing [rateSamples]int64
	rateIdx  int

	stopCh  chan struct{}
	running bool
	workers sync.WaitGroup

	// OnBatch delivers the feed of one browser tab.
	OnBatch func(client any, connID string, msgs []message.NatsMessage)
	// OnTree delivers the tree update of one browser tab.
	OnTree func(client any, connID string, update *TreeUpdate)
	// OnStats is called once a second with the counters.
	OnStats func(connID string, stats Stats)
	// OnRecord sees every received message, on the shard workers: several
	// goroutines call it at once, and it runs on the hot path.
	OnRecord func(connID string, r *message.Record)
}

func NewManager(connID string) *Manager {
	m := &Manager{
		ConnID:   connID,
		Subjects: []string{">"},
		tree:     newTree(),
		clients:  make(map[any]*client),
	}
	m.shards = make([]*shard, min(16, max(2, runtime.NumCPU())))
	for i := range m.shards {
		m.shards[i] = newShard()
	}
	empty := []*client{}
	m.focused.Store(&empty)
	return m
}

func (m *Manager) shardOf(subject string) *shard {
	return m.shards[message.SubjectHash(subject)%uint32(len(m.shards))]
}

// refreshFocused rebuilds the snapshot the hot path reads. Callers hold m.mu.
func (m *Manager) refreshFocused() {
	list := make([]*client, 0, len(m.clients))
	for _, cl := range m.clients {
		cl.mu.Lock()
		if len(cl.focus) > 0 {
			list = append(list, cl)
		}
		cl.mu.Unlock()
	}
	m.focused.Store(&list)
}

// SetFocus subscribes a websocket client to the messages of the given
// subjects or branches; an empty list stops the feed.
func (m *Manager) SetFocus(c any, subjects []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cl := m.clients[c]
	if cl == nil {
		cl = newClient()
		m.clients[c] = cl
	}
	cl.mu.Lock()
	if !sameStrings(cl.focus, subjects) {
		cl.focus = append([]string(nil), subjects...)
		cl.batch = nil
		cl.resetSecond()
	}
	cl.mu.Unlock()
	m.refreshFocused()
}

// SetView tells the manager what part of the tree a client shows. The
// difference to what the client has is sent right away.
func (m *Manager) SetView(c any, view View) {
	m.mu.Lock()
	cl := m.clients[c]
	if cl == nil {
		cl = newClient()
		m.clients[c] = cl
	}
	cl.view.set(view)
	running := m.running
	m.mu.Unlock()
	if running {
		m.emitTree()
	}
}

// RemoveClient forgets a websocket client that went away.
func (m *Manager) RemoveClient(c any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.clients, c)
	m.refreshFocused()
}

func (m *Manager) Start(nc *nats.Conn, subjects []string) error {
	m.Stop()

	m.mu.Lock()
	m.tree = newTree()
	for _, sh := range m.shards {
		sh.mu.Lock()
		sh.subjects = make(map[string]*SubjectStats)
		sh.dirty = nil
		sh.active = make(map[string]struct{})
		sh.mu.Unlock()
		sh.pendMu.Lock()
		sh.pend = nil
		sh.pendMu.Unlock()
	}
	for _, cl := range m.clients {
		cl.mu.Lock()
		cl.batch = nil
		cl.resetSecond()
		cl.mu.Unlock()
		cl.view.needFull = true
	}
	m.totalRecv.Store(0)
	m.totalThrottled.Store(0)
	m.subjectCount.Store(0)
	m.lastRecv = 0
	m.rateRing = [rateSamples]int64{}
	m.rateIdx = 0
	m.running = true
	m.stopCh = make(chan struct{})
	if len(subjects) > 0 {
		m.Subjects = subjects
	} else {
		m.Subjects = []string{">"}
	}
	patterns := make([]*patternStat, len(m.Subjects))
	for i, subj := range m.Subjects {
		patterns[i] = &patternStat{pattern: subj}
	}
	m.patterns.Store(&patterns)
	stopCh := m.stopCh
	m.mu.Unlock()

	// What the persistent history recorded for this connection comes back
	// before the first message arrives, so the tree is not empty after a
	// restart.
	m.restoreSubjects(patterns)

	for _, sh := range m.shards {
		m.workers.Add(1)
		go m.work(sh, stopCh)
	}

	for i, subj := range m.Subjects {
		ps := patterns[i]
		sub, err := nc.Subscribe(subj, func(msg *nats.Msg) {
			m.shardOf(msg.Subject).enqueue(delivery{msg: msg, ps: ps, seq: uint64(m.totalRecv.Add(1)), now: time.Now().UnixMilli()}, stopCh)
		})
		if err != nil {
			m.Stop()
			return err
		}
		m.mu.Lock()
		m.subs = append(m.subs, sub)
		m.mu.Unlock()
	}

	go m.loop(stopCh, flushInterval, func() {
		for _, sh := range m.shards {
			sh.flush(stopCh)
		}
	})
	go m.loop(stopCh, BatchInterval, m.flushBatches)
	go m.treeLoop(stopCh)
	go m.loop(stopCh, StatsInterval, m.tick)

	return nil
}

// work drains a shard's queue until the manager stops.
func (m *Manager) work(sh *shard, stopCh <-chan struct{}) {
	defer m.workers.Done()
	for {
		select {
		case <-stopCh:
			return
		case batch := <-sh.in:
			for _, d := range batch {
				m.process(sh, d)
			}
		}
	}
}

// patternList returns the current patterns. Safe from any goroutine: the
// slice is replaced, never edited, when the subscriptions change.
func (m *Manager) patternList() []*patternStat {
	if p := m.patterns.Load(); p != nil {
		return *p
	}
	return nil
}

// process is the per-message hot path: count, remember, feed, record.
func (m *Manager) process(sh *shard, d delivery) {
	now := d.now
	rec := message.NewRecord(d.msg, d.seq, now)
	d.ps.received.Add(1)

	sh.mu.Lock()
	st, ok := sh.subjects[rec.Subject]
	if !ok {
		st = &SubjectStats{}
		sh.subjects[rec.Subject] = st
		m.subjectCount.Add(1)
		for _, p := range m.patternList() {
			if matchSubject(p.pattern, rec.Subject) {
				p.subjects.Add(1)
			}
		}
	}
	st.Count++
	st.Last = rec
	st.rate.hit(now)
	if _, active := sh.active[rec.Subject]; !active {
		sh.active[rec.Subject] = struct{}{}
	}
	sh.dirty = append(sh.dirty, rec.Subject)
	sh.mu.Unlock()

	for _, cl := range *m.focused.Load() {
		if !cl.wants(rec.Subject) {
			continue
		}
		cl.mu.Lock()
		if cl.admit(rec.Subject) {
			cl.batch = append(cl.batch, rec)
		} else {
			m.totalThrottled.Add(1)
		}
		cl.mu.Unlock()
	}

	if m.History != nil {
		m.History.Append(m.ConnID, rec)
	}
	if m.OnRecord != nil {
		m.OnRecord(m.ConnID, rec)
	}
}

// treeLoop emits tree deltas; the pause between emits grows with the tree.
func (m *Manager) treeLoop(stopCh <-chan struct{}) {
	timer := time.NewTimer(TreeUpdateInterval)
	defer timer.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-timer.C:
			timer.Reset(treeInterval(m.emitTree()))
		}
	}
}

// syncTree carries the shards' changes into the tree: new counts, last
// messages and decayed rates. Callers hold m.mu.
func (m *Manager) syncTree(now int64) {
	for _, sh := range m.shards {
		sh.mu.Lock()
		touched := sh.dirty
		sh.dirty = nil
		seen := make(map[string]struct{}, len(touched))
		for _, subject := range touched {
			if _, dup := seen[subject]; dup {
				continue
			}
			seen[subject] = struct{}{}
			// A subject can disappear between the change and this tick, when
			// a subscription stopped covering it.
			st := sh.subjects[subject]
			if st == nil {
				continue
			}
			m.tree.observe(subject, st.Count, st.rate.value(now), st.Last)
		}
		// Rates of subjects without new messages still decay.
		for subject := range sh.active {
			if _, done := seen[subject]; done {
				continue
			}
			st := sh.subjects[subject]
			if st == nil {
				delete(sh.active, subject)
				continue
			}
			rate := st.rate.value(now)
			if n := m.tree.nodes[subject]; n != nil && n.rate != rate {
				m.tree.observe(subject, st.Count, rate, st.Last)
			}
			if rate == 0 {
				delete(sh.active, subject)
			}
		}
		sh.mu.Unlock()
	}
}

// emitTree refreshes the aggregates and sends every tab the part of the
// change it can see. Returns the subject count for the interval back-off.
func (m *Manager) emitTree() int {
	type pending struct {
		c  any
		up *TreeUpdate
	}
	m.mu.Lock()
	m.syncTree(time.Now().UnixMilli())
	dirty := m.tree.refresh()
	var out []pending
	for c, cl := range m.clients {
		if up := cl.view.update(m.tree, dirty); up != nil {
			out = append(out, pending{c, up})
		}
	}
	m.tree.clearDirty()
	m.mu.Unlock()

	if m.OnTree != nil {
		for _, p := range out {
			m.OnTree(p.c, m.ConnID, p.up)
		}
	}
	return int(m.subjectCount.Load())
}

func (m *Manager) loop(stopCh <-chan struct{}, every time.Duration, fn func()) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			fn()
		}
	}
}

func (m *Manager) Stop() {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	m.running = false
	close(m.stopCh)
	for _, sub := range m.subs {
		sub.Unsubscribe()
	}
	m.subs = nil
	m.mu.Unlock()

	m.workers.Wait()
	m.flushBatches()
	if m.History != nil {
		m.History.Drop(m.ConnID)
	}
}

func (m *Manager) flushBatches() {
	type pending struct {
		c    any
		msgs []message.NatsMessage
	}
	m.mu.RLock()
	var out []pending
	for c, cl := range m.clients {
		cl.mu.Lock()
		batch := cl.batch
		cl.batch = nil
		cl.mu.Unlock()
		if len(batch) == 0 {
			continue
		}
		msgs := make([]message.NatsMessage, len(batch))
		for i, rec := range batch {
			msgs[i] = rec.Wire("")
		}
		out = append(out, pending{c, msgs})
	}
	m.mu.RUnlock()

	if m.OnBatch == nil {
		return
	}
	for _, p := range out {
		m.OnBatch(p.c, m.ConnID, p.msgs)
	}
}

// tick runs once a second: budgets start over and the counters go out.
func (m *Manager) tick() {
	m.mu.Lock()
	for _, cl := range m.clients {
		cl.mu.Lock()
		cl.resetSecond()
		cl.mu.Unlock()
	}
	recv := m.totalRecv.Load()
	m.rateRing[m.rateIdx%rateSamples] = recv - m.lastRecv
	for _, p := range m.patternList() {
		p.tick(m.rateIdx)
	}
	m.rateIdx++
	m.lastRecv = recv
	stats := m.statsLocked()
	m.mu.Unlock()

	if m.OnStats != nil {
		m.OnStats(m.ConnID, stats)
	}
}

// statsLocked builds the counters. Callers hold m.mu.
func (m *Manager) statsLocked() Stats {
	var sum int64
	n := min(m.rateIdx, rateSamples)
	for i := 0; i < n; i++ {
		sum += m.rateRing[i]
	}
	st := Stats{Received: m.totalRecv.Load(), Throttled: m.totalThrottled.Load(), Subjects: int(m.subjectCount.Load())}
	if n > 0 {
		st.Rate = float64(sum) / float64(n)
	}
	if m.History != nil {
		st.History = m.History.Stats(m.ConnID)
	}
	patterns := m.patternList()
	st.Patterns = make([]PatternStats, 0, len(patterns))
	for _, p := range patterns {
		st.Patterns = append(st.Patterns, p.stats(n))
	}
	return st
}

func (m *Manager) GetStats() Stats {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.statsLocked()
}
