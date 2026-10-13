package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"

	"nats-explorer/internal/auth"
	"nats-explorer/internal/connection"
)

// connInPath finds the connection a path names: /api/cluster/{id},
// /api/server/{id}, /api/monitoring/{id}/…, /api/connections/{id}/….
var connInPath = regexp.MustCompile(`^/api/(?:cluster|server|monitoring|connections)/([^/]+)`)

// restrictConnections refuses a request of an account narrowed to some
// connections when it names another one -- in the query, in the path, or
// as the id a connect or disconnect carries in its body -- and the calls
// that act on every connection at once. The lists the API answers with
// are narrowed in their handlers; this is the gate.
func restrictConnections(store *connection.Store, basePath string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := auth.FromContext(r.Context())
			if !id.Restricted() {
				next.ServeHTTP(w, r)
				return
			}
			refuse := func(msg string) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"error": msg})
			}
			path := r.URL.Path
			if len(basePath) > 0 && len(path) >= len(basePath) && path[:len(basePath)] == basePath {
				path = path[len(basePath):]
			}
			var named []string
			if c := r.URL.Query().Get("connId"); c != "" {
				named = append(named, c)
			}
			if m := connInPath.FindStringSubmatch(path); m != nil {
				named = append(named, m[1])
			}
			switch {
			case path == "/api/disconnect-all":
				refuse("this account may only disconnect its own connections, one at a time")
				return
			case path == "/api/history" && r.Method == http.MethodDelete && r.URL.Query().Get("connId") == "":
				refuse("this account may only clear the history of its own connections: name one")
				return
			case (path == "/api/connect" || path == "/api/disconnect") && r.Body != nil:
				body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
				r.Body = io.NopCloser(bytes.NewReader(body))
				var b struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				}
				if json.Unmarshal(body, &b) == nil {
					// A new connection is judged by the name it will have.
					if path == "/api/connect" && !id.AllowsConn(b.ID, b.Name) {
						refuse("this account may not open a connection named " + b.Name)
						return
					}
					if b.ID != "" {
						named = append(named, b.ID)
					}
				}
			}
			for _, c := range named {
				if path == "/api/connect" {
					continue
				}
				if !id.AllowsConn(c, store.GetStatus(c).Name) {
					refuse("this account may not use the connection " + c)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
