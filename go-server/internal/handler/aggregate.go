package handler

import (
	"math"
	"net/http"
)

// How a chart reduces the samples inside one bucket. Downsampling always
// throws something away; which thing depends on the question. "What was the
// peak" and "what was it doing on average" and "how fast is this counter
// climbing" are three different questions about the same field, and a chart
// that can only answer the first is guessing which one was asked.

// Aggregation names the reduction applied per bucket.
type Aggregation string

const (
	// AggMinMax keeps both extremes of a bucket, so a spike between two
	// samples still shows. It is the default because it is the only one
	// that never hides an outlier.
	AggMinMax Aggregation = "minmax"
	AggAvg    Aggregation = "avg"
	AggMin    Aggregation = "min"
	AggMax    Aggregation = "max"
	AggSum    Aggregation = "sum"
	// AggCount is how many messages carried the field in the bucket, which
	// is about the traffic rather than the value.
	AggCount Aggregation = "count"
	// AggRate is the change per second between one bucket's last value and
	// the previous one's: what a monotonic counter (parts produced, kWh,
	// bytes) is actually doing. The raw value of such a field is a
	// staircase and says nothing.
	AggRate Aggregation = "rate"
)

// Aggregations are the ones offered, in the order the UI shows them.
var Aggregations = []Aggregation{AggMinMax, AggAvg, AggMin, AggMax, AggSum, AggCount, AggRate}

func validAggregation(a Aggregation) bool {
	for _, x := range Aggregations {
		if x == a {
			return true
		}
	}
	return false
}

// aggParam reads ?agg=, defaulting to minmax. An unknown one is an error
// rather than a silent fallback: a chart labelled "avg" that shows something
// else is worse than one that refuses.
func aggParam(r *http.Request) (Aggregation, bool) {
	raw := r.URL.Query().Get("agg")
	if raw == "" {
		return AggMinMax, true
	}
	a := Aggregation(raw)
	return a, validAggregation(a)
}

// aggregate reduces samples ([timestamp ms, value], time-ordered) to about
// `points` buckets. minmax yields up to two points per bucket, the rest one.
// With fewer samples than buckets every bucket holds a single sample, which
// needs no special case: the minimum, maximum, average and sum of one value
// are that value, and its count is one.
func aggregate(samples [][2]float64, points int, agg Aggregation) [][2]float64 {
	if samples == nil {
		return [][2]float64{}
	}
	if agg == AggRate {
		return rateOf(bucketLast(samples, points))
	}
	if points <= 0 {
		points = 1
	}
	out := make([][2]float64, 0, 2*points)
	for _, b := range buckets(samples, points) {
		out = append(out, reduce(b, agg)...)
	}
	return out
}

// buckets splits time-ordered samples into about n contiguous groups, never
// smaller than one sample.
func buckets(samples [][2]float64, n int) [][][2]float64 {
	size := float64(len(samples)) / float64(n)
	if size < 1 {
		size = 1
	}
	out := make([][][2]float64, 0, n)
	for b := 0; ; b++ {
		start := int(float64(b) * size)
		if start >= len(samples) {
			break
		}
		end := int(float64(b+1) * size)
		if end > len(samples) {
			end = len(samples)
		}
		if start >= end {
			continue
		}
		out = append(out, samples[start:end])
	}
	return out
}

// reduce turns one bucket into the points it contributes.
func reduce(bucket [][2]float64, agg Aggregation) [][2]float64 {
	lo, hi := 0, 0
	sum := 0.0
	for i, s := range bucket {
		if s[1] < bucket[lo][1] {
			lo = i
		}
		if s[1] > bucket[hi][1] {
			hi = i
		}
		sum += s[1]
	}
	switch agg {
	case AggMin:
		return [][2]float64{bucket[lo]}
	case AggMax:
		return [][2]float64{bucket[hi]}
	case AggSum:
		return [][2]float64{{bucket[len(bucket)-1][0], sum}}
	case AggCount:
		return [][2]float64{{bucket[len(bucket)-1][0], float64(len(bucket))}}
	case AggAvg:
		return [][2]float64{{bucket[len(bucket)-1][0], sum / float64(len(bucket))}}
	}
	// minmax: both extremes, in the order they occurred so the line does
	// not travel backwards in time.
	if lo == hi {
		return [][2]float64{bucket[lo]}
	}
	if lo < hi {
		return [][2]float64{bucket[lo], bucket[hi]}
	}
	return [][2]float64{bucket[hi], bucket[lo]}
}

// bucketLast reduces to one point per bucket, the newest in it. Rate is a
// difference between neighbours, so what matters is where each bucket ended.
func bucketLast(samples [][2]float64, points int) [][2]float64 {
	if points <= 0 || len(samples) <= points {
		return samples
	}
	out := make([][2]float64, 0, points)
	for _, b := range buckets(samples, points) {
		out = append(out, b[len(b)-1])
	}
	return out
}

// rateOf turns values into their change per second. A counter that resets
// (a restart, a wrap) would otherwise show one enormous negative spike that
// flattens everything else, so a decrease is reported as no change rather
// than as a negative rate.
func rateOf(points [][2]float64) [][2]float64 {
	if len(points) < 2 {
		return [][2]float64{}
	}
	out := make([][2]float64, 0, len(points)-1)
	for i := 1; i < len(points); i++ {
		dt := (points[i][0] - points[i-1][0]) / 1000
		if dt <= 0 {
			continue
		}
		dv := points[i][1] - points[i-1][1]
		if dv < 0 {
			dv = 0
		}
		v := dv / dt
		if math.IsInf(v, 0) || math.IsNaN(v) {
			continue
		}
		out = append(out, [2]float64{points[i][0], v})
	}
	return out
}
