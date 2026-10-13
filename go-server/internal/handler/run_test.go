package handler

import (
	mrand "math/rand"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestExpandTemplate(t *testing.T) {
	rnd := mrand.New(mrand.NewSource(1))
	now := time.UnixMilli(1_700_000_000_000)
	if got := expandTemplate("orders.{{i}}.{{ i }}", 7, now, rnd); got != "orders.7.7" {
		t.Errorf("i = %q", got)
	}
	if got := expandTemplate(`{"ts":{{ts}}}`, 1, now, rnd); got != `{"ts":1700000000000}` {
		t.Errorf("ts = %q", got)
	}
	for k := 0; k < 50; k++ {
		got := expandTemplate("{{rand:5-7}}", 1, now, rnd)
		if got != "5" && got != "6" && got != "7" {
			t.Fatalf("rand out of range: %q", got)
		}
	}
	if got := expandTemplate("{{rand:7-5}}", 1, now, rnd); got != "5" && got != "6" && got != "7" {
		t.Errorf("reversed range should still work, got %q", got)
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(expandTemplate("{{uuid}}", 1, now, rnd)) {
		t.Error("uuid is not a v4 uuid")
	}
	if got := expandTemplate("{{unknown}} plain", 1, now, rnd); got != "{{unknown}} plain" {
		t.Errorf("unknown variables must stay untouched, got %q", got)
	}
}

func TestPercentile(t *testing.T) {
	s := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	if percentile(s, 0.5) != 5 || percentile(s, 0.95) != 9 || percentile(nil, 0.5) != 0 {
		t.Errorf("percentiles: p50=%v p95=%v", percentile(s, 0.5), percentile(s, 0.95))
	}
}

// The verdict counts what went wrong: every error, every reply the
// expression refused, a p95 over the bound, a publish asked to judge
// replies it never gets.
func TestVerdict(t *testing.T) {
	res := RunResult{Mode: "request", Sent: 10, OK: 8, Errors: 2, ErrorCounts: map[string]int{"nats: timeout": 2}}
	res.judge(RunSpec{Mode: "request", Expect: &Expect{Expr: "payload.ok", MaxLatencyMs: 100}}, 3, 250)
	v := res.Verdict
	if v.Passed || v.Checked != 10 || v.Failed != 6 || len(v.Reasons) != 3 {
		t.Fatalf("verdict = %+v", v)
	}
	if v.Reasons[0] != "2× nats: timeout" || !strings.Contains(v.Reasons[1], "3 of 8 replies") || !strings.Contains(v.Reasons[2], "p95 250.0 ms over the 100 ms") {
		t.Fatalf("reasons = %v", v.Reasons)
	}

	clean := RunResult{Mode: "request", Sent: 5, OK: 5, ErrorCounts: map[string]int{}}
	clean.judge(RunSpec{Mode: "request", Expect: &Expect{Expr: "true", MaxLatencyMs: 100}}, 0, 20)
	if !clean.Verdict.Passed || clean.Verdict.Failed != 0 || len(clean.Verdict.Reasons) != 0 {
		t.Fatalf("clean verdict = %+v", clean.Verdict)
	}

	// Without an expectation a run still judges itself: no errors is a pass.
	plain := RunResult{Mode: "publish", Sent: 5, OK: 5, ErrorCounts: map[string]int{}}
	plain.judge(RunSpec{Mode: "publish"}, 0, 0)
	if !plain.Verdict.Passed {
		t.Fatalf("plain verdict = %+v", plain.Verdict)
	}
	pub := RunResult{Mode: "publish", Sent: 1, OK: 1, ErrorCounts: map[string]int{}}
	pub.judge(RunSpec{Mode: "publish", Expect: &Expect{Expr: "true"}}, 0, 0)
	if pub.Verdict.Passed || !strings.Contains(pub.Verdict.Reasons[0], "a publish gets none") {
		t.Fatalf("publish with an expression = %+v", pub.Verdict)
	}

	// Normalize applies the limits and names what cannot run.
	spec := RunSpec{Subject: "a", Count: 0, Concurrency: 500, Timeout: -1, Interval: time.Hour}
	if err := spec.Normalize(); err != nil || spec.Count != 1 || spec.Concurrency != 1 || spec.Timeout != 5*time.Second || spec.Interval != 10*time.Second || spec.Mode != "publish" {
		t.Fatalf("normalized = %+v (%v)", spec, err)
	}
	if err := (&RunSpec{Subject: "a", Count: runMaxCount + 1}).Normalize(); err == nil {
		t.Fatal("a count over the limit passed")
	}
	if err := (&RunSpec{Subject: "a", Expect: &Expect{Expr: "payload >"}}).Normalize(); err == nil {
		t.Fatal("a broken expression passed")
	}
	if err := (&RunSpec{Count: 1}).Normalize(); err == nil {
		t.Fatal("no subject passed")
	}
}
