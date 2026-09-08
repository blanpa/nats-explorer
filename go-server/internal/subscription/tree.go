package subscription

import (
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"nats-explorer/internal/filter"
	"nats-explorer/internal/message"
)

const (
	// PreviewMaxChars bounds the payload preview carried by the tree feed. A
	// tree row renders at most 80 characters; the preview is the largest part
	// of every entry, so it stays close to that.
	PreviewMaxChars = 100
)

// SubjectEntry is the wire form of one tree node. The server keeps the
// hierarchy and its aggregates; the browser only receives the nodes that are
// visible in its view (expanded branches, or the paths of filter matches)
// and merges them across connections. Keys are short on purpose: with tens
// of thousands of subjects the feed is the largest thing on the socket.
type SubjectEntry struct {
	Subject string `json:"s"`
	// Messages on exactly this subject and its rate.
	Count int     `json:"n"`
	Rate  float64 `json:"r"`
	// Messages and rate of the whole subtree, including the node itself.
	Total     int     `json:"t"`
	TotalRate float64 `json:"tr"`
	// Number of children; tells the browser to draw a chevron on a
	// collapsed branch whose children it has not received.
	Children int `json:"c,omitempty"`
	// Preview of the most recent payload, cut to PreviewMaxChars. Binary
	// payloads carry no preview, only the type.
	Payload     string `json:"p,omitempty"`
	PayloadType string `json:"pt,omitempty"`
	Timestamp   int64  `json:"ts,omitempty"`
	Size        int    `json:"sz,omitempty"`
}

// TreeUpdate is one tree message for one browser tab.
type TreeUpdate struct {
	// Full replaces everything the browser knows about the connection.
	Full bool
	// Entries are nodes that appeared or changed in the tab's view.
	Entries []SubjectEntry
	// Removed are subjects that left the view (collapsed or filtered out).
	Removed []string
}

// node is one subject or branch in the server-side tree.
type node struct {
	subject  string
	depth    int
	parent   *node
	children map[string]*node
	// own messages, rate and last message, copied from the shard at tick time
	count int
	rate  float64
	last  *message.Record
	// subtree aggregates
	total     int
	totalRate float64
	dirty     bool
}

// tree holds the hierarchy of one connection. Callers hold the manager lock.
type tree struct {
	roots map[string]*node
	nodes map[string]*node
	dirty []*node
}

func newTree() *tree {
	return &tree{roots: make(map[string]*node), nodes: make(map[string]*node)}
}

// get returns the node for subject, creating it and its ancestors.
func (t *tree) get(subject string) *node {
	if n := t.nodes[subject]; n != nil {
		return n
	}
	var parent *node
	level := t.roots
	start := 0
	for i := 0; i <= len(subject); i++ {
		if i < len(subject) && subject[i] != '.' {
			continue
		}
		full := subject[:i]
		n := t.nodes[full]
		if n == nil {
			n = &node{subject: full, parent: parent, children: make(map[string]*node)}
			if parent != nil {
				n.depth = parent.depth + 1
			}
			t.nodes[full] = n
			level[subject[start:i]] = n
			t.markDirty(n)
		}
		parent = n
		level = n.children
		start = i + 1
	}
	return parent
}

// remove deletes a node and the ancestors it leaves empty. Used when a
// subject is no longer covered by any subscription.
func (t *tree) remove(subject string) {
	n := t.nodes[subject]
	if n == nil {
		return
	}
	// Its own numbers go; a branch with children stays as a branch.
	n.count, n.rate, n.last = 0, 0, nil
	for cur := n; cur != nil; {
		if len(cur.children) > 0 || cur.count > 0 {
			t.markDirty(cur)
			return
		}
		parent := cur.parent
		delete(t.nodes, cur.subject)
		if parent != nil {
			delete(parent.children, lastSegment(cur.subject))
		} else {
			delete(t.roots, cur.subject)
		}
		cur = parent
	}
}

func lastSegment(subject string) string {
	for i := len(subject) - 1; i >= 0; i-- {
		if subject[i] == '.' {
			return subject[i+1:]
		}
	}
	return subject
}

// markDirty flags a node and its ancestors for the next tick.
func (t *tree) markDirty(n *node) {
	for ; n != nil && !n.dirty; n = n.parent {
		n.dirty = true
		t.dirty = append(t.dirty, n)
	}
}

// observe records a subject's current numbers, creating its node and
// marking the path to the root.
func (t *tree) observe(subject string, count int, rate float64, last *message.Record) {
	n := t.get(subject)
	n.count = count
	n.rate = rate
	n.last = last
	t.markDirty(n)
}

// refresh recomputes the subtree aggregates of dirty nodes and returns
// them. Callers clear the dirty flags afterwards.
func (t *tree) refresh() []*node {
	// Deepest first, so every child's aggregate is fresh when its parent sums.
	sort.Slice(t.dirty, func(i, j int) bool { return t.dirty[i].depth > t.dirty[j].depth })
	for _, n := range t.dirty {
		n.total = n.count
		n.totalRate = n.rate
		for _, c := range n.children {
			n.total += c.total
			n.totalRate += c.totalRate
		}
	}
	return t.dirty
}

func (t *tree) clearDirty() {
	for _, n := range t.dirty {
		n.dirty = false
	}
	t.dirty = t.dirty[:0]
}

func entryOf(n *node) SubjectEntry {
	e := SubjectEntry{Subject: n.subject, Count: n.count, Rate: n.rate, Total: n.total, TotalRate: n.totalRate, Children: len(n.children)}
	if lm := n.last; lm != nil {
		e.PayloadType = lm.Kind()
		e.Timestamp = lm.Timestamp
		e.Size = len(lm.Data)
		if e.PayloadType != "binary" {
			e.Payload = truncateRunes(string(lm.Data), PreviewMaxChars)
		}
	}
	return e
}

// View is what a browser tab shows of the tree: which branches are open, or
// a filter that shows the paths of every matching subject regardless of
// expansion.
type View struct {
	// All expands every branch; Paths then lists the collapsed exceptions.
	// Otherwise Paths lists the expanded branches.
	All   bool     `json:"all"`
	Paths []string `json:"paths"`
	// Filter terms, all of which a subject must contain (case-insensitive).
	Filter string `json:"filter"`
	// Expr is a CEL expression evaluated against the last message of a
	// subject; only subjects whose last message satisfies it stay visible.
	Expr string `json:"expr"`
}

// clientView is a View plus what has been sent to the tab, to build deltas.
type clientView struct {
	all   bool
	paths map[string]struct{}
	terms []string
	// prg is the compiled Expr; exprErr holds a compile error for the tab.
	prg     *filter.Program
	exprErr string
	sent    map[string]struct{}
	dirty   bool // view changed since the last emit
	loaded  bool // a view was received at all
	// needFull: the next update replaces everything the tab has for this
	// connection. Set for a new tab and whenever the manager restarts.
	needFull bool
}

func newClientView() *clientView {
	return &clientView{paths: make(map[string]struct{}), sent: make(map[string]struct{}), needFull: true}
}

func (v *clientView) set(view View) {
	v.all = view.All
	v.paths = make(map[string]struct{}, len(view.Paths))
	for _, p := range view.Paths {
		v.paths[p] = struct{}{}
	}
	v.terms = nil
	for _, t := range strings.Fields(strings.ToLower(view.Filter)) {
		v.terms = append(v.terms, t)
	}
	v.prg, v.exprErr = nil, ""
	if expr := strings.TrimSpace(view.Expr); expr != "" {
		prg, err := filter.Compile(expr)
		if err != nil {
			v.exprErr = err.Error()
		} else {
			v.prg = prg
		}
	}
	v.dirty = true
	v.loaded = true
}

// filtering reports whether anything narrows the tree, which switches the
// view from expansion to match mode.
func (v *clientView) filtering() bool {
	return len(v.terms) > 0 || v.prg != nil
}

// matchesNode adds the payload expression to the subject terms. A branch
// without messages of its own is judged by its descendants, which the
// callers walk anyway.
func (v *clientView) matchesNode(n *node) bool {
	if !v.matches(n.subject) {
		return false
	}
	if v.prg == nil {
		return true
	}
	return n.last != nil && v.prg.Match(n.last)
}

func (v *clientView) expanded(subject string) bool {
	_, ok := v.paths[subject]
	if v.all {
		return !ok
	}
	return ok
}

func (v *clientView) matches(subject string) bool {
	s := strings.ToLower(subject)
	for _, t := range v.terms {
		if !strings.Contains(s, t) {
			return false
		}
	}
	return true
}

// visibleByExpansion reports whether every ancestor of n is expanded.
func (v *clientView) visibleByExpansion(n *node) bool {
	for p := n.parent; p != nil; p = p.parent {
		if !v.expanded(p.subject) {
			return false
		}
	}
	return true
}

// collect computes the complete visible set for the view. In filter mode a
// node is visible when it matches (which its descendants then do too, since
// they contain its subject), or when something below it matches. Without a
// filter the roots and the children of expanded, visible branches are shown.
func (v *clientView) collect(t *tree) map[string]struct{} {
	out := make(map[string]struct{})
	if v.filtering() {
		var walk func(n *node, above bool) bool
		walk = func(n *node, above bool) bool {
			// With a payload expression every node is judged on its own: a
			// matching branch does not make its children match.
			self := (above && v.prg == nil) || v.matchesNode(n)
			below := false
			for _, c := range n.children {
				if walk(c, self) {
					below = true
				}
			}
			if self || below {
				out[n.subject] = struct{}{}
			}
			return self || below
		}
		for _, r := range t.roots {
			walk(r, false)
		}
		return out
	}
	var walk func(n *node)
	walk = func(n *node) {
		out[n.subject] = struct{}{}
		if v.expanded(n.subject) {
			for _, c := range n.children {
				walk(c)
			}
		}
	}
	for _, r := range t.roots {
		walk(r)
	}
	return out
}

// visible decides for one node under an unchanged view. Only newly created
// or changed nodes are asked, so a node that is not yet sent needs its
// ancestors sent along; the caller handles that.
func (v *clientView) visible(n *node) bool {
	if v.prg != nil {
		// The last message decides, and it changes with every tick.
		return v.matchesNode(n)
	}
	if len(v.terms) > 0 {
		// A new node without children is visible iff it matches; a branch
		// that is already sent stays visible. A new branch appears only with
		// its first leaf, which is checked on its own.
		if _, ok := v.sent[n.subject]; ok {
			return true
		}
		return v.matches(n.subject)
	}
	return v.visibleByExpansion(n)
}

// update produces the tree message for one tab: on a view change the
// difference between the old and the new visible set, otherwise the dirty
// nodes that are visible. Returns nil when there is nothing to send.
func (v *clientView) update(t *tree, dirty []*node) *TreeUpdate {
	if !v.loaded {
		return nil
	}
	full := v.needFull
	v.needFull = false
	if full {
		v.sent = make(map[string]struct{})
	}
	if v.dirty || full {
		v.dirty = false
		want := v.collect(t)
		up := &TreeUpdate{Full: full}
		for s := range v.sent {
			if _, ok := want[s]; !ok {
				up.Removed = append(up.Removed, s)
			}
		}
		for s := range want {
			if _, ok := v.sent[s]; ok && !full {
				continue
			}
			up.Entries = append(up.Entries, entryOf(t.nodes[s]))
		}
		// Changed nodes that stay visible are part of the delta too.
		for _, n := range dirty {
			if _, was := v.sent[n.subject]; was {
				if _, still := want[n.subject]; still {
					up.Entries = append(up.Entries, entryOf(n))
				}
			}
		}
		v.sent = want
		sort.Strings(up.Removed)
		if !full && len(up.Entries) == 0 && len(up.Removed) == 0 {
			return nil
		}
		return up
	}
	var entries []SubjectEntry
	done := make(map[*node]struct{})
	emit := func(n *node) {
		if _, ok := done[n]; ok {
			return
		}
		done[n] = struct{}{}
		v.sent[n.subject] = struct{}{}
		entries = append(entries, entryOf(n))
	}
	for _, n := range dirty {
		if !v.visible(n) {
			continue
		}
		// Make sure the browser can place the node: send unsent ancestors.
		for p := n.parent; p != nil; p = p.parent {
			if _, ok := v.sent[p.subject]; ok {
				break
			}
			emit(p)
		}
		emit(n)
	}
	if len(entries) == 0 {
		return nil
	}
	return &TreeUpdate{Entries: entries}
}

// treeInterval slows the tree feed down as the tree grows so a huge subject
// space does not saturate the socket and the browser's main thread.
func treeInterval(subjects int) time.Duration {
	switch {
	case subjects > 10_000:
		return 2 * time.Second
	case subjects > 2_000:
		return time.Second
	default:
		return TreeUpdateInterval
	}
}

func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i] + "…"
		}
		n++
	}
	return s
}
