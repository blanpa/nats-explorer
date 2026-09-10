package handler

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/filter"
	"nats-explorer/internal/subject"
)

// MatchHandler answers "who would receive this?" for one concrete subject.
//
// Wildcards are where most NATS debugging time goes: `*` covers one token
// and `>` the rest, stream subjects overlap, and a consumer filter one level
// too deep is invisible until nothing arrives. Working that out by hand
// means reading four lists and matching patterns in your head.
type MatchHandler struct {
	Store *connection.Store
}

// MatchStream is a stream that captures the subject, with the patterns of
// its own that do, and the consumers whose filter also does.
type MatchStream struct {
	Name string `json:"name"`
	// Subjects are the stream's own patterns that match, so the answer says
	// which one did it rather than only that the stream did.
	Subjects  []string        `json:"subjects"`
	Consumers []MatchConsumer `json:"consumers"`
	// Filtered is how many consumers of the stream have a filter that does
	// not match, which is the difference between "no consumer" and "no
	// consumer for this".
	Filtered int `json:"filtered"`
}

// MatchConsumer is a consumer whose filter covers the subject. A consumer
// without a filter takes everything the stream has.
type MatchConsumer struct {
	Name string `json:"name"`
	// Subjects are its filters that match; empty means it has none and
	// therefore takes every subject of the stream.
	Subjects []string `json:"subjects"`
	Push     bool     `json:"push,omitempty"`
}

// MatchResponse is what a concrete subject runs into on its way through.
type MatchResponse struct {
	Subject string `json:"subject"`
	// Streams that would store it, with the consumers that would see it.
	Streams []MatchStream `json:"streams"`
	// SchemaPattern is the pinned schema that judges it, empty when none.
	SchemaPattern string `json:"schemaPattern,omitempty"`
	// JetStream says whether the streams could be read at all; without it
	// an empty list would read as "no stream stores this".
	JetStream bool   `json:"jetStream"`
	Error     string `json:"error,omitempty"`
}

// Match answers GET /api/match?subject=&connId=.
func (h *MatchHandler) Match(w http.ResponseWriter, r *http.Request) {
	subj := r.URL.Query().Get("subject")
	if subj == "" {
		writeError(w, http.StatusBadRequest, "subject is required")
		return
	}
	// A concrete subject, not a pattern: the question is what this one
	// message would run into, and a wildcard cannot answer it.
	if strings.ContainsAny(subj, " \t*>") {
		writeError(w, http.StatusBadRequest, "give one concrete subject, without wildcards")
		return
	}
	resp := MatchResponse{Subject: subj, Streams: []MatchStream{}}
	if _, pattern := filter.CheckSchema(subj, "json", nil); pattern != "" {
		resp.SchemaPattern = pattern
	}

	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		// No JetStream is an answer, not a failure: the subscriptions and
		// the rules on the browser side are still worth showing.
		resp.Error = err.Error()
		writeJSON(w, resp)
		return
	}
	resp.JetStream = true

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	for si := range js.ListStreams(ctx).Info() {
		hit := matchingPatterns(si.Config.Subjects, subj)
		if len(hit) == 0 {
			continue
		}
		ms := MatchStream{Name: si.Config.Name, Subjects: hit, Consumers: []MatchConsumer{}}
		s, err := js.Stream(ctx, si.Config.Name)
		if err == nil {
			for ci := range s.ListConsumers(ctx).Info() {
				filters := consumerFilters(ci.Config)
				if len(filters) == 0 {
					// No filter: it takes everything the stream stores.
					ms.Consumers = append(ms.Consumers, MatchConsumer{Name: ci.Name, Push: ci.Config.DeliverSubject != ""})
					continue
				}
				if f := matchingPatterns(filters, subj); len(f) > 0 {
					ms.Consumers = append(ms.Consumers, MatchConsumer{Name: ci.Name, Subjects: f, Push: ci.Config.DeliverSubject != ""})
				} else {
					ms.Filtered++
				}
			}
		}
		resp.Streams = append(resp.Streams, ms)
	}
	writeJSON(w, resp)
}

// consumerFilters is the filter of a consumer, whichever of the two ways it
// was configured; empty means it has none.
func consumerFilters(cfg jetstream.ConsumerConfig) []string {
	if len(cfg.FilterSubjects) > 0 {
		return cfg.FilterSubjects
	}
	if cfg.FilterSubject != "" {
		return []string{cfg.FilterSubject}
	}
	return nil
}

// matchingPatterns keeps the patterns that cover the subject.
func matchingPatterns(patterns []string, subj string) []string {
	out := make([]string, 0, 1)
	for _, p := range patterns {
		if subject.Match(p, subj) {
			out = append(out, p)
		}
	}
	return out
}
