package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// A bundle carries a range of recorded messages plus the server snapshot,
// and importing it opens a read-only connection every module can read.
func TestServerSupportBundle(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "Bundle Source", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"b.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	for i := 0; i < 6; i++ {
		nc.Publish("b.line.temp", []byte(fmt.Sprintf(`{"temp": %d}`, 20+i)))
		nc.Publish("b.line.state", []byte("running"))
	}
	// Not valid UTF-8, so it travels base64 encoded and must survive that.
	nc.Publish("b.raw", []byte{0xff, 0xfe, 0xfd})
	nc.Flush()
	time.Sleep(600 * time.Millisecond)

	// Export
	res, err := http.Get(srv.URL + "/api/bundle?connId=c1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("export = %d: %s", res.StatusCode, body)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "bundle-source") || !strings.HasSuffix(cd, `.zip"`) {
		t.Errorf("content-disposition = %q", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	entries := map[string]int64{}
	for _, f := range zr.File {
		entries[f.Name] = int64(f.UncompressedSize64)
	}
	for _, want := range []string{"manifest.json", "messages.jsonl", "server.json", "streams.json", "kv.json"} {
		if _, ok := entries[want]; !ok {
			t.Fatalf("bundle lacks %s, has %v", want, entries)
		}
	}
	var man struct {
		Format     int `json:"format"`
		Messages   int `json:"messages"`
		Subjects   int `json:"subjects"`
		Connection struct {
			Name string `json:"name"`
		} `json:"connection"`
	}
	readEntry(t, zr, "manifest.json", &man)
	if man.Format != 1 || man.Messages != 13 || man.Subjects != 3 || man.Connection.Name != "Bundle Source" {
		t.Fatalf("manifest = %+v", man)
	}
	// The messages are stored oldest first, so an import replays them in order.
	lines := readLines(t, zr, "messages.jsonl")
	if len(lines) != 13 {
		t.Fatalf("messages.jsonl = %d lines", len(lines))
	}
	var first, last struct {
		Timestamp int64 `json:"timestamp"`
	}
	json.Unmarshal(lines[0], &first)
	json.Unmarshal(lines[len(lines)-1], &last)
	if first.Timestamp > last.Timestamp {
		t.Error("messages must be stored oldest first")
	}

	// Import
	var body2 bytes.Buffer
	mw := multipart.NewWriter(&body2)
	part, _ := mw.CreateFormFile("file", "bundle.zip")
	part.Write(body)
	mw.Close()
	req, _ := http.NewRequest("POST", srv.URL+"/api/bundle/import", &body2)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var imported struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Messages int    `json:"messages"`
	}
	json.NewDecoder(res.Body).Decode(&imported)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(imported.ID, "bundle-") || imported.Messages != 13 {
		t.Fatalf("import = %d %+v", res.StatusCode, imported)
	}
	if imported.Name != "Bundle: Bundle Source" {
		t.Errorf("imported name = %q", imported.Name)
	}

	// It shows up as a read-only connection.
	var conns []struct {
		ID        string `json:"id"`
		Bundle    bool   `json:"bundle"`
		Connected bool   `json:"connected"`
	}
	api.do("GET", "/api/connections", nil, &conns)
	var found bool
	for _, c := range conns {
		if c.ID == imported.ID {
			found = true
			if !c.Bundle || c.Connected {
				t.Errorf("bundle connection = %+v", c)
			}
		}
	}
	if !found {
		t.Fatalf("imported bundle not listed: %+v", conns)
	}

	// Its history is readable like any other connection's, binary included.
	var hist struct {
		Messages []struct {
			Payload     string `json:"payload"`
			PayloadType string `json:"payloadType"`
		} `json:"messages"`
		Branch []struct{ Subject string } `json:"branch"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", "/api/history?subject=b.line.temp&connId="+imported.ID, nil, &hist)
		if len(hist.Messages) == 6 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(hist.Messages) != 6 {
		t.Fatalf("bundle history = %d messages, want 6", len(hist.Messages))
	}
	api.do("GET", "/api/history?subject=b.raw&connId="+imported.ID, nil, &hist)
	if len(hist.Messages) != 1 || hist.Messages[0].PayloadType != "binary" || hist.Messages[0].Payload != "//79" {
		t.Fatalf("binary payload came back as %+v", hist.Messages)
	}

	// Nothing can be published through it.
	if st := api.do("POST", "/api/publish?connId="+imported.ID, map[string]interface{}{"subject": "b.x", "payload": "no"}, nil); st < 400 {
		t.Fatalf("publishing into a bundle = %d, want an error", st)
	}

	// The manifest and the snapshots are served back.
	var opened struct {
		Manifest struct {
			Messages int `json:"messages"`
		} `json:"manifest"`
		Server map[string]interface{} `json:"server"`
	}
	api.do("GET", "/api/bundle/"+imported.ID, nil, &opened)
	if opened.Manifest.Messages != 13 || opened.Server == nil {
		t.Fatalf("opened bundle = %+v", opened)
	}

	// Closing it removes the connection and its history.
	if st := api.do("DELETE", "/api/bundle/"+imported.ID, nil, nil); st != 204 {
		t.Fatalf("closing = %d", st)
	}
	api.do("GET", "/api/connections", nil, &conns)
	for _, c := range conns {
		if c.ID == imported.ID {
			t.Fatal("the bundle is still listed after it was closed")
		}
	}
	if st := api.do("GET", "/api/bundle/"+imported.ID, nil, nil); st != 404 {
		t.Fatalf("closed bundle = %d, want 404", st)
	}
}

func readEntry(t *testing.T, zr *zip.Reader, name string, out interface{}) {
	t.Helper()
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		defer rc.Close()
		if err := json.NewDecoder(rc).Decode(out); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return
	}
	t.Fatalf("%s missing", name)
}

func readLines(t *testing.T, zr *zip.Reader, name string) [][]byte {
	t.Helper()
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, _ := f.Open()
		defer rc.Close()
		data, _ := io.ReadAll(rc)
		var out [][]byte
		for _, line := range bytes.Split(data, []byte("\n")) {
			if len(bytes.TrimSpace(line)) > 0 {
				out = append(out, line)
			}
		}
		return out
	}
	t.Fatalf("%s missing", name)
	return nil
}
