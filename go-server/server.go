package main

import (
	"io/fs"
	"log"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/gorilla/websocket"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/handler"
	"nats-explorer/internal/subscription"
	"nats-explorer/internal/ws"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// createServer builds the full chi router with all API routes, WebSocket, and
// optionally serves static files from the given fs.FS (nil = no static serving).
func createServer(staticFS fs.FS) http.Handler {
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

	connHandler := &handler.ConnectionHandler{
		Store: store,
		OnConnected: func(connID string, cfg connection.Config) {
			nc, err := store.GetNC(connID)
			if err != nil {
				return
			}

			mgr := subscription.NewManager(connID)
			mgr.OnBatch = func(cID string, msgs []subscription.NatsMessage) {
				hub.Broadcast(map[string]interface{}{
					"type":   "message-batch",
					"connId": cID,
					"data":   msgs,
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
				log.Printf("Failed to start subscription manager for %s: %v", connID, err)
				return
			}

			subMu.Lock()
			subManagers[connID] = mgr
			subMu.Unlock()
		},
		OnDisconnected: func(connID string) {
			subMu.Lock()
			if mgr, ok := subManagers[connID]; ok {
				mgr.Stop()
				delete(subManagers, connID)
			}
			subMu.Unlock()
		},
	}

	publishHandler := &handler.PublishHandler{Store: store}
	streamsHandler := &handler.StreamsHandler{Store: store}
	consumersHandler := &handler.ConsumersHandler{Store: store}
	kvHandler := &handler.KVHandler{Store: store}
	objHandler := &handler.ObjectStoreHandler{Store: store}
	monHandler := &handler.MonitoringHandler{Store: store}
	svcHandler := &handler.ServicesHandler{Store: store}

	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// WebSocket
	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("WebSocket upgrade error: %v", err)
			return
		}

		client := hub.AddClient(conn)

		hub.SendToClient(client, map[string]interface{}{
			"type": "connections",
			"data": store.AllStatuses(),
		})

		subMu.RLock()
		for connID, mgr := range subManagers {
			tree := mgr.GetTree()
			if len(tree) > 0 {
				hub.SendToClient(client, map[string]interface{}{
					"type":   "subject-tree",
					"connId": connID,
					"data":   tree,
				})
			}
		}
		subMu.RUnlock()
	})

	// API routes
	r.Route("/api", func(r chi.Router) {
		r.Post("/connect", connHandler.Connect)
		r.Post("/disconnect", connHandler.Disconnect)
		r.Post("/disconnect-all", func(w http.ResponseWriter, req *http.Request) {
			subMu.Lock()
			for _, mgr := range subManagers {
				mgr.Stop()
			}
			subManagers = make(map[string]*subscription.Manager)
			subMu.Unlock()
			connHandler.DisconnectAll(w, req)
		})
		r.Get("/connections", connHandler.ListConnections)
		r.Get("/status", connHandler.Status)
		r.Get("/cluster/{connId}", connHandler.ClusterInfo)

		r.Post("/publish", publishHandler.Publish)
		r.Post("/request", publishHandler.Request)

		r.Get("/streams", streamsHandler.List)
		r.Post("/streams", streamsHandler.Create)
		r.Get("/streams/{name}", streamsHandler.Get)
		r.Put("/streams/{name}", streamsHandler.Update)
		r.Delete("/streams/{name}", streamsHandler.Delete)
		r.Post("/streams/{name}/purge", streamsHandler.Purge)
		r.Get("/streams/{name}/messages", streamsHandler.GetMessages)
		r.Delete("/streams/{name}/{seq}", streamsHandler.DeleteMessage)

		r.Get("/streams/{stream}/consumers", consumersHandler.List)
		r.Post("/streams/{stream}/consumers", consumersHandler.Create)
		r.Get("/streams/{stream}/consumers/{consumer}", consumersHandler.Get)
		r.Delete("/streams/{stream}/consumers/{consumer}", consumersHandler.Delete)

		r.Get("/kv", kvHandler.ListBuckets)
		r.Post("/kv", kvHandler.CreateBucket)
		r.Get("/kv/{bucket}", kvHandler.ListKeys)
		r.Get("/kv/{bucket}/status", kvHandler.BucketStatus)
		r.Get("/kv/{bucket}/{key}", kvHandler.GetEntry)
		r.Post("/kv/{bucket}/{key}", kvHandler.PutEntry)
		r.Delete("/kv/{bucket}/{key}", kvHandler.DeleteEntry)
		r.Delete("/kv/{bucket}/{key}/purge", kvHandler.PurgeKey)
		r.Delete("/kv/{bucket}", kvHandler.DeleteBucket)

		r.Get("/objectstore", objHandler.ListStores)
		r.Post("/objectstore", objHandler.CreateStore)
		r.Get("/objectstore/{store}", objHandler.ListObjects)
		r.Get("/objectstore/{store}/{name}", objHandler.GetObject)
		r.Post("/objectstore/{store}/{name}", objHandler.PutObject)
		r.Delete("/objectstore/{store}/{name}", objHandler.DeleteObject)

		r.Get("/monitoring/{connId}/{endpoint}", monHandler.Proxy)

		r.Get("/services", svcHandler.Discover)
		r.Get("/services/stats", svcHandler.Stats)
		r.Get("/services/ping", svcHandler.Ping)
	})

	// Serve embedded or filesystem-based static files
	if staticFS != nil {
		fileServer := http.FileServer(http.FS(staticFS))
		r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
			// Try to serve the file
			f, err := staticFS.Open(req.URL.Path[1:]) // strip leading /
			if err == nil {
				f.Close()
				fileServer.ServeHTTP(w, req)
				return
			}
			// SPA fallback: serve index.html
			req.URL.Path = "/"
			fileServer.ServeHTTP(w, req)
		})
	}

	return r
}
