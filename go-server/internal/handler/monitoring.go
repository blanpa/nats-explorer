package handler

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"nats-explorer/internal/connection"
)

type MonitoringHandler struct {
	Store *connection.Store
}

var allowedEndpoints = map[string]bool{
	"varz": true, "connz": true, "routez": true, "subsz": true,
	"jsz": true, "healthz": true, "accountz": true, "gatewayz": true, "leafz": true,
}

const defaultMonitoringPort = 8222

// monitoringBaseURL derives the HTTP monitoring endpoint from the connection
// config: an explicit URL wins, then an explicit port, then 8222 on the host
// of the first server URL.
func monitoringBaseURL(cfg connection.Config) (string, error) {
	if cfg.MonitoringURL != "" {
		return strings.TrimRight(cfg.MonitoringURL, "/"), nil
	}
	if len(cfg.Servers) == 0 {
		return "", fmt.Errorf("no server configured")
	}

	raw := cfg.Servers[0]
	if !strings.Contains(raw, "://") {
		raw = "nats://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("cannot parse server url: %w", err)
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("cannot determine host from %q", cfg.Servers[0])
	}

	port := cfg.MonitoringPort
	if port == 0 {
		port = defaultMonitoringPort
	}
	scheme := "http"
	return fmt.Sprintf("%s://%s", scheme, net.JoinHostPort(host, strconv.Itoa(port))), nil
}

func (h *MonitoringHandler) Proxy(w http.ResponseWriter, r *http.Request) {
	connID := urlParam(r, "connId")
	endpoint := urlParam(r, "endpoint")

	if !allowedEndpoints[endpoint] {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid endpoint: %s", endpoint))
		return
	}

	managed, ok := h.Store.Get(connID)
	if !ok {
		writeError(w, http.StatusNotFound, "Connection not found")
		return
	}

	base, err := monitoringBaseURL(managed.Config)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	target := base + "/" + endpoint
	query := r.URL.Query()
	query.Del("connId")
	if encoded := query.Encode(); encoded != "" {
		target += "?" + encoded
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("%s unreachable: %v", base, err))
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
