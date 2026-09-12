package main

import (
	"strings"
	"testing"

	"nats-explorer/internal/auth"
	"nats-explorer/internal/settings"
)

// Every write under /api leaves an entry with the user, the object and the
// result; reads leave none, and only an admin may look at the log.
func TestServerAuditLog(t *testing.T) {
	ns := startNATS(t)
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	adminHash, _ := auth.HashPassword("secret")
	viewerHash, _ := auth.HashPassword("look")
	users, err := auth.ParseUsers(strings.NewReader("alice:admin:" + adminHash + "\nbob:viewer:" + viewerHash))
	if err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, serverConfig{users: users, settings: store})

	basic := func(user, pass string) *apiClient {
		return &apiClient{t: t, base: srv.URL, basic: user + ":" + pass}
	}
	alice := basic("alice", "secret")
	bob := basic("bob", "look")

	alice.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "Audited", "servers": []string{ns.ClientURL()}, "authMethod": "none",
	}, nil)
	defer alice.do("POST", "/api/disconnect-all", nil, nil)
	alice.do("POST", "/api/publish?connId=c1", map[string]interface{}{"subject": "audit.me", "payload": "hi"}, nil)
	// A read must not be logged.
	alice.do("GET", "/api/connections", nil, nil)
	// A refused write is logged with its status.
	if st := bob.do("DELETE", "/api/history", nil, nil); st != 403 {
		t.Fatalf("viewer delete = %d", st)
	}

	var log struct {
		Entries []struct {
			User    string `json:"user"`
			Role    string `json:"role"`
			Method  string `json:"method"`
			Path    string `json:"path"`
			Status  int    `json:"status"`
			Summary string `json:"summary"`
			ConnID  string `json:"connId"`
		} `json:"entries"`
	}
	alice.do("GET", "/api/audit", nil, &log)
	if len(log.Entries) < 2 {
		t.Fatalf("audit log = %+v", log.Entries)
	}
	var sawPublish, sawRefused bool
	for _, e := range log.Entries {
		if e.Method == "GET" {
			t.Errorf("a read was logged: %+v", e)
		}
		if e.Path == "/api/publish" {
			sawPublish = true
			if e.User != "alice" || e.Role != "admin" || e.Status != 200 || e.Summary != "audit.me" || e.ConnID != "c1" {
				t.Errorf("publish entry = %+v", e)
			}
		}
		if e.Path == "/api/history" && e.Method == "DELETE" {
			sawRefused = true
			if e.User != "bob" || e.Status != 403 {
				t.Errorf("refused entry = %+v", e)
			}
		}
	}
	if !sawPublish || !sawRefused {
		t.Fatalf("missing entries: publish=%v refused=%v in %+v", sawPublish, sawRefused, log.Entries)
	}

	// Filters narrow the listing.
	alice.do("GET", "/api/audit?user=bob", nil, &log)
	for _, e := range log.Entries {
		if e.User != "bob" {
			t.Fatalf("user filter let %s through", e.User)
		}
	}

	// A viewer may not read the log.
	if st := bob.do("GET", "/api/audit", nil, nil); st != 403 {
		t.Fatalf("viewer reading the audit log = %d, want 403", st)
	}

	// The file survives a restart of the server with the same settings dir.
	srv2 := newTestServer(t, serverConfig{users: users, settings: store})
	(&apiClient{t: t, base: srv2.URL, basic: "alice:secret"}).do("GET", "/api/audit", nil, &log)
	if len(log.Entries) < 2 {
		t.Fatalf("log did not survive a restart: %+v", log.Entries)
	}
}
