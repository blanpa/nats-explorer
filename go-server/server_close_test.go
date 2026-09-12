package main

import (
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Closing the server stops what it started: the shard workers of every
// connection, the alert engine, the history writer and its retention loop.
// Without it a process that outlives one server leaks a set of goroutines per
// server, and every test case leaves its own behind.
func TestServerCloseStopsGoroutines(t *testing.T) {
	ns := startNATS(t)
	settle := func() int {
		// Two rounds: closing a NATS connection needs a moment to unwind.
		var n int
		for i := 0; i < 40; i++ {
			runtime.GC()
			time.Sleep(50 * time.Millisecond)
			n = runtime.NumGoroutine()
			if i > 4 && n == runtime.NumGoroutine() {
				break
			}
		}
		return n
	}
	before := settle()

	dbPath := filepath.Join(t.TempDir(), "history.db")
	// Built by hand, not through newTestServer: this test owns the shutdown.
	app := createServer(nil, serverConfig{historyDB: dbPath, historyRetention: time.Hour, historyManaged: true})
	srv := httptest.NewServer(app)
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "C", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"x.>"},
	}, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		nc.Publish(fmt.Sprintf("x.%d", i), []byte(`{"n":1}`))
	}
	nc.Flush()
	time.Sleep(300 * time.Millisecond)
	running := runtime.NumGoroutine()
	if running <= before {
		t.Fatalf("the server should be running goroutines: %d before, %d with a connection", before, running)
	}
	nc.Close()

	srv.Close()
	app.Close()
	app.Close() // Close must be safe more than once

	after := settle()
	// A handful may still be unwinding; what must not happen is the whole set
	// of workers staying alive.
	if after > before+5 {
		buf := make([]byte, 1<<16)
		buf = buf[:runtime.Stack(buf, true)]
		t.Fatalf("goroutines after close: %d, before the server: %d (running: %d)\n%s", after, before, running, buf)
	}
}
