// Package auth decides who a request comes from and what it may do.
//
// Three modes, picked by configuration: none (every request is an admin,
// the default for a local tool), token (one shared AUTH_TOKEN, admin) and
// users (a file of name:role:bcrypt lines; viewers read, admins write).
// A login hands out an HttpOnly session cookie, so neither the browser nor
// the websocket URL carries a credential after that. API scripts and
// Prometheus scrapers keep using a bearer token or HTTP basic auth.
package auth

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Role is what an identity may do: viewers read, admins also write.
type Role string

const (
	RoleViewer Role = "viewer"
	RoleAdmin  Role = "admin"
)

// Identity is the caller of a request.
type Identity struct {
	Name string `json:"user"`
	Role Role   `json:"role"`
	// Connections narrows what the caller sees to the connections whose id
	// or name matches one of these patterns (`*` and `?` as in a file
	// name). Empty is every connection.
	Connections []string `json:"connections,omitempty"`
}

// AllowsConn says whether the identity may see a connection, by its id or
// its name.
func (id Identity) AllowsConn(connID, name string) bool {
	if len(id.Connections) == 0 {
		return true
	}
	for _, p := range id.Connections {
		if ok, _ := path.Match(p, connID); ok {
			return true
		}
		if name != "" {
			if ok, _ := path.Match(p, name); ok {
				return true
			}
		}
	}
	return false
}

// Restricted says whether the identity sees less than every connection.
func (id Identity) Restricted() bool { return len(id.Connections) > 0 }

// User is one line of the users file.
type User struct {
	Name string
	Role Role
	Hash []byte
	// Connections, from an optional fourth field, narrows what the user sees.
	Connections []string
}

// splitPatterns reads a comma-separated list of connection patterns.
func splitPatterns(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ParseUsers reads "name:role:bcrypt-hash[:connections]" lines, the last
// field a comma-separated list of connection names or ids, `*` allowed.
// Blank lines and lines starting with # are skipped. A bcrypt hash holds
// no colon, so the fourth field is unambiguous.
func ParseUsers(r io.Reader) ([]User, error) {
	var users []User
	seen := map[string]bool{}
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, ":", 4)
		if len(parts) < 3 || parts[0] == "" {
			return nil, fmt.Errorf("line %d: want name:role:bcrypt-hash[:connections]", n)
		}
		var conns []string
		if len(parts) == 4 {
			conns = splitPatterns(parts[3])
			for _, p := range conns {
				if _, err := path.Match(p, ""); err != nil {
					return nil, fmt.Errorf("line %d: connection pattern %q: %v", n, p, err)
				}
			}
		}
		role := Role(strings.ToLower(strings.TrimSpace(parts[1])))
		if role != RoleAdmin && role != RoleViewer {
			return nil, fmt.Errorf("line %d: role %q is not admin or viewer", n, parts[1])
		}
		hash := strings.TrimSpace(parts[2])
		if _, err := bcrypt.Cost([]byte(hash)); err != nil {
			return nil, fmt.Errorf("line %d: not a bcrypt hash (generate one with `nats-explorer hash-password`)", n)
		}
		if seen[parts[0]] {
			return nil, fmt.Errorf("line %d: user %q listed twice", n, parts[0])
		}
		seen[parts[0]] = true
		users = append(users, User{Name: parts[0], Role: role, Hash: []byte(hash), Connections: conns})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return users, nil
}

// LoadUsers reads a users file.
func LoadUsers(path string) ([]User, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseUsers(f)
}

// HashPassword produces a users-file hash.
func HashPassword(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	return string(h), err
}

const (
	// CookieName carries the session between requests.
	CookieName = "ne_session"
	// SessionTTL is how long a login lasts.
	SessionTTL = 24 * time.Hour
)

type session struct {
	id      Identity
	expires time.Time
}

// Service authenticates requests and keeps the sessions.
type Service struct {
	token string
	users map[string]User
	// hash compared for unknown users so a login takes the same time either way
	dummy []byte

	mu       sync.Mutex
	sessions map[string]session
	sweep    time.Time
	// store keeps the sessions and the personal tokens between restarts;
	// nil keeps them for this run only.
	store  Store
	tokens []Token
	// oidc is the identity provider, when single sign-on is on.
	oidc *oidcProvider
}

// New builds a service. Either argument may be empty.
func New(token string, users []User) *Service {
	s := &Service{token: token, users: make(map[string]User, len(users)), sessions: map[string]session{}}
	for _, u := range users {
		s.users[u.Name] = u
	}
	s.dummy, _ = bcrypt.GenerateFromPassword([]byte("dummy"), bcrypt.MinCost)
	return s
}

// Mode reports "none", "token", "users" or "oidc". With single sign-on and
// a users file both, the login offers both and the mode is "users".
func (s *Service) Mode() string {
	switch {
	case len(s.users) > 0:
		return "users"
	case s.oidc != nil:
		return "oidc"
	case s.token != "":
		return "token"
	default:
		return "none"
	}
}

// Login checks a user's password.
func (s *Service) Login(name, password string) (Identity, bool) {
	u, ok := s.users[name]
	hash := s.dummy
	if ok {
		hash = u.Hash
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte(password)); err != nil || !ok {
		return Identity{}, false
	}
	return Identity{Name: u.Name, Role: u.Role, Connections: u.Connections}, true
}

// LoginToken checks the shared token; it always grants admin.
func (s *Service) LoginToken(token string) (Identity, bool) {
	if s.token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) != 1 {
		return Identity{}, false
	}
	return Identity{Name: "token", Role: RoleAdmin}, true
}

// NewSession stores an identity and returns the cookie value.
func (s *Service) NewSession(id Identity) string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	key := hex.EncodeToString(buf)
	s.mu.Lock()
	s.sessions[key] = session{id: id, expires: time.Now().Add(SessionTTL)}
	s.saveSessions()
	s.mu.Unlock()
	return key
}

// Lookup resolves a cookie value.
func (s *Service) Lookup(key string) (Identity, bool) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.After(s.sweep) {
		swept := false
		for k, ss := range s.sessions {
			if now.After(ss.expires) {
				delete(s.sessions, k)
				swept = true
			}
		}
		if swept {
			s.saveSessions()
		}
		s.sweep = now.Add(10 * time.Minute)
	}
	ss, ok := s.sessions[key]
	if !ok || now.After(ss.expires) {
		return Identity{}, false
	}
	return ss.id, true
}

// Revoke ends a session.
func (s *Service) Revoke(key string) {
	s.mu.Lock()
	delete(s.sessions, key)
	s.saveSessions()
	s.mu.Unlock()
}

// Identify finds the caller: the session cookie, then a bearer token in the
// Authorization or X-Auth-Token header or the token query parameter, then
// HTTP basic auth with a users-file account.
func (s *Service) Identify(r *http.Request) (Identity, bool) {
	if s.Mode() == "none" {
		return Identity{Role: RoleAdmin}, true
	}
	if c, err := r.Cookie(CookieName); err == nil {
		if id, ok := s.Lookup(c.Value); ok {
			return id, true
		}
	}
	if name, pass, ok := r.BasicAuth(); ok {
		return s.Login(name, pass)
	}
	if tok := bearer(r); tok != "" {
		if id, ok := s.LoginToken(tok); ok {
			return id, true
		}
		return s.lookupToken(tok)
	}
	return Identity{}, false
}

func bearer(r *http.Request) string {
	if a := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(a), "bearer ") {
		return strings.TrimSpace(a[7:])
	}
	if t := r.Header.Get("X-Auth-Token"); t != "" {
		return t
	}
	return r.URL.Query().Get("token")
}

type ctxKey struct{}

// FromContext returns the identity Require stored.
func FromContext(ctx context.Context) Identity {
	id, _ := ctx.Value(ctxKey{}).(Identity)
	return id
}

// Require rejects unidentified requests with 401.
func (s *Service) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := s.Identify(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

// AdminForWrites lets viewers through on GET and HEAD only. Every other
// method changes something on the NATS side or in the explorer.
func (s *Service) AdminForWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && FromContext(r.Context()).Role != RoleAdmin {
			writeError(w, http.StatusForbidden, "read-only account: this action needs the admin role")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Info answers GET /api/auth for the UI: the mode and who the caller is.
func (s *Service) Info(w http.ResponseWriter, r *http.Request) {
	id, ok := s.Identify(r)
	writeJSON(w, map[string]interface{}{
		"mode":          s.Mode(),
		"authenticated": ok,
		"user":          id.Name,
		"role":          id.Role,
		"connections":   id.Connections,
		"oidc":          s.oidc != nil,
		// kept for older clients: true when a login is needed
		"required": !ok,
	})
}

// LoginHandler answers POST /api/login with {"user","password"} or
// {"token"} and sets the session cookie.
func (s *Service) LoginHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		User     string `json:"user"`
		Password string `json:"password"`
		Token    string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	var id Identity
	var ok bool
	if body.Token != "" {
		id, ok = s.LoginToken(body.Token)
	} else {
		id, ok = s.Login(body.User, body.Password)
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "wrong credentials")
		return
	}
	http.SetCookie(w, s.cookie(r, s.NewSession(id), int(SessionTTL/time.Second)))
	writeJSON(w, id)
}

// LogoutHandler answers POST /api/logout.
func (s *Service) LogoutHandler(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(CookieName); err == nil {
		s.Revoke(c.Value)
	}
	http.SetCookie(w, s.cookie(r, "", -1))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) cookie(r *http.Request, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
	}
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
