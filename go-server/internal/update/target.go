package update

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Kind is how this copy of the desktop app was installed, which decides the
// file of the release it is replaced with and how.
type Kind string

const (
	// AppImage replaces the AppImage file it was started from ($APPIMAGE).
	AppImage Kind = "appimage"
	// Tarball replaces the binary unpacked from the Linux .tar.gz.
	Tarball Kind = "tarball"
	// Windows replaces the .exe, installed or unpacked from the portable zip:
	// both are the same binary.
	Windows Kind = "windows"
	// MacApp replaces the whole .app bundle.
	MacApp Kind = "macos"
)

// Target is what an update replaces, and with which file of the release.
type Target struct {
	Kind Kind
	// Path is the file, or on macOS the .app bundle, that is replaced.
	Path string
	// asset is the release file's name, %s standing for the version: the
	// versioned name, so a release's checksums cannot be passed off as
	// another version's.
	asset string
	// member is the file inside the archive; empty for an AppImage, which
	// is the file itself, and for the bundle, which is found by its suffix.
	member string
}

// Asset is the name of the release file for a version.
func (t Target) Asset(version string) string {
	return fmt.Sprintf(t.asset, version)
}

// versionOf reads the version out of the name of this installation's
// release file, the reverse of Asset. The names without a version, which a
// release carries for the download links, do not match.
func (t Target) versionOf(name string) (string, bool) {
	prefix, suffix, _ := strings.Cut(t.asset, "%s")
	v, ok := strings.CutPrefix(name, prefix)
	if !ok {
		return "", false
	}
	v, ok = strings.CutSuffix(v, suffix)
	if !ok || v == "" || v[0] < '0' || v[0] > '9' || strings.ContainsAny(v, "/\\ ") {
		return "", false
	}
	return v, true
}

// Detect works out how this copy was installed, from where its executable
// is and what the environment says. An installation the app cannot replace
// by itself comes back as an error that says why, which the UI shows.
func Detect(goos, goarch, exe string, getenv func(string) string) (Target, error) {
	if goarch != "amd64" && goos != "darwin" {
		return Target{}, fmt.Errorf("there is no desktop build for %s/%s to update to", goos, goarch)
	}
	switch goos {
	case "linux":
		// The AppImage runtime names the file it was started from; the
		// executable itself is inside a mount that goes when it exits.
		if p := getenv("APPIMAGE"); p != "" {
			return Target{Kind: AppImage, Path: p, asset: "nats-explorer-desktop-%s-linux-x64.AppImage"}, nil
		}
		if exe == "/usr/bin/nats-explorer" {
			return Target{}, errors.New("installed from the .deb package: the package manager updates it")
		}
		return Target{Kind: Tarball, Path: exe, asset: "nats-explorer-desktop-%s-linux-x64.tar.gz", member: "nats-explorer"}, nil
	case "windows":
		return Target{Kind: Windows, Path: exe, asset: "nats-explorer-desktop-%s-windows-x64.zip", member: "nats-explorer.exe"}, nil
	case "darwin":
		bundle := appBundle(exe)
		if bundle == "" {
			return Target{}, errors.New("not started from an app bundle")
		}
		// Gatekeeper runs an app that was never moved out of Downloads from a
		// read-only copy somewhere else; replacing that copy changes nothing.
		if strings.Contains(bundle, "/AppTranslocation/") {
			return Target{}, errors.New("macOS runs this copy from a read-only place: move NATS Explorer to Applications and start it from there")
		}
		return Target{Kind: MacApp, Path: bundle, asset: "nats-explorer-desktop-%s-macos-universal.zip"}, nil
	}
	return Target{}, fmt.Errorf("there is no desktop build for %s to update to", goos)
}

// appBundle is the .app directory an executable lives in, or "".
func appBundle(exe string) string {
	for dir := filepath.Dir(exe); dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
		if strings.HasSuffix(dir, ".app") {
			return dir
		}
	}
	return ""
}

// previous is where the version an update replaced is kept, to go back to:
// next to the installation, hidden by a dot where a dot hides a file. A
// running .exe cannot be overwritten anyway, only renamed, and the bundle of
// a running app is not pulled away under it. Next to it, previous()+".version"
// says which version it is.
func (t Target) previous() string {
	if t.Kind == Windows {
		return t.Path + ".previous"
	}
	return filepath.Join(filepath.Dir(t.Path), "."+filepath.Base(t.Path)+".previous")
}

// previousVersion is the version kept to go back to, or "".
func (t Target) previousVersion() string {
	if _, err := os.Lstat(t.previous()); err != nil {
		return ""
	}
	data, err := os.ReadFile(t.previous() + ".version")
	if err != nil {
		return ""
	}
	v := strings.TrimSpace(string(data))
	if v == "" || v[0] < '0' || v[0] > '9' {
		return ""
	}
	return v
}

// writable says whether new files can be put into dir, by putting one there.
func writable(dir string) error {
	f, err := os.CreateTemp(dir, ".nats-explorer-write-*")
	if err != nil {
		return err
	}
	f.Close()
	return os.Remove(f.Name())
}
