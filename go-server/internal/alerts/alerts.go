// Package alerts watches the message flow for rules: a CEL expression that
// must not hold on a subject, or a subject that must not fall silent. It
// sits on the manager's record hook, so it sees every message of every
// connection on the shard workers and has to stay cheap there.
package alerts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"nats-explorer/internal/filter"
	"nats-explorer/internal/message"
	"nats-explorer/internal/subject"
)

// Rule is one alert definition.
type Rule struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
	// Expr is a CEL expression (see internal/filter); when it holds for a
	// message the alert fires for that subject, when it stops holding the
	// alert resolves. Empty means the rule only watches for silence.
	Expr string `json:"expr,omitempty"`
	// StaleAfter marks a subject as stale after this many seconds without
	// a message; 0 disables the check.
	StaleAfter int    `json:"staleAfter,omitempty"`
	Severity   string `json:"severity"`
	Webhook    string `json:"webhook,omitempty"`
	Enabled    bool   `json:"enabled"`
}

// States of an alert.
const (
	StateFiring   = "firing"
	StateStale    = "stale"
	StateResolved = "resolved"
)

// Alert is one active condition: a rule on a subject of a connection.
type Alert struct {
	Key      string `json:"key"`
	RuleID   string `json:"ruleId"`
	RuleName string `json:"ruleName"`
	ConnID   string `json:"connId"`
	Subject  string `json:"subject"`
	State    string `json:"state"`
	Severity string `json:"severity"`
	Since    int64  `json:"since"`
	// Preview is the payload that fired the rule, or the last one seen for a stale subject.
	Preview string `json:"preview,omitempty"`
	// At is the time of the message that fired the rule, or the last message before the silence.
	At int64 `json:"at,omitempty"`
}

// Event is one state change, kept in a ring for the log.
type Event struct {
	Time         int64  `json:"time"`
	RuleID       string `json:"ruleId"`
	RuleName     string `json:"ruleName"`
	ConnID       string `json:"connId"`
	Subject      string `json:"subject"`
	State        string `json:"state"`
	Severity     string `json:"severity"`
	Preview      string `json:"preview,omitempty"`
	WebhookError string `json:"webhookError,omitempty"`
}

const (
	maxEvents = 1000
	// evalEvery bounds expression evaluations per rule and subject.
	evalEvery = int64(1000)
	// broadcastEvery bounds websocket pushes.
	broadcastEvery = 250 * time.Millisecond
	previewMax     = 200
)

type compiled struct {
	Rule
	prog *filter.Program
}

// subjectState is what the engine remembers per rule and subject.
type subjectState struct {
	mu       sync.Mutex
	ruleID   string
	connID   string
	subject  string
	lastSeen int64
	lastEval int64
	preview  string
	firing   bool
	stale    bool
}

// Engine evaluates rules and keeps the active alerts and the event log.
type Engine struct {
	rules atomic.Pointer[[]*compiled]
	byID  atomic.Pointer[map[string]*compiled]

	states sync.Map // key → *subjectState

	mu     sync.Mutex
	active map[string]*Alert
	events []Event
	head   int
	count  int
	// pending events since the last broadcast
	pending []Event
	dirty   chan struct{}
	stop    chan struct{}
	wg      sync.WaitGroup

	// OnChange receives the active alerts and the new events, at most a
	// few times per second. Called from the engine's own goroutine.
	OnChange func(active []Alert, events []Event)
	// Now and Post exist for tests.
	Now  func() int64
	Post func(url string, body []byte) error
}

// New returns a stopped engine; call Start.
func New() *Engine {
	e := &Engine{active: map[string]*Alert{}, events: make([]Event, maxEvents), dirty: make(chan struct{}, 1), stop: make(chan struct{})}
	empty := []*compiled{}
	e.rules.Store(&empty)
	byID := map[string]*compiled{}
	e.byID.Store(&byID)
	e.Now = func() int64 { return time.Now().UnixMilli() }
	e.Post = postJSON
	return e
}

// Start runs the stale checker and the broadcaster.
func (e *Engine) Start() {
	e.wg.Add(2)
	go e.staleLoop()
	go e.broadcastLoop()
}

// Stop ends the goroutines.
func (e *Engine) Stop() {
	close(e.stop)
	e.wg.Wait()
}

// Validate checks a rule and fills defaults.
func Validate(r *Rule) error {
	r.Name = strings.TrimSpace(r.Name)
	r.Pattern = strings.TrimSpace(r.Pattern)
	r.Expr = strings.TrimSpace(r.Expr)
	r.Webhook = strings.TrimSpace(r.Webhook)
	if r.Name == "" {
		return errors.New("a rule needs a name")
	}
	if r.Pattern == "" || strings.ContainsAny(r.Pattern, " \t\n") {
		return errors.New("a rule needs a subject pattern without whitespace")
	}
	if r.Expr == "" && r.StaleAfter <= 0 {
		return errors.New("a rule needs an expression, a stale timeout, or both")
	}
	if r.Expr != "" {
		if _, err := filter.Compile(r.Expr); err != nil {
			return fmt.Errorf("expression: %v", err)
		}
	}
	if r.StaleAfter < 0 {
		return errors.New("the stale timeout cannot be negative")
	}
	switch r.Severity {
	case "info", "warning", "critical":
	case "":
		r.Severity = "warning"
	default:
		return fmt.Errorf("severity %q is not info, warning or critical", r.Severity)
	}
	if r.Webhook != "" && !strings.HasPrefix(r.Webhook, "http://") && !strings.HasPrefix(r.Webhook, "https://") {
		return errors.New("the webhook must be an http(s) URL")
	}
	return nil
}

// Rules returns the current rules.
func (e *Engine) Rules() []Rule {
	cs := *e.rules.Load()
	out := make([]Rule, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Rule)
	}
	return out
}

// SetRules replaces the rules. Alerts of rules that vanished are dropped.
func (e *Engine) SetRules(rules []Rule) error {
	cs := make([]*compiled, 0, len(rules))
	byID := make(map[string]*compiled, len(rules))
	for i := range rules {
		r := rules[i]
		if err := Validate(&r); err != nil {
			return fmt.Errorf("rule %q: %w", r.Name, err)
		}
		if r.ID == "" {
			return fmt.Errorf("rule %q: missing id", r.Name)
		}
		if _, dup := byID[r.ID]; dup {
			return fmt.Errorf("rule id %q listed twice", r.ID)
		}
		c := &compiled{Rule: r}
		if r.Expr != "" {
			c.prog, _ = filter.Compile(r.Expr)
		}
		cs = append(cs, c)
		byID[r.ID] = c
	}
	old := *e.byID.Load()
	e.rules.Store(&cs)
	e.byID.Store(&byID)

	// Forget the state of rules that are gone or changed in what they watch.
	e.states.Range(func(k, v any) bool {
		st := v.(*subjectState)
		n, ok := byID[st.ruleID]
		if !ok || !n.Enabled || n.Pattern != old[st.ruleID].patternOr("") || n.Expr != old[st.ruleID].exprOr("") || n.StaleAfter != old[st.ruleID].staleOr(0) {
			e.states.Delete(k)
			e.mu.Lock()
			delete(e.active, k.(string))
			e.mu.Unlock()
		}
		return true
	})
	e.signal()
	return nil
}

func (c *compiled) patternOr(def string) string {
	if c == nil {
		return def
	}
	return c.Pattern
}

func (c *compiled) exprOr(def string) string {
	if c == nil {
		return def
	}
	return c.Expr
}

func (c *compiled) staleOr(def int) int {
	if c == nil {
		return def
	}
	return c.StaleAfter
}

func key(ruleID, connID, subject string) string {
	return ruleID + "\x00" + connID + "\x00" + subject
}

func preview(r *message.Record) string {
	if r.Kind() == "binary" {
		return fmt.Sprintf("binary, %d bytes", len(r.Data))
	}
	s := string(r.Data)
	if len(s) > previewMax {
		s = s[:previewMax] + "…"
	}
	return s
}

// Observe is the hot path: called for every received message.
func (e *Engine) Observe(connID string, r *message.Record) {
	rules := *e.rules.Load()
	if len(rules) == 0 {
		return
	}
	now := e.Now()
	var vars *filter.Vars
	for _, c := range rules {
		if !c.Enabled || !MatchSubject(c.Pattern, r.Subject) {
			continue
		}
		k := key(c.ID, connID, r.Subject)
		v, ok := e.states.Load(k)
		if !ok {
			v, _ = e.states.LoadOrStore(k, &subjectState{ruleID: c.ID, connID: connID, subject: r.Subject})
		}
		st := v.(*subjectState)
		st.mu.Lock()
		st.lastSeen = now
		if st.stale {
			st.stale = false
			e.change(c, st, StateResolved, preview(r), now)
		}
		if c.prog != nil && now-st.lastEval >= evalEvery {
			st.lastEval = now
			if vars == nil {
				vv := filter.VarsOf(r)
				vars = &vv
			}
			hit, _ := c.prog.Eval(*vars)
			switch {
			case hit && !st.firing:
				st.firing = true
				st.preview = preview(r)
				e.change(c, st, StateFiring, st.preview, now)
			case !hit && st.firing:
				st.firing = false
				e.change(c, st, StateResolved, preview(r), now)
			}
		} else if c.StaleAfter > 0 && st.preview == "" {
			st.preview = preview(r)
		}
		st.mu.Unlock()
	}
}

// change records a state transition; st.mu is held by the caller.
func (e *Engine) change(c *compiled, st *subjectState, state, pv string, now int64) {
	k := key(c.ID, st.connID, st.subject)
	ev := Event{Time: now, RuleID: c.ID, RuleName: c.Name, ConnID: st.connID, Subject: st.subject, State: state, Severity: c.Severity, Preview: pv}
	e.mu.Lock()
	if state == StateResolved {
		delete(e.active, k)
	} else {
		e.active[k] = &Alert{Key: k, RuleID: c.ID, RuleName: c.Name, ConnID: st.connID, Subject: st.subject, State: state, Severity: c.Severity, Since: now, Preview: pv, At: st.lastSeen}
	}
	e.mu.Unlock()
	if c.Webhook != "" {
		go e.webhook(c.Webhook, ev)
	} else {
		e.record(ev)
	}
}

// record appends an event to the ring and the pending list.
func (e *Engine) record(ev Event) {
	e.mu.Lock()
	e.events[e.head] = ev
	e.head = (e.head + 1) % maxEvents
	if e.count < maxEvents {
		e.count++
	}
	e.pending = append(e.pending, ev)
	e.mu.Unlock()
	e.signal()
}

func (e *Engine) signal() {
	select {
	case e.dirty <- struct{}{}:
	default:
	}
}

func (e *Engine) webhook(url string, ev Event) {
	body, _ := json.Marshal(map[string]any{
		"rule": ev.RuleName, "ruleId": ev.RuleID, "connId": ev.ConnID, "subject": ev.Subject,
		"state": ev.State, "severity": ev.Severity, "preview": ev.Preview, "time": ev.Time,
	})
	if err := e.Post(url, body); err != nil {
		log.Printf("alert webhook %s: %v", url, err)
		ev.WebhookError = err.Error()
	}
	e.record(ev)
}

func postJSON(url string, body []byte) error {
	client := &http.Client{Timeout: 5 * time.Second}
	res, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	return nil
}

// staleLoop marks silent subjects once a second.
func (e *Engine) staleLoop() {
	defer e.wg.Done()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-e.stop:
			return
		case <-t.C:
			e.CheckStale()
		}
	}
}

// CheckStale runs one pass of the silence check.
func (e *Engine) CheckStale() {
	now := e.Now()
	byID := *e.byID.Load()
	e.states.Range(func(_, v any) bool {
		st := v.(*subjectState)
		c := byID[st.ruleID]
		if c == nil || !c.Enabled || c.StaleAfter <= 0 {
			return true
		}
		st.mu.Lock()
		if !st.stale && st.lastSeen > 0 && now-st.lastSeen > int64(c.StaleAfter)*1000 {
			st.stale = true
			e.change(c, st, StateStale, st.preview, now)
		}
		st.mu.Unlock()
		return true
	})
}

// broadcastLoop pushes changes to OnChange, coalesced.
func (e *Engine) broadcastLoop() {
	defer e.wg.Done()
	for {
		select {
		case <-e.stop:
			return
		case <-e.dirty:
		}
		e.Flush()
		select {
		case <-e.stop:
			return
		case <-time.After(broadcastEvery):
		}
	}
}

// Flush delivers pending changes to OnChange now.
func (e *Engine) Flush() {
	e.mu.Lock()
	pending := e.pending
	e.pending = nil
	active := e.activeLocked()
	e.mu.Unlock()
	if e.OnChange != nil {
		e.OnChange(active, pending)
	}
}

func (e *Engine) activeLocked() []Alert {
	out := make([]Alert, 0, len(e.active))
	for _, a := range e.active {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Since != out[j].Since {
			return out[i].Since > out[j].Since
		}
		return out[i].Key < out[j].Key
	})
	return out
}

// Active returns the active alerts, newest first.
func (e *Engine) Active() []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.activeLocked()
}

// Events returns the newest events first, at most limit.
func (e *Engine) Events(limit int) []Event {
	e.mu.Lock()
	defer e.mu.Unlock()
	if limit <= 0 || limit > e.count {
		limit = e.count
	}
	out := make([]Event, 0, limit)
	for i := 1; i <= limit; i++ {
		out = append(out, e.events[(e.head-i+maxEvents)%maxEvents])
	}
	return out
}

// Forget drops the state of one connection, e.g. when it is closed.
func (e *Engine) Forget(connID string) {
	e.states.Range(func(k, v any) bool {
		if v.(*subjectState).connID == connID {
			e.states.Delete(k)
			e.mu.Lock()
			delete(e.active, k.(string))
			e.mu.Unlock()
		}
		return true
	})
	e.signal()
}

// MatchSubject reports whether a subject matches a NATS pattern.
func MatchSubject(pattern, subj string) bool { return subject.Match(pattern, subj) }

// LiteralPrefix returns the leading literal tokens of a pattern, the branch a
// history lookup can start from; empty when the pattern starts with a wildcard.
func LiteralPrefix(pattern string) string { return subject.LiteralPrefix(pattern) }
