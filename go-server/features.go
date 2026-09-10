package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"nats-explorer/internal/auth"
	"nats-explorer/internal/connection"
	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
	"nats-explorer/internal/settings"
	"nats-explorer/internal/subscription"
	"nats-explorer/internal/ws"
)

// deps is what a feature gets from the server: the shared services and a
// way to hook into every subscription manager.
type deps struct {
	cfg     serverConfig
	store   *connection.Store
	history history.Store
	// tee is the same history; tee.DB() is the SQLite copy when the
	// persistent history is switched on, nil otherwise.
	tee      *history.Tee
	hub      *ws.Hub
	auth     *auth.Service
	settings *settings.Store // nil in browser-storage mode

	// managers returns a snapshot of the running subscription managers by connection id.
	managers func() map[string]*subscription.Manager
	// manager returns one running manager or nil.
	manager func(connID string) *subscription.Manager
	// addManager registers a manager the feature built itself (e.g. for an
	// imported bundle): it gets the tabs' focus and view like the others.
	// The feature wires OnBatch/OnTree/OnStats via wireManager first.
	addManager func(connID string, m *subscription.Manager)
	// removeManager stops and forgets a manager.
	removeManager func(connID string)
	// wireManager attaches the websocket callbacks and the feature hooks.
	wireManager func(connID string, m *subscription.Manager)

	// shutdownHooks run when the server closes, in reverse order of
	// registration, so a feature can stop what it started.
	shutdownHooks []func()
	// recordHooks see every received message of every connection, on the
	// shard workers: keep them cheap and lock-free on the hot path.
	recordHooks []func(connID string, r *message.Record)
}

// onShutdown registers a hook that runs when the server is closed.
func (d *deps) onShutdown(fn func()) {
	d.shutdownHooks = append(d.shutdownHooks, fn)
}

// onRecord registers a hook for every received message.
func (d *deps) onRecord(fn func(connID string, r *message.Record)) {
	d.recordHooks = append(d.recordHooks, fn)
}

// feature is one optional part of the server. root gets the unauthenticated
// router (for callbacks and the like), api the authenticated /api group
// where writes already need the admin role. Either may be nil.
type feature struct {
	name string
	root func(r chi.Router, d *deps)
	api  func(r chi.Router, d *deps)
	// apiMiddleware wraps every /api request, after the caller is identified
	// and before the role is checked, so a refused write is still seen.
	apiMiddleware func(d *deps) func(http.Handler) http.Handler
}

// features are registered from init() of their files, so adding one is a
// new file and nothing else.
var features []feature

func registerFeature(f feature) {
	features = append(features, f)
}

// featureJSON and featureError are how a feature answers. Shared because
// every feature needs the same two lines.
func featureJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func featureError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": strings.TrimSpace(msg)})
}

// decodeJSON reads a JSON body and answers the client on a bad one.
func decodeJSON(w http.ResponseWriter, r *http.Request, out any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err == nil {
		err = json.Unmarshal(body, out)
	}
	if err != nil {
		featureError(w, http.StatusBadRequest, err.Error())
	}
	return err
}
