//go:build !embedui && !desktop

package main

import "io/fs"

// Built without the embedui tag (go run, tests): the UI comes from disk.
func embeddedUI() fs.FS { return nil }
