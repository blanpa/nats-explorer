package handler

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/subscription"
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
	streams := make([]map[string]interface{}, 0)
	for si := range sl.Info() {
		streams = append(streams, streamInfoToMap(si))
	}
	if sl.Err() != nil && len(streams) == 0 {
		writeError(w, http.StatusBadGateway, sl.Err().Error())
		return
	}
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
	writeJSON(w, streamInfoToMap(info))
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
	for len(out) < want {
		batch, err := oc.FetchNoWait(want - len(out))
		if err != nil {
			return nil, err
		}
		got := 0
		for msg := range batch.Messages() {
			got++
			item, seq := StreamMsgToMap(msg)
			if seq > end {
				return out, nil
			}
			out = append(out, item)
		}
		if batch.Error() != nil {
			return nil, batch.Error()
		}
		if got == 0 {
			break // stream ends early (deleted tail) or nothing pending
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
	payload, payloadType := subscription.EncodePayload(msg.Data())
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
	payload, payloadType := subscription.EncodePayload(msg.Data)
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
	out := map[string]interface{}{
		"name":              c.Name,
		"description":       c.Description,
		"subjects":          c.Subjects,
		"retention":         c.Retention.String(),
		"maxConsumers":      c.MaxConsumers,
		"maxMsgs":           c.MaxMsgs,
		"maxMsgsPerSubject": c.MaxMsgsPerSubject,
		"maxBytes":          c.MaxBytes,
		"maxAge":            int64(c.MaxAge),
		"maxMsgSize":        c.MaxMsgSize,
		"storage":           c.Storage.String(),
		"replicas":          c.Replicas,
		"noAck":             c.NoAck,
		"discard":           c.Discard.String(),
		"duplicateWindow":   int64(c.Duplicates),
		"denyDelete":        c.DenyDelete,
		"denyPurge":         c.DenyPurge,
		"allowRollup":       c.AllowRollup,
		"allowDirect":       c.AllowDirect,
		"sealed":            c.Sealed,
		"created":           si.Created.Format(time.RFC3339),
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
	if c.Mirror != nil {
		out["mirror"] = c.Mirror.Name
	}
	if len(c.Sources) > 0 {
		names := make([]string, 0, len(c.Sources))
		for _, src := range c.Sources {
			names = append(names, src.Name)
		}
		out["sources"] = names
	}
	return out
}
