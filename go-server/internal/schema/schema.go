// Package schema derives the structure of a subject's JSON payloads from
// its recorded messages: which fields exist, their types, how often they
// appear, their ranges, and whether the newer messages look different from
// the older ones (drift). Nobody has to maintain a schema; devices and
// gateways that change their output are caught by comparing halves.
package schema

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"nats-explorer/internal/message"
)

const (
	// MaxDepth bounds nesting; deeper levels are counted as their container type only.
	MaxDepth = 6
	// MaxFields bounds the number of distinct paths reported.
	MaxFields = 200
	// maxExample is the length of an example value.
	maxExample = 80
	// enumMax is the most distinct strings a field may have to count as an enumeration.
	enumMax = 8
	// enumMinSamples is the fewest samples needed before an enumeration is reported.
	enumMinSamples = 10
	// driftPresence is the presence a field needs in one half to count as established there.
	driftPresence = 0.8
	// driftMinSamples is the fewest JSON messages a half needs before the
	// halves are compared at all. Below that a single message that happens
	// to omit an optional field reads as a vanished field.
	driftMinSamples = 5
)

// TypeCount is how often a path had a given JSON type.
type TypeCount struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

// Field is one path of the payloads.
type Field struct {
	Path     string      `json:"path"`
	Types    []TypeCount `json:"types"`
	Presence float64     `json:"presence"`
	Example  string      `json:"example"`
	Min      *float64    `json:"min,omitempty"`
	Max      *float64    `json:"max,omitempty"`
	Enum     []string    `json:"enum,omitempty"`
	// Format names the shape of a string field when every sample had it:
	// "date-time" for RFC 3339 timestamps. It is the one shape worth
	// naming -- a timestamp is what a consumer of the schema most often
	// wants typed, and every JSON Schema tool knows the keyword.
	Format string `json:"format,omitempty"`
}

// Drift is a difference between the older and the newer half of the samples.
type Drift struct {
	Path string `json:"path"`
	// "type-changed", "field-gone" or "field-new"
	Kind   string `json:"kind"`
	Before string `json:"before"`
	After  string `json:"after"`
	// Since is the timestamp of the first message of the newer half.
	Since int64 `json:"since"`
}

// Schema is the result of Infer.
type Schema struct {
	// Samples is the number of messages looked at, JSON or not.
	Samples int `json:"samples"`
	// Kinds counts the payload kinds: json, string, binary.
	Kinds  map[string]int `json:"kinds"`
	Fields []Field        `json:"fields"`
	Drift  []Drift        `json:"drift"`
	// Truncated: the payloads have more paths than MaxFields, so the field
	// list is a beginning, not the whole shape. Saying nothing here would
	// let a 300-field payload read as a 200-field one.
	Truncated bool  `json:"truncated,omitempty"`
	From      int64 `json:"from"`
	To        int64 `json:"to"`
}

// stat accumulates one path across samples.
type stat struct {
	types    map[string]int
	present  int
	example  string
	min, max float64
	hasNum   bool
	strings  map[string]struct{}
	tooMany  bool
	strCount int
	// dates counts the strings that are RFC 3339 timestamps.
	dates int
	// first is the order the path was met in, so the report keeps document order.
	first int
}

func newStat(first int) *stat {
	return &stat{types: map[string]int{}, strings: map[string]struct{}{}, first: first}
}

// Infer builds the schema of the messages. Order does not matter; the
// halves for drift are split by timestamp.
func Infer(msgs []message.NatsMessage) Schema {
	s := Schema{Samples: len(msgs), Kinds: map[string]int{}, Fields: []Field{}, Drift: []Drift{}}
	if len(msgs) == 0 {
		return s
	}
	sorted := make([]message.NatsMessage, len(msgs))
	copy(sorted, msgs)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Timestamp < sorted[j].Timestamp })
	s.From, s.To = sorted[0].Timestamp, sorted[len(sorted)-1].Timestamp

	all := newCollector()
	older := newCollector()
	newer := newCollector()
	half := len(sorted) / 2
	for i, m := range sorted {
		kind := m.PayloadType
		if kind == "" {
			kind = "string"
		}
		s.Kinds[kind]++
		if kind != "json" {
			continue
		}
		doc, err := decode([]byte(m.Payload))
		if err != nil {
			s.Kinds["json"]--
			s.Kinds["string"]++
			continue
		}
		all.add(doc)
		if len(sorted) >= 2 {
			if i < half {
				older.add(doc)
			} else {
				newer.add(doc)
			}
		}
	}
	s.Fields = all.fields()
	s.Truncated = all.dropped
	if len(sorted) >= 2 && older.samples > 0 && newer.samples > 0 {
		s.Drift = drift(older, newer, sorted[half].Timestamp)
	}
	return s
}

// collector walks documents and keeps one stat per path.
type collector struct {
	paths   map[string]*stat
	order   int
	samples int
	// dropped: a path was met after the budget was spent.
	dropped bool
}

func newCollector() *collector {
	return &collector{paths: map[string]*stat{}}
}

func (c *collector) add(doc any) {
	c.samples++
	seen := map[string]bool{}
	c.walk("", doc, 0, seen)
}

func (c *collector) stat(path string) *stat {
	st, ok := c.paths[path]
	if !ok {
		if len(c.paths) >= MaxFields {
			c.dropped = true
			return nil
		}
		st = newStat(c.order)
		c.order++
		c.paths[path] = st
	}
	return st
}

// walk records the value at path and descends into objects and arrays.
// The root object itself is not a field; its members are.
func (c *collector) walk(path string, v any, depth int, seen map[string]bool) {
	WalkDoc(path, v, depth, func(p string, val any) bool {
		st := c.stat(p)
		if st == nil {
			// The field budget is spent; deeper paths of this branch add nothing.
			return false
		}
		if !seen[p] {
			seen[p] = true
			st.present++
		}
		st.observe(val)
		return true
	})
}

// WalkDoc visits every path of a document in the same shape the reported
// fields use (`a.b`, `xs[]`, `xs[].n`), members in name order. Validation
// walks documents the same way the inference did, so the two can never
// disagree about what a path is called. Returning false from visit skips the
// subtree below that path.
func WalkDoc(path string, v any, depth int, visit func(path string, v any) bool) {
	if path != "" && !visit(path, v) {
		return
	}
	if depth >= MaxDepth {
		return
	}
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			p := k
			if path != "" {
				p = path + "." + k
			}
			WalkDoc(p, x[k], depth+1, visit)
		}
	case []any:
		for _, item := range x {
			WalkDoc(path+"[]", item, depth+1, visit)
		}
	}
}

// decode parses a payload keeping every number as it was written. JSON has
// one number type, but `21` and `21.0` are not the same statement about a
// field, and float64 forgets which of the two was sent -- along with the
// last digits of anything above 2^53, which is where message and sequence
// ids live.
func decode(payload []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	// A decoder reads one value and stops; anything after it means the
	// payload was never one document.
	if dec.More() {
		return nil, errTrailing
	}
	return doc, nil
}

var errTrailing = errors.New("trailing data after the JSON value")

// intLiteral is a number written without a fraction or an exponent. `21.0`
// is a float that happens to be whole right now; reading it as an integer is
// how a derived schema ends up rejecting the first 21.5.
var intLiteral = regexp.MustCompile(`^-?[0-9]+$`)

// numeric is the value of a number, whichever way the document was decoded.
func numeric(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

func typeOf(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return "bool"
	case json.Number:
		if intLiteral.MatchString(x.String()) {
			return "integer"
		}
		return "number"
	case float64:
		// Documents that never went through decode carry plain float64s;
		// there the value is all that is left to go by.
		if x == math.Trunc(x) && math.Abs(x) < 1e15 {
			return "integer"
		}
		return "number"
	case string:
		return "string"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	default:
		return "unknown"
	}
}

func (st *stat) observe(v any) {
	t := typeOf(v)
	st.types[t]++
	if st.example == "" {
		st.example = example(v)
	}
	if f, ok := numeric(v); ok {
		if !st.hasNum || f < st.min {
			st.min = f
		}
		if !st.hasNum || f > st.max {
			st.max = f
		}
		st.hasNum = true
	}
	if s, ok := v.(string); ok {
		st.strCount++
		if _, err := time.Parse(time.RFC3339, s); err == nil {
			st.dates++
		}
		if !st.tooMany {
			st.strings[s] = struct{}{}
			if len(st.strings) > enumMax {
				st.tooMany = true
				st.strings = nil
			}
		}
	}
}

func example(v any) string {
	var s string
	switch x := v.(type) {
	case string:
		s = strconv.Quote(x)
	case map[string]any, []any:
		b, _ := json.Marshal(x)
		s = string(b)
	default:
		b, _ := json.Marshal(x)
		s = string(b)
	}
	if len(s) > maxExample {
		// Cut on a rune, not on a byte: half of an umlaut is not a
		// character, and an example is shown as text.
		cut := maxExample - 1
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
}

// dominant is the most frequent type of a stat. A null stands for "no value
// yet", not for a type of its own, so it only wins when nothing else was
// ever seen; otherwise a field that is null half the time would read as a
// type change the moment the ratio tips.
func (st *stat) dominant() string {
	best, n := "", -1
	for t, c := range st.types {
		if t == "null" {
			continue
		}
		if c > n || (c == n && t < best) {
			best, n = t, c
		}
	}
	if best == "" && st.types["null"] > 0 {
		return "null"
	}
	return best
}

// comparable maps a dominant type to the name the halves are compared by:
// 21 and 21.5 are the same field, not a type change.
func comparable(t string) string {
	if t == "integer" {
		return "number"
	}
	return t
}

func (c *collector) fields() []Field {
	out := make([]Field, 0, len(c.paths))
	for path, st := range c.paths {
		f := Field{Path: path, Presence: float64(st.present) / float64(max(1, c.samples)), Example: st.example}
		for t, n := range numbersMerged(st.types) {
			f.Types = append(f.Types, TypeCount{Type: t, Count: n})
		}
		sort.Slice(f.Types, func(i, j int) bool {
			if f.Types[i].Count != f.Types[j].Count {
				return f.Types[i].Count > f.Types[j].Count
			}
			return f.Types[i].Type < f.Types[j].Type
		})
		if st.hasNum {
			mn, mx := st.min, st.max
			f.Min, f.Max = &mn, &mx
		}
		if st.strCount > 0 && st.dates == st.strCount {
			f.Format = "date-time"
		}
		if !st.tooMany && st.strCount >= enumMinSamples && len(st.strings) > 0 && len(st.strings) <= enumMax {
			for v := range st.strings {
				f.Enum = append(f.Enum, v)
			}
			sort.Strings(f.Enum)
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return c.paths[out[i].Path].first < c.paths[out[j].Path].first })
	return out
}

// numbersMerged folds integers into numbers once a field has been seen with
// both: a field that carries 21 in one message and 21.5 in the next is a
// number field, not a field with two types. Integers keep standing on their
// own as long as nothing else was ever sent.
func numbersMerged(types map[string]int) map[string]int {
	if types["integer"] == 0 || types["number"] == 0 {
		return types
	}
	out := make(map[string]int, len(types))
	for t, n := range types {
		out[t] = n
	}
	out["number"] += out["integer"]
	delete(out, "integer")
	return out
}

func presence(c *collector, path string) float64 {
	st, ok := c.paths[path]
	if !ok {
		return 0
	}
	return float64(st.present) / float64(max(1, c.samples))
}

// drift compares the halves: dominant type changes, established fields
// that vanished, and new fields that are now established. A field that is
// optional in both halves (present in some messages, missing in others) is
// not a change; only a field that was established and is now entirely gone.
func drift(older, newer *collector, since int64) []Drift {
	out := []Drift{}
	// Too few messages say nothing about a trend.
	if older.samples < driftMinSamples || newer.samples < driftMinSamples {
		return out
	}
	paths := map[string]bool{}
	for p := range older.paths {
		paths[p] = true
	}
	for p := range newer.paths {
		paths[p] = true
	}
	sorted := make([]string, 0, len(paths))
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	for _, p := range sorted {
		before, after := presence(older, p), presence(newer, p)
		switch {
		case before >= driftPresence && after == 0:
			out = append(out, Drift{Path: p, Kind: "field-gone", Before: older.paths[p].dominant(), After: "", Since: since})
		case before == 0 && after >= driftPresence:
			out = append(out, Drift{Path: p, Kind: "field-new", Before: "", After: newer.paths[p].dominant(), Since: since})
		case before > 0 && after > 0:
			// Both halves carry the field: only its type can have changed. A
			// half that only ever saw null says nothing about the type, so a
			// field that starts carrying values is not a change.
			bt, at := older.paths[p].dominant(), newer.paths[p].dominant()
			if bt == "null" || at == "null" {
				continue
			}
			if comparable(bt) != comparable(at) {
				out = append(out, Drift{Path: p, Kind: "type-changed", Before: bt, After: at, Since: since})
			}
		}
	}
	return out
}
