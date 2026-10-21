package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// When the desktop app restarts into another version, the connections it
// had open open again in the new one: their ids go into a small file next
// to the settings, which the next start reads once. Only saved connections
// come back. An unsaved one exists nowhere but in the process that closed,
// and its credentials are not written to disk for this.

const reopenFile = "reopen.json"

// reopenFresh is how old the note may be. A restart that did not happen
// then -- the new version did not start, and was started by hand the next
// day -- does not open connections out of nowhere.
const reopenFresh = 10 * time.Minute

type reopenNote struct {
	At          time.Time `json:"at"`
	Connections []string  `json:"connections"`
}

// noteReopen writes down the connections to open on the next start.
func noteReopen(dir string, ids []string, now time.Time) error {
	data, err := json.Marshal(reopenNote{At: now, Connections: ids})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, reopenFile), data, 0o600)
}

// takeReopen reads the note once and removes it.
func takeReopen(dir string, now time.Time) []string {
	path := filepath.Join(dir, reopenFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	os.Remove(path)
	var n reopenNote
	if json.Unmarshal(data, &n) != nil || now.Sub(n.At) > reopenFresh || n.At.After(now.Add(time.Minute)) {
		return nil
	}
	return n.Connections
}
