package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// startNATS boots an embedded nats-server with JetStream on a random port.
func startNATS(t *testing.T) *natsserver.Server {
	t.Helper()
	opts := &natsserver.Options{
		Host:      "127.0.0.1",
		Port:      -1,
		JetStream: true,
		StoreDir:  t.TempDir(),
		NoLog:     true,
		NoSigs:    true,
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
	t     *testing.T
	base  string
	token string
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

func TestServerEndToEnd(t *testing.T) {
	ns := startNATS(t)
	srv := httptest.NewServer(createServer(nil, ""))
	defer srv.Close()
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

	// Delete a message in the middle and make sure the gap is skipped.
	if st := api.do("DELETE", "/api/streams/T/messages/10"+q, nil, nil); st != 200 {
		t.Fatalf("delete message: %d", st)
	}
	api.do("GET", "/api/streams/T/messages"+q+"&startSeq=5&limit=10", nil, &page)
	if len(page.Messages) != 9 || page.PageStart != 5 || page.PageEnd != 14 {
		t.Fatalf("page after delete = %d-%d (%d msgs)", page.PageStart, page.PageEnd, len(page.Messages))
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

	// Binary message in the live subject feed (published with a raw client:
	// the JSON publish API cannot carry invalid UTF-8).
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

func TestServerAuthToken(t *testing.T) {
	srv := httptest.NewServer(createServer(nil, "tok"))
	defer srv.Close()

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
