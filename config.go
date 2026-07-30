package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Config holds the user-tweakable settings, persisted as JSON in the OS config
// dir (%AppData%\ChineseOCR\config.json on Windows). The frontend reads it via
// GetConfig() and writes it via UpdateConfig(), which saves immediately.
type Config struct {
	OverlayHotkey        string  `json:"overlayHotkey"`        // e.g. "ctrl+f1"
	CaptureHotkey        string  `json:"captureHotkey"`        // e.g. "ctrl+f2" ("" = unbound)
	DictPath             string  `json:"dictPath"`             // served path, e.g. "/dicts/cedict_ts.u8"
	OverlayMinConfidence float64 `json:"overlayMinConfidence"` // 0..1, hide OCR regions below this
	DetectionMaxSide     int     `json:"detectionMaxSide"`     // 0 = auto (native res, capped)
	CaptureDisplay       int     `json:"captureDisplay"`       // display index the overlay captures
}

func defaultConfig() *Config {
	return &Config{
		OverlayHotkey:        "ctrl+f1",
		CaptureHotkey:        "ctrl+f2",
		DictPath:             "/dicts/cedict_ts.u8",
		OverlayMinConfidence: 0.7,
		DetectionMaxSide:     0,
		CaptureDisplay:       0,
	}
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ChineseOCR", "config.json"), nil
}

// loadConfig reads the config file, falling back to defaults for a missing file
// or any missing field (so new settings get sane defaults on upgrade).
func loadConfig() *Config {
	c := defaultConfig()
	path, err := configPath()
	if err != nil {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c // no file yet → defaults
	}
	_ = json.Unmarshal(data, c) // unknown fields ignored; absent fields keep defaults
	return c
}

func (c *Config) save() error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// captureDisplay is the display index the user chose to capture (0 if unset).
func (a *App) captureDisplay() int {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if a.cfg == nil {
		return 0
	}
	return a.cfg.CaptureDisplay
}

// GetConfig returns the current settings (the frontend reads this on boot).
func (a *App) GetConfig() Config {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	return *a.cfg
}

// UpdateConfig applies and persists new settings. Hotkey changes are hot-swapped
// (no restart); everything else is re-read by the frontend on the config:change
// event. On a failed hotkey re-registration the whole update is rolled back.
func (a *App) UpdateConfig(next Config) error {
	// Hot-swap the global hotkeys first; if a binding is invalid we bail out
	// before persisting, so the bad value never sticks.
	if err := a.reapplyHotkeys(next); err != nil {
		return err
	}

	a.cfgMu.Lock()
	a.cfg = &next
	a.cfgMu.Unlock()

	if err := next.save(); err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, "config:change", next)
	return nil
}

// ListDicts returns the dictionary filenames available under /dicts/ (from the
// embedded assets), for the settings dropdown.
func (a *App) ListDicts() []string {
	entries, err := assets.ReadDir("frontend/dist/dicts")
	if err != nil {
		return []string{"cedict_ts.u8"} // fallback
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".u8") {
			out = append(out, e.Name())
		}
	}
	if len(out) == 0 {
		return []string{"cedict_ts.u8"}
	}
	sort.Strings(out)
	return out
}
