package subscription

import (
	"testing"
	"time"
)

func TestBuildTreeHierarchyAndSorting(t *testing.T) {
	now := time.Now().UnixMilli()
	stats := map[string]*SubjectStats{
		"b.y":   {MessageCount: 2, Timestamps: []int64{now - 500, now - 200}},
		"a.x.1": {MessageCount: 5, Timestamps: []int64{now - 20_000}},
		"a.x.2": {MessageCount: 1},
		"a":     {MessageCount: 7, LastMessage: &NatsMessage{Subject: "a", Payload: "root"}},
	}

	tree := BuildTree(stats)
	if len(tree) != 2 || tree[0].Segment != "a" || tree[1].Segment != "b" {
		t.Fatalf("root segments = %+v", segs(tree))
	}

	a := tree[0]
	if a.MessageCount != 7 || a.LastMessage == nil || a.LastMessage.Payload != "root" {
		t.Errorf("node 'a' should carry its own count and last message, got %+v", a)
	}
	if len(a.Children) != 1 || a.Children[0].Segment != "x" || a.Children[0].FullSubject != "a.x" {
		t.Fatalf("children of a = %+v", segs(a.Children))
	}
	x := a.Children[0]
	if x.MessageCount != 0 {
		t.Errorf("intermediate node must not carry a count, got %d", x.MessageCount)
	}
	if got := segs(x.Children); len(got) != 2 || got[0] != "1" || got[1] != "2" {
		t.Errorf("children of a.x = %v", got)
	}
	if x.Children[0].FullSubject != "a.x.1" {
		t.Errorf("full subject = %q", x.Children[0].FullSubject)
	}

	// Rate: only timestamps inside the 10 s window count.
	if x.Children[0].Rate != 0 {
		t.Errorf("stale timestamps must not count towards the rate, got %v", x.Children[0].Rate)
	}
	if got := tree[1].Children[0].Rate; got != 0.2 {
		t.Errorf("b.y rate = %v, want 0.2", got)
	}
}

func TestBuildTreeEmpty(t *testing.T) {
	if got := BuildTree(map[string]*SubjectStats{}); len(got) != 0 {
		t.Fatalf("expected empty tree, got %d nodes", len(got))
	}
}

func TestBuildTreeLeafChildrenNeverNil(t *testing.T) {
	tree := BuildTree(map[string]*SubjectStats{"only": {MessageCount: 1}})
	if tree[0].Children == nil {
		t.Fatal("children must be an empty slice so JSON renders [] not null")
	}
}

func segs(nodes []SubjectNode) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.Segment
	}
	return out
}
