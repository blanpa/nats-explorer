package main

import (
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
)

// A CEL expression narrows the subject tree to the subjects whose last
// message satisfies it, and the same expression filters the history
// endpoints.
func TestServerPayloadFilter(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "T", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"f.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	// Two sensors, one hot and one cold, plus a text payload that no
	// expression about numbers may match.
	for i := 0; i < 5; i++ {
		nc.Publish("f.hot.temp", []byte(fmt.Sprintf(`{"temp": %d, "unit": "C"}`, 80+i)))
		nc.Publish("f.cold.temp", []byte(fmt.Sprintf(`{"temp": %d, "unit": "C"}`, 10+i)))
		nc.Publish("f.note", []byte("just text"))
	}
	nc.Flush()

	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	readEvent(t, ws, "connections")

	// Without an expression every subject is in the tree.
	ws.WriteJSON(map[string]interface{}{"type": "view", "all": true})
	seen := map[string]bool{}
	deadline := time.Now().Add(5 * time.Second)
	for !seen["f.cold.temp"] && time.Now().Before(deadline) {
		ev := readEvent(t, ws, "subject-tree")
		for _, e := range asEntries(ev["data"]) {
			seen[e] = true
		}
	}
	if !seen["f.hot.temp"] || !seen["f.note"] {
		t.Fatalf("unfiltered tree = %v", seen)
	}

	// With the expression only the hot sensor stays; the others are removed.
	ws.WriteJSON(map[string]interface{}{"type": "view", "all": true, "expr": "payload.temp > 50"})
	if ev := readEvent(t, ws, "filter-error"); ev["error"] != "" {
		t.Fatalf("valid expression reported %v", ev["error"])
	}
	removed := map[string]bool{}
	kept := map[string]bool{}
	deadline = time.Now().Add(5 * time.Second)
	for !removed["f.cold.temp"] && time.Now().Before(deadline) {
		ev := readEvent(t, ws, "subject-tree")
		for _, r := range asStrings(ev["removed"]) {
			removed[r] = true
		}
		for _, e := range asEntries(ev["data"]) {
			kept[e] = true
			delete(removed, e)
		}
	}
	if !removed["f.note"] {
		t.Errorf("a text payload must not match a number expression: removed = %v", removed)
	}
	if removed["f.hot.temp"] {
		t.Errorf("the matching subject must stay: removed = %v", removed)
	}

	// A broken expression is reported instead of silently emptying the tree.
	ws.WriteJSON(map[string]interface{}{"type": "view", "all": true, "expr": "payload.temp >"})
	if ev := readEvent(t, ws, "filter-error"); ev["error"] == "" {
		t.Fatal("broken expression must report an error")
	}

	// The history endpoints take the same expression.
	q := func(path string, params map[string]string) string {
		v := url.Values{}
		for k, val := range params {
			v.Set(k, val)
		}
		return path + "?" + v.Encode()
	}
	var hist struct {
		Messages []struct{ Payload string } `json:"messages"`
		Branch   []struct{ Subject string } `json:"branch"`
	}
	api.do("GET", q("/api/history", map[string]string{"subject": "f.hot.temp", "expr": "payload.temp >= 82"}), nil, &hist)
	if len(hist.Messages) != 3 {
		t.Fatalf("filtered history = %d messages, want 3: %+v", len(hist.Messages), hist.Messages)
	}
	api.do("GET", q("/api/history", map[string]string{"subject": "f", "branchLimit": "50", "expr": `subject.endsWith(".temp") && payload.temp < 20`}), nil, &hist)
	if len(hist.Branch) != 5 {
		t.Fatalf("filtered branch = %d messages, want 5", len(hist.Branch))
	}
	for _, m := range hist.Branch {
		if m.Subject != "f.cold.temp" {
			t.Fatalf("branch filter let %s through", m.Subject)
		}
	}

	var search struct {
		Messages []struct{ Subject string } `json:"messages"`
	}
	api.do("GET", q("/api/history/search", map[string]string{"subject": "f", "q": "unit", "expr": "payload.temp > 80"}), nil, &search)
	if len(search.Messages) != 4 {
		t.Fatalf("search with expression = %d, want 4", len(search.Messages))
	}

	var series struct {
		Samples int `json:"samples"`
	}
	api.do("GET", q("/api/history/series", map[string]string{"subject": "f.hot.temp", "field": "temp", "expr": "payload.temp > 81"}), nil, &series)
	if series.Samples != 3 {
		t.Fatalf("series with expression = %d samples, want 3", series.Samples)
	}

	// An invalid expression is a client error, not an empty result.
	if st := api.do("GET", q("/api/history", map[string]string{"subject": "f.hot.temp", "expr": "payload.temp >"}), nil, nil); st != 400 {
		t.Fatalf("broken expression = %d, want 400", st)
	}
}

func asStrings(v interface{}) []string {
	list, _ := v.([]interface{})
	out := make([]string, 0, len(list))
	for _, e := range list {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func asEntries(v interface{}) []string {
	list, _ := v.([]interface{})
	out := make([]string, 0, len(list))
	for _, e := range list {
		if m, ok := e.(map[string]interface{}); ok {
			if s, ok := m["s"].(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
