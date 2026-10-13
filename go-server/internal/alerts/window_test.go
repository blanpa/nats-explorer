package alerts

import (
	"strings"
	"testing"
)

func intp(n int) *int           { return &n }
func floatp(f float64) *float64 { return &f }

// Too few messages in a window is the condition a single message cannot
// trigger: the engine's clock has to notice. Too many is its mirror.
func TestWindowCountsTooFewAndTooMany(t *testing.T) {
	h := newHarness(t,
		Rule{ID: "few", Name: "quiet", Pattern: "plant.>", Window: 60, MinCount: intp(10), Enabled: true},
		Rule{ID: "many", Name: "storm", Pattern: "plant.>", Window: 60, MaxCount: intp(100), Enabled: true},
	)
	// Three messages in the first ten seconds: too few for a minute, but
	// the subject has not been watched for a minute yet.
	for i := 0; i < 3; i++ {
		h.now += 3000
		h.e.Observe("c", rec("plant.a", `1`))
	}
	h.e.Tick()
	if got := h.states(); len(got) != 0 {
		t.Fatalf("a subject younger than the window must not be reported: %v", got)
	}
	h.now += 60_000
	h.e.Tick()
	act := h.e.Active()
	if len(act) != 1 || act[0].State != StateRate || !strings.Contains(act[0].Preview, "fewer than 10") {
		t.Fatalf("active = %+v", act)
	}
	// Enough traffic resolves it.
	for i := 0; i < 12; i++ {
		h.now += 1000
		h.e.Observe("c", rec("plant.a", `1`))
	}
	h.e.Tick()
	if got := h.states(); len(got) != 0 {
		t.Fatalf("resolved by traffic: %v", got)
	}
	// A storm fires the other rule.
	for i := 0; i < 120; i++ {
		h.now += 100
		h.e.Observe("c", rec("plant.a", `1`))
	}
	h.e.Tick()
	act = h.e.Active()
	if len(act) != 1 || act[0].RuleID != "many" || !strings.Contains(act[0].Preview, "more than 100") {
		t.Fatalf("active = %+v", act)
	}
	// Sixty seconds later the window is empty: the storm is over, and the
	// quiet rule has its say again.
	h.now += 61_000
	h.e.Tick()
	act = h.e.Active()
	if len(act) != 1 || act[0].RuleID != "few" {
		t.Fatalf("active = %+v", act)
	}
	// Both changed on the same tick, in whatever order the subjects came.
	evs := h.e.Events(0)
	states := evs[0].State + "," + evs[1].State
	if states != StateRate+","+StateResolved && states != StateResolved+","+StateRate {
		t.Fatalf("events = %+v", evs[:2])
	}
}

// An average over the window is what a threshold on a noisy sensor needs:
// one reading over 80 is a spike, five minutes over 80 is a problem.
func TestWindowAggregate(t *testing.T) {
	h := newHarness(t, Rule{ID: "r", Name: "warm", Pattern: "plant.>", Window: 60, Field: "temp", Agg: "avg", Above: floatp(80), Enabled: true})
	for _, v := range []string{"70", "95", "70", "75"} {
		h.now += 1000
		h.e.Observe("c", rec("plant.oven", `{"temp": `+v+`}`))
	}
	h.e.Tick()
	if got := h.states(); len(got) != 0 {
		t.Fatalf("average 77.5 is under 80: %v", got)
	}
	for i := 0; i < 6; i++ {
		h.now += 1000
		h.e.Observe("c", rec("plant.oven", `{"temp": 90}`))
	}
	h.e.Tick()
	act := h.e.Active()
	if len(act) != 1 || act[0].State != StateLevel || !strings.Contains(act[0].Preview, "avg temp 85 over 60 s, above 80") {
		t.Fatalf("active = %+v", act)
	}
	// A message without the field counts for the rate, not for the average.
	h.now += 1000
	h.e.Observe("c", rec("plant.oven", `{"humidity": 40}`))
	h.e.Tick()
	if len(h.e.Active()) != 1 {
		t.Fatal("a message without the field must not change the verdict")
	}
	// Min and max read the extremes, and a nested path is a path.
	h2 := newHarness(t, Rule{ID: "r", Name: "cold", Pattern: ">", Window: 60, Field: "s.t", Agg: "min", Below: floatp(0), Enabled: true})
	h2.now += 1000
	h2.e.Observe("c", rec("x", `{"s": {"t": 5}}`))
	h2.now += 1000
	h2.e.Observe("c", rec("x", `{"s": {"t": -2}}`))
	h2.e.Tick()
	if act := h2.e.Active(); len(act) != 1 || !strings.Contains(act[0].Preview, "min s.t -2 over 60 s, below 0") {
		t.Fatalf("active = %+v", act)
	}
}

// A sensor that is stuck sends the same value on time, which no other
// condition can tell from a sensor that is fine.
func TestStuckValue(t *testing.T) {
	h := newHarness(t, Rule{ID: "r", Name: "stuck", Pattern: "plant.>", Field: "temp", UnchangedFor: 30, Enabled: true})
	h.e.Observe("c", rec("plant.a", `{"temp": 21.5}`))
	h.now += 31_000
	h.e.Tick()
	if got := h.states(); len(got) != 0 {
		t.Fatalf("one message is a value, not a stuck one: %v", got)
	}
	h.e.Observe("c", rec("plant.a", `{"temp": 21.5}`))
	h.now += 5000
	h.e.Tick()
	act := h.e.Active()
	if len(act) != 1 || act[0].State != StateStuck || !strings.Contains(act[0].Preview, "temp = 21.5 unchanged for 36 s") {
		t.Fatalf("active = %+v", act)
	}
	h.now += 1000
	h.e.Observe("c", rec("plant.a", `{"temp": 21.6}`))
	if got := h.states(); len(got) != 0 {
		t.Fatalf("a new value resolves it: %v", got)
	}
	// Without a field the whole payload is compared.
	h2 := newHarness(t, Rule{ID: "r", Name: "stuck", Pattern: ">", UnchangedFor: 10, Enabled: true})
	h2.e.Observe("c", rec("x", `same`))
	h2.now += 6000
	h2.e.Observe("c", rec("x", `same`))
	h2.now += 6000
	h2.e.Tick()
	if act := h2.e.Active(); len(act) != 1 || !strings.HasPrefix(act[0].Preview, "payload unchanged") {
		t.Fatalf("active = %+v", act)
	}
}

// Muting keeps the change in the log and out of the channel; when the mute
// runs out, what is still true is sent then.
func TestMuteHoldsTheChannelAndSendsAfterwards(t *testing.T) {
	h := newHarness(t, Rule{ID: "r", Name: "hot", Pattern: ">", Expr: "payload.temp > 80", Webhook: "http://hook", MutedUntil: 1_000_000 + 60_000, Enabled: true})
	h.e.Observe("c", rec("plant.a", `{"temp": 90}`))
	act := h.e.Active()
	if len(act) != 1 || !act[0].Muted {
		t.Fatalf("active = %+v", act)
	}
	evs := h.e.Events(0)
	if len(evs) != 1 || !evs[0].Muted {
		t.Fatalf("events = %+v", evs)
	}
	h.mu.Lock()
	posts := len(h.posts)
	h.mu.Unlock()
	if posts != 0 {
		t.Fatal("a muted change was posted")
	}
	// The mute runs out while the alert is still true.
	h.now += 61_000
	h.e.Tick()
	waitFor(t, func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return len(h.posts) == 1
	})
	if act := h.e.Active(); len(act) != 1 || act[0].Muted {
		t.Fatalf("active = %+v", act)
	}
	if evs := h.e.Events(0); len(evs) != 2 || evs[0].Muted || evs[0].State != StateFiring {
		t.Fatalf("the change after the mute is logged as sent: %+v", evs)
	}
}

// A maintenance window mutes the subjects it names for the time it lasts.
func TestMaintenanceWindow(t *testing.T) {
	h := newHarness(t, Rule{ID: "r", Name: "hot", Pattern: ">", Expr: "true", Webhook: "http://hook", Enabled: true})
	if err := h.e.SetMaintenance([]Maintenance{{ID: "m1", Name: "line 1 rebuild", From: h.now - 1000, To: h.now + 60_000, Patterns: []string{"plant.line1.>"}}}); err != nil {
		t.Fatal(err)
	}
	h.e.Observe("c", rec("plant.line1.oven", `1`))
	h.e.Observe("c", rec("plant.line2.oven", `1`))
	byKey := map[string]Alert{}
	for _, a := range h.e.Active() {
		byKey[a.Subject] = a
	}
	if !byKey["plant.line1.oven"].Muted || byKey["plant.line2.oven"].Muted {
		t.Fatalf("active = %+v", byKey)
	}
	waitFor(t, func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return len(h.posts) == 1
	})
	h.mu.Lock()
	if !strings.Contains(h.posts[0], "line2") {
		t.Fatalf("posts = %v", h.posts)
	}
	h.mu.Unlock()
	// Removing the window sends what it held back.
	if err := h.e.SetMaintenance(nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return len(h.posts) == 2
	})
	for _, bad := range []Maintenance{{ID: "", From: 1, To: 2}, {ID: "x", From: 2, To: 1}, {ID: "x", From: 1, To: 2, Patterns: []string{"a b"}}} {
		if err := h.e.SetMaintenance([]Maintenance{bad}); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
}

// Acknowledging keeps the alert and marks who saw it; it clears with a resolve.
func TestAck(t *testing.T) {
	h := newHarness(t, Rule{ID: "r", Name: "hot", Pattern: ">", Expr: "payload.temp > 80", Enabled: true})
	h.e.Observe("c", rec("a", `{"temp": 90}`))
	k := h.e.Active()[0].Key
	if !h.e.Ack(k, "pascal", true) {
		t.Fatal("ack of an active alert failed")
	}
	if a := h.e.Active()[0]; a.AckedBy != "pascal" || a.AckedAt == 0 {
		t.Fatalf("active = %+v", a)
	}
	h.e.Ack(k, "", false)
	if a := h.e.Active()[0]; a.AckedBy != "" || a.AckedAt != 0 {
		t.Fatalf("unack: %+v", a)
	}
	if h.e.Ack("nope", "x", true) {
		t.Fatal("ack of nothing succeeded")
	}
	h.e.Ack(k, "pascal", true)
	h.now += 1000
	h.e.Observe("c", rec("a", `{"temp": 70}`))
	h.now += 1000
	h.e.Observe("c", rec("a", `{"temp": 90}`))
	if a := h.e.Active()[0]; a.AckedBy != "" {
		t.Fatalf("an ack must not survive a resolve: %+v", a)
	}
}

func TestWebhookFormatsAndMail(t *testing.T) {
	ev := Event{RuleName: "Too hot", Subject: "plant.a", State: StateFiring, Severity: "critical", Preview: `{"temp":90}`, Time: 1_000_000}
	if s := string(webhookBody(FormatSlack, ev)); !strings.Contains(s, `"text":"*[critical] Too hot: plant.a firing*`) || !strings.Contains(s, "```") {
		t.Fatalf("slack = %s", s)
	}
	if s := string(webhookBody(FormatTeams, ev)); !strings.Contains(s, "AdaptiveCard") || !strings.Contains(s, "[critical] Too hot: plant.a firing") {
		t.Fatalf("teams = %s", s)
	}
	if s := string(webhookBody("", ev)); !strings.Contains(s, `"state":"firing"`) || strings.Contains(s, "text") {
		t.Fatalf("json = %s", s)
	}
	if h := headline(Event{RuleName: "r", Subject: "s", State: StateStale, Severity: "warning"}); h != "[warning] r: s silent" {
		t.Fatalf("headline = %q", h)
	}
	if b := mailBody(ev); !strings.Contains(b, "Subject: plant.a") || !strings.Contains(b, `{"temp":90}`) {
		t.Fatalf("mail = %s", b)
	}
	if got := recipients("a@x.io, b@x.io;c@x.io"); len(got) != 3 || got[2] != "c@x.io" {
		t.Fatalf("recipients = %v", got)
	}

	// A rule with recipients and no mailer says so in the log instead of
	// failing quietly.
	h := newHarness(t, Rule{ID: "r", Name: "hot", Pattern: ">", Expr: "true", Email: "ops@example.com", Enabled: true})
	h.e.Observe("c", rec("a", `1`))
	waitFor(t, func() bool { return len(h.e.Events(0)) == 1 })
	if evs := h.e.Events(0); !strings.Contains(evs[0].WebhookError, "email is not configured") {
		t.Fatalf("events = %+v", evs)
	}
	// With one, it is used.
	var sent []string
	h2 := newHarness(t, Rule{ID: "r", Name: "hot", Pattern: ">", Expr: "true", Email: "ops@example.com, oncall@example.com", Enabled: true})
	h2.e.Mail = func(to []string, subject, body string) error {
		h2.mu.Lock()
		sent = append(sent, strings.Join(to, "+")+" "+subject)
		h2.mu.Unlock()
		return nil
	}
	h2.e.Observe("c", rec("a", `1`))
	waitFor(t, func() bool {
		h2.mu.Lock()
		defer h2.mu.Unlock()
		return len(sent) == 1
	})
	if sent[0] != "ops@example.com+oncall@example.com [warning] hot: a firing" {
		t.Fatalf("sent = %v", sent)
	}
}

func TestValidateWindowAndChannels(t *testing.T) {
	ok := Rule{Name: "x", Pattern: "a", Window: 60, Field: "temp", Above: floatp(1)}
	if err := Validate(&ok); err != nil || ok.Agg != "avg" {
		t.Fatalf("valid: %v %+v", err, ok)
	}
	for _, bad := range []Rule{
		{Name: "x", Pattern: "a", MinCount: intp(1)},              // no window
		{Name: "x", Pattern: "a", Window: 60, MinCount: intp(-1)}, // negative count
		{Name: "x", Pattern: "a", Window: 60, Above: floatp(1)},   // no field
		{Name: "x", Pattern: "a", Window: 60, Field: "t", Agg: "sum", Above: floatp(1)},
		{Name: "x", Pattern: "a", Window: MaxWindow + 1, MinCount: intp(1)},
		{Name: "x", Pattern: "a", UnchangedFor: -1},
		{Name: "x", Pattern: "a", Expr: "true", WebhookFormat: "discord"},
		{Name: "x", Pattern: "a", Expr: "true", Email: "nobody"},
		{Name: "x", Pattern: "a", Window: 60}, // a window alone is no condition
	} {
		if err := Validate(&bad); err == nil {
			t.Errorf("%+v validated", bad)
		}
	}
	// Renaming a rule keeps its state; changing what it watches does not.
	h := newHarness(t, Rule{ID: "r", Name: "hot", Pattern: ">", Expr: "true", Enabled: true})
	h.e.Observe("c", rec("a", `1`))
	if err := h.e.SetRules([]Rule{{ID: "r", Name: "renamed", Pattern: ">", Expr: "true", Email: "a@b.c", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if len(h.e.Active()) != 1 {
		t.Fatal("a rename dropped the alert")
	}
	if err := h.e.SetRules([]Rule{{ID: "r", Name: "renamed", Pattern: ">", Expr: "true", Window: 60, MinCount: intp(1), Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if len(h.e.Active()) != 0 {
		t.Fatal("a changed condition kept the alert")
	}
}

// waitFor polls a condition that a goroutine of the engine fulfils.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if cond() {
			return
		}
		<-timeAfter(5)
	}
	t.Fatal("condition not met in time")
}
