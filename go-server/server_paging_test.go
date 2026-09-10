package main

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

type pagedHistory struct {
	Messages []struct {
		Payload  string `json:"payload"`
		Sequence uint64 `json:"sequence"`
	} `json:"messages"`
	Branch []struct{} `json:"branch"`
	More   bool       `json:"more"`
}

// The history pages backwards: `before` walks past the newest page into the
// older messages the store still holds, and `more` says when to stop. The UI
// loads its history in pages instead of one capped request.
func TestServerHistoryPaging(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "p1", "name": "P", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"page.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	const total = 25
	for i := 0; i < total; i++ {
		nc.Publish("page.a", []byte(fmt.Sprintf(`{"n":%d}`, i)))
	}
	nc.Publish("page.a.below", []byte(`{"b":1}`))
	nc.Flush()

	var page pagedHistory
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", "/api/history?connId=p1&subject=page.a&limit=10", nil, &page)
		if len(page.Messages) == 10 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Page backwards until the store says there is nothing older, collecting
	// the payloads to check that no message is skipped or served twice.
	seen := []string{}
	for i := len(page.Messages) - 1; i >= 0; i-- {
		seen = append(seen, page.Messages[i].Payload)
	}
	requests := 1
	for page.More {
		if requests > 10 {
			t.Fatal("paging does not end")
		}
		before := page.Messages[0].Sequence
		requests++
		if st := api.do("GET", fmt.Sprintf("/api/history?connId=p1&subject=page.a&limit=10&branchLimit=0&before=%d", before), nil, &page); st != 200 {
			t.Fatalf("page %d: %d", requests, st)
		}
		// Paging backwards is about the subject; the branch is not fetched again.
		if len(page.Branch) != 0 {
			t.Errorf("branchLimit=0 still returned %d branch messages", len(page.Branch))
		}
		for i := len(page.Messages) - 1; i >= 0; i-- {
			seen = append(seen, page.Messages[i].Payload)
		}
	}
	if len(seen) != total {
		t.Fatalf("paged %d messages in %d requests, want %d: %v", len(seen), requests, total, seen)
	}
	for i, payload := range seen {
		want := fmt.Sprintf(`{"n":%d}`, total-1-i)
		if payload != want {
			t.Fatalf("message %d (newest first) = %s, want %s", i, payload, want)
		}
	}
}

// The branch list and the search page over the same merge, each with its own
// cursor: a node's own messages run out at a different point than everything
// below it, and a search at yet another.
func TestServerBranchAndSearchPaging(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "b1", "name": "B", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"deep.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	const total = 30
	for i := 0; i < total; i++ {
		nc.Publish(fmt.Sprintf("deep.node.leaf%d", i%3), []byte(fmt.Sprintf(`{"n":%d,"tag":"find"}`, i)))
	}
	nc.Flush()

	var page struct {
		Branch []struct {
			Payload  string `json:"payload"`
			Sequence uint64 `json:"sequence"`
		} `json:"branch"`
		BranchMore bool `json:"branchMore"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", "/api/history?connId=b1&subject=deep.node&limit=1&branchLimit=8", nil, &page)
		if len(page.Branch) == 8 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !page.BranchMore {
		t.Fatalf("a full branch page must say there is more: %+v", page)
	}

	seen := 0
	for round := 0; round < 10 && len(page.Branch) > 0; round++ {
		seen += len(page.Branch)
		if !page.BranchMore {
			break
		}
		before := page.Branch[len(page.Branch)-1].Sequence
		api.do("GET", fmt.Sprintf("/api/history?connId=b1&subject=deep.node&limit=1&branchLimit=8&branchBefore=%d", before), nil, &page)
	}
	if seen != total {
		t.Fatalf("branch paged %d of %d messages", seen, total)
	}

	// The search over the same subtree pages on its own cursor.
	var found struct {
		Messages []struct {
			Sequence uint64 `json:"sequence"`
		} `json:"messages"`
		More bool `json:"more"`
	}
	api.do("GET", "/api/history/search?connId=b1&subject=deep&q=find&limit=8", nil, &found)
	if len(found.Messages) != 8 || !found.More {
		t.Fatalf("first search page = %d messages, more=%v", len(found.Messages), found.More)
	}
	hits := 0
	for round := 0; round < 10 && len(found.Messages) > 0; round++ {
		hits += len(found.Messages)
		if !found.More {
			break
		}
		before := found.Messages[len(found.Messages)-1].Sequence
		api.do("GET", fmt.Sprintf("/api/history/search?connId=b1&subject=deep&q=find&limit=8&beforeSeq=%d", before), nil, &found)
	}
	if hits != total {
		t.Fatalf("search paged %d of %d matches", hits, total)
	}
}

type pagedRange struct {
	Messages []struct {
		Payload   string `json:"payload"`
		Timestamp int64  `json:"timestamp"`
		Sequence  uint64 `json:"sequence"`
	} `json:"messages"`
	More bool `json:"more"`
}

// The persistent history pages the same way, with a (timestamp, sequence)
// cursor so messages sharing a millisecond are not skipped.
func TestServerRangePaging(t *testing.T) {
	ns := startNATS(t)
	dbPath := filepath.Join(t.TempDir(), "history.db")
	srv := newTestServer(t, serverConfig{historyDB: dbPath, historyRetention: time.Hour, historyManaged: true})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "r1", "name": "R", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"rng.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	from := time.Now().UnixMilli() - 1000
	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	const total = 12
	for i := 0; i < total; i++ {
		// No pause between them: several share a millisecond, which is what
		// the sequence half of the cursor is for.
		nc.Publish("rng.a", []byte(fmt.Sprintf(`{"n":%d}`, i)))
	}
	nc.Flush()

	url := func(cursor string) string {
		return fmt.Sprintf("/api/history/range?connId=r1&subject=rng.a&from=%d&limit=5%s", from, cursor)
	}
	var page pagedRange
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", url(""), nil, &page)
		if len(page.Messages) == 5 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	seen := []string{}
	requests := 0
	for {
		requests++
		if requests > 10 {
			t.Fatal("paging does not end")
		}
		for _, m := range page.Messages {
			seen = append(seen, m.Payload)
		}
		if !page.More || len(page.Messages) == 0 {
			break
		}
		last := page.Messages[len(page.Messages)-1]
		cursor := fmt.Sprintf("&beforeTs=%d&beforeSeq=%d", last.Timestamp, last.Sequence)
		if st := api.do("GET", url(cursor), nil, &page); st != 200 {
			t.Fatalf("page %d: %d", requests, st)
		}
	}
	if len(seen) != total {
		t.Fatalf("paged %d of %d messages in %d requests: %v", len(seen), total, requests, seen)
	}
	for i, payload := range seen {
		want := fmt.Sprintf(`{"n":%d}`, total-1-i)
		if payload != want {
			t.Fatalf("message %d (newest first) = %s, want %s", i, payload, want)
		}
	}
}

// A range says how many messages it holds with its first page, so a view
// that pages as it is scrolled can show the real figure from the start
// instead of a number that climbs while it is read.
func TestServerRangeTotal(t *testing.T) {
	ns := startNATS(t)
	dir := t.TempDir()
	srv := newTestServer(t, serverConfig{historyDB: filepath.Join(dir, "h.db"), historyManaged: true, historyRetention: time.Hour})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "t1", "name": "T", "servers": []string{ns.ClientURL()}, "authMethod": "none", "subscriptions": []string{"tot.>"},
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	const total = 40
	for i := 0; i < total; i++ {
		nc.Publish("tot.a", []byte(fmt.Sprintf(`{"n":%d}`, i)))
		nc.Publish("tot.a.below", []byte(fmt.Sprintf(`{"n":%d}`, i)))
	}
	nc.Flush()

	type ranged struct {
		Messages []struct {
			Payload string `json:"payload"`
		} `json:"messages"`
		More  bool `json:"more"`
		Total *int `json:"total"`
	}
	from := time.Now().Add(-time.Hour).UnixMilli()
	to := time.Now().Add(time.Hour).UnixMilli()
	url := func(extra string) string {
		return fmt.Sprintf("/api/history/range?connId=t1&subject=tot.a&branch=1&from=%d&to=%d&limit=5%s", from, to, extra)
	}

	var page ranged
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		api.do("GET", url("&count=1"), nil, &page)
		if page.Total != nil && *page.Total == 2*total {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if page.Total == nil || *page.Total != 2*total {
		t.Fatalf("total = %v, want %d (the subject and everything below it)", page.Total, 2*total)
	}
	// The page itself is still the small one that was asked for: the count
	// is what makes the number honest, not a bigger fetch.
	if len(page.Messages) != 5 || !page.More {
		t.Fatalf("page = %d messages, more=%v; want the requested 5 and more to follow", len(page.Messages), page.More)
	}

	// Without asking there is no count, so a page costs what it always did.
	var plain ranged
	api.do("GET", url(""), nil, &plain)
	if plain.Total != nil {
		t.Errorf("total = %v without count=1, want none", plain.Total)
	}

	// A payload filter decides per message, so only reading them can say how
	// many are kept: the count is left out rather than guessed at.
	var filtered ranged
	api.do("GET", url("&count=1&expr=payload.n%20%3E%2020"), nil, &filtered)
	if filtered.Total != nil {
		t.Errorf("total = %v with an expression, want none", filtered.Total)
	}
}
