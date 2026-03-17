package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"nats-explorer/internal/connection"
)

type KVHandler struct {
	Store *connection.Store
}

func (h *KVHandler) getJS(r *http.Request) (jetstream.JetStream, error) {
	connID := getConnID(r)
	nc, err := h.Store.GetNC(connID)
	if err != nil { return nil, err }
	return jetstream.New(nc)
}

func (h *KVHandler) ListBuckets(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	buckets := make([]map[string]interface{}, 0)
	sl := js.ListStreams(ctx)
	for si := range sl.Info() {
		if strings.HasPrefix(si.Config.Name, "KV_") {
			bucketName := si.Config.Name[3:]
			buckets = append(buckets, map[string]interface{}{
				"bucket":            bucketName,
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
	}
	writeJSON(w, buckets)
}

func (h *KVHandler) CreateBucket(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	var cfg struct {
		Bucket      string `json:"bucket"`
		Description string `json:"description,omitempty"`
		History     int64  `json:"history,omitempty"`
		TTL         int64  `json:"ttl,omitempty"`
		MaxValueSize int32  `json:"maxValueSize,omitempty"`
		MaxBytes    int64  `json:"maxBytes,omitempty"`
		Storage     string `json:"storage,omitempty"`
		Replicas    int    `json:"replicas,omitempty"`
	}
	json.NewDecoder(r.Body).Decode(&cfg)

	kvcfg := jetstream.KeyValueConfig{
		Bucket:      cfg.Bucket,
		Description: cfg.Description,
	}
	if cfg.History > 0 { kvcfg.History = uint8(cfg.History) }
	if cfg.TTL > 0 { kvcfg.TTL = time.Duration(cfg.TTL) }
	if cfg.MaxValueSize > 0 { kvcfg.MaxValueSize = cfg.MaxValueSize }
	if cfg.MaxBytes > 0 { kvcfg.MaxBytes = cfg.MaxBytes }
	if cfg.Replicas > 0 { kvcfg.Replicas = cfg.Replicas }
	if cfg.Storage == "memory" { kvcfg.Storage = jetstream.MemoryStorage }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	_, err = js.CreateKeyValue(ctx, kvcfg)
	if err != nil { writeError(w, http.StatusInternalServerError, err.Error()); return }
	writeJSON(w, map[string]interface{}{"success": true, "bucket": cfg.Bucket})
}

func (h *KVHandler) BucketStatus(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	bucket := chi_URLParam(r, "bucket")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	kv, err := js.KeyValue(ctx, bucket)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	status, err := kv.Status(ctx)
	if err != nil { writeError(w, http.StatusInternalServerError, err.Error()); return }

	writeJSON(w, map[string]interface{}{
		"bucket":  status.Bucket(),
		"values":  status.Values(),
		"history": status.History(),
		"ttl":     int64(status.TTL()),
		"bytes":   status.Bytes(),
	})
}

func (h *KVHandler) ListKeys(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	bucket := chi_URLParam(r, "bucket")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	kv, err := js.KeyValue(ctx, bucket)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	keys, err := kv.Keys(ctx)
	if err != nil {
		// Empty bucket
		writeJSON(w, []string{})
		return
	}
	writeJSON(w, keys)
}

func (h *KVHandler) GetEntry(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	bucket := chi_URLParam(r, "bucket")
	key := chi_URLParam(r, "key")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	kv, err := js.KeyValue(ctx, bucket)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	entry, err := kv.Get(ctx, key)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	// Get history
	history := make([]map[string]interface{}, 0)
	entries, err := kv.History(ctx, key)
	if err == nil {
		for _, e := range entries {
			op := "put"
			switch e.Operation() {
			case jetstream.KeyValueDelete: op = "delete"
			case jetstream.KeyValuePurge: op = "purge"
			}
			history = append(history, map[string]interface{}{
				"bucket":   bucket,
				"key":      e.Key(),
				"value":    string(e.Value()),
				"revision": e.Revision(),
				"created":  e.Created().Format(time.RFC3339),
				"operation": op,
			})
		}
	}

	writeJSON(w, map[string]interface{}{
		"bucket":   bucket,
		"key":      entry.Key(),
		"value":    string(entry.Value()),
		"revision": entry.Revision(),
		"created":  entry.Created().Format(time.RFC3339),
		"operation": "put",
		"history":  history,
	})
}

func (h *KVHandler) PutEntry(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	bucket := chi_URLParam(r, "bucket")
	key := chi_URLParam(r, "key")
	var body struct { Value string `json:"value"` }
	json.NewDecoder(r.Body).Decode(&body)

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	kv, err := js.KeyValue(ctx, bucket)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	rev, err := kv.Put(ctx, key, []byte(body.Value))
	if err != nil { writeError(w, http.StatusInternalServerError, err.Error()); return }

	writeJSON(w, map[string]interface{}{"success": true, "revision": rev})
}

func (h *KVHandler) DeleteEntry(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	bucket := chi_URLParam(r, "bucket")
	key := chi_URLParam(r, "key")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	kv, err := js.KeyValue(ctx, bucket)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	if err := kv.Delete(ctx, key); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *KVHandler) PurgeKey(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	bucket := chi_URLParam(r, "bucket")
	key := chi_URLParam(r, "key")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	kv, err := js.KeyValue(ctx, bucket)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	if err := kv.Purge(ctx, key); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *KVHandler) DeleteBucket(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	bucket := chi_URLParam(r, "bucket")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := js.DeleteKeyValue(ctx, bucket); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}
