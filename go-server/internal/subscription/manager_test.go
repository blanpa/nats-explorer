package subscription

import (
	"encoding/base64"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/message"
)

func TestEncodePayload(t *testing.T) {
	cases := []struct {
		name     string
		in       []byte
		wantType string
		wantOut  string
	}{
		{"json object", []byte(`{"a":1}`), "json", `{"a":1}`},
		{"json array", []byte(`[1,2]`), "json", `[1,2]`},
		{"looks like json but invalid", []byte(`{oops`), "string", `{oops`},
		{"plain text", []byte("hello"), "string", "hello"},
		{"empty", []byte(""), "string", ""},
		{"utf8 text", []byte("grüße"), "string", "grüße"},
		{"binary", []byte{0xff, 0x00, 0x01}, "binary", base64.StdEncoding.EncodeToString([]byte{0xff, 0x00, 0x01})},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, typ := message.EncodePayload(c.in)
			if typ != c.wantType {
				t.Errorf("type = %q, want %q", typ, c.wantType)
			}
			if out != c.wantOut {
				t.Errorf("payload = %q, want %q", out, c.wantOut)
			}
		})
	}
}

func TestManagerStopIsIdempotent(t *testing.T) {
	m := NewManager("c1")
	m.Stop() // never started
	m.Stop()
	if m.GetStats().Received != 0 {
		t.Fatal("fresh manager must have no stats")
	}
}

func TestClientFeedBudgets(t *testing.T) {
	m := NewManager("c1")
	m.SetFocus("tab", []string{"hot.branch", "other.leaf"})
	cl := m.clients["tab"]

	if cl.wants("hot.branchx") || cl.wants("hot") || !cl.wants("hot.branch") || !cl.wants("hot.branch.leaf.deep") {
		t.Fatal("focus must match the subject itself and everything below it, at segment boundaries")
	}
	if !cl.wants("other.leaf") || cl.wants("other") {
		t.Fatal("every focused subject must be matched")
	}

	// Per-subject cap.
	got := 0
	for i := 0; i < MaxMsgsPerSecondPerSubject+5; i++ {
		if cl.admit("hot.branch.leaf") {
			got++
		}
	}
	if got != MaxMsgsPerSecondPerSubject {
		t.Fatalf("subject admitted %d, want %d", got, MaxMsgsPerSecondPerSubject)
	}

	// Repeats yield to first messages once half the client budget is used.
	cl.resetSecond()
	for i := 0; i < MaxMsgsPerSecondPerClient/2; i++ {
		cl.admit("hot.branch.repeat")
		cl.perSubject["hot.branch.repeat"] = 1 // stay below the per-subject cap
	}
	if cl.admit("hot.branch.repeat") {
		t.Fatal("repeat must be refused above half the client budget")
	}
	if !cl.admit("hot.branch.fresh") {
		t.Fatal("first message of a subject must still get through")
	}
	cl.sent = MaxMsgsPerSecondPerClient
	if cl.admit("hot.branch.other") {
		t.Fatal("exhausted client budget must refuse")
	}
	cl.resetSecond()
	if cl.sent != 0 || len(cl.perSubject) != 0 || !cl.admit("hot.branch.other") {
		t.Fatal("resetSecond must start the budgets over")
	}

	// Changing the focus discards what was batched for the old one.
	cl.batch = []*message.Record{{Subject: "hot.branch.leaf"}}
	m.SetFocus("tab", []string{"cold"})
	if !sameStrings(m.clients["tab"].focus, []string{"cold"}) || len(m.clients["tab"].batch) != 0 {
		t.Fatal("focus change must reset the client")
	}
	m.clients["tab"].batch = []*message.Record{{Subject: "cold"}}
	m.SetFocus("tab", []string{"cold"})
	if len(m.clients["tab"].batch) != 1 {
		t.Fatal("an unchanged focus must keep the batch")
	}
	m.SetFocus("tab", nil)
	if len(m.clients["tab"].focus) != 0 || m.clients["tab"].wants("cold") {
		t.Fatal("empty focus must stop the feed")
	}
	m.RemoveClient("tab")
	if _, ok := m.clients["tab"]; ok {
		t.Fatal("client should be forgotten")
	}
}

func TestStatsRateAveragesSeconds(t *testing.T) {
	m := NewManager("c1")
	var got Stats
	m.OnStats = func(_ string, s Stats) { got = s }
	m.totalRecv.Store(100)
	m.tick()
	m.totalRecv.Store(400)
	m.tick()
	if got.Rate != 200 || got.Received != 400 {
		t.Fatalf("rate after two ticks = %+v", got)
	}
	m.tick()
	m.tick()
	if got.Rate != 100 {
		t.Fatalf("rate averages the last %d seconds, got %+v", rateSamples, got)
	}
}

func TestMatchSubject(t *testing.T) {
	cases := []struct {
		pattern, subject string
		want             bool
	}{
		{">", "a", true},
		{">", "a.b.c", true},
		{"a.>", "a", false},
		{"a.>", "a.b", true},
		{"a.>", "a.b.c", true},
		{"a.*", "a.b", true},
		{"a.*", "a.b.c", false},
		{"a.*.c", "a.b.c", true},
		{"a.*.c", "a.b.d", false},
		{"a.b", "a.b", true},
		{"a.b", "a.bc", false},
		{"*.b.>", "x.b.y.z", true},
	}
	for _, c := range cases {
		if got := matchSubject(c.pattern, c.subject); got != c.want {
			t.Errorf("match(%q, %q) = %v, want %v", c.pattern, c.subject, got, c.want)
		}
	}
}

func TestPatternStatsCountSubjectsAndRate(t *testing.T) {
	m := NewManager("c1")
	patterns := []*patternStat{{pattern: "a.>"}, {pattern: "*.x"}}
	m.patterns.Store(&patterns)
	var got Stats
	m.OnStats = func(_ string, s Stats) { got = s }
	for _, subj := range []string{"a.x", "a.y", "b.x"} {
		ps := patterns[0]
		if !matchSubject(ps.pattern, subj) {
			ps = patterns[1]
		}
		m.process(m.shardOf(subj), delivery{msg: &nats.Msg{Subject: subj, Data: []byte("1")}, ps: ps, seq: uint64(m.totalRecv.Add(1)), now: time.Now().UnixMilli()})
	}
	m.tick()
	if len(got.Patterns) != 2 {
		t.Fatalf("patterns = %+v", got.Patterns)
	}
	// a.x matches both patterns, so it counts for each.
	if p := got.Patterns[0]; p.Pattern != "a.>" || p.Received != 2 || p.Subjects != 2 || p.Rate != 2 {
		t.Errorf("a.> = %+v", p)
	}
	if p := got.Patterns[1]; p.Pattern != "*.x" || p.Received != 1 || p.Subjects != 2 || p.Rate != 1 {
		t.Errorf("*.x = %+v", p)
	}
}

func TestRateBuckets(t *testing.T) {
	var r rateBuckets
	if r.value(5_000) != 0 {
		t.Fatal("no hits, no rate")
	}
	for i := 0; i < 20; i++ {
		r.hit(10_000 + int64(i)*100) // 20 messages within second 10..11
	}
	if got := r.value(11_500); got != 2 {
		t.Fatalf("rate after 20 hits in the window = %v, want 2", got)
	}
	if got := r.value(21_500); got != 0 {
		t.Fatalf("rate ten seconds later = %v, want 0", got)
	}
	r.hit(30_000)
	r.hit(30_500)
	r.hit(31_000)
	if got := r.value(31_000); got != 0.3 {
		t.Fatalf("rate = %v, want 0.3", got)
	}
	if got := r.value(39_999); got != 0.3 {
		t.Fatalf("still inside the window: %v", got)
	}
	if got := r.value(40_500); got != 0.1 {
		t.Fatalf("second 30 dropped out: %v", got)
	}
}

// process is the whole hot path: counters, subject stats, feed, history.
func TestProcessCountsAndFeeds(t *testing.T) {
	m := NewManager("c1")
	patterns := []*patternStat{{pattern: ">"}}
	m.patterns.Store(&patterns)
	m.SetFocus("tab", []string{"hot"})
	var batches [][]message.NatsMessage
	m.OnBatch = func(_ any, _ string, msgs []message.NatsMessage) { batches = append(batches, msgs) }
	deliver := func(subject string, data []byte) {
		m.process(m.shardOf(subject), delivery{msg: &nats.Msg{Subject: subject, Data: data}, ps: patterns[0], seq: uint64(m.totalRecv.Add(1)), now: time.Now().UnixMilli()})
	}
	for i := 0; i < 3; i++ {
		deliver("hot.a", []byte(`{"i":1}`))
	}
	deliver("cold", []byte{0xff})
	if m.totalRecv.Load() != 4 || m.subjectCount.Load() != 2 || patterns[0].subjects.Load() != 2 {
		t.Fatalf("counters: recv %d subjects %d pattern subjects %d", m.totalRecv.Load(), m.subjectCount.Load(), patterns[0].subjects.Load())
	}
	m.flushBatches()
	if len(batches) != 1 || len(batches[0]) != 3 || batches[0][0].PayloadType != "json" || batches[0][2].Sequence != 3 {
		t.Fatalf("feed = %+v", batches)
	}
	// The tree learns about both subjects at the next tick.
	m.mu.Lock()
	m.syncTree(time.Now().UnixMilli())
	dirty := m.tree.refresh()
	m.mu.Unlock()
	if len(dirty) != 3 || m.tree.nodes["hot.a"].count != 3 || m.tree.nodes["hot"].total != 3 || m.tree.nodes["cold"].last.Kind() != "binary" {
		t.Fatalf("tree after sync: dirty %d, hot.a %+v", len(dirty), m.tree.nodes["hot.a"])
	}
}
