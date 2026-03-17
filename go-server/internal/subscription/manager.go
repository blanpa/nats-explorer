package subscription

import (
	"encoding/json"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
)

const (
	MaxMsgsPerSecondPerSubject = 10
	BatchIntervalMs            = 100
	TreeUpdateIntervalMs       = 500
)

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
	stopped bool

	OnBatch func(connID string, msgs []NatsMessage)
	OnTree  func(connID string, tree []SubjectNode)
}

func NewManager(connID string) *Manager {
	return &Manager{
		ConnID:     connID,
		Subjects:   []string{">"},
		stats:      make(map[string]*SubjectStats),
		emitCounts: make(map[string]int),
		stopCh:     make(chan struct{}),
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
	m.stopped = false
	m.stopCh = make(chan struct{})
	if len(subjects) > 0 {
		m.Subjects = subjects
	} else {
		m.Subjects = []string{">"}
	}
	m.mu.Unlock()

	for _, subj := range m.Subjects {
		sub, err := nc.Subscribe(subj, func(msg *nats.Msg) {
			m.handleMessage(msg)
		})
		if err != nil {
			return err
		}
		m.mu.Lock()
		m.subs = append(m.subs, sub)
		m.mu.Unlock()
	}

	// Batch flush ticker
	go func() {
		ticker := time.NewTicker(BatchIntervalMs * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-m.stopCh:
				return
			case <-ticker.C:
				m.flushBatch()
			}
		}
	}()

	// Tree update ticker
	go func() {
		ticker := time.NewTicker(TreeUpdateIntervalMs * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-m.stopCh:
				return
			case <-ticker.C:
				if m.OnTree != nil {
					tree := m.GetTree()
					m.OnTree(m.ConnID, tree)
				}
			}
		}
	}()

	// Throttle reset ticker (1s)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-m.stopCh:
				return
			case <-ticker.C:
				m.mu.Lock()
				m.emitCounts = make(map[string]int)
				m.mu.Unlock()
			}
		}
	}()

	return nil
}

func (m *Manager) Stop() {
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return
	}
	m.stopped = true
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

	m.mu.Lock()
	m.totalRecv++

	// Update stats always
	st, ok := m.stats[nm.Subject]
	if !ok {
		st = &SubjectStats{}
		m.stats[nm.Subject] = st
	}
	st.MessageCount++
	st.LastMessage = &nm
	now := time.Now().UnixMilli()
	st.Timestamps = append(st.Timestamps, now)
	if len(st.Timestamps) > 200 {
		cutoff := now - 10000
		filtered := st.Timestamps[:0]
		for _, t := range st.Timestamps {
			if t >= cutoff {
				filtered = append(filtered, t)
			}
		}
		st.Timestamps = filtered
	}

	// Throttle
	count := m.emitCounts[nm.Subject]
	if count < MaxMsgsPerSecondPerSubject {
		m.emitCounts[nm.Subject] = count + 1
		m.batch = append(m.batch, nm)
	} else {
		m.totalDropped++
	}
	m.mu.Unlock()
}

func (m *Manager) flushBatch() {
	m.mu.Lock()
	if len(m.batch) == 0 {
		m.mu.Unlock()
		return
	}
	batch := m.batch
	m.batch = nil
	m.mu.Unlock()

	if m.OnBatch != nil {
		m.OnBatch(m.ConnID, batch)
	}
}

func (m *Manager) GetTree() []SubjectNode {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return BuildTree(m.stats)
}

func convertMessage(msg *nats.Msg) NatsMessage {
	payload := string(msg.Data)
	payloadType := "string"

	if !utf8.Valid(msg.Data) {
		// Binary - base64 would be needed, but we'll just mark it
		payloadType = "binary"
	} else if len(payload) > 0 && (payload[0] == '{' || payload[0] == '[') {
		if json.Valid(msg.Data) {
			payloadType = "json"
		}
	}

	var headers map[string][]string
	if msg.Header != nil && len(msg.Header) > 0 {
		headers = make(map[string][]string)
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
