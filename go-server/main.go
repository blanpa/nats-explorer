//go:build !desktop

package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"nats-explorer/internal/settings"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3002"
	}

	publicPath := os.Getenv("PUBLIC_PATH")
	if publicPath == "" {
		// Release archives ship the UI as public/ next to the binary; a source
		// checkout has it in client/dist.
		exe, _ := os.Executable()
		for _, candidate := range []string{filepath.Join(filepath.Dir(exe), "public"), filepath.Join(filepath.Dir(exe), "..", "client", "dist")} {
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				publicPath = candidate
				break
			}
		}
	}

	var staticFS fs.FS
	if info, err := os.Stat(publicPath); err == nil && info.IsDir() {
		staticFS = os.DirFS(publicPath)
		log.Printf("Serving static files from %s", publicPath)
	}

	authToken := os.Getenv("AUTH_TOKEN")
	if authToken != "" {
		log.Printf("API token authentication enabled")
	}
	cfg := serverConfig{authToken: authToken, mode: "server"}
	// STORAGE_DIR turns a single-user server into a persistent installation:
	// connections and templates live there instead of in the browser.
	if dir := os.Getenv("STORAGE_DIR"); dir != "" {
		store, err := settings.Open(dir, settings.NewSecretStore(dir, os.Getenv("NO_KEYRING") == ""))
		if err != nil {
			log.Fatalf("settings: %v", err)
		}
		log.Printf("UI settings stored in %s (secrets: %s)", store.Path(), store.SecretsName())
		cfg.settings = store
	}
	handler := createServer(staticFS, cfg)

	log.Printf("NATS Explorer running on http://localhost:%s", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%s", port), handler); err != nil {
		log.Fatal(err)
	}
}
