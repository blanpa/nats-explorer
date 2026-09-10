package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// The wildcard is the one subscription nobody can afford on a busy cluster,
// and it used to be the only one that could not be removed: every layer put
// it back, so the button did nothing. A connection that listens to nothing
// is a real thing to want -- publishing, JetStream and KV need no feed.
func TestServerRemoveEverySubscription(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "u1", "name": "U", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{">"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()

	subjectsOf := func() []string {
		var list []struct {
			ID            string   `json:"id"`
			Subscriptions []string `json:"subscriptions"`
		}
		api.do("GET", "/api/connections", nil, &list)
		for _, c := range list {
			if c.ID == "u1" {
				return c.Subscriptions
			}
		}
		t.Fatal("connection u1 is gone")
		return nil
	}

	// It starts on the firehose and collects something.
	for i := 0; i < 3; i++ {
		nc.Publish("u.before", []byte(fmt.Sprintf(`{"n":%d}`, i)))
	}
	nc.Flush()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var page struct {
			Messages []struct{} `json:"messages"`
		}
		api.do("GET", "/api/history?connId=u1&subject=u.before&limit=10", nil, &page)
		if len(page.Messages) == 3 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Remove every pattern.
	api.do("PUT", "/api/connections/u1/subscriptions", map[string]interface{}{"subscriptions": []string{}}, nil)
	if got := subjectsOf(); len(got) != 0 {
		t.Fatalf("subscriptions = %v after removing them all, want none", got)
	}

	// Nothing arrives any more.
	for i := 0; i < 5; i++ {
		nc.Publish("u.after", []byte(`{"n":1}`))
	}
	nc.Flush()
	time.Sleep(400 * time.Millisecond)
	var after struct {
		Messages []struct{} `json:"messages"`
	}
	api.do("GET", "/api/history?connId=u1&subject=u.after&limit=10", nil, &after)
	if len(after.Messages) != 0 {
		t.Fatalf("%d messages arrived with no subscription", len(after.Messages))
	}

	// And a pattern can be added again afterwards.
	api.do("PUT", "/api/connections/u1/subscriptions", map[string]interface{}{"subscriptions": []string{"u.later.>"}}, nil)
	if got := subjectsOf(); len(got) != 1 || got[0] != "u.later.>" {
		t.Fatalf("subscriptions = %v, want the one that was added", got)
	}
	nc.Publish("u.later.x", []byte(`{"n":9}`))
	nc.Flush()
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var page struct {
			Messages []struct{} `json:"messages"`
		}
		api.do("GET", "/api/history?connId=u1&subject=u.later.x&limit=10", nil, &page)
		if len(page.Messages) == 1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("nothing arrived through the pattern added after unsubscribing")
}
