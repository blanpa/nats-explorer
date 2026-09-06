package subscription

import (
	"strings"
	"testing"
	"time"
)

func TestCollectEntriesDeltaAndRate(t *testing.T) {
	m := NewManager("c1")
	now := time.Now().UnixMilli()
	m.stats["b.y"] = &SubjectStats{MessageCount: 2, Timestamps: []int64{now - 500, now - 200}}
	m.stats["a.x.1"] = &SubjectStats{MessageCount: 5, Timestamps: []int64{now - 20_000}}
	m.stats["a"] = &SubjectStats{MessageCount: 7, LastMessage: &NatsMessage{Payload: `{"v":1}`, PayloadType: "json", Timestamp: now, Size: 7}}

	full := m.collectEntries(true)
	if len(full) != 3 {
		t.Fatalf("full snapshot = %d entries, want 3", len(full))
	}
	byS := map[string]SubjectEntry{}
	for _, e := range full {
		byS[e.Subject] = e
	}
	if e := byS["a"]; e.Count != 7 || e.Payload != `{"v":1}` || e.PayloadType != "json" || e.Size != 7 || e.Timestamp != now {
		t.Errorf("entry a = %+v", e)
	}
	if byS["a.x.1"].Rate != 0 {
		t.Errorf("stale timestamps must not count towards the rate, got %v", byS["a.x.1"].Rate)
	}
	if len(m.stats["a.x.1"].Timestamps) != 0 {
		t.Errorf("stale timestamps should be pruned, got %v", m.stats["a.x.1"].Timestamps)
	}
	if byS["b.y"].Rate != 0.2 {
		t.Errorf("b.y rate = %v, want 0.2", byS["b.y"].Rate)
	}

	// Nothing changed: the delta is empty.
	if d := m.collectEntries(false); len(d) != 0 {
		t.Fatalf("unchanged tree produced delta %+v", d)
	}
	// One more message on a: only a is reported.
	m.stats["a"].MessageCount++
	d := m.collectEntries(false)
	if len(d) != 1 || d[0].Subject != "a" || d[0].Count != 8 {
		t.Fatalf("delta = %+v", d)
	}
}

func TestEntryPreviewIsTruncatedAndBinaryOmitted(t *testing.T) {
	long := strings.Repeat("ä", PreviewMaxChars+50)
	e := entryOf("s", &SubjectStats{LastMessage: &NatsMessage{Payload: long, PayloadType: "string"}}, 0)
	if !strings.HasSuffix(e.Payload, "…") || len([]rune(e.Payload)) != PreviewMaxChars+1 {
		t.Errorf("preview not truncated at a rune boundary: %d runes", len([]rune(e.Payload)))
	}
	b := entryOf("b", &SubjectStats{LastMessage: &NatsMessage{Payload: "AAAA", PayloadType: "binary", Size: 3}}, 0)
	if b.Payload != "" || b.PayloadType != "binary" || b.Size != 3 {
		t.Errorf("binary entry = %+v", b)
	}
}

func TestTreeIntervalGrowsWithTree(t *testing.T) {
	if treeInterval(10) != TreeUpdateInterval || treeInterval(5000) != time.Second || treeInterval(20000) != 2*time.Second {
		t.Fatal("unexpected tree intervals")
	}
}
