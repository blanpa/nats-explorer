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
	totalRecv    int64
	totalDropped int64

	stopCh  chan struct{}
	running bool

	OnBatch func(connID string, msgs []NatsMessage, stats Stats)
	OnTree  func(connID string, tree []SubjectNode)
}

func NewManager(connID string) *Manager {
	return &Manager{
		ConnID:     connID,
		Subjects:   []string{">"},
		stats:      make(map[string]*SubjectStats),
		emitCounts: make(map[string]int),
	}
}

func (m *Manager) Start(nc *nats.Conn, subjects []string) error {
	m.Stop()

	m.mu.Lock()
	m.stats = make(map[string]*SubjectStats)
	m.emitCounts = make(map[string]int)
	m.batch = nil
	m.totalRecv = 0
	m.totalDropped = 0
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
	go m.loop(stopCh, TreeUpdateInterval, func() {
		if m.OnTree != nil {
			m.OnTree(m.ConnID, m.GetTree())
		}
	})
	go m.loop(stopCh, time.Second, func() {
		m.mu.Lock()
		m.emitCounts = make(map[string]int)
		m.mu.Unlock()
	})

	return nil
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

	count := m.emitCounts[nm.Subject]
	if count < MaxMsgsPerSecondPerSubject {
		m.emitCounts[nm.Subject] = count + 1
		m.batch = append(m.batch, nm)
	} else {
		m.totalDropped++
	}
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

func (m *Manager) GetTree() []SubjectNode {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return BuildTree(m.stats)
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
