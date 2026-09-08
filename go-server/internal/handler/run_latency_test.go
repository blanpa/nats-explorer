package handler

import "testing"

func TestHistogramBuckets(t *testing.T) {
	// sorted latencies in ms, two of them beyond the last bound
	sorted := []float64{0.2, 0.5, 0.7, 1.0, 3.0, 3.0, 60, 900, 5000, 9000}
	h := histogram(sorted)
	total := 0
	for _, b := range h {
		total += b.Count
	}
	if total != len(sorted) {
		t.Fatalf("histogram counts %d of %d latencies", total, len(sorted))
	}
	if h[0].Le != 0.5 || h[0].Count != 2 {
		t.Errorf("first bucket = %+v, want 2 at or below 0.5 ms", h[0])
	}
	if last := h[len(h)-1]; last.Le != 0 || last.Count != 2 {
		t.Errorf("overflow bucket = %+v, want 2 above the last bound", last)
	}
	// A bucket that nothing falls into still exists, so the bars keep their scale.
	if len(h) != len(latencyBounds)+1 {
		t.Fatalf("got %d buckets, want %d", len(h), len(latencyBounds)+1)
	}
	if empty := histogram(nil); len(empty) != len(latencyBounds) {
		t.Fatalf("empty input = %d buckets", len(empty))
	}
}

func TestPercentileEdges(t *testing.T) {
	sorted := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	if got := percentile(sorted, 0.5); got != 5 {
		t.Errorf("p50 = %v", got)
	}
	// Nearest rank, rounded down: with ten samples p99 is the ninth.
	if got := percentile(sorted, 0.99); got != 9 {
		t.Errorf("p99 = %v", got)
	}
	if got := percentile(sorted, 1); got != 10 {
		t.Errorf("p100 = %v", got)
	}
	if got := percentile(nil, 0.5); got != 0 {
		t.Errorf("empty = %v", got)
	}
}
