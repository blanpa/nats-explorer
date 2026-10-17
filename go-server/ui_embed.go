//go:build embedui && !desktop

package main

import (
	"embed"
	"io/fs"
)

// Release builds carry the UI inside the binary, so the server is one file
// that cannot lose its UI on the way. "all:" keeps files whose names start
// with "_" or ".", which Vite emits (__vite-browser-external-*.js).
//
//go:embed all:frontend/dist
var embeddedAssets embed.FS

func embeddedUI() fs.FS {
	ui, err := fs.Sub(embeddedAssets, "frontend/dist")
	if err != nil {
		return nil
	}
	return ui
}
