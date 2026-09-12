package alerts

import (
	"strings"
	"sync"
	"testing"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/message"
)

func rec(subject, payload string) *message.Record {
	return message.NewRecord(&nats.Msg{Subject: subject, Data: []byte(payload)}, 1, 0)
}

// harness runs an engine on a fake clock with a captured webhook.
type harness struct {
	e     *Engine
	now   int64
	mu    sync.Mutex
	posts []string
}

func newHarness(t *testing.T, rules ...Rule) *harness {
	t.Helper()
	h := &harness{e: New(), now: 1_000_000}
	h.e.Now = func() int64 { return h.now }
	h.e.Post = func(url string, body []byte) error {
		h.mu.Lock()
		h.posts = append(h.posts, url+" "+string(body))
		h.mu.Unlock()
		return nil
	}
	if err := h.e.SetRules(rules); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *harness) states() []string {
	var out []string
	for _, a := range h.e.Active() {
		out = append(out, a.Subject+":"+a.State)
	}
	return out
}

func TestValidate(t *testing.T) {
	ok := Rule{Name: "hot", Pattern: "plant.>", Expr: "payload.temp > 80"}
	if err := Validate(&ok); err != nil || ok.Severity != "warning" {
		t.Fatalf("valid rule: %v %+v", err, ok)
	}
	for _, bad := range []Rule{
		{Pattern: "a", Expr: "true"},
		{Name: "x", Pattern: "", Expr: "true"},
		{Name: "x", Pattern: "a b", Expr: "true"},
		{Name: "x", Pattern: "a"},
		{Name: "x", Pattern: "a", Expr: "payload.temp >"},
		{Name: "x", Pattern: "a", Expr: "true", Severity: "loud"},
		{Name: "x", Pattern: "a", StaleAfter: -1},
		{Name: "x", Pattern: "a", Expr: "true", Webhook: "ftp://x"},
	} {
		if err := Validate(&bad); err == nil {
			t.Errorf("%+v validated", bad)
		}
	}
}

func TestFireAndResolve(t *testing.T) {
	h := newHarness(t, Rule{ID: "r1", Name: "hot", Pattern: "plant.*.temp", Expr: "payload.temp > 80", Severity: "critical", Enabled: true})
	h.e.Observe("c", rec("plant.a.temp", `{"temp": 70}`))
	if len(h.e.Active()) != 0 {
		t.Fatal("nothing should fire at 70")
	}
	h.now += 1000
	h.e.Observe("c", rec("plant.a.temp", `{"temp": 90}`))
	h.e.Observe("c", rec("plant.a.humidity", `{"temp": 999}`)) // not matched by the pattern
	h.e.Observe("c", rec("other", `{"temp": 999}`))
	act := h.e.Active()
	if len(act) != 1 || act[0].Subject != "plant.a.temp" || act[0].State != StateFiring || act[0].Severity != "critical" || !strings.Contains(act[0].Preview, "90") {
		t.Fatalf("active = %+v", act)
	}
	// Throttled: within the same second a resolving value is not evaluated.
	h.e.Observe("c", rec("plant.a.temp", `{"temp": 10}`))
	if len(h.e.Active()) != 1 {
		t.Fatal("evaluation must be throttled to once per second")
	}
	h.now += 1000
	h.e.Observe("c", rec("plant.a.temp", `{"temp": 10}`))
	if len(h.e.Active()) != 0 {
		t.Fatalf("should have resolved: %v", h.states())
	}
	evs := h.e.Events(10)
	if len(evs) != 2 || evs[0].State != StateResolved || evs[1].State != StateFiring {
		t.Fatalf("events = %+v", evs)
	}
}

func TestStaleFiresAndResolves(t *testing.T) {
	h := newHarness(t, Rule{ID: "r1", Name: "silent", Pattern: "plant.>", StaleAfter: 5, Enabled: true})
	h.e.Observe("c", rec("plant.a", `1`))
	h.e.Observe("c", rec("plant.b", `2`))
	h.now += 3000
	h.e.Observe("c", rec("plant.b", `3`))
	h.now += 3000 // a silent 6 s, b silent 3 s
	h.e.CheckStale()
	if got := h.states(); len(got) != 1 || got[0] != "plant.a:stale" {
		t.Fatalf("states = %v", got)
	}
	h.e.Observe("c", rec("plant.a", `4`))
	if len(h.e.Active()) != 0 {
		t.Fatal("a message resolves the stale alert")
	}
	h.e.CheckStale()
	if len(h.e.Active()) != 0 {
		t.Fatal("nothing stale right after traffic")
	}
	if evs := h.e.Events(0); len(evs) != 2 || evs[1].State != StateStale || evs[1].Preview != "1" {
		t.Fatalf("events = %+v", evs)
	}
}

func TestWebhookAndRuleChanges(t *testing.T) {
	h := newHarness(t, Rule{ID: "r1", Name: "hot", Pattern: "plant.>", Expr: "payload.temp > 80", Webhook: "http://hook", Enabled: true})
	h.e.Observe("c", rec("plant.a", `{"temp": 90}`))
	// the webhook posts from a goroutine and records the event afterwards
	deadline := 200
	for ; deadline > 0; deadline-- {
		h.mu.Lock()
		n := len(h.posts)
		h.mu.Unlock()
		if n == 1 {
			break
		}
		waitMs(5)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.posts) != 1 || !strings.Contains(h.posts[0], `"state":"firing"`) || !strings.HasPrefix(h.posts[0], "http://hook ") {
		t.Fatalf("posts = %v", h.posts)
	}
	// Disabling the rule drops its alert; a rule with other terms starts fresh.
	if err := h.e.SetRules([]Rule{{ID: "r1", Name: "hot", Pattern: "plant.>", Expr: "payload.temp > 80", Webhook: "http://hook", Enabled: false}}); err != nil {
		t.Fatal(err)
	}
	if len(h.e.Active()) != 0 {
		t.Fatal("disabled rule keeps an alert")
	}
	h.e.Observe("c", rec("plant.a", `{"temp": 90}`))
	if len(h.e.Active()) != 0 {
		t.Fatal("disabled rule fired")
	}
	if err := h.e.SetRules([]Rule{{ID: "r1", Name: "x", Pattern: "plant.>", Expr: "true", Enabled: true}, {ID: "r1", Name: "y", Pattern: "a", Expr: "true", Enabled: true}}); err == nil {
		t.Fatal("duplicate ids accepted")
	}
}

func TestForgetConnection(t *testing.T) {
	h := newHarness(t, Rule{ID: "r1", Name: "hot", Pattern: ">", Expr: "true", Enabled: true})
	h.e.Observe("c1", rec("a", `1`))
	h.e.Observe("c2", rec("a", `1`))
	if len(h.e.Active()) != 2 {
		t.Fatal("one alert per connection")
	}
	h.e.Forget("c1")
	if act := h.e.Active(); len(act) != 1 || act[0].ConnID != "c2" {
		t.Fatalf("active = %+v", act)
	}
}

func TestFlushDeliversChanges(t *testing.T) {
	h := newHarness(t, Rule{ID: "r1", Name: "hot", Pattern: ">", Expr: "true", Enabled: true})
	var got []Alert
	var evs []Event
	h.e.OnChange = func(a []Alert, e []Event) { got, evs = a, e }
	h.e.Observe("c", rec("a", `1`))
	h.e.Flush()
	if len(got) != 1 || len(evs) != 1 {
		t.Fatalf("flush delivered %d alerts, %d events", len(got), len(evs))
	}
	h.e.Flush()
	if len(evs) != 0 {
		t.Fatal("events must be delivered once")
	}
}

func TestMatchSubjectAndPrefix(t *testing.T) {
	for _, c := range []struct {
		p, s string
		want bool
	}{
		{"a.b", "a.b", true}, {"a.*", "a.b", true}, {"a.*", "a.b.c", false}, {"a.>", "a.b.c", true}, {"a.>", "a", false}, {">", "x", true}, {"a.b", "a.c", false},
	} {
		if got := MatchSubject(c.p, c.s); got != c.want {
			t.Errorf("MatchSubject(%q, %q) = %v", c.p, c.s, got)
		}
	}
	if LiteralPrefix("plant.line1.*.temp") != "plant.line1" || LiteralPrefix("*.temp") != "" || LiteralPrefix("a.>") != "a" {
		t.Fatal("literal prefix")
	}
}

func waitMs(ms int) { <-timeAfter(ms) }
