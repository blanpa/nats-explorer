package handler

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
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
	rand.Read(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func chi_URLParam(r *http.Request, key string) string {
	return chi.URLParam(r, key)
}

func getConnID(r *http.Request) string {
	connID := r.URL.Query().Get("connId")
	if connID != "" {
		return connID
	}
	// Try body for POST requests - but we can't re-read body
	// So query param is the primary method
	return ""
}
