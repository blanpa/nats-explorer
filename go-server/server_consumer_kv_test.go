package main

import (
	"fmt"
	"testing"
	"time"
)

// A pull consumer's next messages, handed over without an ack, and the
// ack said afterwards: the backlog moves only once the reader decided.
func TestServerConsumerNextAndAck(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "t1", "name": "test", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	q := "?connId=t1"
	if st := api.do("POST", "/api/streams"+q, map[string]interface{}{"name": "W", "subjects": []string{"w.>"}, "retention": "workqueue"}, nil); st != 200 {
		t.Fatalf("create stream: %d", st)
	}
	for i := 1; i <= 5; i++ {
		if st := api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": fmt.Sprintf("w.%d", i), "payload": fmt.Sprintf(`{"i":%d}`, i)}, nil); st != 200 {
			t.Fatalf("publish: %d", st)
		}
	}
	// Every field the form now knows, read back.
	var created map[string]interface{}
	if st := api.do("POST", "/api/streams/W/consumers"+q, map[string]interface{}{
		"name": "worker", "ackWait": 2e9, "filterSubjects": []string{"w.1", "w.2", "w.3", "w.4", "w.5"},
		"backoff": []int64{1e9, 5e9}, "maxDeliver": 3, "inactiveThreshold": 3600e9, "maxWaiting": 64, "headersOnly": false,
		"metadata": map[string]string{"team": "ops"},
	}, &created); st != 200 {
		t.Fatalf("create consumer: %d", st)
	}
	cfg, _ := created["config"].(map[string]interface{})
	if fs, _ := cfg["filterSubjects"].([]interface{}); len(fs) != 5 {
		t.Fatalf("filterSubjects = %v", cfg["filterSubjects"])
	}
	if bo, _ := cfg["backoff"].([]interface{}); len(bo) != 2 || bo[1] != float64(5e9) {
		t.Fatalf("backoff = %v", cfg["backoff"])
	}
	if cfg["inactiveThreshold"] != float64(3600e9) || cfg["maxWaiting"] != float64(64) {
		t.Fatalf("config = %v", cfg)
	}
	if md, _ := cfg["metadata"].(map[string]interface{}); md["team"] != "ops" {
		t.Fatalf("metadata = %v", cfg["metadata"])
	}

	var next struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	if st := api.do("POST", "/api/streams/W/consumers/worker/next"+q, map[string]interface{}{"batch": 2, "waitMs": 1000}, &next); st != 200 || len(next.Messages) != 2 {
		t.Fatalf("next: %d %+v", st, next)
	}
	m := next.Messages[0]
	reply, _ := m["reply"].(string)
	if reply == "" || m["deliveries"] != float64(1) || m["subject"] != "w.1" || m["pending"] != float64(4) {
		t.Fatalf("first message = %v", m)
	}
	var ci map[string]interface{}
	api.do("GET", "/api/streams/W/consumers/worker"+q, nil, &ci)
	if ci["numAckPending"] != float64(2) {
		t.Fatalf("after next: ack pending = %v, want 2", ci["numAckPending"])
	}

	// Acked, the first leaves the work queue; termed, the second does too,
	// and with a reason the server can log.
	if st := api.do("POST", "/api/streams/W/consumers/worker/ack"+q, map[string]interface{}{"reply": reply, "action": "ack"}, nil); st != 200 {
		t.Fatalf("ack: %d", st)
	}
	second, _ := next.Messages[1]["reply"].(string)
	if st := api.do("POST", "/api/streams/W/consumers/worker/ack"+q, map[string]interface{}{"reply": second, "action": "term"}, nil); st != 200 {
		t.Fatalf("term: %d", st)
	}
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		api.do("GET", "/api/streams/W/consumers/worker"+q, nil, &ci)
		if ci["numAckPending"] == float64(0) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if ci["numAckPending"] != float64(0) || ci["numPending"] != float64(3) {
		t.Fatalf("after ack and term: %v / %v", ci["numAckPending"], ci["numPending"])
	}
	// A nak with a delay keeps the message pending for later.
	if st := api.do("POST", "/api/streams/W/consumers/worker/next"+q, map[string]interface{}{"batch": 1, "waitMs": 1000}, &next); st != 200 || len(next.Messages) != 1 {
		t.Fatalf("next again: %d %+v", st, next)
	}
	third, _ := next.Messages[0]["reply"].(string)
	if st := api.do("POST", "/api/streams/W/consumers/worker/ack"+q, map[string]interface{}{"reply": third, "action": "nak", "delayMs": 50}, nil); st != 200 {
		t.Fatalf("nak: %d", st)
	}
	if st := api.do("POST", "/api/streams/W/consumers/worker/ack"+q, map[string]interface{}{"reply": "w.1", "action": "ack"}, nil); st != 400 {
		t.Fatalf("a non-ack subject was accepted: %d", st)
	}
	if st := api.do("POST", "/api/streams/W/consumers/worker/ack"+q, map[string]interface{}{"reply": third, "action": "drop"}, nil); st != 400 {
		t.Fatalf("an unknown action was accepted: %d", st)
	}

	// An update may change the filters, the backoff and the metadata.
	var updated map[string]interface{}
	if st := api.do("PUT", "/api/streams/W/consumers/worker"+q, map[string]interface{}{"filterSubjects": []string{"w.>"}, "backoff": []int64{}, "metadata": map[string]string{"team": "data"}, "headersOnly": true}, &updated); st != 200 {
		t.Fatalf("update: %d", st)
	}
	cfg, _ = updated["config"].(map[string]interface{})
	if cfg["filterSubject"] != "w.>" || cfg["backoff"] != nil || cfg["headersOnly"] != true {
		t.Fatalf("updated config = %v", cfg)
	}
	if md, _ := cfg["metadata"].(map[string]interface{}); md["team"] != "data" {
		t.Fatalf("updated metadata = %v", cfg["metadata"])
	}
}

// A bucket's settings after creation, a write that checks the revision it
// read, and many keys deleted at once.
func TestServerKVUpdateRevisionsAndBulkDelete(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "t1", "name": "test", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	q := "?connId=t1"
	if st := api.do("POST", "/api/kv"+q, map[string]interface{}{"bucket": "cfg", "history": 3, "metadata": map[string]string{"owner": "plant"}, "compression": true}, nil); st != 200 {
		t.Fatalf("create bucket: %d", st)
	}
	var buckets []map[string]interface{}
	api.do("GET", "/api/kv"+q, nil, &buckets)
	if len(buckets) != 1 || buckets[0]["compression"] != true || buckets[0]["history"] != float64(3) {
		t.Fatalf("buckets = %v", buckets)
	}
	if md, _ := buckets[0]["metadata"].(map[string]interface{}); md["owner"] != "plant" {
		t.Fatalf("metadata = %v", buckets[0]["metadata"])
	}

	// Update: a description, a TTL and a size limit, with the rest kept.
	var updated map[string]interface{}
	if st := api.do("PUT", "/api/kv/cfg"+q, map[string]interface{}{"description": "plant config", "ttl": 3600e9, "maxBytes": 1 << 20}, &updated); st != 200 {
		t.Fatalf("update bucket: %d", st)
	}
	if updated["description"] != "plant config" || updated["ttl"] != float64(3600e9) || updated["maxBytes"] != float64(1<<20) || updated["history"] != float64(3) || updated["compression"] != true {
		t.Fatalf("updated = %v", updated)
	}
	// A mirror bucket of it, named by bucket, read back by bucket.
	var mirror map[string]interface{}
	if st := api.do("POST", "/api/kv"+q, map[string]interface{}{"bucket": "cfg-copy", "mirror": map[string]string{"bucket": "cfg"}}, nil); st != 200 {
		t.Fatalf("create mirror: %d", st)
	}
	api.do("GET", "/api/kv"+q, nil, &buckets)
	for _, b := range buckets {
		if b["bucket"] == "cfg-copy" {
			mirror = b
		}
	}
	if m, _ := mirror["mirror"].(map[string]interface{}); m["bucket"] != "cfg" {
		t.Fatalf("mirror = %v", mirror)
	}

	// Revisions: a create of a key that exists, and an update from a stale
	// revision, are conflicts that name the current revision.
	var put struct {
		Revision uint64 `json:"revision"`
	}
	if st := api.do("PUT", "/api/kv/cfg/db.host"+q, map[string]interface{}{"value": "a", "revision": 0}, &put); st != 200 || put.Revision == 0 {
		t.Fatalf("create key: %d %+v", st, put)
	}
	first := put.Revision
	if st := api.do("PUT", "/api/kv/cfg/db.host"+q, map[string]interface{}{"value": "b", "revision": 0}, nil); st != 409 {
		t.Fatalf("creating twice: %d", st)
	}
	if st := api.do("PUT", "/api/kv/cfg/db.host"+q, map[string]interface{}{"value": "b", "revision": first}, &put); st != 200 || put.Revision != first+1 {
		t.Fatalf("update from the read revision: %d %+v", st, put)
	}
	if st := api.do("PUT", "/api/kv/cfg/db.host"+q, map[string]interface{}{"value": "c", "revision": first}, nil); st != 409 {
		t.Fatalf("update from a stale revision: %d", st)
	}
	if st := api.do("PUT", "/api/kv/cfg/db.host"+q, map[string]interface{}{"value": "c"}, &put); st != 200 || put.Revision != first+2 {
		t.Fatalf("a plain put still wins: %d %+v", st, put)
	}

	// Many at once.
	for i := 0; i < 5; i++ {
		api.do("PUT", "/api/kv/cfg/line."+fmt.Sprint(i)+q, map[string]interface{}{"value": "x"}, nil)
	}
	var bulk struct {
		Deleted int               `json:"deleted"`
		Failed  map[string]string `json:"failed"`
	}
	if st := api.do("POST", "/api/kv/cfg/delete"+q, map[string]interface{}{"keys": []string{"line.0", "line.1", "line.2"}, "purge": true}, &bulk); st != 200 || bulk.Deleted != 3 || len(bulk.Failed) != 0 {
		t.Fatalf("bulk delete: %d %+v", st, bulk)
	}
	var keys []string
	api.do("GET", "/api/kv/cfg"+q, nil, &keys)
	if len(keys) != 3 {
		t.Fatalf("keys after the bulk delete = %v", keys)
	}
	if st := api.do("POST", "/api/kv/cfg/delete"+q, map[string]interface{}{"keys": []string{}}, nil); st != 400 {
		t.Fatalf("an empty bulk delete: %d", st)
	}
}
