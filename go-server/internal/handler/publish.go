package handler

import (
	"fmt"
	mrand "math/rand"
	"net/http"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/message"
)

type PublishHandler struct {
	Store *connection.Store
}

type publishBody struct {
	ConnID  string              `json:"connId"`
	Subject string              `json:"subject"`
	Payload string              `json:"payload"`
	Headers map[string][]string `json:"headers,omitempty"`
	Timeout int                 `json:"timeout,omitempty"` // ms, request only
	// PayloadType "binary" means Payload is base64 and the bytes are what
	// gets sent: hex, base64 and protobuf are written in the browser and
	// arrive here as bytes, because JSON has no way to carry them otherwise.
	PayloadType string `json:"payloadType,omitempty"`
	// Expect, when given, judges the reply; see run.go.
	Expect *Expect `json:"expect,omitempty"`
}

func (h *PublishHandler) parse(w http.ResponseWriter, r *http.Request) (*nats.Conn, *nats.Msg, publishBody, bool) {
	var body publishBody
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, body, false
	}
	if body.ConnID == "" {
		body.ConnID = connIDFromRequest(r)
	}
	if body.ConnID == "" {
		writeError(w, http.StatusBadRequest, "connId required")
		return nil, nil, body, false
	}
	if body.Subject == "" {
		writeError(w, http.StatusBadRequest, "subject required")
		return nil, nil, body, false
	}

	nc, err := h.Store.GetNC(body.ConnID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, body, false
	}

	// The placeholders are offered under the payload whether a message is
	// sent once or a thousand times; a single send expanded none of them and
	// published the literal `{{uuid}}`, which is exactly the value nobody
	// wants in an idempotency key. i is 1: this is the first message, and
	// the only one.
	now := time.Now()
	rnd := mrand.New(mrand.NewSource(now.UnixNano()))
	data, err := payloadBytes(body.Payload, body.PayloadType, 1, now, rnd)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, body, false
	}
	msg := &nats.Msg{Subject: expandTemplate(body.Subject, 1, now, rnd), Data: data}
	if len(body.Headers) > 0 {
		msg.Header = make(nats.Header)
		for k, vals := range body.Headers {
			for _, v := range vals {
				msg.Header.Add(k, expandTemplate(v, 1, now, rnd))
			}
		}
	}
	return nc, msg, body, true
}

func (h *PublishHandler) Publish(w http.ResponseWriter, r *http.Request) {
	nc, msg, _, ok := h.parse(w, r)
	if !ok {
		return
	}
	if err := nc.PublishMsg(msg); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := nc.FlushTimeout(2 * time.Second); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *PublishHandler) Request(w http.ResponseWriter, r *http.Request) {
	nc, msg, body, ok := h.parse(w, r)
	if !ok {
		return
	}

	timeout := time.Duration(body.Timeout) * time.Millisecond
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if timeout > 60*time.Second {
		timeout = 60 * time.Second
	}

	started := time.Now()
	resp, err := nc.RequestMsg(msg, timeout)
	if err != nil {
		status := http.StatusBadGateway
		if err == nats.ErrTimeout {
			status = http.StatusGatewayTimeout
		} else if err == nats.ErrNoResponders {
			status = http.StatusNotFound
		}
		writeError(w, status, err.Error())
		return
	}

	payload, payloadType := message.EncodePayload(resp.Data)
	elapsed := float64(time.Since(started).Microseconds()) / 1000.0
	out := map[string]interface{}{
		"subject":     resp.Subject,
		"payload":     payload,
		"payloadType": payloadType,
		"reply":       resp.Reply,
		"size":        len(resp.Data),
		"durationMs":  elapsed,
	}
	if len(resp.Header) > 0 {
		out["headers"] = resp.Header
	}
	if body.Expect != nil {
		prog, err := compileExpect(body.Expect)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		v := &Verdict{Checked: 1}
		if !replyMatches(prog, resp, started) {
			v.Failed++
			v.Reasons = append(v.Reasons, "the reply does not satisfy "+body.Expect.Expr)
		}
		if body.Expect.MaxLatencyMs > 0 && elapsed > body.Expect.MaxLatencyMs {
			v.Failed++
			v.Reasons = append(v.Reasons, fmt.Sprintf("%.1f ms over the %.0f ms allowed", elapsed, body.Expect.MaxLatencyMs))
		}
		v.Passed = v.Failed == 0
		out["verdict"] = v
	}
	writeJSON(w, out)
}
