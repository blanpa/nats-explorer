//go:build desktop

package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing/fstest"
	"time"

	"nats-explorer/internal/history"
	"nats-explorer/internal/settings"
	"nats-explorer/internal/update"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// "all:" keeps files whose names start with "_", which Vite emits
// (__vite-browser-external-*.js, imported by the decoders).
//
//go:embed all:frontend/dist
var embeddedAssets embed.FS

func main() {
	// Extract the frontend subdirectory from the embedded FS
	frontendFS, err := fs.Sub(embeddedAssets, "frontend/dist")
	if err != nil {
		log.Fatal("Failed to load embedded frontend:", err)
	}

	// Connections, templates and preferences live in the OS config directory
	// (~/.config, %AppData%, ~/Library/Application Support); credentials go
	// to the OS keyring when one is available.
	configDir, err := os.UserConfigDir()
	if err != nil {
		configDir = "."
	}
	storeDir := filepath.Join(configDir, "nats-explorer")
	store, err := settings.Open(storeDir, settings.NewSecretStore(storeDir, os.Getenv("NO_KEYRING") == ""))
	if err != nil {
		log.Fatalf("settings: %v", err)
	}
	log.Printf("NATS Explorer %s: settings in %s (secrets: %s)", version, store.Path(), store.SecretsName())
	// After a restart into another version, what was open opens again.
	reopen := takeReopen(storeDir, time.Now())
	if len(reopen) > 0 {
		log.Printf("NATS Explorer %s: reopening %d connections open before the restart", version, len(reopen))
	}

	// The update button closes the window through the Wails runtime, which
	// only hands out its context once the window is up.
	updater := update.New(version)
	var wailsCtx atomic.Pointer[context.Context]
	updater.Restart = func() {
		if ctx := wailsCtx.Load(); ctx != nil {
			wailsruntime.Quit(*ctx)
		}
	}
	if s := updater.Status(); !s.Supported {
		log.Printf("NATS Explorer %s: no in-app update (%s)", version, s.Reason)
	}

	// The history is persisted next to the settings and on by default: a
	// desktop app that loses everything it recorded when it is closed is not
	// what anyone expects. It can be switched off in the UI.
	app := createServer(frontendFS, serverConfig{
		mode:             "desktop",
		settings:         store,
		autoConnect:      true,
		historyDB:        filepath.Join(storeDir, "history.db"),
		historyRetention: history.DefaultRetention,
		historyOn:        true,
		updater:          updater,
		reopen:           reopen,
	})
	// wails.Run blocks until the window is closed; the server goes with it.
	defer app.Close()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	go http.Serve(listener, app)

	log.Printf("NATS Explorer %s: API running on http://127.0.0.1:%d", version, port)

	// Minimal loader page that redirects to our HTTP server.
	// This ensures WebSocket and all APIs work through the real HTTP server.
	loaderHTML := fmt.Sprintf(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { background: #1e1e2e; color: #cdd6f4; font-family: system-ui; display: flex;
         align-items: center; justify-content: center; height: 100vh; margin: 0; }
</style>
<script>window.location.replace("http://127.0.0.1:%d");</script>
</head><body>Loading...</body></html>`, port)

	// A real fs.FS (directory listing, Stat) is what the Wails asset server expects.
	loaderFS := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(loaderHTML)}}

	err = wails.Run(&options.App{
		Title:         "NATS Explorer" + versionSuffix(),
		Width:         1400,
		Height:        900,
		MinWidth:      800,
		MinHeight:     600,
		DisableResize: false,
		Frameless:     false,
		StartHidden:   false,
		AssetServer: &assetserver.Options{
			Assets: loaderFS,
		},
		OnStartup: func(ctx context.Context) { wailsCtx.Store(&ctx) },
	})
	if err != nil {
		log.Fatal(err)
	}
	// After an update the new version starts once this one has closed the
	// history database and everything else it holds, and opens what was open.
	if updater.Relaunching() {
		if err := noteReopen(storeDir, app.openConnections(), time.Now()); err != nil {
			log.Printf("update: the open connections cannot be noted: %v", err)
		}
	}
	app.Close()
	if err := updater.Relaunch(); err != nil {
		log.Printf("update: starting the new version: %v", err)
	}
}

func versionSuffix() string {
	if version == "" || version == "dev" {
		return ""
	}
	return " " + version
}
