package handler

import (
	mrand "math/rand"
	"regexp"
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
