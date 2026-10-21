// fake-github plays api.github.com and github.com for scripts/test-update.sh:
// the newest release is the directory $RELEASE_DIR/current points at, its
// tag in a file named TAG, every other file in it an asset. HTTPS only, as
// the update refuses anything else; the test trusts the certificate through
// a CA of its own.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	root := os.Getenv("RELEASE_DIR")
	http.HandleFunc("/repos/blanpa/nats-explorer/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		dir := filepath.Join(root, "current")
		data, err := os.ReadFile(filepath.Join(dir, "TAG"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		tag := strings.TrimSpace(string(data))
		entries, _ := os.ReadDir(dir)
		type asset struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		}
		var assets []asset
		for _, e := range entries {
			if e.Name() != "TAG" {
				assets = append(assets, asset{e.Name(), "https://github.com/blanpa/nats-explorer/releases/download/" + tag + "/" + e.Name()})
			}
		}
		log.Printf("latest: %s, %d assets", tag, len(assets))
		json.NewEncoder(w).Encode(map[string]any{"tag_name": tag, "assets": assets})
	})
	http.HandleFunc("/blanpa/nats-explorer/releases/download/", func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.URL.Path)
		log.Printf("download: %s", name)
		http.ServeFile(w, r, filepath.Join(root, "current", name))
	})
	log.Fatal(http.ListenAndServeTLS(":443", os.Getenv("CERT"), os.Getenv("KEY"), nil))
}
