package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireToken(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })

	t.Run("disabled when empty", func(t *testing.T) {
		rr := httptest.NewRecorder()
		RequireToken("")(ok).ServeHTTP(rr, httptest.NewRequest("GET", "/api/x", nil))
		if rr.Code != http.StatusNoContent {
			t.Fatalf("status = %d", rr.Code)
		}
	})

	cases := []struct {
		name   string
		setup  func(r *http.Request)
		status int
	}{
		{"missing", func(r *http.Request) {}, http.StatusUnauthorized},
		{"wrong", func(r *http.Request) { r.Header.Set("Authorization", "Bearer nope") }, http.StatusUnauthorized},
		{"bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer s3cret") }, http.StatusNoContent},
		{"bearer case-insensitive", func(r *http.Request) { r.Header.Set("Authorization", "bearer s3cret") }, http.StatusNoContent},
		{"x-auth-token", func(r *http.Request) { r.Header.Set("X-Auth-Token", "s3cret") }, http.StatusNoContent},
		{"query", func(r *http.Request) { r.URL.RawQuery = "token=s3cret" }, http.StatusNoContent},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/x", nil)
			c.setup(req)
			rr := httptest.NewRecorder()
			RequireToken("s3cret")(ok).ServeHTTP(rr, req)
			if rr.Code != c.status {
				t.Fatalf("status = %d, want %d", rr.Code, c.status)
			}
		})
	}
}
