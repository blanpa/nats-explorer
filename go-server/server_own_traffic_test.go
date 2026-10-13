package main

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// What the explorer does itself -- the JetStream API, a KV put, an object
// upload, reading a stream, discovering services -- is not recorded as
// traffic under `>`; what is published on the network, by anyone and from
// the explorer too, is, and so are the server's advisories.
func TestServerOwnTrafficIsNotRecorded(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "C", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{">"},
	}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	defer api.do("POST", "/api/disconnect-all", nil, nil)
	q := "?connId=c1"
	must := func(st int, what string) {
		t.Helper()
		if st != 200 {
			t.Fatalf("%s: %d", what, st)
		}
	}

	must(api.do("POST", "/api/streams"+q, map[string]interface{}{"name": "O", "subjects": []string{"o.>"}}, nil), "stream")
	must(api.do("POST", "/api/kv"+q, map[string]interface{}{"bucket": "cfg"}, nil), "bucket")
	must(api.do("PUT", "/api/kv/cfg/a"+q, map[string]string{"value": "1"}, nil), "kv put")
	must(api.do("POST", "/api/objectstore"+q, map[string]interface{}{"bucket": "files"}, nil), "store")
	req, _ := http.NewRequest("PUT", srv.URL+"/api/objectstore/files/big.bin"+q, bytes.NewReader(bytes.Repeat([]byte{7}, 600*1024)))
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("upload: %v %v", err, res)
	}
	res.Body.Close()
	api.do("GET", "/api/services"+q, nil, nil)

	// The network's traffic, from another client and from the explorer.
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	nc.Publish("o.created", []byte(`{"n":1}`))
	nc.Flush()
	must(api.do("POST", "/api/publish", map[string]interface{}{"connId": "c1", "subject": "mine.hello", "payload": "hi"}, nil), "publish")
	api.do("GET", "/api/streams/O/messages"+q+"&startSeq=1&limit=5&subject=o.created", nil, nil)
	time.Sleep(500 * time.Millisecond)

	found := func(query string) []string {
		var out struct {
			Hits []struct {
				Kind string `json:"kind"`
				Name string `json:"name"`
			} `json:"hits"`
		}
		api.do("GET", "/api/search"+q+"&q="+query, nil, &out)
		var subjects []string
		for _, h := range out.Hits {
			if h.Kind == "subject" {
				subjects = append(subjects, h.Name)
			}
		}
		return subjects
	}
	// The server's advisories are events of the network, published by the
	// server: they stay. Everything else under $ was the explorer's.
	for _, s := range found("$") {
		if !strings.HasPrefix(s, "$JS.EVENT.ADVISORY.") {
			t.Errorf("the explorer's own system call was recorded: %s", s)
		}
	}
	if got := found("_INBOX"); len(got) != 0 {
		t.Errorf("replies to the explorer were recorded: %v", got)
	}
	if got := found("o.created"); len(got) != 1 {
		t.Errorf("a publish on the network = %v", got)
	}
	if got := found("mine.hello"); len(got) != 1 {
		t.Errorf("a publish from the explorer = %v", got)
	}
}
