package main

import (
	"net"
	"testing"

	"nats-explorer/internal/connection"
)

// Connections opened at start wait for a server that is not there yet, not
// for one that said no.
func TestAutoConnectRetriesOnlyAnAbsentServer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	absent := "nats://" + ln.Addr().String()
	ln.Close()
	s := connection.NewStore()
	_, err = s.Connect(connection.Config{ID: "a", Name: "a", Servers: []string{absent}})
	if !unreachable(err) {
		t.Fatalf("no server must count as unreachable: %v", err)
	}

	ns := startNATSWithSystemAccount(t)
	_, err = s.Connect(connection.Config{ID: "b", Name: "b", Servers: []string{ns.ClientURL()}, AuthMethod: "userpass", User: "app", Pass: "wrong"})
	if err == nil || unreachable(err) {
		t.Fatalf("a wrong password must not be retried: %v", err)
	}
}
