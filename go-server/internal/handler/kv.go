package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
		buckets = append(buckets, kvBucketToMap(si))
	}
	if sl.Err() != nil && len(buckets) == 0 {
		writeError(w, http.StatusBadGateway, sl.Err().Error())
		return
	}
	writeJSON(w, buckets)
}

// kvBucketToMap describes a bucket from its backing stream, the way the
// listing and the detail both show it.
func kvBucketToMap(si *jetstream.StreamInfo) map[string]interface{} {
	c := si.Config
	out := map[string]interface{}{
		"bucket":            strings.TrimPrefix(c.Name, kvStreamPrefix),
		"description":       c.Description,
		"values":            si.State.Msgs,
		"history":           c.MaxMsgsPerSubject,
		"ttl":               int64(c.MaxAge),
		"maxValueSize":      c.MaxMsgSize,
		"maxBytes":          c.MaxBytes,
		"storage":           c.Storage.String(),
		"replicas":          c.Replicas,
		"bytes":             si.State.Bytes,
		"backingStreamName": c.Name,
		"compression":       c.Compression == jetstream.S2Compression,
	}
	if c.Mirror != nil {
		out["mirror"] = kvSourceMap(c.Mirror)
	}
	if len(c.Sources) > 0 {
		list := make([]map[string]interface{}, 0, len(c.Sources))
		for _, src := range c.Sources {
			list = append(list, kvSourceMap(src))
		}
		out["sources"] = list
	}
	if len(c.Metadata) > 0 {
		out["metadata"] = c.Metadata
	}
	if c.Placement != nil {
		out["placement"] = map[string]interface{}{"cluster": c.Placement.Cluster, "tags": c.Placement.Tags}
	}
	return out
}

// kvSourceMap names a mirror or source bucket; the backing stream's name
// is KV_<bucket>, which is what the reader typed.
func kvSourceMap(src *jetstream.StreamSource) map[string]interface{} {
	out := map[string]interface{}{"bucket": strings.TrimPrefix(src.Name, kvStreamPrefix)}
	if src.Domain != "" {
		out["domain"] = src.Domain
	}
	if src.External != nil {
		out["externalApi"] = src.External.APIPrefix
	}
	return out
}

// kvBucketBody is a bucket as the UI writes it, for create and update.
type kvBucketBody struct {
	Bucket       string `json:"bucket"`
	Description  string `json:"description,omitempty"`
	History      int64  `json:"history,omitempty"`
	TTL          int64  `json:"ttl,omitempty"`
	MaxValueSize int32  `json:"maxValueSize,omitempty"`
	MaxBytes     int64  `json:"maxBytes,omitempty"`
	Storage      string `json:"storage,omitempty"`
	Replicas     int    `json:"replicas,omitempty"`
	Compression  *bool  `json:"compression,omitempty"`
	// Mirror and Sources name buckets, with a domain or an API prefix for
	// one elsewhere. Present and empty takes them away.
	Mirror   optionalRaw `json:"mirror"`
	Sources  optionalRaw `json:"sources"`
	Metadata optionalRaw `json:"metadata"`
}

type kvSourceBody struct {
	Bucket      string `json:"bucket"`
	Domain      string `json:"domain,omitempty"`
	ExternalAPI string `json:"externalApi,omitempty"`
}

func (b kvSourceBody) toSource() *jetstream.StreamSource {
	name := strings.TrimSpace(b.Bucket)
	if name == "" {
		return nil
	}
	src := &jetstream.StreamSource{Name: kvStreamPrefix + strings.TrimPrefix(name, kvStreamPrefix), Domain: strings.TrimSpace(b.Domain)}
	if api := strings.TrimSpace(b.ExternalAPI); api != "" {
		src.External = &jetstream.ExternalStream{APIPrefix: api}
	}
	return src
}

// applyKVBody copies the fields the body carries onto a bucket config.
func applyKVBody(kvcfg *jetstream.KeyValueConfig, cfg kvBucketBody) {
	if cfg.Description != "" || kvcfg.Description != "" {
		kvcfg.Description = cfg.Description
	}
	if cfg.History > 0 && cfg.History <= 64 {
		kvcfg.History = uint8(cfg.History)
	}
	if cfg.TTL >= 0 {
		kvcfg.TTL = time.Duration(cfg.TTL)
	}
	if cfg.MaxValueSize != 0 {
		kvcfg.MaxValueSize = cfg.MaxValueSize
	}
	if cfg.MaxBytes != 0 {
		kvcfg.MaxBytes = cfg.MaxBytes
	}
	if cfg.Replicas > 0 {
		kvcfg.Replicas = cfg.Replicas
	}
	switch cfg.Storage {
	case "memory":
		kvcfg.Storage = jetstream.MemoryStorage
	case "file":
		kvcfg.Storage = jetstream.FileStorage
	}
	if cfg.Compression != nil {
		kvcfg.Compression = *cfg.Compression
	}
	if cfg.Mirror.set {
		kvcfg.Mirror = nil
		if !cfg.Mirror.isNull() {
			var m kvSourceBody
			if json.Unmarshal(cfg.Mirror.raw, &m) == nil {
				kvcfg.Mirror = m.toSource()
			}
		}
	}
	if cfg.Sources.set {
		kvcfg.Sources = nil
		if !cfg.Sources.isNull() {
			var list []kvSourceBody
			if json.Unmarshal(cfg.Sources.raw, &list) == nil {
				for _, sb := range list {
					if src := sb.toSource(); src != nil {
						kvcfg.Sources = append(kvcfg.Sources, src)
					}
				}
			}
		}
	}
	if cfg.Metadata.set {
		kept := map[string]string{}
		for k, v := range kvcfg.Metadata {
			if strings.HasPrefix(k, "_nats.") {
				kept[k] = v
			}
		}
		if !cfg.Metadata.isNull() {
			var md map[string]string
			if json.Unmarshal(cfg.Metadata.raw, &md) == nil {
				for k, v := range md {
					if !strings.HasPrefix(k, "_nats.") {
						kept[k] = v
					}
				}
			}
		}
		kvcfg.Metadata = kept
		if len(kept) == 0 {
			kvcfg.Metadata = nil
		}
	}
}

func (h *KVHandler) CreateBucket(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var cfg kvBucketBody
	if err := decodeBody(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if cfg.Bucket == "" {
		writeError(w, http.StatusBadRequest, "bucket required")
		return
	}

	kvcfg := jetstream.KeyValueConfig{Bucket: cfg.Bucket}
	applyKVBody(&kvcfg, cfg)

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if _, err := js.CreateKeyValue(ctx, kvcfg); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"success": true, "bucket": cfg.Bucket})
}

// UpdateBucket answers PUT /api/kv/{bucket}: the bucket's limits, TTL,
// replicas, sources and metadata, read from its backing stream first so a
// field the body leaves out stays what it was. Storage and history are
// what they were made with.
func (h *KVHandler) UpdateBucket(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var cfg kvBucketBody
	if err := decodeBody(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	bucket := urlParam(r, "bucket")
	s, err := js.Stream(ctx, kvStreamPrefix+bucket)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	c := info.Config
	kvcfg := jetstream.KeyValueConfig{
		Bucket: bucket, Description: c.Description, MaxValueSize: c.MaxMsgSize, History: uint8(c.MaxMsgsPerSubject), TTL: c.MaxAge,
		MaxBytes: c.MaxBytes, Storage: c.Storage, Replicas: c.Replicas, Placement: c.Placement, RePublish: c.RePublish,
		Mirror: c.Mirror, Sources: c.Sources, Compression: c.Compression == jetstream.S2Compression, Metadata: c.Metadata,
	}
	cfg.Bucket = bucket
	cfg.Storage = ""
	applyKVBody(&kvcfg, cfg)
	if _, err := js.UpdateKeyValue(ctx, kvcfg); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	updated, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, kvBucketToMap(updated))
}

// DeleteKeys answers POST /api/kv/{bucket}/delete with {"keys": [...],
// "purge": bool}: every key named, one after the other, with what failed
// named back rather than the whole call failing on the first.
func (h *KVHandler) DeleteKeys(w http.ResponseWriter, r *http.Request) {
	kv, ctx, cancel, ok := h.bucket(w, r)
	if !ok {
		return
	}
	defer cancel()
	var body struct {
		Keys  []string `json:"keys"`
		Purge bool     `json:"purge"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Keys) == 0 || len(body.Keys) > 10000 {
		writeError(w, http.StatusBadRequest, "between 1 and 10000 keys")
		return
	}
	failed := map[string]string{}
	deleted := 0
	for _, key := range body.Keys {
		var err error
		if body.Purge {
			err = kv.Purge(ctx, key)
		} else {
			err = kv.Delete(ctx, key)
		}
		if err != nil {
			failed[key] = err.Error()
			continue
		}
		deleted++
	}
	writeJSON(w, map[string]interface{}{"deleted": deleted, "failed": failed})
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
		// Revision, when given, is the one the value was read at: the put
		// only goes through if nobody wrote in between. Zero says the key
		// must not exist yet.
		Revision *uint64 `json:"revision"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	key := urlParam(r, "key")
	var rev uint64
	var err error
	switch {
	case body.Revision == nil:
		rev, err = kv.Put(ctx, key, []byte(body.Value))
	case *body.Revision == 0:
		rev, err = kv.Create(ctx, key, []byte(body.Value))
	default:
		rev, err = kv.Update(ctx, key, []byte(body.Value), *body.Revision)
	}
	if err != nil {
		// A write that lost the race is a conflict, not a gateway fault:
		// the reader wants the current revision, to look again.
		if errors.Is(err, jetstream.ErrKeyExists) || strings.Contains(err.Error(), "wrong last sequence") {
			current, _ := kv.Get(ctx, key)
			out := map[string]interface{}{"error": "the key changed since it was read"}
			if current != nil {
				out["revision"] = current.Revision()
				out["error"] = fmt.Sprintf("the key changed since it was read; it is at revision %d now", current.Revision())
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(out)
			return
		}
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
