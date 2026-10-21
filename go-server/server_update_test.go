package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"nats-explorer/internal/update"
)

// A server is not updated from its UI; it says so instead of offering it.
func TestServerUpdateNotOffered(t *testing.T) {
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	var st update.Status
	if code := api.do("GET", "/api/update", nil, &st); code != 200 || st.Supported || st.Reason == "" {
		t.Fatalf("GET /api/update = %d %+v", code, st)
	}
	if code := api.do("POST", "/api/update", nil, nil); code != http.StatusNotFound {
		t.Fatalf("POST /api/update = %d", code)
	}
}

// A page of another origin does not get to start an update of the desktop
// app; the app's own page does (and is told why this build has none).
func TestServerUpdateOnlyFromTheApp(t *testing.T) {
	srv := newTestServer(t, serverConfig{mode: "desktop", updater: update.New("dev")})
	post := func(origin string) (int, string) {
		req, _ := http.NewRequest("POST", srv.URL+"/api/update", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body struct {
			Error string `json:"error"`
		}
		json.NewDecoder(res.Body).Decode(&body)
		return res.StatusCode, body.Error
	}
	if code, _ := post("https://evil.example"); code != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", code)
	}
	if code, msg := post(srv.URL); code != http.StatusConflict || msg == "" {
		t.Fatalf("own origin: %d %q", code, msg)
	}
	if code, _ := post(""); code != http.StatusConflict {
		t.Fatalf("no origin: %d", code)
	}
	for _, path := range []string{"/api/update/rollback", "/api/update/restart"} {
		req, _ := http.NewRequest("POST", srv.URL+path, nil)
		req.Header.Set("Origin", "https://evil.example")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s from a foreign origin: %d", path, res.StatusCode)
		}
	}
}

// upload is a form with files, the way the settings send a release.
func upload(t *testing.T, files map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for name, content := range files {
		w, err := mw.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	mw.Close()
	return &body, mw.FormDataContentType()
}

func TestReadUpdateFiles(t *testing.T) {
	read := func(files map[string]string) (string, []byte, []byte, error) {
		body, ct := upload(t, files)
		req := httptest.NewRequest("POST", "/api/update/file", body)
		req.Header.Set("Content-Type", ct)
		pkg, sums, sig, err := readUpdateFiles(req)
		if pkg != "" {
			t.Cleanup(func() { os.Remove(pkg) })
		}
		return pkg, sums, sig, err
	}
	// Renamed by a browser that had downloaded them before: only the suffix counts.
	pkg, sums, sig, err := read(map[string]string{
		"nats-explorer-desktop-0.7.0-linux-x64 (1).tar.gz": "package",
		"SHA256SUMS (1).txt":     "sums",
		"SHA256SUMS.txt (1).sig": "sig",
	})
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(pkg); string(data) != "package" || string(sums) != "sums" || string(sig) != "sig" {
		t.Fatalf("package %q, sums %q, sig %q", data, sums, sig)
	}
	for missing, files := range map[string]map[string]string{
		"SHA256SUMS.txt.sig": {"a.zip": "p", "SHA256SUMS.txt": "s"},
		"SHA256SUMS.txt of":  {"a.zip": "p", "SHA256SUMS.txt.sig": "s"},
		"package":            {"SHA256SUMS.txt": "s", "SHA256SUMS.txt.sig": "s"},
		"one package":        {"a.zip": "p", "b.AppImage": "p", "SHA256SUMS.txt": "s", "SHA256SUMS.txt.sig": "s"},
	} {
		if _, _, _, err := read(files); err == nil || !strings.Contains(err.Error(), missing) {
			t.Errorf("%v: err = %v, want one about %q", files, err, missing)
		}
	}
}

// The upload goes through the same guard and the same checks as the download.
func TestServerUpdateFromFile(t *testing.T) {
	srv := newTestServer(t, serverConfig{mode: "desktop", updater: update.New("dev")})
	post := func(origin string, files map[string]string) (int, string) {
		body, ct := upload(t, files)
		req, _ := http.NewRequest("POST", srv.URL+"/api/update/file", body)
		req.Header.Set("Content-Type", ct)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out struct {
			Error string `json:"error"`
		}
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out.Error
	}
	all := map[string]string{"a.tar.gz": "p", "SHA256SUMS.txt": "s", "SHA256SUMS.txt.sig": "s"}
	if code, _ := post("https://evil.example", all); code != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", code)
	}
	if code, msg := post(srv.URL, map[string]string{"a.tar.gz": "p"}); code != http.StatusBadRequest || !strings.Contains(msg, "missing") {
		t.Fatalf("incomplete: %d %q", code, msg)
	}
	if code, msg := post(srv.URL, all); code != http.StatusUnprocessableEntity || !strings.Contains(msg, "development build") {
		t.Fatalf("development build: %d %q", code, msg)
	}

	plain := newTestServer(t, serverConfig{})
	if code := (&apiClient{t: t, base: plain.URL}).do("POST", "/api/update/file", nil, nil); code != http.StatusNotFound {
		t.Fatalf("server: %d", code)
	}
}
