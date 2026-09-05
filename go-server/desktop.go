//go:build desktop

package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"time"

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

	// Start the HTTP server (API + WebSocket) on a random port
	handler := createServer(frontendFS, "")

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	go http.Serve(listener, handler)

	log.Printf("NATS Explorer API running on http://127.0.0.1:%d", port)

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

	loaderFS := &singleFileFS{name: "index.html", content: []byte(loaderHTML)}

	err = wails.Run(&options.App{
		Title:         "NATS Explorer",
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

// singleFileFS serves a single in-memory file as an fs.FS
type singleFileFS struct {
	name    string
	content []byte
}

func (f *singleFileFS) Open(name string) (fs.File, error) {
	if name == "." || name == f.name || name == "" || name == "index.html" {
		return &memFile{name: f.name, content: f.content}, nil
	}
	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

type memFile struct {
	name    string
	content []byte
	offset  int
}

func (f *memFile) Stat() (fs.FileInfo, error) { return f, nil }
func (f *memFile) Read(b []byte) (int, error) {
	if f.offset >= len(f.content) {
		return 0, io.EOF
	}
	n := copy(b, f.content[f.offset:])
	f.offset += n
	return n, nil
}
func (f *memFile) Close() error       { return nil }
func (f *memFile) Name() string       { return f.name }
func (f *memFile) Size() int64        { return int64(len(f.content)) }
func (f *memFile) Mode() fs.FileMode  { return 0444 }
func (f *memFile) ModTime() time.Time { return time.Time{} }
func (f *memFile) IsDir() bool        { return false }
func (f *memFile) Sys() any           { return nil }
