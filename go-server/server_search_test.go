package main

import (
	"fmt"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Search without a subject spans every subject, the full-text index answers
// word queries, and a long range is charted from the minute aggregates.
func TestServerGlobalSearchAndRollups(t *testing.T) {
	ns := startNATS(t)
	dbPath := filepath.Join(t.TempDir(), "history.db")
	srv := newTestServer(t, serverConfig{historyDB: dbPath, historyRetention: time.Hour, historyManaged: true})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "S", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"s.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	for i := 0; i < 4; i++ {
		nc.Publish("s.plant.temp", []byte(fmt.Sprintf(`{"temp": %d, "unit": "celsius"}`, 20+i)))
		nc.Publish("s.line.speed", []byte(fmt.Sprintf(`{"speed": %d, "note": "conveyor running"}`, 100+i)))
	}
	nc.Flush()
	time.Sleep(1500 * time.Millisecond) // let the writer flush

	q := func(path string, params map[string]string) string {
		v := url.Values{}
		for k, val := range params {
			v.Set(k, val)
		}
		return path + "?" + v.Encode()
	}
	var search struct {
		Messages []struct {
			Subject string `json:"subject"`
			Payload string `json:"payload"`
		} `json:"messages"`
	}

	// Without a subject the search spans every subject of the connection.
	api.do("GET", q("/api/history/search", map[string]string{"q": "conveyor"}), nil, &search)
	if len(search.Messages) != 4 {
		t.Fatalf("global search for a word = %d messages", len(search.Messages))
	}
	for _, m := range search.Messages {
		if m.Subject != "s.line.speed" {
			t.Fatalf("global search returned %s", m.Subject)
		}
	}

	// Two words must both appear.
	api.do("GET", q("/api/history/search", map[string]string{"q": "conveyor celsius"}), nil, &search)
	if len(search.Messages) != 0 {
		t.Fatalf("both words must match the same message, got %d", len(search.Messages))
	}

	// A prefix search finds the word.
	api.do("GET", q("/api/history/search", map[string]string{"q": "convey*"}), nil, &search)
	if len(search.Messages) != 4 {
		t.Fatalf("prefix search = %d", len(search.Messages))
	}

	// A fragment the index cannot express falls back to a scan.
	api.do("GET", q("/api/history/search", map[string]string{"q": "elsiu"}), nil, &search)
	if len(search.Messages) != 4 {
		t.Fatalf("fallback scan for a fragment = %d", len(search.Messages))
	}

	// A subject still narrows the search.
	api.do("GET", q("/api/history/search", map[string]string{"subject": "s.plant", "q": "celsius"}), nil, &search)
	if len(search.Messages) != 4 {
		t.Fatalf("scoped search = %d", len(search.Messages))
	}

	// The minute buckets, asked for outright.
	now := time.Now().UnixMilli()
	var series struct {
		Points  [][2]float64 `json:"points"`
		Samples int          `json:"samples"`
		Source  string       `json:"source"`
	}
	api.do("GET", q("/api/history/series", map[string]string{
		"subject": "s.plant.temp", "field": "temp", "rollup": "1",
		"from": fmt.Sprint(now - 48*3600*1000), "to": fmt.Sprint(now + 60000),
	}), nil, &series)
	if series.Source != "rollup" {
		t.Fatalf("rollup=1 should come from rollups, got %q", series.Source)
	}
	if series.Samples != 4 || len(series.Points) == 0 {
		t.Fatalf("rollup series = %+v", series)
	}
	// Left to itself over the same range, it reads the messages instead:
	// these four fall in one minute, and one bucket is one instant, which
	// is a chart with no width. The way out is the messages, which have the
	// real times.
	var auto struct {
		Points [][2]float64 `json:"points"`
		Source string       `json:"source"`
	}
	api.do("GET", q("/api/history/series", map[string]string{
		"subject": "s.plant.temp", "field": "temp",
		"from": fmt.Sprint(now - 48*3600*1000), "to": fmt.Sprint(now + 60000),
	}), nil, &auto)
	if auto.Source == "rollup" {
		t.Fatal("a range whose buckets span one minute was answered from them anyway")
	}
	// The messages themselves, not the one bucket they reduce to. They were
	// published in a loop and share a millisecond, so this series has no
	// width either -- but it is the four values, and the chart says so
	// rather than drawing a line of no length.
	if len(auto.Points) != 4 {
		t.Fatalf("the fallback = %+v, want the four messages", auto.Points)
	}

	// The bucket keeps the extremes of the minute.
	var lo, hi float64 = 1e9, -1e9
	for _, p := range series.Points {
		lo = min(lo, p[1])
		hi = max(hi, p[1])
	}
	if lo != 20 || hi != 23 {
		t.Fatalf("rollup extremes = %v..%v, want 20..23", lo, hi)
	}

	// A short range keeps reading the messages. Reset first: an absent field
	// leaves the previous value in place.
	series.Source = ""
	api.do("GET", q("/api/history/series", map[string]string{
		"subject": "s.plant.temp", "field": "temp", "from": fmt.Sprint(now - 60000), "to": fmt.Sprint(now + 60000),
	}), nil, &series)
	if series.Source == "rollup" {
		t.Errorf("a one-minute range should read messages, not rollups")
	}

	// The known numeric fields come from the aggregates.
	var fields struct {
		Fields []string `json:"fields"`
	}
	api.do("GET", q("/api/history/fields", map[string]string{"subject": "s.plant.temp"}), nil, &fields)
	if len(fields.Fields) != 1 || fields.Fields[0] != "temp" {
		t.Fatalf("fields = %v", fields.Fields)
	}
}
