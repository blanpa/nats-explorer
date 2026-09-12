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

	// Testing the rule against the recorded history finds the same message.
	var test struct {
		Sampled int `json:"sampled"`
		Matched int `json:"matched"`
	}
	if st := api.do("POST", "/api/alerts/rules/r1/test", rule, &test); st != 200 || test.Matched != 1 || test.Sampled < 1 {
		t.Fatalf("rule test: %d %+v", st, test)
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
