package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// cheap hashes: the tests check the plumbing, not bcrypt's cost
func hash(pw string) string {
	h, _ := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.MinCost)
	return string(h)
}

func testUsers(t *testing.T) []User {
	t.Helper()
	admin, viewer := hash("secret"), hash("look")
	users, err := ParseUsers(strings.NewReader("# staff\nalice:admin:" + admin + "\n\nbob:viewer:" + viewer + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	return users
}

func TestParseUsersRejectsBadLines(t *testing.T) {
	for _, bad := range []string{"alice:admin", "alice:root:$2a$10$abc", "alice:admin:plaintext", "a:admin:$2a$04$Wqo8JFqXvXcJqXH5w5w5wO9J9Qp0M9vQq1cJb0sU2Gk7qJbGmYb3G\na:viewer:$2a$04$Wqo8JFqXvXcJqXH5w5w5wO9J9Qp0M9vQq1cJb0sU2Gk7qJbGmYb3G"} {
		if _, err := ParseUsers(strings.NewReader(bad)); err == nil {
			t.Errorf("%q parsed without error", bad)
		}
	}
}

func TestModesAndLogin(t *testing.T) {
	if New("", nil).Mode() != "none" || New("tok", nil).Mode() != "token" || New("tok", testUsers(t)).Mode() != "users" {
		t.Fatal("mode detection")
	}
	s := New("tok", testUsers(t))
	if id, ok := s.Login("alice", "secret"); !ok || id.Role != RoleAdmin {
		t.Fatalf("alice login = %+v %v", id, ok)
	}
	if _, ok := s.Login("alice", "wrong"); ok {
		t.Fatal("wrong password accepted")
	}
	if _, ok := s.Login("nobody", "secret"); ok {
		t.Fatal("unknown user accepted")
	}
	if id, ok := s.LoginToken("tok"); !ok || id.Role != RoleAdmin {
		t.Fatal("token login")
	}
	if _, ok := s.LoginToken("nope"); ok {
		t.Fatal("wrong token accepted")
	}
}

func TestSessionsAndMiddleware(t *testing.T) {
	s := New("", testUsers(t))
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(string(FromContext(r.Context()).Role))) })
	h := s.Require(s.AdminForWrites(ok))
	call := func(method, cookie, basic string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/x", nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: CookieName, Value: cookie})
		}
		if basic != "" {
			req.SetBasicAuth(strings.Split(basic, ":")[0], strings.Split(basic, ":")[1])
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	if rr := call("GET", "", ""); rr.Code != 401 {
		t.Fatalf("anonymous: %d", rr.Code)
	}
	bob := s.NewSession(Identity{Name: "bob", Role: RoleViewer})
	if rr := call("GET", bob, ""); rr.Code != 200 || rr.Body.String() != "viewer" {
		t.Fatalf("viewer GET: %d %s", rr.Code, rr.Body.String())
	}
	if rr := call("DELETE", bob, ""); rr.Code != 403 {
		t.Fatalf("viewer DELETE: %d", rr.Code)
	}
	if rr := call("POST", "", "alice:secret"); rr.Code != 200 || rr.Body.String() != "admin" {
		t.Fatalf("basic auth admin POST: %d", rr.Code)
	}
	if rr := call("GET", "", "alice:wrong"); rr.Code != 401 {
		t.Fatalf("basic auth wrong password: %d", rr.Code)
	}
	s.Revoke(bob)
	if rr := call("GET", bob, ""); rr.Code != 401 {
		t.Fatalf("revoked session: %d", rr.Code)
	}
	if rr := call("GET", "forged", ""); rr.Code != 401 {
		t.Fatalf("forged session: %d", rr.Code)
	}
}

func TestNoAuthModeIsAdmin(t *testing.T) {
	s := New("", nil)
	req := httptest.NewRequest("DELETE", "/api/x", nil)
	rr := httptest.NewRecorder()
	s.Require(s.AdminForWrites(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))).ServeHTTP(rr, req)
	if rr.Code != 204 {
		t.Fatalf("no-auth mode: %d", rr.Code)
	}
}

func TestLoginHandlerSetsCookie(t *testing.T) {
	s := New("tok", testUsers(t))
	rr := httptest.NewRecorder()
	s.LoginHandler(rr, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"user":"bob","password":"look"}`)))
	if rr.Code != 200 {
		t.Fatalf("login: %d %s", rr.Code, rr.Body.String())
	}
	cookies := rr.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName || !cookies[0].HttpOnly {
		t.Fatalf("cookie = %+v", cookies)
	}
	if id, ok := s.Lookup(cookies[0].Value); !ok || id.Name != "bob" || id.Role != RoleViewer {
		t.Fatalf("session = %+v %v", id, ok)
	}
	rr = httptest.NewRecorder()
	s.LoginHandler(rr, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"token":"tok"}`)))
	if rr.Code != 200 {
		t.Fatalf("token login: %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	s.LoginHandler(rr, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"user":"bob","password":"nope"}`)))
	if rr.Code != 401 {
		t.Fatalf("bad login: %d", rr.Code)
	}
	req := httptest.NewRequest("POST", "/api/logout", nil)
	req.AddCookie(cookies[0])
	rr = httptest.NewRecorder()
	s.LogoutHandler(rr, req)
	if _, ok := s.Lookup(cookies[0].Value); ok || rr.Code != 204 {
		t.Fatal("logout must revoke the session")
	}
}

// memStore is the settings store of the tests: a map.
type memStore struct{ m map[string]json.RawMessage }

func (s *memStore) Get(key string) (json.RawMessage, bool) { v, ok := s.m[key]; return v, ok }
func (s *memStore) Set(key string, v json.RawMessage) error {
	s.m[key] = append(json.RawMessage(nil), v...)
	return nil
}

// Sessions and personal tokens survive a new service on the same store;
// a token is checked by its hash, named by its name, and gone once revoked.
func TestPersistedSessionsAndTokens(t *testing.T) {
	store := &memStore{m: map[string]json.RawMessage{}}
	hash, _ := bcrypt.GenerateFromPassword([]byte("pw"), bcrypt.MinCost)
	users := []User{{Name: "pascal", Role: RoleAdmin, Hash: hash}}
	s := New("", users)
	s.Persist(store)
	key := s.NewSession(Identity{Name: "pascal", Role: RoleAdmin})
	plain, info, err := s.CreateToken("grafana", RoleViewer)
	if err != nil || !strings.HasPrefix(plain, "ne_") || info.Hash != "" || info.Name != "grafana" {
		t.Fatalf("create token: %v %q %+v", err, plain, info)
	}
	if _, _, err := s.CreateToken("", RoleViewer); err == nil {
		t.Fatal("a nameless token was made")
	}
	if _, _, err := s.CreateToken("x", "root"); err == nil {
		t.Fatal("a token with an unknown role was made")
	}

	// A new service on the same store: the session and the token are there.
	s2 := New("", users)
	s2.Persist(store)
	if id, ok := s2.Lookup(key); !ok || id.Name != "pascal" {
		t.Fatalf("the session did not survive: %v %+v", ok, id)
	}
	req := httptest.NewRequest("GET", "/api/streams", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	if id, ok := s2.Identify(req); !ok || id.Name != "token:grafana" || id.Role != RoleViewer {
		t.Fatalf("the token did not identify: %v %+v", ok, id)
	}
	req.Header.Set("Authorization", "Bearer ne_0000")
	if _, ok := s2.Identify(req); ok {
		t.Fatal("an unknown token identified")
	}
	if list := s2.Tokens(); len(list) != 1 || list[0].Hash != "" || list[0].LastUsed == 0 {
		t.Fatalf("tokens = %+v", list)
	}
	if !s2.DeleteToken(info.ID) || s2.DeleteToken(info.ID) {
		t.Fatal("delete")
	}
	req.Header.Set("Authorization", "Bearer "+plain)
	if _, ok := s2.Identify(req); ok {
		t.Fatal("a revoked token identified")
	}
	s2.Revoke(key)
	s3 := New("", users)
	s3.Persist(store)
	if _, ok := s3.Lookup(key); ok {
		t.Fatal("a revoked session survived")
	}

	// Without authentication there is nothing a token stands in for; without
	// a store it would not survive a restart.
	if _, _, err := New("", nil).CreateToken("x", RoleAdmin); !errors.Is(err, ErrNoAuth) {
		t.Fatalf("no auth: %v", err)
	}
	if _, _, err := New("shared", nil).CreateToken("x", RoleAdmin); !errors.Is(err, ErrNoStore) {
		t.Fatalf("no store: %v", err)
	}
}
