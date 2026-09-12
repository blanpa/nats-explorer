package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Changing the subscriptions must not cost what was already collected --
// neither by the patterns that stayed nor by the one that went. What a
// connection received is a fact; unsubscribing only stops the next message.
func TestServerSubscriptionChangeKeepsHistory(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "R", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"keep.>", "drop.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	publish := func(subject string, n int) {
		for i := 0; i < n; i++ {
			nc.Publish(subject, []byte(fmt.Sprintf(`{"n":%d}`, i)))
		}
		nc.Flush()
	}
	publish("keep.one", 4)
	publish("drop.two", 3)
	time.Sleep(400 * time.Millisecond)

	count := func(subject string) int {
		var resp struct {
			Messages []struct{} `json:"messages"`
		}
		api.do("GET", "/api/history?subject="+subject+"&connId=c1", nil, &resp)
		return len(resp.Messages)
	}
	if count("keep.one") != 4 || count("drop.two") != 3 {
		t.Fatalf("before the change: keep=%d drop=%d", count("keep.one"), count("drop.two"))
	}

	// Adding a pattern keeps everything that was recorded.
	if st := api.do("PUT", "/api/connections/c1/subscriptions", map[string]interface{}{
		"subscriptions": []string{"keep.>", "drop.>", "extra.>"},
	}, nil); st != 200 {
		t.Fatalf("adding a pattern: %d", st)
	}
	time.Sleep(300 * time.Millisecond)
	if got := count("keep.one"); got != 4 {
		t.Fatalf("adding a pattern dropped the history of keep.one: %d messages left", got)
	}
	if got := count("drop.two"); got != 3 {
		t.Fatalf("adding a pattern dropped the history of drop.two: %d messages left", got)
	}

	// The new pattern receives, and the old ones keep receiving.
	publish("extra.three", 2)
	publish("keep.one", 1)
	time.Sleep(400 * time.Millisecond)
	if got := count("extra.three"); got != 2 {
		t.Fatalf("the added pattern does not receive: %d", got)
	}
	if got := count("keep.one"); got != 5 {
		t.Fatalf("an untouched pattern stopped receiving: %d", got)
	}

	// Removing a pattern stops the feed and keeps the record.
	if st := api.do("PUT", "/api/connections/c1/subscriptions", map[string]interface{}{
		"subscriptions": []string{"keep.>", "extra.>"},
	}, nil); st != 200 {
		t.Fatalf("removing a pattern: %d", st)
	}
	time.Sleep(300 * time.Millisecond)
	before := count("drop.two")
	if before != 3 {
		t.Errorf("unsubscribing threw away what drop.two had collected: %d of 3 left", before)
	}
	if got := count("keep.one"); got != 5 {
		t.Errorf("removing a pattern cost keep.one: %d messages left", got)
	}
	if got := count("extra.three"); got != 2 {
		t.Errorf("removing a pattern cost extra.three: %d messages left", got)
	}
	// New messages on the removed pattern do not arrive; the old ones stay.
	publish("drop.two", 2)
	time.Sleep(400 * time.Millisecond)
	if got := count("drop.two"); got != before {
		t.Errorf("drop.two = %d messages after unsubscribing, want the %d it already had", got, before)
	}

	// The counters of the connection reflect what is left.
	var stats struct {
		Subjects int `json:"subjects"`
		Patterns []struct {
			Pattern  string `json:"pattern"`
			Received int    `json:"received"`
		} `json:"patterns"`
	}
	api.do("GET", "/api/status?connId=c1", nil, &stats)
	if len(stats.Patterns) > 0 {
		for _, p := range stats.Patterns {
			if p.Pattern == "keep.>" && p.Received < 5 {
				t.Errorf("a pattern that stayed lost its counter: %+v", p)
			}
		}
	}
}
