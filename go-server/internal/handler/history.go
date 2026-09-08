package handler

import (
	"encoding/json"
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
	// DB serves time ranges beyond memory; nil without HISTORY_DB.
	DB *history.DB
	// OnCleared is called with the subjects a clear emptied, so the
	// subscription manager can drop them from its tree and counters.
	OnCleared func(connID string, subjects []string)
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
// persisted messages in a time range, newest first.
func (h *HistoryHandler) Range(w http.ResponseWriter, r *http.Request) {
	if h.DB == nil {
		writeError(w, http.StatusNotFound, "persistent history is not enabled (HISTORY_DB)")
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
	out := []message.NatsMessage{}
	ids := h.connIDs(r)
	for _, id := range ids {
		msgs, err := h.DB.Range(r.Context(), id, subject, branch, from, to, scanLimit(limit, prg, maxRangeLimit*10))
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out = append(out, filter.Keep(prg, msgs, limit)...)
	}
	if len(ids) > 1 {
		sort.SliceStable(out, func(i, j int) bool { return older(&out[j], &out[i]) })
		if len(out) > limit {
			out = out[:limit]
		}
	}
	writeJSON(w, map[string]interface{}{"subject": subject, "from": from, "to": to, "messages": out, "expr": r.URL.Query().Get("expr")})
}

// HistoryResponse is the answer to GET /api/history.
type HistoryResponse struct {
	Subject string `json:"subject"`
	// Messages on exactly the subject, oldest first.
	Messages []message.NatsMessage `json:"messages"`
	// Branch holds the newest messages below the subject, newest first.
	Branch []message.NatsMessage `json:"branch"`
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
	before, _ := strconv.ParseUint(r.URL.Query().Get("before"), 10, 64)
	prg, err := exprParam(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ids := h.connIDs(r)
	resp := HistoryResponse{Subject: subject, Messages: []message.NatsMessage{}, Branch: []message.NatsMessage{}}
	for _, id := range ids {
		msgs := h.History.Subject(id, subject, scanLimit(limit, prg, maxSubjectLimit), before)
		if prg != nil {
			// Oldest first here, so keep the newest matches, not the first.
			msgs = keepNewest(prg, msgs, limit)
		}
		resp.Messages = append(resp.Messages, msgs...)
		if branchLimit > 0 {
			resp.Branch = append(resp.Branch, filter.Keep(prg, h.History.Branch(id, subject, scanLimit(branchLimit, prg, maxBranchLimit)), branchLimit)...)
		}
	}
	if len(ids) > 1 {
		sort.SliceStable(resp.Messages, func(i, j int) bool { return older(&resp.Messages[i], &resp.Messages[j]) })
		if len(resp.Messages) > limit {
			resp.Messages = resp.Messages[len(resp.Messages)-limit:]
		}
		sort.SliceStable(resp.Branch, func(i, j int) bool { return older(&resp.Branch[j], &resp.Branch[i]) })
		if len(resp.Branch) > branchLimit {
			resp.Branch = resp.Branch[:branchLimit]
		}
	}
	writeJSON(w, resp)
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
	ids := h.connIDs(r)
	out := make([]message.NatsMessage, 0, 64)
	from, to, ranged := timeRange(r)
	if !ranged && h.DB != nil {
		// With a persistent history the index knows more than memory does,
		// so a search without a range still goes to the database.
		to = time.Now().UnixMilli()
		ranged = true
	}
	scan := scanLimit(limit, prg, maxSearchLimit*5)
	for _, id := range ids {
		if ranged && h.DB != nil {
			msgs, err := h.DB.Search(r.Context(), id, subject, q, from, to, scan)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			out = append(out, filter.Keep(prg, msgs, limit)...)
			continue
		}
		out = append(out, filter.Keep(prg, h.History.Search(id, subject, q, scan), limit)...)
	}
	if len(ids) > 1 {
		sort.SliceStable(out, func(i, j int) bool { return older(&out[j], &out[i]) })
		if len(out) > limit {
			out = out[:limit]
		}
	}
	writeJSON(w, map[string]interface{}{"subject": subject, "q": q, "expr": r.URL.Query().Get("expr"), "messages": out})
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
	if id := r.URL.Query().Get("connId"); id != "" {
		h.History.Drop(id)
	} else {
		h.History.Clear()
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
	prg, err := exprParam(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	path := strings.Split(field, ".")

	// A long range is answered from the minute buckets. An expression has to
	// see the messages, so it keeps the message path.
	ranged0, ranged1, isRanged := timeRange(r)
	wantRollup := r.URL.Query().Get("rollup") == "1" || (isRanged && time.Duration(ranged1-ranged0)*time.Millisecond > rollupFrom)
	if h.DB != nil && isRanged && wantRollup && prg == nil {
		points := make([][2]float64, 0, 256)
		samples := 0
		for _, id := range h.connIDs(r) {
			buckets, err := h.DB.SeriesRollup(r.Context(), id, subject, field, ranged0, ranged1)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			for _, b := range buckets {
				// Minimum and maximum per bucket, like the downsampler, so a
				// peak inside the minute survives.
				points = append(points, [2]float64{float64(b.T), b.Min})
				if b.Max != b.Min {
					points = append(points, [2]float64{float64(b.T), b.Max})
				}
				samples += int(b.Count)
			}
		}
		sort.SliceStable(points, func(i, j int) bool { return points[i][0] < points[j][0] })
		writeJSON(w, SeriesResponse{Subject: subject, Field: field, Points: points, Samples: samples, Source: "rollup"})
		return
	}

	var samples [][2]float64
	var last uint64
	from, to, ranged := timeRange(r)
	for _, id := range h.connIDs(r) {
		var msgs []message.NatsMessage
		if ranged && h.DB != nil {
			var err error
			if msgs, err = h.DB.Series(r.Context(), id, subject, from, to, 200000); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		} else {
			msgs = h.History.Subject(id, subject, history.DefaultMaxPerSubject, 0)
		}
		for i := range msgs {
			m := msgs[i]
			if m.Sequence > last {
				last = m.Sequence
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
	writeJSON(w, SeriesResponse{Subject: subject, Field: field, Points: downsample(samples, points), Samples: len(samples), Last: last})
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
	if h.DB != nil {
		seen := map[string]bool{}
		for _, id := range h.connIDs(r) {
			list, err := h.DB.RollupFields(r.Context(), id, subject)
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
func downsample(samples [][2]float64, points int) [][2]float64 {
	if points <= 0 || len(samples) <= points {
		if samples == nil {
			return [][2]float64{}
		}
		return samples
	}
	out := make([][2]float64, 0, 2*points)
	size := float64(len(samples)) / float64(points)
	for b := 0; b < points; b++ {
		start := int(float64(b) * size)
		end := int(float64(b+1) * size)
		if end > len(samples) {
			end = len(samples)
		}
		if start >= end {
			continue
		}
		lo, hi := start, start
		for i := start + 1; i < end; i++ {
			if samples[i][1] < samples[lo][1] {
				lo = i
			}
			if samples[i][1] > samples[hi][1] {
				hi = i
			}
		}
		if lo == hi {
			out = append(out, samples[lo])
		} else if lo < hi {
			out = append(out, samples[lo], samples[hi])
		} else {
			out = append(out, samples[hi], samples[lo])
		}
	}
	return out
}
