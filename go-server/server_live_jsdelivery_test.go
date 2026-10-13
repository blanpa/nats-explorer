package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Reading a stream through a consumer must not show up as live traffic: the
// consumer's deliveries carry the stored subject, and a wildcard subscription
// that also matches the consumer's inbox would count them again.
func TestServerStreamReadIsNotLiveTraffic(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "C", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{">"},
	}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	defer api.do("POST", "/api/disconnect-all", nil, nil)
	q := "?connId=c1"
	if st := api.do("POST", "/api/streams"+q, map[string]interface{}{"name": "O", "subjects": []string{"o.>"}}, nil); st != 200 {
		t.Fatalf("create stream: %d", st)
	}

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	for i := 0; i < 3; i++ {
		nc.Publish("o.paid", []byte(fmt.Sprintf(`{"n":%d}`, i)))
		nc.Publish("o.created", []byte(fmt.Sprintf(`{"n":%d}`, i)))
	}
	nc.Flush()

	count := func() int {
		var resp struct {
			Messages []struct{} `json:"messages"`
		}
		api.do("GET", "/api/history?subject=o.paid&connId=c1", nil, &resp)
		return len(resp.Messages)
	}
	deadline := time.Now().Add(3 * time.Second)
	for count() < 3 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if n := count(); n != 3 {
		t.Fatalf("live before the read = %d, want 3", n)
	}

	// The subject filter reads through an ordered consumer.
	if st := api.do("GET", "/api/streams/O/messages"+q+"&startSeq=1&limit=10&subject=o.paid", nil, nil); st != 200 {
		t.Fatalf("read stream: %d", st)
	}
	time.Sleep(500 * time.Millisecond)
	if n := count(); n != 3 {
		t.Fatalf("live after the read = %d, want 3: the stream read was recorded as traffic", n)
	}
}
