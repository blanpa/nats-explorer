package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"nats-explorer/internal/filter"
	"nats-explorer/internal/schema"
	"nats-explorer/internal/subject"
)

// A pinned schema is the reference the derived one lacks. Drift only compares
// the samples to each other, so a subject that has always been wrong looks
// consistent; pinning says "this is what it should be" and every message can
// be judged against it afterwards.
//
// The judgement is exposed through the payload filter (`valid`,
// `violations`), which is what makes it reach everything at once: the
// subject tree, the history endpoints, a time range, the search and the
// alert rules all already speak CEL. `!valid` is a complete alert rule.

// pinnedKey is where the pinned schemas live in the settings store.
const pinnedKey = "ne.schemas.v1"

// maxPinned bounds the registry; every message is matched against all of them.
const maxPinned = 200

// PinnedSchema is one schema pinned for a subject pattern.
type PinnedSchema struct {
	ID      string `json:"id"`
	Pattern string `json:"pattern"`
	Note    string `json:"note,omitempty"`
	// PinnedAt is when it was taken, unix ms.
	PinnedAt int64 `json:"pinnedAt"`
	// Samples is how many messages it was derived from, for the UI to say
	// how well founded it is.
	Samples         int `json:"samples"`
	schema.Expected     // Fields and Strict
}

// pinnedRegistry answers "how does this message differ from what was pinned
// for its subject" on the message path, so it stays lock-free for readers.
type pinnedRegistry struct {
	mu  sync.Mutex
	all []PinnedSchema
}

func (reg *pinnedRegistry) list() []PinnedSchema {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	out := make([]PinnedSchema, len(reg.all))
	copy(out, reg.all)
	return out
}

// forSubject returns the schema pinned for a subject: the most specific
// pattern wins, so `factory.line1.temp` beats `factory.>`.
func (reg *pinnedRegistry) forSubject(subj string) *PinnedSchema {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	var best *PinnedSchema
	bestScore := -1
	for i := range reg.all {
		p := &reg.all[i]
		if !subject.Match(p.Pattern, subj) {
			continue
		}
		if score := len(subject.LiteralPrefix(p.Pattern)); score > bestScore {
			best, bestScore = p, score
		}
	}
	return best
}

func (reg *pinnedRegistry) set(list []PinnedSchema) {
	sort.SliceStable(list, func(i, j int) bool { return list[i].Pattern < list[j].Pattern })
	reg.mu.Lock()
	reg.all = list
	reg.mu.Unlock()
}

// check is what the payload filter asks on `valid` and `violations`.
func (reg *pinnedRegistry) check(subj, kind string, payload []byte) ([]string, string) {
	p := reg.forSubject(subj)
	if p == nil {
		return nil, ""
	}
	return schema.Strings(p.Expected.Check(kind, payload)), p.Pattern
}

func init() {
	registerFeature(feature{
		name: "schemas",
		api: func(r chi.Router, d *deps) {
			reg := &pinnedRegistry{}
			if d.settings != nil {
				if entries, err := d.settings.All(); err == nil {
					if raw, ok := entries[pinnedKey]; ok {
						var list []PinnedSchema
						if err := json.Unmarshal(raw, &list); err != nil {
							log.Printf("schemas: saved schemas unreadable: %v", err)
						} else {
							reg.set(list)
						}
					}
				}
			}
			// Expressions everywhere judge against these from now on.
			d.onShutdown(filter.SetSchemaChecker(reg.check))

			save := func(list []PinnedSchema) {
				reg.set(list)
				if d.settings == nil {
					return
				}
				raw, err := json.Marshal(reg.list())
				if err != nil {
					return
				}
				if err := d.settings.Set(pinnedKey, raw); err != nil {
					log.Printf("schemas: cannot save: %v", err)
				}
			}

			r.Get("/schemas", func(w http.ResponseWriter, req *http.Request) {
				featureJSON(w, map[string]interface{}{"schemas": reg.list()})
			})

			// PUT pins one, replacing whatever was pinned for the same pattern.
			r.Put("/schemas", func(w http.ResponseWriter, req *http.Request) {
				var in PinnedSchema
				if err := decodeJSON(w, req, &in); err != nil {
					return
				}
				if in.Pattern == "" {
					featureError(w, http.StatusBadRequest, "pattern is required")
					return
				}
				if len(in.Fields) == 0 {
					featureError(w, http.StatusBadRequest, "a schema without fields would accept everything")
					return
				}
				in.PinnedAt = time.Now().UnixMilli()
				if in.ID == "" {
					in.ID = in.Pattern
				}
				list := reg.list()
				kept := list[:0]
				for _, p := range list {
					if p.Pattern != in.Pattern {
						kept = append(kept, p)
					}
				}
				if len(kept) >= maxPinned {
					featureError(w, http.StatusBadRequest, "too many pinned schemas")
					return
				}
				save(append(kept, in))
				featureJSON(w, in)
			})

			r.Delete("/schemas", func(w http.ResponseWriter, req *http.Request) {
				pattern := req.URL.Query().Get("pattern")
				list := reg.list()
				kept := list[:0]
				for _, p := range list {
					if p.Pattern != pattern {
						kept = append(kept, p)
					}
				}
				save(kept)
				featureJSON(w, map[string]bool{"success": true})
			})

			// Check one payload without publishing it: the publish drawer
			// asks before sending, so nobody breaks a subject by hand.
			r.Post("/schemas/check", func(w http.ResponseWriter, req *http.Request) {
				var in struct {
					Subject string `json:"subject"`
					Payload string `json:"payload"`
					Kind    string `json:"kind"`
				}
				if err := decodeJSON(w, req, &in); err != nil {
					return
				}
				p := reg.forSubject(in.Subject)
				if p == nil {
					featureJSON(w, map[string]interface{}{"pinned": false, "violations": []string{}})
					return
				}
				kind := in.Kind
				if kind == "" {
					kind = "json"
				}
				featureJSON(w, map[string]interface{}{
					"pinned":     true,
					"pattern":    p.Pattern,
					"violations": schema.Strings(p.Expected.Check(kind, []byte(in.Payload))),
				})
			})
		},
	})
}
