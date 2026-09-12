package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/message"
)

type KVHandler struct {
	Store *connection.Store
}

const kvStreamPrefix = "KV_"

func (h *KVHandler) bucket(w http.ResponseWriter, r *http.Request) (jetstream.KeyValue, context.Context, context.CancelFunc, bool) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	kv, err := js.KeyValue(ctx, urlParam(r, "bucket"))
	if err != nil {
		cancel()
		writeError(w, http.StatusNotFound, err.Error())
		return nil, nil, nil, false
	}
	return kv, ctx, cancel, true
}

func (h *KVHandler) ListBuckets(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	buckets := make([]map[string]interface{}, 0)
	sl := js.ListStreams(ctx)
	for si := range sl.Info() {
		if !strings.HasPrefix(si.Config.Name, kvStreamPrefix) {
			continue
		}
		buckets = append(buckets, map[string]interface{}{
			"bucket":            strings.TrimPrefix(si.Config.Name, kvStreamPrefix),
			"description":       si.Config.Description,
			"values":            si.State.Msgs,
			"history":           si.Config.MaxMsgsPerSubject,
			"ttl":               int64(si.Config.MaxAge),
			"maxValueSize":      si.Config.MaxMsgSize,
			"maxBytes":          si.Config.MaxBytes,
			"storage":           si.Config.Storage.String(),
			"replicas":          si.Config.Replicas,
			"bytes":             si.State.Bytes,
			"backingStreamName": si.Config.Name,
		})
	}
	if sl.Err() != nil && len(buckets) == 0 {
		writeError(w, http.StatusBadGateway, sl.Err().Error())
		return
	}
	writeJSON(w, buckets)
}

func (h *KVHandler) CreateBucket(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var cfg struct {
		Bucket       string `json:"bucket"`
		Description  string `json:"description,omitempty"`
		History      int64  `json:"history,omitempty"`
		TTL          int64  `json:"ttl,omitempty"`
		MaxValueSize int32  `json:"maxValueSize,omitempty"`
		MaxBytes     int64  `json:"maxBytes,omitempty"`
		Storage      string `json:"storage,omitempty"`
		Replicas     int    `json:"replicas,omitempty"`
	}
	if err := decodeBody(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if cfg.Bucket == "" {
		writeError(w, http.StatusBadRequest, "bucket required")
		return
	}

	kvcfg := jetstream.KeyValueConfig{Bucket: cfg.Bucket, Description: cfg.Description}
	if cfg.History > 0 && cfg.History <= 64 {
		kvcfg.History = uint8(cfg.History)
	}
	if cfg.TTL > 0 {
		kvcfg.TTL = time.Duration(cfg.TTL)
	}
	if cfg.MaxValueSize > 0 {
		kvcfg.MaxValueSize = cfg.MaxValueSize
	}
	if cfg.MaxBytes > 0 {
		kvcfg.MaxBytes = cfg.MaxBytes
	}
	if cfg.Replicas > 0 {
		kvcfg.Replicas = cfg.Replicas
	}
	if cfg.Storage == "memory" {
		kvcfg.Storage = jetstream.MemoryStorage
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if _, err := js.CreateKeyValue(ctx, kvcfg); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"success": true, "bucket": cfg.Bucket})
}

func (h *KVHandler) BucketStatus(w http.ResponseWriter, r *http.Request) {
	kv, ctx, cancel, ok := h.bucket(w, r)
	if !ok {
		return
	}
	defer cancel()

	status, err := kv.Status(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{
		"bucket":  status.Bucket(),
		"values":  status.Values(),
		"history": status.History(),
		"ttl":     int64(status.TTL()),
		"bytes":   status.Bytes(),
	})
}

func (h *KVHandler) ListKeys(w http.ResponseWriter, r *http.Request) {
	kv, ctx, cancel, ok := h.bucket(w, r)
	if !ok {
		return
	}
	defer cancel()

	keys, err := kv.Keys(ctx)
	if err != nil {
		if errors.Is(err, jetstream.ErrNoKeysFound) {
			writeJSON(w, []string{})
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, keys)
}

func KvEntryToMap(bucket string, e jetstream.KeyValueEntry) map[string]interface{} {
	op := "put"
	switch e.Operation() {
	case jetstream.KeyValueDelete:
		op = "delete"
	case jetstream.KeyValuePurge:
		op = "purge"
	}
	payload, payloadType := message.EncodePayload(e.Value())
	return map[string]interface{}{
		"bucket":      bucket,
		"key":         e.Key(),
		"value":       payload,
		"payloadType": payloadType,
		"size":        len(e.Value()),
		"revision":    e.Revision(),
		"created":     e.Created().Format(time.RFC3339Nano),
		"operation":   op,
	}
}

func (h *KVHandler) GetEntry(w http.ResponseWriter, r *http.Request) {
	kv, ctx, cancel, ok := h.bucket(w, r)
	if !ok {
		return
	}
	defer cancel()

	bucket := urlParam(r, "bucket")
	key := urlParam(r, "key")

	entry, err := kv.Get(ctx, key)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	history := make([]map[string]interface{}, 0)
	if entries, err := kv.History(ctx, key); err == nil {
		for _, e := range entries {
			history = append(history, KvEntryToMap(bucket, e))
		}
	}

	out := KvEntryToMap(bucket, entry)
	out["history"] = history
	writeJSON(w, out)
}

func (h *KVHandler) PutEntry(w http.ResponseWriter, r *http.Request) {
	kv, ctx, cancel, ok := h.bucket(w, r)
	if !ok {
		return
	}
	defer cancel()

	var body struct {
		Value string `json:"value"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	rev, err := kv.Put(ctx, urlParam(r, "key"), []byte(body.Value))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"success": true, "revision": rev})
}

func (h *KVHandler) DeleteEntry(w http.ResponseWriter, r *http.Request) {
	kv, ctx, cancel, ok := h.bucket(w, r)
	if !ok {
		return
	}
	defer cancel()

	if err := kv.Delete(ctx, urlParam(r, "key")); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *KVHandler) PurgeKey(w http.ResponseWriter, r *http.Request) {
	kv, ctx, cancel, ok := h.bucket(w, r)
	if !ok {
		return
	}
	defer cancel()

	if err := kv.Purge(ctx, urlParam(r, "key")); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *KVHandler) DeleteBucket(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := js.DeleteKeyValue(ctx, urlParam(r, "bucket")); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}
