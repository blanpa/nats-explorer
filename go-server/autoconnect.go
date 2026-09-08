package main

import (
	"encoding/json"
	"log"
	"time"

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

// autoConnectSaved opens every saved connection flagged "connect at start".
// It runs in the background so a slow or unreachable server never delays
// the start of the UI.
func autoConnectSaved(store *settings.Store, connect func(cfg connection.Config) error) {
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
		if !sc.AutoConnect {
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
		if err := connect(cfg); err != nil {
			log.Printf("auto-connect %q: %v", cfg.Name, err)
			continue
		}
		log.Printf("auto-connect %q: connected in %s", cfg.Name, time.Since(started).Round(time.Millisecond))
	}
}
