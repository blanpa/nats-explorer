package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"
)

// The parts of a stream the form used to leave to the CLI: republish,
// transforms, metadata, compression, sources; the configuration in the
// server's own JSON; a page narrowed to a subject; the last message on a
// subject; a backup the CLI could restore, restored here; and sealing.
func TestServerStreamExtras(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "t1", "name": "test", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	q := "?connId=t1"

	var info map[string]interface{}
	if st := api.do("POST", "/api/streams"+q, map[string]interface{}{
		"name": "X", "subjects": []string{"x.>"},
		"republish":             map[string]interface{}{"src": "x.>", "dest": "rp.>", "headersOnly": true},
		"metadata":              map[string]string{"owner": "plant"},
		"compression":           "s2",
		"consumerMaxAckPending": 100,
		"allowMsgTtl":           true,
	}, &info); st != 200 {
		t.Fatalf("create: %d", st)
	}
	rp, _ := info["republish"].(map[string]interface{})
	if rp["dest"] != "rp.>" || rp["headersOnly"] != true || info["compression"] != "s2" {
		t.Fatalf("created = %v", info)
	}
	if md, _ := info["metadata"].(map[string]interface{}); md["owner"] != "plant" {
		t.Fatalf("metadata = %v", info["metadata"])
	}
	if cl, _ := info["consumerLimits"].(map[string]interface{}); cl["maxAckPending"] != float64(100) {
		t.Fatalf("consumerLimits = %v", info["consumerLimits"])
	}

	// The configuration as the server writes it, snake_case and all.
	var raw map[string]interface{}
	if st := api.do("GET", "/api/streams/X/config"+q, nil, &raw); st != 200 || raw["compression"] != "s2" || raw["republish"] == nil || raw["num_replicas"] != float64(1) {
		t.Fatalf("config: %d %v", st, raw)
	}

	// A source with a filter, read back as configured before data flows.
	var y map[string]interface{}
	if st := api.do("POST", "/api/streams"+q, map[string]interface{}{"name": "Y", "sources": []map[string]interface{}{{"name": "X", "filterSubject": "x.a.>", "optStartSeq": 2}}}, &y); st != 200 {
		t.Fatalf("create Y: %d", st)
	}
	srcs, _ := y["sources"].([]interface{})
	if len(srcs) != 1 || srcs[0].(map[string]interface{})["filterSubject"] != "x.a.>" || srcs[0].(map[string]interface{})["optStartSeq"] != float64(2) {
		t.Fatalf("sources = %v", y["sources"])
	}

	for i := 1; i <= 60; i++ {
		sub := "x.a." + fmt.Sprint(i)
		if i%3 == 0 {
			sub = "x.b." + fmt.Sprint(i)
		}
		if st := api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": sub, "payload": fmt.Sprintf(`{"i":%d}`, i)}, nil); st != 200 {
			t.Fatalf("publish %d: %d", i, st)
		}
	}
	var state struct {
		State struct {
			Messages int `json:"messages"`
		} `json:"state"`
	}
	for deadline := time.Now().Add(5 * time.Second); state.State.Messages < 60 && time.Now().Before(deadline); {
		api.do("GET", "/api/streams/X"+q, nil, &state)
		time.Sleep(50 * time.Millisecond)
	}
	if state.State.Messages != 60 {
		t.Fatalf("stream has %d messages", state.State.Messages)
	}

	// Narrowed to a subject: the newest matches without a start, the next
	// ones from a start, and the last one straight from the stream.
	var page struct {
		Messages  []map[string]interface{} `json:"messages"`
		PageStart uint64                   `json:"pageStart"`
		PageEnd   uint64                   `json:"pageEnd"`
		Subject   string                   `json:"subject"`
	}
	if st := api.do("GET", "/api/streams/X/messages"+q+"&subject=x.b.>&limit=5", nil, &page); st != 200 || len(page.Messages) != 5 || page.Subject != "x.b.>" {
		t.Fatalf("newest filtered: %d %+v", st, page)
	}
	if page.Messages[4]["seq"].(float64) != 60 || page.Messages[0]["seq"].(float64) != 48 || page.PageEnd != 60 {
		t.Fatalf("newest filtered page = %v (end %d)", page.Messages, page.PageEnd)
	}
	for _, m := range page.Messages {
		if m["subject"].(string)[:4] != "x.b." {
			t.Fatalf("a message off the subject: %v", m)
		}
	}
	if st := api.do("GET", "/api/streams/X/messages"+q+"&subject=x.b.>&startSeq=1&limit=4", nil, &page); st != 200 || len(page.Messages) != 4 || page.PageStart != 1 || page.PageEnd != 12 {
		t.Fatalf("filtered from the start: %d %+v", st, page)
	}
	if st := api.do("GET", "/api/streams/X/messages"+q+"&subject=x.b.>&startSeq=13&limit=100", nil, &page); st != 200 || len(page.Messages) != 16 || page.PageEnd != 60 {
		t.Fatalf("a short page runs to the end: %d %d %d", st, len(page.Messages), page.PageEnd)
	}
	if st := api.do("GET", "/api/streams/X/messages"+q+"&subject=nothing.>&limit=5", nil, &page); st != 200 || len(page.Messages) != 0 {
		t.Fatalf("no matches: %d %+v", st, page)
	}
	var last map[string]interface{}
	if st := api.do("GET", "/api/streams/X/last"+q+"&subject=x.b.>", nil, &last); st != 200 || last["seq"] != float64(60) {
		t.Fatalf("last by subject: %d %v", st, last)
	}
	if st := api.do("GET", "/api/streams/X/last"+q+"&subject=x.c.1", nil, nil); st != 404 {
		t.Fatalf("last on an empty subject: %d", st)
	}

	// Null takes the republish away; an empty list takes the sources away.
	// A fresh map: decoding into the old one keeps the keys the answer
	// leaves out, and a cleared republish is left out.
	var cleared map[string]interface{}
	if st := api.do("PUT", "/api/streams/X"+q, map[string]interface{}{"republish": nil, "metadata": map[string]string{}}, &cleared); st != 200 || cleared["republish"] != nil {
		t.Fatalf("clearing: %d %v", st, cleared["republish"])
	}
	// The server's own _nats.* entries may stay; the reader's are gone.
	if md, _ := cleared["metadata"].(map[string]interface{}); md["owner"] != nil {
		t.Fatalf("metadata after clearing = %v", cleared["metadata"])
	}
	var ySources map[string]interface{}
	if st := api.do("PUT", "/api/streams/Y"+q, map[string]interface{}{"sources": []interface{}{}}, &ySources); st != 200 || ySources["sources"] != nil {
		t.Fatalf("clearing sources: %d %v", st, ySources["sources"])
	}

	// A backup is a zip with the files the nats CLI lays out; restored, the
	// stream is back with every message.
	res, err := http.Get(srv.URL + "/api/streams/X/backup" + q)
	if err != nil {
		t.Fatal(err)
	}
	backup, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("backup: %d %s %s", res.StatusCode, res.Header.Get("Content-Type"), backup)
	}
	zr, err := zip.NewReader(bytes.NewReader(backup), int64(len(backup)))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names["backup.json"] || !(names["stream.arc.s2"] || names["stream.tar.s2"]) {
		t.Fatalf("backup files = %v", names)
	}
	if st := api.do("DELETE", "/api/streams/X"+q, nil, nil); st != 200 {
		t.Fatalf("delete: %d", st)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/streams-restore"+q, bytes.NewReader(backup))
	req.Header.Set("Content-Type", "application/zip")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("restore: %d %s", res.StatusCode, body)
	}
	var restored struct {
		Name  string `json:"name"`
		State struct {
			Messages int `json:"messages"`
		} `json:"state"`
	}
	json.Unmarshal(body, &restored)
	if restored.Name != "X" || restored.State.Messages != 60 {
		t.Fatalf("restored = %s", body)
	}
	if st := api.do("GET", "/api/streams/X/last"+q+"&subject=x.b.>", nil, &last); st != 200 || last["seq"] != float64(60) {
		t.Fatalf("after the restore: %d %v", st, last)
	}
	// A second restore of a stream that exists is refused.
	req, _ = http.NewRequest("POST", srv.URL+"/api/streams-restore"+q, bytes.NewReader(backup))
	req.Header.Set("Content-Type", "application/zip")
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode == 200 {
		t.Fatal("restoring over an existing stream succeeded")
	}
	req, _ = http.NewRequest("POST", srv.URL+"/api/streams-restore"+q, bytes.NewReader([]byte("not a zip")))
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("a non-zip body: %d", res.StatusCode)
	}

	// Sealed: no more writes, and the flag says so.
	if st := api.do("POST", "/api/streams/Y/seal"+q, nil, &y); st != 200 || y["sealed"] != true {
		t.Fatalf("seal: %d %v", st, y["sealed"])
	}
}
