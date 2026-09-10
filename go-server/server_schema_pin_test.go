package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

type pinnedResponse struct {
	Pattern string `json:"pattern"`
	Fields  []struct {
		Path     string   `json:"path"`
		Types    []string `json:"types"`
		Required bool     `json:"required"`
	} `json:"fields"`
}

// Pinning a schema turns the derived description into a reference, and the
// payload filter is what carries it everywhere: `!valid` narrows the history
// to the messages that do not match, without the history knowing about
// schemas at all.
func TestServerPinnedSchemaDrivesThePayloadFilter(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "s1", "name": "S", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subjects": []string{">"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()

	// Three well-formed messages, then two that are not.
	for i := 0; i < 3; i++ {
		nc.Publish("pin.temp", []byte(fmt.Sprintf(`{"v":%d,"unit":"C"}`, 20+i)))
	}
	nc.Flush()
	waitForHistory(t, api, "pin.temp", 3)

	// Pin what was derived.
	pin := map[string]interface{}{
		"pattern": "pin.>",
		"fields": []map[string]interface{}{
			{"path": "v", "types": []string{"integer"}, "required": true},
			{"path": "unit", "types": []string{"string"}, "required": true, "enum": []string{"C", "F"}},
		},
	}
	var pinned pinnedResponse
	if code := api.do("PUT", "/api/schemas", pin, &pinned); code != 200 || pinned.Pattern != "pin.>" {
		t.Fatalf("pin: %d %+v", code, pinned)
	}

	nc.Publish("pin.temp", []byte(`{"v":"warm","unit":"C"}`)) // wrong type
	nc.Publish("pin.temp", []byte(`{"v":30}`))                // missing unit
	nc.Flush()
	waitForHistory(t, api, "pin.temp", 5)

	// The filter reaches the history without any schema knowledge of its own.
	var bad struct {
		Messages []struct {
			Payload string `json:"payload"`
		} `json:"messages"`
	}
	if code := api.do("GET", "/api/history?connId=s1&subject=pin.temp&expr=%21valid", nil, &bad); code != 200 {
		t.Fatalf("filtered history: %d", code)
	}
	if len(bad.Messages) != 2 {
		t.Fatalf("!valid should find the two broken messages, got %d: %+v", len(bad.Messages), bad.Messages)
	}
	var good struct {
		Messages []struct{} `json:"messages"`
	}
	api.do("GET", "/api/history?connId=s1&subject=pin.temp&expr=valid", nil, &good)
	if len(good.Messages) != 3 {
		t.Fatalf("valid should find the three good messages, got %d", len(good.Messages))
	}

	// The reasons are readable from an expression too.
	var typed struct {
		Messages []struct{} `json:"messages"`
	}
	api.do("GET", `/api/history?connId=s1&subject=pin.temp&expr=violations.exists(x%2C%20x.startsWith(%22unit%22))`, nil, &typed)
	if len(typed.Messages) != 1 {
		t.Fatalf("only one message is missing its unit, got %d", len(typed.Messages))
	}

	// The schema panel is told how the samples hold up.
	var derived struct {
		PinnedPattern string `json:"pinnedPattern"`
		Invalid       int    `json:"invalid"`
	}
	api.do("GET", "/api/schema?connId=s1&subject=pin.temp", nil, &derived)
	if derived.PinnedPattern != "pin.>" || derived.Invalid != 2 {
		t.Fatalf("schema report = %+v, want pin.> with 2 invalid", derived)
	}

	// A payload can be checked before it is published.
	var check struct {
		Pinned     bool     `json:"pinned"`
		Violations []string `json:"violations"`
	}
	api.do("POST", "/api/schemas/check", map[string]string{"subject": "pin.temp", "payload": `{"v":1}`}, &check)
	if !check.Pinned || len(check.Violations) != 1 || check.Violations[0] != "unit: missing" {
		t.Fatalf("check = %+v", check)
	}
	api.do("POST", "/api/schemas/check", map[string]string{"subject": "other.temp", "payload": `{}`}, &check)
	if check.Pinned {
		t.Fatal("nothing is pinned for other.temp")
	}

	// Unpinning takes the reference away again; everything is valid once more.
	api.do("DELETE", "/api/schemas?pattern=pin.%3E", nil, nil)
	api.do("GET", "/api/history?connId=s1&subject=pin.temp&expr=%21valid", nil, &bad)
	if len(bad.Messages) != 0 {
		t.Fatalf("without a pinned schema nothing is invalid, got %d", len(bad.Messages))
	}
}

// waitForHistory blocks until the subject has at least n recorded messages.
func waitForHistory(t *testing.T, api *apiClient, subject string, n int) {
	t.Helper()
	var resp struct {
		Messages []struct{} `json:"messages"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", "/api/history?connId=s1&subject="+subject, nil, &resp)
		if len(resp.Messages) >= n {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s has %d messages, want %d", subject, len(resp.Messages), n)
}
