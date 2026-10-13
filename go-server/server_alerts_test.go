package main

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"nats-explorer/internal/alerts"
	"nats-explorer/internal/settings"
)

// Rules survive a restart through the settings store, fire on a matching
// payload, reach the browser over the websocket and resolve again.
func TestServerAlerts(t *testing.T) {
	ns := startNATS(t)
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, serverConfig{settings: store})
	api := &apiClient{t: t, base: srv.URL}

	if st := api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "C1", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"al.>"},
	}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	rule := alerts.Rule{ID: "r1", Name: "Too hot", Pattern: "al.*.temp", Expr: "payload.temp > 30", Severity: "critical", Enabled: true}
	if st := api.do("PUT", "/api/alerts/rules/r1", rule, nil); st != 200 {
		t.Fatalf("put rule: %d", st)
	}
	var listed struct {
		Rules []alerts.Rule `json:"rules"`
	}
	api.do("GET", "/api/alerts/rules", nil, &listed)
	if len(listed.Rules) != 1 || listed.Rules[0].Name != "Too hot" || !listed.Rules[0].Enabled {
		t.Fatalf("rules = %+v", listed.Rules)
	}

	// A rule with a broken expression is refused before it can fire.
	if st := api.do("PUT", "/api/alerts/rules/bad", alerts.Rule{ID: "bad", Name: "Bad", Pattern: "al.>", Expr: "payload.temp >", Enabled: true}, nil); st != 400 {
		t.Fatalf("broken expression accepted: %d", st)
	}

	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	readEvent(t, ws, "connections")

	// A payload over the threshold fires the alert on that subject.
	if st := api.do("POST", "/api/publish?connId=c1", map[string]interface{}{"subject": "al.line1.temp", "payload": `{"temp": 42}`}, nil); st != 200 {
		t.Fatalf("publish: %d", st)
	}
	ev := waitForAlert(t, ws, "firing")
	if ev["subject"] != "al.line1.temp" || ev["ruleName"] != "Too hot" || ev["severity"] != "critical" {
		t.Fatalf("firing alert = %v", ev)
	}

	// The REST view agrees with the event.
	var active struct {
		Active []alerts.Alert `json:"active"`
	}
	api.do("GET", "/api/alerts", nil, &active)
	if len(active.Active) != 1 || active.Active[0].State != alerts.StateFiring {
		t.Fatalf("active = %+v", active.Active)
	}

	// Seen: it stays, marked, until it resolves; the mark can be taken back.
	if st := api.do("POST", "/api/alerts/ack", map[string]interface{}{"key": active.Active[0].Key}, &active); st != 200 {
		t.Fatalf("ack: %d", st)
	}
	if len(active.Active) != 1 || active.Active[0].AckedAt == 0 {
		t.Fatalf("acked = %+v", active.Active)
	}
	// A fresh variable: decoding into the old slice would keep the fields
	// the answer leaves out, and an ack time of zero is left out.
	var unacked struct {
		Active []alerts.Alert `json:"active"`
	}
	if st := api.do("POST", "/api/alerts/ack", map[string]interface{}{"key": active.Active[0].Key, "acked": false}, &unacked); st != 200 || unacked.Active[0].AckedAt != 0 {
		t.Fatalf("unack: %d %+v", st, unacked.Active)
	}
	if st := api.do("POST", "/api/alerts/ack", map[string]interface{}{"key": "nope"}, nil); st != 404 {
		t.Fatalf("ack of nothing: %d", st)
	}

	// Testing the rule against the recorded history finds the same message.
	var test struct {
		Sampled int `json:"sampled"`
		Matched int `json:"matched"`
	}
	if st := api.do("POST", "/api/alerts/rules/r1/test", rule, &test); st != 200 || test.Matched != 1 || test.Sampled < 1 {
		t.Fatalf("rule test: %d %+v", st, test)
	}
	// Nothing matching is an empty list, not null: the dialog reads its length.
	var none map[string]json.RawMessage
	nothing := map[string]interface{}{"name": "none", "pattern": "nowhere.>", "expr": "true", "severity": "warning"}
	if st := api.do("POST", "/api/alerts/rules/r2/test", nothing, &none); st != 200 || string(none["matches"]) != "[]" {
		t.Fatalf("rule test without matches: %d matches=%s", st, none["matches"])
	}

	// A payload below the threshold resolves it. The engine evaluates a
	// subject at most once a second, so the second message has to wait.
	time.Sleep(1100 * time.Millisecond)
	if st := api.do("POST", "/api/publish?connId=c1", map[string]interface{}{"subject": "al.line1.temp", "payload": `{"temp": 5}`}, nil); st != 200 {
		t.Fatalf("publish: %d", st)
	}
	waitForAlert(t, ws, "resolved")
	api.do("GET", "/api/alerts", nil, &active)
	if len(active.Active) != 0 {
		t.Fatalf("still active after resolve: %+v", active.Active)
	}

	var events struct {
		Events []alerts.Event `json:"events"`
	}
	api.do("GET", "/api/alerts/events?limit=10", nil, &events)
	if len(events.Events) < 2 || events.Events[0].State != alerts.StateResolved {
		t.Fatalf("events = %+v", events.Events)
	}

	// The rules were written through to the settings file.
	entries, err := store.All()
	if err != nil {
		t.Fatal(err)
	}
	var saved []alerts.Rule
	if err := json.Unmarshal(entries[alertsKey], &saved); err != nil || len(saved) != 1 || saved[0].ID != "r1" {
		t.Fatalf("saved rules = %s (%v)", entries[alertsKey], err)
	}

	if st := api.do("DELETE", "/api/alerts/rules/r1", nil, nil); st != 204 {
		t.Fatalf("delete rule: %d", st)
	}
	api.do("GET", "/api/alerts/rules", nil, &listed)
	if len(listed.Rules) != 0 {
		t.Fatalf("rules after delete = %+v", listed.Rules)
	}
	if st := api.do("DELETE", "/api/alerts/rules/r1", nil, nil); st != 404 {
		t.Fatalf("deleting twice: %d", st)
	}
}

// waitForAlert reads until an alerts event reports a change into the state.
// Other frames (stats, tree) travel on the same socket and are skipped.
func waitForAlert(t *testing.T, ws *websocket.Conn, state string) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		ws.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, data, err := ws.ReadMessage()
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			t.Fatalf("waiting for a %s alert: %v", state, err)
		}
		var ev map[string]interface{}
		if json.Unmarshal(data, &ev) != nil || ev["type"] != "alerts" {
			continue
		}
		list, _ := ev["events"].([]interface{})
		for _, e := range list {
			if em, ok := e.(map[string]interface{}); ok && em["state"] == state {
				return em
			}
		}
	}
	t.Fatalf("no alert in state %s within deadline", state)
	return nil
}

// Maintenance windows are stored with the settings and mute what they
// cover: the alert is active and logged, but says so, and the toast-raising
// event carries the same flag.
func TestServerAlertMaintenance(t *testing.T) {
	ns := startNATS(t)
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, serverConfig{settings: store})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "C1", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"mw.>"},
	}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	now := time.Now().UnixMilli()
	windows := []alerts.Maintenance{{ID: "m1", Name: "line 1 rebuild", From: now - 1000, To: now + 3600_000, Patterns: []string{"mw.line1.>"}}}
	var got struct {
		Windows []alerts.Maintenance `json:"windows"`
	}
	if st := api.do("PUT", "/api/alerts/maintenance", windows, &got); st != 200 || len(got.Windows) != 1 || got.Windows[0].Name != "line 1 rebuild" {
		t.Fatalf("put maintenance: %d %+v", st, got.Windows)
	}
	if st := api.do("PUT", "/api/alerts/maintenance", []alerts.Maintenance{{ID: "m2", From: 5, To: 1}}, nil); st != 400 {
		t.Fatalf("a window that ends before it starts was accepted: %d", st)
	}
	entries, _ := store.All()
	if _, ok := entries[maintenanceKey]; !ok {
		t.Fatal("maintenance windows not written to the settings")
	}

	rule := alerts.Rule{ID: "r1", Name: "any", Pattern: "mw.>", Expr: "true", Enabled: true}
	if st := api.do("PUT", "/api/alerts/rules/r1", rule, nil); st != 200 {
		t.Fatalf("put rule: %d", st)
	}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	readEvent(t, ws, "connections")
	if st := api.do("POST", "/api/publish?connId=c1", map[string]interface{}{"subject": "mw.line1.oven", "payload": `1`}, nil); st != 200 {
		t.Fatalf("publish: %d", st)
	}
	ev := waitForAlert(t, ws, "firing")
	if ev["muted"] != true {
		t.Fatalf("an alert inside the window is not muted: %v", ev)
	}
	var active struct {
		Active []alerts.Alert `json:"active"`
	}
	api.do("GET", "/api/alerts", nil, &active)
	if len(active.Active) != 1 || !active.Active[0].Muted {
		t.Fatalf("active = %+v", active.Active)
	}
	// Outside the window's patterns nothing is muted.
	if st := api.do("POST", "/api/publish?connId=c1", map[string]interface{}{"subject": "mw.line2.oven", "payload": `1`}, nil); st != 200 {
		t.Fatalf("publish: %d", st)
	}
	ev = waitForAlert(t, ws, "firing")
	if ev["muted"] == true {
		t.Fatalf("an alert outside the window is muted: %v", ev)
	}
}
