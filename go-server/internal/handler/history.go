package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/filter"
	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
)

const (
	defaultSubjectLimit = 500
	maxSubjectLimit     = 5000
	defaultBranchLimit  = 200
	maxBranchLimit      = 2000
)

// HistoryHandler serves the messages the subscription managers recorded, so
// the browser pulls the history of what it looks at instead of buffering
// every message of every subject.
type HistoryHandler struct {
	Store   *connection.Store
	History history.Store
	// Tee holds the optional database that serves time ranges beyond memory.
	Tee *history.Tee
	// Persist switches that database on and off.
	Persist *history.Persistence
	// OnCleared is called with the subjects a clear emptied, so the
	// subscription manager can drop them from its tree and counters.
	OnCleared func(connID string, subjects []string)
	// OnClearedAll is called when everything of a connection was cleared, or
	// of every connection when connID is empty. The tree goes with the
	// history: a subject with a count and nothing behind it is worse than a
	// tree that starts over.
	OnClearedAll func(connID string)
}

// db is the database behind the history, or nil when it is memory-only.
// Read once per request: the setting can be switched while one is running.
func (h *HistoryHandler) db() *history.DB {
	if h.Tee == nil {
		return nil
	}
	return h.Tee.DB()
}

// exprParam compiles the optional CEL filter of a request. An invalid
// expression is a client error, not an empty result: the UI shows it.
func exprParam(r *http.Request) (*filter.Program, error) {
	expr := strings.TrimSpace(r.URL.Query().Get("expr"))
	if expr == "" {
		return nil, nil
	}
	return filter.Compile(expr)
}

// scanLimit is how many messages to read when a filter has to run over them
// first; the caller cuts the result back to the requested limit.
func scanLimit(limit int, prg *filter.Program, max int) int {
	if prg == nil {
		return limit
	}
	if n := limit * 20; n < max {
		return n
	}
	return max
}

// timeRange reads from/to (unix ms); ok is false when neither is given.
func timeRange(r *http.Request) (from, to int64, ok bool) {
	from, _ = strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	to, _ = strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
	if from == 0 && to == 0 {
		return 0, 0, false
	}
	if to == 0 {
		to = time.Now().UnixMilli()
	}
	return from, to, true
}

const (
	defaultRangeLimit = 1000
	maxRangeLimit     = 10000
)

// Range answers GET /api/history/range?subject=...&from=&to=&branch=1&limit=&connId=:
// persisted messages in a time range, newest first. beforeTs/beforeSeq page
// backwards from a message already shown; `more` says whether another page
// may follow.
func (h *HistoryHandler) Range(w http.ResponseWriter, r *http.Request) {
	db := h.db()
	if db == nil {
		writeError(w, http.StatusNotFound, "the persistent history is switched off")
		return
	}
	subject := r.URL.Query().Get("subject")
	from, to, ok := timeRange(r)
	if subject == "" || !ok {
		writeError(w, http.StatusBadRequest, "subject and from/to are required")
		return
	}
	limit := limitParam(r, "limit", defaultRangeLimit, maxRangeLimit)
	prg, err := exprParam(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	branch := r.URL.Query().Get("branch") == "1"
	beforeTS, _ := strconv.ParseInt(r.URL.Query().Get("beforeTs"), 10, 64)
	beforeSeq, _ := strconv.ParseUint(r.URL.Query().Get("beforeSeq"), 10, 64)
	out := []message.NatsMessage{}
	ids := h.connIDs(r)
	scan := scanLimit(limit, prg, maxRangeLimit*10)
	more := false
	for _, id := range ids {
		msgs, err := db.RangePage(r.Context(), id, subject, branch, from, to, beforeTS, beforeSeq, scan)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// A full page means the database had at least that many rows before
		// the cursor: filtering may hide them, but there is more to fetch.
		more = more || len(msgs) == scan
		out = append(out, filter.Keep(prg, msgs, limit)...)
	}
	if len(ids) > 1 {
		sort.SliceStable(out, func(i, j int) bool { return older(&out[j], &out[i]) })
		if len(out) > limit {
			out = out[:limit]
			more = true
		}
	}
	resp := map[string]interface{}{"subject": subject, "from": from, "to": to, "messages": out, "more": more, "expr": r.URL.Query().Get("expr")}
	// The total is asked for once, with the first page: a view that pages as
	// it scrolls can then say how much it is looking at from the start
	// instead of correcting the number upwards as pages arrive. It is left
	// out when an expression is in play, because only reading the messages
	// can say how many of them it keeps.
	if r.URL.Query().Get("count") == "1" && prg == nil {
		var total int64
		for _, id := range ids {
			n, err := db.CountRange(r.Context(), id, subject, branch, from, to)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			total += n
		}
		resp["total"] = total
	}
	if msgs, ok := resp["messages"].([]message.NatsMessage); ok {
		filter.Annotate(msgs)
	}
	writeJSON(w, resp)
}

// HistoryResponse is the answer to GET /api/history.
type HistoryResponse struct {
	Subject string `json:"subject"`
	// Messages on exactly the subject, oldest first.
	Messages []message.NatsMessage `json:"messages"`
	// Branch holds the newest messages below the subject, newest first.
	Branch []message.NatsMessage `json:"branch"`
	// BranchMore is true when the store held more below the branch cursor.
	BranchMore bool `json:"branchMore,omitempty"`
	// More is true when the store still held messages before the cursor, so
	// another page backwards may follow. Reported separately from the
	// message count because a payload filter can empty a full page.
	More bool `json:"more"`
}

func (h *HistoryHandler) connIDs(r *http.Request) []string {
	if id := r.URL.Query().Get("connId"); id != "" {
		return []string{id}
	}
	statuses := h.Store.AllStatuses()
	ids := make([]string, 0, len(statuses))
	for _, s := range statuses {
		ids = append(ids, s.ID)
	}
	return ids
}

func limitParam(r *http.Request, name string, def, max int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// Get answers GET /api/history?subject=...&connId=...&limit=...&before=...&branchLimit=...
// Without connId the histories of all connections are merged. limit is the
// number of messages on the exact subject (oldest first, before pages
// backwards by sequence and requires connId); branchLimit is the number of
// newest messages below it.
func (h *HistoryHandler) Get(w http.ResponseWriter, r *http.Request) {
	subject := r.URL.Query().Get("subject")
	if subject == "" {
		writeError(w, http.StatusBadRequest, "subject is required")
		return
	}
	limit := limitParam(r, "limit", defaultSubjectLimit, maxSubjectLimit)
	branchLimit := limitParam(r, "branchLimit", defaultBranchLimit, maxBranchLimit)
	// An explicit zero means "no branch", which limitParam's zero-picks-the-
	// default cannot express. Paging backwards wants the subject only.
	if r.URL.Query().Get("branchLimit") == "0" {
		branchLimit = 0
	}
	before, _ := strconv.ParseUint(r.URL.Query().Get("before"), 10, 64)
	// The branch is its own list with its own cursor: it merges every
	// subject below the node, so it runs out at a different point.
	branchBefore, _ := strconv.ParseUint(r.URL.Query().Get("branchBefore"), 10, 64)
	// The timestamp of the same cursor, for reading on past the edge of
	// memory; see olderOnDisk for why the sequence alone will not do.
	beforeTS, _ := strconv.ParseInt(r.URL.Query().Get("beforeTs"), 10, 64)
	branchBeforeTS, _ := strconv.ParseInt(r.URL.Query().Get("branchBeforeTs"), 10, 64)
	prg, err := exprParam(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ids := h.connIDs(r)
	db := h.db()
	resp := HistoryResponse{Subject: subject, Messages: []message.NatsMessage{}, Branch: []message.NatsMessage{}}
	scan := scanLimit(limit, prg, maxSubjectLimit)
	for _, id := range ids {
		// Memory pages by sequence; the cursor also carries the time, and
		// both have to hold. See olderThan.
		msgs := olderThan(h.History.Subject(id, subject, scan, before), beforeTS, before)
		// A full page means the store had more before the cursor.
		more := len(msgs) == scan
		if !more {
			// Memory ran out. What is older is on disk, if a disk is kept.
			ts, seq := beforeTS, before
			if len(msgs) > 0 {
				ts, seq = msgs[0].Timestamp, msgs[0].Sequence
			}
			var older []message.NatsMessage
			older, more = h.olderOnDisk(r.Context(), db, id, subject, scopeThisSubject, ts, seq, scan-len(msgs))
			// The database answers newest first and this list is oldest
			// first, so the page turns around and goes in front.
			msgs = append(reversed(older), msgs...)
		}
		resp.More = resp.More || more
		if prg != nil {
			// Oldest first here, so keep the newest matches, not the first.
			msgs = keepNewest(prg, msgs, limit)
		}
		resp.Messages = append(resp.Messages, msgs...)
		if branchLimit > 0 {
			branchScan := scanLimit(branchLimit, prg, maxBranchLimit)
			below := olderThan(h.History.Branch(id, subject, branchScan, branchBefore), branchBeforeTS, branchBefore)
			branchMore := len(below) == branchScan
			if !branchMore {
				ts, seq := branchBeforeTS, branchBefore
				if n := len(below); n > 0 {
					// Newest first, so the last one is the cursor.
					ts, seq = below[n-1].Timestamp, below[n-1].Sequence
				}
				var older []message.NatsMessage
				older, branchMore = h.olderOnDisk(r.Context(), db, id, subject, scopeBelowSubject, ts, seq, branchScan-len(below))
				below = append(below, older...)
			}
			resp.BranchMore = resp.BranchMore || branchMore
			resp.Branch = append(resp.Branch, filter.Keep(prg, below, branchLimit)...)
		}
	}
	if len(ids) > 1 {
		sort.SliceStable(resp.Messages, func(i, j int) bool { return older(&resp.Messages[i], &resp.Messages[j]) })
		if len(resp.Messages) > limit {
			resp.Messages = resp.Messages[len(resp.Messages)-limit:]
			resp.More = true
		}
		sort.SliceStable(resp.Branch, func(i, j int) bool { return older(&resp.Branch[j], &resp.Branch[i]) })
		if len(resp.Branch) > branchLimit {
			resp.Branch = resp.Branch[:branchLimit]
			resp.BranchMore = true
		}
	}
	// How each message stands against the schema pinned for its subject, so
	// a list can show it without asking a second time.
	filter.Annotate(resp.Messages)
	filter.Annotate(resp.Branch)
	writeJSON(w, resp)
}

// Which list a disk page continues: the subject's own, or the merged one of
// everything under it.
type diskScope int

const (
	scopeThisSubject diskScope = iota
	scopeBelowSubject
)

/**
 * olderOnDisk continues a backward page in the database, for a list that has
 * reached the edge of what memory keeps.
 *
 * Memory holds the last few thousand messages of a subject, and a byte
 * budget shared with every other subject cuts a busy one to far fewer -- on
 * a running demo, 2 083 of 14 336. Everything before that is only on disk,
 * and a live view that stopped at the memory edge said "no older messages"
 * about messages it had recorded itself.
 *
 * The cursor is a timestamp and a sequence, not the sequence alone: sequence
 * numbers count from one again every time a connection is opened, so a
 * database spanning two runs holds several messages numbered 2. Ordered by
 * time first, the pages still line up across a restart.
 *
 * It reads one row more than it returns, and that row is the answer to
 * "is there more": on disk the question can be answered outright, so the
 * view is not sent back for a page that turns out to be empty.
 */
func (h *HistoryHandler) olderOnDisk(
	ctx context.Context, db *history.DB, connID, subject string, scope diskScope, ts int64, seq uint64, limit int,
) (msgs []message.NatsMessage, more bool) {
	if db == nil || limit <= 0 {
		return nil, false
	}
	// Without a cursor there is nothing above to page from: read from the
	// newest message down, which is what opening a subject that only the
	// database remembers asks for.
	to := ts
	if to == 0 {
		to = time.Now().UnixMilli()
	}
	var err error
	if scope == scopeBelowSubject {
		// Strictly below: the list under a node is its own list, and the
		// node's own messages already have one beside it.
		msgs, err = db.RangeBelowPage(ctx, connID, subject, 0, to, ts, seq, limit+1)
	} else {
		msgs, err = db.RangePage(ctx, connID, subject, false, 0, to, ts, seq, limit+1)
	}
	if err != nil {
		// What memory gave is still a page: a failed read on disk narrows
		// the answer, it does not break it.
		log.Printf("history page from disk %s %s: %v", connID, subject, err)
		return nil, false
	}
	if len(msgs) > limit {
		return msgs[:limit], true
	}
	return msgs, false
}

/**
 * olderThan keeps the messages before the cursor (timestamp, sequence). A
 * zero timestamp means there is no cursor and nothing to cut.
 *
 * The memory store pages by sequence alone, and sequence numbers start over
 * with every reconnect. So a cursor taken from a message of an earlier run
 * -- which is what paging into the database hands back -- is a larger number
 * than anything memory holds of the current one, and memory would answer a
 * request for older messages with its newest. The time settles it.
 */
func olderThan(msgs []message.NatsMessage, ts int64, seq uint64) []message.NatsMessage {
	if ts == 0 {
		return msgs
	}
	out := msgs[:0:0]
	for i := range msgs {
		if m := &msgs[i]; m.Timestamp < ts || (m.Timestamp == ts && m.Sequence < seq) {
			out = append(out, *m)
		}
	}
	return out
}

// reversed turns a newest-first page around, without touching the original.
func reversed(msgs []message.NatsMessage) []message.NatsMessage {
	out := make([]message.NatsMessage, len(msgs))
	for i, m := range msgs {
		out[len(msgs)-1-i] = m
	}
	return out
}

// keepNewest filters an oldest-first list and keeps the last matches.
func keepNewest(prg *filter.Program, msgs []message.NatsMessage, limit int) []message.NatsMessage {
	out := msgs[:0:0]
	for i := range msgs {
		if prg.MatchMessage(&msgs[i]) {
			out = append(out, msgs[i])
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func older(a, b *message.NatsMessage) bool {
	if a.Timestamp != b.Timestamp {
		return a.Timestamp < b.Timestamp
	}
	return a.Sequence < b.Sequence
}

const (
	defaultSearchLimit = 200
	maxSearchLimit     = 2000
)

// Search answers GET /api/history/search?subject=&q=&limit=&connId=&expr=:
// the newest recorded messages whose subject or payload contains q, on one
// subject and everything below it, or across every subject when subject is
// empty.
func (h *HistoryHandler) Search(w http.ResponseWriter, r *http.Request) {
	// An empty subject searches every subject; that is the global search.
	subject := r.URL.Query().Get("subject")
	q := r.URL.Query().Get("q")
	limit := limitParam(r, "limit", defaultSearchLimit, maxSearchLimit)
	prg, err := exprParam(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Paging backwards: the database orders by (timestamp, sequence), the
	// memory store by sequence alone, which is the same order within one
	// connection.
	beforeTS, _ := strconv.ParseInt(r.URL.Query().Get("beforeTs"), 10, 64)
	beforeSeq, _ := strconv.ParseUint(r.URL.Query().Get("beforeSeq"), 10, 64)
	ids := h.connIDs(r)
	db := h.db()
	out := make([]message.NatsMessage, 0, 64)
	more := false
	from, to, ranged := timeRange(r)
	if !ranged && db != nil {
		// With a persistent history the index knows more than memory does,
		// so a search without a range still goes to the database.
		to = time.Now().UnixMilli()
		ranged = true
	}
	scan := scanLimit(limit, prg, maxSearchLimit*5)
	for _, id := range ids {
		if ranged && db != nil {
			msgs, err := db.SearchPage(r.Context(), id, subject, q, from, to, beforeTS, beforeSeq, scan)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			more = more || len(msgs) == scan
			out = append(out, filter.Keep(prg, msgs, limit)...)
			continue
		}
		found := h.History.Search(id, subject, q, scan, beforeSeq)
		more = more || len(found) == scan
		out = append(out, filter.Keep(prg, found, limit)...)
	}
	if len(ids) > 1 {
		sort.SliceStable(out, func(i, j int) bool { return older(&out[j], &out[i]) })
		if len(out) > limit {
			out = out[:limit]
			more = true
		}
	}
	filter.Annotate(out)
	writeJSON(w, map[string]interface{}{"subject": subject, "q": q, "expr": r.URL.Query().Get("expr"), "messages": out, "more": more})
}

// Clear answers DELETE /api/history?connId=... and forgets the recorded
// messages of one or, without connId, all connections.
func (h *HistoryHandler) Clear(w http.ResponseWriter, r *http.Request) {
	// With a subject only that one is forgotten, with branch=1 everything
	// below it as well; the rest of the history stays.
	if subject := r.URL.Query().Get("subject"); subject != "" {
		branch := r.URL.Query().Get("branch") == "1"
		cleared := []string{}
		dropper, ok := h.History.(interface {
			DropMatching(string, string, bool) []string
		})
		if !ok {
			writeError(w, http.StatusNotImplemented, "this history cannot clear single subjects")
			return
		}
		for _, id := range h.connIDs(r) {
			gone := dropper.DropMatching(id, subject, branch)
			cleared = append(cleared, gone...)
			if h.OnCleared != nil {
				h.OnCleared(id, gone)
			}
		}
		writeJSON(w, map[string]interface{}{"success": true, "subject": subject, "branch": branch, "cleared": len(cleared)})
		return
	}
	// The persisted copy goes too. Otherwise the next connect restores the
	// tree from it and the clear looks like it did nothing.
	id := r.URL.Query().Get("connId")
	if dropper, ok := h.History.(interface {
		DropRecorded(context.Context, string) error
	}); ok {
		if err := dropper.DropRecorded(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if id != "" {
		h.History.Drop(id)
	} else {
		h.History.Clear()
	}
	if h.OnClearedAll != nil {
		h.OnClearedAll(id)
	}
	writeJSON(w, map[string]bool{"success": true})
}

const (
	defaultSeriesPoints = 400
	maxSeriesPoints     = 4000
)

// SeriesResponse is the answer to GET /api/history/series: a numeric field
// of a subject over its recorded history, downsampled for a chart.
type SeriesResponse struct {
	Subject string `json:"subject"`
	Field   string `json:"field"`
	// Points are [timestamp ms, value] pairs in time order, at most about
	// twice the requested number: every bucket keeps its minimum and maximum
	// so peaks survive the downsampling.
	Points [][2]float64 `json:"points"`
	// Samples is how many messages carried the field.
	Samples int `json:"samples"`
	// Last is the sequence of the newest message considered, so the browser
	// can append live messages after it.
	Last uint64 `json:"last"`
	// Source is "rollup" when the points come from the minute aggregates
	// instead of the messages.
	Source string `json:"source,omitempty"`
	// Agg is the reduction applied per bucket, echoed so a chart can label
	// what it is showing rather than what was asked for.
	Agg Aggregation `json:"agg"`
}

// spansTime says whether a series covers more than one instant, which is
// what it takes to draw it over time.
func spansTime(points [][2]float64) bool {
	return len(points) > 1 && points[0][0] != points[len(points)-1][0]
}

// rollupPoints turns one stored minute into the points the aggregation asks
// for. min, max, sum and count are stored; the average is derived from the
// sum. Rate differences the minute's maximum, because the last value of a
// minute is not kept and a counter's maximum is its last value.
func rollupPoints(b history.RollupPoint, agg Aggregation) [][2]float64 {
	t := float64(b.T)
	switch agg {
	case AggAvg:
		return [][2]float64{{t, b.Avg}}
	case AggMin:
		return [][2]float64{{t, b.Min}}
	case AggMax, AggRate:
		return [][2]float64{{t, b.Max}}
	case AggSum:
		return [][2]float64{{t, b.Avg * float64(b.Count)}}
	case AggCount:
		return [][2]float64{{t, float64(b.Count)}}
	}
	// minmax: both extremes, so a peak inside the minute survives.
	if b.Max == b.Min {
		return [][2]float64{{t, b.Min}}
	}
	return [][2]float64{{t, b.Min}, {t, b.Max}}
}

// rollupFrom is the range beyond which a chart reads minute aggregates
// instead of messages: a day of messages is too many points to move.
const rollupFrom = 6 * time.Hour

// Series answers GET /api/history/series?subject=...&field=a.b&points=400&connId=...
func (h *HistoryHandler) Series(w http.ResponseWriter, r *http.Request) {
	subject := r.URL.Query().Get("subject")
	field := r.URL.Query().Get("field")
	if subject == "" || field == "" {
		writeError(w, http.StatusBadRequest, "subject and field are required")
		return
	}
	points := limitParam(r, "points", defaultSeriesPoints, maxSeriesPoints)
	agg, ok := aggParam(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown aggregation "+r.URL.Query().Get("agg"))
		return
	}
	prg, err := exprParam(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	path := strings.Split(field, ".")
	db := h.db()

	// A long range is answered from the minute buckets. An expression has to
	// see the messages, so it keeps the message path.
	ranged0, ranged1, isRanged := timeRange(r)
	// Asking for the buckets outright is an answer in itself: a caller that
	// says rollup=1 wants what the writer kept, however little of it there
	// is, and is not helped by the fallback below.
	askedRollup := r.URL.Query().Get("rollup") == "1"
	wantRollup := askedRollup || (isRanged && time.Duration(ranged1-ranged0)*time.Millisecond > rollupFrom)
	if db != nil && isRanged && wantRollup && prg == nil {
		points := make([][2]float64, 0, 256)
		samples := 0
		for _, id := range h.connIDs(r) {
			minutes, err := db.SeriesRollup(r.Context(), id, subject, field, ranged0, ranged1)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			// The minute already reduced the messages, so the aggregation
			// applies to the minute rather than to the samples in it: the
			// average of a minute is stored, the sum of one is not the sum
			// of the messages twice.
			for _, b := range minutes {
				points = append(points, rollupPoints(b, agg)...)
				samples += int(b.Count)
			}
		}
		sort.SliceStable(points, func(i, j int) bool { return points[i][0] < points[j][0] })
		if agg == AggRate {
			points = rateOf(points)
		}
		// Chosen for the range, the minute buckets only answer if they span
		// more than one minute.
		// A subject with three messages in one minute reduces to a single
		// bucket, and a chart of one instant has no width: the reader picks
		// "All", the range is long, and nothing is drawn. Whatever is there
		// is few enough to read as messages, and the messages have the real
		// times. The same way out covers a range whose rollups have been
		// pruned while the messages are still kept.
		if askedRollup || spansTime(points) {
			writeJSON(w, SeriesResponse{Subject: subject, Field: field, Points: points, Samples: samples, Source: "rollup", Agg: agg})
			return
		}
	}

	var samples [][2]float64
	var last uint64
	var lastTS int64
	from, to, ranged := timeRange(r)
	for _, id := range h.connIDs(r) {
		var msgs []message.NatsMessage
		if ranged && db != nil {
			var err error
			if msgs, err = db.Series(r.Context(), id, subject, from, to, 200000); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		} else {
			msgs = h.History.Subject(id, subject, history.DefaultMaxPerSubject, 0)
			// Memory holds the newest few thousand messages of a subject,
			// and for a subject last seen before a restart it holds none:
			// a live chart that read memory alone drew nothing while the
			// payloads of those very messages sat on screen beside it.
			if want := history.DefaultMaxPerSubject - len(msgs); want > 0 {
				var ts int64
				var seq uint64
				if len(msgs) > 0 {
					ts, seq = msgs[0].Timestamp, msgs[0].Sequence
				}
				older, _ := h.olderOnDisk(r.Context(), db, id, subject, scopeThisSubject, ts, seq, want)
				msgs = append(reversed(older), msgs...)
			}
		}
		for i := range msgs {
			m := msgs[i]
			// The newest message by the clock, not the largest number:
			// sequences restart with every reconnect, and this is what the
			// browser appends its live values after.
			if m.Timestamp > lastTS || (m.Timestamp == lastTS && m.Sequence > last) {
				lastTS, last = m.Timestamp, m.Sequence
			}
			if m.PayloadType != "json" {
				continue
			}
			if prg != nil && !prg.MatchMessage(&msgs[i]) {
				continue
			}
			if v, ok := numberAt(m.Payload, path); ok {
				samples = append(samples, [2]float64{float64(m.Timestamp), v})
			}
		}
	}
	sort.SliceStable(samples, func(i, j int) bool { return samples[i][0] < samples[j][0] })
	writeJSON(w, SeriesResponse{Subject: subject, Field: field, Points: aggregate(samples, points, agg), Samples: len(samples), Last: last, Agg: agg})
}

// Fields answers GET /api/history/fields?subject=&connId=: the numeric
// fields known from the minute aggregates, so a chart over a long range can
// offer them without reading messages.
func (h *HistoryHandler) Fields(w http.ResponseWriter, r *http.Request) {
	subject := r.URL.Query().Get("subject")
	if subject == "" {
		writeError(w, http.StatusBadRequest, "subject is required")
		return
	}
	fields := []string{}
	if db := h.db(); db != nil {
		seen := map[string]bool{}
		for _, id := range h.connIDs(r) {
			list, err := db.RollupFields(r.Context(), id, subject)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			for _, f := range list {
				if !seen[f] {
					seen[f] = true
					fields = append(fields, f)
				}
			}
		}
		sort.Strings(fields)
	}
	writeJSON(w, map[string]interface{}{"subject": subject, "fields": fields})
}

// numberAt extracts a number at a dotted path from a JSON document.
func numberAt(payload string, path []string) (float64, bool) {
	var doc interface{}
	if err := json.Unmarshal([]byte(payload), &doc); err != nil {
		return 0, false
	}
	cur := doc
	for _, key := range path {
		switch c := cur.(type) {
		case map[string]interface{}:
			cur = c[key]
		case []interface{}:
			i, err := strconv.Atoi(key)
			if err != nil || i < 0 || i >= len(c) {
				return 0, false
			}
			cur = c[i]
		default:
			return 0, false
		}
	}
	v, ok := cur.(float64)
	return v, ok
}

// downsample keeps the minimum and maximum of every bucket, in time order.
// downsample keeps both extremes of every bucket. It is aggregate() with
// the default reduction, kept as a name for the callers that never offered
// a choice.
func downsample(samples [][2]float64, points int) [][2]float64 {
	return aggregate(samples, points, AggMinMax)
}
