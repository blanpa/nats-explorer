package main

import (
	"os"
	"strings"
)

// version and commit are stamped by the build scripts
// (-ldflags "-X main.version=… -X main.commit=…").
var (
	version = "dev"
	commit  = ""
)

// defaultSource is where the source of an unmodified build lives. The AGPL asks
// a build that is offered over a network to offer its own source: a modified
// build points `SOURCE_URL` (or stamps `-X main.defaultSource=…`) at its own
// repository, and the "Source" link in the UI follows.
var defaultSource = "https://github.com/blanpa/nats-explorer"

// sourceURL is the link the UI offers as "Source". For a GitHub repository it
// points at the exact commit or release tag this binary was built from, so the
// link hands out the source that corresponds to what is running and not just the
// newest main. Anything else is used as given.
func sourceURL() string {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("SOURCE_URL")), "/")
	if base == "" {
		base = strings.TrimRight(defaultSource, "/")
	}
	if base == "" || !strings.Contains(base, "github.com/") {
		return base
	}
	switch {
	case commit != "":
		return base + "/tree/" + commit
	case version != "" && version != "dev":
		return base + "/releases/tag/v" + strings.TrimPrefix(version, "v")
	}
	return base
}
