//go:build !windows

package main

// initHotkey is a no-op off Windows: the hover-lookup overlay relies on Win32
// (global cursor position + click-through window styles), so it is Windows-only.
func (a *App) initHotkey() {}
