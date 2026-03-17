package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"nats-explorer/internal/connection"
)

type ObjectStoreHandler struct {
	Store *connection.Store
}

func (h *ObjectStoreHandler) getJS(r *http.Request) (jetstream.JetStream, error) {
	connID := getConnID(r)
	nc, err := h.Store.GetNC(connID)
	if err != nil { return nil, err }
	return jetstream.New(nc)
}

func (h *ObjectStoreHandler) ListStores(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	stores := make([]map[string]interface{}, 0)
	sl := js.ListStreams(ctx)
	for si := range sl.Info() {
		if strings.HasPrefix(si.Config.Name, "OBJ_") {
			storeName := si.Config.Name[4:]
			stores = append(stores, map[string]interface{}{
				"bucket":            storeName,
				"description":       si.Config.Description,
				"size":              si.State.Bytes,
				"storage":           si.Config.Storage.String(),
				"sealed":            si.Config.Sealed,
				"replicas":          si.Config.Replicas,
				"chunks":            si.State.Msgs,
				"backingStreamName": si.Config.Name,
			})
		}
	}
	writeJSON(w, stores)
}

func (h *ObjectStoreHandler) CreateStore(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	var cfg struct {
		Bucket      string `json:"bucket"`
		Description string `json:"description,omitempty"`
		MaxBytes    int64  `json:"maxBytes,omitempty"`
		Storage     string `json:"storage,omitempty"`
		Replicas    int    `json:"replicas,omitempty"`
		TTL         int64  `json:"ttl,omitempty"`
	}
	json.NewDecoder(r.Body).Decode(&cfg)

	oscfg := jetstream.ObjectStoreConfig{
		Bucket:      cfg.Bucket,
		Description: cfg.Description,
	}
	if cfg.MaxBytes > 0 { oscfg.MaxBytes = cfg.MaxBytes }
	if cfg.Replicas > 0 { oscfg.Replicas = cfg.Replicas }
	if cfg.TTL > 0 { oscfg.TTL = time.Duration(cfg.TTL) }
	if cfg.Storage == "memory" { oscfg.Storage = jetstream.MemoryStorage }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	_, err = js.CreateObjectStore(ctx, oscfg)
	if err != nil { writeError(w, http.StatusInternalServerError, err.Error()); return }
	writeJSON(w, map[string]interface{}{"success": true, "bucket": cfg.Bucket})
}

func (h *ObjectStoreHandler) ListObjects(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	storeName := chi_URLParam(r, "store")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	os, err := js.ObjectStore(ctx, storeName)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	objects := make([]map[string]interface{}, 0)
	list, err := os.List(ctx)
	if err != nil { writeJSON(w, objects); return }

	for _, info := range list {
		if info.Deleted { continue }
		objects = append(objects, map[string]interface{}{
			"name":        info.Name,
			"description": info.Description,
			"size":        info.Size,
			"chunks":      info.Chunks,
			"nuid":        info.NUID,
			"deleted":     info.Deleted,
			"mtime":       info.ModTime.Format(time.RFC3339),
		})
	}
	writeJSON(w, objects)
}

func (h *ObjectStoreHandler) GetObject(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	storeName := chi_URLParam(r, "store")
	objName := chi_URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	os, err := js.ObjectStore(ctx, storeName)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	result, err := os.Get(ctx, objName)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }
	defer result.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+objName+`"`)
	io.Copy(w, result)
}

func (h *ObjectStoreHandler) PutObject(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	storeName := chi_URLParam(r, "store")
	objName := chi_URLParam(r, "name")

	var body struct {
		Data        string `json:"data"` // base64 encoded
		Description string `json:"description,omitempty"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.Data == "" {
		writeError(w, http.StatusBadRequest, "data (base64) required")
		return
	}

	data, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid base64 data")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	os, err := js.ObjectStore(ctx, storeName)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	meta := jetstream.ObjectMeta{Name: objName, Description: body.Description}
	info, err := os.Put(ctx, meta, bytes.NewReader(data))
	if err != nil { writeError(w, http.StatusInternalServerError, err.Error()); return }

	writeJSON(w, map[string]interface{}{
		"success": true,
		"name":    objName,
		"size":    info.Size,
		"chunks":  info.Chunks,
	})
}

func (h *ObjectStoreHandler) DeleteObject(w http.ResponseWriter, r *http.Request) {
	js, err := h.getJS(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	storeName := chi_URLParam(r, "store")
	objName := chi_URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	os, err := js.ObjectStore(ctx, storeName)
	if err != nil { writeError(w, http.StatusNotFound, err.Error()); return }

	if err := os.Delete(ctx, objName); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}
