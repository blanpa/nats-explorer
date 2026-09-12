package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"nats-explorer/internal/alerts"
	"nats-explorer/internal/filter"
	"nats-explorer/internal/message"
)

// alertsEvent pushes the active alerts and the changes since the last push
// to every tab. The JSON tags are the wire format (shared/src/alerts.ts);
// MessagePack uses the same names.
type alertsEvent struct {
	Type   string         `json:"type"`
	Active []alerts.Alert `json:"active"`
	Events []alerts.Event `json:"events,omitempty"`
}

// alertsKey is where the rules live in the settings store.
const alertsKey = "ne.alerts.v1"

const (
	alertsTestLimit   = 200
	alertsTestMatches = 5
	alertsEventLimit  = 200
)

// Alert rules watch the message flow: a CEL expression that must not hold on
// a subject, or a subject that must not fall silent. The engine sits on the
// record hook, the browser learns about changes over the websocket.
func init() {
	registerFeature(feature{
		name: "alerts",
		api: func(r chi.Router, d *deps) {
			engine := alerts.New()
			engine.OnChange = func(active []alerts.Alert, events []alerts.Event) {
				d.hub.Broadcast(alertsEvent{Type: "alerts", Active: active, Events: events})
			}
			if d.settings != nil {
				loadAlertRules(d, engine)
			}
			d.onRecord(engine.Observe)
			engine.Start()
			d.onShutdown(engine.Stop)

			save := func(w http.ResponseWriter, rules []alerts.Rule) bool {
				if err := engine.SetRules(rules); err != nil {
					featureError(w, http.StatusBadRequest, err.Error())
					return false
				}
				saveAlertRules(d, rules)
				engine.Flush()
				return true
			}

			r.Get("/alerts", func(w http.ResponseWriter, req *http.Request) {
				featureJSON(w, map[string]interface{}{"active": engine.Active()})
			})
			r.Get("/alerts/rules", func(w http.ResponseWriter, req *http.Request) {
				featureJSON(w, map[string]interface{}{"rules": engine.Rules()})
			})
			r.Get("/alerts/events", func(w http.ResponseWriter, req *http.Request) {
				limit := alertsEventLimit
				if n, err := strconv.Atoi(req.URL.Query().Get("limit")); err == nil && n > 0 {
					limit = min(n, 1000)
				}
				featureJSON(w, map[string]interface{}{"events": engine.Events(limit)})
			})

			r.Put("/alerts/rules", func(w http.ResponseWriter, req *http.Request) {
				var body []alerts.Rule
				if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<20)).Decode(&body); err != nil {
					featureError(w, http.StatusBadRequest, "invalid JSON body")
					return
				}
				if !save(w, body) {
					return
				}
				featureJSON(w, map[string]interface{}{"rules": engine.Rules()})
			})

			r.Put("/alerts/rules/{id}", func(w http.ResponseWriter, req *http.Request) {
				id := chi.URLParam(req, "id")
				var rule alerts.Rule
				if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<20)).Decode(&rule); err != nil {
					featureError(w, http.StatusBadRequest, "invalid JSON body")
					return
				}
				rule.ID = id
				rules := engine.Rules()
				replaced := false
				for i := range rules {
					if rules[i].ID == id {
						rules[i] = rule
						replaced = true
						break
					}
				}
				if !replaced {
					rules = append(rules, rule)
				}
				if !save(w, rules) {
					return
				}
				featureJSON(w, rule)
			})

			r.Delete("/alerts/rules/{id}", func(w http.ResponseWriter, req *http.Request) {
				id := chi.URLParam(req, "id")
				rules := engine.Rules()
				out := rules[:0]
				for _, r := range rules {
					if r.ID != id {
						out = append(out, r)
					}
				}
				if len(out) == len(rules) {
					featureError(w, http.StatusNotFound, "no such rule")
					return
				}
				if !save(w, out) {
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})

			// Try a rule against what is already recorded, so an expression
			// can be checked before it is saved.
			r.Post("/alerts/rules/{id}/test", func(w http.ResponseWriter, req *http.Request) {
				var rule alerts.Rule
				if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<20)).Decode(&rule); err != nil {
					featureError(w, http.StatusBadRequest, "invalid JSON body")
					return
				}
				rule.ID = chi.URLParam(req, "id")
				if err := alerts.Validate(&rule); err != nil {
					featureError(w, http.StatusBadRequest, err.Error())
					return
				}
				var prog *filter.Program
				if rule.Expr != "" {
					p, err := filter.Compile(rule.Expr)
					if err != nil {
						featureError(w, http.StatusBadRequest, err.Error())
						return
					}
					prog = p
				}
				sampled, matches := testAlertRule(d, rule, prog)
				out := map[string]interface{}{"sampled": len(sampled), "matched": len(matches)}
				if len(matches) > alertsTestMatches {
					matches = matches[:alertsTestMatches]
				}
				out["matches"] = matches
				if len(sampled) == 0 {
					out["note"] = "nothing recorded yet for this pattern; the rule still applies to new messages"
				}
				featureJSON(w, out)
			})
		},
	})
}

// testAlertRule samples the recorded messages of a rule's pattern and returns
// them together with the ones the expression matches (newest first).
func testAlertRule(d *deps, rule alerts.Rule, prog *filter.Program) (sampled, matched []message.NatsMessage) {
	for _, prefix := range alertSamplePrefixes(d, rule.Pattern) {
		for _, st := range d.store.AllStatuses() {
			for _, m := range d.history.Search(st.ID, prefix, "", alertsTestLimit, 0) {
				if !alerts.MatchSubject(rule.Pattern, m.Subject) {
					continue
				}
				sampled = append(sampled, m)
				if prog == nil || prog.MatchMessage(&m) {
					matched = append(matched, m)
				}
			}
		}
	}
	return sampled, matched
}

// alertSamplePrefixes are the history branches a pattern can be sampled from.
// A pattern that starts with a wildcard has no literal prefix of its own, so
// the subscribed patterns of the open connections stand in for it.
func alertSamplePrefixes(d *deps, pattern string) []string {
	if p := alerts.LiteralPrefix(pattern); p != "" {
		return []string{p}
	}
	seen := map[string]bool{}
	var out []string
	for _, st := range d.store.AllStatuses() {
		for _, sub := range st.Subscriptions {
			p := alerts.LiteralPrefix(sub)
			if p == "" || seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

func loadAlertRules(d *deps, engine *alerts.Engine) {
	entries, err := d.settings.All()
	if err != nil {
		log.Printf("alerts: cannot read settings: %v", err)
		return
	}
	raw, ok := entries[alertsKey]
	if !ok {
		return
	}
	var rules []alerts.Rule
	if err := json.Unmarshal(raw, &rules); err != nil {
		log.Printf("alerts: saved rules unreadable: %v", err)
		return
	}
	if err := engine.SetRules(rules); err != nil {
		log.Printf("alerts: saved rules rejected: %v", err)
	}
}

func saveAlertRules(d *deps, rules []alerts.Rule) {
	if d.settings == nil {
		return
	}
	raw, err := json.Marshal(rules)
	if err != nil {
		return
	}
	if err := d.settings.Set(alertsKey, raw); err != nil {
		log.Printf("alerts: cannot save rules: %v", err)
	}
}
