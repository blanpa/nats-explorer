package filter

import (
	"testing"
	"time"

	"nats-explorer/internal/message"
)

// What one expression costs per message. The persist filter runs on the
// ingest path, so this is paid at the arrival rate -- the rate the filter
// exists to survive in the first place.
//
// The eager case is what evaluating used to cost every time: VarsOf parses
// the payload up front, whether or not the expression looks at it. Most
// filters only look at the subject, which is why the variables are resolved
// lazily now.
func BenchmarkEval(b *testing.B) {
	rec := &message.Record{
		Subject:   "sensor.hall-2.t-14",
		Data:      []byte(`{"sensor":"t-14","celsius":21.5,"site":"hall-2","tags":["a","b"],"reading":{"raw":4711,"unit":"C"}}`),
		Timestamp: time.Now().UnixMilli(),
	}
	cases := []struct {
		name  string
		expr  string
		eager bool
	}{
		{name: "subject", expr: `subject.startsWith("sensor.")`},
		{name: "subject_eager", expr: `subject.startsWith("sensor.")`, eager: true},
		{name: "size", expr: `size > 1024`},
		{name: "payload", expr: `payload.celsius > 30.0`},
	}
	for _, c := range cases {
		p, err := Compile(c.expr)
		if err != nil {
			b.Fatal(err)
		}
		b.Run(c.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if c.eager {
					p.Eval(VarsOf(rec))
				} else {
					p.Match(rec)
				}
			}
		})
	}
}
