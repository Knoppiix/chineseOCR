//go:build !windows

package main

// reapplyHotkeys / DisplayCount are no-ops off Windows: the hover-lookup overlay
// relies on Win32 (global cursor + click-through + hotkeys), so it is Windows-only.
func (a *App) reapplyHotkeys(Config) error { return nil }
func (a *App) DisplayCount() int           { return 1 }

// ListDisplays reports a single placeholder display off Windows.
func (a *App) ListDisplays() []DisplayInfo {
	return []DisplayInfo{{Index: 0, Width: 1920, Height: 1080, Primary: true}}
}
