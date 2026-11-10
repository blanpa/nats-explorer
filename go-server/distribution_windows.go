package main

import (
	"syscall"
	"unsafe"
)

// packagedMSIX reports whether the process runs from an MSIX package: only
// then has it a package identity. GetCurrentPackageFullName answers
// APPMODEL_ERROR_NO_PACKAGE (15700) without one and ERROR_INSUFFICIENT_BUFFER
// (122) with one when asked for the length only.
func packagedMSIX() bool {
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("GetCurrentPackageFullName")
	if proc.Find() != nil {
		return false // before Windows 8
	}
	var length uint32
	r, _, _ := proc.Call(uintptr(unsafe.Pointer(&length)), 0)
	return r == 122
}
