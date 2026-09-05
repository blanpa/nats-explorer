package handler

import (
	"context"
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
	}
}
