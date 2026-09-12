package filter

import (
	"strings"
	"testing"

	"nats-explorer/internal/message"
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

// A list the browser gets carries the same verdict an expression makes, so
// a row that reads red and a `!valid` filter that does not catch it cannot
// disagree.
func TestAnnotate(t *testing.T) {
	t.Cleanup(func() { SetSchemaChecker(nil) })
	SetSchemaChecker(func(subject, _ string, payload []byte) ([]string, string) {
		if subject != "plant.temp" {
			return nil, ""
		}
		if strings.Contains(string(payload), `"temp"`) {
			return nil, "plant.>"
		}
		return []string{"temp: missing"}, "plant.>"
	})

	msgs := []message.NatsMessage{
		{Subject: "plant.temp", PayloadType: "json", Payload: `{"temp":21}`},
		{Subject: "plant.temp", PayloadType: "json", Payload: `{"other":1}`},
		{Subject: "plant.other", PayloadType: "json", Payload: `{}`},
	}
	Annotate(msgs)

	if msgs[0].Schema == nil || !msgs[0].Schema.Valid || msgs[0].Schema.Pattern != "plant.>" {
		t.Fatalf("matching message = %+v", msgs[0].Schema)
	}
	if msgs[1].Schema == nil || msgs[1].Schema.Valid || len(msgs[1].Schema.Violations) != 1 {
		t.Fatalf("breaking message = %+v", msgs[1].Schema)
	}
	// Nothing pinned is not the same as matching: the field stays away.
	if msgs[2].Schema != nil {
		t.Fatalf("unpinned subject = %+v", msgs[2].Schema)
	}
}

// Without a pinned schema anywhere the annotation costs one lookup and
// changes nothing.
func TestAnnotateWithoutAChecker(t *testing.T) {
	SetSchemaChecker(nil)
	msgs := []message.NatsMessage{{Subject: "plant.temp", PayloadType: "json", Payload: `{}`}}
	Annotate(msgs)
	if msgs[0].Schema != nil {
		t.Fatalf("verdict without a reference: %+v", msgs[0].Schema)
	}
}
