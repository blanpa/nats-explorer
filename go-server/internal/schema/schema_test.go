package schema

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"nats-explorer/internal/message"
)

func msg(ts int64, payload string) message.NatsMessage {
	return message.NatsMessage{Subject: "s", Payload: payload, PayloadType: "json", Timestamp: ts, Size: len(payload)}
}

func field(t *testing.T, s Schema, path string) Field {
	t.Helper()
	for _, f := range s.Fields {
		if f.Path == path {
			return f
		}
	}
	t.Fatalf("field %q missing in %+v", path, s.Fields)
	return Field{}
}

func TestTypesPresenceAndRanges(t *testing.T) {
	s := Infer([]message.NatsMessage{
		msg(1, `{"temp": 21.5, "on": true, "name": "a", "tags": ["x", "y"], "meta": {"unit": "C"}}`),
		msg(2, `{"temp": 22, "on": false, "name": null, "tags": [], "meta": {"unit": "C", "extra": 1}}`),
		msg(3, `{"temp": 19.25, "on": true, "name": "b"}`),
		{Subject: "s", Payload: "plain text", PayloadType: "string", Timestamp: 4},
		{Subject: "s", Payload: "AAAA", PayloadType: "binary", Timestamp: 5},
	})
	if s.Samples != 5 || s.Kinds["json"] != 3 || s.Kinds["string"] != 1 || s.Kinds["binary"] != 1 {
		t.Fatalf("samples/kinds = %d %v", s.Samples, s.Kinds)
	}
	if s.From != 1 || s.To != 5 {
		t.Fatalf("range = %d..%d", s.From, s.To)
	}
	temp := field(t, s, "temp")
	if temp.Presence != 1 || *temp.Min != 19.25 || *temp.Max != 22 {
		t.Fatalf("temp = %+v", temp)
	}
	// 22 among the floats does not make the field an integer one.
	if len(temp.Types) != 1 || temp.Types[0] != (TypeCount{"number", 3}) {
		t.Fatalf("temp types = %+v", temp.Types)
	}
	name := field(t, s, "name")
	if name.Types[0].Type != "string" || name.Types[0].Count != 2 || name.Types[1].Type != "null" || name.Example != `"a"` {
		t.Fatalf("name = %+v", name)
	}
	if got := field(t, s, "meta.extra"); got.Presence < 0.33 || got.Presence > 0.34 || got.Types[0].Type != "integer" {
		t.Fatalf("nested presence = %+v", got)
	}
	if got := field(t, s, "tags[]"); got.Types[0] != (TypeCount{"string", 2}) || got.Presence < 0.33 || got.Presence > 0.34 {
		t.Fatalf("array items = %+v", got)
	}
	if got := field(t, s, "tags"); got.Presence < 0.66 || got.Types[0].Type != "array" {
		t.Fatalf("array = %+v", got)
	}
	// document order of first sight, not alphabetical
	if s.Fields[0].Path != "meta" && s.Fields[0].Path != "name" && s.Fields[0].Path != "on" {
		t.Fatalf("first field = %s", s.Fields[0].Path)
	}
	if len(s.Drift) != 0 {
		t.Fatalf("no drift expected in stable data, got %+v", s.Drift)
	}
}

// How a number was written is the only word the producer has on whether the
// field is whole: JSON has one number type, and 21.0 read as an integer is
// how a schema ends up rejecting the first 21.5.
func TestIntegerAndFloatComeFromTheLiteral(t *testing.T) {
	s := Infer([]message.NatsMessage{
		msg(1, `{"whole": 21, "float": 21.0, "exp": 1e3, "id": 9007199254740993, "neg": -3}`),
	})
	for path, want := range map[string]string{"whole": "integer", "float": "number", "exp": "number", "id": "integer", "neg": "integer"} {
		if got := field(t, s, path).Types[0].Type; got != want {
			t.Errorf("%s = %s, want %s", path, got, want)
		}
	}
	// A float64 would have rounded the id to ...92 on the way through.
	if got := field(t, s, "id").Example; got != "9007199254740993" {
		t.Errorf("id example = %s, the digits should survive", got)
	}
	if got := field(t, s, "float").Example; got != "21.0" {
		t.Errorf("float example = %s, want the literal", got)
	}
}

// A field that carries both is a number field, not a field of two types:
// every integer is a number, and the union would otherwise widen the moment
// a whole value arrives.
func TestIntegersFoldIntoNumbers(t *testing.T) {
	f := field(t, Infer([]message.NatsMessage{
		msg(1, `{"v": 21}`),
		msg(2, `{"v": 21.5}`),
		msg(3, `{"v": 22}`),
	}), "v")
	if len(f.Types) != 1 || f.Types[0] != (TypeCount{"number", 3}) {
		t.Fatalf("types = %+v", f.Types)
	}
	if *f.Min != 21 || *f.Max != 22 {
		t.Fatalf("range = %v..%v", *f.Min, *f.Max)
	}
}

// An example is text on a screen; a byte cut through a rune would show up
// as a replacement character in the middle of a word.
func TestLongExampleIsCutOnARune(t *testing.T) {
	long := strings.Repeat("ü", 60)
	got := field(t, Infer([]message.NatsMessage{msg(1, fmt.Sprintf(`{"note": %q}`, long))}), "note").Example
	if !strings.HasSuffix(got, "…") || !utf8.ValidString(got) {
		t.Fatalf("example = %q, want valid UTF-8 ending in an ellipsis", got)
	}
}

// The timestamp of a payload is a string like any other until the schema
// says what shape it has; then a generator can turn it into a date.
func TestTimestampStringsAreNamedAsSuch(t *testing.T) {
	s := Infer([]message.NatsMessage{
		msg(1, `{"at": "2026-09-12T08:04:31.768Z", "name": "pump", "mixed": "2026-09-12T08:04:31Z"}`),
		msg(2, `{"at": "2026-09-12T08:04:36Z", "name": "2026-09-12T08:04:36Z", "mixed": "later"}`),
	})
	if got := field(t, s, "at").Format; got != "date-time" {
		t.Errorf("at format = %q", got)
	}
	// One timestamp among the names says nothing about the field.
	if got := field(t, s, "name").Format; got != "" {
		t.Errorf("name format = %q, a field is only a date when every sample is", got)
	}
	if got := field(t, s, "mixed").Format; got != "" {
		t.Errorf("mixed format = %q", got)
	}
}

func TestEnumNeedsEnoughSamplesAndFewValues(t *testing.T) {
	var few, many []message.NatsMessage
	for i := 0; i < 12; i++ {
		few = append(few, msg(int64(i), fmt.Sprintf(`{"state": "%s"}`, []string{"run", "stop", "idle"}[i%3])))
		many = append(many, msg(int64(i), fmt.Sprintf(`{"id": "id-%d"}`, i)))
	}
	if got := field(t, Infer(few), "state").Enum; strings.Join(got, ",") != "idle,run,stop" {
		t.Fatalf("enum = %v", got)
	}
	if got := field(t, Infer(many), "id").Enum; got != nil {
		t.Fatalf("too many distinct values must not be an enum: %v", got)
	}
	if got := field(t, Infer(few[:6]), "state").Enum; got != nil {
		t.Fatalf("too few samples must not be an enum: %v", got)
	}
}

// A payload with more paths than the budget is reported as far as it goes,
// and says so; silence would make a cut list look like the whole shape.
func TestTooManyFieldsSaysSo(t *testing.T) {
	var b strings.Builder
	b.WriteString("{")
	for i := 0; i < MaxFields+20; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"f%03d":%d`, i, i)
	}
	b.WriteString("}")
	s := Infer([]message.NatsMessage{msg(1, b.String())})
	if len(s.Fields) != MaxFields || !s.Truncated {
		t.Fatalf("fields = %d, truncated = %v", len(s.Fields), s.Truncated)
	}
	if plenty := Infer([]message.NatsMessage{msg(1, `{"a":1,"b":2}`)}); plenty.Truncated {
		t.Fatal("a payload that fits must not be reported as cut")
	}
}

func TestDriftKinds(t *testing.T) {
	var msgs []message.NatsMessage
	for i := 0; i < 10; i++ {
		msgs = append(msgs, msg(int64(i), `{"temp": 20, "old": 1, "unit": "C"}`))
	}
	for i := 10; i < 20; i++ {
		msgs = append(msgs, msg(int64(i), `{"temp": "20", "fresh": true, "unit": "C"}`))
	}
	s := Infer(msgs)
	want := map[string]Drift{
		"temp":  {Path: "temp", Kind: "type-changed", Before: "integer", After: "string", Since: 10},
		"old":   {Path: "old", Kind: "field-gone", Before: "integer", After: "", Since: 10},
		"fresh": {Path: "fresh", Kind: "field-new", Before: "", After: "bool", Since: 10},
	}
	if len(s.Drift) != len(want) {
		t.Fatalf("drift = %+v", s.Drift)
	}
	for _, d := range s.Drift {
		if want[d.Path] != d {
			t.Errorf("drift %s = %+v, want %+v", d.Path, d, want[d.Path])
		}
	}
	// a field that appears in only a few new messages is not "established"
	rare := append([]message.NatsMessage{}, msgs[:10]...)
	for i := 10; i < 20; i++ {
		p := `{"temp": 20, "old": 1, "unit": "C"}`
		if i == 10 {
			p = `{"temp": 20, "old": 1, "unit": "C", "blip": 1}`
		}
		rare = append(rare, msg(int64(i), p))
	}
	if d := Infer(rare).Drift; len(d) != 0 {
		t.Fatalf("rare field must not drift: %+v", d)
	}
}

// Halves are only compared when both hold enough messages, and a field that
// merely wobbles (optional, or an int that becomes a decimal, or a null that
// gets a value) is not a change.
func TestDriftIgnoresNoise(t *testing.T) {
	half := func(n int, payload string, from int) []message.NatsMessage {
		var out []message.NatsMessage
		for i := 0; i < n; i++ {
			out = append(out, msg(int64(from+i), payload))
		}
		return out
	}

	// Four messages per half: too little to call anything a trend.
	short := append(half(4, `{"a": 1, "gone": 2}`, 0), half(4, `{"a": 1}`, 10)...)
	if d := Infer(short).Drift; len(d) != 0 {
		t.Fatalf("below the sample minimum nothing may drift: %+v", d)
	}

	// The same data with enough messages does report the vanished field.
	long := append(half(6, `{"a": 1, "gone": 2}`, 0), half(6, `{"a": 1}`, 10)...)
	if d := Infer(long).Drift; len(d) != 1 || d[0].Path != "gone" || d[0].Kind != "field-gone" {
		t.Fatalf("a genuinely vanished field must drift: %+v", d)
	}

	// 20 then 20.5 is one numeric field, and a null that gets a value is not
	// a type change either; both halves also skip an optional field at times.
	wobble := append(half(3, `{"temp": 20, "name": null, "opt": 1}`, 0), half(3, `{"temp": 20, "name": null}`, 3)...)
	wobble = append(wobble, half(3, `{"temp": 20.5, "name": "x", "opt": 1}`, 10)...)
	wobble = append(wobble, half(3, `{"temp": 21.5, "name": "y"}`, 13)...)
	if d := Infer(wobble).Drift; len(d) != 0 {
		t.Fatalf("int→decimal, null→value and an optional field are no drift: %+v", d)
	}

	// A real type change is still caught next to that noise.
	real := append(half(6, `{"temp": 20, "opt": 1}`, 0), half(6, `{"temp": "20", "opt": 1}`, 10)...)
	d := Infer(real).Drift
	if len(d) != 1 || d[0].Path != "temp" || d[0].Kind != "type-changed" || d[0].Before != "integer" || d[0].After != "string" {
		t.Fatalf("real type change = %+v", d)
	}
}

func TestDepthAndFieldCaps(t *testing.T) {
	deep := `{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}`
	s := Infer([]message.NatsMessage{msg(1, deep)})
	for _, f := range s.Fields {
		if strings.Count(f.Path, ".") > MaxDepth-1 {
			t.Fatalf("path beyond depth limit: %s", f.Path)
		}
	}
	if _, ok := find(s, "a.b.c.d.e.f"); !ok {
		t.Fatal("depth 6 must still be reported")
	}
	if _, ok := find(s, "a.b.c.d.e.f.g"); ok {
		t.Fatal("depth 7 must be cut")
	}
	var b strings.Builder
	b.WriteString("{")
	for i := 0; i < MaxFields+50; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"f%03d": %d`, i, i)
	}
	b.WriteString("}")
	if got := len(Infer([]message.NatsMessage{msg(1, b.String())}).Fields); got != MaxFields {
		t.Fatalf("fields = %d, want cap %d", got, MaxFields)
	}
}

func TestEmptyAndInvalidJSON(t *testing.T) {
	s := Infer(nil)
	if s.Samples != 0 || len(s.Fields) != 0 || s.Fields == nil || s.Drift == nil {
		t.Fatalf("empty = %+v", s)
	}
	s = Infer([]message.NatsMessage{{Payload: "{not json", PayloadType: "json", Timestamp: 1}})
	if s.Kinds["json"] != 0 || s.Kinds["string"] != 1 || len(s.Fields) != 0 {
		t.Fatalf("invalid json = %+v", s)
	}
}

func find(s Schema, path string) (Field, bool) {
	for _, f := range s.Fields {
		if f.Path == path {
			return f, true
		}
	}
	return Field{}, false
}
