package main

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Clearing the history takes the tree with it. A row that says three
// thousand messages with nothing behind it is worse than an empty tree, and
// the persisted copy goes too -- otherwise the next connect restores the
// tree from disk and the clear looks like it did nothing.
func TestServerClearAllEmptiesTreeAndDisk(t *testing.T) {
	ns := startNATS(t)
	dbPath := filepath.Join(t.TempDir(), "history.db")
	cfg := serverConfig{historyDB: dbPath, historyRetention: time.Hour, historyManaged: true}
	srv := newTestServer(t, cfg)
	api := &apiClient{t: t, base: srv.URL}
	connect := map[string]interface{}{"id": "w1", "name": "W", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"wipe.>"}}
	api.do("POST", "/api/connect", connect, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	for i := 0; i < 12; i++ {
		nc.Publish(fmt.Sprintf("wipe.s%d", i%4), []byte(`{"v":1}`))
	}
	nc.Flush()

	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && subjectMetric(t, srv.URL, "w1") < 4 {
		time.Sleep(100 * time.Millisecond)
	}
	if got := subjectMetric(t, srv.URL, "w1"); got != 4 {
		t.Fatalf("subjects before the clear = %d, want 4", got)
	}
	// Let the writer put them on disk.
	time.Sleep(1500 * time.Millisecond)

	if code := api.do("DELETE", "/api/history", nil, nil); code != 200 {
		t.Fatalf("clear: %d", code)
	}

	// The tree is empty, not just the history.
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && subjectMetric(t, srv.URL, "w1") != 0 {
		time.Sleep(100 * time.Millisecond)
	}
	if got := subjectMetric(t, srv.URL, "w1"); got != 0 {
		t.Fatalf("subjects after the clear = %d, want 0", got)
	}
	var hist struct {
		Messages []struct{} `json:"messages"`
	}
	api.do("GET", "/api/history?connId=w1&subject=wipe.s0", nil, &hist)
	if len(hist.Messages) != 0 {
		t.Fatalf("memory history after the clear = %d messages", len(hist.Messages))
	}
	// And the disk is empty, so a time range finds nothing either.
	var rng struct {
		Messages []struct{} `json:"messages"`
	}
	from := time.Now().Add(-time.Hour).UnixMilli()
	api.do("GET", fmt.Sprintf("/api/history/range?connId=w1&subject=wipe&branch=1&from=%d", from), nil, &rng)
	if len(rng.Messages) != 0 {
		t.Fatalf("persistent history after the clear = %d messages", len(rng.Messages))
	}

	// What still sends comes back, so the connection is not broken by it.
	nc.Publish("wipe.s0", []byte(`{"v":2}`))
	nc.Flush()
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && subjectMetric(t, srv.URL, "w1") == 0 {
		time.Sleep(100 * time.Millisecond)
	}
	if got := subjectMetric(t, srv.URL, "w1"); got != 1 {
		t.Fatalf("subjects after one new message = %d, want 1", got)
	}
}
