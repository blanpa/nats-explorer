package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type memSecrets struct{ m map[string]string }

func (m *memSecrets) Get(k string) (string, bool, error) { v, ok := m.m[k]; return v, ok, nil }
func (m *memSecrets) Set(k, v string) error              { m.m[k] = v; return nil }
func (m *memSecrets) Delete(k string) error              { delete(m.m, k); return nil }
func (m *memSecrets) Name() string                       { return "mem" }

func TestStoreRoundTripAndSecretSplit(t *testing.T) {
	dir := t.TempDir()
	sec := &memSecrets{m: map[string]string{}}
	s, err := Open(dir, sec)
	if err != nil {
		t.Fatal(err)
	}
	conns := `[{"id":"a","name":"A","authMethod":"token","token":"t0p","tlsCert":"CERT","tlsKey":"KEY"},{"id":"b","name":"B","pass":""}]`
	if err := s.Set(ConnectionsKey, json.RawMessage(conns)); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("ne.theme", json.RawMessage(`"dark"`)); err != nil {
		t.Fatal(err)
	}

	// The file on disk carries no credentials.
	data, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	for _, secret := range []string{"t0p", "KEY"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("settings.json leaks %q:\n%s", secret, data)
		}
	}
	if !strings.Contains(string(data), "CERT") {
		t.Error("the client certificate is not secret and should stay in the file")
	}
	if _, ok := sec.m["conn:a"]; !ok {
		t.Fatal("secrets for a not stored")
	}
	if _, ok := sec.m["conn:b"]; ok {
		t.Fatal("empty credentials must not create a secret entry")
	}

	// Reading back merges them again, even after a fresh Open.
	s2, err := Open(dir, sec)
	if err != nil {
		t.Fatal(err)
	}
	all, err := s2.All()
	if err != nil {
		t.Fatal(err)
	}
	var back []map[string]any
	if err := json.Unmarshal(all[ConnectionsKey], &back); err != nil {
		t.Fatal(err)
	}
	if back[0]["token"] != "t0p" || back[0]["tlsKey"] != "KEY" || back[0]["tlsCert"] != "CERT" || back[0]["name"] != "A" {
		t.Fatalf("merged connection = %v", back[0])
	}
	if string(all["ne.theme"]) != `"dark"` {
		t.Errorf("theme = %s", all["ne.theme"])
	}

	// Removing a connection removes its secret.
	if err := s2.Set(ConnectionsKey, json.RawMessage(`[{"id":"b","name":"B"}]`)); err != nil {
		t.Fatal(err)
	}
	if _, ok := sec.m["conn:a"]; ok {
		t.Fatal("stale secret for a must be deleted")
	}
	if err := s2.Delete(ConnectionsKey); err != nil {
		t.Fatal(err)
	}
	if len(sec.m) != 0 {
		t.Fatalf("secrets left after delete: %v", sec.m)
	}
}

func TestStoreRejectsBadInput(t *testing.T) {
	s, _ := Open(t.TempDir(), &memSecrets{m: map[string]string{}})
	if err := s.Set("evil/../key", json.RawMessage(`1`)); err == nil {
		t.Error("key outside ne.* must be rejected")
	}
	if err := s.Set("ne.x", json.RawMessage(`{not json`)); err == nil {
		t.Error("invalid JSON must be rejected")
	}
	if err := s.Set(ConnectionsKey, json.RawMessage(`{"not":"an array"}`)); err == nil {
		t.Error("connections must be an array")
	}
}

func TestFileSecretsPermissions(t *testing.T) {
	dir := t.TempDir()
	f := newFileSecrets(dir)
	if err := f.Set("conn:x", `{"token":"s"}`); err != nil {
		t.Fatal(err)
	}
	v, ok, err := f.Get("conn:x")
	if err != nil || !ok || v != `{"token":"s"}` {
		t.Fatalf("get = %q %v %v", v, ok, err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(filepath.Join(dir, "secrets.json"))
		if info.Mode().Perm() != 0o600 {
			t.Errorf("secrets.json mode = %o, want 600", info.Mode().Perm())
		}
	}
	if err := f.Delete("conn:x"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := f.Get("conn:x"); ok {
		t.Error("deleted secret still readable")
	}
	if _, ok, _ := f.Get("missing"); ok {
		t.Error("missing key reported as present")
	}
}

func TestSecretStoreFallsBackToFile(t *testing.T) {
	if NewSecretStore(t.TempDir(), false).Name() != "file" {
		t.Fatal("keyring disabled must yield the file store")
	}
}
