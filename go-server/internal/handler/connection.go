package handler

import (
	"encoding/json"
	"net/http"

	"nats-explorer/internal/connection"
)

type ConnectionHandler struct {
	Store          *connection.Store
	OnConnected    func(connID string, cfg connection.Config)
	OnDisconnected func(connID string)
}

func (h *ConnectionHandler) Connect(w http.ResponseWriter, r *http.Request) {
	var cfg connection.Config
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if cfg.ID == "" {
		cfg.ID = generateID()
	}
	if cfg.Name == "" && len(cfg.Servers) > 0 {
		cfg.Name = cfg.Servers[0]
	}

	managed, err := h.Store.Connect(cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
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
	json.NewDecoder(r.Body).Decode(&body)
	if body.ConnID == "" {
		writeError(w, http.StatusBadRequest, "connId required")
		return
	}

	if h.OnDisconnected != nil {
		h.OnDisconnected(body.ConnID)
	}

	if err := h.Store.Disconnect(body.ConnID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
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

func (h *ConnectionHandler) ClusterInfo(w http.ResponseWriter, r *http.Request) {
	connID := chi_URLParam(r, "connId")
	nc, err := h.Store.GetNC(connID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Connection not found")
		return
	}

	if !nc.IsConnected() {
		writeError(w, http.StatusInternalServerError, "Not connected")
		return
	}

	clientID, _ := nc.GetClientID()
	clientIP, _ := nc.GetClientIP()

	clusterInfo := map[string]interface{}{
		"connId":       connID,
		"serverName":   nc.ConnectedServerName(),
		"serverId":     nc.ConnectedServerId(),
		"version":      nc.ConnectedServerVersion(),
		"cluster":      nc.ConnectedClusterName(),
		"maxPayload":   nc.MaxPayload(),
		"clientId":     clientID,
		"clientIp":     clientIP.String(),
		"headers":      nc.HeadersSupported(),
		"authRequired": nc.AuthRequired(),
		"connectUrls":  nc.DiscoveredServers(),
	}
	writeJSON(w, clusterInfo)
}
