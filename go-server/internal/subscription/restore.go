package subscription

import (
	"context"
	"fmt"
	"os"
	"time"

	"nats-explorer/internal/history"
)

// Bringing the subject tree back from the persistent history. Without this a
// restart shows an empty tree until every subject sends again -- on a
// namespace where some subjects report once an hour that can take an hour,
// even though the messages are on disk and a time range would find them.

const (
	// MaxRestoredSubjects bounds what a restart brings back, so a namespace
	// of hundreds of thousands of subjects cannot stall a connect.
	MaxRestoredSubjects = 50_000
	// restoreTimeout gives up rather than holding up the connection.
	restoreTimeout = 5 * time.Second
)

// restoreSubjects seeds the tree and the per-subject counters from the
// persistent history, for the subjects the current patterns cover. The
// newest message comes back with the count, so the tree shows its value and
// the payload filter can judge the subject; only the rate stays at zero,
// because that describes the live connection and nothing else. Without a
// database this does nothing.
//
// Called from Start after the reset and before the subscriptions exist, so
// nothing else is touching the tree or the shards yet.
func (m *Manager) restoreSubjects(patterns []*patternStat) {
	loader, ok := m.History.(history.SubjectLoader)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	recorded, err := loader.RecordedSubjects(ctx, m.ConnID, MaxRestoredSubjects)
	if err != nil {
		// A connection that works without its old tree is better than one
		// that refuses to open.
		fmt.Fprintf(os.Stderr, "history: subjects of %s not restored: %v\n", m.ConnID, err)
		return
	}
	if len(recorded) == 0 {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	var restored int64
	for _, rs := range recorded {
		covered := false
		for _, p := range patterns {
			if matchSubject(p.pattern, rs.Subject) {
				covered = true
				p.subjects.Add(1)
			}
		}
		// The database outlives the subscriptions: what no pattern covers
		// any more stays on disk but out of this connection's tree.
		if !covered {
			continue
		}
		sh := m.shardOf(rs.Subject)
		sh.mu.Lock()
		if _, exists := sh.subjects[rs.Subject]; !exists {
			sh.subjects[rs.Subject] = &SubjectStats{Count: rs.Count, Last: rs.Last}
			restored++
		}
		sh.mu.Unlock()
		m.tree.observe(rs.Subject, rs.Count, 0, rs.Last)
	}
	m.subjectCount.Add(restored)
}
