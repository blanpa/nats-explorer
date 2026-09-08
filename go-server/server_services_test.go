package main

import (
	"testing"

	"github.com/nats-io/nats.go"
)

// A server without any micro service answers discovery with an empty status
// message. That is not a service and must not reach the browser, which would
// read a null out of the list.
func TestServerServiceDiscoveryWithoutServices(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "S", "servers": []string{ns.ClientURL()}, "authMethod": "none",
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	for _, path := range []string{"/api/services", "/api/services/stats", "/api/services/ping"} {
		var out []map[string]interface{}
		if st := api.do("GET", path+"?connId=c1&waitMs=300", nil, &out); st != 200 {
			t.Fatalf("%s: %d", path, st)
		}
		if len(out) != 0 {
			t.Fatalf("%s returned %d entries without any service: %+v", path, len(out), out)
		}
	}

	// With a responder the reply is passed through.
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	sub, err := nc.Subscribe("$SRV.INFO", func(msg *nats.Msg) {
		msg.Respond([]byte(`{"name":"greeter","id":"abc","version":"1.0.0","endpoints":[]}`))
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()
	nc.Flush()

	var services []map[string]interface{}
	api.do("GET", "/api/services?connId=c1&waitMs=500", nil, &services)
	if len(services) != 1 || services[0]["name"] != "greeter" {
		t.Fatalf("discovery = %+v", services)
	}
}
