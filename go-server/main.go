//go:build !desktop

package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3002"
	}

	publicPath := os.Getenv("PUBLIC_PATH")
	if publicPath == "" {
		exe, _ := os.Executable()
		publicPath = filepath.Join(filepath.Dir(exe), "..", "client", "dist")
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
	handler := createServer(staticFS, authToken)

	log.Printf("NATS Explorer running on http://localhost:%s", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%s", port), handler); err != nil {
		log.Fatal(err)
	}
}
