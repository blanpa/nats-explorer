package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A context directory becomes a list of connections: the files a context
// names are read in, what cannot be read is named, and a server without
// the opt-in offers nothing.
func TestServerContexts(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "ops.creds"), []byte("-----BEGIN NATS USER JWT-----\nabc\n------END NATS USER JWT------\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "seed.nk"), []byte("# a seed\nSUACSSJ3CTLSKPXY2BUHQXAXU5R37XYQ6QZWWQOS6D7VDSP7UWIU2WDUE\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "prod.json"), []byte(`{"url":"tls://a:4222,tls://b:4222","creds":"ops.creds","jetstream_domain":"hub","description":"production"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "lab.json"), []byte(`{"url":"nats://lab:4222","user":"u","password":"p","tls_first":true}`), 0o644)
	os.WriteFile(filepath.Join(dir, "keyed.json"), []byte(`{"url":"nats://k:4222","nkey":"seed.nk"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "broken.json"), []byte(`{"url":"nats://x:4222","creds":"missing.creds"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(`ignored`), 0o644)

	t.Setenv("NATS_CONTEXTS_DIR", dir)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	var res struct {
		Available bool              `json:"available"`
		Contexts  []importedContext `json:"contexts"`
	}
	if st := api.do("GET", "/api/contexts", nil, &res); st != 200 || !res.Available || len(res.Contexts) != 4 {
		t.Fatalf("contexts: %d %+v", st, res)
	}
	byName := map[string]importedContext{}
	for _, c := range res.Contexts {
		byName[c.Name] = c
	}
	prod := byName["prod"]
	if prod.AuthMethod != "jwt" || prod.Creds == "" || !prod.TLS || len(prod.Servers) != 2 || prod.JSDomain != "hub" || prod.Description != "production" {
		t.Fatalf("prod = %+v", prod)
	}
	if lab := byName["lab"]; lab.AuthMethod != "userpass" || lab.User != "u" || lab.Pass != "p" || !lab.TLSFirst || lab.TLS {
		t.Fatalf("lab = %+v", lab)
	}
	if keyed := byName["keyed"]; keyed.AuthMethod != "nkey" || keyed.NKeySeed[:2] != "SU" {
		t.Fatalf("keyed = %+v", keyed)
	}
	if broken := byName["broken"]; broken.AuthMethod != "none" || len(broken.Problems) != 1 {
		t.Fatalf("broken = %+v", broken)
	}

	// Without the opt-in a server offers nothing, whatever is on disk.
	t.Setenv("NATS_CONTEXTS_DIR", "")
	srv2 := newTestServer(t, serverConfig{})
	api2 := &apiClient{t: t, base: srv2.URL}
	if st := api2.do("GET", "/api/contexts", nil, &res); st != 200 || res.Available {
		t.Fatalf("a server without the opt-in offered contexts: %d %+v", st, res)
	}
}
