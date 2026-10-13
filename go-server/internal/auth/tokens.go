package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// What a team needs beyond a login: sessions that survive a restart of the
// server, so a deploy does not log everyone out, and tokens of their own
// for the scripts and the scrapers, each with a name and a role, revoked
// one at a time instead of rotating the one shared AUTH_TOKEN for all.

// Store is where sessions and tokens are kept between restarts: the
// settings store of a server with a directory of its own.
type Store interface {
	Get(key string) (json.RawMessage, bool)
	Set(key string, value json.RawMessage) error
}

const (
	sessionsKey = "ne.auth.sessions.v1"
	tokensKey   = "ne.auth.tokens.v1"
	tokenPrefix = "ne_"
)

// Token is a personal API token: the hash of it, never the token itself,
// which is shown once when it is made.
type Token struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Role    Role   `json:"role"`
	Created int64  `json:"created"`
	// LastUsed is unix ms of the last request that carried it.
	LastUsed int64  `json:"lastUsed,omitempty"`
	Hash     string `json:"hash,omitempty"`
}

type storedSession struct {
	User    string `json:"user"`
	Role    Role   `json:"role"`
	Expires int64  `json:"expires"`
}

// Persist loads the sessions and tokens from the store and writes every
// change back. Before this a restart meant a login for everyone.
func (s *Service) Persist(store Store) {
	s.mu.Lock()
	s.store = store
	if raw, ok := store.Get(sessionsKey); ok {
		var saved map[string]storedSession
		if json.Unmarshal(raw, &saved) == nil {
			now := time.Now()
			for key, ss := range saved {
				exp := time.UnixMilli(ss.Expires)
				if exp.After(now) {
					s.sessions[key] = session{id: Identity{Name: ss.User, Role: ss.Role}, expires: exp}
				}
			}
		}
	}
	if raw, ok := store.Get(tokensKey); ok {
		var saved []Token
		if json.Unmarshal(raw, &saved) == nil {
			s.tokens = saved
		}
	}
	s.mu.Unlock()
}

// saveSessions writes the sessions; s.mu is held by the caller.
func (s *Service) saveSessions() {
	if s.store == nil {
		return
	}
	out := make(map[string]storedSession, len(s.sessions))
	for key, ss := range s.sessions {
		out[key] = storedSession{User: ss.id.Name, Role: ss.id.Role, Expires: ss.expires.UnixMilli()}
	}
	data, _ := json.Marshal(out)
	s.store.Set(sessionsKey, data)
}

// saveTokens writes the tokens; s.mu is held by the caller.
func (s *Service) saveTokens() {
	if s.store == nil {
		return
	}
	data, _ := json.Marshal(s.tokens)
	s.store.Set(tokensKey, data)
}

// ErrNoAuth is answered when tokens are asked for on a server without
// authentication: there is nothing a token could stand in for.
var ErrNoAuth = errors.New("no authentication is configured, so there is nothing a token would stand in for: set AUTH_TOKEN or AUTH_USERS")

// ErrNoStore is answered when tokens cannot be kept: a browser-storage
// server forgets them with the next restart, which is worse than none.
var ErrNoStore = errors.New("personal tokens need a server with STORAGE_DIR, where they survive a restart")

func hashToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// CreateToken makes a token and returns it in the clear, once.
func (s *Service) CreateToken(name string, role Role) (string, Token, error) {
	name = strings.TrimSpace(name)
	switch {
	case s.Mode() == "none":
		return "", Token{}, ErrNoAuth
	case s.store == nil:
		return "", Token{}, ErrNoStore
	case name == "":
		return "", Token{}, errors.New("a token needs a name")
	case role != RoleAdmin && role != RoleViewer:
		return "", Token{}, fmt.Errorf("role %q is not admin or viewer", role)
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", Token{}, err
	}
	plain := tokenPrefix + hex.EncodeToString(buf)
	id := make([]byte, 8)
	rand.Read(id)
	t := Token{ID: hex.EncodeToString(id), Name: name, Role: role, Created: time.Now().UnixMilli(), Hash: hashToken(plain)}
	s.mu.Lock()
	s.tokens = append(s.tokens, t)
	s.saveTokens()
	s.mu.Unlock()
	t.Hash = ""
	return plain, t, nil
}

// Tokens lists the tokens without their hashes.
func (s *Service) Tokens() []Token {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Token, 0, len(s.tokens))
	for _, t := range s.tokens {
		t.Hash = ""
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out
}

// DeleteToken revokes one; a request carrying it is refused from then on.
func (s *Service) DeleteToken(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, t := range s.tokens {
		if t.ID == id {
			s.tokens = append(s.tokens[:i], s.tokens[i+1:]...)
			s.saveTokens()
			return true
		}
	}
	return false
}

// lookupToken finds the personal token a bearer value stands for.
func (s *Service) lookupToken(plain string) (Identity, bool) {
	if !strings.HasPrefix(plain, tokenPrefix) {
		return Identity{}, false
	}
	h := hashToken(plain)
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.tokens {
		if subtle.ConstantTimeCompare([]byte(s.tokens[i].Hash), []byte(h)) == 1 {
			// Once a minute is enough for "last used"; every request would
			// write the file for every scrape.
			if now := time.Now().UnixMilli(); now-s.tokens[i].LastUsed > 60_000 {
				s.tokens[i].LastUsed = now
				s.saveTokens()
			}
			return Identity{Name: "token:" + s.tokens[i].Name, Role: s.tokens[i].Role}, true
		}
	}
	return Identity{}, false
}

// TokenRoutes mounts the token management under an authenticated router.
// Reading the list is for admins as well: a token's name and role say who
// may do what, which is not a viewer's business.
func (s *Service) TokenRoutes(r chi.Router) {
	admin := func(w http.ResponseWriter, r *http.Request) bool {
		if FromContext(r.Context()).Role != RoleAdmin {
			writeError(w, http.StatusForbidden, "tokens are managed by an admin")
			return false
		}
		return true
	}
	r.Get("/tokens", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		writeJSON(w, map[string]interface{}{"tokens": s.Tokens(), "supported": s.Mode() != "none" && s.store != nil})
	})
	r.Post("/tokens", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var body struct {
			Name string `json:"name"`
			Role Role   `json:"role"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.Role == "" {
			body.Role = RoleViewer
		}
		plain, t, err := s.CreateToken(body.Name, body.Role)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, ErrNoAuth) || errors.Is(err, ErrNoStore) {
				status = http.StatusConflict
			}
			writeError(w, status, err.Error())
			return
		}
		writeJSON(w, map[string]interface{}{"token": plain, "info": t})
	})
	r.Delete("/tokens/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		if !s.DeleteToken(chi.URLParam(r, "id")) {
			writeError(w, http.StatusNotFound, "no such token")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
