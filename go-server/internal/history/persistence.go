package history

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// Persistence switches the SQLite copy of the history on and off while the
// server runs. Without it the history would only ever be a memory buffer
// that a restart empties, and the only way to keep it would be an
// environment variable -- which the desktop app has no way to set. It owns
// the database the Tee writes to, and stores the choice so it survives the
// next start.
//
// HISTORY_DB still wins: an installation configured by its environment is
// "managed" and the UI reports the state instead of changing it.
type Persistence struct {
	mu  sync.Mutex
	tee *Tee
	// path of the database file; empty when this installation has nowhere
	// to put one (a server without STORAGE_DIR keeps its state in the browser).
	path      string
	managed   bool
	retention time.Duration
	fullText  bool
	// save stores the choice for the next start; nil keeps it for this run only.
	save func(PersistenceConfig) error
}

// SettingsKey is where the choice is kept in the settings store.
const SettingsKey = "ne.historyDb.v1"

const (
	// MinRetention keeps a mistyped value from emptying the database on the
	// next cleanup tick; MaxRetention is well past what a message log needs.
	MinRetention     = time.Minute
	MaxRetention     = 365 * 24 * time.Hour
	DefaultRetention = 72 * time.Hour
)

// PersistenceConfig is the stored choice.
type PersistenceConfig struct {
	Enabled   bool   `json:"enabled"`
	Retention string `json:"retention"`
	// FullText fills the word index. Absent in an older stored choice, which
	// is why it is a pointer: the default is on, not off.
	FullText *bool `json:"fullText,omitempty"`
}

// PersistenceStatus is what the UI shows and edits.
type PersistenceStatus struct {
	// Supported is false when there is nowhere to put the file; Reason says why.
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	// Managed: HISTORY_DB decides, the UI only reports.
	Managed   bool   `json:"managed"`
	Enabled   bool   `json:"enabled"`
	Path      string `json:"path,omitempty"`
	Retention string `json:"retention"`
	// FullText: the word index behind the search over the persistent
	// history. It costs most of the write throughput, so it can be switched
	// off; searches then fall back to a scan.
	FullText bool `json:"fullText"`
	// DB is the size of the database, when one is open.
	DB *DBStats `json:"db,omitempty"`
}

// PersistenceOptions configures the controller. Enabled and Retention are
// the state to start in; a stored choice is applied by the caller first.
type PersistenceOptions struct {
	Path      string
	Retention time.Duration
	Managed   bool
	Enabled   bool
	FullText  bool
	Save      func(PersistenceConfig) error
}

// ParseConfig reads a stored choice over the defaults. An unreadable entry
// is ignored: a broken settings file should not stop the server.
func (o *PersistenceOptions) ParseConfig(raw json.RawMessage) {
	var c PersistenceConfig
	if json.Unmarshal(raw, &c) != nil {
		return
	}
	o.Enabled = c.Enabled
	if d, err := time.ParseDuration(c.Retention); err == nil && d >= MinRetention && d <= MaxRetention {
		o.Retention = d
	}
	if c.FullText != nil {
		o.FullText = *c.FullText
	}
}

// NewPersistence builds the controller and opens the database when the
// options ask for it. An error means the database could not be opened; the
// controller is usable either way and reports the history as memory-only.
func NewPersistence(tee *Tee, o PersistenceOptions) (*Persistence, error) {
	if o.Retention <= 0 {
		o.Retention = DefaultRetention
	}
	p := &Persistence{tee: tee, path: o.Path, managed: o.Managed, retention: o.Retention, fullText: o.FullText, save: o.Save}
	if !o.Enabled || o.Path == "" {
		return p, nil
	}
	db, err := OpenDB(o.Path, o.Retention)
	if err != nil {
		return p, fmt.Errorf("history db %s: %w", o.Path, err)
	}
	if err := db.SetFullText(o.FullText); err != nil {
		db.Close()
		return p, fmt.Errorf("history db %s: %w", o.Path, err)
	}
	tee.SetDB(db)
	return p, nil
}

// Status reports what the UI needs to render the setting.
func (p *Persistence) Status() PersistenceStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := PersistenceStatus{
		Supported: p.path != "",
		Managed:   p.managed,
		Path:      p.path,
		Retention: p.retention.String(),
		FullText:  p.fullText,
	}
	if !st.Supported {
		st.Reason = "this installation keeps its state in the browser; start the server with STORAGE_DIR or HISTORY_DB to persist the history"
	}
	if db := p.tee.DB(); db != nil {
		st.Enabled = true
		st.Retention = db.Retention().String()
		st.FullText = db.FullText()
		s := db.Stats()
		st.DB = &s
	}
	return st
}

// ErrManaged is returned when the environment owns the setting.
var ErrManaged = errors.New("the persistent history is configured by HISTORY_DB and cannot be changed from the UI")

// ErrUnsupported is returned when there is nowhere to put the database.
var ErrUnsupported = errors.New("this installation has no place for a history database")

// Set turns the database on or off and changes the retention. With purge the
// file is deleted as well, so switching it off can really remove the
// payloads instead of leaving them on disk.
func (p *Persistence) Set(enabled bool, retention time.Duration, fullText, purge bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case p.managed:
		return ErrManaged
	case p.path == "":
		return ErrUnsupported
	case retention < MinRetention || retention > MaxRetention:
		return fmt.Errorf("retention must be between %s and %s", MinRetention, MaxRetention)
	}
	p.retention = retention
	p.fullText = fullText
	switch db := p.tee.DB(); {
	case enabled && db == nil:
		opened, err := OpenDB(p.path, retention)
		if err != nil {
			return fmt.Errorf("history db %s: %w", p.path, err)
		}
		if err := opened.SetFullText(fullText); err != nil {
			opened.Close()
			return err
		}
		p.tee.SetDB(opened)
	case enabled:
		db.SetRetention(retention)
		// Rebuilding or emptying the index can take a moment on a large
		// database; it happens while messages keep being recorded.
		if err := db.SetFullText(fullText); err != nil {
			return err
		}
	case db != nil:
		p.tee.SetDB(nil)
		if err := db.Close(); err != nil {
			return err
		}
	}
	if purge && !enabled {
		if err := removeDB(p.path); err != nil {
			return err
		}
	}
	if p.save != nil {
		return p.save(PersistenceConfig{Enabled: enabled, Retention: retention.String(), FullText: &fullText})
	}
	return nil
}

// removeDB deletes the database and the files SQLite keeps beside it.
func removeDB(path string) error {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(path + suffix); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// Close detaches and closes the database, if one is open.
func (p *Persistence) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if db := p.tee.SetDB(nil); db != nil {
		return db.Close()
	}
	return nil
}
