package main

import (
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Clearing the history of one subject leaves every other subject alone, and
// with branch=1 it takes what sits below it. The persisted copy goes too, so
// a time range does not bring the messages back.
func TestServerClearSubjectHistory(t *testing.T) {
	ns := startNATS(t)
	dbPath := filepath.Join(t.TempDir(), "history.db")
	srv := newTestServer(t, serverConfig{historyDB: dbPath, historyRetention: time.Hour})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "C", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"c.>"},
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
	publish("c.keep", 3)
	publish("c.gone", 4)
	publish("c.gone.below", 2)
	time.Sleep(1500 * time.Millisecond) // let the writer flush to the database

	count := func(subject string) int {
		var resp struct {
			Messages []struct{} `json:"messages"`
		}
		api.do("GET", "/api/history?subject="+subject+"&connId=c1", nil, &resp)
		return len(resp.Messages)
	}
	if count("c.keep") != 3 || count("c.gone") != 4 || count("c.gone.below") != 2 {
		t.Fatalf("before: keep=%d gone=%d below=%d", count("c.keep"), count("c.gone"), count("c.gone.below"))
	}

	// One subject only: what is below it stays.
	var res struct {
		Cleared int `json:"cleared"`
	}
	if st := api.do("DELETE", "/api/history?subject=c.gone&connId=c1", nil, &res); st != 200 {
		t.Fatalf("clear one: %d", st)
	}
	if res.Cleared != 1 {
		t.Errorf("cleared = %d, want 1", res.Cleared)
	}
	if count("c.gone") != 0 {
		t.Errorf("the subject still has %d messages", count("c.gone"))
	}
	if count("c.gone.below") != 2 || count("c.keep") != 3 {
		t.Errorf("clearing one subject touched others: below=%d keep=%d", count("c.gone.below"), count("c.keep"))
	}

	// The whole branch.
	publish("c.gone", 2)
	time.Sleep(400 * time.Millisecond)
	if st := api.do("DELETE", "/api/history?subject=c.gone&branch=1&connId=c1", nil, &res); st != 200 {
		t.Fatalf("clear branch: %d", st)
	}
	if count("c.gone") != 0 || count("c.gone.below") != 0 {
		t.Errorf("branch clear left messages: %d / %d", count("c.gone"), count("c.gone.below"))
	}
	if count("c.keep") != 3 {
		t.Errorf("the branch clear took an unrelated subject: %d", count("c.keep"))
	}

	// The persisted copy is gone as well: a range finds nothing.
	now := time.Now().UnixMilli()
	var ranged struct {
		Messages []struct{} `json:"messages"`
	}
	api.do("GET", fmt.Sprintf("/api/history/range?subject=c.gone&branch=1&from=%d&to=%d&connId=c1", now-3600_000, now+60_000), nil, &ranged)
	if len(ranged.Messages) != 0 {
		t.Errorf("the database still holds %d messages of the cleared branch", len(ranged.Messages))
	}
	api.do("GET", fmt.Sprintf("/api/history/range?subject=c.keep&from=%d&to=%d&connId=c1", now-3600_000, now+60_000), nil, &ranged)
	if len(ranged.Messages) != 3 {
		t.Errorf("the database lost the subject that was kept: %d", len(ranged.Messages))
	}

	// The subject is out of the counters until it sends again. /metrics is
	// the readable place for them; the browser gets the same number pushed.
	res2, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res2.Body)
	res2.Body.Close()
	if !strings.Contains(string(body), `nats_explorer_subjects{conn="c1",name="C"} 1`) {
		for _, line := range strings.Split(string(body), "\n") {
			if strings.HasPrefix(line, "nats_explorer_subjects{") {
				t.Errorf("subject count after clearing: %s, want 1", line)
			}
		}
	}
	publish("c.gone", 1)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && count("c.gone") == 0 {
		time.Sleep(100 * time.Millisecond)
	}
	if count("c.gone") != 1 {
		t.Errorf("a cleared subject must record again, got %d", count("c.gone"))
	}
}
