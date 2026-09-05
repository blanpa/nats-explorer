package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
)

type ObjectStoreHandler struct {
	Store *connection.Store
}

const objStreamPrefix = "OBJ_"

func (h *ObjectStoreHandler) store(w http.ResponseWriter, r *http.Request, timeout time.Duration) (jetstream.ObjectStore, context.Context, context.CancelFunc, bool) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	os, err := js.ObjectStore(ctx, urlParam(r, "store"))
	if err != nil {
		cancel()
		writeError(w, http.StatusNotFound, err.Error())
		return nil, nil, nil, false
	}
	return os, ctx, cancel, true
}

func (h *ObjectStoreHandler) ListStores(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	stores := make([]map[string]interface{}, 0)
	sl := js.ListStreams(ctx)
	for si := range sl.Info() {
		if !strings.HasPrefix(si.Config.Name, objStreamPrefix) {
			continue
		}
		stores = append(stores, map[string]interface{}{
			"bucket":            strings.TrimPrefix(si.Config.Name, objStreamPrefix),
			"description":       si.Config.Description,
			"size":              si.State.Bytes,
			"storage":           si.Config.Storage.String(),
			"sealed":            si.Config.Sealed,
			"replicas":          si.Config.Replicas,
			"chunks":            si.State.Msgs,
			"backingStreamName": si.Config.Name,
		})
	}
	if sl.Err() != nil && len(stores) == 0 {
		writeError(w, http.StatusBadGateway, sl.Err().Error())
		return
	}
	writeJSON(w, stores)
}

func (h *ObjectStoreHandler) CreateStore(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var cfg struct {
		Bucket      string `json:"bucket"`
		Description string `json:"description,omitempty"`
		MaxBytes    int64  `json:"maxBytes,omitempty"`
		Storage     string `json:"storage,omitempty"`
		Replicas    int    `json:"replicas,omitempty"`
		TTL         int64  `json:"ttl,omitempty"`
	}
	if err := decodeBody(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if cfg.Bucket == "" {
		writeError(w, http.StatusBadRequest, "bucket required")
		return
	}

	oscfg := jetstream.ObjectStoreConfig{Bucket: cfg.Bucket, Description: cfg.Description}
	if cfg.MaxBytes > 0 {
		oscfg.MaxBytes = cfg.MaxBytes
	}
	if cfg.Replicas > 0 {
		oscfg.Replicas = cfg.Replicas
	}
	if cfg.TTL > 0 {
		oscfg.TTL = time.Duration(cfg.TTL)
	}
	if cfg.Storage == "memory" {
		oscfg.Storage = jetstream.MemoryStorage
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if _, err := js.CreateObjectStore(ctx, oscfg); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"success": true, "bucket": cfg.Bucket})
}

func (h *ObjectStoreHandler) DeleteStore(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := js.DeleteObjectStore(ctx, urlParam(r, "store")); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *ObjectStoreHandler) ListObjects(w http.ResponseWriter, r *http.Request) {
	os, ctx, cancel, ok := h.store(w, r, 10*time.Second)
	if !ok {
		return
	}
	defer cancel()

	objects := make([]map[string]interface{}, 0)
	list, err := os.List(ctx)
	if err != nil {
		if err == jetstream.ErrNoObjectsFound {
			writeJSON(w, objects)
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	for _, info := range list {
		if info.Deleted {
			continue
		}
		objects = append(objects, map[string]interface{}{
			"name":        info.Name,
			"description": info.Description,
			"size":        info.Size,
			"chunks":      info.Chunks,
			"nuid":        info.NUID,
			"digest":      info.Digest,
			"deleted":     info.Deleted,
			"mtime":       info.ModTime.Format(time.RFC3339),
			"headers":     info.Headers,
		})
	}
	writeJSON(w, objects)
}

func (h *ObjectStoreHandler) GetObject(w http.ResponseWriter, r *http.Request) {
	os, ctx, cancel, ok := h.store(w, r, 60*time.Second)
	if !ok {
		return
	}
	defer cancel()

	objName := urlParam(r, "name")
	result, err := os.Get(ctx, objName)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	defer result.Close()

	ctype := mime.TypeByExtension(extOf(objName))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": objName}))
	if info, err := result.Info(); err == nil && info.Size > 0 {
		w.Header().Set("Content-Length", uintToString(info.Size))
	}
	io.Copy(w, result)
}

// PutObject accepts either a raw body (any Content-Type except JSON) or a JSON
// envelope {"data": "<base64>", "description": "..."}.
func (h *ObjectStoreHandler) PutObject(w http.ResponseWriter, r *http.Request) {
	os, ctx, cancel, ok := h.store(w, r, 5*time.Minute)
	if !ok {
		return
	}
	defer cancel()

	objName := urlParam(r, "name")
	meta := jetstream.ObjectMeta{Name: objName}

	var reader io.Reader
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var body struct {
			Data        string `json:"data"`
			Description string `json:"description,omitempty"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		data, err := base64.StdEncoding.DecodeString(body.Data)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid base64 data")
			return
		}
		meta.Description = body.Description
		reader = bytes.NewReader(data)
	} else {
		meta.Description = r.URL.Query().Get("description")
		reader = r.Body
	}

	info, err := os.Put(ctx, meta, reader)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{
		"success": true,
		"name":    objName,
		"size":    info.Size,
		"chunks":  info.Chunks,
	})
}

func (h *ObjectStoreHandler) DeleteObject(w http.ResponseWriter, r *http.Request) {
	os, ctx, cancel, ok := h.store(w, r, 10*time.Second)
	if !ok {
		return
	}
	defer cancel()

	if err := os.Delete(ctx, urlParam(r, "name")); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func extOf(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return name[i:]
	}
	return ""
}

func uintToString(n uint64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
