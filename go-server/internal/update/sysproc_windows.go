//go:build windows

package update

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

// detached: a Windows process outlives the one that started it anyway.
func detached() *syscall.SysProcAttr {
	return nil
}

// uninstallKey is where the installer lists the app under "Installed apps"
// (UNINST_KEY in build/windows/installer).
const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\NATS ExplorerNATS Explorer`

// setDisplayVersion keeps "Installed apps" in step with the replaced .exe.
// A portable copy, which has no uninstaller next to it, is not listed there.
func setDisplayVersion(exe, version string) {
	dir := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(dir, "uninstall.exe")); err != nil {
		return
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, uninstallKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	if loc, _, err := k.GetStringValue("InstallLocation"); err != nil || !strings.EqualFold(filepath.Clean(loc), filepath.Clean(dir)) {
		return
	}
	k.SetStringValue("DisplayVersion", version)
}
