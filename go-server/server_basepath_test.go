package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func indexFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":     &fstest.MapFile{Data: []byte("<!doctype html>\n<html>\n  <head>\n    <title>x</title>\n  </head>\n  <body></body>\n</html>")},
		"assets/app.js":  &fstest.MapFile{Data: []byte("console.log(1)")},
		"favicon.ico":    &fstest.MapFile{Data: []byte("icon")},
		"nested/deep.js": &fstest.MapFile{Data: []byte("deep")},
	}
}

func get(t *testing.T, base, path string) (int, string) {
	t.Helper()
	res, err := http.Get(base + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

func TestNormalizeBasePath(t *testing.T) {
	for in, want := range map[string]string{"": "", "/": "", "nats": "/nats", "/nats": "/nats", "/nats/": "/nats", " /a/b/ ": "/a/b"} {
		if got := normalizeBasePath(in); got != want {
			t.Errorf("normalizeBasePath(%q) = %q, want %q", in, got, want)
		}
	}
}

// Behind a proxy that does not strip the prefix, everything the server
// answers carries it: the API, the websocket route, the assets and the SPA
// fallback. The UI learns the prefix from the base href, so one build works
// at the root and under a subpath.
func TestServerUnderBasePath(t *testing.T) {
	app := createServer(indexFS(), serverConfig{basePath: "/nats"})
	t.Cleanup(app.Close)
	srv := httptest.NewServer(app)
	defer srv.Close()

	code, body := get(t, srv.URL, "/nats/")
	if code != 200 || !strings.Contains(body, `<base href="/nats/" />`) {
		t.Fatalf("index under the prefix = %d, %q", code, body)
	}
	// A deep link into the SPA gets the same document.
	if code, body := get(t, srv.URL, "/nats/subjects/anything"); code != 200 || !strings.Contains(body, `<base href="/nats/"`) {
		t.Fatalf("SPA fallback = %d, %q", code, body)
	}
	if code, body := get(t, srv.URL, "/nats/assets/app.js"); code != 200 || body != "console.log(1)" {
		t.Fatalf("asset = %d, %q", code, body)
	}
	var app2 struct{ Mode string }
	if code, body := get(t, srv.URL, "/nats/api/app"); code != 200 || !strings.Contains(body, `"mode"`) {
		t.Fatalf("api under the prefix = %d, %q", code, body)
	}
	_ = app2

	// The bare prefix goes to its trailing-slash form, or relative assets
	// would resolve one level too high.
	res, err := http.DefaultTransport.RoundTrip(mustRequest(t, srv.URL+"/nats"))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMovedPermanently || res.Header.Get("Location") != "/nats/" {
		t.Fatalf("bare prefix = %d, Location %q", res.StatusCode, res.Header.Get("Location"))
	}

	// Nothing answers at the root any more; that is the proxy's business.
	if code, _ := get(t, srv.URL, "/api/app"); code != 404 {
		t.Fatalf("the API must not answer outside the prefix, got %d", code)
	}
}

// Without a prefix the base href still says "/", so the UI has one rule.
func TestServerWithoutBasePathStillSetsBase(t *testing.T) {
	app := createServer(indexFS(), serverConfig{})
	t.Cleanup(app.Close)
	srv := httptest.NewServer(app)
	defer srv.Close()

	if code, body := get(t, srv.URL, "/"); code != 200 || !strings.Contains(body, `<base href="/" />`) {
		t.Fatalf("index = %d, %q", code, body)
	}
	if code, _ := get(t, srv.URL, "/api/app"); code != 200 {
		t.Fatalf("api at the root = %d", code)
	}
}

func mustRequest(t *testing.T, url string) *http.Request {
	t.Helper()
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}
