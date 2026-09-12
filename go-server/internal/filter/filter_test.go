package filter

import (
	"testing"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/message"
)

func rec(subject, payload string) *message.Record {
	return message.NewRecord(&nats.Msg{Subject: subject, Data: []byte(payload), Header: nats.Header{"Trace": {"abc"}}}, 1, 1000)
}

func TestCompileErrors(t *testing.T) {
	for _, bad := range []string{"payload.temp >", "subject + 1", "nope(1)", `"a string"`} {
		if _, err := Compile(bad); err == nil {
			t.Errorf("%q compiled", bad)
		}
	}
	if _, err := Compile("payload.temp > 21"); err != nil {
		t.Fatal(err)
	}
}

func TestMatchRecords(t *testing.T) {
	cases := []struct {
		expr    string
		subject string
		payload string
		want    bool
	}{
		{"payload.temp > 21", "plant.a.temp", `{"temp": 21.5}`, true},
		{"payload.temp > 21", "plant.a.temp", `{"temp": 20}`, false},
		{"payload.temp > 21", "plant.a.temp", `{"unit": "C"}`, false}, // missing field: no match, no panic
		{"payload.temp > 21", "plant.a.temp", `not json`, false},
		{`subject.endsWith(".temp") && payload.unit == "C"`, "plant.a.temp", `{"unit": "C"}`, true},
		{`subject.startsWith("plant") && has(payload.alarm)`, "plant.b", `{"alarm": {"code": 3}}`, true},
		{`payload.alarm.code in [3, 4]`, "plant.b", `{"alarm": {"code": 3}}`, true},
		{`payload.tags.exists(t, t == "hot")`, "plant.b", `{"tags": ["cold", "hot"]}`, true},
		{`headers["Trace"] == "abc"`, "x", `{}`, true},
		{`headers["Missing"] == "abc"`, "x", `{}`, false},
		{`size > 3 && kind == "string"`, "x", `hello`, true},
		{`raw.contains("ell")`, "x", `hello`, true},
		{`payload.matches("^h.*o$")`, "x", `hello`, true},
		{`timestamp == 1000`, "x", `{}`, true},
		{`subject.matches("^plant\\.[a-z]+\\.temp$")`, "plant.a.temp", `{}`, true},
		{`payload.values.size() == 2 && math.greatest(payload.values) >= 9`, "x", `{"values": [1, 9]}`, true},
	}
	for _, c := range cases {
		p, err := Compile(c.expr)
		if err != nil {
			t.Fatalf("%s: %v", c.expr, err)
		}
		if got := p.Match(rec(c.subject, c.payload)); got != c.want {
			t.Errorf("%s on %s %s = %v, want %v", c.expr, c.subject, c.payload, got, c.want)
		}
	}
}

func TestKeepAndWireMessages(t *testing.T) {
	p, _ := Compile("payload.n % 2 == 0")
	var msgs []message.NatsMessage
	for i := 0; i < 10; i++ {
		msgs = append(msgs, rec("s", `{"n": `+string(rune('0'+i))+`}`).Wire("c"))
	}
	kept := Keep(p, msgs, 3)
	if len(kept) != 3 || kept[0].Payload != `{"n": 0}` || kept[2].Payload != `{"n": 4}` {
		t.Fatalf("kept = %+v", kept)
	}
	if got := Keep(nil, msgs, 4); len(got) != 4 {
		t.Fatalf("nil program keeps the first limit: %d", len(got))
	}
	if !p.MatchMessage(&msgs[2]) || p.MatchMessage(&msgs[3]) {
		t.Fatal("wire message evaluation")
	}
}

func TestCompileCache(t *testing.T) {
	a, _ := Compile("size > 1")
	b, _ := Compile("size > 1")
	if a != b {
		t.Fatal("same expression must reuse the program")
	}
}
