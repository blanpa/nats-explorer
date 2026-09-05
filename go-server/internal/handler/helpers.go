package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"

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
func jetStreamFor(store *connection.Store, r *http.Request) (jetstream.JetStream, error) {
	nc, err := store.GetNC(connIDFromRequest(r))
	if err != nil {
		return nil, err
	}
	return jetstream.New(nc)
}

func decodeBody(r *http.Request, v interface{}) error {
	dec := json.NewDecoder(r.Body)
	return dec.Decode(v)
}
