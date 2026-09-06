package subscription

import (
	"time"
	"unicode/utf8"
)

const (
	// rateWindowMs is the sliding window used to compute per-subject message rates.
	rateWindowMs = 10_000
	// PreviewMaxChars bounds the payload preview carried by the tree feed. The
	// browser only renders a short excerpt per row; full messages travel in the
	// message batches instead.
	PreviewMaxChars = 160
)

// SubjectEntry is the compact wire form of one subject in the tree feed. The
// browser rebuilds the hierarchy itself. Keys are short on purpose: with tens
// of thousands of subjects the feed is the largest thing on the socket.
type SubjectEntry struct {
	Subject string  `json:"s"`
	Count   int     `json:"n"`
	Rate    float64 `json:"r"`
	// Preview of the most recent payload, cut to PreviewMaxChars. Binary
	// payloads carry no preview, only the type.
	Payload     string `json:"p,omitempty"`
	PayloadType string `json:"pt,omitempty"`
	Timestamp   int64  `json:"ts,omitempty"`
	Size        int    `json:"sz,omitempty"`
}

// treeInterval slows the tree feed down as the tree grows so a huge subject
// space does not saturate the socket and the browser's main thread.
func treeInterval(subjects int) time.Duration {
	switch {
	case subjects > 10_000:
		return 2 * time.Second
	case subjects > 2_000:
		return time.Second
	default:
		return TreeUpdateInterval
	}
}

// rateOf counts the timestamps inside the window and prunes older ones. The
// slice is append-only in arrival order, so the prefix outside the window can
// be sliced off.
func rateOf(st *SubjectStats, now int64) float64 {
	cutoff := now - rateWindowMs
	i := 0
	for i < len(st.Timestamps) && st.Timestamps[i] < cutoff {
		i++
	}
	if i > 0 {
		st.Timestamps = append(st.Timestamps[:0], st.Timestamps[i:]...)
	}
	return float64(len(st.Timestamps)) / (rateWindowMs / 1000.0)
}

func entryOf(subject string, st *SubjectStats, rate float64) SubjectEntry {
	e := SubjectEntry{Subject: subject, Count: st.MessageCount, Rate: rate}
	if lm := st.LastMessage; lm != nil {
		e.PayloadType = lm.PayloadType
		e.Timestamp = lm.Timestamp
		e.Size = lm.Size
		if lm.PayloadType != "binary" {
			e.Payload = truncateRunes(lm.Payload, PreviewMaxChars)
		}
	}
	return e
}

func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i] + "…"
		}
		n++
	}
	return s
}

// collectEntries returns the full snapshot (full=true) or only the subjects
// whose count or rate changed since the previous emit. Callers hold m.mu.
func (m *Manager) collectEntries(full bool) []SubjectEntry {
	now := time.Now().UnixMilli()
	out := make([]SubjectEntry, 0, 64)
	for subject, st := range m.stats {
		rate := rateOf(st, now)
		if full || st.MessageCount != st.sentCount || rate != st.sentRate {
			st.sentCount = st.MessageCount
			st.sentRate = rate
			out = append(out, entryOf(subject, st, rate))
		}
	}
	return out
}
