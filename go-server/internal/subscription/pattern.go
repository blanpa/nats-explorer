package subscription

import (
	"strings"
	"sync/atomic"
)

// PatternStats are the counters of one subscribed pattern.
type PatternStats struct {
	Pattern string `json:"pattern"`
	// Received counts messages delivered through this pattern.
	Received int64 `json:"received"`
	// Subjects seen that match the pattern; a subject matching several
	// patterns counts for each.
	Subjects int     `json:"subjects"`
	Rate     float64 `json:"rate"`
}

// patternStat is the mutable form behind PatternStats. The counters are
// atomic because every shard worker bumps them.
type patternStat struct {
	pattern  string
	received atomic.Int64
	subjects atomic.Int64
	lastRecv int64
	ring     [rateSamples]int64
}

func (p *patternStat) tick(idx int) {
	recv := p.received.Load()
	p.ring[idx%rateSamples] = recv - p.lastRecv
	p.lastRecv = recv
}

func (p *patternStat) stats(samples int) PatternStats {
	var sum int64
	for i := 0; i < samples; i++ {
		sum += p.ring[i]
	}
	st := PatternStats{Pattern: p.pattern, Received: p.received.Load(), Subjects: int(p.subjects.Load())}
	if samples > 0 {
		st.Rate = float64(sum) / float64(samples)
	}
	return st
}

// matchSubject reports whether a subject matches a NATS pattern: "*"
// matches one token, ">" the rest of the subject (at least one token).
func matchSubject(pattern, subject string) bool {
	pt := strings.Split(pattern, ".")
	st := strings.Split(subject, ".")
	for i, p := range pt {
		if p == ">" {
			return i == len(pt)-1 && len(st) > i
		}
		if i >= len(st) || (p != "*" && p != st[i]) {
			return false
		}
	}
	return len(pt) == len(st)
}
