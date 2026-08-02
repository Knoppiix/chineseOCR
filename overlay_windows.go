//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image/png"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kbinani/screenshot"
	"github.com/lxn/win"
	"golang.design/x/hotkey"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// overlayCursorHz is how often we sample the cursor while the overlay is shown.
const overlayCursorHz = 60

var (
	hkMu    sync.Mutex
	hotkeys = map[string]*hotkey.Hotkey{} // action → registered hotkey
)

// DisplayCount reports the number of active displays (for the settings dropdown).
func (a *App) DisplayCount() int { return screenshot.NumActiveDisplays() }

// ListDisplays describes every active monitor so the settings screen can show a
// layout map. The primary display is the one whose origin is (0,0) — Windows
// defines the virtual desktop that way.
func (a *App) ListDisplays() []DisplayInfo {
	n := screenshot.NumActiveDisplays()
	out := make([]DisplayInfo, 0, n)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		out = append(out, DisplayInfo{
			Index:   i,
			X:       b.Min.X,
			Y:       b.Min.Y,
			Width:   b.Dx(),
			Height:  b.Dy(),
			Primary: b.Min.X == 0 && b.Min.Y == 0,
		})
	}
	return out
}

// reapplyHotkeys (re)binds every global shortcut from the config — at runtime,
// no restart.
func (a *App) reapplyHotkeys(cfg Config) error {
	if err := a.applyHotkey("overlay", cfg.OverlayHotkey, a.toggleOverlay); err != nil {
		return err
	}
	if err := a.applyHotkey("capture", cfg.CaptureHotkey, func() { go a.Capture() }); err != nil {
		return err
	}
	return nil
}

// applyHotkey rebinds one action's shortcut. An empty spec just unbinds it.
// Unregistering the old hotkey closes its Keydown() channel, so the old listener
// goroutine exits on its own; then we register the new one.
func (a *App) applyHotkey(action, spec string, handler func()) error {
	hkMu.Lock()
	defer hkMu.Unlock()

	if old := hotkeys[action]; old != nil {
		_ = old.Unregister()
		delete(hotkeys, action)
	}
	if strings.TrimSpace(spec) == "" {
		return nil // unbound
	}

	mods, key, err := parseHotkey(spec)
	if err != nil {
		return err
	}
	hk := hotkey.New(mods, key)
	if err := hk.Register(); err != nil {
		return fmt.Errorf("register hotkey %q: %w", spec, err)
	}
	hotkeys[action] = hk

	go func() {
		for range hk.Keydown() {
			handler()
		}
	}()
	return nil
}

// parseHotkey turns "ctrl+alt+f1" into modifiers + key.
func parseHotkey(spec string) ([]hotkey.Modifier, hotkey.Key, error) {
	var mods []hotkey.Modifier
	var key hotkey.Key
	haveKey := false
	for _, part := range strings.Split(strings.ToLower(strings.TrimSpace(spec)), "+") {
		switch strings.TrimSpace(part) {
		case "ctrl", "control":
			mods = append(mods, hotkey.ModCtrl)
		case "alt":
			mods = append(mods, hotkey.ModAlt)
		case "shift":
			mods = append(mods, hotkey.ModShift)
		case "win", "super", "meta", "cmd":
			mods = append(mods, hotkey.ModWin)
		case "":
			// ignore empty segments
		default:
			k, ok := keyFromString(strings.TrimSpace(part))
			if !ok {
				return nil, 0, fmt.Errorf("unknown key %q in hotkey %q", part, spec)
			}
			key, haveKey = k, true
		}
	}
	if !haveKey {
		return nil, 0, fmt.Errorf("hotkey %q has no key", spec)
	}
	return mods, key, nil
}

// keyFromString maps a key name to a hotkey.Key. Letters/digits map by ASCII
// (hotkey.KeyA==0x41, hotkey.Key0==0x30); F-keys and named keys are explicit.
func keyFromString(s string) (hotkey.Key, bool) {
	switch s {
	case "f1":
		return hotkey.KeyF1, true
	case "f2":
		return hotkey.KeyF2, true
	case "f3":
		return hotkey.KeyF3, true
	case "f4":
		return hotkey.KeyF4, true
	case "f5":
		return hotkey.KeyF5, true
	case "f6":
		return hotkey.KeyF6, true
	case "f7":
		return hotkey.KeyF7, true
	case "f8":
		return hotkey.KeyF8, true
	case "f9":
		return hotkey.KeyF9, true
	case "f10":
		return hotkey.KeyF10, true
	case "f11":
		return hotkey.KeyF11, true
	case "f12":
		return hotkey.KeyF12, true
	case "space":
		return hotkey.KeySpace, true
	case "enter", "return":
		return hotkey.KeyReturn, true
	}
	if len(s) == 1 {
		c := s[0]
		if c >= 'a' && c <= 'z' {
			return hotkey.Key(c - 'a' + 0x41), true // KeyA..KeyZ
		}
		if c >= '0' && c <= '9' {
			return hotkey.Key(c), true // Key0..Key9 == '0'..'9'
		}
	}
	return 0, false
}

// toggleOverlay shows/hides the transparent, click-through, always-on-top overlay
// window. While shown, a goroutine streams the cursor position to the frontend.
func (a *App) toggleOverlay() {
	a.ovMu.Lock()
	defer a.ovMu.Unlock()

	if a.overlayOn {
		a.overlayOn = false
		close(a.overlayStop)
		a.overlayStop = nil

		setClickThrough(false)
		runtime.WindowSetAlwaysOnTop(a.ctx, false)
		runtime.WindowUnfullscreen(a.ctx)
		runtime.WindowSetSize(a.ctx, resultsWidth, resultsHeight)
		a.setView(viewCapture)
		runtime.WindowHide(a.ctx)
		runtime.LogInfof(a.ctx, "overlay: OFF") // DEBUG
		return
	}

	// Snapshot the chosen display BEFORE showing our (transparent) overlay on top.
	disp := a.captureDisplay()
	b64, ox, oy, w, h, err := capturePrimary(disp)
	if err != nil {
		runtime.LogErrorf(a.ctx, "overlay capture: %v", err)
		a.overlayStop = nil
		return
	}

	a.overlayOn = true
	stop := make(chan struct{})
	a.overlayStop = stop

	a.setView(viewOverlay)                   // swap to the transparent card layer
	runtime.WindowSetPosition(a.ctx, ox, oy) // move onto the captured display…
	runtime.WindowFullscreen(a.ctx)          // …then fill it
	runtime.WindowSetAlwaysOnTop(a.ctx, true)
	runtime.WindowShow(a.ctx)
	setClickThrough(true) // after Show so the HWND exists and is visible

	// Hand the snapshot to the frontend to OCR, segment and look up.
	runtime.EventsEmit(a.ctx, "overlay:analyze", overlayFrame{Image: b64, OriginX: ox, OriginY: oy, Width: w, Height: h})
	runtime.LogInfof(a.ctx, "overlay: ON (origin %d,%d size %dx%d)", ox, oy, w, h) // DEBUG

	go a.cursorLoop(stop)
}

// capturePrimary grabs the chosen display and returns it as a base64 PNG plus
// its top-left origin and size in virtual-screen coordinates.
func capturePrimary(display int) (string, int, int, int, int, error) {
	if n := screenshot.NumActiveDisplays(); display < 0 || display >= n {
		display = 0
	}
	b := screenshot.GetDisplayBounds(display)
	img, err := screenshot.CaptureRect(b)
	if err != nil {
		return "", 0, 0, 0, 0, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", 0, 0, 0, 0, err
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), b.Min.X, b.Min.Y, b.Dx(), b.Dy(), nil
}

// cursorLoop streams the mouse position to the frontend (only when it moves)
// until stop is closed.
func (a *App) cursorLoop(stop chan struct{}) {
	t := time.NewTicker(time.Second / overlayCursorHz)
	defer t.Stop()

	var lastX, lastY int32 = -1, -1
	var lastLog time.Time
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			var p win.POINT
			if !win.GetCursorPos(&p) {
				continue
			}
			if p.X != lastX || p.Y != lastY {
				lastX, lastY = p.X, p.Y
				runtime.EventsEmit(a.ctx, "overlay:cursor", cursorPos{X: int(p.X), Y: int(p.Y)})
				if time.Since(lastLog) > 500*time.Millisecond { // DEBUG: throttled
					lastLog = time.Now()
					runtime.LogInfof(a.ctx, "overlay cursor: (%d, %d)", p.X, p.Y)
				}
			}
		}
	}
}

// setClickThrough toggles the WS_EX_TRANSPARENT extended style on our window so
// mouse input passes through to whatever is underneath (the game). WS_EX_LAYERED
// is required alongside it; we leave it set once applied.
func setClickThrough(on bool) {
	hwnd := win.FindWindow(nil, syscall.StringToUTF16Ptr("Chinese OCR"))
	if hwnd == 0 {
		return
	}
	ex := win.GetWindowLongPtr(hwnd, win.GWL_EXSTYLE)
	if on {
		ex |= win.WS_EX_LAYERED | win.WS_EX_TRANSPARENT
	} else {
		ex &^= win.WS_EX_TRANSPARENT
	}
	win.SetWindowLongPtr(hwnd, win.GWL_EXSTYLE, ex)
}
