package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"nats-explorer/internal/auth"
	"nats-explorer/internal/settings"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"golang.org/x/crypto/bcrypt"
)

// startNATS boots an embedded nats-server with JetStream on a random port.
func startNATS(t *testing.T) *natsserver.Server {
	t.Helper()
	opts := &natsserver.Options{
		Host:      "127.0.0.1",
		Port:      -1,
		JetStream: true,
		// A domain so the domain routing of the API can be exercised.
		JetStreamDomain: "hub",
		StoreDir:        t.TempDir(),
		NoLog:           true,
		NoSigs:          true,
	}
	ns, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats-server did not start")
	}
	t.Cleanup(ns.Shutdown)
	return ns
}

type apiClient struct {
	t      *testing.T
	base   string
	token  string
	cookie *http.Cookie
	// basic is "user:password" for HTTP basic auth
	basic string
}

func (c *apiClient) do(method, path string, body interface{}, out interface{}) int {
	c.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	if c.basic != "" {
		user, pass, _ := strings.Cut(c.basic, ":")
		req.SetBasicAuth(user, pass)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if out != nil && res.StatusCode < 300 {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: bad json %q: %v", method, path, data, err)
		}
	}
	if res.StatusCode >= 300 {
		c.t.Logf("%s %s -> %d %s", method, path, res.StatusCode, data)
	}
	return res.StatusCode
}

// newTestServer starts the API on a random port and shuts the whole server
// down with the test: the listener, the subscription managers with their NATS
// connections, the persistent history and what the features started.
func newTestServer(t *testing.T, cfg serverConfig) *httptest.Server {
	t.Helper()
	app := createServer(nil, cfg)
	srv := httptest.NewServer(app)
	t.Cleanup(func() {
		srv.Close()
		app.Close()
	})
	return srv
}

func TestServerEndToEnd(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}

	// Connect
	var connResp struct {
		ID     string `json:"id"`
		Status struct {
			Connected bool `json:"connected"`
		} `json:"status"`
	}
	if st := api.do("POST", "/api/connect", map[string]interface{}{
		"id": "t1", "name": "test", "servers": []string{ns.ClientURL()}, "authMethod": "none",
	}, &connResp); st != 200 || !connResp.Status.Connected {
		t.Fatalf("connect failed: %d %+v", st, connResp)
	}
	q := "?connId=t1"

	// Stream + messages page via ordered consumer
	if st := api.do("POST", "/api/streams"+q, map[string]interface{}{"name": "T", "subjects": []string{"t.>"}}, nil); st != 200 {
		t.Fatalf("create stream: %d", st)
	}
	for i := 1; i <= 120; i++ {
		body := map[string]interface{}{"subject": fmt.Sprintf("t.%d", i%3), "payload": fmt.Sprintf(`{"i":%d}`, i)}
		if st := api.do("POST", "/api/publish"+q, body, nil); st != 200 {
			t.Fatalf("publish %d: %d", i, st)
		}
	}
	// Publishing is async; wait until the stream reports all messages.
	var info struct {
		State struct {
			Messages int    `json:"messages"`
			LastSeq  uint64 `json:"lastSeq"`
		} `json:"state"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for info.State.Messages < 120 && time.Now().Before(deadline) {
		api.do("GET", "/api/streams/T"+q, nil, &info)
		time.Sleep(50 * time.Millisecond)
	}
	if info.State.Messages != 120 {
		t.Fatalf("stream has %d messages", info.State.Messages)
	}

	var page struct {
		Messages  []map[string]interface{} `json:"messages"`
		PageStart uint64                   `json:"pageStart"`
		PageEnd   uint64                   `json:"pageEnd"`
	}
	api.do("GET", "/api/streams/T/messages"+q+"&limit=50", nil, &page)
	if page.PageStart != 71 || page.PageEnd != 120 || len(page.Messages) != 50 {
		t.Fatalf("newest page = %d-%d (%d msgs)", page.PageStart, page.PageEnd, len(page.Messages))
	}
	if seq := page.Messages[0]["seq"].(float64); seq != 71 {
		t.Errorf("first message seq = %v, want 71", seq)
	}
	if page.Messages[49]["payload"] != `{"i":120}` || page.Messages[49]["payloadType"] != "json" {
		t.Errorf("last message = %+v", page.Messages[49])
	}

	// The sequence at a point in time: before everything, and after the end.
	var at struct {
		Seq      uint64 `json:"seq"`
		FirstSeq uint64 `json:"firstSeq"`
		LastSeq  uint64 `json:"lastSeq"`
	}
	if st := api.do("GET", "/api/streams/T/seq"+q+"&time=0", nil, &at); st != 200 || at.Seq != at.FirstSeq {
		t.Fatalf("seq at time 0 = %d %+v", st, at)
	}
	if st := api.do("GET", "/api/streams/T/seq"+q+fmt.Sprintf("&time=%d", time.Now().Add(time.Hour).UnixMilli()), nil, &at); st != 200 || at.Seq != at.LastSeq+1 {
		t.Fatalf("seq past the end = %d %+v", st, at)
	}
	if st := api.do("GET", "/api/streams/T/seq"+q, nil, nil); st != 400 {
		t.Errorf("seq without time must be 400, got %d", st)
	}

	// Consumers can be edited after creation, but not their policies.
	if st := api.do("POST", "/api/streams/T/consumers"+q, map[string]interface{}{"name": "edit-me", "description": "before", "ackWait": 5e9}, nil); st != 200 {
		t.Fatalf("create consumer: %d", st)
	}
	var cinfo struct {
		Config struct {
			Description string `json:"description"`
			AckWait     int64  `json:"ackWait"`
			MaxDeliver  int    `json:"maxDeliver"`
		} `json:"config"`
	}
	if st := api.do("PUT", "/api/streams/T/consumers/edit-me"+q, map[string]interface{}{"description": "after", "maxDeliver": 7, "ackWait": 9e9}, &cinfo); st != 200 || cinfo.Config.Description != "after" || cinfo.Config.MaxDeliver != 7 || cinfo.Config.AckWait != 9e9 {
		t.Fatalf("update consumer = %d %+v", st, cinfo)
	}
	if st := api.do("PUT", "/api/streams/T/consumers/edit-me"+q, map[string]interface{}{"ackPolicy": "none"}, nil); st != 400 {
		t.Errorf("changing the ack policy must be rejected, got %d", st)
	}
	if st := api.do("DELETE", "/api/streams/T/consumers/edit-me"+q, nil, nil); st != 200 {
		t.Fatalf("delete consumer: %d", st)
	}

	// Delete a message in the middle and make sure the gap is skipped.
	if st := api.do("DELETE", "/api/streams/T/messages/10"+q, nil, nil); st != 200 {
		t.Fatalf("delete message: %d", st)
	}
	api.do("GET", "/api/streams/T/messages"+q+"&startSeq=5&limit=10", nil, &page)
	if len(page.Messages) != 9 || page.PageStart != 5 || page.PageEnd != 14 {
		t.Fatalf("page after delete = %d-%d (%d msgs)", page.PageStart, page.PageEnd, len(page.Messages))
	}

	// Numeric field over the stream's messages, per subject or overall.
	var ss struct {
		Points  [][2]float64 `json:"points"`
		Samples int          `json:"samples"`
		Scanned int          `json:"scanned"`
		FromSeq uint64       `json:"fromSeq"`
		ToSeq   uint64       `json:"toSeq"`
	}
	if st := api.do("GET", "/api/streams/T/series"+q+"&field=i&last=50&points=10", nil, &ss); st != 200 {
		t.Fatalf("stream series: %d", st)
	}
	if ss.FromSeq != 71 || ss.ToSeq != 120 || ss.Scanned != 50 || ss.Samples != 50 || len(ss.Points) < 10 || len(ss.Points) > 20 {
		t.Fatalf("stream series = %+v", ss)
	}
	if ss.Points[len(ss.Points)-1][1] != 120 {
		t.Errorf("last point must be i=120, got %v", ss.Points[len(ss.Points)-1])
	}
	if st := api.do("GET", "/api/streams/T/series"+q+"&field=i&subject=t.1&last=1000", nil, &ss); st != 200 || ss.Samples != 39 {
		t.Fatalf("stream series for t.1 = %d %+v (seq 10 was deleted)", st, ss)
	}
	if st := api.do("GET", "/api/streams/T/series"+q, nil, nil); st != 400 {
		t.Errorf("series without field must be 400, got %d", st)
	}

	// KV: PUT must work (it used to be POST-only and 405 from the UI).
	if st := api.do("POST", "/api/kv"+q, map[string]interface{}{"bucket": "cfg", "history": 3}, nil); st != 200 {
		t.Fatalf("create bucket: %d", st)
	}
	if st := api.do("PUT", "/api/kv/cfg/a.b"+q, map[string]string{"value": `{"x":1}`}, nil); st != 200 {
		t.Fatalf("kv put: %d", st)
	}
	var entry struct {
		Value       string `json:"value"`
		PayloadType string `json:"payloadType"`
		Revision    int    `json:"revision"`
	}
	api.do("GET", "/api/kv/cfg/a.b"+q, nil, &entry)
	if entry.Value != `{"x":1}` || entry.PayloadType != "json" || entry.Revision != 1 {
		t.Fatalf("kv entry = %+v", entry)
	}

	// Object store: raw body upload and byte-identical download.
	if st := api.do("POST", "/api/objectstore"+q, map[string]interface{}{"bucket": "files"}, nil); st != 200 {
		t.Fatalf("create store: %d", st)
	}
	blob := bytes.Repeat([]byte{0, 1, 2, 0xff}, 3000)
	req, _ := http.NewRequest("PUT", srv.URL+"/api/objectstore/files/blob.bin"+q, bytes.NewReader(blob))
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("upload: %v %v", err, res)
	}
	res.Body.Close()
	res, err = http.Get(srv.URL + "/api/objectstore/files/blob.bin" + q)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Equal(got, blob) {
		t.Fatalf("download differs: %d bytes vs %d", len(got), len(blob))
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "blob.bin") {
		t.Errorf("content-disposition = %q", cd)
	}

	// Binary publish shows up base64 encoded in the live feed.
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	// First frame is the connection list.
	ev := readEvent(t, ws, "connections")
	if conns, ok := ev["data"].([]interface{}); !ok || len(conns) != 1 {
		t.Fatalf("connections event = %v", ev)
	}

	// The tree follows the tab's view: with everything expanded every node
	// arrives, branches carry their subtree totals and child counts.
	ws.WriteJSON(map[string]interface{}{"type": "view", "all": true})
	entries := map[string]map[string]interface{}{}
	deadline = time.Now().Add(5 * time.Second)
	for entries["t.1"] == nil && time.Now().Before(deadline) {
		ev = readEvent(t, ws, "subject-tree")
		for _, e := range ev["data"].([]interface{}) {
			em := e.(map[string]interface{})
			entries[em["s"].(string)] = em
		}
	}
	if e := entries["t.1"]; e == nil || e["n"].(float64) < 1 || e["pt"] != "json" || e["p"] == "" {
		t.Fatalf("tree entry t.1 = %v", entries["t.1"])
	}
	if e := entries["t"]; e == nil || e["c"].(float64) < 3 || e["t"].(float64) < 120 || e["n"] != nil && e["n"].(float64) != 0 {
		t.Fatalf("branch entry t = %v", entries["t"])
	}
	// Collapsing everything removes the children again.
	ws.WriteJSON(map[string]interface{}{"type": "view", "all": false, "paths": []string{}})
	removed := map[string]bool{}
	deadline = time.Now().Add(5 * time.Second)
	for !removed["t.1"] && time.Now().Before(deadline) {
		ev = readEvent(t, ws, "subject-tree")
		if list, ok := ev["removed"].([]interface{}); ok {
			for _, r := range list {
				removed[r.(string)] = true
			}
		}
	}
	if !removed["t.1"] || removed["t"] {
		t.Fatalf("collapse: removed = %v", removed)
	}
	// A filter shows the paths of matching subjects regardless of expansion.
	ws.WriteJSON(map[string]interface{}{"type": "view", "filter": "T.2"})
	entries = map[string]map[string]interface{}{}
	deadline = time.Now().Add(5 * time.Second)
	for entries["t.2"] == nil && time.Now().Before(deadline) {
		ev = readEvent(t, ws, "subject-tree")
		for _, e := range ev["data"].([]interface{}) {
			em := e.(map[string]interface{})
			entries[em["s"].(string)] = em
		}
	}
	if entries["t.2"] == nil || entries["t.1"] != nil {
		t.Fatalf("filter: entries = %v", entries)
	}
	ws.WriteJSON(map[string]interface{}{"type": "view", "all": true})

	// KV watch over the websocket.
	ws.WriteJSON(map[string]string{"type": "kv-watch", "connId": "t1", "bucket": "cfg"})
	time.Sleep(200 * time.Millisecond) // let the watcher subscribe
	api.do("PUT", "/api/kv/cfg/a.b"+q, map[string]string{"value": "v2"}, nil)
	ev = readEvent(t, ws, "kv-update")
	entryMap := ev["entry"].(map[string]interface{})
	if entryMap["key"] != "a.b" || entryMap["value"] != "v2" || entryMap["revision"].(float64) != 2 {
		t.Fatalf("kv-update = %v", ev)
	}

	// Stream tail over the websocket.
	ws.WriteJSON(map[string]string{"type": "stream-tail", "connId": "t1", "stream": "T"})
	time.Sleep(200 * time.Millisecond)
	api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": "t.tail", "payload": "live!"}, nil)
	ev = readEvent(t, ws, "stream-msg")
	msg := ev["message"].(map[string]interface{})
	if msg["subject"] != "t.tail" || msg["payload"] != "live!" || msg["seq"].(float64) != 121 {
		t.Fatalf("stream-msg = %v", ev)
	}

	// Recorded history: exact subject oldest first, branch newest first.
	// (Subjects of the stream T are also re-delivered by the JetStream
	// consumers used above, so use fresh ones here.)
	for i := 1; i <= 12; i++ {
		api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": fmt.Sprintf("h.%d", i%2), "payload": fmt.Sprintf("%d", i)}, nil)
	}
	var hist struct {
		Messages []map[string]interface{} `json:"messages"`
		Branch   []map[string]interface{} `json:"branch"`
	}
	// Wait for both subjects: the search below expects the newest message of
	// all twelve, which is the last one on h.0.
	var even struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if st := api.do("GET", "/api/history"+q+"&subject=h.1&limit=4&branchLimit=5", nil, &hist); st != 200 {
			t.Fatalf("history: %d", st)
		}
		api.do("GET", "/api/history"+q+"&subject=h.0&limit=1", nil, &even)
		if len(hist.Messages) == 4 && hist.Messages[3]["payload"] == "11" && len(even.Messages) == 1 && even.Messages[0]["payload"] == "12" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(hist.Messages) != 4 || hist.Messages[0]["payload"] != "5" || hist.Messages[3]["payload"] != "11" {
		t.Fatalf("subject history = %v", hist.Messages)
	}
	if hist.Messages[0]["connId"] != "t1" || hist.Messages[0]["sequence"].(float64) <= 0 {
		t.Errorf("history message lacks connId or sequence: %v", hist.Messages[0])
	}
	if len(hist.Branch) != 0 {
		t.Errorf("h.1 has no subjects below it, got %d", len(hist.Branch))
	}
	// Search over the recorded messages: subject or payload, newest first.
	var found struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	if st := api.do("GET", "/api/history/search"+q+"&subject=h&q=1&limit=3", nil, &found); st != 200 || len(found.Messages) != 3 || found.Messages[0]["payload"] != "12" {
		t.Fatalf("history search = %d %v", st, found.Messages)
	}
	if st := api.do("GET", "/api/history/search"+q+"&subject=h.0&q=zzz", nil, &found); st != 200 || len(found.Messages) != 0 {
		t.Fatalf("search without hits = %d %v", st, found.Messages)
	}

	// Numeric series over the history, downsampled to min/max buckets.
	for i := 0; i < 40; i++ {
		api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": "series.x", "payload": fmt.Sprintf(`{"m":{"v":%d}}`, (i*7)%40)}, nil)
	}
	var series struct {
		Points  [][2]float64 `json:"points"`
		Samples int          `json:"samples"`
		Last    uint64       `json:"last"`
	}
	deadline = time.Now().Add(2 * time.Second)
	for series.Samples < 40 && time.Now().Before(deadline) {
		api.do("GET", "/api/history/series"+q+"&subject=series.x&field=m.v&points=10", nil, &series)
		time.Sleep(20 * time.Millisecond)
	}
	if series.Samples != 40 || len(series.Points) < 10 || len(series.Points) > 20 || series.Last == 0 {
		t.Fatalf("series = %d samples, %d points, last %d", series.Samples, len(series.Points), series.Last)
	}
	maxV := 0.0
	for _, p := range series.Points {
		maxV = max(maxV, p[1])
	}
	if maxV != 39 {
		t.Errorf("downsampling must keep the peaks, max = %v", maxV)
	}
	if st := api.do("GET", "/api/history/series"+q+"&subject=series.x", nil, nil); st != 400 {
		t.Errorf("series without field must be 400, got %d", st)
	}
	if st := api.do("GET", "/api/history?subject=h&branchLimit=5", nil, &hist); st != 200 || len(hist.Branch) != 5 || hist.Branch[0]["payload"] != "12" || hist.Branch[4]["payload"] != "8" {
		t.Fatalf("branch history across connections: %d %v", st, hist.Branch)
	}
	if before := hist.Branch[4]["sequence"].(float64); before > 0 {
		api.do("GET", "/api/history"+q+fmt.Sprintf("&subject=h.0&limit=2&before=%d", int(before)), nil, &hist)
		if len(hist.Messages) != 2 || hist.Messages[1]["payload"] != "6" {
			t.Fatalf("paging before seq %v = %v", before, hist.Messages)
		}
	}

	// Counters arrive once a second and include the history size.
	ev = readEvent(t, ws, "stats")
	if stats := ev["data"].(map[string]interface{}); stats["received"].(float64) < 121 || stats["history"].(map[string]interface{})["messages"].(float64) < 121 {
		t.Fatalf("stats = %v", stats)
	}

	// Binary message in the live subject feed (published with a raw client:
	// the JSON publish API cannot carry invalid UTF-8). The feed only carries
	// the focused subject, so focus first.
	ws.WriteJSON(map[string]interface{}{"type": "focus", "subjects": []string{"bin", "also.this"}})
	time.Sleep(100 * time.Millisecond)
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	nc.Publish("bin.x", []byte{0xff, 0xfe, 0x00})
	nc.Flush()
	var binMsg map[string]interface{}
	deadline = time.Now().Add(5 * time.Second)
	for binMsg == nil && time.Now().Before(deadline) {
		ev = readEvent(t, ws, "message-batch")
		for _, m := range ev["data"].([]interface{}) {
			if mm := m.(map[string]interface{}); mm["subject"] == "bin.x" {
				binMsg = mm
			}
		}
	}
	if binMsg == nil {
		t.Fatal("bin.x never arrived in the live feed")
	}
	if binMsg["payloadType"] != "binary" || binMsg["payload"] != "//4A" || binMsg["size"].(float64) != 3 {
		t.Errorf("binary payload = %v", binMsg)
	}
	// Every focused subject is streamed; unfocused ones stay out of the feed
	// but land in the history.
	nc.Publish("also.this", []byte("second"))
	nc.Publish("elsewhere.y", []byte("quiet"))
	nc.Flush()
	var second map[string]interface{}
	deadline = time.Now().Add(5 * time.Second)
	for second == nil && time.Now().Before(deadline) {
		ev = readEvent(t, ws, "message-batch")
		for _, m := range ev["data"].([]interface{}) {
			if mm := m.(map[string]interface{}); mm["subject"] == "also.this" {
				second = mm
			}
		}
	}
	if second == nil || second["payload"] != "second" {
		t.Fatalf("second focused subject not streamed: %v", second)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", "/api/history"+q+"&subject=elsewhere.y", nil, &hist)
		if len(hist.Messages) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(hist.Messages) != 1 || hist.Messages[0]["payload"] != "quiet" {
		t.Fatalf("unfocused message missing from history: %v", hist.Messages)
	}
	if st := api.do("DELETE", "/api/history"+q, nil, nil); st != 200 {
		t.Fatalf("clear history: %d", st)
	}
	api.do("GET", "/api/history"+q+"&subject=elsewhere.y", nil, &hist)
	if len(hist.Messages) != 0 {
		t.Fatalf("history not cleared: %v", hist.Messages)
	}

	// Repeated request run with template variables against an echo responder.
	echo, _ := nc.Subscribe("echo.*", func(m *nats.Msg) { m.Respond(m.Data) })
	defer echo.Unsubscribe()
	nc.Flush()
	var run struct {
		Sent, OK, Errors int
		Replies          []struct {
			Subject string
			Payload string
		}
		Latency *struct{ P50, Max float64 }
	}
	if st := api.do("POST", "/api/run"+q, map[string]interface{}{"mode": "request", "subject": "echo.{{i}}", "payload": `{"n":{{i}},"r":{{rand:1-3}}}`, "count": 20, "concurrency": 4, "timeout": 2000}, &run); st != 200 {
		t.Fatalf("run: %d", st)
	}
	if run.Sent != 20 || run.OK != 20 || run.Errors != 0 || len(run.Replies) != 5 || run.Latency == nil || run.Latency.Max <= 0 {
		t.Fatalf("run result = %+v", run)
	}
	if !strings.HasPrefix(run.Replies[0].Subject, "_INBOX.") || !strings.Contains(run.Replies[0].Payload, `"n":`) {
		t.Errorf("run reply = %+v", run.Replies[0])
	}
	// No responder: every attempt is an error, the run still completes.
	if st := api.do("POST", "/api/run"+q, map[string]interface{}{"mode": "request", "subject": "nobody.home", "count": 3, "timeout": 500}, &run); st != 200 || run.Errors != 3 {
		t.Fatalf("run without responders: status %d, %+v", st, run)
	}

	// JetStream domains: a connection configured for the "hub" domain sees
	// the same streams; a per-call override to a domain nobody serves fails.
	if st := api.do("POST", "/api/connect", map[string]interface{}{
		"id": "t2", "name": "hub-domain", "servers": []string{ns.ClientURL()}, "authMethod": "none", "jsDomain": "hub",
	}, &connResp); st != 200 {
		t.Fatalf("connect t2: %d", st)
	}
	var domainStreams []struct {
		Name string `json:"name"`
	}
	st := api.do("GET", "/api/streams?connId=t2", nil, &domainStreams)
	sawT := false
	for _, s := range domainStreams {
		sawT = sawT || s.Name == "T"
	}
	if st != 200 || !sawT {
		t.Fatalf("streams via domain: %d %+v", st, domainStreams)
	}
	if st := api.do("GET", "/api/streams"+q+"&domain=nowhere", nil, nil); st == 200 {
		t.Fatal("unknown domain override must fail")
	}
	var domainInfo struct {
		JsAccount struct {
			Domain string `json:"domain"`
		} `json:"jsAccount"`
	}
	api.do("GET", "/api/server/t2", nil, &domainInfo)
	if domainInfo.JsAccount.Domain != "hub" {
		t.Errorf("account info domain = %q, want hub", domainInfo.JsAccount.Domain)
	}
	api.do("POST", "/api/disconnect", map[string]string{"connId": "t2"}, nil)

	// Subscriptions can be changed on a live connection: the feed restarts
	// with the new patterns, the status reports them, history starts over.
	var subResp struct {
		Status struct {
			Subscriptions []string `json:"subscriptions"`
		} `json:"status"`
	}
	if st := api.do("PUT", "/api/connections/t1/subscriptions", map[string]interface{}{"subscriptions": []string{" only.> ", "only.>", "also.here"}}, &subResp); st != 200 {
		t.Fatalf("set subscriptions: %d", st)
	}
	if got := subResp.Status.Subscriptions; len(got) != 2 || got[0] != "only.>" || got[1] != "also.here" {
		t.Fatalf("subscriptions after change = %v", got)
	}
	if st := api.do("PUT", "/api/connections/t1/subscriptions", map[string]interface{}{"subscriptions": []string{"bad subject"}}, nil); st != 400 {
		t.Fatalf("whitespace in a subject must be rejected, got %d", st)
	}
	if st := api.do("PUT", "/api/connections/nope/subscriptions", map[string]interface{}{"subscriptions": []string{">"}}, nil); st != 404 {
		t.Fatalf("unknown connection must be 404, got %d", st)
	}
	// The tab's tree starts over: a full update arrives without the old subjects.
	ev = readEvent(t, ws, "subject-tree")
	deadline = time.Now().Add(5 * time.Second)
	for ev["full"] != true && time.Now().Before(deadline) {
		ev = readEvent(t, ws, "subject-tree")
	}
	if ev["full"] != true {
		t.Fatalf("no full tree update after the subscription change: %v", ev)
	}
	if list, _ := ev["data"].([]interface{}); len(list) != 0 {
		t.Fatalf("full update after restart must be empty, got %v", list)
	}
	time.Sleep(100 * time.Millisecond) // let the new subscriptions settle
	nc.Publish("only.a", []byte("in"))
	nc.Publish("elsewhere.z", []byte("out"))
	nc.Flush()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", "/api/history"+q+"&subject=only.a", nil, &hist)
		if len(hist.Messages) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(hist.Messages) != 1 {
		t.Fatalf("message on the new pattern not recorded: %v", hist.Messages)
	}
	api.do("GET", "/api/history"+q+"&subject=elsewhere.z", nil, &hist)
	if len(hist.Messages) != 0 {
		t.Fatalf("message outside the patterns was recorded: %v", hist.Messages)
	}
	api.do("GET", "/api/history"+q+"&subject=h.1", nil, &hist)
	if len(hist.Messages) != 0 {
		t.Fatal("history must start over when the patterns change")
	}

	// Server info probe
	var srvInfo struct {
		JetStream bool    `json:"jetstream"`
		RTT       float64 `json:"rttMs"`
		Version   string  `json:"version"`
	}
	api.do("GET", "/api/server/t1", nil, &srvInfo)
	if !srvInfo.JetStream || srvInfo.Version == "" {
		t.Fatalf("server info = %+v", srvInfo)
	}

	// Disconnect cleans up
	if st := api.do("POST", "/api/disconnect", map[string]string{"connId": "t1"}, nil); st != 200 {
		t.Fatalf("disconnect: %d", st)
	}
	if st := api.do("GET", "/api/streams"+q, nil, nil); st != 400 {
		t.Fatalf("after disconnect streams should fail with 400, got %d", st)
	}
}

// With HISTORY_DB the history reaches the database: time ranges, search
// and series over a range read from SQLite.
func TestServerPersistentHistory(t *testing.T) {
	ns := startNATS(t)
	dbPath := filepath.Join(t.TempDir(), "history.db")
	srv := newTestServer(t, serverConfig{historyDB: dbPath, historyRetention: time.Hour, historyManaged: true})
	api := &apiClient{t: t, base: srv.URL}
	var app struct {
		HistoryDb        bool   `json:"historyDb"`
		HistoryRetention string `json:"historyRetention"`
	}
	api.do("GET", "/api/app", nil, &app)
	if !app.HistoryDb || app.HistoryRetention != "1h0m0s" {
		t.Fatalf("app info = %+v", app)
	}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "p1", "name": "p", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	q := "?connId=p1"
	start := time.Now().UnixMilli() - 1000
	for i := 1; i <= 6; i++ {
		api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": fmt.Sprintf("db.%d", i%2), "payload": fmt.Sprintf(`{"v":%d}`, i)}, nil)
	}
	var rng struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(rng.Messages) < 6 && time.Now().Before(deadline) {
		api.do("GET", "/api/history/range"+q+fmt.Sprintf("&subject=db&branch=1&from=%d", start), nil, &rng)
		time.Sleep(100 * time.Millisecond)
	}
	if len(rng.Messages) != 6 || rng.Messages[0]["payload"] != `{"v":6}` {
		t.Fatalf("range = %v", rng.Messages)
	}
	if st := api.do("GET", "/api/history/range"+q+fmt.Sprintf("&subject=db.1&from=%d", start), nil, &rng); st != 200 || len(rng.Messages) != 3 {
		t.Fatalf("exact range = %d %v", st, rng.Messages)
	}
	if st := api.do("GET", "/api/history/search"+q+fmt.Sprintf("&subject=db&q=%%22v%%22%%3A4&from=%d", start), nil, &rng); st != 200 || len(rng.Messages) != 1 {
		t.Fatalf("db search = %d %v", st, rng.Messages)
	}
	var series struct {
		Samples int `json:"samples"`
	}
	if st := api.do("GET", "/api/history/series"+q+fmt.Sprintf("&subject=db.0&field=v&from=%d", start), nil, &series); st != 200 || series.Samples != 3 {
		t.Fatalf("db series = %d %+v", st, series)
	}
	if st := api.do("GET", "/api/history/range"+q+"&subject=db", nil, nil); st != 400 {
		t.Errorf("range without time must be 400, got %d", st)
	}
	api.do("POST", "/api/disconnect-all", nil, nil)
}

// Saved connections flagged autoConnect open when the server starts, and
// /metrics reports them.
func TestServerAutoConnectAndMetrics(t *testing.T) {
	ns := startNATS(t)
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := json.Marshal([]map[string]interface{}{
		{"id": "auto", "name": "Auto", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"auto.>"}, "sysTopics": map[string]bool{"kv": true}, "autoConnect": true},
		{"id": "manual", "name": "Manual", "servers": []string{ns.ClientURL()}, "authMethod": "none"},
	})
	if err := store.Set(settings.ConnectionsKey, saved); err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, serverConfig{mode: "server", settings: store, autoConnect: true})
	api := &apiClient{t: t, base: srv.URL}

	var conns []struct {
		ID            string   `json:"id"`
		Connected     bool     `json:"connected"`
		Subscriptions []string `json:"subscriptions"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", "/api/connections", nil, &conns)
		if len(conns) == 1 && conns[0].Connected {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(conns) != 1 || conns[0].ID != "auto" || !conns[0].Connected || strings.Join(conns[0].Subscriptions, ",") != "auto.>,$KV.>" {
		t.Fatalf("auto-connected = %+v", conns)
	}

	res, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	text := string(body)
	for _, want := range []string{`nats_explorer_connections{state="connected"} 1`, `nats_explorer_messages_received_total{conn="auto",name="Auto"}`, "nats_explorer_ws_clients 0", "# TYPE nats_explorer_subjects gauge"} {
		if !strings.Contains(text, want) {
			t.Errorf("metrics lack %q:\n%s", want, text)
		}
	}
	api.do("POST", "/api/disconnect-all", nil, nil)
}

func TestServerAuthToken(t *testing.T) {
	srv := newTestServer(t, serverConfig{authToken: "tok"})

	var info struct {
		Required bool `json:"required"`
	}
	(&apiClient{t: t, base: srv.URL}).do("GET", "/api/auth", nil, &info)
	if !info.Required {
		t.Fatal("/api/auth must report required=true")
	}
	if st := (&apiClient{t: t, base: srv.URL}).do("GET", "/api/connections", nil, nil); st != 401 {
		t.Fatalf("without token: %d, want 401", st)
	}
	if st := (&apiClient{t: t, base: srv.URL, token: "tok"}).do("GET", "/api/connections", nil, nil); st != 200 {
		t.Fatalf("with token: %d, want 200", st)
	}
	if _, res, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil); err == nil || res == nil || res.StatusCode != 401 {
		t.Fatalf("ws without token should be rejected with 401, got err=%v res=%v", err, res)
	}
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?token=tok", nil)
	if err != nil {
		t.Fatalf("ws with token: %v", err)
	}
	c.Close()
}

// In users mode a login sets a cookie that carries the API and the
// websocket; viewers are turned away from writes.
func TestServerUsersAndRoles(t *testing.T) {
	adminHash, _ := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	viewerHash, _ := bcrypt.GenerateFromPassword([]byte("look"), bcrypt.MinCost)
	users, err := auth.ParseUsers(strings.NewReader("alice:admin:" + string(adminHash) + "\nbob:viewer:" + string(viewerHash)))
	if err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, serverConfig{users: users})

	var info struct {
		Mode          string `json:"mode"`
		Authenticated bool   `json:"authenticated"`
		Role          string `json:"role"`
	}
	(&apiClient{t: t, base: srv.URL}).do("GET", "/api/auth", nil, &info)
	if info.Mode != "users" || info.Authenticated {
		t.Fatalf("anonymous /api/auth = %+v", info)
	}

	login := func(user, pass string) *http.Cookie {
		body, _ := json.Marshal(map[string]string{"user": user, "password": pass})
		res, err := http.Post(srv.URL+"/api/login", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("login %s: %d", user, res.StatusCode)
		}
		for _, c := range res.Cookies() {
			if c.Name == auth.CookieName {
				return c
			}
		}
		t.Fatalf("login %s set no session cookie", user)
		return nil
	}
	if res, _ := http.Post(srv.URL+"/api/login", "application/json", strings.NewReader(`{"user":"bob","password":"wrong"}`)); res.StatusCode != 401 {
		t.Fatalf("wrong password: %d", res.StatusCode)
	}

	bob := &apiClient{t: t, base: srv.URL, cookie: login("bob", "look")}
	bob.do("GET", "/api/auth", nil, &info)
	if !info.Authenticated || info.Role != "viewer" {
		t.Fatalf("bob /api/auth = %+v", info)
	}
	if st := bob.do("GET", "/api/connections", nil, nil); st != 200 {
		t.Fatalf("viewer read: %d", st)
	}
	if st := bob.do("DELETE", "/api/history", nil, nil); st != 403 {
		t.Fatalf("viewer write: %d, want 403", st)
	}
	alice := &apiClient{t: t, base: srv.URL, cookie: login("alice", "secret")}
	if st := alice.do("DELETE", "/api/history", nil, nil); st != 204 && st != 200 {
		t.Fatalf("admin write: %d", st)
	}

	// the websocket rides on the cookie, no token in the URL
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	if _, res, err := websocket.DefaultDialer.Dial(wsURL, nil); err == nil || res == nil || res.StatusCode != 401 {
		t.Fatalf("ws without cookie: err=%v res=%v", err, res)
	}
	c, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Cookie": {bob.cookie.String()}})
	if err != nil {
		t.Fatalf("ws with cookie: %v", err)
	}
	c.Close()

	// basic auth for scrapers and scripts
	req, _ := http.NewRequest("GET", srv.URL+"/metrics", nil)
	req.SetBasicAuth("bob", "look")
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != 200 {
		t.Fatalf("metrics with basic auth: %v %v", err, res)
	}

	if st := bob.do("POST", "/api/logout", nil, nil); st != 204 {
		t.Fatalf("logout: %d", st)
	}
	if st := bob.do("GET", "/api/connections", nil, nil); st != 401 {
		t.Fatalf("after logout: %d, want 401", st)
	}
}

func readEvent(t *testing.T, ws *websocket.Conn, wantType string) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ws.SetReadDeadline(deadline)
		_, data, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %s: %v", wantType, err)
		}
		var ev map[string]interface{}
		if err := json.Unmarshal(data, &ev); err != nil {
			continue
		}
		if ev["type"] == wantType {
			return ev
		}
	}
	t.Fatalf("no %s event within deadline", wantType)
	return nil
}

func TestServerSettingsAPI(t *testing.T) {
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, serverConfig{mode: "desktop", settings: store})
	api := &apiClient{t: t, base: srv.URL}

	var app struct {
		Mode, Storage, Secrets, ConfigDir string
	}
	api.do("GET", "/api/app", nil, &app)
	if app.Mode != "desktop" || app.Storage != "file" || app.Secrets != "file" || app.ConfigDir != dir {
		t.Fatalf("app info = %+v", app)
	}

	conns := []map[string]interface{}{{"id": "c1", "name": "Prod", "authMethod": "token", "token": "sekrit"}}
	if st := api.do("PUT", "/api/settings/ne.connections.v2", conns, nil); st != 200 {
		t.Fatalf("put connections: %d", st)
	}
	if st := api.do("PUT", "/api/settings/ne.theme", "light", nil); st != 200 {
		t.Fatalf("put theme: %d", st)
	}
	if st := api.do("PUT", "/api/settings/other.key", "x", nil); st != 400 {
		t.Fatalf("foreign key must be rejected, got %d", st)
	}
	var all struct {
		Entries map[string]json.RawMessage `json:"entries"`
	}
	api.do("GET", "/api/settings", nil, &all)
	if string(all.Entries["ne.theme"]) != `"light"` || !strings.Contains(string(all.Entries["ne.connections.v2"]), `"sekrit"`) {
		t.Fatalf("entries = %v", all.Entries)
	}
	file, _ := os.ReadFile(store.Path())
	if strings.Contains(string(file), "sekrit") {
		t.Fatal("settings.json must not contain the token")
	}
	if st := api.do("DELETE", "/api/settings/ne.theme", nil, nil); st != 200 {
		t.Fatalf("delete: %d", st)
	}
	all.Entries = nil // json.Unmarshal merges into an existing map
	api.do("GET", "/api/settings", nil, &all)
	if _, ok := all.Entries["ne.theme"]; ok {
		t.Fatal("theme still present after delete")
	}
}

// startNATSWithSystemAccount runs a server whose $SYS account can be used by
// user sys/pw; unauthenticated clients land in the APP account.
func startNATSWithSystemAccount(t *testing.T) *natsserver.Server {
	t.Helper()
	sysAcc := natsserver.NewAccount("$SYS")
	appAcc := natsserver.NewAccount("APP")
	opts := &natsserver.Options{
		Host:          "127.0.0.1",
		Port:          -1,
		JetStream:     true,
		StoreDir:      t.TempDir(),
		NoLog:         true,
		NoSigs:        true,
		Accounts:      []*natsserver.Account{sysAcc, appAcc},
		SystemAccount: "$SYS",
		Users: []*natsserver.User{
			{Username: "sys", Password: "pw", Account: sysAcc},
			{Username: "app", Password: "app", Account: appAcc},
		},
		NoAuthUser: "app",
	}
	ns, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats-server did not start")
	}
	acc, err := ns.LookupAccount("APP")
	if err != nil {
		t.Fatal(err)
	}
	if err := acc.EnableJetStream(nil, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ns.Shutdown)
	return ns
}

func TestClusterOverview(t *testing.T) {
	ns := startNATSWithSystemAccount(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}

	type overview struct {
		Source  string `json:"source"`
		Servers []struct {
			Name      string `json:"name"`
			JetStream bool   `json:"jetstream"`
			Cores     int    `json:"cores"`
		} `json:"servers"`
		Streams []struct {
			Account string `json:"account"`
			Name    string `json:"name"`
			Storage string `json:"storage"`
		} `json:"streams"`
		Errors []string `json:"errors"`
	}

	// Without system credentials: monitoring fallback (no HTTP monitoring here → error listed, nothing crashes).
	// The monitoring port is pinned to the embedded server's client port, which speaks NATS and not HTTP.
	// Left at the default the fallback would call 127.0.0.1:8222 and pick up whatever NATS the developer
	// happens to be running.
	monPort := ns.Addr().(*net.TCPAddr).Port
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "c1", "name": "plain", "servers": []string{ns.ClientURL()}, "authMethod": "none", "monitoringPort": monPort}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	var ov overview
	if st := api.do("GET", "/api/cluster/c1/overview", nil, &ov); st != 200 || ov.Source != "monitoring" || len(ov.Errors) == 0 {
		t.Fatalf("fallback overview: %d %+v", st, ov)
	}

	// With system credentials: every server answers the ping, streams are listed with their account.
	var conn struct {
		Status struct {
			SysAccount bool   `json:"sysAccount"`
			SysError   string `json:"sysError"`
		} `json:"status"`
	}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "c2", "name": "sys", "servers": []string{ns.ClientURL()}, "authMethod": "none", "sysAuthMethod": "userpass", "sysUser": "sys", "sysPass": "pw"}, &conn); st != 200 || !conn.Status.SysAccount {
		t.Fatalf("connect with system account: %d %+v", st, conn)
	}
	if st := api.do("POST", "/api/streams?connId=c2", map[string]interface{}{"name": "C", "subjects": []string{"c.>"}, "storage": "memory"}, nil); st != 200 {
		t.Fatalf("create stream: %d", st)
	}
	ov = overview{}
	if st := api.do("GET", "/api/cluster/c2/overview", nil, &ov); st != 200 {
		t.Fatalf("overview: %d", st)
	}
	if ov.Source != "system" || len(ov.Servers) != 1 || ov.Servers[0].Name != ns.Name() || !ov.Servers[0].JetStream || ov.Servers[0].Cores == 0 {
		t.Fatalf("servers = %+v (errors %v)", ov.Servers, ov.Errors)
	}
	found := false
	for _, s := range ov.Streams {
		if s.Name == "C" && s.Account == "APP" && s.Storage == "memory" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stream C not in overview: %+v (errors %v)", ov.Streams, ov.Errors)
	}

	// Wrong system credentials: the main connection still works, the status explains.
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "c3", "name": "badsys", "servers": []string{ns.ClientURL()}, "authMethod": "none", "sysAuthMethod": "userpass", "sysUser": "sys", "sysPass": "wrong"}, &conn); st != 200 || conn.Status.SysAccount || conn.Status.SysError == "" {
		t.Fatalf("connect with bad system credentials: %d %+v", st, conn)
	}
	api.do("POST", "/api/disconnect-all", nil, nil)
}
