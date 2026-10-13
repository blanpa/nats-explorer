package main

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// The search finds a subject the connection received, a stream by one of
// its subjects, a key in any bucket and an object in any store, each with
// where it lives.
func TestServerSearchJetStream(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "s1", "name": "s", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"live.>"}}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	defer api.do("POST", "/api/disconnect-all", nil, nil)
	q := "?connId=s1"
	must := func(st int, what string) {
		t.Helper()
		if st != 200 {
			t.Fatalf("%s: %d", what, st)
		}
	}
	must(api.do("POST", "/api/streams"+q, map[string]interface{}{"name": "ORDERS", "subjects": []string{"shop.orders.>"}}, nil), "stream")
	must(api.do("POST", "/api/kv"+q, map[string]interface{}{"bucket": "config"}, nil), "bucket a")
	must(api.do("POST", "/api/kv"+q, map[string]interface{}{"bucket": "flags"}, nil), "bucket b")
	must(api.do("PUT", "/api/kv/config/line.orders.limit"+q, map[string]string{"value": "5"}, nil), "key a")
	must(api.do("PUT", "/api/kv/flags/new-checkout"+q, map[string]string{"value": "on"}, nil), "key b")
	must(api.do("POST", "/api/objectstore"+q, map[string]interface{}{"bucket": "docs"}, nil), "store")
	req, _ := http.NewRequest("PUT", srv.URL+"/api/objectstore/docs/orders-2026.csv"+q, bytes.NewReader([]byte("a,b")))
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("upload: %v %v", err, res)
	}
	res.Body.Close()

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	nc.Publish("live.orders.created", []byte("{}"))
	nc.Flush()
	time.Sleep(300 * time.Millisecond)

	type hit struct {
		Kind   string `json:"kind"`
		Name   string `json:"name"`
		Item   string `json:"item"`
		Detail string `json:"detail"`
	}
	var out struct {
		Hits []hit `json:"hits"`
	}
	must(api.do("GET", "/api/search"+q+"&q=ORDERS", nil, &out), "search")
	got := map[hit]bool{}
	for _, h := range out.Hits {
		got[h] = true
	}
	for _, want := range []hit{
		{Kind: "subject", Name: "live.orders.created"},
		{Kind: "stream", Name: "ORDERS"},
		{Kind: "key", Name: "config", Item: "line.orders.limit"},
		{Kind: "object", Name: "docs", Item: "orders-2026.csv"},
	} {
		if !got[want] {
			t.Errorf("missing %+v in %+v", want, out.Hits)
		}
	}
	if len(out.Hits) != 4 {
		t.Errorf("hits = %+v", out.Hits)
	}

	// A subject finds its stream, a bucket name its bucket.
	out.Hits = nil
	must(api.do("GET", "/api/search"+q+"&q=shop.orders", nil, &out), "search subject")
	if len(out.Hits) != 1 || out.Hits[0].Kind != "stream" || out.Hits[0].Detail != "shop.orders.>" {
		t.Errorf("by subject = %+v", out.Hits)
	}
	out.Hits = nil
	must(api.do("GET", "/api/search"+q+"&q=flag", nil, &out), "search bucket")
	if len(out.Hits) != 1 || out.Hits[0].Kind != "bucket" || out.Hits[0].Name != "flags" {
		t.Errorf("by bucket = %+v", out.Hits)
	}
}
