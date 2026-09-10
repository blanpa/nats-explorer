package filter

import (
	"testing"
)

// `valid` is what makes the payload filter, the history endpoints and the
// alert rules judge a message against the pinned schema without any of them
// knowing about schemas.
func TestValidAndViolations(t *testing.T) {
	t.Cleanup(func() { SetSchemaChecker(nil) })

	// Without a checker nothing is pinned, so everything is valid.
	SetSchemaChecker(nil)
	p, err := Compile("!valid")
	if err != nil {
		t.Fatal(err)
	}
	if p.Match(rec("a.b", `{"v":1}`)) {
		t.Fatal("without a pinned schema a message must not count as invalid")
	}

	var asked int
	SetSchemaChecker(func(subject, kind string, payload []byte) ([]string, string) {
		asked++
		if subject != "a.b" || kind != "json" || string(payload) != `{"v":1}` {
			t.Fatalf("checker got %s %s %s", subject, kind, payload)
		}
		return []string{"unit: missing"}, "a.>"
	})
	if !p.Match(rec("a.b", `{"v":1}`)) {
		t.Fatal("a violated schema must match !valid")
	}
	if asked != 1 {
		t.Fatalf("checker asked %d times, want once per message", asked)
	}

	// The reasons are readable from an expression too.
	q, err := Compile(`violations.exists(v, v.startsWith("unit"))`)
	if err != nil {
		t.Fatal(err)
	}
	if !q.Match(rec("a.b", `{"v":1}`)) {
		t.Fatal("violations should list the reason")
	}
}

// An expression that never mentions the schema must not pay for it.
func TestSchemaCheckIsLazy(t *testing.T) {
	t.Cleanup(func() { SetSchemaChecker(nil) })
	asked := 0
	SetSchemaChecker(func(string, string, []byte) ([]string, string) {
		asked++
		return nil, ""
	})
	p, err := Compile("payload.v == 1")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Match(rec("a.b", `{"v":1}`)) {
		t.Fatal("expression should match")
	}
	if asked != 0 {
		t.Fatalf("schema checked %d times for an expression that does not use it", asked)
	}
}
