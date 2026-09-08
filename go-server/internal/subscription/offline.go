package subscription

import (
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/message"
)

// Offline managers carry recorded messages instead of a live subscription:
// an imported support bundle. They run the same shards, tree and history as
// a live connection, so every module works on a bundle unchanged.

// StartOffline starts the machinery without subscribing to anything.
func (m *Manager) StartOffline(subjects []string) {
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

	for _, sh := range m.shards {
		m.workers.Add(1)
		go m.work(sh, stopCh)
	}
	go m.loop(stopCh, flushInterval, func() {
		for _, sh := range m.shards {
			sh.flush(stopCh)
		}
	})
	go m.loop(stopCh, BatchInterval, m.flushBatches)
	go m.treeLoop(stopCh)
	go m.loop(stopCh, StatsInterval, m.tick)
}

// Ingest pushes recorded messages through the same path a live message
// takes, keeping their own timestamps and sequence numbers, so the subject
// tree, the counters and the history end up as they were.
func (m *Manager) Ingest(msgs []message.NatsMessage) {
	m.mu.Lock()
	stopCh := m.stopCh
	running := m.running
	var ps *patternStat
	if patterns := m.patternList(); len(patterns) > 0 {
		ps = patterns[0]
	}
	m.mu.Unlock()
	if !running || ps == nil {
		return
	}
	for i := range msgs {
		wire := &msgs[i]
		data, err := message.DecodePayload(wire.Payload, wire.PayloadType)
		if err != nil {
			continue
		}
		msg := &nats.Msg{Subject: wire.Subject, Data: data, Reply: wire.Reply}
		if len(wire.Headers) > 0 {
			msg.Header = nats.Header{}
			for k, v := range wire.Headers {
				msg.Header[k] = v
			}
		}
		seq := wire.Sequence
		if seq == 0 {
			seq = uint64(m.totalRecv.Load() + 1)
		}
		m.totalRecv.Add(1)
		ts := wire.Timestamp
		if ts == 0 {
			ts = time.Now().UnixMilli()
		}
		m.shardOf(wire.Subject).enqueue(delivery{msg: msg, ps: ps, seq: seq, now: ts}, stopCh)
	}
	// Hand the tails of the batches to the workers right away, so a caller
	// that ingests and then reads does not wait for the flush tick.
	for _, sh := range m.shards {
		sh.flush(stopCh)
	}
}
