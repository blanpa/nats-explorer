package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/bcrypt"

	"nats-explorer/internal/auth"
)

// An account narrowed to some connections sees those and no others: in the
// connection list, behind a connId, in a path, on the socket, and it may
// neither open a connection by another name nor act on all of them.
func TestServerRestrictedAccount(t *testing.T) {
	ns := startNATS(t)
	users, err := auth.ParseUsers(strings.NewReader(
		"ops:admin:" + mustBcrypt(t, "pw") + "\n" +
			"lab:admin:" + mustBcrypt(t, "pw") + ":lab*\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(users[1].Connections) != 1 || users[1].Connections[0] != "lab*" {
		t.Fatalf("users = %+v", users)
	}
	srv := newTestServer(t, serverConfig{users: users})
	ops := &apiClient{t: t, base: srv.URL, basic: "ops:pw"}
	lab := &apiClient{t: t, base: srv.URL, basic: "lab:pw"}
	for _, c := range []map[string]interface{}{
		{"id": "p1", "name": "prod", "servers": []string{ns.ClientURL()}, "authMethod": "none"},
		{"id": "l1", "name": "lab-east", "servers": []string{ns.ClientURL()}, "authMethod": "none"},
	} {
		if st := ops.do("POST", "/api/connect", c, nil); st != 200 {
			t.Fatalf("connect %v: %d", c["name"], st)
		}
	}
	defer ops.do("POST", "/api/disconnect-all", nil, nil)

	var list []map[string]interface{}
	lab.do("GET", "/api/connections", nil, &list)
	if len(list) != 1 || list[0]["name"] != "lab-east" {
		t.Fatalf("lab sees %v", list)
	}
	ops.do("GET", "/api/connections", nil, &list)
	if len(list) != 2 {
		t.Fatalf("ops sees %v", list)
	}
	if st := lab.do("GET", "/api/streams?connId=p1", nil, nil); st != 403 {
		t.Fatalf("lab read prod's streams: %d", st)
	}
	if st := lab.do("GET", "/api/streams?connId=l1", nil, nil); st != 200 {
		t.Fatalf("lab could not read its own streams: %d", st)
	}
	if st := lab.do("GET", "/api/server/p1", nil, nil); st != 403 {
		t.Fatalf("lab read prod's server info by path: %d", st)
	}
	if st := lab.do("POST", "/api/connect", map[string]interface{}{"id": "x", "name": "prod-2", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 403 {
		t.Fatalf("lab opened a connection by another name: %d", st)
	}
	if st := lab.do("POST", "/api/disconnect", map[string]string{"id": "p1"}, nil); st != 403 {
		t.Fatalf("lab disconnected prod: %d", st)
	}
	if st := lab.do("POST", "/api/disconnect-all", nil, nil); st != 403 {
		t.Fatalf("lab disconnected everything: %d", st)
	}
	if st := lab.do("DELETE", "/api/history", nil, nil); st != 403 {
		t.Fatalf("lab cleared every history: %d", st)
	}

	// The socket says the same: only lab's connection, only lab's stats.
	hdr := http.Header{}
	req, _ := http.NewRequest("GET", srv.URL, nil)
	req.SetBasicAuth("lab", "pw")
	hdr.Set("Authorization", req.Header.Get("Authorization"))
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ev := readEvent(t, ws, "connections")
	data, _ := ev["data"].([]interface{})
	if len(data) != 1 || data[0].(map[string]interface{})["id"] != "l1" {
		t.Fatalf("lab's socket lists %v", data)
	}
	for i := 0; i < 6; i++ {
		ev := readEvent(t, ws, "stats")
		if ev["connId"] != "l1" {
			t.Fatalf("lab's socket got stats of %v", ev["connId"])
		}
	}
}

// mustBcrypt hashes at the lowest cost: every request of the test checks
// it, and the race detector makes the default cost take seconds.
func mustBcrypt(t *testing.T, pw string) string {
	t.Helper()
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	return string(h)
}
