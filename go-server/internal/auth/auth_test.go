package auth

import (
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
