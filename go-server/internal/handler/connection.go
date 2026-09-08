package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"nats-explorer/internal/connection"
)

type ConnectionHandler struct {
	Store          *connection.Store
	OnConnected    func(connID string, cfg connection.Config)
	OnDisconnected func(connID string)
	// OnSubscriptionsChanged restarts the live feed with the new patterns.
	OnSubscriptionsChanged func(connID string, cfg connection.Config)
}

// SetSubscriptions answers PUT /api/connections/{connId}/subscriptions with
// {"subscriptions": [...]} and switches the live feed of a connected server
// to the new patterns without reconnecting. An empty list means ">".
func (h *ConnectionHandler) SetSubscriptions(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Subscriptions []string `json:"subscriptions"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	subs, err := normalizeSubjects(body.Subscriptions)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	connID := urlParam(r, "connId")
	cfg, err := h.Store.SetSubscriptions(connID, subs)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if h.OnSubscriptionsChanged != nil {
		h.OnSubscriptionsChanged(connID, cfg)
	}
	writeJSON(w, map[string]interface{}{"success": true, "status": h.Store.GetStatus(connID)})
}

// normalizeSubjects trims, de-duplicates and validates subject patterns.
func normalizeSubjects(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool)
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		if strings.ContainsAny(s, " \t\r\n") {
			return nil, fmt.Errorf("subject %q must not contain whitespace", s)
		}
		for _, tok := range strings.Split(s, ".") {
			if tok == "" {
				return nil, fmt.Errorf("subject %q has an empty token", s)
			}
		}
		if i := strings.Index(s, ">"); i >= 0 && i != len(s)-1 {
			return nil, fmt.Errorf("subject %q: > is only allowed as the last token", s)
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(out) == 0 {
		out = []string{">"}
	}
	return out, nil
}

func (h *ConnectionHandler) Connect(w http.ResponseWriter, r *http.Request) {
	var cfg connection.Config
	if err := decodeBody(r, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if cfg.ID == "" {
		cfg.ID = generateID()
	}
	if cfg.Name == "" && len(cfg.Servers) > 0 {
		cfg.Name = cfg.Servers[0]
	}

	// Stop the old subscription manager first if this id is being replaced.
	if _, exists := h.Store.Get(cfg.ID); exists && h.OnDisconnected != nil {
		h.OnDisconnected(cfg.ID)
	}

	managed, err := h.Store.Connect(cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	if h.OnConnected != nil {
		h.OnConnected(managed.ID, cfg)
	}

	writeJSON(w, map[string]interface{}{
		"success": true,
		"id":      cfg.ID,
		"status":  h.Store.GetStatus(cfg.ID),
	})
}

func (h *ConnectionHandler) Disconnect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ConnID string `json:"connId"`
	}
	decodeBody(r, &body)
	if body.ConnID == "" {
		writeError(w, http.StatusBadRequest, "connId required")
		return
	}

	if h.OnDisconnected != nil {
		h.OnDisconnected(body.ConnID)
	}

	if err := h.Store.Disconnect(body.ConnID); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}

func (h *ConnectionHandler) DisconnectAll(w http.ResponseWriter, r *http.Request) {
	h.Store.DisconnectAll()
	writeJSON(w, map[string]bool{"success": true})
}

func (h *ConnectionHandler) ListConnections(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.Store.AllStatuses())
}

func (h *ConnectionHandler) Status(w http.ResponseWriter, r *http.Request) {
	connID := r.URL.Query().Get("connId")
	if connID != "" {
		writeJSON(w, h.Store.GetStatus(connID))
	} else {
		writeJSON(w, h.Store.AllStatuses())
	}
}

// ServerInfo returns what the client library knows about the server it is
// connected to, plus a JetStream availability probe and client-side stats.
func (h *ConnectionHandler) ServerInfo(w http.ResponseWriter, r *http.Request) {
	connID := urlParam(r, "connId")
	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	clientID, _ := nc.GetClientID()
	clientIP, _ := nc.GetClientIP()
	rtt, _ := nc.RTT()
	stats := nc.Stats()

	jsEnabled := false
	jsError := ""
	var jsAccount map[string]interface{}
	if js, err := jetStreamForConn(h.Store, connID, r.URL.Query().Get("domain")); err == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if info, err := js.AccountInfo(ctx); err == nil {
			jsEnabled = true
			jsAccount = map[string]interface{}{
				"memory":     info.Memory,
				"storage":    info.Store,
				"streams":    info.Streams,
				"consumers":  info.Consumers,
				"maxMemory":  info.Limits.MaxMemory,
				"maxStorage": info.Limits.MaxStore,
				"domain":     info.Domain,
			}
		} else {
			jsError = err.Error()
		}
	}

	clientIPStr := ""
	if clientIP != nil {
		clientIPStr = clientIP.String()
	}

	writeJSON(w, map[string]interface{}{
		"connId":       connID,
		"serverName":   nc.ConnectedServerName(),
		"serverId":     nc.ConnectedServerId(),
		"version":      nc.ConnectedServerVersion(),
		"cluster":      nc.ConnectedClusterName(),
		"url":          nc.ConnectedUrl(),
		"addr":         nc.ConnectedAddr(),
		"maxPayload":   nc.MaxPayload(),
		"clientId":     clientID,
		"clientIp":     clientIPStr,
		"headers":      nc.HeadersSupported(),
		"authRequired": nc.AuthRequired(),
		"tlsRequired":  nc.TLSRequired(),
		"rttMs":        float64(rtt.Microseconds()) / 1000.0,
		"jetstream":    jsEnabled,
		"jetstreamErr": jsError,
		"jsAccount":    jsAccount,
		"connectUrls":  nc.DiscoveredServers(),
		"servers":      nc.Servers(),
		"stats": map[string]interface{}{
			"inMsgs":     stats.InMsgs,
			"outMsgs":    stats.OutMsgs,
			"inBytes":    stats.InBytes,
			"outBytes":   stats.OutBytes,
			"reconnects": stats.Reconnects,
		},
	})
}
