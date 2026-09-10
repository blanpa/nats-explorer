package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"

	"nats-explorer/internal/auth"
	"nats-explorer/internal/connection"
	"nats-explorer/internal/filter"
	"nats-explorer/internal/handler"
	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
	"nats-explorer/internal/settings"
	"nats-explorer/internal/subscription"
	"nats-explorer/internal/ws"
)

// The UI is always served from the same origin as the API (embedded static
// files, the Vite dev proxy, or the desktop webview), so only same-host and
// loopback origins are accepted for the websocket upgrade.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 64 * 1024,
	// permessage-deflate: the tree feed and message batches are repetitive
	// JSON and shrink several-fold.
	EnableCompression: true,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		if strings.EqualFold(u.Host, r.Host) {
			return true
		}
		host := u.Hostname()
		return host == "localhost" || host == "127.0.0.1" || host == "::1"
	},
}

// serverConfig carries what differs between the headless server, the desktop
// app and tests.
type serverConfig struct {
	authToken string
	// accounts for the users mode; empty keeps token or no auth
	users []auth.User
	// "server" or "desktop"; shown to the UI
	mode string
	// file-backed UI settings; nil keeps everything in the browser
	settings *settings.Store
	// memory budget for the message history; 0 picks the default (256 MB)
	historyBytes int
	// expose /debug/pprof
	pprof bool
	// SQLite file for the persistent history; empty means this installation
	// has nowhere to put one and the history stays in memory.
	historyDB        string
	historyRetention time.Duration
	// historyManaged: HISTORY_DB decided the path, so the environment owns
	// the setting and the UI only reports it.
	historyManaged bool
	// historyOn is the default before a stored choice is applied: the
	// desktop app persists by default, a server does not. Implied by
	// historyManaged.
	historyOn bool
	// historyNoFullText drops the word index of the persistent history: the
	// writer is then several times faster and a search falls back to a scan.
	// Negated so the zero value is the behaviour everyone expects.
	historyNoFullText bool
	// open the saved connections flagged for it when the server starts
	autoConnect bool
	// basePath mounts everything under a prefix ("/nats"), for a reverse
	// proxy that does not strip it. Empty serves from the root.
	basePath string
}

// createServer builds the chi router with the REST API, the websocket feed
// and (optionally) the static UI from staticFS.
// appServer is the router together with everything that has to be shut down
// with it: the subscription managers and their NATS connections, the
// persistent history and whatever the features started. Without a Close the
// goroutines outlive the server that owns them, which shows up as leaks in
// tests and as an unflushed history on exit.
type appServer struct {
	http.Handler
	once  sync.Once
	close func()
}

// Close stops everything the server started. Safe to call more than once.
func (s *appServer) Close() {
	s.once.Do(s.close)
}

func createServer(staticFS fs.FS, cfg serverConfig) *appServer {
	authSvc := auth.New(cfg.authToken, cfg.users)
	if cfg.mode == "" {
		cfg.mode = "server"
	}
	hub := ws.NewHub()
	// The history is always a tee: memory is the live source, the database
	// behind it can be switched on and off while the server runs.
	tee := history.NewTee(history.NewMemStore(cfg.historyBytes, 0))
	var hist history.Store = tee
	histPersist := openHistoryDB(tee, cfg)

	var subMu sync.RWMutex
	subManagers := make(map[string]*subscription.Manager)
	// What each browser tab looks at: the focused subject (its messages are
	// streamed) and the tree view (which nodes are sent). Applied to every
	// manager, including ones started later.
	clientFocus := make(map[*ws.Client][]string)
	clientView := make(map[*ws.Client]subscription.View)

	store := connection.NewStore()
	store.SetOnChange(func() {
		hub.Broadcast(connectionsOf(store.AllStatuses()))
	})

	d := &deps{cfg: cfg, store: store, history: hist, tee: tee, hub: hub, auth: authSvc, settings: cfg.settings}
	d.managers = func() map[string]*subscription.Manager {
		subMu.RLock()
		defer subMu.RUnlock()
		out := make(map[string]*subscription.Manager, len(subManagers))
		for id, mgr := range subManagers {
			out[id] = mgr
		}
		return out
	}
	d.manager = func(connID string) *subscription.Manager {
		subMu.RLock()
		defer subMu.RUnlock()
		return subManagers[connID]
	}

	stopManager := func(connID string) {
		subMu.Lock()
		mgr, ok := subManagers[connID]
		if ok {
			delete(subManagers, connID)
		}
		subMu.Unlock()
		if ok {
			mgr.Stop()
		}
	}

	// wireManager attaches the browser callbacks and the feature hooks.
	wireManager := func(connID string, mgr *subscription.Manager) {
		mgr.History = hist
		// The feed is per browser tab: only the subject or branch it
		// looks at, everything else waits in the history.
		mgr.OnBatch = func(c any, cID string, msgs []message.NatsMessage) {
			hub.SendToClient(c.(*ws.Client), messageBatchEvent{Type: "message-batch", ConnID: cID, Data: msgs})
		}
		mgr.OnStats = func(cID string, stats subscription.Stats) {
			hub.Broadcast(statsEvent{Type: "stats", ConnID: cID, Data: stats})
		}
		mgr.OnTree = func(c any, cID string, up *subscription.TreeUpdate) {
			hub.SendToClient(c.(*ws.Client), subjectTreeEvent{Type: "subject-tree", ConnID: cID, Full: up.Full, Data: up.Entries, Removed: up.Removed})
		}
		if len(d.recordHooks) > 0 {
			hooks := d.recordHooks
			mgr.OnRecord = func(cID string, r *message.Record) {
				for _, h := range hooks {
					h(cID, r)
				}
			}
		}
	}

	// addManager makes a started manager visible to the tabs.
	addManager := func(connID string, mgr *subscription.Manager) {
		subMu.Lock()
		subManagers[connID] = mgr
		for c, subject := range clientFocus {
			mgr.SetFocus(c, subject)
		}
		for c, view := range clientView {
			mgr.SetView(c, view)
		}
		subMu.Unlock()
	}
	d.wireManager = wireManager
	d.addManager = addManager
	d.removeManager = stopManager

	// startManager subscribes to the connection's patterns and feeds the
	// browsers; used on connect and whenever the patterns change.
	startManager := func(connID string, cfg connection.Config) {
		nc, err := store.GetNC(connID)
		if err != nil {
			return
		}
		mgr := subscription.NewManager(connID)
		wireManager(connID, mgr)
		subjects := cfg.Subscriptions
		if len(subjects) == 0 {
			subjects = []string{">"}
		}
		if err := mgr.Start(nc, subjects); err != nil {
			log.Printf("subscription manager for %s: %v", connID, err)
			return
		}
		addManager(connID, mgr)
	}

	connHandler := &handler.ConnectionHandler{
		Store:          store,
		OnConnected:    startManager,
		OnDisconnected: stopManager,
		OnSubscriptionsChanged: func(connID string, cfg connection.Config) {
			// Swap the patterns in place: what stays keeps its history, its
			// counters and its place in the tree.
			subMu.RLock()
			mgr := subManagers[connID]
			subMu.RUnlock()
			nc, err := store.GetNC(connID)
			if mgr == nil || err != nil {
				stopManager(connID)
				startManager(connID, cfg)
				return
			}
			if err := mgr.SetSubjects(nc, cfg.Subscriptions); err != nil {
				log.Printf("changing subscriptions of %s: %v", connID, err)
				stopManager(connID)
				startManager(connID, cfg)
			}
		},
	}

	publishHandler := &handler.PublishHandler{Store: store}
	streamsHandler := &handler.StreamsHandler{Store: store}
	consumersHandler := &handler.ConsumersHandler{Store: store}
	kvHandler := &handler.KVHandler{Store: store}
	objHandler := &handler.ObjectStoreHandler{Store: store}
	monHandler := &handler.MonitoringHandler{Store: store}
	clusterHandler := &handler.ClusterHandler{Store: store}
	svcHandler := &handler.ServicesHandler{Store: store}
	liveHandler := handler.NewLiveHandler(store)
	histHandler := &handler.HistoryHandler{
		Store:   store,
		History: hist,
		Tee:     tee,
		Persist: histPersist,
		// A cleared subject leaves the tree and the counters as well, so it
		// starts over instead of showing numbers with no messages behind them.
		OnCleared: func(connID string, subjects []string) {
			subMu.RLock()
			mgr := subManagers[connID]
			subMu.RUnlock()
			if mgr != nil {
				mgr.Forget(subjects)
			}
		},
		// A cleared history leaves no tree behind: without a connection id
		// every manager starts over, with one only that connection.
		OnClearedAll: func(connID string) {
			subMu.RLock()
			managers := make([]*subscription.Manager, 0, len(subManagers))
			for id, mgr := range subManagers {
				if connID == "" || id == connID {
					managers = append(managers, mgr)
				}
			}
			subMu.RUnlock()
			for _, mgr := range managers {
				mgr.ForgetAll()
			}
		},
	}

	hub.OnMessage = func(c *ws.Client, data []byte) {
		var cmd struct {
			Type string `json:"type"`
			// focus: the subjects to stream; "subject" is the older single form.
			Subject  string   `json:"subject"`
			Subjects []string `json:"subjects"`
			subscription.View
		}
		if err := json.Unmarshal(data, &cmd); err == nil {
			switch cmd.Type {
			case "focus":
				subjects := cmd.Subjects
				if len(subjects) == 0 && cmd.Subject != "" {
					subjects = []string{cmd.Subject}
				}
				subMu.Lock()
				clientFocus[c] = subjects
				for _, mgr := range subManagers {
					mgr.SetFocus(c, subjects)
				}
				subMu.Unlock()
				return
			case "view":
				// A broken expression must say so; an empty tree looks like
				// "nothing matches".
				if expr := strings.TrimSpace(cmd.View.Expr); expr != "" {
					if _, err := filter.Compile(expr); err != nil {
						hub.SendToClient(c, filterErrorEvent{Type: "filter-error", Error: err.Error()})
						return
					}
				}
				hub.SendToClient(c, filterErrorEvent{Type: "filter-error", Error: ""})
				subMu.Lock()
				clientView[c] = cmd.View
				managers := make([]*subscription.Manager, 0, len(subManagers))
				for _, mgr := range subManagers {
					managers = append(managers, mgr)
				}
				subMu.Unlock()
				// Outside the lock: SetView emits the delta right away.
				for _, mgr := range managers {
					mgr.SetView(c, cmd.View)
				}
				return
			}
		}
		liveHandler.HandleCommand(c, data, func(ev interface{}) { hub.SendToClient(c, ev) })
	}
	hub.OnDisconnect = func(c *ws.Client) {
		liveHandler.StopAll(c)
		subMu.Lock()
		delete(clientFocus, c)
		delete(clientView, c)
		for _, mgr := range subManagers {
			mgr.RemoveClient(c)
		}
		subMu.Unlock()
	}

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5, "application/json"))

	// PPROF=1 exposes Go's profiler under /debug/pprof for load investigations.
	if cfg.pprof {
		r.Mount("/debug", middleware.Profiler())
	}

	r.Get("/api/auth", authSvc.Info)
	r.Post("/api/login", authSvc.LoginHandler)
	r.Post("/api/logout", authSvc.LogoutHandler)
	// Prometheus exposition of the explorer's own counters (protected like the API).
	r.With(authSvc.Require).Get("/metrics", func(w http.ResponseWriter, req *http.Request) {
		subMu.RLock()
		managers := make(map[string]*subscription.Manager, len(subManagers))
		for id, mgr := range subManagers {
			managers[id] = mgr
		}
		subMu.RUnlock()
		writeMetrics(w, store.AllStatuses(), managers, hub.ClientCount(), tee.DB())
	})
	// What kind of installation this is, so the UI knows where state lives.
	r.Get("/api/app", func(w http.ResponseWriter, req *http.Request) {
		// `source` is the AGPL offer of source for what is running here; a
		// modified build points SOURCE_URL at its own repository.
		// Read per request: the persistent history is a setting, so a tab
		// that reloads after it was switched sees the new state.
		db := tee.DB()
		info := map[string]interface{}{"mode": cfg.mode, "storage": "browser", "version": version, "commit": commit, "source": sourceURL(), "historyDb": db != nil}
		if db != nil {
			info["historyRetention"] = db.Retention().String()
		}
		if cfg.settings != nil {
			info["storage"] = "file"
			info["configDir"] = cfg.settings.Dir()
			info["secrets"] = cfg.settings.SecretsName()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(info)
	})

	r.With(authSvc.Require).Get("/ws", func(w http.ResponseWriter, req *http.Request) {
		conn, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			log.Printf("websocket upgrade: %v", err)
			return
		}

		// ?enc=msgpack switches the tab to MessagePack frames.
		client := hub.AddClient(conn, req.URL.Query().Get("enc") == "msgpack")

		// The tree follows once the tab sends its view.
		hub.SendToClient(client, connectionsOf(store.AllStatuses()))
	})

	for _, f := range features {
		if f.root != nil {
			f.root(r, d)
		}
	}

	r.Route("/api", func(r chi.Router) {
		// Identify first, then the features, then the role check: a refused
		// write must still reach the audit log. chi wants every middleware
		// before the first route.
		r.Use(authSvc.Require)
		for _, f := range features {
			if f.apiMiddleware != nil {
				r.Use(f.apiMiddleware(d))
			}
		}
		r.Use(authSvc.AdminForWrites)
		for _, f := range features {
			if f.api != nil {
				f.api(r, d)
			}
		}
		r.Post("/connect", connHandler.Connect)
		r.Post("/disconnect", connHandler.Disconnect)
		r.Post("/disconnect-all", func(w http.ResponseWriter, req *http.Request) {
			subMu.Lock()
			managers := subManagers
			subManagers = make(map[string]*subscription.Manager)
			subMu.Unlock()
			for _, mgr := range managers {
				mgr.Stop()
			}
			connHandler.DisconnectAll(w, req)
		})
		r.Get("/connections", connHandler.ListConnections)
		r.Put("/connections/{connId}/subscriptions", connHandler.SetSubscriptions)
		r.Get("/status", connHandler.Status)
		r.Get("/cluster/{connId}", connHandler.ServerInfo)
		r.Get("/cluster/{connId}/overview", clusterHandler.Overview)
		r.Get("/server/{connId}", connHandler.ServerInfo)

		r.Get("/history", histHandler.Get)
		r.Get("/history/series", histHandler.Series)
		r.Get("/history/fields", histHandler.Fields)
		r.Get("/history/search", histHandler.Search)
		r.Get("/history/range", histHandler.Range)
		r.Delete("/history", histHandler.Clear)
		r.Get("/history/persistence", histHandler.Persistence)
		r.Put("/history/persistence", histHandler.SetPersistence)

		r.Post("/publish", publishHandler.Publish)
		r.Post("/request", publishHandler.Request)
		r.Post("/run", publishHandler.Run)

		if cfg.settings != nil {
			sh := &handler.SettingsHandler{Store: cfg.settings}
			r.Get("/settings", sh.All)
			r.Put("/settings/{key}", sh.Put)
			r.Delete("/settings/{key}", sh.Delete)
		}

		r.Get("/streams", streamsHandler.List)
		r.Post("/streams", streamsHandler.Create)
		r.Get("/streams/{name}", streamsHandler.Get)
		r.Put("/streams/{name}", streamsHandler.Update)
		r.Delete("/streams/{name}", streamsHandler.Delete)
		r.Post("/streams/{name}/purge", streamsHandler.Purge)
		r.Get("/streams/{name}/messages", streamsHandler.GetMessages)
		r.Get("/streams/{name}/series", streamsHandler.Series)
		r.Get("/streams/{name}/seq", streamsHandler.SeqAtTime)
		r.Delete("/streams/{name}/messages/{seq}", streamsHandler.DeleteMessage)

		r.Get("/streams/{stream}/consumers", consumersHandler.List)
		r.Post("/streams/{stream}/consumers", consumersHandler.Create)
		r.Get("/streams/{stream}/consumers/{consumer}", consumersHandler.Get)
		r.Put("/streams/{stream}/consumers/{consumer}", consumersHandler.Update)
		r.Delete("/streams/{stream}/consumers/{consumer}", consumersHandler.Delete)
		r.Post("/streams/{stream}/consumers/{consumer}/pause", consumersHandler.Pause)
		r.Post("/streams/{stream}/consumers/{consumer}/resume", consumersHandler.Resume)

		r.Get("/kv", kvHandler.ListBuckets)
		r.Post("/kv", kvHandler.CreateBucket)
		r.Get("/kv/{bucket}", kvHandler.ListKeys)
		r.Delete("/kv/{bucket}", kvHandler.DeleteBucket)
		r.Get("/kv/{bucket}/status", kvHandler.BucketStatus)
		r.Get("/kv/{bucket}/{key}", kvHandler.GetEntry)
		r.Put("/kv/{bucket}/{key}", kvHandler.PutEntry)
		r.Post("/kv/{bucket}/{key}", kvHandler.PutEntry)
		r.Delete("/kv/{bucket}/{key}", kvHandler.DeleteEntry)
		r.Post("/kv/{bucket}/{key}/purge", kvHandler.PurgeKey)

		r.Get("/objectstore", objHandler.ListStores)
		r.Post("/objectstore", objHandler.CreateStore)
		r.Get("/objectstore/{store}", objHandler.ListObjects)
		r.Delete("/objectstore/{store}", objHandler.DeleteStore)
		r.Get("/objectstore/{store}/{name}", objHandler.GetObject)
		r.Put("/objectstore/{store}/{name}", objHandler.PutObject)
		r.Post("/objectstore/{store}/{name}", objHandler.PutObject)
		r.Delete("/objectstore/{store}/{name}", objHandler.DeleteObject)

		r.Get("/monitoring/{connId}/{endpoint}", monHandler.Proxy)

		r.Get("/services", svcHandler.Discover)
		r.Get("/services/stats", svcHandler.Stats)
		r.Get("/services/ping", svcHandler.Ping)

		r.NotFound(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"not found"}`))
		})
	})

	// Saved connections open after the features attached their hooks.
	if cfg.settings != nil && cfg.autoConnect {
		go autoConnectSaved(cfg.settings, func(c connection.Config) error {
			if _, err := store.Connect(c); err != nil {
				return err
			}
			startManager(c.ID, c)
			return nil
		})
	}

	if staticFS != nil {
		fileServer := http.FileServer(http.FS(staticFS))
		// The index carries the base href the UI resolves every backend URL
		// against, so one build serves "/" and any subpath. Read per request,
		// not once: with PUBLIC_PATH pointing at a directory that is rebuilt
		// while the server runs, a cached copy would keep naming chunks that
		// no longer exist.
		serveIndex := func(w http.ResponseWriter, req *http.Request) {
			index := indexWithBase(staticFS, cfg.basePath)
			if index == nil {
				req.URL.Path = "/"
				fileServer.ServeHTTP(w, req)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Write(index)
		}
		r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
			path := strings.TrimPrefix(req.URL.Path, "/")
			if path != "" && path != "index.html" {
				if f, err := staticFS.Open(path); err == nil {
					if st, err := f.Stat(); err == nil && !st.IsDir() {
						f.Close()
						fileServer.ServeHTTP(w, req)
						return
					}
					f.Close()
				}
			}
			serveIndex(w, req)
		})
	}

	handler := mountUnder(r, cfg.basePath)
	return &appServer{Handler: handler, close: func() {
		subMu.Lock()
		managers := subManagers
		subManagers = make(map[string]*subscription.Manager)
		subMu.Unlock()
		for _, mgr := range managers {
			mgr.Stop()
		}
		store.DisconnectAll()
		// Features stop in reverse order, so one that builds on another is
		// gone before what it uses.
		for i := len(d.shutdownHooks) - 1; i >= 0; i-- {
			d.shutdownHooks[i]()
		}
		histPersist.Close()
	}}
}

// Serving under a reverse-proxy subpath. A proxy that forwards
// https://host/nats/ without stripping the prefix means every path the
// server answers, and every URL the UI builds, carries it. The server is the
// only place that knows the prefix: it mounts itself under it and writes a
// <base href> into index.html, and the UI resolves everything against that.

// normalizeBasePath turns "nats/" into "/nats"; empty stays empty.
func normalizeBasePath(p string) string {
	p = strings.Trim(strings.TrimSpace(p), "/")
	if p == "" {
		return ""
	}
	return "/" + p
}

// mountUnder puts the whole router behind a prefix and sends the bare prefix
// to its trailing-slash form, so relative asset paths resolve.
func mountUnder(r chi.Router, basePath string) http.Handler {
	if basePath == "" {
		return r
	}
	outer := chi.NewRouter()
	// As middleware, not a route: chi's Mount claims the bare prefix itself.
	outer.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == basePath {
				http.Redirect(w, req, basePath+"/", http.StatusMovedPermanently)
				return
			}
			next.ServeHTTP(w, req)
		})
	})
	// StripPrefix as well as Mount: chi routes on its own path context, but
	// the static handler reads req.URL.Path and would look for "nats/assets".
	outer.Mount(basePath, http.StripPrefix(basePath, r))
	return outer
}

// indexWithBase reads index.html and sets its <base href> to the prefix.
// Returns nil when there is no index to serve, and the file unchanged when
// it has no <base> tag to replace.
func indexWithBase(staticFS fs.FS, basePath string) []byte {
	data, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		return nil
	}
	href := basePath + "/"
	if i := bytes.Index(data, []byte("<base ")); i >= 0 {
		if j := bytes.IndexByte(data[i:], '>'); j >= 0 {
			return append(append(append([]byte{}, data[:i]...), []byte(`<base href="`+href+`"`)...), data[i+j:]...)
		}
	}
	if i := bytes.Index(data, []byte("<head>")); i >= 0 {
		at := i + len("<head>")
		return append(append(append([]byte{}, data[:at]...), []byte("\n    <base href=\""+href+"\" />")...), data[at:]...)
	}
	return data
}
