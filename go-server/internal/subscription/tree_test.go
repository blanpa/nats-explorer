package subscription

import (
	"nats-explorer/internal/message"
	"sort"
	"strings"
	"testing"
	"time"
)

func subjectsOf(entries []SubjectEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Subject)
	}
	sort.Strings(out)
	return out
}

// feed adds n messages to a subject the way the shard sync does at tick time.
// now < 0 marks messages older than the rate window: they count, no rate.
func feed(t *tree, subject string, n int, now int64) {
	nd := t.get(subject)
	count := nd.count + n
	rate := nd.rate
	if now >= 0 {
		rate += float64(n) / rateWindowSec
	}
	t.observe(subject, count, rate, &message.Record{Subject: subject, Data: []byte(`{"v":1}`), Timestamp: max(now, 0)})
}

func TestTreeAggregatesBottomUp(t *testing.T) {
	tr := newTree()
	now := time.Now().UnixMilli()
	feed(tr, "a.x.1", 5, now)
	feed(tr, "a.x.2", 1, -1) // outside the rate window
	feed(tr, "a", 7, now)
	feed(tr, "b.y", 2, now)
	if len(tr.nodes) != 6 {
		t.Fatalf("nodes = %d, want a, a.x, a.x.1, a.x.2, b, b.y", len(tr.nodes))
	}
	dirty := tr.refresh()
	if len(dirty) != 6 {
		t.Fatalf("every node is dirty on first refresh, got %d", len(dirty))
	}
	a := tr.nodes["a"]
	if a.count != 7 || a.total != 13 || a.rate != 0.7 || a.totalRate != 1.2 {
		t.Fatalf("a = count %d total %d rate %v totalRate %v", a.count, a.total, a.rate, a.totalRate)
	}
	if ax := tr.nodes["a.x"]; ax.count != 0 || ax.total != 6 || len(ax.children) != 2 {
		t.Fatalf("a.x = %+v", ax)
	}
	e := entryOf(a, true)
	if e.Children != 1 || e.Payload != `{"v":1}` || e.Total != 13 || e.TotalRate != 1.2 {
		t.Fatalf("entry a = %+v", e)
	}
	// a, a.x.1, a.x.2 have messages; a.x is only a branch.
	if e.Subjects != 3 {
		t.Fatalf("entry a: subjects = %d, want 3", e.Subjects)
	}
	if p := entryOf(a, false); p.Payload != "" || p.PayloadType != "json" || p.Total != 13 {
		t.Fatalf("without preview the payload goes, the rest stays: %+v", p)
	}
	tr.clearDirty()
	if d := tr.refresh(); len(d) != 0 {
		t.Fatalf("nothing changed, got %d dirty", len(d))
	}
	// A message on a leaf dirties the path to the root and nothing else.
	feed(tr, "a.x.1", 1, now)
	d := tr.refresh()
	if got := strings.Join(subjectsOfNodes(d), ","); got != "a,a.x,a.x.1" {
		t.Fatalf("dirty after one message = %s", got)
	}
	if a.total != 14 || tr.nodes["a.x"].total != 7 {
		t.Fatalf("totals not carried up: a %d a.x %d", a.total, tr.nodes["a.x"].total)
	}
}

func subjectsOfNodes(nodes []*node) []string {
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.subject)
	}
	sort.Strings(out)
	return out
}

func TestViewExpansionDeltas(t *testing.T) {
	tr := newTree()
	now := time.Now().UnixMilli()
	feed(tr, "a.x.1", 1, now)
	feed(tr, "a.y", 1, now)
	feed(tr, "b", 1, now)
	dirty := tr.refresh()

	v := newClientView()
	if v.update(tr, dirty) != nil {
		t.Fatal("no view yet: nothing may be sent")
	}
	v.set(View{}) // nothing expanded: roots only
	up := v.update(tr, dirty)
	if up == nil || !up.Full || strings.Join(subjectsOf(up.Entries), ",") != "a,b" {
		t.Fatalf("roots only, got %+v", up)
	}
	tr.clearDirty()

	// Expand a: its children appear, nothing is removed.
	v.set(View{Paths: []string{"a"}})
	up = v.update(tr, nil)
	if up == nil || strings.Join(subjectsOf(up.Entries), ",") != "a.x,a.y" || len(up.Removed) != 0 {
		t.Fatalf("expand a: %+v", up)
	}
	// A new leaf below the collapsed a.x is not sent, but a.x and a change.
	feed(tr, "a.x.2", 1, now)
	dirty = tr.refresh()
	up = v.update(tr, dirty)
	if up == nil || strings.Join(subjectsOf(up.Entries), ",") != "a,a.x" {
		t.Fatalf("delta under collapsed branch: %+v", up)
	}
	tr.clearDirty()
	// A new root appears with its own entry only.
	feed(tr, "c.deep.leaf", 1, now)
	dirty = tr.refresh()
	up = v.update(tr, dirty)
	if up == nil || strings.Join(subjectsOf(up.Entries), ",") != "c" {
		t.Fatalf("new root: %+v", up)
	}
	tr.clearDirty()

	// Collapse a again: the children leave.
	v.set(View{})
	up = v.update(tr, nil)
	if up == nil || len(up.Entries) != 0 || strings.Join(up.Removed, ",") != "a.x,a.y" {
		t.Fatalf("collapse a: %+v", up)
	}
	// Everything expanded except c.
	v.set(View{All: true, Paths: []string{"c"}})
	up = v.update(tr, nil)
	if up == nil || strings.Join(subjectsOf(up.Entries), ",") != "a.x,a.x.1,a.x.2,a.y" {
		t.Fatalf("expand all but c: %+v", up)
	}
	// A restart replaces everything the tab has, even when nothing changed.
	v.needFull = true
	up = v.update(tr, nil)
	if up == nil || !up.Full || len(up.Entries) != 7 || len(up.Removed) != 0 {
		t.Fatalf("after restart: %+v", up)
	}
	if v.update(tr, nil) != nil {
		t.Fatal("unchanged view without dirty nodes must send nothing")
	}
}

func TestViewFilter(t *testing.T) {
	tr := newTree()
	now := time.Now().UnixMilli()
	feed(tr, "plant.line1.temp", 1, now)
	feed(tr, "plant.line1.speed", 1, now)
	feed(tr, "plant.line2.temp", 1, now)
	feed(tr, "other", 1, now)
	tr.refresh()
	tr.clearDirty()

	v := newClientView()
	v.set(View{Filter: "Temp line1"})
	up := v.update(tr, nil)
	if up == nil || strings.Join(subjectsOf(up.Entries), ",") != "plant,plant.line1,plant.line1.temp" {
		t.Fatalf("filter: %+v", up)
	}
	// A new matching leaf brings its unsent ancestors along; a non-match is ignored.
	feed(tr, "plant.line1.sub.temp", 1, now)
	feed(tr, "plant.line3.speed", 1, now)
	dirty := tr.refresh()
	up = v.update(tr, dirty)
	if up == nil || strings.Join(subjectsOf(up.Entries), ",") != "plant,plant.line1,plant.line1.sub,plant.line1.sub.temp" {
		t.Fatalf("filter delta: %+v", up)
	}
	tr.clearDirty()
	// Clearing the filter falls back to expansion: roots only, the rest is removed.
	v.set(View{})
	up = v.update(tr, nil)
	if up == nil || strings.Join(subjectsOf(up.Entries), ",") != "other" || strings.Join(up.Removed, ",") != "plant.line1,plant.line1.sub,plant.line1.sub.temp,plant.line1.temp" {
		t.Fatalf("filter cleared: %+v", up)
	}
}

// Turning the previews off has to replace what the tab already has: a delta
// only carries changed nodes, so the rows already sent would keep payloads
// the tab no longer wants.
func TestViewNoPreviewResendsEverything(t *testing.T) {
	tr := newTree()
	now := time.Now().UnixMilli()
	feed(tr, "a.x.1", 3, now)
	feed(tr, "b.y", 2, now)
	dirty := tr.refresh()

	v := newClientView()
	v.set(View{All: true})
	up := v.update(tr, dirty)
	previews := 0
	for _, e := range up.Entries {
		if e.Payload != "" {
			previews++
		}
	}
	if previews != 2 {
		t.Fatalf("previews are on by default, got %d of %d entries: %+v", previews, len(up.Entries), up)
	}
	tr.clearDirty()

	v.set(View{All: true, NoPreview: true})
	up = v.update(tr, nil)
	if up == nil || !up.Full {
		t.Fatalf("switching previews off must resend the view: %+v", up)
	}
	for _, e := range up.Entries {
		if e.Payload != "" {
			t.Fatalf("%s still carries a payload", e.Subject)
		}
		if e.Subjects == 0 && e.Total > 0 {
			t.Fatalf("%s lost its subject count", e.Subject)
		}
	}

	// An unchanged flag is not a reason to send everything again.
	v.set(View{All: true, NoPreview: true})
	if up = v.update(tr, nil); up != nil && up.Full {
		t.Fatalf("same view resent in full: %+v", up)
	}
}

func TestEntryPreviewIsTruncatedAndBinaryOmitted(t *testing.T) {
	long := strings.Repeat("ä", PreviewMaxChars+50)
	e := entryOf(&node{last: &message.Record{Data: []byte(long)}}, true)
	if !strings.HasSuffix(e.Payload, "…") || len([]rune(e.Payload)) != PreviewMaxChars+1 {
		t.Errorf("preview not truncated at a rune boundary: %d runes", len([]rune(e.Payload)))
	}
	b := entryOf(&node{last: &message.Record{Data: []byte{0xff, 0xfe, 0x00}}}, true)
	if b.Payload != "" || b.PayloadType != "binary" || b.Size != 3 {
		t.Errorf("binary entry = %+v", b)
	}
}

func TestTreeIntervalGrowsWithTree(t *testing.T) {
	if treeInterval(10) != TreeUpdateInterval || treeInterval(5000) != time.Second || treeInterval(20000) != 2*time.Second {
		t.Fatal("unexpected tree intervals")
	}
}
