package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/connection"
)

type ServicesHandler struct {
	Store *connection.Store
}

const (
	defaultDiscoverWait = 1200 * time.Millisecond
	maxDiscoverWait     = 10 * time.Second
	maxDiscoverResults  = 500
)

// discoverVia publishes a $SRV request and collects every reply that arrives
// within the wait window. Replies are appended under a mutex because the
// subscription callback runs on the NATS client goroutine.
func (h *ServicesHandler) discoverVia(w http.ResponseWriter, r *http.Request, subject string) {
	nc, err := h.Store.GetNC(connIDFromRequest(r))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	wait := defaultDiscoverWait
	if ms, err := strconv.Atoi(r.URL.Query().Get("waitMs")); err == nil && ms > 0 {
		wait = time.Duration(ms) * time.Millisecond
		if wait > maxDiscoverWait {
			wait = maxDiscoverWait
		}
	}

	var mu sync.Mutex
	results := make([]json.RawMessage, 0)

	inbox := nc.NewRespInbox()
	sub, err := nc.Subscribe(inbox, func(msg *nats.Msg) {
		// Without a responder the server answers with an empty 503 message.
		// It carries no service, and passing it on would put a null into the
		// list the browser reads.
		if !isServiceReply(msg) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if len(results) < maxDiscoverResults {
			results = append(results, json.RawMessage(append([]byte(nil), msg.Data...)))
		}
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer sub.Unsubscribe()

	if err := nc.PublishRequest(subject, inbox, nil); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	nc.Flush()

	select {
	case <-time.After(wait):
	case <-r.Context().Done():
		return
	}

	mu.Lock()
	out := make([]json.RawMessage, len(results))
	copy(out, results)
	mu.Unlock()

	writeJSON(w, out)
}

// isServiceReply reports whether a reply carries a service description: a
// JSON object, not a status message and not empty.
func isServiceReply(msg *nats.Msg) bool {
	if msg.Header.Get("Status") != "" {
		return false
	}
	data := bytes.TrimSpace(msg.Data)
	return len(data) > 0 && data[0] == '{' && json.Valid(data)
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
