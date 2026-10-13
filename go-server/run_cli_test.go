package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/handler"
)

// A collection runs from the terminal the way it runs in the module: the
// same executor, the same verdict, PASS and FAIL per template, and a
// payload the terminal cannot encode named rather than sent wrong.
func TestRunCollection(t *testing.T) {
	ns := startNATS(t)
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	// A service that answers, and one that answers slowly.
	sub, _ := nc.Subscribe("svc.ok", func(m *nats.Msg) { m.Respond([]byte(`{"status":"ok","n":` + string(m.Data) + `}`)) })
	defer sub.Unsubscribe()
	slow, _ := nc.Subscribe("svc.slow", func(m *nats.Msg) {
		time.Sleep(60 * time.Millisecond)
		m.Respond([]byte(`{"status":"late"}`))
	})
	defer slow.Unsubscribe()
	nc.Flush()

	dir := t.TempDir()
	path := filepath.Join(dir, "collection.json")
	os.WriteFile(path, []byte(`{"format":"nats-explorer-requests","version":1,"items":[
		{"name":"ok","mode":"request","subject":"svc.ok","payload":"{{i}}","count":3,"expect":{"expr":"payload.status == \"ok\"","maxLatencyMs":2000}},
		{"name":"wrong answer","mode":"request","subject":"svc.ok","payload":"1","expect":{"expr":"payload.status == \"done\""}},
		{"name":"too slow","mode":"request","subject":"svc.slow","payload":"","expect":{"maxLatencyMs":10}},
		{"name":"nobody there","mode":"request","subject":"svc.none","payload":"","timeout":200},
		{"name":"fire and forget","mode":"publish","subject":"fire","payload":"x","count":5},
		{"name":"bytes","mode":"publish","subject":"fire","payload":"de ad be ef","format":"hex"},
		{"name":"proto","mode":"publish","subject":"fire","payload":"{}","format":"protobuf"}
	]}`), 0o644)

	items, err := loadCollection(path)
	if err != nil || len(items) != 7 {
		t.Fatalf("load: %v, %d items", err, len(items))
	}
	var lines []string
	outcomes, failed := executeCollection(context.Background(), nc, items, func(o runOutcome) { lines = append(lines, formatOutcome(o)) })
	if len(outcomes) != 7 || failed != 4 {
		t.Fatalf("%d outcomes, %d failed; lines:\n%s", len(outcomes), failed, strings.Join(lines, "\n"))
	}
	want := map[string]string{
		"ok":              "PASS",
		"wrong answer":    "FAIL",
		"too slow":        "FAIL",
		"nobody there":    "FAIL",
		"fire and forget": "PASS",
		"bytes":           "PASS",
		"proto":           "FAIL",
	}
	for _, o := range outcomes {
		status := "PASS"
		if o.Error != "" || o.Result.Verdict == nil || !o.Result.Verdict.Passed {
			status = "FAIL"
		}
		if status != want[o.Name] {
			t.Errorf("%s: %s, want %s (%+v %s)", o.Name, status, want[o.Name], o.Result.Verdict, o.Error)
		}
	}
	joined := strings.Join(lines, "\n")
	for _, s := range []string{"replies do not satisfy", "over the 10 ms allowed", "no responders", "protobuf payload"} {
		if !strings.Contains(joined, s) {
			t.Errorf("the report does not say %q:\n%s", s, joined)
		}
	}
	if ok := outcomes[0].Result; ok.Sent != 3 || ok.OK != 3 || ok.Verdict.Checked != 3 {
		t.Fatalf("ok = %+v", ok)
	}

	// A bare list is a collection too; anything else is named as not one.
	os.WriteFile(path, []byte(`[{"subject":"a","mode":"publish","payload":""}]`), 0o644)
	if items, err := loadCollection(path); err != nil || len(items) != 1 {
		t.Fatalf("bare list: %v %d", err, len(items))
	}
	os.WriteFile(path, []byte(`{"nope": true}`), 0o644)
	if _, err := loadCollection(path); err == nil {
		t.Fatal("a file without templates loaded")
	}
	// A spec out of bounds is refused before anything is sent.
	if _, err := specOf(collectionItem{Mode: "publish", Subject: "a", Count: 1_000_000}); err == nil {
		t.Fatal("a count over the limit was accepted")
	}
	if _, err := specOf(collectionItem{Mode: "request", Subject: "a", Expect: &handler.Expect{Expr: "payload."}}); err == nil {
		t.Fatal("a broken expression was accepted")
	}
}
