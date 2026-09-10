package main

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/handler"
	"nats-explorer/internal/history"
	"nats-explorer/internal/message"
	"nats-explorer/internal/subscription"
)

// A support bundle is one zip with a time range of recorded messages and a
// snapshot of the server: what someone needs to look into an incident
// without access to the system. Importing one opens it as a read-only
// connection, so every module works on it exactly as on a live server.

const (
	bundleFormat       = 1
	bundleDefaultLimit = 100000
	bundleMaxMessages  = 1000000
	bundleMaxUpload    = 200 << 20 // 200 MB compressed
	bundleIDPrefix     = "bundle-"
)

// bundleManifest describes what a file contains.
type bundleManifest struct {
	Format          int    `json:"format"`
	CreatedAt       int64  `json:"createdAt"`
	ExplorerVersion string `json:"explorerVersion"`
	Connection      struct {
		ID            string   `json:"id"`
		Name          string   `json:"name"`
		Servers       []string `json:"servers,omitempty"`
		Subscriptions []string `json:"subscriptions,omitempty"`
		JSDomain      string   `json:"jsDomain,omitempty"`
	} `json:"connection"`
	From     int64    `json:"from,omitempty"`
	To       int64    `json:"to,omitempty"`
	Subject  string   `json:"subject,omitempty"`
	Messages int      `json:"messages"`
	Subjects int      `json:"subjects"`
	Errors   []string `json:"errors,omitempty"`
}

// imported is an opened bundle: its manifest and the snapshots that have no
// live source to read from.
type imported struct {
	Manifest bundleManifest           `json:"manifest"`
	Server   map[string]interface{}   `json:"server,omitempty"`
	Streams  []map[string]interface{} `json:"streams,omitempty"`
	KV       []map[string]interface{} `json:"kv,omitempty"`
}

var (
	bundlesMu sync.RWMutex
	bundles   = map[string]*imported{}
)

func init() {
	registerFeature(feature{
		name: "bundle",
		api: func(r chi.Router, d *deps) {
			r.Get("/bundle", func(w http.ResponseWriter, req *http.Request) { exportBundle(w, req, d) })
			r.Post("/bundle/import", func(w http.ResponseWriter, req *http.Request) { importBundle(w, req, d) })
			r.Get("/bundle/{id}", func(w http.ResponseWriter, req *http.Request) {
				bundlesMu.RLock()
				b := bundles[chi.URLParam(req, "id")]
				bundlesMu.RUnlock()
				if b == nil {
					bundleError(w, http.StatusNotFound, "no such bundle")
					return
				}
				bundleJSON(w, b)
			})
			r.Delete("/bundle/{id}", func(w http.ResponseWriter, req *http.Request) {
				id := chi.URLParam(req, "id")
				bundlesMu.Lock()
				_, ok := bundles[id]
				delete(bundles, id)
				bundlesMu.Unlock()
				if !ok {
					bundleError(w, http.StatusNotFound, "no such bundle")
					return
				}
				d.removeManager(id)
				d.history.Drop(id)
				d.store.RemoveVirtual(id)
				w.WriteHeader(http.StatusNoContent)
			})
		},
	})
}

// exportBundle streams the zip.
func exportBundle(w http.ResponseWriter, r *http.Request, d *deps) {
	connID := r.URL.Query().Get("connId")
	if connID == "" {
		if list := d.store.AllStatuses(); len(list) > 0 {
			connID = list[0].ID
		}
	}
	st := d.store.GetStatus(connID)
	if st.ID == "" || st.Name == "" && !st.Connected && !st.Bundle {
		bundleError(w, http.StatusBadRequest, "connId is required")
		return
	}
	subject := r.URL.Query().Get("subject")
	from, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	to, _ := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
	if to == 0 {
		to = time.Now().UnixMilli()
	}
	limit := bundleDefaultLimit
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
		limit = min(n, bundleMaxMessages)
	}

	msgs, errs := bundleMessages(r.Context(), d, connID, subject, from, to, limit)
	history.Oldest(msgs)

	man := bundleManifest{Format: bundleFormat, CreatedAt: time.Now().UnixMilli(), ExplorerVersion: version, From: from, To: to, Subject: subject, Messages: len(msgs), Errors: errs}
	man.Connection.ID = st.ID
	man.Connection.Name = st.Name
	man.Connection.Servers = st.Servers
	man.Connection.Subscriptions = st.Subscriptions
	man.Connection.JSDomain = st.JSDomain
	subjects := map[string]bool{}
	for i := range msgs {
		subjects[msgs[i].Subject] = true
	}
	man.Subjects = len(subjects)

	name := fmt.Sprintf("nats-explorer-%s-%s.zip", safeName(st.Name), time.Now().Format("20060102-1504"))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)

	zw := zip.NewWriter(w)
	defer zw.Close()
	writeJSONEntry(zw, "manifest.json", man)
	if f, err := zw.Create("messages.jsonl"); err == nil {
		bw := bufio.NewWriterSize(f, 64<<10)
		enc := json.NewEncoder(bw)
		for i := range msgs {
			if enc.Encode(msgs[i]) != nil {
				break
			}
		}
		bw.Flush()
	}
	server, snapErrs := handler.Snapshot(d.store, connID, []string{"varz", "jsz", "connz", "subsz", "routez", "leafz", "healthz"})
	if len(snapErrs) > 0 {
		server["errors"] = snapErrs
	}
	writeJSONEntry(zw, "server.json", server)
	writeJSONEntry(zw, "streams.json", bundleStreams(r.Context(), d, connID))
	writeJSONEntry(zw, "kv.json", bundleKV(r.Context(), d, connID))
}

// bundleMessages reads the range from the database when there is one, and
// from memory otherwise.
func bundleMessages(ctx context.Context, d *deps, connID, subject string, from, to int64, limit int) ([]message.NatsMessage, []string) {
	var errs []string
	if db := d.tee.DB(); db != nil && from > 0 {
		var msgs []message.NatsMessage
		var err error
		if subject != "" {
			msgs, err = db.Range(ctx, connID, subject, true, from, to, limit)
		} else {
			msgs, err = db.RangeAll(ctx, connID, from, to, limit)
		}
		if err == nil {
			return msgs, nil
		}
		errs = append(errs, "history db: "+err.Error())
	}
	if subject != "" {
		return d.history.Branch(connID, subject, limit, 0), errs
	}
	if mem, ok := d.history.(interface {
		Dump(string, int) []message.NatsMessage
	}); ok {
		return mem.Dump(connID, limit), errs
	}
	return nil, append(errs, "no message source available")
}

func bundleStreams(ctx context.Context, d *deps, connID string) []map[string]interface{} {
	out := []map[string]interface{}{}
	js, err := handler.JetStreamFor(d.store, connID)
	if err != nil {
		return out
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for si := range js.ListStreams(ctx).Info() {
		entry := map[string]interface{}{"name": si.Config.Name, "subjects": si.Config.Subjects, "messages": si.State.Msgs, "bytes": si.State.Bytes, "consumers": si.State.Consumers}
		consumers := []map[string]interface{}{}
		if s, err := js.Stream(ctx, si.Config.Name); err == nil {
			for ci := range s.ListConsumers(ctx).Info() {
				consumers = append(consumers, map[string]interface{}{
					"name": ci.Name, "pending": ci.NumPending, "ackPending": ci.NumAckPending, "redelivered": ci.NumRedelivered,
				})
			}
		}
		entry["consumers"] = consumers
		out = append(out, entry)
	}
	return out
}

func bundleKV(ctx context.Context, d *deps, connID string) []map[string]interface{} {
	out := []map[string]interface{}{}
	js, err := handler.JetStreamFor(d.store, connID)
	if err != nil {
		return out
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for name := range js.KeyValueStoreNames(ctx).Name() {
		kv, err := js.KeyValue(ctx, name)
		if err != nil {
			continue
		}
		status, err := kv.Status(ctx)
		if err != nil {
			continue
		}
		out = append(out, map[string]interface{}{"bucket": name, "values": status.Values(), "bytes": status.Bytes(), "history": status.History()})
	}
	return out
}

// importBundle reads an uploaded zip and opens it as a read-only connection.
func importBundle(w http.ResponseWriter, r *http.Request, d *deps) {
	r.Body = http.MaxBytesReader(w, r.Body, bundleMaxUpload)
	file, header, err := r.FormFile("file")
	if err != nil {
		bundleError(w, http.StatusBadRequest, "a zip file is required in the `file` field")
		return
	}
	defer file.Close()
	buf, err := io.ReadAll(file)
	if err != nil {
		bundleError(w, http.StatusBadRequest, err.Error())
		return
	}
	zr, err := zip.NewReader(strings.NewReader(string(buf)), int64(len(buf)))
	if err != nil {
		bundleError(w, http.StatusBadRequest, "not a readable zip: "+err.Error())
		return
	}

	b := &imported{}
	var msgs []message.NatsMessage
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			continue
		}
		switch f.Name {
		case "manifest.json":
			json.NewDecoder(rc).Decode(&b.Manifest)
		case "server.json":
			json.NewDecoder(rc).Decode(&b.Server)
		case "streams.json":
			json.NewDecoder(rc).Decode(&b.Streams)
		case "kv.json":
			json.NewDecoder(rc).Decode(&b.KV)
		case "messages.jsonl":
			sc := bufio.NewScanner(rc)
			sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
			for sc.Scan() && len(msgs) < bundleMaxMessages {
				var m message.NatsMessage
				if json.Unmarshal(sc.Bytes(), &m) == nil && m.Subject != "" {
					msgs = append(msgs, m)
				}
			}
		}
		rc.Close()
	}
	if b.Manifest.Format == 0 && len(msgs) == 0 {
		bundleError(w, http.StatusBadRequest, "this zip carries no manifest and no messages")
		return
	}

	sum := sha256.Sum256(buf)
	id := bundleIDPrefix + hex.EncodeToString(sum[:4])
	name := b.Manifest.Connection.Name
	if name == "" {
		name = strings.TrimSuffix(header.Filename, ".zip")
	}

	// A second import of the same file replaces the first.
	d.removeManager(id)
	d.history.Drop(id)

	mgr := subscription.NewManager(id)
	d.wireManager(id, mgr)
	subjects := b.Manifest.Connection.Subscriptions
	if len(subjects) == 0 {
		subjects = []string{">"}
	}
	mgr.StartOffline(subjects)
	mgr.Ingest(msgs)
	d.addManager(id, mgr)

	d.store.AddVirtual(connection.Status{ID: id, Name: "Bundle: " + name, Subscriptions: subjects, Servers: b.Manifest.Connection.Servers})
	bundlesMu.Lock()
	bundles[id] = b
	bundlesMu.Unlock()

	bundleJSON(w, map[string]interface{}{"id": id, "name": "Bundle: " + name, "messages": len(msgs), "manifest": b.Manifest})
}

func writeJSONEntry(zw *zip.Writer, name string, v interface{}) {
	f, err := zw.Create(name)
	if err != nil {
		return
	}
	enc := json.NewEncoder(f)
	enc.SetIndent("", " ")
	enc.Encode(v)
}

// safeName keeps a connection name usable in a file name.
func safeName(name string) string {
	if name == "" {
		return "connection"
	}
	out := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		case r == ' ' || r == '.':
			return '-'
		default:
			return -1
		}
	}, name)
	if out == "" {
		return "connection"
	}
	return strings.ToLower(out)
}

func bundleJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func bundleError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
