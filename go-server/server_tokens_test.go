package main

import (
	"testing"

	"nats-explorer/internal/auth"
	"nats-explorer/internal/settings"
)

// Tokens are made by an admin, carry their own role, survive a restart of
// the server with the sessions, and are refused once revoked.
func TestServerTokensAndPersistedSessions(t *testing.T) {
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	hash := mustBcrypt(t, "pw")
	users := []auth.User{{Name: "admin", Role: auth.RoleAdmin, Hash: []byte(hash)}, {Name: "viewer", Role: auth.RoleViewer, Hash: []byte(hash)}}
	srv := newTestServer(t, serverConfig{users: users, settings: store})
	admin := &apiClient{t: t, base: srv.URL, basic: "admin:pw"}
	viewer := &apiClient{t: t, base: srv.URL, basic: "viewer:pw"}

	var listed struct {
		Tokens    []auth.Token `json:"tokens"`
		Supported bool         `json:"supported"`
	}
	if st := admin.do("GET", "/api/tokens", nil, &listed); st != 200 || !listed.Supported || len(listed.Tokens) != 0 {
		t.Fatalf("list: %d %+v", st, listed)
	}
	if st := viewer.do("GET", "/api/tokens", nil, nil); st != 403 {
		t.Fatalf("a viewer listed the tokens: %d", st)
	}
	var made struct {
		Token string     `json:"token"`
		Info  auth.Token `json:"info"`
	}
	if st := admin.do("POST", "/api/tokens", map[string]string{"name": "grafana", "role": "viewer"}, &made); st != 200 || made.Token == "" || made.Info.Role != auth.RoleViewer {
		t.Fatalf("make: %d %+v", st, made)
	}
	// The token reads, and does not write.
	bearer := &apiClient{t: t, base: srv.URL, token: made.Token}
	if st := bearer.do("GET", "/api/connections", nil, nil); st != 200 {
		t.Fatalf("the token did not read: %d", st)
	}
	if st := bearer.do("POST", "/api/connect", map[string]interface{}{"id": "x", "name": "x", "servers": []string{"nats://127.0.0.1:1"}, "authMethod": "none"}, nil); st != 403 {
		t.Fatalf("a viewer token wrote: %d", st)
	}
	var who struct {
		User string `json:"user"`
		Role string `json:"role"`
	}
	bearer.do("GET", "/api/auth", nil, &who)
	if who.User != "token:grafana" || who.Role != "viewer" {
		t.Fatalf("who = %+v", who)
	}

	// A login's session and the token survive a new server on the same store.
	var login struct{ User string }
	if st := (&apiClient{t: t, base: srv.URL}).do("POST", "/api/login", map[string]string{"user": "admin", "password": "pw"}, &login); st != 200 {
		t.Fatalf("login: %d", st)
	}
	srv2 := newTestServer(t, serverConfig{users: users, settings: store})
	bearer2 := &apiClient{t: t, base: srv2.URL, token: made.Token}
	if st := bearer2.do("GET", "/api/connections", nil, nil); st != 200 {
		t.Fatalf("the token did not survive the restart: %d", st)
	}
	admin2 := &apiClient{t: t, base: srv2.URL, basic: "admin:pw"}
	if st := admin2.do("DELETE", "/api/tokens/"+made.Info.ID, nil, nil); st != 204 {
		t.Fatalf("revoke: %d", st)
	}
	if st := bearer2.do("GET", "/api/connections", nil, nil); st != 401 {
		t.Fatalf("a revoked token still read: %d", st)
	}
	if st := admin2.do("DELETE", "/api/tokens/"+made.Info.ID, nil, nil); st != 404 {
		t.Fatalf("revoking twice: %d", st)
	}

	// Without a store there is nowhere to keep a token.
	srv3 := newTestServer(t, serverConfig{users: users})
	if st := (&apiClient{t: t, base: srv3.URL, basic: "admin:pw"}).do("POST", "/api/tokens", map[string]string{"name": "x", "role": "admin"}, nil); st != 409 {
		t.Fatalf("a token without a store: %d", st)
	}
}
