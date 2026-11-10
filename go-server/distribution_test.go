package main

import "testing"

func TestDistributionFlatpak(t *testing.T) {
	t.Setenv("FLATPAK_ID", "io.github.blanpa.nats-explorer")
	if got := distribution(); got != "flatpak" {
		t.Fatalf("distribution() = %q, want flatpak", got)
	}
}

func TestDistributionNone(t *testing.T) {
	t.Setenv("FLATPAK_ID", "")
	if got := distribution(); got != "" {
		t.Fatalf("distribution() = %q outside a package", got)
	}
}
