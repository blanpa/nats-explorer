package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"nats-explorer/internal/connection"
)

type ConsumersHandler struct {
	Store *connection.Store
}

func (h *ConsumersHandler) List(w http.ResponseWriter, r *http.Request) {
	connID := getConnID(r)
	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	js, err := jetstream.New(nc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	streamName := chi_URLParam(r, "stream")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, streamName)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	cl := s.ListConsumers(ctx)
	consumers := make([]map[string]interface{}, 0)
	for ci := range cl.Info() {
		consumers = append(consumers, consumerInfoToMap(ci))
	}

	writeJSON(w, consumers)
}

func (h *ConsumersHandler) Get(w http.ResponseWriter, r *http.Request) {
	connID := getConnID(r)
	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	js, err := jetstream.New(nc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	streamName := chi_URLParam(r, "stream")
	consumerName := chi_URLParam(r, "consumer")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, streamName)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	c, err := s.Consumer(ctx, consumerName)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	ci, err := c.Info(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, consumerInfoToMap(ci))
}

func (h *ConsumersHandler) Create(w http.ResponseWriter, r *http.Request) {
	connID := getConnID(r)
	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	js, err := jetstream.New(nc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	streamName := chi_URLParam(r, "stream")

	var cfg struct {
		Name          string `json:"name,omitempty"`
		DurableName   string `json:"durableName,omitempty"`
		Description   string `json:"description,omitempty"`
		DeliverPolicy string `json:"deliverPolicy,omitempty"`
		AckPolicy     string `json:"ackPolicy,omitempty"`
		AckWait       int64  `json:"ackWait,omitempty"`
		MaxDeliver    int    `json:"maxDeliver,omitempty"`
		FilterSubject string `json:"filterSubject,omitempty"`
		ReplayPolicy  string `json:"replayPolicy,omitempty"`
		MaxAckPending int    `json:"maxAckPending,omitempty"`
	}
	json.NewDecoder(r.Body).Decode(&cfg)

	ccfg := jetstream.ConsumerConfig{
		Name:        cfg.Name,
		Durable:     cfg.DurableName,
		Description: cfg.Description,
	}
	if ccfg.Durable == "" { ccfg.Durable = cfg.Name }

	switch cfg.AckPolicy {
	case "none": ccfg.AckPolicy = jetstream.AckNonePolicy
	case "all": ccfg.AckPolicy = jetstream.AckAllPolicy
	default: ccfg.AckPolicy = jetstream.AckExplicitPolicy
	}

	switch cfg.DeliverPolicy {
	case "last": ccfg.DeliverPolicy = jetstream.DeliverLastPolicy
	case "new": ccfg.DeliverPolicy = jetstream.DeliverNewPolicy
	case "last_per_subject": ccfg.DeliverPolicy = jetstream.DeliverLastPerSubjectPolicy
	default: ccfg.DeliverPolicy = jetstream.DeliverAllPolicy
	}

	if cfg.AckWait > 0 { ccfg.AckWait = time.Duration(cfg.AckWait) }
	if cfg.MaxDeliver > 0 { ccfg.MaxDeliver = cfg.MaxDeliver }
	if cfg.FilterSubject != "" { ccfg.FilterSubjects = []string{cfg.FilterSubject} }
	if cfg.MaxAckPending > 0 { ccfg.MaxAckPending = cfg.MaxAckPending }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	c, err := js.CreateOrUpdateConsumer(ctx, streamName, ccfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ci, _ := c.Info(ctx)
	writeJSON(w, map[string]interface{}{"success": true, "name": ci.Name})
}

func (h *ConsumersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	connID := getConnID(r)
	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	js, err := jetstream.New(nc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	streamName := chi_URLParam(r, "stream")
	consumerName := chi_URLParam(r, "consumer")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, streamName)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	if err := s.DeleteConsumer(ctx, consumerName); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func consumerInfoToMap(ci *jetstream.ConsumerInfo) map[string]interface{} {
	config := map[string]interface{}{
		"name":        ci.Config.Name,
		"durableName": ci.Config.Durable,
		"description": ci.Config.Description,
		"deliverPolicy": ci.Config.DeliverPolicy.String(),
		"ackPolicy":   ci.Config.AckPolicy.String(),
		"ackWait":     int64(ci.Config.AckWait),
		"maxDeliver":  ci.Config.MaxDeliver,
		"replayPolicy": ci.Config.ReplayPolicy.String(),
		"maxAckPending": ci.Config.MaxAckPending,
	}
	if len(ci.Config.FilterSubjects) > 0 {
		config["filterSubject"] = ci.Config.FilterSubjects[0]
	}

	return map[string]interface{}{
		"name":           ci.Name,
		"streamName":     ci.Stream,
		"description":    ci.Config.Description,
		"created":        ci.Created.Format(time.RFC3339),
		"config":         config,
		"delivered":      ci.Delivered,
		"ackFloor":       ci.AckFloor,
		"numAckPending":  ci.NumAckPending,
		"numRedelivered": ci.NumRedelivered,
		"numWaiting":     ci.NumWaiting,
		"numPending":     ci.NumPending,
	}
}
