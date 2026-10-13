package handler

import (
	"net/http"

	"nats-explorer/internal/auth"
	"nats-explorer/internal/connection"
)

// VisibleStatuses is every connection the caller may see: all of them, or
// the ones an account narrowed to some names matches.
func VisibleStatuses(store *connection.Store, r *http.Request) []connection.Status {
	all := store.AllStatuses()
	id := auth.FromContext(r.Context())
	if !id.Restricted() {
		return all
	}
	out := make([]connection.Status, 0, len(all))
	for _, st := range all {
		if id.AllowsConn(st.ID, st.Name) {
			out = append(out, st)
		}
	}
	return out
}

// MayUse says whether the caller may use one connection.
func MayUse(store *connection.Store, r *http.Request, connID string) bool {
	id := auth.FromContext(r.Context())
	if !id.Restricted() {
		return true
	}
	return id.AllowsConn(connID, store.GetStatus(connID).Name)
}
