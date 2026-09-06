package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"
)

// SecretStore keeps credentials out of the plain settings file.
type SecretStore interface {
	Get(key string) (value string, ok bool, err error)
	Set(key, value string) error
	Delete(key string) error
	// Name is reported to the UI: "keyring" or "file".
	Name() string
}

const keyringService = "nats-explorer"

// keyringSecrets uses the OS credential store (Secret Service on Linux,
// Keychain on macOS, Credential Manager on Windows).
type keyringSecrets struct{}

func (keyringSecrets) Get(key string) (string, bool, error) {
	v, err := keyring.Get(keyringService, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}
func (keyringSecrets) Set(key, value string) error { return keyring.Set(keyringService, key, value) }
func (keyringSecrets) Delete(key string) error {
	err := keyring.Delete(keyringService, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
func (keyringSecrets) Name() string { return "keyring" }

// fileSecrets is the fallback: a JSON file readable only by the user.
type fileSecrets struct {
	mu   sync.Mutex
	path string
}

func newFileSecrets(dir string) *fileSecrets {
	return &fileSecrets{path: filepath.Join(dir, "secrets.json")}
}

func (f *fileSecrets) load() (map[string]string, error) {
	m := map[string]string{}
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return m, nil
	}
	return m, json.Unmarshal(data, &m)
}

func (f *fileSecrets) save(m map[string]string) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(f.path, data, 0o600)
}

func (f *fileSecrets) Get(key string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return "", false, err
	}
	v, ok := m[key]
	return v, ok, nil
}

func (f *fileSecrets) Set(key, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return err
	}
	m[key] = value
	return f.save(m)
}

func (f *fileSecrets) Delete(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return err
	}
	if _, ok := m[key]; !ok {
		return nil
	}
	delete(m, key)
	return f.save(m)
}
func (f *fileSecrets) Name() string { return "file" }

// NewSecretStore prefers the OS keyring and falls back to secrets.json when
// no keyring is reachable (headless Linux, containers) or when disabled.
func NewSecretStore(dir string, allowKeyring bool) SecretStore {
	if allowKeyring && keyringUsable() {
		return keyringSecrets{}
	}
	return newFileSecrets(dir)
}

// keyringUsable writes and removes a probe entry; any failure means fallback.
func keyringUsable() bool {
	const probe = "probe"
	if err := keyring.Set(keyringService, probe, "ok"); err != nil {
		return false
	}
	v, err := keyring.Get(keyringService, probe)
	_ = keyring.Delete(keyringService, probe)
	return err == nil && v == "ok"
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
