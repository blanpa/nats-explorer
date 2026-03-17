package handler

import (
	"encoding/json"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
	"nats-explorer/internal/connection"
)

type PublishHandler struct {
	Store *connection.Store
}

func (h *PublishHandler) Publish(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ConnID  string              `json:"connId"`
		Subject string              `json:"subject"`
		Payload string              `json:"payload"`
		Headers map[string][]string `json:"headers,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	connID := body.ConnID
	if connID == "" {
		connID = r.URL.Query().Get("connId")
	}
	if connID == "" {
		writeError(w, http.StatusBadRequest, "connId required")
		return
	}

	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	msg := &nats.Msg{
		Subject: body.Subject,
		Data:    []byte(body.Payload),
	}

	if len(body.Headers) > 0 {
		msg.Header = make(nats.Header)
		for k, vals := range body.Headers {
			for _, v := range vals {
				msg.Header.Add(k, v)
			}
		}
	}

	if err := nc.PublishMsg(msg); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, map[string]bool{"success": true})
}

func (h *PublishHandler) Request(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ConnID  string              `json:"connId"`
		Subject string              `json:"subject"`
		Payload string              `json:"payload"`
		Timeout int                 `json:"timeout"`
		Headers map[string][]string `json:"headers,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	connID := body.ConnID
	if connID == "" {
		connID = r.URL.Query().Get("connId")
	}
	if connID == "" {
		writeError(w, http.StatusBadRequest, "connId required")
		return
	}

	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	timeout := time.Duration(body.Timeout) * time.Millisecond
	if timeout == 0 {
		timeout = 5 * time.Second
	}

	msg := &nats.Msg{
		Subject: body.Subject,
		Data:    []byte(body.Payload),
	}
	if len(body.Headers) > 0 {
		msg.Header = make(nats.Header)
		for k, vals := range body.Headers {
			for _, v := range vals {
				msg.Header.Add(k, v)
			}
		}
	}

	resp, err := nc.RequestMsg(msg, timeout)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	payload := string(resp.Data)
	payloadType := "string"
	if !utf8.Valid(resp.Data) {
		payloadType = "binary"
	} else if len(payload) > 0 && (payload[0] == '{' || payload[0] == '[') {
		if json.Valid(resp.Data) {
			payloadType = "json"
		}
	}

	writeJSON(w, map[string]interface{}{
		"subject":     resp.Subject,
		"payload":     payload,
		"payloadType": payloadType,
		"reply":       resp.Reply,
		"size":        len(resp.Data),
	})
}
