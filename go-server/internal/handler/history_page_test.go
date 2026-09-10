package handler

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
)

// A store that keeps three messages per subject, with everything also on
// disk: the shape of a running server, where memory holds the newest few
// thousand of a busy subject and the database holds every one of them.
func pagedStore(t *testing.T, subject string, n int, base int64, seqFrom uint64) *history.Tee {
	t.Helper()
	db, err := history.OpenDB(filepath.Join(t.TempDir(), "h.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	tee := history.NewTee(history.NewMemStore(1<<20, 3))
	tee.SetDB(db)
	for i := 0; i < n; i++ {
		tee.Append("c", &message.Record{
			Subject:   subject,
			Data:      []byte(`{"n":` + string(rune('0'+i%10)) + `}`),
			Timestamp: base + int64(i)*1000,
			Sequence:  seqFrom + uint64(i),
		})
	}
	db.Flush()
	return tee
}

func page(t *testing.T, h *HistoryHandler, query string) HistoryResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Get(rec, httptest.NewRequest("GET", "/api/history?"+query, nil))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var resp HistoryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func seqs(msgs []message.NatsMessage) []uint64 {
	out := make([]uint64, len(msgs))
	for i, m := range msgs {
		out[i] = m.Sequence
	}
	return out
}

// The live view used to stop where memory does. Memory holds the last few
// thousand messages of a subject, and a byte budget shared with every other
// subject cuts a busy one to far fewer -- so a view that stopped there said
// "no older messages" about messages the server had recorded itself.
func TestGetReadsPastMemoryIntoTheDatabase(t *testing.T) {
	base := time.Now().Add(-time.Hour).UnixMilli()
	tee := pagedStore(t, "plant.temp", 10, base, 1)
	h := &HistoryHandler{History: tee, Tee: tee}

	// Memory holds three; the page asked for five and got five.
	resp := page(t, h, "subject=plant.temp&connId=c&limit=5&branchLimit=0")
	if got := seqs(resp.Messages); len(got) != 5 || got[0] != 6 || got[4] != 10 {
		t.Fatalf("first page = %v, want 6..10", got)
	}
	if !resp.More {
		t.Fatal("first page says there is nothing older, but five messages are on disk")
	}

	// And it keeps going, from the cursor the view holds.
	older := page(t, h, "subject=plant.temp&connId=c&limit=5&branchLimit=0&before=6&beforeTs="+strconv.FormatInt(base+5000, 10))
	if got := seqs(older.Messages); len(got) != 5 || got[0] != 1 || got[4] != 5 {
		t.Fatalf("second page = %v, want 1..5", got)
	}
	if older.More {
		t.Fatal("second page has read the lot and still claims more")
	}
}

// Sequence numbers count from one again every time a connection is opened,
// so a database spanning two runs holds two messages numbered 2. Paged by
// sequence alone the older run would be unreachable; the cursor carries the
// time, and the pages line up across the restart.
func TestGetPagesAcrossAReconnect(t *testing.T) {
	base := time.Now().Add(-time.Hour).UnixMilli()
	tee := pagedStore(t, "plant.temp", 4, base, 1)
	// The same connection, opened again: the numbers start over, the clock
	// does not.
	second := base + 10*1000
	for i := 0; i < 4; i++ {
		tee.Append("c", &message.Record{Subject: "plant.temp", Data: []byte(`{"n":1}`), Timestamp: second + int64(i)*1000, Sequence: uint64(i + 1)})
	}
	tee.DB().Flush()
	h := &HistoryHandler{History: tee, Tee: tee}

	// Reading back from the oldest message of the second run reaches the
	// first run rather than the second run's own message number 2.
	resp := page(t, h, "subject=plant.temp&connId=c&limit=4&branchLimit=0&before=1&beforeTs="+strconv.FormatInt(second, 10))
	if len(resp.Messages) != 4 {
		t.Fatalf("page = %v, want the four of the first run", seqs(resp.Messages))
	}
	for _, m := range resp.Messages {
		if m.Timestamp >= second {
			t.Fatalf("page reached forward into the second run: %+v", seqs(resp.Messages))
		}
	}
}

// Without a database the answer is memory's, unchanged.
func TestGetWithoutADatabaseStopsAtMemory(t *testing.T) {
	mem := history.NewMemStore(1<<20, 3)
	for i := 0; i < 10; i++ {
		mem.Append("c", &message.Record{Subject: "plant.temp", Data: []byte(`{}`), Timestamp: int64(1000 + i*1000), Sequence: uint64(i + 1)})
	}
	h := &HistoryHandler{History: mem}
	resp := page(t, h, "subject=plant.temp&connId=c&limit=5&branchLimit=0")
	if got := seqs(resp.Messages); len(got) != 3 || got[0] != 8 {
		t.Fatalf("page = %v, want the three memory holds", got)
	}
	if resp.More {
		t.Fatal("memory has nothing older and said it had")
	}
}

// The list of everything below a subject reads past memory the same way.
func TestGetBranchReadsPastMemory(t *testing.T) {
	base := time.Now().Add(-time.Hour).UnixMilli()
	tee := pagedStore(t, "plant.line1.temp", 10, base, 1)
	h := &HistoryHandler{History: tee, Tee: tee}
	resp := page(t, h, "subject=plant&connId=c&limit=1&branchLimit=6")
	if len(resp.Branch) != 6 {
		t.Fatalf("branch = %v, want six", seqs(resp.Branch))
	}
	if !resp.BranchMore {
		t.Fatal("branch says there is nothing older, with four on disk")
	}
}

// A leaf has nothing below it, and reading past memory must not invent it.
// The database can answer "this subject and everything under it" in one
// query, and taking that for the list under a node fills a leaf's branch
// list with its own messages -- which then reads as a branch of itself.
func TestGetBranchOfALeafStaysEmpty(t *testing.T) {
	base := time.Now().Add(-time.Hour).UnixMilli()
	tee := pagedStore(t, "plant.line1.temp", 10, base, 1)
	h := &HistoryHandler{History: tee, Tee: tee}
	resp := page(t, h, "subject=plant.line1.temp&connId=c&limit=1&branchLimit=50")
	if len(resp.Branch) != 0 {
		t.Fatalf("branch of a leaf = %d messages on %s, want none", len(resp.Branch), resp.Branch[0].Subject)
	}
	if resp.BranchMore {
		t.Fatal("branch of a leaf offers another page")
	}
	// The subject's own list is unaffected.
	if len(resp.Messages) == 0 {
		t.Fatal("the leaf lost its own messages")
	}
}

// A long range is answered from the minute buckets, because a week of
// messages is too many points to move. But a subject with three messages in
// one minute reduces to a single bucket, and a chart of one instant has no
// width: picking "All" drew nothing at all. The buckets only answer when
// they span more than one of them.
func TestSeriesFallsBackToMessagesWhenTheRollupsSpanOneMinute(t *testing.T) {
	base := time.Now().Add(-time.Hour).Truncate(time.Minute).UnixMilli()
	db, err := history.OpenDB(filepath.Join(t.TempDir(), "h.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tee := history.NewTee(history.NewMemStore(1<<20, 3))
	tee.SetDB(db)
	// Three messages a quarter second apart: one minute bucket, three times.
	for i := 0; i < 3; i++ {
		tee.Append("c", &message.Record{
			Subject:   "e2e.wipe.b",
			Data:      []byte(`{"n":` + strconv.Itoa(i) + `}`),
			Timestamp: base + int64(i)*250,
			Sequence:  uint64(i + 1),
		})
	}
	db.Flush()
	h := &HistoryHandler{History: tee, Tee: tee}

	rec := httptest.NewRecorder()
	q := "subject=e2e.wipe.b&connId=c&field=n&from=0&to=" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "&points=600"
	h.Series(rec, httptest.NewRequest("GET", "/api/history/series?"+q, nil))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var resp SeriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Source == "rollup" {
		t.Fatalf("answered from one minute bucket: %+v", resp.Points)
	}
	if len(resp.Points) != 3 {
		t.Fatalf("points = %v, want the three messages", resp.Points)
	}
	if resp.Points[0][0] == resp.Points[len(resp.Points)-1][0] {
		t.Fatalf("points still share one instant: %v", resp.Points)
	}
}

// Enough minutes to describe, and the buckets do the describing.
func TestSeriesUsesTheRollupsOverSeveralMinutes(t *testing.T) {
	base := time.Now().Add(-24 * time.Hour).Truncate(time.Minute).UnixMilli()
	db, err := history.OpenDB(filepath.Join(t.TempDir(), "h.db"), 48*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tee := history.NewTee(history.NewMemStore(1<<20, 3))
	tee.SetDB(db)
	for i := 0; i < 10; i++ {
		tee.Append("c", &message.Record{
			Subject:   "plant.temp",
			Data:      []byte(`{"n":` + strconv.Itoa(i) + `}`),
			Timestamp: base + int64(i)*int64(time.Minute/time.Millisecond),
			Sequence:  uint64(i + 1),
		})
	}
	db.Flush()
	h := &HistoryHandler{History: tee, Tee: tee}
	rec := httptest.NewRecorder()
	q := "subject=plant.temp&connId=c&field=n&from=0&to=" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "&points=600"
	h.Series(rec, httptest.NewRequest("GET", "/api/history/series?"+q, nil))
	var resp SeriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Source != "rollup" {
		t.Fatalf("read the messages where ten minutes of buckets would do: %+v", resp)
	}
}

// The live chart read memory alone. A subject last seen before a restart
// has its messages on disk only, so the chart said "collecting data points"
// while the payloads of those very messages sat on screen beside it.
func TestSeriesLiveReadsTheRecordedHistory(t *testing.T) {
	base := time.Now().Add(-time.Hour).UnixMilli()
	db, err := history.OpenDB(filepath.Join(t.TempDir(), "h.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Written before this run: on disk, and never in this memory store.
	for i := 0; i < 3; i++ {
		db.Enqueue("c", &message.Record{
			Subject:   "e2e.wipe.b",
			Data:      []byte(`{"n":` + strconv.Itoa(i) + `}`),
			Timestamp: base + int64(i)*250,
			Sequence:  uint64(i + 1),
		})
	}
	db.Flush()
	tee := history.NewTee(history.NewMemStore(1<<20, 3))
	tee.SetDB(db)
	h := &HistoryHandler{History: tee, Tee: tee}

	rec := httptest.NewRecorder()
	h.Series(rec, httptest.NewRequest("GET", "/api/history/series?subject=e2e.wipe.b&connId=c&field=n&points=600", nil))
	var resp SeriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Points) != 3 {
		t.Fatalf("live series = %v, want the three recorded messages", resp.Points)
	}
	// What the browser appends its live values after: the newest message by
	// the clock, not the largest number.
	if resp.Last != 3 {
		t.Fatalf("last = %d, want the sequence of the newest message", resp.Last)
	}
}

// After a reconnect the numbers start over, so the largest one belongs to
// the older run. Handing that back would tell the browser to ignore every
// live message until the count caught up.
func TestSeriesLastIsTheNewestNotTheLargest(t *testing.T) {
	base := time.Now().Add(-time.Hour).UnixMilli()
	mem := history.NewMemStore(1<<20, 100)
	mem.Append("c", &message.Record{Subject: "plant.temp", Data: []byte(`{"n":1}`), Timestamp: base, Sequence: 16624})
	mem.Append("c", &message.Record{Subject: "plant.temp", Data: []byte(`{"n":2}`), Timestamp: base + 1000, Sequence: 1})
	h := &HistoryHandler{History: mem}
	rec := httptest.NewRecorder()
	h.Series(rec, httptest.NewRequest("GET", "/api/history/series?subject=plant.temp&connId=c&field=n&points=600", nil))
	var resp SeriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Last != 1 {
		t.Fatalf("last = %d, want 1: the newest message by the clock", resp.Last)
	}
}
