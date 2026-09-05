package handler

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// TokenFromRequest extracts a bearer token from the Authorization header,
// the X-Auth-Token header, or the `token` query parameter (used by the
// websocket and by download links, which cannot set headers).
func TokenFromRequest(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	if t := r.Header.Get("X-Auth-Token"); t != "" {
		return t
	}
	return r.URL.Query().Get("token")
}

// RequireToken rejects requests that do not carry the configured token.
// With an empty token the middleware is a no-op.
func RequireToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if token == "" {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := TokenFromRequest(r)
			if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				writeError(w, http.StatusUnauthorized, "authentication required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// AuthInfo tells the UI whether a token is needed. It is served without auth.
func AuthInfo(token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]bool{"required": token != ""})
	}
}
