package main

import (
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/settings"
)

// savedConnection is what the UI stores under ne.connections.v2, with the
// credentials merged back in by the settings store. The Config fields share
// their JSON names with the browser's saved shape.
type savedConnection struct {
	connection.Config
	AutoConnect bool            `json:"autoConnect"`
	SysTopics   map[string]bool `json:"sysTopics"`
}

// systemTopicSubjects mirrors SYSTEM_TOPICS in the client.
var systemTopicSubjects = map[string]string{"sys": "$SYS.>", "js": "$JS.>", "kv": "$KV.>", "srv": "$SRV.>"}

// autoConnectSaved opens every saved connection flagged "connect at start",
// and those named in reopen. It runs in the background so a slow or
// unreachable server never delays the start of the UI.
func autoConnectSaved(store *settings.Store, reopen []string, connect func(cfg connection.Config) error) {
	again := map[string]bool{}
	for _, id := range reopen {
		again[id] = true
	}
	entries, err := store.All()
	if err != nil {
		log.Printf("auto-connect: cannot read settings: %v", err)
		return
	}
	raw, ok := entries[settings.ConnectionsKey]
	if !ok {
		return
	}
	var saved []savedConnection
	if err := json.Unmarshal(raw, &saved); err != nil {
		log.Printf("auto-connect: saved connections unreadable: %v", err)
		return
	}
	for _, sc := range saved {
		if !sc.AutoConnect && !again[sc.ID] {
			continue
		}
		cfg := sc.Config
		if len(cfg.Subscriptions) == 0 {
			cfg.Subscriptions = []string{">"}
		}
		for key, on := range sc.SysTopics {
			if subj, known := systemTopicSubjects[key]; on && known {
				cfg.Subscriptions = append(cfg.Subscriptions, subj)
			}
		}
		started := time.Now()
		err := connect(cfg)
		// The explorer may start before NATS does, in a pod or a compose
		// file: a server that is not there yet is waited for. One that
		// answers and says no -- a wrong password, a TLS mismatch -- is
		// not: retrying would hide the answer behind "reconnecting".
		if unreachable(err) {
			log.Printf("auto-connect %q: %v; trying in the background until it answers", cfg.Name, err)
			cfg.Retry = true
			err = connect(cfg)
		}
		if err != nil {
			log.Printf("auto-connect %q: %v", cfg.Name, err)
			continue
		}
		log.Printf("auto-connect %q: opened in %s", cfg.Name, time.Since(started).Round(time.Millisecond))
	}
}

// unreachable reports whether a connect failed for want of a server rather
// than because one turned it down.
func unreachable(err error) bool {
	return errors.Is(err, nats.ErrNoServers) || errors.Is(err, nats.ErrTimeout)
}
