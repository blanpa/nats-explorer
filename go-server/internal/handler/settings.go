package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"nats-explorer/internal/settings"
)

// SettingsHandler exposes the file-backed settings store (desktop app or
// STORAGE_DIR). The browser mirrors these entries into its local storage.
type SettingsHandler struct {
	Store *settings.Store
}

const maxSettingBytes = 4 << 20

func (h *SettingsHandler) All(w http.ResponseWriter, r *http.Request) {
	entries, err := h.Store.All()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"entries": entries})
}

func (h *SettingsHandler) Put(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSettingBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body) > maxSettingBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "setting too large")
		return
	}
	if err := h.Store.Set(urlParam(r, "key"), json.RawMessage(body)); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *SettingsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.Delete(urlParam(r, "key")); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}
