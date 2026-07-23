//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"syscall"
	"time"

	"github.com/kbinani/screenshot"
	"github.com/lxn/win"
	"golang.design/x/hotkey"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// overlayCursorHz is how often we sample the cursor while the overlay is shown.
const overlayCursorHz = 60

// initHotkey registers the global toggle shortcut (Ctrl+F1) for the
// hover-lookup overlay and dispatches presses to toggleOverlay.
func (a *App) initHotkey() {
	go func() {
		hk := hotkey.New([]hotkey.Modifier{hotkey.ModCtrl}, hotkey.KeyF1)
		if err := hk.Register(); err != nil {
			runtime.LogErrorf(a.ctx, "overlay hotkey register: %v", err)
			return
		}
		defer hk.Unregister()
		for range hk.Keydown() {
			a.toggleOverlay()
		}
	}()
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
		return
	}

	// Snapshot the display BEFORE showing our (transparent) overlay on top.
	b64, ox, oy, err := capturePrimary()
	if err != nil {
		runtime.LogErrorf(a.ctx, "overlay capture: %v", err)
		a.overlayStop = nil
		return
	}

	a.overlayOn = true
	stop := make(chan struct{})
	a.overlayStop = stop

	a.setView(viewOverlay) // let the frontend swap to the transparent card layer
	runtime.WindowFullscreen(a.ctx)
	runtime.WindowSetAlwaysOnTop(a.ctx, true)
	runtime.WindowShow(a.ctx)
	setClickThrough(true) // after Show so the HWND exists and is visible

	// Hand the snapshot to the frontend to OCR, segment and look up.
	runtime.EventsEmit(a.ctx, "overlay:analyze", overlayFrame{Image: b64, OriginX: ox, OriginY: oy})

	go a.cursorLoop(stop)
}

// capturePrimary grabs the primary display and returns it as a base64 PNG plus
// its top-left origin in virtual-screen coordinates.
func capturePrimary() (string, int, int, error) {
	b := screenshot.GetDisplayBounds(0)
	img, err := screenshot.CaptureRect(b)
	if err != nil {
		return "", 0, 0, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", 0, 0, err
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), b.Min.X, b.Min.Y, nil
}

// cursorLoop streams the mouse position to the frontend (only when it moves)
// until stop is closed.
func (a *App) cursorLoop(stop chan struct{}) {
	t := time.NewTicker(time.Second / overlayCursorHz)
	defer t.Stop()

	var lastX, lastY int32 = -1, -1
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
