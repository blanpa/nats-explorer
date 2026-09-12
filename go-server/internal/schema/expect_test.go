package schema

import (
	"strings"
	"testing"
)

func expected() *Expected {
	return &Expected{Fields: []ExpectedField{
		{Path: "v", Types: []string{"number"}, Required: true},
		{Path: "unit", Types: []string{"string"}, Required: true, Enum: []string{"C", "F"}},
		{Path: "note", Types: []string{"string"}},
		{Path: "meta", Types: []string{"object"}, Required: true},
		{Path: "meta.id", Types: []string{"string"}, Required: true},
		{Path: "tags", Types: []string{"array"}},
		{Path: "tags[]", Types: []string{"string"}},
	}}
}

func reasons(vs []Violation) string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.String()
	}
	return strings.Join(out, " | ")
}

func TestCheckAcceptsWhatMatches(t *testing.T) {
	e := expected()
	ok := []string{
		`{"v":21,"unit":"C","meta":{"id":"m-1"}}`,
		`{"v":21.5,"unit":"F","note":"x","meta":{"id":"m-1"},"tags":["a","b"]}`,
		// An optional field may be absent, and an empty array has no elements to check.
		`{"v":1,"unit":"C","meta":{"id":"m"},"tags":[]}`,
	}
	for _, payload := range ok {
		if vs := e.Check("json", []byte(payload)); len(vs) > 0 {
			t.Errorf("%s should match, got %s", payload, reasons(vs))
		}
	}
}

func TestCheckReportsMissingWrongAndOutOfEnum(t *testing.T) {
	e := expected()
	cases := []struct{ payload, want string }{
		{`{"unit":"C","meta":{"id":"m"}}`, "v: missing"},
		{`{"v":"warm","unit":"C","meta":{"id":"m"}}`, "v: string, expected number"},
		{`{"v":1,"unit":"K","meta":{"id":"m"}}`, "unit: K, expected C or F"},
		{`{"v":1,"unit":"C","meta":{}}`, "meta.id: missing"},
		{`{"v":1,"unit":"C","meta":{"id":"m"},"tags":[1]}`, "tags[]: integer, expected string"},
		// A field that is missing below an absent optional parent is not
		// reported twice; both are named once.
		{`{"v":1,"unit":"C"}`, "meta: missing"},
	}
	for _, c := range cases {
		got := reasons(e.Check("json", []byte(c.payload)))
		if !strings.Contains(got, c.want) {
			t.Errorf("%s\n got: %s\nwant: %s", c.payload, got, c.want)
		}
	}
}

// A number field pinned from floats still has to accept the message that
// happens to send a whole one; the other way round is a real type change.
func TestCheckTakesIntegersForNumbers(t *testing.T) {
	e := expected()
	if vs := e.Check("json", []byte(`{"v":21,"unit":"C","meta":{"id":"m"}}`)); len(vs) > 0 {
		t.Errorf("an integer satisfies a number: %s", reasons(vs))
	}
	whole := &Expected{Fields: []ExpectedField{{Path: "v", Types: []string{"integer"}}}}
	if got := reasons(whole.Check("json", []byte(`{"v":21.5}`))); !strings.Contains(got, "v: number, expected integer") {
		t.Errorf("a float in an integer field is a violation, got %q", got)
	}
}

func TestCheckOnNonJSON(t *testing.T) {
	e := expected()
	if vs := e.Check("string", []byte("hello")); len(vs) != 1 || vs[0].Kind != "payload" {
		t.Fatalf("a non-JSON payload should be one violation, got %s", reasons(vs))
	}
	if vs := e.Check("json", []byte("{oops")); len(vs) != 1 || vs[0].Kind != "payload" {
		t.Fatalf("broken JSON should be one violation, got %s", reasons(vs))
	}
	// Nothing pinned accepts everything.
	var empty *Expected
	if vs := empty.Check("json", []byte(`{"anything":1}`)); vs != nil {
		t.Fatalf("an empty schema must accept everything, got %s", reasons(vs))
	}
}

// Unknown fields are only a violation when the schema was pinned strict:
// a producer that adds a field is usually fine, and a validator that cries
// about it is switched off.
func TestStrictReportsUnknownFields(t *testing.T) {
	e := expected()
	payload := []byte(`{"v":1,"unit":"C","meta":{"id":"m"},"extra":true}`)
	if vs := e.Check("json", payload); len(vs) != 0 {
		t.Fatalf("an extra field is not a violation by default: %s", reasons(vs))
	}
	e.Strict = true
	if got := reasons(e.Check("json", payload)); !strings.Contains(got, "extra: not in the schema") {
		t.Fatalf("strict should report the extra field, got %s", got)
	}
}

// Pinning takes the derived schema at face value: what every message carried
// is required, the observed types are the allowed ones. Ranges are not
// carried over -- a range from samples is not a rule.
func TestFromSchema(t *testing.T) {
	mn, mx := 1.0, 9.0
	s := Schema{Fields: []Field{
		{Path: "v", Types: []TypeCount{{Type: "integer", Count: 10}}, Presence: 1, Min: &mn, Max: &mx},
		{Path: "note", Types: []TypeCount{{Type: "string", Count: 4}}, Presence: 0.4, Enum: []string{"a", "b"}},
	}}
	e := FromSchema(s)
	if len(e.Fields) != 2 {
		t.Fatalf("fields = %+v", e.Fields)
	}
	if !e.Fields[0].Required || e.Fields[1].Required {
		t.Fatalf("presence should decide required: %+v", e.Fields)
	}
	if len(e.Fields[1].Enum) != 0 {
		t.Fatal("an enumeration guessed from samples must not be enforced without being asked for")
	}
	if e.Strict {
		t.Fatal("pinning is not strict by default")
	}
}
