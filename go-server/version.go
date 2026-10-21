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

// deployment names what runs this server when it is a container, for the
// hint that a newer release is out: a container is updated through its
// image, not in place. Empty for a binary started by hand.
func deployment() string {
	return deploymentFrom(os.Getenv, func(p string) bool {
		_, err := os.Stat(p)
		return err == nil
	})
}

func deploymentFrom(getenv func(string) string, exists func(string) bool) string {
	switch {
	case getenv("KUBERNETES_SERVICE_HOST") != "":
		return "kubernetes"
	case exists("/.dockerenv"):
		return "docker"
	case exists("/run/.containerenv"): // podman
		return "container"
	}
	return ""
}
