package handler

import (
	"reflect"
	"testing"
)

// A thousand deleted messages in a row are one hole, not a thousand of them:
// a list a reader can take in is the point of the answer.
func TestGapRanges(t *testing.T) {
	cases := []struct {
		name    string
		deleted []uint64
		want    []GapRange
	}{
		{"nothing missing", nil, []GapRange{}},
		{"one sequence", []uint64{1350}, []GapRange{{1350, 1350}}},
		{"a run", []uint64{10, 11, 12}, []GapRange{{10, 12}}},
		{"runs and singles", []uint64{3, 10, 11, 12, 20}, []GapRange{{3, 3}, {10, 12}, {20, 20}}},
		// The server does not promise an order, and a repeat is not a hole
		// of its own.
		{"unordered with a repeat", []uint64{12, 3, 11, 10, 10}, []GapRange{{3, 3}, {10, 12}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := gapRanges(c.deleted); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("gapRanges(%v) = %v, want %v", c.deleted, got, c.want)
			}
		})
	}
}

// The input is not modified: the caller's slice belongs to the caller.
func TestGapRangesLeavesTheInputAlone(t *testing.T) {
	in := []uint64{5, 1, 3}
	gapRanges(in)
	if !reflect.DeepEqual(in, []uint64{5, 1, 3}) {
		t.Fatalf("input was sorted underneath the caller: %v", in)
	}
}
