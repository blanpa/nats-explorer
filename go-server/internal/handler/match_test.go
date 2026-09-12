package handler

import (
	"testing"

	"github.com/nats-io/nats.go/jetstream"
)

// Wildcards are where the debugging time goes, and the answer has to say
// which pattern did it -- "the stream takes it" is half an answer when the
// question is why a consumer one level too deep sees nothing.
func TestMatchingPatterns(t *testing.T) {
	patterns := []string{"orders.>", "orders.*.created", "shipping.>", "orders.eu.created"}
	got := matchingPatterns(patterns, "orders.eu.created")
	want := []string{"orders.>", "orders.*.created", "orders.eu.created"}
	if len(got) != len(want) {
		t.Fatalf("matched %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("matched %v, want %v", got, want)
		}
	}

	// One token is one token: `*` does not reach across a dot.
	if hit := matchingPatterns([]string{"orders.*"}, "orders.eu.created"); len(hit) != 0 {
		t.Fatalf("orders.* matched a two-token tail: %v", hit)
	}
	// And `>` reaches to the end but not to nothing.
	if hit := matchingPatterns([]string{"orders.>"}, "orders"); len(hit) != 0 {
		t.Fatalf("orders.> matched the bare parent: %v", hit)
	}
}

// A consumer states its filter in one of two ways, and no filter at all is a
// third answer: it takes everything the stream stores.
func TestConsumerFilters(t *testing.T) {
	if got := consumerFilters(jetstream.ConsumerConfig{FilterSubject: "orders.eu.>"}); len(got) != 1 || got[0] != "orders.eu.>" {
		t.Fatalf("single filter = %v", got)
	}
	multi := jetstream.ConsumerConfig{FilterSubjects: []string{"a.>", "b.>"}}
	if got := consumerFilters(multi); len(got) != 2 {
		t.Fatalf("several filters = %v", got)
	}
	// FilterSubjects wins where both are set; the server refuses both anyway.
	both := jetstream.ConsumerConfig{FilterSubject: "old.>", FilterSubjects: []string{"new.>"}}
	if got := consumerFilters(both); len(got) != 1 || got[0] != "new.>" {
		t.Fatalf("both set = %v", got)
	}
	if got := consumerFilters(jetstream.ConsumerConfig{}); got != nil {
		t.Fatalf("no filter = %v, want nil: it takes everything", got)
	}
}
