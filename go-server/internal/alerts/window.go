package alerts

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The conditions a plant asks for that a single message cannot answer: too
// few messages in the last minute, an average over five minutes past a
// threshold, a value that has not moved for ten minutes. They need a little
// memory per subject, and this file is that memory: a ring of buckets that
// costs the same whether the subject sends once an hour or a thousand times
// a second.

// winBuckets is how many buckets a window is cut into. Sixty keeps the
// memory per subject and rule at a few kilobytes for an hour-long window,
// and a sixtieth of the window is as fine as a threshold over it needs.
const winBuckets = 60

// MaxWindow bounds the window a rule may ask for, in seconds.
const MaxWindow = 24 * 3600

type bucket struct {
	// start is the bucket's time, in units of the bucket size; a bucket
	// whose start is not the current one is stale and starts over.
	start int64
	count int64
	// the numeric field, where the rule names one
	n        int64
	sum      float64
	min, max float64
}

// window is the sliding window of one subject under one rule.
type window struct {
	// size is the width of a bucket in milliseconds.
	size int64
	b    [winBuckets]bucket
}

func newWindow(seconds int) *window {
	size := int64(seconds) * 1000 / winBuckets
	if size < 1 {
		size = 1
	}
	return &window{size: size}
}

func (w *window) at(now int64) *bucket {
	slot := now / w.size
	b := &w.b[slot%winBuckets]
	if b.start != slot {
		*b = bucket{start: slot}
	}
	return b
}

// add counts a message, and its value when the rule names a field.
func (w *window) add(now int64, value float64, hasValue bool) {
	b := w.at(now)
	b.count++
	if hasValue {
		if b.n == 0 || value < b.min {
			b.min = value
		}
		if b.n == 0 || value > b.max {
			b.max = value
		}
		b.sum += value
		b.n++
	}
}

// totals sums the buckets that fall inside the window ending now.
func (w *window) totals(now, windowMs int64) (count, n int64, sum, min, max float64) {
	from := (now - windowMs) / w.size
	slot := now / w.size
	for i := range w.b {
		b := &w.b[i]
		if b.start < from || b.start > slot || (b.count == 0 && b.n == 0) {
			continue
		}
		count += b.count
		if b.n > 0 {
			if n == 0 || b.min < min {
				min = b.min
			}
			if n == 0 || b.max > max {
				max = b.max
			}
			sum += b.sum
			n += b.n
		}
	}
	return count, n, sum, min, max
}

// fieldAt walks a dotted path through a parsed payload: object keys, and
// array indexes where the token is a number. The second answer says whether
// the path led anywhere; a field that is not there is not a zero.
func fieldAt(payload any, path string) (any, bool) {
	cur := payload
	for _, tok := range strings.Split(path, ".") {
		switch v := cur.(type) {
		case map[string]any:
			next, ok := v[tok]
			if !ok {
				return nil, false
			}
			cur = next
		case []any:
			i, err := strconv.Atoi(tok)
			if err != nil || i < 0 || i >= len(v) {
				return nil, false
			}
			cur = v[i]
		default:
			return nil, false
		}
	}
	return cur, true
}

// numberOf reads a field as a number, which is what an aggregate needs.
func numberOf(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case int64:
		return float64(n), true
	case int:
		return float64(n), true
	case uint64:
		return float64(n), true
	}
	return 0, false
}

// valueText is how a field reads in a preview and compares for "unchanged":
// numbers as written, strings as they are, the rest as JSON would show it.
func valueText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case nil:
		return "null"
	}
	return fmt.Sprint(v)
}

// formatNumber writes a threshold or a result the way someone would type it.
func formatNumber(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', 2, 64)
}

// formatSeconds reads a window back: "45 s", "5 min", "2 h".
func formatSeconds(s int) string {
	switch {
	case s >= 3600 && s%3600 == 0:
		return fmt.Sprintf("%d h", s/3600)
	case s >= 120 && s%60 == 0:
		return fmt.Sprintf("%d min", s/60)
	default:
		return fmt.Sprintf("%d s", s)
	}
}

// hasWindow says whether the rule has anything to count over a window.
func (r *Rule) hasWindow() bool {
	return r.Window > 0 && (r.MinCount != nil || r.MaxCount != nil || r.hasAggregate())
}

func (r *Rule) hasAggregate() bool {
	return r.Field != "" && (r.Above != nil || r.Below != nil)
}

// needsField says whether the hot path has to read the field from the payload.
func (r *Rule) needsField() bool {
	return r.Field != "" && (r.hasAggregate() || r.UnchangedFor > 0)
}

// rateVerdict evaluates the count conditions; the preview says what was
// counted and against what.
func (r *Rule) rateVerdict(count int64) (bool, string) {
	in := fmt.Sprintf("%d messages in %s", count, formatSeconds(r.Window))
	if count == 1 {
		in = fmt.Sprintf("1 message in %s", formatSeconds(r.Window))
	}
	if r.MinCount != nil && count < int64(*r.MinCount) {
		return true, fmt.Sprintf("%s, fewer than %d", in, *r.MinCount)
	}
	if r.MaxCount != nil && count > int64(*r.MaxCount) {
		return true, fmt.Sprintf("%s, more than %d", in, *r.MaxCount)
	}
	return false, in
}

// levelVerdict evaluates the aggregate; without a value in the window there
// is nothing to judge, and the answer is "no".
func (r *Rule) levelVerdict(n int64, sum, min, max float64) (bool, string) {
	if n == 0 {
		return false, ""
	}
	var v float64
	switch r.Agg {
	case "min":
		v = min
	case "max":
		v = max
	default:
		v = sum / float64(n)
	}
	in := fmt.Sprintf("%s %s %s over %s", r.Agg, r.Field, formatNumber(v), formatSeconds(r.Window))
	if r.Above != nil && v > *r.Above {
		return true, fmt.Sprintf("%s, above %s", in, formatNumber(*r.Above))
	}
	if r.Below != nil && v < *r.Below {
		return true, fmt.Sprintf("%s, below %s", in, formatNumber(*r.Below))
	}
	return false, in
}
