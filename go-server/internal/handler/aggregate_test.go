package handler

import (
	"math"
	"net/http/httptest"
	"reflect"
	"testing"
)

// Four samples a second apart, so every bucket boundary is easy to name.
func samples(vs ...float64) [][2]float64 {
	out := make([][2]float64, len(vs))
	for i, v := range vs {
		out[i] = [2]float64{float64(1000 + i*1000), v}
	}
	return out
}

func values(points [][2]float64) []float64 {
	out := make([]float64, len(points))
	for i, p := range points {
		out[i] = p[1]
	}
	return out
}

// Each aggregation answers a different question about the same bucket, and
// the answers must not be interchangeable: two buckets of {1,9} and {6,4}.
// The second one falls, so it also pins the order minmax emits -- the line
// must not travel backwards in time.
func TestAggregatePerBucket(t *testing.T) {
	in := samples(1, 9, 6, 4)
	cases := []struct {
		agg  Aggregation
		want []float64
	}{
		// minmax keeps both extremes in the order they occurred.
		{AggMinMax, []float64{1, 9, 6, 4}},
		{AggAvg, []float64{5, 5}},
		{AggMin, []float64{1, 4}},
		{AggMax, []float64{9, 6}},
		{AggSum, []float64{10, 10}},
		{AggCount, []float64{2, 2}},
	}
	for _, c := range cases {
		got := values(aggregate(in, 2, c.agg))
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s = %v, want %v", c.agg, got, c.want)
		}
	}
}

// Fewer samples than buckets needs no special case: every bucket holds one
// sample, and the count of one sample is one, not the sample's value.
func TestAggregateFewerSamplesThanBuckets(t *testing.T) {
	in := samples(7, 8)
	if got := values(aggregate(in, 100, AggCount)); !reflect.DeepEqual(got, []float64{1, 1}) {
		t.Errorf("count = %v, want [1 1]", got)
	}
	if got := values(aggregate(in, 100, AggAvg)); !reflect.DeepEqual(got, []float64{7, 8}) {
		t.Errorf("avg = %v, want [7 8]", got)
	}
	if got := values(aggregate(in, 100, AggMinMax)); !reflect.DeepEqual(got, []float64{7, 8}) {
		t.Errorf("minmax = %v, want [7 8]", got)
	}
}

// A counter's own value is a staircase; its rate is what it is doing. One
// second apart, so the numbers are the differences themselves.
func TestAggregateRate(t *testing.T) {
	in := samples(100, 110, 130, 130)
	got := values(aggregate(in, 100, AggRate))
	if !reflect.DeepEqual(got, []float64{10, 20, 0}) {
		t.Fatalf("rate = %v, want [10 20 0]", got)
	}
	// A reset would otherwise be one enormous negative spike that flattens
	// everything before it; it reads as no change instead.
	if got := values(aggregate(samples(500, 4), 100, AggRate)); !reflect.DeepEqual(got, []float64{0}) {
		t.Fatalf("rate over a reset = %v, want [0]", got)
	}
	// Nothing to difference.
	if got := aggregate(samples(1), 100, AggRate); len(got) != 0 {
		t.Fatalf("rate of one sample = %v, want none", got)
	}
}

// Rate is a difference, so it is taken after bucketing rather than per
// bucket: 400 samples over 400 seconds climbing by one each second is one
// per second, whatever the number of buckets asked for.
func TestAggregateRateIsPerSecondNotPerBucket(t *testing.T) {
	vs := make([]float64, 400)
	for i := range vs {
		vs[i] = float64(i)
	}
	for _, points := range []int{400, 40, 4} {
		got := values(aggregate(samples(vs...), points, AggRate))
		if len(got) == 0 {
			t.Fatalf("points=%d gave nothing", points)
		}
		for _, v := range got {
			if math.Abs(v-1) > 1e-9 {
				t.Fatalf("points=%d: rate %v, want 1 per second regardless of bucketing", points, v)
			}
		}
	}
}

func TestAggregateEmpty(t *testing.T) {
	for _, agg := range Aggregations {
		if got := aggregate(nil, 10, agg); got == nil || len(got) != 0 {
			t.Errorf("%s of nothing = %v, want an empty slice (a nil marshals as null)", agg, got)
		}
	}
}

// An unknown aggregation is refused rather than quietly replaced: a chart
// labelled "avg" showing something else is worse than one that errors.
func TestAggParam(t *testing.T) {
	if a, ok := aggParam(httptest.NewRequest("GET", "/?x=1", nil)); !ok || a != AggMinMax {
		t.Errorf("no agg = %q %v, want minmax", a, ok)
	}
	for _, agg := range Aggregations {
		if a, ok := aggParam(httptest.NewRequest("GET", "/?agg="+string(agg), nil)); !ok || a != agg {
			t.Errorf("agg=%s = %q %v", agg, a, ok)
		}
	}
	if _, ok := aggParam(httptest.NewRequest("GET", "/?agg=median", nil)); ok {
		t.Error("agg=median was accepted")
	}
}
