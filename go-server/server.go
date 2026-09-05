package main

import (
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/handler"
	"nats-explorer/internal/subscription"
	"nats-explorer/internal/ws"
)

// The UI is always served from the same origin as the API (embedded static
// files, the Vite dev proxy, or the desktop webview), so only same-host and
// loopback origins are accepted for the websocket upgrade.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 64 * 1024,
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

// createServer builds the chi router with the REST API, the websocket feed
// and (optionally) the static UI from staticFS.
func createServer(staticFS fs.FS, authToken string) http.Handler {
	hub := ws.NewHub()

	var subMu sync.RWMutex
	subManagers := make(map[string]*subscription.Manager)

	store := connection.NewStore()
	store.SetOnChange(func() {
		hub.Broadcast(map[string]interface{}{
			"type": "connections",
			"data": store.AllStatuses(),
		})
	})

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

	connHandler := &handler.ConnectionHandler{
		Store: store,
		OnConnected: func(connID string, cfg connection.Config) {
			nc, err := store.GetNC(connID)
			if err != nil {
				return
			}

			mgr := subscription.NewManager(connID)
			mgr.OnBatch = func(cID string, msgs []subscription.NatsMessage, stats subscription.Stats) {
				hub.Broadcast(map[string]interface{}{
					"type":   "message-batch",
					"connId": cID,
					"data":   msgs,
					"stats":  stats,
				})
			}
			mgr.OnTree = func(cID string, tree []subscription.SubjectNode) {
				hub.Broadcast(map[string]interface{}{
					"type":   "subject-tree",
					"connId": cID,
					"data":   tree,
				})
			}

			subjects := cfg.Subscriptions
			if len(subjects) == 0 {
				subjects = []string{">"}
			}
			if err := mgr.Start(nc, subjects); err != nil {
				log.Printf("subscription manager for %s: %v", connID, err)
				return
			}

			subMu.Lock()
			subManagers[connID] = mgr
			subMu.Unlock()
		},
		OnDisconnected: stopManager,
	}

	publishHandler := &handler.PublishHandler{Store: store}
	streamsHandler := &handler.StreamsHandler{Store: store}
	consumersHandler := &handler.ConsumersHandler{Store: store}
	kvHandler := &handler.KVHandler{Store: store}
	objHandler := &handler.ObjectStoreHandler{Store: store}
	monHandler := &handler.MonitoringHandler{Store: store}
	svcHandler := &handler.ServicesHandler{Store: store}
	liveHandler := handler.NewLiveHandler(store)

	hub.OnMessage = func(c *ws.Client, data []byte) {
		liveHandler.HandleCommand(c, data, func(ev interface{}) { hub.SendToClient(c, ev) })
	}
	hub.OnDisconnect = func(c *ws.Client) { liveHandler.StopAll(c) }

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5, "application/json"))

	r.Get("/api/auth", handler.AuthInfo(authToken))

	r.With(handler.RequireToken(authToken)).Get("/ws", func(w http.ResponseWriter, req *http.Request) {
		conn, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			log.Printf("websocket upgrade: %v", err)
			return
		}

		client := hub.AddClient(conn)

		hub.SendToClient(client, map[string]interface{}{
			"type": "connections",
			"data": store.AllStatuses(),
		})

		subMu.RLock()
		for connID, mgr := range subManagers {
			if tree := mgr.GetTree(); len(tree) > 0 {
				hub.SendToClient(client, map[string]interface{}{
					"type":   "subject-tree",
					"connId": connID,
					"data":   tree,
				})
			}
		}
		subMu.RUnlock()
	})

	r.Route("/api", func(r chi.Router) {
		r.Use(handler.RequireToken(authToken))
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
		r.Get("/status", connHandler.Status)
		r.Get("/cluster/{connId}", connHandler.ServerInfo)
		r.Get("/server/{connId}", connHandler.ServerInfo)

		r.Post("/publish", publishHandler.Publish)
		r.Post("/request", publishHandler.Request)

		r.Get("/streams", streamsHandler.List)
		r.Post("/streams", streamsHandler.Create)
		r.Get("/streams/{name}", streamsHandler.Get)
		r.Put("/streams/{name}", streamsHandler.Update)
		r.Delete("/streams/{name}", streamsHandler.Delete)
		r.Post("/streams/{name}/purge", streamsHandler.Purge)
		r.Get("/streams/{name}/messages", streamsHandler.GetMessages)
		r.Delete("/streams/{name}/messages/{seq}", streamsHandler.DeleteMessage)

		r.Get("/streams/{stream}/consumers", consumersHandler.List)
		r.Post("/streams/{stream}/consumers", consumersHandler.Create)
		r.Get("/streams/{stream}/consumers/{consumer}", consumersHandler.Get)
		r.Delete("/streams/{stream}/consumers/{consumer}", consumersHandler.Delete)

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

	if staticFS != nil {
		fileServer := http.FileServer(http.FS(staticFS))
		r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
			path := strings.TrimPrefix(req.URL.Path, "/")
			if path != "" {
				if f, err := staticFS.Open(path); err == nil {
					if st, err := f.Stat(); err == nil && !st.IsDir() {
						f.Close()
						fileServer.ServeHTTP(w, req)
						return
					}
					f.Close()
				}
			}
			// SPA fallback
			req.URL.Path = "/"
			fileServer.ServeHTTP(w, req)
		})
	}

	return r
}
