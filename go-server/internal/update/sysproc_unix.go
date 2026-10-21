//go:build !windows

package update

import "syscall"

// detached starts the new version in a session of its own, so it does not
// go down with a terminal the old one was started from.
func detached() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func setDisplayVersion(string, string) {}
