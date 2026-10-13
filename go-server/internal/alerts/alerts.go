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
	// a message; 0 disables the check. With StaleAuto it is a floor rather
	// than the threshold.
	StaleAfter int `json:"staleAfter,omitempty"`
	// StaleAuto learns each subject's own rhythm instead of being told one.
	// A plant has two thousand subjects sending at a dozen different rates,
	// and nobody maintains a timeout per subject; the gaps between the
	// messages already say what normal is.
	StaleAuto bool   `json:"staleAuto,omitempty"`
	Severity  string `json:"severity"`
	Webhook   string `json:"webhook,omitempty"`
	// WebhookFormat is the shape of the POST: json (the default), slack or
	// teams, so the two chat tools need no adapter in front of them.
	WebhookFormat string `json:"webhookFormat,omitempty"`
	// Email lists recipients, comma separated; it needs SMTP_* on the server.
	Email   string `json:"email,omitempty"`
	Enabled bool   `json:"enabled"`

	// Conditions over a window of Window seconds. A single message cannot
	// say that too few arrived in the last minute or that the average of
	// the last five is past a threshold; these can.
	Window int `json:"window,omitempty"`
	// MinCount fires when fewer messages than this arrived in the window,
	// MaxCount when more did.
	MinCount *int `json:"minCount,omitempty"`
	MaxCount *int `json:"maxCount,omitempty"`
	// Field is a dotted path into the payload; Agg (avg, min or max) of it
	// over the window is compared with Above and Below.
	Field string   `json:"field,omitempty"`
	Agg   string   `json:"agg,omitempty"`
	Above *float64 `json:"above,omitempty"`
	Below *float64 `json:"below,omitempty"`
	// UnchangedFor fires when the field, or the whole payload without one,
	// has been reported again without changing for this many seconds: a
	// sensor that is stuck looks exactly like one that is fine.
	UnchangedFor int `json:"unchangedFor,omitempty"`

	// MutedUntil, a unix time in milliseconds, keeps the rule's changes in
	// the log but out of the webhook, the mail and the toasts until then.
	MutedUntil int64 `json:"mutedUntil,omitempty"`
}

// Maintenance is a planned window in which alerts are not sent: a rebuild,
// a firmware update, a line that is down on purpose. The ones still true
// when it ends are sent then.
type Maintenance struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	From int64  `json:"from"`
	To   int64  `json:"to"`
	// Patterns narrows it to subjects matching one of them; empty means all.
	Patterns []string `json:"patterns,omitempty"`
}

// covers says whether the window is on now and includes the subject.
func (m *Maintenance) covers(subject string, now int64) bool {
	if now < m.From || now >= m.To {
		return false
	}
	if len(m.Patterns) == 0 {
		return true
	}
	for _, p := range m.Patterns {
		if MatchSubject(p, subject) {
			return true
		}
	}
	return false
}

// States of an alert.
const (
	StateFiring   = "firing"
	StateStale    = "stale"
	StateResolved = "resolved"
	// StateRate: too few or too many messages in the window.
	StateRate = "rate"
	// StateLevel: the aggregate of a field over the window is out of range.
	StateLevel = "level"
	// StateStuck: a value reported again and again without changing.
	StateStuck = "stuck"
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
	// Muted: the rule or a maintenance window keeps it out of the channels.
	Muted bool `json:"muted,omitempty"`
	// Acked: someone has seen it; it stays until it resolves but no longer counts as new.
	AckedAt int64  `json:"ackedAt,omitempty"`
	AckedBy string `json:"ackedBy,omitempty"`
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
	// Muted: logged, but not sent.
	Muted bool `json:"muted,omitempty"`
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
	// gaps between the last messages, in milliseconds, for the learned
	// silence threshold. A ring, because a subject runs for months.
	gaps  [staleWindow]int64
	gapsN int

	// the window conditions and the stuck check
	firstSeen int64
	seen      int64
	win       *window
	rate      bool
	level     bool
	stuck     bool
	// what each condition said last, for the active alert
	ratePreview, levelPreview, stuckPreview string
	lastValue                               string
	lastChange                              int64
}

// current is the state the active alert shows: the one that matters most
// of the conditions that hold, or empty when none does.
func (st *subjectState) current() (string, string) {
	switch {
	case st.firing:
		return StateFiring, st.preview
	case st.level:
		return StateLevel, st.levelPreview
	case st.rate:
		return StateRate, st.ratePreview
	case st.stuck:
		return StateStuck, st.stuckPreview
	case st.stale:
		return StateStale, st.preview
	}
	return "", ""
}

// How many gaps the learned threshold is built from, and how many are
// needed before it will fire at all: a subject that has sent twice has not
// shown a rhythm, and firing on it would be guesswork.
const (
	staleWindow  = 16
	staleMinGaps = 8
	// staleFactor is how many typical gaps of silence count as stale. Ten
	// is late enough that jitter, a retry or a slow batch never fires it,
	// and early enough to matter: a sensor sending every five seconds is
	// reported after a minute.
	staleFactor = 10
)

// typicalGap is the pause a subject normally has between messages, in
// milliseconds. The upper quartile rather than the average: a subject that
// sends a burst every minute has many tiny gaps and a few big ones, and the
// average of those is a number that happens to no one.
func (st *subjectState) typicalGap() int64 {
	n := st.gapsN
	if n > staleWindow {
		n = staleWindow
	}
	if n < staleMinGaps {
		return 0
	}
	sorted := make([]int64, n)
	copy(sorted, st.gaps[:n])
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return sorted[(n*3)/4]
}

func (st *subjectState) noteGap(now int64) {
	if st.lastSeen > 0 && now > st.lastSeen {
		st.gaps[st.gapsN%staleWindow] = now - st.lastSeen
		st.gapsN++
	}
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
	// Mail sends an email; nil means the server has no SMTP configuration,
	// and a rule with recipients logs that instead of sending.
	Mail func(to []string, subject, body string) error

	maintenance atomic.Pointer[[]Maintenance]
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
	none := []Maintenance{}
	e.maintenance.Store(&none)
	return e
}

// SetMaintenance replaces the maintenance windows.
func (e *Engine) SetMaintenance(list []Maintenance) error {
	out := make([]Maintenance, 0, len(list))
	for _, m := range list {
		m.Name = strings.TrimSpace(m.Name)
		if m.ID == "" {
			return errors.New("a maintenance window needs an id")
		}
		if m.To <= m.From {
			return fmt.Errorf("maintenance window %q ends before it starts", m.Name)
		}
		for i, p := range m.Patterns {
			p = strings.TrimSpace(p)
			if p == "" || strings.ContainsAny(p, " \t\n") {
				return fmt.Errorf("maintenance window %q: pattern %q is not a subject pattern", m.Name, p)
			}
			m.Patterns[i] = p
		}
		out = append(out, m)
	}
	e.maintenance.Store(&out)
	e.refreshMuted(e.Now())
	return nil
}

// Maintenance returns the windows, the past ones included until they are removed.
func (e *Engine) Maintenance() []Maintenance {
	return append([]Maintenance(nil), *e.maintenance.Load()...)
}

// muted says whether a change of this rule on this subject is kept out of
// the channels right now.
func (e *Engine) muted(c *compiled, subject string, now int64) bool {
	if c.MutedUntil > now {
		return true
	}
	for i := range *e.maintenance.Load() {
		if (*e.maintenance.Load())[i].covers(subject, now) {
			return true
		}
	}
	return false
}

// Ack marks an active alert as seen, or takes that back. It stays active
// until it resolves; it only stops counting as new.
func (e *Engine) Ack(key, by string, acked bool) bool {
	e.mu.Lock()
	a, ok := e.active[key]
	if ok {
		if acked {
			a.AckedAt = e.Now()
			a.AckedBy = by
		} else {
			a.AckedAt = 0
			a.AckedBy = ""
		}
	}
	e.mu.Unlock()
	if ok {
		e.signal()
	}
	return ok
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
	if !r.hasCondition() {
		return errors.New("a rule needs a condition: an expression, a silence, a count or a threshold over a window, or an unchanged value")
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
	switch r.WebhookFormat {
	case "", FormatJSON, FormatSlack, FormatTeams:
	default:
		return fmt.Errorf("webhook format %q is not json, slack or teams", r.WebhookFormat)
	}
	r.Email = strings.TrimSpace(r.Email)
	for _, a := range recipients(r.Email) {
		if !strings.Contains(a, "@") {
			return fmt.Errorf("%q is not an email address", a)
		}
	}
	r.Field = strings.TrimSpace(r.Field)
	r.Agg = strings.TrimSpace(r.Agg)
	if r.Window < 0 || r.Window > MaxWindow {
		return fmt.Errorf("the window must be between 1 s and %d h", MaxWindow/3600)
	}
	if r.UnchangedFor < 0 {
		return errors.New("the unchanged time cannot be negative")
	}
	if (r.MinCount != nil || r.MaxCount != nil || r.Above != nil || r.Below != nil) && r.Window <= 0 {
		return errors.New("a count or a threshold over time needs a window")
	}
	if r.MinCount != nil && *r.MinCount < 0 || r.MaxCount != nil && *r.MaxCount < 0 {
		return errors.New("a message count cannot be negative")
	}
	if r.Above != nil || r.Below != nil {
		if r.Field == "" {
			return errors.New("a threshold over time needs a field")
		}
		switch r.Agg {
		case "avg", "min", "max":
		case "":
			r.Agg = "avg"
		default:
			return fmt.Errorf("aggregate %q is not avg, min or max", r.Agg)
		}
	}
	return nil
}

// hasCondition says whether the rule watches for anything at all.
func (r *Rule) hasCondition() bool {
	return r.Expr != "" || r.StaleAfter > 0 || r.StaleAuto || r.hasWindow() || r.UnchangedFor > 0
}

// watch is everything that decides when the rule fires: a rule whose watch
// changed starts over, one that only changed its name or channel keeps its
// state.
func (r *Rule) watch() string {
	b, _ := json.Marshal(struct {
		P, E, F, A string
		S          int
		SA         bool
		W, U       int
		Mn, Mx     *int
		Ab, Bl     *float64
	}{r.Pattern, r.Expr, r.Field, r.Agg, r.StaleAfter, r.StaleAuto, r.Window, r.UnchangedFor, r.MinCount, r.MaxCount, r.Above, r.Below})
	return string(b)
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
		if !ok || !n.Enabled || old[st.ruleID] == nil || n.watch() != old[st.ruleID].watch() {
			e.states.Delete(k)
			e.mu.Lock()
			delete(e.active, k.(string))
			e.mu.Unlock()
		}
		return true
	})
	// A rule that was muted or unmuted changes what its alerts count as.
	e.refreshMuted(e.Now())
	e.signal()
	return nil
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
		st.noteGap(now)
		st.lastSeen = now
		st.seen++
		if st.firstSeen == 0 {
			st.firstSeen = now
		}
		if st.stale {
			st.stale = false
			e.cleared(c, st, preview(r), now)
		}
		// The field the window and the stuck check read, parsed once per
		// message and only for the rules that ask for it.
		var fieldVal any
		var hasField bool
		if c.needsField() {
			if vars == nil {
				vv := filter.VarsOf(r)
				vars = &vv
			}
			fieldVal, hasField = fieldAt(vars.Payload, c.Field)
		}
		if c.hasWindow() {
			if st.win == nil {
				st.win = newWindow(c.Window)
			}
			n, isNum := numberOf(fieldVal)
			st.win.add(now, n, hasField && isNum)
		}
		if c.UnchangedFor > 0 {
			var val string
			if c.Field != "" {
				if hasField {
					val = valueText(fieldVal)
				} else {
					val = "\x00missing"
				}
			} else {
				val = string(r.Data)
			}
			if st.lastChange == 0 || val != st.lastValue {
				st.lastValue = val
				st.lastChange = now
				if st.stuck {
					st.stuck = false
					e.cleared(c, st, preview(r), now)
				}
			}
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
				e.cleared(c, st, preview(r), now)
			}
		} else if st.preview == "" {
			st.preview = preview(r)
		}
		st.mu.Unlock()
	}
}

// cleared is what happens when one condition stops holding: resolved when
// it was the last, otherwise the active alert shows the one that is left.
// st.mu is held by the caller.
func (e *Engine) cleared(c *compiled, st *subjectState, pv string, now int64) {
	state, left := st.current()
	if state == "" {
		e.change(c, st, StateResolved, pv, now)
		return
	}
	k := key(c.ID, st.connID, st.subject)
	e.mu.Lock()
	if a, ok := e.active[k]; ok {
		a.State = state
		a.Preview = left
	}
	e.mu.Unlock()
	e.signal()
}

// change records a state transition; st.mu is held by the caller.
func (e *Engine) change(c *compiled, st *subjectState, state, pv string, now int64) {
	k := key(c.ID, st.connID, st.subject)
	muted := e.muted(c, st.subject, now)
	ev := Event{Time: now, RuleID: c.ID, RuleName: c.Name, ConnID: st.connID, Subject: st.subject, State: state, Severity: c.Severity, Preview: pv, Muted: muted}
	e.mu.Lock()
	if state == StateResolved {
		delete(e.active, k)
	} else {
		e.active[k] = &Alert{Key: k, RuleID: c.ID, RuleName: c.Name, ConnID: st.connID, Subject: st.subject, State: state, Severity: c.Severity, Since: now, Preview: pv, At: st.lastSeen, Muted: muted}
	}
	e.mu.Unlock()
	e.notify(c, ev)
}

// notify sends an event where the rule says, or only logs it while muted.
// Sending happens off the hot path; the event is logged once it is sent,
// with what went wrong if anything did.
func (e *Engine) notify(c *compiled, ev Event) {
	if ev.Muted || (c.Webhook == "" && c.Email == "") {
		e.record(ev)
		return
	}
	go func() {
		var errs []string
		if c.Webhook != "" {
			if err := e.Post(c.Webhook, webhookBody(c.WebhookFormat, ev)); err != nil {
				log.Printf("alert webhook %s: %v", c.Webhook, err)
				errs = append(errs, "webhook: "+err.Error())
			}
		}
		if c.Email != "" {
			if e.Mail == nil {
				errs = append(errs, "email: "+ErrNoMail.Error())
			} else if err := e.Mail(recipients(c.Email), mailSubject(ev), mailBody(ev)); err != nil {
				log.Printf("alert email %s: %v", c.Email, err)
				errs = append(errs, "email: "+err.Error())
			}
		}
		ev.WebhookError = strings.Join(errs, "; ")
		e.record(ev)
	}()
}

// refreshMuted re-reads whether each active alert is muted. One that just
// came out of a mute or a maintenance window and is still true is sent
// now: the window was there to hold the alert back, not to lose it.
func (e *Engine) refreshMuted(now int64) {
	byID := *e.byID.Load()
	var send []Event
	var rules []*compiled
	e.mu.Lock()
	for _, a := range e.active {
		c := byID[a.RuleID]
		if c == nil {
			continue
		}
		muted := e.muted(c, a.Subject, now)
		if a.Muted && !muted {
			send = append(send, Event{Time: now, RuleID: c.ID, RuleName: c.Name, ConnID: a.ConnID, Subject: a.Subject, State: a.State, Severity: c.Severity, Preview: a.Preview})
			rules = append(rules, c)
		}
		a.Muted = muted
	}
	e.mu.Unlock()
	for i, ev := range send {
		e.notify(rules[i], ev)
	}
	if len(send) > 0 {
		e.signal()
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

// staleLoop runs the conditions that time decides once a second.
func (e *Engine) staleLoop() {
	defer e.wg.Done()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-e.stop:
			return
		case <-t.C:
			e.Tick()
		}
	}
}

// CheckStale runs one pass of the checks that time decides; the name is
// from when silence was the only one.
func (e *Engine) CheckStale() { e.Tick() }

// Tick runs one pass of everything a message cannot trigger: a silence, a
// window with too few messages, an average that drifted, a value that has
// not moved, and a mute that ran out.
func (e *Engine) Tick() {
	now := e.Now()
	byID := *e.byID.Load()
	e.states.Range(func(_, v any) bool {
		st := v.(*subjectState)
		c := byID[st.ruleID]
		if c == nil || !c.Enabled {
			return true
		}
		st.mu.Lock()
		e.checkStale(c, st, now)
		e.checkWindow(c, st, now)
		e.checkStuck(c, st, now)
		st.mu.Unlock()
		return true
	})
	e.refreshMuted(now)
}

// checkStale marks a silent subject; st.mu is held.
func (e *Engine) checkStale(c *compiled, st *subjectState, now int64) {
	if c.StaleAfter <= 0 && !c.StaleAuto {
		return
	}
	after := int64(c.StaleAfter) * 1000
	if c.StaleAuto {
		learned := st.typicalGap() * staleFactor
		// Until the subject has shown a rhythm there is nothing to be
		// late against, and a floor the reader set still applies.
		if learned == 0 {
			return
		}
		if learned > after {
			after = learned
		}
	}
	if !st.stale && st.lastSeen > 0 && now-st.lastSeen > after {
		st.stale = true
		e.change(c, st, StateStale, st.preview, now)
	}
}

// checkWindow evaluates the count and the aggregate over the window. A
// count that is too low is only judged once the subject has been watched
// for a whole window: a subject seen ten seconds ago has not had a minute
// to send its ten messages in. st.mu is held.
func (e *Engine) checkWindow(c *compiled, st *subjectState, now int64) {
	if !c.hasWindow() || st.win == nil {
		return
	}
	windowMs := int64(c.Window) * 1000
	count, n, sum, min, max := st.win.totals(now, windowMs)
	if c.MinCount != nil || c.MaxCount != nil {
		hit, pv := c.rateVerdict(count)
		if hit && c.MinCount != nil && count < int64(*c.MinCount) && now-st.firstSeen < windowMs {
			hit = false
		}
		switch {
		case hit && !st.rate:
			st.rate = true
			st.ratePreview = pv
			e.change(c, st, StateRate, pv, now)
		case hit && st.rate && pv != st.ratePreview:
			st.ratePreview = pv
			e.update(c, st, StateRate, pv)
		case !hit && st.rate:
			st.rate = false
			e.cleared(c, st, pv, now)
		}
	}
	if c.hasAggregate() {
		hit, pv := c.levelVerdict(n, sum, min, max)
		switch {
		case hit && !st.level:
			st.level = true
			st.levelPreview = pv
			e.change(c, st, StateLevel, pv, now)
		case hit && st.level && pv != st.levelPreview:
			st.levelPreview = pv
			e.update(c, st, StateLevel, pv)
		case !hit && st.level:
			st.level = false
			e.cleared(c, st, pv, now)
		}
	}
}

// checkStuck reports a value that was reported again without changing for
// longer than the rule allows. One message is a value, not a stuck one.
func (e *Engine) checkStuck(c *compiled, st *subjectState, now int64) {
	if c.UnchangedFor <= 0 || st.stuck || st.seen < 2 || st.lastChange == 0 {
		return
	}
	if now-st.lastChange > int64(c.UnchangedFor)*1000 {
		st.stuck = true
		what := "payload"
		if c.Field != "" {
			what = c.Field + " = " + st.lastValue
		}
		st.stuckPreview = fmt.Sprintf("%s unchanged for %s", what, formatSeconds(int((now-st.lastChange)/1000)))
		e.change(c, st, StateStuck, st.stuckPreview, now)
	}
}

// update rewrites the preview of an active alert whose condition still
// holds but reads differently now -- 3 messages became 2 -- without an
// event: the state did not change. The alert must show the state, or the
// preview belongs to a condition the reader is not looking at.
func (e *Engine) update(c *compiled, st *subjectState, state, pv string) {
	k := key(c.ID, st.connID, st.subject)
	e.mu.Lock()
	if a, ok := e.active[k]; ok && a.State == state {
		a.Preview = pv
	}
	e.mu.Unlock()
	e.signal()
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
