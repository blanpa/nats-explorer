package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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
		// OptStartTime is unix milliseconds, for the by_start_time policy.
		OptStartTime  int64  `json:"optStartTime,omitempty"`
		AckPolicy     string `json:"ackPolicy,omitempty"`
		AckWait       int64  `json:"ackWait,omitempty"` // nanoseconds
		MaxDeliver    int    `json:"maxDeliver,omitempty"`
		FilterSubject string `json:"filterSubject,omitempty"`
		// FilterSubjects takes several patterns; one is FilterSubject.
		FilterSubjects []string `json:"filterSubjects,omitempty"`
		ReplayPolicy   string   `json:"replayPolicy,omitempty"`
		MaxAckPending  int      `json:"maxAckPending,omitempty"`
		// The rest of what a consumer can be told, nanoseconds where a time.
		BackOff           []int64           `json:"backoff,omitempty"`
		InactiveThreshold int64             `json:"inactiveThreshold,omitempty"`
		MaxWaiting        int               `json:"maxWaiting,omitempty"`
		HeadersOnly       bool              `json:"headersOnly,omitempty"`
		MaxRequestBatch   int               `json:"maxRequestBatch,omitempty"`
		RateLimit         uint64            `json:"rateLimit,omitempty"`
		Replicas          int               `json:"replicas,omitempty"`
		MemoryStorage     bool              `json:"memoryStorage,omitempty"`
		Metadata          map[string]string `json:"metadata,omitempty"`
		// A deliver subject makes it a push consumer; the group shares it.
		DeliverSubject string `json:"deliverSubject,omitempty"`
		DeliverGroup   string `json:"deliverGroup,omitempty"`
	}
	if err := decodeBody(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ccfg := jetstream.ConsumerConfig{
		Name:              cfg.Name,
		Durable:           cfg.DurableName,
		Description:       cfg.Description,
		InactiveThreshold: time.Duration(cfg.InactiveThreshold),
		MaxWaiting:        cfg.MaxWaiting,
		HeadersOnly:       cfg.HeadersOnly,
		MaxRequestBatch:   cfg.MaxRequestBatch,
		RateLimit:         cfg.RateLimit,
		Replicas:          cfg.Replicas,
		MemoryStorage:     cfg.MemoryStorage,
		Metadata:          cfg.Metadata,
		DeliverSubject:    strings.TrimSpace(cfg.DeliverSubject),
		DeliverGroup:      strings.TrimSpace(cfg.DeliverGroup),
	}
	for _, b := range cfg.BackOff {
		if b > 0 {
			ccfg.BackOff = append(ccfg.BackOff, time.Duration(b))
		}
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
	case "by_start_time":
		ccfg.DeliverPolicy = jetstream.DeliverByStartTimePolicy
		if cfg.OptStartTime > 0 {
			t := time.UnixMilli(cfg.OptStartTime)
			ccfg.OptStartTime = &t
		}
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
	setFilters(&ccfg, cfg.FilterSubject, cfg.FilterSubjects)
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
		Description       *string            `json:"description"`
		AckWait           *int64             `json:"ackWait"` // nanoseconds
		MaxDeliver        *int               `json:"maxDeliver"`
		MaxAckPending     *int               `json:"maxAckPending"`
		FilterSubject     *string            `json:"filterSubject"`
		FilterSubjects    *[]string          `json:"filterSubjects"`
		DeliverPolicy     string             `json:"deliverPolicy,omitempty"`
		AckPolicy         string             `json:"ackPolicy,omitempty"`
		BackOff           *[]int64           `json:"backoff"`
		InactiveThreshold *int64             `json:"inactiveThreshold"`
		HeadersOnly       *bool              `json:"headersOnly"`
		MaxRequestBatch   *int               `json:"maxRequestBatch"`
		RateLimit         *uint64            `json:"rateLimit"`
		Metadata          *map[string]string `json:"metadata"`
		DeliverSubject    *string            `json:"deliverSubject"`
		DeliverGroup      *string            `json:"deliverGroup"`
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
	if in.FilterSubject != nil || in.FilterSubjects != nil {
		var one string
		var many []string
		if in.FilterSubject != nil {
			one = *in.FilterSubject
		}
		if in.FilterSubjects != nil {
			many = *in.FilterSubjects
		}
		cfg.FilterSubject, cfg.FilterSubjects = "", nil
		setFilters(&cfg, one, many)
	}
	if in.BackOff != nil {
		cfg.BackOff = nil
		for _, b := range *in.BackOff {
			if b > 0 {
				cfg.BackOff = append(cfg.BackOff, time.Duration(b))
			}
		}
	}
	if in.InactiveThreshold != nil {
		cfg.InactiveThreshold = time.Duration(*in.InactiveThreshold)
	}
	if in.HeadersOnly != nil {
		cfg.HeadersOnly = *in.HeadersOnly
	}
	if in.MaxRequestBatch != nil {
		cfg.MaxRequestBatch = *in.MaxRequestBatch
	}
	if in.RateLimit != nil {
		cfg.RateLimit = *in.RateLimit
	}
	if in.Metadata != nil {
		// The server keeps entries of its own under _nats.*; those stay.
		kept := map[string]string{}
		for k, v := range cfg.Metadata {
			if strings.HasPrefix(k, "_nats.") {
				kept[k] = v
			}
		}
		for k, v := range *in.Metadata {
			if !strings.HasPrefix(k, "_nats.") {
				kept[k] = v
			}
		}
		cfg.Metadata = kept
		if len(kept) == 0 {
			cfg.Metadata = nil
		}
	}
	if in.DeliverSubject != nil {
		cfg.DeliverSubject = strings.TrimSpace(*in.DeliverSubject)
	}
	if in.DeliverGroup != nil {
		cfg.DeliverGroup = strings.TrimSpace(*in.DeliverGroup)
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

// setFilters puts one pattern in FilterSubject and several in
// FilterSubjects, which is what the server expects; a single pattern in
// the list is the same as the one field.
func setFilters(cfg *jetstream.ConsumerConfig, one string, many []string) {
	var list []string
	if s := strings.TrimSpace(one); s != "" {
		list = append(list, s)
	}
	for _, s := range many {
		if s = strings.TrimSpace(s); s != "" {
			list = append(list, s)
		}
	}
	switch len(list) {
	case 0:
	case 1:
		cfg.FilterSubject = list[0]
	default:
		cfg.FilterSubjects = list
	}
}

func consumerInfoToMap(ci *jetstream.ConsumerInfo) map[string]interface{} {
	c := ci.Config
	config := map[string]interface{}{
		"name":              c.Name,
		"durableName":       c.Durable,
		"description":       c.Description,
		"deliverPolicy":     c.DeliverPolicy.String(),
		"ackPolicy":         c.AckPolicy.String(),
		"ackWait":           int64(c.AckWait),
		"maxDeliver":        c.MaxDeliver,
		"replayPolicy":      c.ReplayPolicy.String(),
		"maxAckPending":     c.MaxAckPending,
		"deliverSubject":    c.DeliverSubject,
		"deliverGroup":      c.DeliverGroup,
		"optStartSeq":       c.OptStartSeq,
		"inactiveThreshold": int64(c.InactiveThreshold),
		"maxWaiting":        c.MaxWaiting,
		"headersOnly":       c.HeadersOnly,
		"maxRequestBatch":   c.MaxRequestBatch,
		"rateLimit":         c.RateLimit,
		"replicas":          c.Replicas,
		"memoryStorage":     c.MemoryStorage,
	}
	if c.OptStartTime != nil {
		config["optStartTime"] = c.OptStartTime.UnixMilli()
	}
	if len(c.BackOff) > 0 {
		backoff := make([]int64, 0, len(c.BackOff))
		for _, b := range c.BackOff {
			backoff = append(backoff, int64(b))
		}
		config["backoff"] = backoff
	}
	if len(c.Metadata) > 0 {
		config["metadata"] = c.Metadata
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

const (
	nextMaxBatch = 100
	nextMaxWait  = 10 * time.Second
)

// Next answers POST /api/streams/{stream}/consumers/{consumer}/next with
// {"batch": n, "waitMs": ms}: the next messages of a pull consumer, as a
// client of it would get them, and not acknowledged -- each carries its
// ack subject, so the reader decides what happens to it, with the Ack
// call below. Until then the message is in flight like any other, and
// comes back after the ack wait if nothing is said.
func (h *ConsumersHandler) Next(w http.ResponseWriter, r *http.Request) {
	_, s, ctx, cancel, ok := h.stream(w, r)
	if !ok {
		return
	}
	defer cancel()
	var body struct {
		Batch  int `json:"batch"`
		WaitMs int `json:"waitMs"`
	}
	if r.Body != nil {
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
	}
	if body.Batch <= 0 {
		body.Batch = 1
	}
	if body.Batch > nextMaxBatch {
		body.Batch = nextMaxBatch
	}
	c, err := s.Consumer(ctx, urlParam(r, "consumer"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if ci := c.CachedInfo(); ci != nil && ci.Config.DeliverSubject != "" {
		writeError(w, http.StatusBadRequest, "a push consumer delivers by itself; only a pull consumer can be asked for its next messages")
		return
	}
	var batch jetstream.MessageBatch
	if body.WaitMs <= 0 {
		batch, err = c.FetchNoWait(body.Batch)
	} else {
		wait := time.Duration(body.WaitMs) * time.Millisecond
		if wait > nextMaxWait {
			wait = nextMaxWait
		}
		batch, err = c.Fetch(body.Batch, jetstream.FetchMaxWait(wait))
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := make([]map[string]interface{}, 0, body.Batch)
	for msg := range batch.Messages() {
		item, _ := StreamMsgToMap(msg)
		item["reply"] = msg.Reply()
		if md, err := msg.Metadata(); err == nil {
			item["deliveries"] = md.NumDelivered
			item["consumerSeq"] = md.Sequence.Consumer
			item["pending"] = md.NumPending
		}
		out = append(out, item)
	}
	if batch.Error() != nil {
		writeError(w, http.StatusBadGateway, batch.Error().Error())
		return
	}
	writeJSON(w, map[string]interface{}{"messages": out})
}

// Ack answers POST /api/streams/{stream}/consumers/{consumer}/ack with
// {"reply": "$JS.ACK.…", "action": "ack"|"nak"|"term"|"progress",
// "delayMs": n}: what a client would say about a message it was handed.
// It is a publish to the message's own ack subject, which is all an ack
// ever is, and it is ignored once the ack wait has passed.
func (h *ConsumersHandler) Ack(w http.ResponseWriter, r *http.Request) {
	nc, err := h.Store.GetNC(connIDFromRequest(r))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Reply   string `json:"reply"`
		Action  string `json:"action"`
		DelayMs int64  `json:"delayMs"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Only an ack subject may be written to this way: the endpoint is not
	// a general publish.
	if !strings.HasPrefix(body.Reply, "$JS.") || !strings.Contains(body.Reply, ".ACK.") {
		writeError(w, http.StatusBadRequest, "reply is not an ack subject")
		return
	}
	var payload []byte
	switch body.Action {
	case "ack", "":
		payload = []byte("+ACK")
	case "nak":
		payload = []byte("-NAK")
		if body.DelayMs > 0 {
			payload = []byte(fmt.Sprintf(`-NAK {"delay": %d}`, body.DelayMs*int64(time.Millisecond)))
		}
	case "term":
		payload = []byte("+TERM")
	case "progress":
		payload = []byte("+WPI")
	default:
		writeError(w, http.StatusBadRequest, "action must be ack, nak, term or progress")
		return
	}
	if err := nc.Publish(body.Reply, payload); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	nc.Flush()
	writeJSON(w, map[string]bool{"success": true})
}
