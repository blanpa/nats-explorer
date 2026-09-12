package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
)

type ConsumersHandler struct {
	Store *connection.Store
}

func (h *ConsumersHandler) stream(w http.ResponseWriter, r *http.Request) (jetstream.JetStream, jetstream.Stream, context.Context, context.CancelFunc, bool) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	s, err := js.Stream(ctx, urlParam(r, "stream"))
	if err != nil {
		cancel()
		writeError(w, http.StatusNotFound, err.Error())
		return nil, nil, nil, nil, false
	}
	return js, s, ctx, cancel, true
}

func (h *ConsumersHandler) List(w http.ResponseWriter, r *http.Request) {
	_, s, ctx, cancel, ok := h.stream(w, r)
	if !ok {
		return
	}
	defer cancel()

	cl := s.ListConsumers(ctx)
	consumers := make([]map[string]interface{}, 0)
	for ci := range cl.Info() {
		consumers = append(consumers, consumerInfoToMap(ci))
	}
	if cl.Err() != nil && len(consumers) == 0 {
		writeError(w, http.StatusBadGateway, cl.Err().Error())
		return
	}
	writeJSON(w, consumers)
}

func (h *ConsumersHandler) Get(w http.ResponseWriter, r *http.Request) {
	_, s, ctx, cancel, ok := h.stream(w, r)
	if !ok {
		return
	}
	defer cancel()

	c, err := s.Consumer(ctx, urlParam(r, "consumer"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	ci, err := c.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, consumerInfoToMap(ci))
}

func (h *ConsumersHandler) Create(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var cfg struct {
		Name          string `json:"name,omitempty"`
		DurableName   string `json:"durableName,omitempty"`
		Description   string `json:"description,omitempty"`
		DeliverPolicy string `json:"deliverPolicy,omitempty"`
		OptStartSeq   uint64 `json:"optStartSeq,omitempty"`
		AckPolicy     string `json:"ackPolicy,omitempty"`
		AckWait       int64  `json:"ackWait,omitempty"` // nanoseconds
		MaxDeliver    int    `json:"maxDeliver,omitempty"`
		FilterSubject string `json:"filterSubject,omitempty"`
		ReplayPolicy  string `json:"replayPolicy,omitempty"`
		MaxAckPending int    `json:"maxAckPending,omitempty"`
	}
	if err := decodeBody(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ccfg := jetstream.ConsumerConfig{
		Name:        cfg.Name,
		Durable:     cfg.DurableName,
		Description: cfg.Description,
	}
	if ccfg.Durable == "" {
		ccfg.Durable = cfg.Name
	}
	if ccfg.Name == "" {
		ccfg.Name = ccfg.Durable
	}
	if ccfg.Name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}

	switch cfg.AckPolicy {
	case "none":
		ccfg.AckPolicy = jetstream.AckNonePolicy
	case "all":
		ccfg.AckPolicy = jetstream.AckAllPolicy
	default:
		ccfg.AckPolicy = jetstream.AckExplicitPolicy
	}

	switch cfg.DeliverPolicy {
	case "last":
		ccfg.DeliverPolicy = jetstream.DeliverLastPolicy
	case "new":
		ccfg.DeliverPolicy = jetstream.DeliverNewPolicy
	case "last_per_subject":
		ccfg.DeliverPolicy = jetstream.DeliverLastPerSubjectPolicy
	case "by_start_sequence":
		ccfg.DeliverPolicy = jetstream.DeliverByStartSequencePolicy
		ccfg.OptStartSeq = cfg.OptStartSeq
	default:
		ccfg.DeliverPolicy = jetstream.DeliverAllPolicy
	}
	if cfg.ReplayPolicy == "original" {
		ccfg.ReplayPolicy = jetstream.ReplayOriginalPolicy
	}

	if cfg.AckWait > 0 {
		ccfg.AckWait = time.Duration(cfg.AckWait)
	}
	if cfg.MaxDeliver > 0 {
		ccfg.MaxDeliver = cfg.MaxDeliver
	}
	if cfg.FilterSubject != "" {
		ccfg.FilterSubject = cfg.FilterSubject
	}
	if cfg.MaxAckPending > 0 {
		ccfg.MaxAckPending = cfg.MaxAckPending
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	c, err := js.CreateOrUpdateConsumer(ctx, urlParam(r, "stream"), ccfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	ci, err := c.Info(ctx)
	if err != nil {
		writeJSON(w, map[string]interface{}{"success": true, "name": ccfg.Name})
		return
	}
	writeJSON(w, consumerInfoToMap(ci))
}

// Update answers PUT /api/streams/{stream}/consumers/{consumer}: the fields
// JetStream allows to change on an existing consumer. Deliver and ack
// policies are fixed at creation and rejected here.
func (h *ConsumersHandler) Update(w http.ResponseWriter, r *http.Request) {
	js, s, ctx, cancel, ok := h.stream(w, r)
	if !ok {
		return
	}
	defer cancel()
	var in struct {
		Description   *string `json:"description"`
		AckWait       *int64  `json:"ackWait"` // nanoseconds
		MaxDeliver    *int    `json:"maxDeliver"`
		MaxAckPending *int    `json:"maxAckPending"`
		FilterSubject *string `json:"filterSubject"`
		DeliverPolicy string  `json:"deliverPolicy,omitempty"`
		AckPolicy     string  `json:"ackPolicy,omitempty"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	c, err := s.Consumer(ctx, urlParam(r, "consumer"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	ci, err := c.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	cfg := ci.Config
	if in.DeliverPolicy != "" && in.DeliverPolicy != cfg.DeliverPolicy.String() {
		writeError(w, http.StatusBadRequest, "the deliver policy cannot be changed on an existing consumer")
		return
	}
	if in.AckPolicy != "" && in.AckPolicy != cfg.AckPolicy.String() {
		writeError(w, http.StatusBadRequest, "the ack policy cannot be changed on an existing consumer")
		return
	}
	if in.Description != nil {
		cfg.Description = *in.Description
	}
	if in.AckWait != nil && *in.AckWait > 0 {
		cfg.AckWait = time.Duration(*in.AckWait)
	}
	if in.MaxDeliver != nil {
		cfg.MaxDeliver = *in.MaxDeliver
	}
	if in.MaxAckPending != nil {
		cfg.MaxAckPending = *in.MaxAckPending
	}
	if in.FilterSubject != nil {
		cfg.FilterSubject = *in.FilterSubject
		cfg.FilterSubjects = nil
	}
	updated, err := js.UpdateConsumer(ctx, urlParam(r, "stream"), cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if ci, err := updated.Info(ctx); err == nil {
		writeJSON(w, consumerInfoToMap(ci))
		return
	}
	writeJSON(w, map[string]interface{}{"success": true, "name": cfg.Name})
}

func (h *ConsumersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	_, s, ctx, cancel, ok := h.stream(w, r)
	if !ok {
		return
	}
	defer cancel()

	if err := s.DeleteConsumer(ctx, urlParam(r, "consumer")); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func consumerInfoToMap(ci *jetstream.ConsumerInfo) map[string]interface{} {
	c := ci.Config
	config := map[string]interface{}{
		"name":           c.Name,
		"durableName":    c.Durable,
		"description":    c.Description,
		"deliverPolicy":  c.DeliverPolicy.String(),
		"ackPolicy":      c.AckPolicy.String(),
		"ackWait":        int64(c.AckWait),
		"maxDeliver":     c.MaxDeliver,
		"replayPolicy":   c.ReplayPolicy.String(),
		"maxAckPending":  c.MaxAckPending,
		"deliverSubject": c.DeliverSubject,
		"optStartSeq":    c.OptStartSeq,
	}
	switch {
	case c.FilterSubject != "":
		config["filterSubject"] = c.FilterSubject
	case len(c.FilterSubjects) == 1:
		config["filterSubject"] = c.FilterSubjects[0]
	case len(c.FilterSubjects) > 1:
		config["filterSubjects"] = c.FilterSubjects
	}

	return map[string]interface{}{
		"name":           ci.Name,
		"streamName":     ci.Stream,
		"description":    c.Description,
		"created":        ci.Created.Format(time.RFC3339),
		"config":         config,
		"delivered":      map[string]interface{}{"consumerSeq": ci.Delivered.Consumer, "streamSeq": ci.Delivered.Stream},
		"ackFloor":       map[string]interface{}{"consumerSeq": ci.AckFloor.Consumer, "streamSeq": ci.AckFloor.Stream},
		"numAckPending":  ci.NumAckPending,
		"numRedelivered": ci.NumRedelivered,
		"numWaiting":     ci.NumWaiting,
		"numPending":     ci.NumPending,
		"push":           c.DeliverSubject != "",
		// A paused consumer delivers nothing until its deadline; without
		// saying so a stalled pipeline looks like a broken one.
		"paused":         ci.Paused,
		"pauseRemaining": int64(ci.PauseRemaining / time.Millisecond),
	}
}

// Pause answers POST /api/streams/{stream}/consumers/{consumer}/pause with
// {"seconds": n} or {"until": "<RFC3339>"}: the consumer stops delivering
// until the deadline and resumes by itself. Draining a backlog or replacing
// a downstream service is what this is for.
func (h *ConsumersHandler) Pause(w http.ResponseWriter, r *http.Request) {
	js, _, ctx, cancel, ok := h.stream(w, r)
	if !ok {
		return
	}
	defer cancel()

	var body struct {
		Seconds int    `json:"seconds"`
		Until   string `json:"until"`
	}
	if r.Body != nil {
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
	}
	until := time.Now().Add(time.Duration(body.Seconds) * time.Second)
	if body.Until != "" {
		t, err := time.Parse(time.RFC3339, body.Until)
		if err != nil {
			writeError(w, http.StatusBadRequest, "until must be an RFC 3339 time")
			return
		}
		until = t
	} else if body.Seconds <= 0 {
		writeError(w, http.StatusBadRequest, "seconds or until is required")
		return
	}
	if !until.After(time.Now()) {
		writeError(w, http.StatusBadRequest, "the pause deadline is in the past")
		return
	}
	res, err := js.PauseConsumer(ctx, urlParam(r, "stream"), urlParam(r, "consumer"), until)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"paused": res.Paused, "pauseUntil": res.PauseUntil.Format(time.RFC3339), "pauseRemaining": int64(res.PauseRemaining / time.Millisecond)})
}

// Resume answers POST .../resume: deliveries start again at once.
func (h *ConsumersHandler) Resume(w http.ResponseWriter, r *http.Request) {
	js, _, ctx, cancel, ok := h.stream(w, r)
	if !ok {
		return
	}
	defer cancel()
	res, err := js.ResumeConsumer(ctx, urlParam(r, "stream"), urlParam(r, "consumer"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"paused": res.Paused})
}
