package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/go-chi/chi/v5"

	"nats-explorer/internal/audit"
	"nats-explorer/internal/auth"
)

const (
	auditDefaultLimit = 200
	auditMaxLimit     = 2000
	auditMemEntries   = 5000
)

// The audit log records who changed what: every write under /api with the
// user, the object and the result. It lives in the settings directory when
// there is one, otherwise in memory.
func init() {
	// One store per server, shared by the middleware and the endpoint.
	var store audit.Store
	registerFeature(feature{
		name: "audit",
		apiMiddleware: func(d *deps) func(http.Handler) http.Handler {
			if d.settings != nil {
				store = audit.NewFileStore(filepath.Join(d.settings.Dir(), "audit.log"))
			} else {
				store = audit.NewMemStore(auditMemEntries)
			}
			return audit.Middleware(store)
		},
		api: func(r chi.Router, d *deps) {
			// Reading the log is an admin matter, and GET is not gated by role.
			r.Get("/audit", func(w http.ResponseWriter, req *http.Request) {
				if id := auth.FromContext(req.Context()); id.Role != auth.RoleAdmin {
					auditError(w, http.StatusForbidden, "the audit log needs the admin role")
					return
				}
				q := req.URL.Query()
				limit := auditDefaultLimit
				if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 {
					limit = min(n, auditMaxLimit)
				}
				since, _ := strconv.ParseInt(q.Get("since"), 10, 64)
				entries, err := store.Query(req.Context(), audit.Query{Limit: limit, User: q.Get("user"), Method: q.Get("method"), Since: since})
				if err != nil {
					auditError(w, http.StatusInternalServerError, err.Error())
					return
				}
				if entries == nil {
					entries = []audit.Entry{}
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]interface{}{"entries": entries})
			})
		},
	})
}

func auditError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
