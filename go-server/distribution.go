package main

import "os"

// distribution names the package manager that installed this binary, when
// one did: "flatpak" (Flathub) or "msix" (Microsoft Store). Such an
// installation is updated by its store, so the UI does not look for newer
// releases on GitHub itself. Empty for the GitHub downloads, the Docker image
// and a build from source.
func distribution() string {
	// Every Flatpak sandbox has /.flatpak-info, and flatpak run sets FLATPAK_ID.
	if os.Getenv("FLATPAK_ID") != "" {
		return "flatpak"
	}
	if _, err := os.Stat("/.flatpak-info"); err == nil {
		return "flatpak"
	}
	if packagedMSIX() {
		return "msix"
	}
	return ""
}
