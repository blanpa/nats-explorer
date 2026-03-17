package handler

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
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

func (h *MonitoringHandler) Proxy(w http.ResponseWriter, r *http.Request) {
	connID := chi_URLParam(r, "connId")
	endpoint := chi_URLParam(r, "endpoint")

	if !allowedEndpoints[endpoint] {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid endpoint: %s", endpoint))
		return
	}

	managed, ok := h.Store.Get(connID)
	if !ok {
		writeError(w, http.StatusNotFound, "Connection not found")
		return
	}

	// Determine monitoring URL
	monURL := managed.Config.MonitoringURL
	if monURL == "" {
		// Derive from server URL
		serverURL := ""
		if len(managed.Config.Servers) > 0 {
			serverURL = managed.Config.Servers[0]
		}
		re := regexp.MustCompile(`nats://([^:]+):?(\d+)?`)
		matches := re.FindStringSubmatch(serverURL)
		if len(matches) >= 2 {
			host := matches[1]
			natsPort := 4222
			if len(matches) >= 3 && matches[2] != "" {
				natsPort, _ = strconv.Atoi(matches[2])
			}
			monPort := managed.Config.MonitoringPort
			if monPort == 0 {
				monPort = natsPort + 4000
			}
			monURL = fmt.Sprintf("http://%s:%d", host, monPort)
		}
	}

	if monURL == "" {
		writeError(w, http.StatusBadRequest, "Cannot determine monitoring URL")
		return
	}

	// Forward query params
	targetURL := fmt.Sprintf("%s/%s", monURL, endpoint)
	queryParams := r.URL.Query()
	queryParams.Del("connId")
	if encoded := queryParams.Encode(); encoded != "" {
		targetURL += "?" + encoded
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(targetURL)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
