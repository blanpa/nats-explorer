package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"nats-explorer/internal/history"
	"nats-explorer/internal/settings"
)

type persistenceStatus struct {
	Supported bool   `json:"supported"`
	Managed   bool   `json:"managed"`
	Enabled   bool   `json:"enabled"`
	Path      string `json:"path"`
	Retention string `json:"retention"`
	DB        *struct {
		Messages int64 `json:"messages"`
	} `json:"db"`
}

// The persistent history is a setting: the UI switches it on, messages
// received from then on survive, and the choice is stored for the next start.
func TestServerHistoryPersistenceSetting(t *testing.T) {
	ns := startNATS(t)
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dir, "history.db")
	cfg := serverConfig{settings: store, historyDB: dbPath, historyRetention: time.Hour}
	srv := newTestServer(t, cfg)
	api := &apiClient{t: t, base: srv.URL}

	var st persistenceStatus
	api.do("GET", "/api/history/persistence", nil, &st)
	if !st.Supported || st.Enabled || st.Managed || st.Path != dbPath {
		t.Fatalf("status = %+v", st)
	}
	var app struct {
		HistoryDb bool `json:"historyDb"`
	}
	api.do("GET", "/api/app", nil, &app)
	if app.HistoryDb {
		t.Fatal("app info claims a persistent history before it is switched on")
	}

	if code := api.do("PUT", "/api/history/persistence", map[string]interface{}{"enabled": true, "retention": "6h"}, &st); code != 200 {
		t.Fatalf("switch on: %d", code)
	}
	if !st.Enabled || st.Retention != "6h0m0s" {
		t.Fatalf("status after switching on = %+v", st)
	}
	api.do("GET", "/api/app", nil, &app)
	if !app.HistoryDb {
		t.Fatal("app info still reports no persistent history")
	}

	// Messages received now reach the database, so a time range finds them.
	if code := api.do("POST", "/api/connect", map[string]interface{}{"id": "h1", "name": "h", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); code != 200 {
		t.Fatal("connect")
	}
	q := "?connId=h1"
	from := time.Now().UnixMilli() - 1000
	for i := 1; i <= 3; i++ {
		api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": "set.a", "payload": fmt.Sprintf(`{"v":%d}`, i)}, nil)
	}
	var rng struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(rng.Messages) < 3 && time.Now().Before(deadline) {
		api.do("GET", "/api/history/range"+q+fmt.Sprintf("&subject=set.a&from=%d", from), nil, &rng)
		time.Sleep(100 * time.Millisecond)
	}
	if len(rng.Messages) != 3 {
		t.Fatalf("range = %v", rng.Messages)
	}

	// The choice is in the settings file, so the next start opens it again.
	raw, ok := store.Get(history.SettingsKey)
	if !ok {
		t.Fatal("choice not stored")
	}
	var saved history.PersistenceConfig
	json.Unmarshal(raw, &saved)
	if !saved.Enabled || saved.Retention != "6h0m0s" {
		t.Fatalf("stored = %+v", saved)
	}

	// Switching off with purge leaves nothing on disk; a range says so
	// instead of answering from a database that is gone.
	if code := api.do("PUT", "/api/history/persistence", map[string]interface{}{"enabled": false, "purge": true}, &st); code != 200 || st.Enabled {
		t.Fatalf("switch off: %d %+v", code, st)
	}
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("database survived the purge: %v", err)
	}
	if code := api.do("GET", "/api/history/range"+q+fmt.Sprintf("&subject=set.a&from=%d", from), nil, nil); code != 404 {
		t.Fatalf("range without a database = %d", code)
	}
	// The live history still works: only the copy on disk is gone.
	var hist struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	if code := api.do("GET", "/api/history"+q+"&subject=set.a", nil, &hist); code != 200 || len(hist.Messages) != 3 {
		t.Fatalf("memory history after switching off = %d %v", code, hist.Messages)
	}
}

// The subject tree survives a restart when the history is on disk: the
// second server knows the subjects before a single new message arrives.
func TestServerRestoresTreeFromPersistentHistory(t *testing.T) {
	ns := startNATS(t)
	dbPath := filepath.Join(t.TempDir(), "history.db")
	cfg := serverConfig{historyDB: dbPath, historyRetention: time.Hour, historyManaged: true}
	connect := map[string]interface{}{"id": "r1", "name": "R", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"tree.>"}}

	first := createServer(nil, cfg)
	srv := httptest.NewServer(first)
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", connect, nil)
	for _, subject := range []string{"tree.a", "tree.b", "tree.c.deep"} {
		for i := 0; i < 3; i++ {
			api.do("POST", "/api/publish?connId=r1", map[string]interface{}{"subject": subject, "payload": `{"v":1}`}, nil)
		}
	}
	// Let the writer flush before the server goes down.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && subjectMetric(t, srv.URL, "r1") < 3 {
		time.Sleep(100 * time.Millisecond)
	}
	time.Sleep(1500 * time.Millisecond)
	srv.Close()
	first.Close()

	// A fresh server on the same database, and the same connection again.
	second := newTestServer(t, cfg)
	api = &apiClient{t: t, base: second.URL}
	defer api.do("POST", "/api/disconnect-all", nil, nil)
	if code := api.do("POST", "/api/connect", connect, nil); code != 200 {
		t.Fatalf("reconnect: %d", code)
	}
	if got := subjectMetric(t, second.URL, "r1"); got != 3 {
		t.Fatalf("subjects after restart = %d, want the 3 recorded ones", got)
	}
}

// subjectMetric reads nats_explorer_subjects of one connection from /metrics.
func subjectMetric(t *testing.T, base, connID string) int {
	t.Helper()
	res, err := http.Get(base + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "nats_explorer_subjects{conn=\""+connID+"\"") {
			continue
		}
		n, err := strconv.Atoi(line[strings.LastIndex(line, " ")+1:])
		if err != nil {
			t.Fatalf("metric line %q: %v", line, err)
		}
		return n
	}
	return 0
}

// A stored choice is applied at the next start.
func TestServerHistoryPersistenceRestored(t *testing.T) {
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Set(history.SettingsKey, json.RawMessage(`{"enabled":true,"retention":"12h"}`)); err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, serverConfig{settings: store, historyDB: filepath.Join(dir, "history.db"), historyRetention: time.Hour})
	api := &apiClient{t: t, base: srv.URL}
	var st persistenceStatus
	api.do("GET", "/api/history/persistence", nil, &st)
	if !st.Enabled || st.Retention != "12h0m0s" {
		t.Fatalf("restored status = %+v", st)
	}
}

// The desktop app persists by default, and a stored choice still overrides it.
func TestServerHistoryPersistenceDefaultOn(t *testing.T) {
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	cfg := serverConfig{mode: "desktop", settings: store, historyDB: filepath.Join(dir, "history.db"), historyRetention: time.Hour, historyOn: true}
	api := &apiClient{t: t, base: newTestServer(t, cfg).URL}
	var st persistenceStatus
	api.do("GET", "/api/history/persistence", nil, &st)
	if !st.Enabled || st.Managed {
		t.Fatalf("desktop status = %+v", st)
	}

	if err := store.Set(history.SettingsKey, json.RawMessage(`{"enabled":false,"retention":"1h"}`)); err != nil {
		t.Fatal(err)
	}
	api = &apiClient{t: t, base: newTestServer(t, cfg).URL}
	api.do("GET", "/api/history/persistence", nil, &st)
	if st.Enabled {
		t.Fatalf("a stored \"off\" should beat the default: %+v", st)
	}
}

// With HISTORY_DB the environment owns the setting: the UI is told, not asked.
func TestServerHistoryPersistenceManaged(t *testing.T) {
	dir := t.TempDir()
	srv := newTestServer(t, serverConfig{historyDB: filepath.Join(dir, "history.db"), historyRetention: time.Hour, historyManaged: true})
	api := &apiClient{t: t, base: srv.URL}
	var st persistenceStatus
	api.do("GET", "/api/history/persistence", nil, &st)
	if !st.Managed || !st.Enabled {
		t.Fatalf("managed status = %+v", st)
	}
	if code := api.do("PUT", "/api/history/persistence", map[string]interface{}{"enabled": false}, nil); code != 409 {
		t.Fatalf("changing a managed setting = %d, want 409", code)
	}
}

// Without a place for the file the setting reports why instead of failing.
func TestServerHistoryPersistenceUnsupported(t *testing.T) {
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	var st persistenceStatus
	api.do("GET", "/api/history/persistence", nil, &st)
	if st.Supported || st.Enabled {
		t.Fatalf("status = %+v", st)
	}
	if code := api.do("PUT", "/api/history/persistence", map[string]interface{}{"enabled": true}, nil); code != 409 {
		t.Fatalf("switching on without a path = %d, want 409", code)
	}
}
