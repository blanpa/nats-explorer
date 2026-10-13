package main

import (
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// The cluster operations are one request each; a responder on a plain
// server stands in for JetStream and the system account and says what
// arrived, and an error answer is passed on with its description.
func TestServerClusterOperations(t *testing.T) {
	ns, err := natsserver.NewServer(&natsserver.Options{Host: "127.0.0.1", Port: -1, NoLog: true, NoSigs: true})
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats-server did not start")
	}
	defer ns.Shutdown()
	nc, _ := nats.Connect(ns.ClientURL())
	defer nc.Close()
	got := make(chan string, 10)
	answer := func(subject, reply string) {
		nc.Subscribe(subject, func(m *nats.Msg) {
			got <- m.Subject + " " + string(m.Data)
			m.Respond([]byte(reply))
		})
	}
	answer("$JS.API.STREAM.LEADER.STEPDOWN.ORDERS", `{"success":true}`)
	answer("$JS.API.STREAM.PEER.REMOVE.ORDERS", `{"success":true}`)
	answer("$JS.API.CONSUMER.LEADER.STEPDOWN.ORDERS.billing", `{"error":{"code":400,"description":"consumer is not clustered"}}`)
	answer("$SYS.REQ.SERVER.NABC.RELOAD", `{"data":{}}`)
	answer("$JS.API.META.LEADER.STEPDOWN", `{"success":true}`)
	nc.Flush()

	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "c", "name": "c", "servers": []string{ns.ClientURL()}, "authMethod": "none", "sysAuthMethod": "token", "sysToken": "x"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	q := "?connId=c"
	expect := func(want string) {
		t.Helper()
		select {
		case s := <-got:
			if s != want {
				t.Fatalf("request = %q, want %q", s, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no request for %q", want)
		}
	}
	if st := api.do("POST", "/api/streams/ORDERS/stepdown"+q, nil, nil); st != 200 {
		t.Fatalf("stepdown: %d", st)
	}
	expect("$JS.API.STREAM.LEADER.STEPDOWN.ORDERS ")
	if st := api.do("POST", "/api/streams/ORDERS/peer-remove"+q, map[string]string{"peer": "n2"}, nil); st != 200 {
		t.Fatalf("peer remove: %d", st)
	}
	expect(`$JS.API.STREAM.PEER.REMOVE.ORDERS {"peer":"n2"}`)
	if st := api.do("POST", "/api/streams/ORDERS/peer-remove"+q, map[string]string{}, nil); st != 400 {
		t.Fatalf("peer remove without a peer: %d", st)
	}
	if st := api.do("POST", "/api/streams/ORDERS/consumers/billing/stepdown"+q, nil, nil); st != 502 {
		t.Fatalf("an error answer was not passed on: %d", st)
	}
	expect("$JS.API.CONSUMER.LEADER.STEPDOWN.ORDERS.billing ")
	if st := api.do("POST", "/api/cluster/c/reload", map[string]string{"serverId": "NABC"}, nil); st != 200 {
		t.Fatalf("reload: %d", st)
	}
	expect("$SYS.REQ.SERVER.NABC.RELOAD ")
	if st := api.do("POST", "/api/cluster/c/meta-stepdown", nil, nil); st != 200 {
		t.Fatalf("meta stepdown: %d", st)
	}
	expect("$JS.API.META.LEADER.STEPDOWN {}")

	// Without a system account the server operations say what they need.
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "d", "name": "d", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	if st := api.do("POST", "/api/cluster/d/reload", map[string]string{"serverId": "NABC"}, nil); st != 400 {
		t.Fatalf("reload without a system account: %d", st)
	}
}
