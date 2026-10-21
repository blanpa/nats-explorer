package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/settings"
)

func TestReopenNote(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if err := noteReopen(dir, []string{"a", "b"}, now); err != nil {
		t.Fatal(err)
	}
	if got := takeReopen(dir, now.Add(5*time.Second)); fmt.Sprint(got) != "[a b]" {
		t.Fatalf("takeReopen = %v", got)
	}
	if got := takeReopen(dir, now); got != nil {
		t.Fatalf("read twice: %v", got)
	}
	noteReopen(dir, []string{"a"}, now)
	if got := takeReopen(dir, now.Add(time.Hour)); got != nil {
		t.Fatalf("a stale note was followed: %v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, reopenFile)); !os.IsNotExist(err) {
		t.Fatalf("a stale note was kept: %v", err)
	}
}

// After a restart for an update the connections that were open come back,
// next to those flagged to open at start; the others stay closed.
func TestAutoConnectReopens(t *testing.T) {
	dir := t.TempDir()
	store, err := settings.Open(dir, settings.NewSecretStore(dir, false))
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := json.Marshal([]map[string]any{
		{"id": "flagged", "name": "flagged", "servers": []string{"nats://x:4222"}, "autoConnect": true},
		{"id": "was-open", "name": "was-open", "servers": []string{"nats://x:4222"}},
		{"id": "closed", "name": "closed", "servers": []string{"nats://x:4222"}},
	})
	if err := store.Set(settings.ConnectionsKey, saved); err != nil {
		t.Fatal(err)
	}
	var opened []string
	autoConnectSaved(store, []string{"was-open", "not-saved"}, func(c connection.Config) error {
		opened = append(opened, c.ID)
		return nil
	})
	sort.Strings(opened)
	if fmt.Sprint(opened) != "[flagged was-open]" {
		t.Fatalf("opened %v", opened)
	}
}
