package subscription

import (
	"encoding/base64"
	"encoding/json"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
)

const (
	// MaxMsgsPerSecondPerSubject caps how many messages per subject are
	// forwarded to the browser each second. Stats and the tree still see
	// every message; only the live feed is throttled.
	MaxMsgsPerSecondPerSubject = 10
	// MaxFocusedMsgsPerSecond bounds the feed for subjects the browser is
	// looking at (selected subject or branch); MaxBackgroundMsgsPerSecond is
	// the shared budget for everything else, so a wide subject space cannot
	// flood the socket. Within the background budget the first message of a
	// subject per second has priority over repeats, keeping the per-subject
	// history fresh for as many subjects as possible.
	MaxFocusedMsgsPerSecond    = 5000
	MaxBackgroundMsgsPerSecond = 1000
	BatchInterval              = 100 * time.Millisecond
	TreeUpdateInterval         = 500 * time.Millisecond
	// maxTimestamps bounds the per-subject rate window so a very hot subject
	// cannot grow memory without limit.
	maxTimestamps = 2000
)

// NatsMessage is the wire format sent to the browser. Binary payloads are
// base64 encoded and flagged with PayloadType "binary".
type NatsMessage struct {
	Subject     string              `json:"subject"`
	Payload     string              `json:"payload"`
	PayloadType string              `json:"payloadType"` // "string", "json", "binary"
	Headers     map[string][]string `json:"headers,omitempty"`
	Timestamp   int64               `json:"timestamp"`
	Reply       string              `json:"reply,omitempty"`
	Size        int                 `json:"size"`
}

type SubjectStats struct {
	MessageCount int
	LastMessage  *NatsMessage
	Timestamps   []int64

	// what the tree feed last reported, to build deltas
	sentCount int
	sentRate  float64
}

// Stats is a snapshot of the manager counters.
type Stats struct {
	Received int64 `json:"received"`
	Dropped  int64 `json:"dropped"`
	Subjects int   `json:"subjects"`
}

type Manager struct {
	ConnID   string
	Subjects []string

	mu           sync.RWMutex
	stats        map[string]*SubjectStats
	subs         []*nats.Subscription
	batch        []NatsMessage
	emitCounts   map[string]int
	focusedSent  int
	bgSent       int
	focus        map[any]string // ws client -> focused subject (exact or branch)
	totalRecv    int64
	totalDropped int64
	needFull     bool

	stopCh  chan struct{}
	running bool

	OnBatch func(connID string, msgs []NatsMessage, stats Stats)
	// OnTree receives either a full snapshot (full=true, replaces everything
	// the browser knows) or the subjects that changed since the last call.
	OnTree func(connID string, full bool, entries []SubjectEntry)
}

func NewManager(connID string) *Manager {
	return &Manager{
		ConnID:     connID,
		Subjects:   []string{">"},
		stats:      make(map[string]*SubjectStats),
		emitCounts: make(map[string]int),
		focus:      make(map[any]string),
	}
}

// SetFocus marks the subject (or branch) a websocket client is looking at.
// Messages below it bypass the background budget. An empty subject clears it.
func (m *Manager) SetFocus(client any, subject string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if subject == "" {
		delete(m.focus, client)
		return
	}
	m.focus[client] = subject
}

func (m *Manager) ClearFocus(client any) { m.SetFocus(client, "") }

// isFocused reports whether subject equals or lies below any focused subject.
// Callers hold m.mu.
func (m *Manager) isFocused(subject string) bool {
	for _, f := range m.focus {
		if subject == f || (len(subject) > len(f) && subject[len(f)] == '.' && subject[:len(f)] == f) {
			return true
		}
	}
	return false
}

func (m *Manager) Start(nc *nats.Conn, subjects []string) error {
	m.Stop()

	m.mu.Lock()
	m.stats = make(map[string]*SubjectStats)
	m.emitCounts = make(map[string]int)
	m.batch = nil
	m.totalRecv = 0
	m.totalDropped = 0
	m.focusedSent = 0
	m.bgSent = 0
	m.needFull = true
	m.running = true
	m.stopCh = make(chan struct{})
	if len(subjects) > 0 {
		m.Subjects = subjects
	} else {
		m.Subjects = []string{">"}
	}
	stopCh := m.stopCh
	m.mu.Unlock()

	for _, subj := range m.Subjects {
		sub, err := nc.Subscribe(subj, m.handleMessage)
		if err != nil {
			m.Stop()
			return err
		}
		m.mu.Lock()
		m.subs = append(m.subs, sub)
		m.mu.Unlock()
	}

	go m.loop(stopCh, BatchInterval, m.flushBatch)
	go m.treeLoop(stopCh)
	go m.loop(stopCh, time.Second, func() {
		m.mu.Lock()
		m.emitCounts = make(map[string]int)
		m.focusedSent = 0
		m.bgSent = 0
		m.mu.Unlock()
	})

	return nil
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

// emitTree sends the pending snapshot or delta and returns the subject count.
func (m *Manager) emitTree() int {
	m.mu.Lock()
	full := m.needFull
	m.needFull = false
	entries := m.collectEntries(full)
	subjects := len(m.stats)
	m.mu.Unlock()

	if m.OnTree != nil && (full || len(entries) > 0) {
		m.OnTree(m.ConnID, full, entries)
	}
	return subjects
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

	m.flushBatch()
}

func (m *Manager) handleMessage(msg *nats.Msg) {
	nm := convertMessage(msg)
	now := nm.Timestamp

	m.mu.Lock()
	defer m.mu.Unlock()

	m.totalRecv++

	st, ok := m.stats[nm.Subject]
	if !ok {
		st = &SubjectStats{}
		m.stats[nm.Subject] = st
	}
	st.MessageCount++
	st.LastMessage = &nm
	st.Timestamps = append(st.Timestamps, now)
	if len(st.Timestamps) > 200 {
		cutoff := now - rateWindowMs
		filtered := st.Timestamps[:0]
		for _, t := range st.Timestamps {
			if t >= cutoff {
				filtered = append(filtered, t)
			}
		}
		if len(filtered) > maxTimestamps {
			filtered = filtered[len(filtered)-maxTimestamps:]
		}
		st.Timestamps = filtered
	}

	if m.admit(nm.Subject) {
		m.batch = append(m.batch, nm)
	} else {
		m.totalDropped++
	}
}

// admit decides whether a message joins the live feed and charges the
// budgets. Callers hold m.mu.
func (m *Manager) admit(subject string) bool {
	count := m.emitCounts[subject]
	if count >= MaxMsgsPerSecondPerSubject {
		return false
	}
	switch {
	case m.isFocused(subject):
		if m.focusedSent >= MaxFocusedMsgsPerSecond {
			return false
		}
		m.focusedSent++
	case count == 0:
		if m.bgSent >= MaxBackgroundMsgsPerSecond {
			return false
		}
		m.bgSent++
	default:
		if m.bgSent >= MaxBackgroundMsgsPerSecond/2 {
			return false
		}
		m.bgSent++
	}
	m.emitCounts[subject] = count + 1
	return true
}

func (m *Manager) flushBatch() {
	m.mu.Lock()
	if len(m.batch) == 0 {
		m.mu.Unlock()
		return
	}
	batch := m.batch
	m.batch = nil
	stats := Stats{Received: m.totalRecv, Dropped: m.totalDropped, Subjects: len(m.stats)}
	m.mu.Unlock()

	if m.OnBatch != nil {
		m.OnBatch(m.ConnID, batch, stats)
	}
}

// Snapshot returns every subject for a newly connected browser. It does not
// touch the delta bookkeeping of the running feed.
func (m *Manager) Snapshot() []SubjectEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UnixMilli()
	out := make([]SubjectEntry, 0, len(m.stats))
	for subject, st := range m.stats {
		out = append(out, entryOf(subject, st, rateOf(st, now)))
	}
	return out
}

func (m *Manager) GetStats() Stats {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return Stats{Received: m.totalRecv, Dropped: m.totalDropped, Subjects: len(m.stats)}
}

// EncodePayload classifies raw bytes into the wire representation.
func EncodePayload(data []byte) (payload string, payloadType string) {
	if !utf8.Valid(data) {
		return base64.StdEncoding.EncodeToString(data), "binary"
	}
	payload = string(data)
	if len(data) > 0 && (data[0] == '{' || data[0] == '[') && json.Valid(data) {
		return payload, "json"
	}
	return payload, "string"
}

func convertMessage(msg *nats.Msg) NatsMessage {
	payload, payloadType := EncodePayload(msg.Data)

	var headers map[string][]string
	if len(msg.Header) > 0 {
		headers = make(map[string][]string, len(msg.Header))
		for k, v := range msg.Header {
			headers[k] = v
		}
	}

	return NatsMessage{
		Subject:     msg.Subject,
		Payload:     payload,
		PayloadType: payloadType,
		Headers:     headers,
		Timestamp:   time.Now().UnixMilli(),
		Reply:       msg.Reply,
		Size:        len(msg.Data),
	}
}
