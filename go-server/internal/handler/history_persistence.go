package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"nats-explorer/internal/history"
)

// The persistent history as a setting. Without this the SQLite copy could
// only be turned on with an environment variable, which the desktop app has
// no way to set -- so its history did not survive a restart.

// Persistence answers GET /api/history/persistence.
func (h *HistoryHandler) Persistence(w http.ResponseWriter, r *http.Request) {
	if h.Persist == nil {
		writeError(w, http.StatusNotFound, "not available")
		return
	}
	writeJSON(w, h.Persist.Status())
}

// SetPersistence answers PUT /api/history/persistence: switch the database
// on or off, change the retention, and with purge delete the file.
func (h *HistoryHandler) SetPersistence(w http.ResponseWriter, r *http.Request) {
	if h.Persist == nil {
		writeError(w, http.StatusNotFound, "not available")
		return
	}
	var body struct {
		Enabled   bool   `json:"enabled"`
		Retention string `json:"retention"`
		// FullText fills the word index behind the search over the persistent
		// history. Absent means on: it is what an older client expects.
		FullText *bool `json:"fullText"`
		// Purge deletes the database file when switching off, so the stored
		// payloads really are gone.
		Purge bool `json:"purge"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	retention := history.DefaultRetention
	if body.Retention != "" {
		d, err := time.ParseDuration(body.Retention)
		if err != nil {
			writeError(w, http.StatusBadRequest, "retention must be a duration like 24h")
			return
		}
		retention = d
	}
	fullText := body.FullText == nil || *body.FullText
	if err := h.Persist.Set(body.Enabled, retention, fullText, body.Purge); err != nil {
		status := http.StatusBadRequest
		switch {
		case errors.Is(err, history.ErrManaged), errors.Is(err, history.ErrUnsupported):
			status = http.StatusConflict
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, h.Persist.Status())
}
