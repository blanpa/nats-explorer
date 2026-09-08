//go:build desktop

package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing/fstest"

	"nats-explorer/internal/settings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed frontend/dist
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

	// Start the HTTP server (API + WebSocket) on a random port
	app := createServer(frontendFS, serverConfig{mode: "desktop", settings: store, autoConnect: true})
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
	})
	if err != nil {
		log.Fatal(err)
	}
}

func versionSuffix() string {
	if version == "" || version == "dev" {
		return ""
	}
	return " " + version
}
