//go:build !windows

package main

// reapplyHotkeys / DisplayCount are no-ops off Windows: the hover-lookup overlay
// relies on Win32 (global cursor + click-through + hotkeys), so it is Windows-only.
func (a *App) reapplyHotkeys(Config) error { return nil }
func (a *App) DisplayCount() int           { return 1 }
