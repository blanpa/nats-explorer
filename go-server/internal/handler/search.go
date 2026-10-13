package handler

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
)

// SearchHandler finds JetStream things by name across a connection: streams
// (by name or by one of their subjects), Key-Value buckets and the keys in
// all of them, object stores and the objects in all of them. It is what the
// command palette asks while someone types.
type SearchHandler struct {
	Store *connection.Store
	// Subjects finds the subjects a connection has received that contain
	// q; nil leaves subjects out.
	Subjects func(connID, q string, limit int) []string
}

const (
	searchBudget   = 3 * time.Second
	searchPerKind  = 20
	searchMaxQuery = 200
)

type searchHit struct {
	Kind string `json:"kind"` // subject | stream | bucket | key | store | object
	// Name is the stream, bucket, store or subject; Item the key or object
	// in it.
	Name string `json:"name"`
	Item string `json:"item,omitempty"`
	// Detail says why it matched or what it is: a subject of the stream.
	Detail string `json:"detail,omitempty"`
}

type searchResult struct {
	Hits []searchHit `json:"hits"`
	// Partial is set when the time ran out before every bucket and store
	// was read, or a kind was cut at its limit.
	Partial bool     `json:"partial"`
	Errors  []string `json:"errors"`
}

// Search answers GET /api/search?connId=…&q=…
func (h *SearchHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if q == "" || len(q) > searchMaxQuery {
		writeJSON(w, searchResult{Hits: []searchHit{}, Errors: []string{}})
		return
	}
	var subjects []searchHit
	moreSubjects := false
	if h.Subjects != nil {
		found := h.Subjects(r.URL.Query().Get("connId"), q, searchPerKind+1)
		moreSubjects = len(found) > searchPerKind
		for i, s := range found {
			if i == searchPerKind {
				break
			}
			subjects = append(subjects, searchHit{Kind: "subject", Name: s})
		}
	}
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		// Without JetStream the subjects are still worth an answer.
		writeJSON(w, searchResult{Hits: append([]searchHit{}, subjects...), Partial: moreSubjects, Errors: []string{err.Error()}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), searchBudget)
	defer cancel()
	res := search(ctx, js, q)
	res.Hits = append(subjects, res.Hits...)
	res.Partial = res.Partial || moreSubjects
	if res.Hits == nil {
		res.Hits = []searchHit{}
	}
	writeJSON(w, res)
}

func search(ctx context.Context, js jetstream.JetStream, q string) searchResult {
	out := searchResult{Hits: []searchHit{}, Errors: []string{}}
	count := map[string]int{}
	add := func(h searchHit) bool {
		if count[h.Kind] >= searchPerKind {
			out.Partial = true
			return false
		}
		count[h.Kind]++
		out.Hits = append(out.Hits, h)
		return true
	}

	var buckets, stores []string
	sl := js.ListStreams(ctx)
	for si := range sl.Info() {
		name := si.Config.Name
		switch {
		case strings.HasPrefix(name, kvStreamPrefix):
			b := strings.TrimPrefix(name, kvStreamPrefix)
			buckets = append(buckets, b)
			if strings.Contains(strings.ToLower(b), q) {
				add(searchHit{Kind: "bucket", Name: b})
			}
		case strings.HasPrefix(name, "OBJ_"):
			s := strings.TrimPrefix(name, "OBJ_")
			stores = append(stores, s)
			if strings.Contains(strings.ToLower(s), q) {
				add(searchHit{Kind: "store", Name: s})
			}
		default:
			if strings.Contains(strings.ToLower(name), q) {
				add(searchHit{Kind: "stream", Name: name})
				continue
			}
			for _, subj := range si.Config.Subjects {
				if strings.Contains(strings.ToLower(subj), q) {
					add(searchHit{Kind: "stream", Name: name, Detail: subj})
					break
				}
			}
		}
	}
	if err := sl.Err(); err != nil {
		out.Errors = append(out.Errors, "streams: "+err.Error())
	}
	sort.Strings(buckets)
	sort.Strings(stores)

	// The keys and the objects are read bucket by bucket, as far as the
	// time goes; a huge bucket can take it all.
	for _, b := range buckets {
		if ctx.Err() != nil || count["key"] >= searchPerKind {
			out.Partial = out.Partial || ctx.Err() != nil
			break
		}
		kv, err := js.KeyValue(ctx, b)
		if err != nil {
			continue
		}
		lister, err := kv.ListKeys(ctx)
		if err != nil {
			continue
		}
		for k := range lister.Keys() {
			if strings.Contains(strings.ToLower(k), q) && !add(searchHit{Kind: "key", Name: b, Item: k}) {
				break
			}
		}
		lister.Stop()
	}
	for _, s := range stores {
		if ctx.Err() != nil || count["object"] >= searchPerKind {
			out.Partial = out.Partial || ctx.Err() != nil
			break
		}
		os, err := js.ObjectStore(ctx, s)
		if err != nil {
			continue
		}
		infos, err := os.List(ctx)
		if err != nil {
			continue
		}
		for _, info := range infos {
			if strings.Contains(strings.ToLower(info.Name), q) && !add(searchHit{Kind: "object", Name: s, Item: info.Name}) {
				break
			}
		}
	}
	return out
}
