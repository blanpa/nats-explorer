// Package audit records who changed what through the API: every request
// with a method other than GET or HEAD, after it completed, with the object
// it touched. The store behind it is SQLite, a JSONL file or memory.
package audit

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"nats-explorer/internal/auth"
)

// Entry is one recorded write.
type Entry struct {
	Time    int64  `json:"time"` // unix milliseconds
	User    string `json:"user"`
	Role    string `json:"role"`
	IP      string `json:"ip"`
	Method  string `json:"method"`
	Path    string `json:"path"`
	ConnID  string `json:"connId,omitempty"`
	Status  int    `json:"status"`
	Summary string `json:"summary"`
}

// Query narrows a listing; results come newest first.
type Query struct {
	Limit  int
	User   string
	Method string
	Since  int64 // unix milliseconds, 0 for all
}

// Store keeps entries.
type Store interface {
	Append(e Entry) error
	Query(ctx context.Context, q Query) ([]Entry, error)
}

// Matches applies the filters of a query to one entry.
func (q Query) Matches(e Entry) bool {
	if q.User != "" && !strings.EqualFold(e.User, q.User) {
		return false
	}
	if q.Method != "" && !strings.EqualFold(e.Method, q.Method) {
		return false
	}
	return q.Since == 0 || e.Time >= q.Since
}

/* Memory ---------------------------------------------------------------- */

// MemStore keeps the last entries in a ring.
type MemStore struct {
	mu      sync.Mutex
	entries []Entry
	max     int
}

// NewMemStore keeps at most max entries.
func NewMemStore(max int) *MemStore {
	return &MemStore{max: max}
}

func (s *MemStore) Append(e Entry) error {
	s.mu.Lock()
	s.entries = append(s.entries, e)
	if len(s.entries) > s.max {
		s.entries = s.entries[len(s.entries)-s.max:]
	}
	s.mu.Unlock()
	return nil
}

func (s *MemStore) Query(_ context.Context, q Query) ([]Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return newestFirst(s.entries, q), nil
}

// newestFirst filters and reverses an oldest-first list.
func newestFirst(entries []Entry, q Query) []Entry {
	out := []Entry{}
	for i := len(entries) - 1; i >= 0; i-- {
		if q.Matches(entries[i]) {
			out = append(out, entries[i])
			if q.Limit > 0 && len(out) >= q.Limit {
				break
			}
		}
	}
	return out
}

/* File ------------------------------------------------------------------ */

// FileStore appends JSON lines to a file and reads them back on query.
type FileStore struct {
	mu   sync.Mutex
	path string
}

// NewFileStore writes to path (created on first entry).
func NewFileStore(path string) *FileStore {
	return &FileStore{path: path}
}

func (s *FileStore) Append(e Entry) error {
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	return err
}

func (s *FileStore) Query(_ context.Context, q Query) ([]Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.Open(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Entry{}, nil
		}
		return nil, err
	}
	defer f.Close()
	var entries []Entry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		var e Entry
		if err := json.Unmarshal(sc.Bytes(), &e); err == nil {
			entries = append(entries, e)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return newestFirst(entries, q), nil
}

/* Summary --------------------------------------------------------------- */

// bodyPeek is how much of a request body the summary may look at.
const bodyPeek = 8 << 10

// Summarize names the object a write touches: the subject of a publish,
// the stream or bucket in the path, the connection, the settings key.
// body holds at most the first bodyPeek bytes of the request.
func Summarize(method, reqPath string, query map[string][]string, body []byte) (connID, summary string) {
	var doc map[string]any
	if len(body) > 0 && body[0] == '{' {
		// A truncated body does not parse; the summary then comes from the path.
		_ = json.Unmarshal(body, &doc)
	}
	str := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := doc[k]; ok {
				switch x := v.(type) {
				case string:
					if x != "" {
						return x
					}
				case []any:
					parts := make([]string, 0, len(x))
					for _, p := range x {
						if s, ok := p.(string); ok {
							parts = append(parts, s)
						}
					}
					if len(parts) > 0 {
						return strings.Join(parts, ", ")
					}
				}
			}
		}
		return ""
	}
	if v := query["connId"]; len(v) > 0 {
		connID = v[0]
	} else {
		connID = str("connId")
	}

	p := strings.TrimPrefix(path.Clean(reqPath), "/api/")
	seg := strings.Split(p, "/")
	switch seg[0] {
	case "publish", "request", "run":
		summary = str("subject")
	case "connect":
		if connID == "" {
			connID = str("id")
		}
		summary = str("name", "id")
	case "disconnect", "disconnect-all":
		summary = connID
	case "connections":
		if len(seg) > 1 && connID == "" {
			connID = seg[1]
		}
		if len(seg) > 2 && seg[2] == "subscriptions" {
			summary = str("subscriptions")
		}
	case "streams":
		if len(seg) > 1 {
			summary = seg[1]
			if len(seg) > 3 && seg[2] == "consumers" {
				summary += " / " + seg[3]
			} else if len(seg) > 3 && seg[2] == "messages" {
				summary += " #" + seg[3]
			}
		} else {
			summary = str("name")
		}
		if len(seg) > 2 && seg[2] == "consumers" && len(seg) == 3 {
			summary += " / " + str("name", "durable")
		}
	case "kv", "objectstore":
		if len(seg) > 1 {
			summary = strings.Join(seg[1:min(3, len(seg))], " / ")
		} else {
			summary = str("bucket", "name", "store")
		}
	case "settings":
		if len(seg) > 1 {
			summary = seg[1]
		}
	case "history":
		summary = "history"
	case "alerts":
		summary = str("name", "id")
	default:
		summary = str("name", "id", "subject")
	}
	if summary == "" {
		summary = p
	}
	return connID, summary
}

// Skip reports writes that are not worth an entry: UI preferences saved
// through the settings endpoint (only connections and alerts are kept).
func Skip(method, reqPath string) bool {
	if strings.HasPrefix(reqPath, "/api/settings/") {
		key := strings.TrimPrefix(reqPath, "/api/settings/")
		return !strings.Contains(key, "connections") && !strings.Contains(key, "alerts")
	}
	return false
}

/* Middleware ------------------------------------------------------------ */

// Middleware records every completed write into the store.
func Middleware(store Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions || Skip(r.Method, r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			// Peek at the body for the summary; the handler gets the whole of it.
			var peek []byte
			if r.Body != nil && r.Body != http.NoBody {
				peek, _ = io.ReadAll(io.LimitReader(r.Body, bodyPeek))
				r.Body = struct {
					io.Reader
					io.Closer
				}{io.MultiReader(bytes.NewReader(peek), r.Body), r.Body}
			}
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			started := time.Now()
			next.ServeHTTP(ww, r)

			id := auth.FromContext(r.Context())
			connID, summary := Summarize(r.Method, r.URL.Path, r.URL.Query(), peek)
			ip := r.RemoteAddr
			if host, _, err := net.SplitHostPort(ip); err == nil {
				ip = host
			}
			status := ww.Status()
			if status == 0 {
				status = http.StatusOK
			}
			_ = store.Append(Entry{
				Time:    started.UnixMilli(),
				User:    id.Name,
				Role:    string(id.Role),
				IP:      ip,
				Method:  r.Method,
				Path:    r.URL.Path,
				ConnID:  connID,
				Status:  status,
				Summary: summary,
			})
		})
	}
}
