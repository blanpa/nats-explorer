package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go/jetstream"
	"nats-explorer/internal/connection"
)

type StreamsHandler struct {
	Store *connection.Store
}

func (h *StreamsHandler) getJS(r *http.Request) (jetstream.JetStream, error) {
	connID := getConnID(r)
	nc, err := h.Store.GetNC(connID)
	if err != nil {
		return nil, err
	}
	return jetstream.New(nc)
}

func (h *StreamsHandler) List(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
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
		writeError(w, http.StatusInternalServerError, sl.Err().Error())
		return
	}
	writeJSON(w, streams)
}

func (h *StreamsHandler) Create(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var cfg struct {
		Name            string   `json:"name"`
		Description     string   `json:"description,omitempty"`
		Subjects        []string `json:"subjects"`
		Retention       string   `json:"retention,omitempty"`
		MaxConsumers    int      `json:"maxConsumers,omitempty"`
		MaxMsgs         int64    `json:"maxMsgs,omitempty"`
		MaxBytes        int64    `json:"maxBytes,omitempty"`
		MaxAge          int64    `json:"maxAge,omitempty"`
		MaxMsgSize      int32    `json:"maxMsgSize,omitempty"`
		Storage         string   `json:"storage,omitempty"`
		Replicas        int      `json:"replicas,omitempty"`
		NoAck           bool     `json:"noAck,omitempty"`
		Discard         string   `json:"discard,omitempty"`
		DuplicateWindow int64    `json:"duplicateWindow,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	scfg := jetstream.StreamConfig{
		Name:        cfg.Name,
		Description: cfg.Description,
		Subjects:    cfg.Subjects,
	}
	if cfg.MaxConsumers != 0 { scfg.MaxConsumers = cfg.MaxConsumers }
	if cfg.MaxMsgs != 0 { scfg.MaxMsgs = cfg.MaxMsgs }
	if cfg.MaxBytes != 0 { scfg.MaxBytes = cfg.MaxBytes }
	if cfg.MaxAge != 0 { scfg.MaxAge = time.Duration(cfg.MaxAge) }
	if cfg.MaxMsgSize != 0 { scfg.MaxMsgSize = cfg.MaxMsgSize }
	if cfg.Replicas != 0 { scfg.Replicas = cfg.Replicas }
	scfg.NoAck = cfg.NoAck
	if cfg.DuplicateWindow != 0 { scfg.Duplicates = time.Duration(cfg.DuplicateWindow) }

	switch cfg.Retention {
	case "interest": scfg.Retention = jetstream.InterestPolicy
	case "workqueue": scfg.Retention = jetstream.WorkQueuePolicy
	default: scfg.Retention = jetstream.LimitsPolicy
	}
	switch cfg.Storage {
	case "memory": scfg.Storage = jetstream.MemoryStorage
	default: scfg.Storage = jetstream.FileStorage
	}
	switch cfg.Discard {
	case "new": scfg.Discard = jetstream.DiscardNew
	default: scfg.Discard = jetstream.DiscardOld
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.CreateStream(ctx, scfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	info, _ := s.Info(ctx)
	writeJSON(w, map[string]interface{}{"success": true, "name": info.Config.Name})
}

func (h *StreamsHandler) Get(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := chi_URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, streamInfoToMap(info))
}

func (h *StreamsHandler) Update(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := chi_URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	info, _ := s.Info(ctx)
	cfg := info.Config

	var update struct {
		Subjects   []string `json:"subjects,omitempty"`
		MaxMsgs    *int64   `json:"maxMsgs,omitempty"`
		MaxBytes   *int64   `json:"maxBytes,omitempty"`
		MaxAge     *int64   `json:"maxAge,omitempty"`
		MaxMsgSize *int32   `json:"maxMsgSize,omitempty"`
	}
	json.NewDecoder(r.Body).Decode(&update)

	if update.Subjects != nil { cfg.Subjects = update.Subjects }
	if update.MaxMsgs != nil { cfg.MaxMsgs = *update.MaxMsgs }
	if update.MaxBytes != nil { cfg.MaxBytes = *update.MaxBytes }
	if update.MaxAge != nil { cfg.MaxAge = time.Duration(*update.MaxAge) }
	if update.MaxMsgSize != nil { cfg.MaxMsgSize = *update.MaxMsgSize }

	_, err = js.UpdateStream(ctx, cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"success": true, "name": name})
}

func (h *StreamsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := chi_URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := js.DeleteStream(ctx, name); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *StreamsHandler) Purge(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := chi_URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err := s.Purge(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"success": true})
}

func (h *StreamsHandler) GetMessages(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := chi_URLParam(r, "name")
	startSeq, _ := strconv.ParseUint(r.URL.Query().Get("startSeq"), 10, 64)
	if startSeq == 0 { startSeq = 1 }
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit == 0 || limit > 200 { limit = 50 }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	info, _ := s.Info(ctx)
	messages := make([]map[string]interface{}, 0)

	for seq := startSeq; seq < startSeq+uint64(limit) && seq <= info.State.LastSeq; seq++ {
		msg, err := s.GetMsg(ctx, seq)
		if err != nil {
			continue
		}
		payload := string(msg.Data)
		payloadType := "string"
		if !utf8.Valid(msg.Data) {
			payloadType = "binary"
		} else if len(payload) > 0 && (payload[0] == '{' || payload[0] == '[') {
			if json.Valid(msg.Data) {
				payloadType = "json"
			}
		}
		messages = append(messages, map[string]interface{}{
			"seq":         msg.Sequence,
			"subject":     msg.Subject,
			"payload":     payload,
			"payloadType": payloadType,
			"timestamp":   msg.Time.UnixMilli(),
			"size":        len(msg.Data),
		})
	}

	writeJSON(w, map[string]interface{}{
		"messages": messages,
		"total":    info.State.Msgs,
		"firstSeq": info.State.FirstSeq,
		"lastSeq":  info.State.LastSeq,
	})
}

func (h *StreamsHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := chi_URLParam(r, "name")
	seq, _ := strconv.ParseUint(chi_URLParam(r, "seq"), 10, 64)

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err := s.DeleteMsg(ctx, seq); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func streamInfoToMap(si *jetstream.StreamInfo) map[string]interface{} {
	return map[string]interface{}{
		"name":            si.Config.Name,
		"description":     si.Config.Description,
		"subjects":        si.Config.Subjects,
		"retention":       si.Config.Retention.String(),
		"maxConsumers":    si.Config.MaxConsumers,
		"maxMsgs":         si.Config.MaxMsgs,
		"maxBytes":        si.Config.MaxBytes,
		"maxAge":          int64(si.Config.MaxAge),
		"maxMsgSize":      si.Config.MaxMsgSize,
		"storage":         si.Config.Storage.String(),
		"replicas":        si.Config.Replicas,
		"noAck":           si.Config.NoAck,
		"discard":         si.Config.Discard.String(),
		"duplicateWindow": int64(si.Config.Duplicates),
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
}
