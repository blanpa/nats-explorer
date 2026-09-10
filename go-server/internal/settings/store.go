// Package settings persists the UI state of a single-user installation (the
// desktop app, or a server started with STORAGE_DIR) in the OS config
// directory instead of the browser's local storage. Entries mirror the
// browser keys (ne.*) so the UI can hydrate its local storage from them.
// Connection credentials are split off into a SecretStore.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
)

const (
	ConnectionsKey = "ne.connections.v2"
	fileName       = "settings.json"
	secretPrefix   = "conn:"
)

// secretFields are removed from saved connections before they hit settings.json.
var secretFields = []string{"token", "pass", "nkeySeed", "creds", "tlsKey", "sysToken", "sysPass", "sysNkeySeed", "sysCreds"}

var keyPattern = regexp.MustCompile(`^ne\.[A-Za-z0-9_.-]{1,64}$`)

type document struct {
	Version int                        `json:"version"`
	Entries map[string]json.RawMessage `json:"entries"`
}

type Store struct {
	mu      sync.Mutex
	dir     string
	path    string
	doc     document
	secrets SecretStore
}

// Open loads (or creates) <dir>/settings.json.
func Open(dir string, secrets SecretStore) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("settings dir: %w", err)
	}
	s := &Store{dir: dir, path: filepath.Join(dir, fileName), secrets: secrets, doc: document{Version: 1, Entries: map[string]json.RawMessage{}}}
	data, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &s.doc); err != nil {
			return nil, fmt.Errorf("%s: %w", s.path, err)
		}
	}
	if s.doc.Entries == nil {
		s.doc.Entries = map[string]json.RawMessage{}
	}
	return s, nil
}

func (s *Store) Dir() string         { return s.dir }
func (s *Store) Path() string        { return s.path }
func (s *Store) SecretsName() string { return s.secrets.Name() }

// All returns every entry with connection secrets merged back in.
func (s *Store) All() (map[string]json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]json.RawMessage, len(s.doc.Entries))
	for k, v := range s.doc.Entries {
		out[k] = v
	}
	if raw, ok := out[ConnectionsKey]; ok {
		merged, err := s.mergeSecrets(raw)
		if err != nil {
			return nil, err
		}
		out[ConnectionsKey] = merged
	}
	return out, nil
}

// Get returns one raw entry. Connection secrets are not merged back in --
// All does that; this is for server-side settings that live in the same file.
func (s *Store) Get(key string) (json.RawMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.doc.Entries[key]
	return v, ok
}

// Set stores one entry. Values must be valid JSON.
func (s *Store) Set(key string, value json.RawMessage) error {
	if !keyPattern.MatchString(key) {
		return fmt.Errorf("invalid settings key %q", key)
	}
	if !json.Valid(value) {
		return fmt.Errorf("value for %s is not valid JSON", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if key == ConnectionsKey {
		stripped, err := s.splitSecrets(value)
		if err != nil {
			return err
		}
		value = stripped
	}
	s.doc.Entries[key] = value
	return s.save()
}

func (s *Store) Delete(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if key == ConnectionsKey {
		for _, id := range s.connectionIDs(s.doc.Entries[key]) {
			if err := s.secrets.Delete(secretPrefix + id); err != nil {
				return err
			}
		}
	}
	delete(s.doc.Entries, key)
	return s.save()
}

func (s *Store) save() error {
	data, err := json.MarshalIndent(s.doc, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, append(data, '\n'), 0o600)
}

type connection = map[string]json.RawMessage

func parseConnections(raw json.RawMessage) ([]connection, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var conns []connection
	if err := json.Unmarshal(raw, &conns); err != nil {
		return nil, fmt.Errorf("connections must be a JSON array of objects: %w", err)
	}
	return conns, nil
}

func idOf(c connection) string {
	var id string
	if raw, ok := c["id"]; ok {
		_ = json.Unmarshal(raw, &id)
	}
	return id
}

func (s *Store) connectionIDs(raw json.RawMessage) []string {
	conns, _ := parseConnections(raw)
	ids := make([]string, 0, len(conns))
	for _, c := range conns {
		if id := idOf(c); id != "" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// splitSecrets moves credential fields into the secret store and returns the
// connections without them. Secrets of removed connections are deleted.
func (s *Store) splitSecrets(raw json.RawMessage) (json.RawMessage, error) {
	conns, err := parseConnections(raw)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, c := range conns {
		id := idOf(c)
		if id == "" {
			continue
		}
		seen[id] = true
		secrets := map[string]json.RawMessage{}
		for _, f := range secretFields {
			if v, ok := c[f]; ok {
				var str string
				if json.Unmarshal(v, &str) == nil && str == "" {
					delete(c, f) // empty credential: nothing to keep
					continue
				}
				secrets[f] = v
				delete(c, f)
			}
		}
		if len(secrets) == 0 {
			if err := s.secrets.Delete(secretPrefix + id); err != nil {
				return nil, err
			}
			continue
		}
		data, _ := json.Marshal(secrets)
		if err := s.secrets.Set(secretPrefix+id, string(data)); err != nil {
			return nil, fmt.Errorf("storing credentials: %w", err)
		}
	}
	for _, id := range s.connectionIDs(s.doc.Entries[ConnectionsKey]) {
		if !seen[id] {
			if err := s.secrets.Delete(secretPrefix + id); err != nil {
				return nil, err
			}
		}
	}
	if conns == nil {
		conns = []connection{}
	}
	return json.Marshal(conns)
}

func (s *Store) mergeSecrets(raw json.RawMessage) (json.RawMessage, error) {
	conns, err := parseConnections(raw)
	if err != nil {
		return nil, err
	}
	for _, c := range conns {
		id := idOf(c)
		if id == "" {
			continue
		}
		data, ok, err := s.secrets.Get(secretPrefix + id)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		var secrets map[string]json.RawMessage
		if err := json.Unmarshal([]byte(data), &secrets); err != nil {
			continue // unreadable secret: leave the connection without credentials
		}
		for k, v := range secrets {
			c[k] = v
		}
	}
	if conns == nil {
		conns = []connection{}
	}
	return json.Marshal(conns)
}
