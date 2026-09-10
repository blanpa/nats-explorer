package main

import (
	"encoding/json"
	"log"

	"nats-explorer/internal/history"
)

// openHistoryDB builds the controller for the SQLite copy of the history and
// opens the database when it is switched on. The choice comes from three
// places, in order: HISTORY_DB (the environment owns it and the UI cannot
// change it), the settings file of a desktop app or STORAGE_DIR server, and
// otherwise the default for the installation -- on for the desktop app,
// where a restart would else empty the history, off for a server.
func openHistoryDB(tee *history.Tee, cfg serverConfig) *history.Persistence {
	opts := history.PersistenceOptions{
		Path:      cfg.historyDB,
		Retention: cfg.historyRetention,
		Managed:   cfg.historyManaged,
		Enabled:   cfg.historyDB != "" && (cfg.historyManaged || cfg.historyOn),
		// The word index is on unless a stored choice or the environment
		// says otherwise: searching is what most installations want, and
		// the ones recording a firehose can trade it for write throughput.
		FullText:   !cfg.historyNoFullText,
		Filter:     cfg.historyFilter,
		QueueBytes: cfg.historyQueueBytes,
	}
	if cfg.settings != nil && !cfg.historyManaged {
		if raw, ok := cfg.settings.Get(history.SettingsKey); ok {
			opts.ParseConfig(raw)
		}
		opts.Save = func(c history.PersistenceConfig) error {
			data, err := json.Marshal(c)
			if err != nil {
				return err
			}
			return cfg.settings.Set(history.SettingsKey, data)
		}
	}
	p, err := history.NewPersistence(tee, opts)
	switch {
	case err != nil && cfg.historyManaged:
		// HISTORY_DB is an explicit instruction: not being able to follow it
		// is a configuration error, not something to carry on without.
		log.Fatalf("%v", err)
	case err != nil:
		log.Printf("Persistent history stays off: %v", err)
	case tee.DB() != nil:
		log.Printf("Persistent history in %s (retention %s)", cfg.historyDB, tee.DB().Retention())
		if expr := tee.PersistFilter(); expr != "" {
			log.Printf("Persisting only messages matching %s", expr)
		}
	}
	return p
}
