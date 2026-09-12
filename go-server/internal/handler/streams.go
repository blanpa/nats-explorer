package handler

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/message"
)

type StreamsHandler struct {
	Store *connection.Store
}

const (
	defaultMessagePage = 50
	maxMessagePage     = 200
)

type streamConfigBody struct {
	Name            string   `json:"name"`
	Description     string   `json:"description,omitempty"`
	Subjects        []string `json:"subjects"`
	Retention       string   `json:"retention,omitempty"`
	MaxConsumers    *int     `json:"maxConsumers,omitempty"`
	MaxMsgs         *int64   `json:"maxMsgs,omitempty"`
	MaxMsgsPerSubj  *int64   `json:"maxMsgsPerSubject,omitempty"`
	MaxBytes        *int64   `json:"maxBytes,omitempty"`
	MaxAge          *int64   `json:"maxAge,omitempty"` // nanoseconds
	MaxMsgSize      *int32   `json:"maxMsgSize,omitempty"`
	Storage         string   `json:"storage,omitempty"`
	Replicas        *int     `json:"replicas,omitempty"`
	NoAck           *bool    `json:"noAck,omitempty"`
	Discard         string   `json:"discard,omitempty"`
	DuplicateWindow *int64   `json:"duplicateWindow,omitempty"`
	DenyDelete      *bool    `json:"denyDelete,omitempty"`
	DenyPurge       *bool    `json:"denyPurge,omitempty"`
	AllowRollup     *bool    `json:"allowRollup,omitempty"`
	AllowDirect     *bool    `json:"allowDirect,omitempty"`
	// DiscardNewPerSubject applies the "new" discard policy per subject
	// instead of to the stream as a whole; needs maxMsgsPerSubject.
	DiscardNewPerSubject *bool `json:"discardNewPerSubject,omitempty"`
	// AllowMsgTTL lets a publisher expire its own message with a
	// Nats-TTL header (NATS 2.11).
	AllowMsgTTL *bool `json:"allowMsgTtl,omitempty"`
	// SubjectDeleteMarkerTTL keeps a marker after the last message of a
	// subject is removed, for this long. Nanoseconds; 0 is off.
	SubjectDeleteMarkerTTL *int64 `json:"subjectDeleteMarkerTtl,omitempty"`
}

// applyStreamBody copies the provided (non-nil) fields onto a stream config.
func applyStreamBody(cfg *jetstream.StreamConfig, b streamConfigBody) {
	if b.Name != "" {
		cfg.Name = b.Name
	}
	if b.Description != "" || cfg.Description != "" {
		cfg.Description = b.Description
	}
	if b.Subjects != nil {
		cfg.Subjects = b.Subjects
	}
	if b.MaxConsumers != nil {
		cfg.MaxConsumers = *b.MaxConsumers
	}
	if b.MaxMsgs != nil {
		cfg.MaxMsgs = *b.MaxMsgs
	}
	if b.MaxMsgsPerSubj != nil {
		cfg.MaxMsgsPerSubject = *b.MaxMsgsPerSubj
	}
	if b.MaxBytes != nil {
		cfg.MaxBytes = *b.MaxBytes
	}
	if b.MaxAge != nil {
		cfg.MaxAge = time.Duration(*b.MaxAge)
	}
	if b.MaxMsgSize != nil {
		cfg.MaxMsgSize = *b.MaxMsgSize
	}
	if b.Replicas != nil {
		cfg.Replicas = *b.Replicas
	}
	if b.NoAck != nil {
		cfg.NoAck = *b.NoAck
	}
	if b.DuplicateWindow != nil {
		cfg.Duplicates = time.Duration(*b.DuplicateWindow)
	}
	if b.DenyDelete != nil {
		cfg.DenyDelete = *b.DenyDelete
	}
	if b.DenyPurge != nil {
		cfg.DenyPurge = *b.DenyPurge
	}
	if b.AllowRollup != nil {
		cfg.AllowRollup = *b.AllowRollup
	}
	if b.AllowDirect != nil {
		cfg.AllowDirect = *b.AllowDirect
	}
	if b.DiscardNewPerSubject != nil {
		cfg.DiscardNewPerSubject = *b.DiscardNewPerSubject
	}
	if b.AllowMsgTTL != nil {
		cfg.AllowMsgTTL = *b.AllowMsgTTL
	}
	if b.SubjectDeleteMarkerTTL != nil {
		cfg.SubjectDeleteMarkerTTL = time.Duration(*b.SubjectDeleteMarkerTTL)
	}

	switch b.Retention {
	case "interest":
		cfg.Retention = jetstream.InterestPolicy
	case "workqueue":
		cfg.Retention = jetstream.WorkQueuePolicy
	case "limits":
		cfg.Retention = jetstream.LimitsPolicy
	}
	switch b.Storage {
	case "memory":
		cfg.Storage = jetstream.MemoryStorage
	case "file":
		cfg.Storage = jetstream.FileStorage
	}
	switch b.Discard {
	case "new":
		cfg.Discard = jetstream.DiscardNew
	case "old":
		cfg.Discard = jetstream.DiscardOld
	}
}

func (h *StreamsHandler) List(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	sl := js.ListStreams(ctx)
	infos := make([]*jetstream.StreamInfo, 0)
	for si := range sl.Info() {
		infos = append(infos, si)
	}
	if sl.Err() != nil && len(infos) == 0 {
		writeError(w, http.StatusBadGateway, sl.Err().Error())
		return
	}
	streams := make([]map[string]interface{}, 0, len(infos))
	for _, si := range infos {
		streams = append(streams, streamInfoToMap(si))
	}
	// Only this endpoint sees every stream, so the reverse relation is
	// computed here; GET /streams/{name} leaves it out.
	applySourcedBy(streams, infos)
	writeJSON(w, streams)
}

func (h *StreamsHandler) Create(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var body streamConfigBody
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}

	cfg := jetstream.StreamConfig{
		Retention: jetstream.LimitsPolicy,
		Storage:   jetstream.FileStorage,
		Discard:   jetstream.DiscardOld,
	}
	applyStreamBody(&cfg, body)

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.CreateStream(ctx, cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeJSON(w, map[string]interface{}{"success": true, "name": cfg.Name})
		return
	}
	writeJSON(w, streamInfoToMap(info))
}

func (h *StreamsHandler) Get(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, urlParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := streamInfoToMap(info)
	// Who copies from this stream is only visible across all of them, so the
	// detail view pays for one listing; it is opened by hand, not on a feed.
	if names := js.ListStreams(ctx); names != nil {
		others := make([]*jetstream.StreamInfo, 0, 8)
		for si := range names.Info() {
			others = append(others, si)
		}
		applySourcedBy([]map[string]interface{}{out}, others)
	}
	writeJSON(w, out)
}

func (h *StreamsHandler) Update(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	name := urlParam(r, "name")
	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	var body streamConfigBody
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	body.Name = "" // the name cannot change
	cfg := info.Config
	applyStreamBody(&cfg, body)

	updated, err := js.UpdateStream(ctx, cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	ui, err := updated.Info(ctx)
	if err != nil {
		writeJSON(w, map[string]interface{}{"success": true, "name": name})
		return
	}
	writeJSON(w, streamInfoToMap(ui))
}

func (h *StreamsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := js.DeleteStream(ctx, urlParam(r, "name")); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *StreamsHandler) Purge(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, urlParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	var opts []jetstream.StreamPurgeOpt
	if subj := r.URL.Query().Get("subject"); subj != "" {
		opts = append(opts, jetstream.WithPurgeSubject(subj))
	}
	if err := s.Purge(ctx, opts...); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"success": true})
}

// GetMessages returns a page of raw stream messages. Without startSeq the
// newest page is returned, which is what an operator usually wants to see.
// Gaps caused by deleted messages are skipped.
func (h *StreamsHandler) GetMessages(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = defaultMessagePage
	}
	if limit > maxMessagePage {
		limit = maxMessagePage
	}
	startSeq, _ := strconv.ParseUint(r.URL.Query().Get("startSeq"), 10, 64)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	name := urlParam(r, "name")
	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	first, last := info.State.FirstSeq, info.State.LastSeq
	messages := make([]map[string]interface{}, 0, limit)

	if info.State.Msgs == 0 || last == 0 {
		writeJSON(w, map[string]interface{}{
			"messages": messages, "total": 0, "firstSeq": first, "lastSeq": last,
			"pageStart": 0, "pageEnd": 0,
		})
		return
	}

	if startSeq == 0 {
		// Newest page.
		if last >= uint64(limit) {
			startSeq = last - uint64(limit) + 1
		} else {
			startSeq = 1
		}
	}
	if startSeq < first {
		startSeq = first
	}

	end := startSeq + uint64(limit) - 1
	if end > last {
		end = last
	}

	page, err := fetchRange(ctx, js, name, startSeq, end)
	if err != nil {
		// Ordered consumers can be denied by permissions; fall back to per-sequence gets.
		page = fetchRangeSlow(ctx, s, startSeq, end)
	}
	messages = append(messages, page...)

	writeJSON(w, map[string]interface{}{
		"messages":  messages,
		"total":     info.State.Msgs,
		"firstSeq":  first,
		"lastSeq":   last,
		"pageStart": startSeq,
		"pageEnd":   end,
	})
}

const (
	defaultSeriesLast = 2000
	maxSeriesLast     = 50000
)

// StreamSeriesResponse is the answer to GET /api/streams/{name}/series.
type StreamSeriesResponse struct {
	Stream  string `json:"stream"`
	Field   string `json:"field"`
	Subject string `json:"subject,omitempty"`
	// Points are [timestamp ms, value] pairs in time order, reduced per
	// bucket the way Agg says, like the subject history series.
	Points [][2]float64 `json:"points"`
	Agg    Aggregation  `json:"agg"`
	// Samples is how many messages carried the field; Scanned how many of
	// the stream's messages in the range were read.
	Samples int    `json:"samples"`
	Scanned int    `json:"scanned"`
	FromSeq uint64 `json:"fromSeq"`
	ToSeq   uint64 `json:"toSeq"`
}

// Series answers GET /api/streams/{name}/series?field=a.b&subject=...&last=2000&points=600:
// a numeric JSON field over the last N sequences of a stream, optionally
// only for one subject, downsampled for a chart.
func (h *StreamsHandler) Series(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	field := r.URL.Query().Get("field")
	if field == "" {
		writeError(w, http.StatusBadRequest, "field is required")
		return
	}
	subject := r.URL.Query().Get("subject")
	last := limitParam(r, "last", defaultSeriesLast, maxSeriesLast)
	points := limitParam(r, "points", defaultSeriesPoints, maxSeriesPoints)
	agg, aggOK := aggParam(r)
	if !aggOK {
		writeError(w, http.StatusBadRequest, "unknown aggregation "+r.URL.Query().Get("agg"))
		return
	}
	path := strings.Split(field, ".")

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	name := urlParam(r, "name")
	st, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := st.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	resp := StreamSeriesResponse{Stream: name, Field: field, Subject: subject, Points: [][2]float64{}, Agg: agg}
	first, end := info.State.FirstSeq, info.State.LastSeq
	if info.State.Msgs == 0 || end == 0 {
		writeJSON(w, resp)
		return
	}
	start := first
	if end >= uint64(last) && end-uint64(last)+1 > first {
		start = end - uint64(last) + 1
	}
	resp.FromSeq, resp.ToSeq = start, end

	// The subject is filtered here, not on the consumer: a filtered ordered
	// consumer resets itself on the sequence gaps and starts over.
	cfg := jetstream.OrderedConsumerConfig{DeliverPolicy: jetstream.DeliverByStartSequencePolicy, OptStartSeq: start, InactiveThreshold: 5 * time.Second}
	oc, err := js.OrderedConsumer(ctx, name, cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer func() {
		if ci := oc.CachedInfo(); ci != nil {
			dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
			js.DeleteConsumer(dctx, name, ci.Name)
			dcancel()
		}
	}()

	var samples [][2]float64
	want := int(end - start + 1)
	// An ordered consumer may redeliver the last message after a reset
	// between fetches; sequences only move forward here.
	var lastSeq uint64
	for resp.Scanned < want {
		batch, err := oc.FetchNoWait(min(want-resp.Scanned, 1000))
		if err != nil {
			break
		}
		// A batch without a new sequence means the stream's tail was reached
		// (deleted sequences never arrive, redeliveries repeat the last one).
		got := 0
		done := false
		for msg := range batch.Messages() {
			md, err := msg.Metadata()
			if err != nil {
				continue
			}
			if md.Sequence.Stream > end {
				done = true
				break
			}
			if md.Sequence.Stream <= lastSeq {
				continue
			}
			got++
			lastSeq = md.Sequence.Stream
			resp.Scanned++
			if subject != "" && msg.Subject() != subject {
				continue
			}
			data := msg.Data()
			if len(data) > 0 && (data[0] == '{' || data[0] == '[') {
				if v, ok := numberAt(string(data), path); ok {
					samples = append(samples, [2]float64{float64(md.Timestamp.UnixMilli()), v})
				}
			}
			if md.Sequence.Stream == end {
				done = true
			}
		}
		if done || got == 0 || batch.Error() != nil || ctx.Err() != nil {
			break
		}
	}
	resp.Samples = len(samples)
	resp.Points = aggregate(samples, points, agg)
	resp.Agg = agg
	writeJSON(w, resp)
}

// SeqAtTime answers GET /api/streams/{name}/seq?time=<unix ms>: the first
// sequence stored at or after that time, or lastSeq+1 when the time is past
// the end of the stream.
func (h *StreamsHandler) SeqAtTime(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ms, err := strconv.ParseInt(r.URL.Query().Get("time"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "time (unix ms) is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	name := urlParam(r, "name")
	st, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := st.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	at := time.UnixMilli(ms)
	oc, err := js.OrderedConsumer(ctx, name, jetstream.OrderedConsumerConfig{DeliverPolicy: jetstream.DeliverByStartTimePolicy, OptStartTime: &at, InactiveThreshold: 5 * time.Second})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer func() {
		if ci := oc.CachedInfo(); ci != nil {
			dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
			js.DeleteConsumer(dctx, name, ci.Name)
			dcancel()
		}
	}()
	seq := info.State.LastSeq + 1
	var ts int64
	if batch, err := oc.FetchNoWait(1); err == nil {
		for msg := range batch.Messages() {
			if md, err := msg.Metadata(); err == nil {
				seq = md.Sequence.Stream
				ts = md.Timestamp.UnixMilli()
			}
		}
	}
	writeJSON(w, map[string]interface{}{"seq": seq, "timestamp": ts, "firstSeq": info.State.FirstSeq, "lastSeq": info.State.LastSeq})
}

// fetchRange reads [startSeq, end] with an ephemeral ordered consumer: one
// round trip instead of one per sequence.
func fetchRange(ctx context.Context, js jetstream.JetStream, stream string, startSeq, end uint64) ([]map[string]interface{}, error) {
	oc, err := js.OrderedConsumer(ctx, stream, jetstream.OrderedConsumerConfig{
		DeliverPolicy:     jetstream.DeliverByStartSequencePolicy,
		OptStartSeq:       startSeq,
		InactiveThreshold: 5 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	defer func() {
		if ci := oc.CachedInfo(); ci != nil {
			dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
			js.DeleteConsumer(dctx, stream, ci.Name)
			dcancel()
		}
	}()

	want := int(end - startSeq + 1)
	out := make([]map[string]interface{}, 0, want)
	// The sequence of the next message that belongs in the page. An ordered
	// consumer starts over from OptStartSeq whenever it has to recreate
	// itself, so a second fetch can replay what the first already handed
	// over -- a page that asked for eight came back as seven messages and a
	// copy of the first, with the newest one missing. What was already
	// taken is known by its number, not by how many arrived.
	next := startSeq
	for len(out) < want {
		// The whole range every time, not the remainder: after a replay the
		// batch has to be large enough to hold what is skipped as well.
		batch, err := oc.FetchNoWait(want)
		if err != nil {
			return nil, err
		}
		added := 0
		for msg := range batch.Messages() {
			item, seq := StreamMsgToMap(msg)
			if seq > end {
				return out, nil
			}
			if seq < next {
				continue // replayed after a restart; already in the page
			}
			out = append(out, item)
			next = seq + 1
			added++
		}
		if batch.Error() != nil {
			return nil, batch.Error()
		}
		if added == 0 {
			break // stream ends early (deleted tail), or the fetch only replayed
		}
	}
	return out, nil
}

func fetchRangeSlow(ctx context.Context, s jetstream.Stream, startSeq, end uint64) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, end-startSeq+1)
	for seq := startSeq; seq <= end; seq++ {
		msg, err := s.GetMsg(ctx, seq)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			continue
		}
		out = append(out, rawStreamMsgToMap(msg))
	}
	return out
}

// StreamMsgToMap converts a consumer-delivered message into the API shape.
func StreamMsgToMap(msg jetstream.Msg) (map[string]interface{}, uint64) {
	payload, payloadType := message.EncodePayload(msg.Data())
	item := map[string]interface{}{
		"subject":     msg.Subject(),
		"payload":     payload,
		"payloadType": payloadType,
		"size":        len(msg.Data()),
	}
	var seq uint64
	if md, err := msg.Metadata(); err == nil {
		seq = md.Sequence.Stream
		item["seq"] = seq
		item["timestamp"] = md.Timestamp.UnixMilli()
	}
	if h := msg.Headers(); len(h) > 0 {
		item["headers"] = h
	}
	return item, seq
}

func rawStreamMsgToMap(msg *jetstream.RawStreamMsg) map[string]interface{} {
	payload, payloadType := message.EncodePayload(msg.Data)
	item := map[string]interface{}{
		"seq":         msg.Sequence,
		"subject":     msg.Subject,
		"payload":     payload,
		"payloadType": payloadType,
		"timestamp":   msg.Time.UnixMilli(),
		"size":        len(msg.Data),
	}
	if len(msg.Header) > 0 {
		item["headers"] = msg.Header
	}
	return item
}

func (h *StreamsHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	seq, err := strconv.ParseUint(urlParam(r, "seq"), 10, 64)
	if err != nil || seq == 0 {
		writeError(w, http.StatusBadRequest, "invalid sequence")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, urlParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err := s.DeleteMsg(ctx, seq); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func streamInfoToMap(si *jetstream.StreamInfo) map[string]interface{} {
	c := si.Config
	// A mirror has no subjects of its own; the browser wants a list, not null.
	subjects := c.Subjects
	if subjects == nil {
		subjects = []string{}
	}
	out := map[string]interface{}{
		"name":                   c.Name,
		"description":            c.Description,
		"subjects":               subjects,
		"retention":              c.Retention.String(),
		"maxConsumers":           c.MaxConsumers,
		"maxMsgs":                c.MaxMsgs,
		"maxMsgsPerSubject":      c.MaxMsgsPerSubject,
		"maxBytes":               c.MaxBytes,
		"maxAge":                 int64(c.MaxAge),
		"maxMsgSize":             c.MaxMsgSize,
		"storage":                c.Storage.String(),
		"replicas":               c.Replicas,
		"noAck":                  c.NoAck,
		"discard":                c.Discard.String(),
		"duplicateWindow":        int64(c.Duplicates),
		"denyDelete":             c.DenyDelete,
		"denyPurge":              c.DenyPurge,
		"allowRollup":            c.AllowRollup,
		"allowDirect":            c.AllowDirect,
		"discardNewPerSubject":   c.DiscardNewPerSubject,
		"allowMsgTtl":            c.AllowMsgTTL,
		"subjectDeleteMarkerTtl": int64(c.SubjectDeleteMarkerTTL),
		"sealed":                 c.Sealed,
		"created":                si.Created.Format(time.RFC3339),
		"state": map[string]interface{}{
			"messages":      si.State.Msgs,
			"bytes":         si.State.Bytes,
			"firstSeq":      si.State.FirstSeq,
			"lastSeq":       si.State.LastSeq,
			"firstTs":       si.State.FirstTime.Format(time.RFC3339),
			"lastTs":        si.State.LastTime.Format(time.RFC3339),
			"numSubjects":   si.State.NumSubjects,
			"numDeleted":    si.State.NumDeleted,
			"consumerCount": si.State.Consumers,
		},
	}
	if si.Cluster != nil {
		replicas := make([]map[string]interface{}, 0, len(si.Cluster.Replicas))
		for _, rep := range si.Cluster.Replicas {
			replicas = append(replicas, map[string]interface{}{
				"name": rep.Name, "current": rep.Current, "offline": rep.Offline, "lag": rep.Lag,
			})
		}
		out["cluster"] = map[string]interface{}{
			"name": si.Cluster.Name, "leader": si.Cluster.Leader, "replicas": replicas,
		}
	}
	// Replication: the config names the relation even before data flows, the
	// info adds lag and activity once it does.
	if c.Mirror != nil {
		out["mirror"] = sourceMap(c.Mirror.Name, si.Mirror)
	}
	if len(c.Sources) > 0 || len(si.Sources) > 0 {
		byName := make(map[string]*jetstream.StreamSourceInfo, len(si.Sources))
		for _, src := range si.Sources {
			byName[src.Name] = src
		}
		sources := make([]map[string]interface{}, 0, len(c.Sources))
		seen := map[string]bool{}
		for _, src := range c.Sources {
			sources = append(sources, sourceMap(src.Name, byName[src.Name]))
			seen[src.Name] = true
		}
		for _, src := range si.Sources {
			if !seen[src.Name] {
				sources = append(sources, sourceMap(src.Name, src))
			}
		}
		out["sources"] = sources
	}
	return out
}

// sourceMap describes one replication relation. `active` is milliseconds
// since the last activity, so the UI can say "3 s ago" without a clock.
func sourceMap(name string, info *jetstream.StreamSourceInfo) map[string]interface{} {
	out := map[string]interface{}{"name": name}
	if info == nil {
		return out
	}
	if info.Name != "" {
		out["name"] = info.Name
	}
	out["lag"] = info.Lag
	// Active is -1 while nothing has happened yet.
	out["active"] = info.Active.Milliseconds()
	if info.FilterSubject != "" {
		out["filterSubject"] = info.FilterSubject
	}
	return out
}

// applySourcedBy fills the reverse relation: which of the listed streams
// mirror or source from each stream. Only a full listing knows this.
func applySourcedBy(streams []map[string]interface{}, infos []*jetstream.StreamInfo) {
	type user struct{ name, kind string }
	users := make(map[string][]user)
	for _, si := range infos {
		if si.Config.Mirror != nil {
			users[si.Config.Mirror.Name] = append(users[si.Config.Mirror.Name], user{si.Config.Name, "mirror"})
		}
		for _, src := range si.Config.Sources {
			users[src.Name] = append(users[src.Name], user{si.Config.Name, "source"})
		}
	}
	for _, s := range streams {
		name, _ := s["name"].(string)
		list := users[name]
		if len(list) == 0 {
			continue
		}
		out := make([]map[string]interface{}, 0, len(list))
		for _, u := range list {
			out = append(out, map[string]interface{}{"name": u.name, "kind": u.kind})
		}
		s["sourcedBy"] = out
	}
}
