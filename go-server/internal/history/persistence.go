package history

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"nats-explorer/internal/filter"
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
	// filterExpr is the CEL expression deciding what is written to disk;
	// empty keeps everything.
	filterExpr string
	// queueBytes is how much of a burst the writer buffers. It is the knob
	// that decides whether a burst reaches the database at all, so it
	// belongs next to the setting that switches the database on.
	queueBytes int64
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

	// MinQueueBytes still holds a batch; MaxQueueBytes is where buffering a
	// burst turns into holding the whole burst in memory, which is the
	// problem the database was there to solve.
	MinQueueBytes = 1 << 20
	MaxQueueBytes = 2 << 30
)

// PersistenceConfig is the stored choice.
type PersistenceConfig struct {
	Enabled   bool   `json:"enabled"`
	Retention string `json:"retention"`
	// FullText fills the word index. Absent in an older stored choice, which
	// is why it is a pointer: the default is on, not off.
	FullText *bool `json:"fullText,omitempty"`
	// Filter decides what is written to disk; empty keeps everything.
	Filter string `json:"filter,omitempty"`
	// QueueBytes is the writer's buffer; 0 means the default.
	QueueBytes int64 `json:"queueBytes,omitempty"`
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
	// Filter is the expression deciding what is written to disk. Empty
	// keeps everything, which is what an installation that never set one
	// does.
	Filter string `json:"filter"`
	// QueueBytes is how much of a burst the writer buffers before it starts
	// dropping, and MaxQueueBytes what it may be raised to.
	QueueBytes    int64 `json:"queueBytes"`
	MaxQueueBytes int64 `json:"maxQueueBytes"`
	// DB is the size of the database, when one is open.
	DB *DBStats `json:"db,omitempty"`
}

// PersistenceOptions configures the controller. Enabled and Retention are
// the state to start in; a stored choice is applied by the caller first.
type PersistenceOptions struct {
	Path       string
	Retention  time.Duration
	Managed    bool
	Enabled    bool
	FullText   bool
	Filter     string
	QueueBytes int64
	Save       func(PersistenceConfig) error
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
	// A stored expression that no longer compiles is dropped rather than
	// refused: the alternative is a server that will not start because of a
	// filter someone typed weeks ago.
	if c.Filter != "" {
		if _, err := filter.Compile(c.Filter); err == nil {
			o.Filter = c.Filter
		}
	}
	if c.QueueBytes >= MinQueueBytes && c.QueueBytes <= MaxQueueBytes {
		o.QueueBytes = c.QueueBytes
	}
}

// NewPersistence builds the controller and opens the database when the
// options ask for it. An error means the database could not be opened; the
// controller is usable either way and reports the history as memory-only.
func NewPersistence(tee *Tee, o PersistenceOptions) (*Persistence, error) {
	if o.Retention <= 0 {
		o.Retention = DefaultRetention
	}
	if o.QueueBytes < MinQueueBytes || o.QueueBytes > MaxQueueBytes {
		o.QueueBytes = DefaultQueueBytes
	}
	p := &Persistence{tee: tee, path: o.Path, managed: o.Managed, retention: o.Retention,
		fullText: o.FullText, filterExpr: o.Filter, queueBytes: o.QueueBytes, save: o.Save}
	if err := p.applyFilter(o.Filter); err != nil {
		p.filterExpr = ""
		return p, err
	}
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
	db.SetQueueBytes(o.QueueBytes)
	tee.SetDB(db)
	return p, nil
}

// applyFilter compiles the expression and installs it; an empty one removes
// the filter, so the database goes back to keeping everything.
func (p *Persistence) applyFilter(expr string) error {
	if strings.TrimSpace(expr) == "" {
		p.tee.SetPersistFilter(nil)
		return nil
	}
	prg, err := filter.Compile(expr)
	if err != nil {
		return fmt.Errorf("persist filter: %w", err)
	}
	p.tee.SetPersistFilter(prg)
	return nil
}

// Status reports what the UI needs to render the setting.
func (p *Persistence) Status() PersistenceStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := PersistenceStatus{
		Supported:     p.path != "",
		Managed:       p.managed,
		Path:          p.path,
		Retention:     p.retention.String(),
		FullText:      p.fullText,
		Filter:        p.filterExpr,
		QueueBytes:    p.queueBytes,
		MaxQueueBytes: MaxQueueBytes,
	}
	if !st.Supported {
		st.Reason = "this installation keeps its state in the browser; start the server with STORAGE_DIR or HISTORY_DB to persist the history"
	}
	if db := p.tee.DB(); db != nil {
		st.Enabled = true
		st.Retention = db.Retention().String()
		st.FullText = db.FullText()
		st.QueueBytes = db.QueueBytesLimit()
		s := db.Stats()
		st.DB = &s
	}
	return st
}

// ErrManaged is returned when the environment owns the setting.
var ErrManaged = errors.New("the persistent history is configured by HISTORY_DB and cannot be changed from the UI")

// ErrUnsupported is returned when there is nowhere to put the database.
var ErrUnsupported = errors.New("this installation has no place for a history database")

// PersistenceRequest is one change to the setting. It is a struct rather
// than a row of booleans because it kept growing: what is written, how long
// it is kept, whether it is indexed, and how much of a burst is buffered
// are four separate answers to "what should the disk copy cost".
type PersistenceRequest struct {
	Enabled   bool
	Retention time.Duration
	FullText  bool
	// Filter decides what is written; empty keeps everything.
	Filter string
	// QueueBytes is the writer's buffer; 0 keeps the current one.
	QueueBytes int64
	// Purge deletes the file when switching off, so the payloads really go.
	Purge bool
}

// Set turns the database on or off, changes the retention, the word index,
// the persist filter and the writer's buffer. With Purge the file is deleted
// as well, so switching it off can really remove the payloads instead of
// leaving them on disk.
func (p *Persistence) Set(req PersistenceRequest) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if req.QueueBytes == 0 {
		req.QueueBytes = p.queueBytes
	}
	switch {
	case p.managed:
		return ErrManaged
	case p.path == "":
		return ErrUnsupported
	case req.Retention < MinRetention || req.Retention > MaxRetention:
		return fmt.Errorf("retention must be between %s and %s", MinRetention, MaxRetention)
	case req.QueueBytes < MinQueueBytes || req.QueueBytes > MaxQueueBytes:
		return fmt.Errorf("the write buffer must be between %s and %s", formatBytes(MinQueueBytes), formatBytes(MaxQueueBytes))
	}
	// The filter is compiled before anything is opened or closed: a typo
	// should leave the setting as it was, not switch the database off.
	if err := p.applyFilter(req.Filter); err != nil {
		return err
	}
	p.retention = req.Retention
	p.fullText = req.FullText
	p.filterExpr = strings.TrimSpace(req.Filter)
	p.queueBytes = req.QueueBytes
	switch db := p.tee.DB(); {
	case req.Enabled && db == nil:
		opened, err := OpenDB(p.path, req.Retention)
		if err != nil {
			return fmt.Errorf("history db %s: %w", p.path, err)
		}
		if err := opened.SetFullText(req.FullText); err != nil {
			opened.Close()
			return err
		}
		opened.SetQueueBytes(req.QueueBytes)
		p.tee.SetDB(opened)
	case req.Enabled:
		db.SetRetention(req.Retention)
		db.SetQueueBytes(req.QueueBytes)
		// Rebuilding or emptying the index can take a moment on a large
		// database; it happens while messages keep being recorded.
		if err := db.SetFullText(req.FullText); err != nil {
			return err
		}
	case db != nil:
		p.tee.SetDB(nil)
		if err := db.Close(); err != nil {
			return err
		}
	}
	if req.Purge && !req.Enabled {
		if err := removeDB(p.path); err != nil {
			return err
		}
	}
	if p.save != nil {
		fullText := req.FullText
		return p.save(PersistenceConfig{
			Enabled:    req.Enabled,
			Retention:  req.Retention.String(),
			FullText:   &fullText,
			Filter:     p.filterExpr,
			QueueBytes: req.QueueBytes,
		})
	}
	return nil
}

// formatBytes renders a budget the way the message about it reads best.
func formatBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%d GB", n>>30)
	case n >= 1<<20:
		return fmt.Sprintf("%d MB", n>>20)
	default:
		return fmt.Sprintf("%d bytes", n)
	}
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
