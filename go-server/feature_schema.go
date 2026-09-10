package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"nats-explorer/internal/filter"
	"nats-explorer/internal/message"
	"nats-explorer/internal/schema"
)

const (
	schemaDefaultLimit = 200
	schemaMaxLimit     = 2000
)

// GET /api/schema?subject=&connId=&limit=&from=&to=: the structure of a
// subject's payloads, derived from its recorded messages. Without connId
// the histories of all connections are merged; with from/to and a
// persistent history the messages come from the database.
func init() {
	registerFeature(feature{
		name: "schema",
		api: func(r chi.Router, d *deps) {
			r.Get("/schema", func(w http.ResponseWriter, req *http.Request) {
				q := req.URL.Query()
				subject := q.Get("subject")
				if subject == "" {
					schemaError(w, http.StatusBadRequest, "subject is required")
					return
				}
				limit := schemaDefaultLimit
				if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 {
					limit = min(n, schemaMaxLimit)
				}
				from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
				to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
				ranged := from != 0 || to != 0
				if ranged && to == 0 {
					to = time.Now().UnixMilli()
				}

				var ids []string
				if id := q.Get("connId"); id != "" {
					ids = []string{id}
				} else {
					for _, st := range d.store.AllStatuses() {
						ids = append(ids, st.ID)
					}
				}
				var msgs []message.NatsMessage
				for _, id := range ids {
					if db := d.tee.DB(); ranged && db != nil {
						part, err := db.Range(req.Context(), id, subject, false, from, to, limit)
						if err != nil {
							schemaError(w, http.StatusInternalServerError, err.Error())
							return
						}
						msgs = append(msgs, part...)
						continue
					}
					msgs = append(msgs, d.history.Subject(id, subject, limit, 0)...)
				}
				out := schema.Infer(msgs)
				// How the sampled messages hold up against a pinned schema:
				// the number is the point of pinning one.
				body := map[string]interface{}{"subject": subject, "schema": out}
				if _, pattern := filter.SchemaViolations(subject, "json", []byte("{}")); pattern != "" {
					invalid := 0
					for i := range msgs {
						if v, _ := filter.SchemaViolations(subject, msgs[i].PayloadType, []byte(msgs[i].Payload)); len(v) > 0 {
							invalid++
						}
					}
					body["pinnedPattern"] = pattern
					body["invalid"] = invalid
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(body)
			})
		},
	})
}

func schemaError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
