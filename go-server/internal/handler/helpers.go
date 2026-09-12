package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
)

func writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func generateID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func urlParam(r *http.Request, key string) string {
	return chi.URLParam(r, key)
}

// connIDFromRequest reads the connection id from the query string (all
// resource routes) or a route parameter (monitoring/cluster routes).
func connIDFromRequest(r *http.Request) string {
	if id := r.URL.Query().Get("connId"); id != "" {
		return id
	}
	return chi.URLParam(r, "connId")
}

// jetStreamFor resolves the JetStream context for the request's connection.
// A `domain` query parameter overrides the connection's configured domain
// for this call, so one hub connection can browse every leaf domain.
func jetStreamFor(store *connection.Store, r *http.Request) (jetstream.JetStream, error) {
	return jetStreamForConn(store, connIDFromRequest(r), r.URL.Query().Get("domain"))
}

// JetStreamFor is jetStreamForConn for callers outside this package (the
// support bundle), with the connection's own domain.
func JetStreamFor(store *connection.Store, connID string) (jetstream.JetStream, error) {
	return jetStreamForConn(store, connID, "")
}

func jetStreamForConn(store *connection.Store, connID, domainOverride string) (jetstream.JetStream, error) {
	m, ok := store.Get(connID)
	if !ok || m.NC == nil {
		return nil, fmt.Errorf("connection not found")
	}
	if !m.NC.IsConnected() {
		return nil, fmt.Errorf("not connected")
	}
	domain := strings.TrimSpace(domainOverride)
	switch {
	case domain != "":
		return jetstream.NewWithDomain(m.NC, domain)
	case m.Config.JSAPIPrefix != "":
		return jetstream.NewWithAPIPrefix(m.NC, m.Config.JSAPIPrefix)
	case m.Config.JSDomain != "":
		return jetstream.NewWithDomain(m.NC, m.Config.JSDomain)
	default:
		return jetstream.New(m.NC)
	}
}

func decodeBody(r *http.Request, v interface{}) error {
	dec := json.NewDecoder(r.Body)
	return dec.Decode(v)
}
