package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/nats-io/nats.go"
	"nats-explorer/internal/connection"
)

type ServicesHandler struct {
	Store *connection.Store
}

func (h *ServicesHandler) discoverVia(w http.ResponseWriter, r *http.Request, subject string) {
	connID := r.URL.Query().Get("connId")
	if connID == "" {
		writeError(w, http.StatusBadRequest, "connId required")
		return
	}

	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	inbox := nc.NewRespInbox()
	results := make([]json.RawMessage, 0)
	sub, err := nc.Subscribe(inbox, func(msg *nats.Msg) {
		results = append(results, json.RawMessage(msg.Data))
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	sub.AutoUnsubscribe(50)
	defer sub.Unsubscribe()

	nc.PublishRequest(subject, inbox, nil)
	nc.Flush()

	time.Sleep(2 * time.Second)

	writeJSON(w, results)
}

func (h *ServicesHandler) Discover(w http.ResponseWriter, r *http.Request) {
	h.discoverVia(w, r, "$SRV.INFO")
}

func (h *ServicesHandler) Stats(w http.ResponseWriter, r *http.Request) {
	h.discoverVia(w, r, "$SRV.STATS")
}

func (h *ServicesHandler) Ping(w http.ResponseWriter, r *http.Request) {
	h.discoverVia(w, r, "$SRV.PING")
}
