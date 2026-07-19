package main

import (
	"context"

	"github.com/energye/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Window dimensions for the small results card (must match main.go / style.css).
const (
	resultsWidth  = 480
	resultsHeight = 300
)

type App struct {
	ctx context.Context
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// energye/systray on Linux talks to the desktop tray over DBus (the
	// StatusNotifierItem/AppIndicator spec) — no GTK, so it coexists with
	// Wails' GTK main loop. On Windows/macOS it uses the native tray. Run it in
	// a goroutine; handlers use a.ctx.
	go systray.Run(a.onTrayReady, func() {})
}

func (a *App) shutdown(_ context.Context) { systray.Quit() }

// onTrayReady builds the tray icon + menu. Clicking the tray icon shows this
// menu (rendered by the desktop shell over DBus).
func (a *App) onTrayReady() {
	systray.SetIcon(trayIcon)
	systray.SetTitle("Chinese OCR")
	systray.SetTooltip("Chinese OCR — screenshot to Chinese text")

	mCapture := systray.AddMenuItem("📸 Capture", "Select a screen region to OCR")
	mShow := systray.AddMenuItem("Show window", "Open the results window")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Exit Chinese OCR")

	// Capture blocks while the user picks a region, so run it off the DBus callback.
	mCapture.Click(func() { go a.Capture() })
	mShow.Click(func() { runtime.WindowShow(a.ctx) })
	mQuit.Click(func() { a.Quit() })

	// Some desktop environments need an explicit menu-show on click.
	systray.SetOnClick(func(menu systray.IMenu) { _ = menu.ShowMenu() })
	systray.SetOnRClick(func(menu systray.IMenu) { _ = menu.ShowMenu() })
}

// Quit tears down the tray then exits the application.
func (a *App) Quit() {
	systray.Quit()
	runtime.Quit(a.ctx)
}

// HideWindow returns the window to the tray (used by the in-window × button).
func (a *App) HideWindow() { runtime.WindowHide(a.ctx) }

// Capture hides the window and grabs the screen via the platform-specific
// backend (screenshot_linux.go / screenshot_other.go), then routes the result:
//
//   - NeedsSelect == false (Linux/XDG portal): the OS already cropped the region,
//     so hand the PNG straight to JS for OCR and show the small results window.
//
//   - NeedsSelect == true (Windows/macOS/kbinani): the backend captured the whole
//     virtual desktop, so go fullscreen and let the frontend overlay handle the
//     region selection before OCR (see FinishSelection / CancelSelection).
func (a *App) Capture() {
	runtime.WindowHide(a.ctx)

	res, err := captureScreenshot()
	if err != nil {
		runtime.LogErrorf(a.ctx, "Capture: %v", err)
		return
	}
	if res == nil {
		return // user cancelled — stay in the tray
	}

	if res.NeedsSelect {
		runtime.EventsEmit(a.ctx, "capture:select", res.Image)
		runtime.WindowFullscreen(a.ctx)
		runtime.WindowShow(a.ctx)
		return
	}

	runtime.EventsEmit(a.ctx, "capture:done", res.Image)
	runtime.WindowCenter(a.ctx)
	runtime.WindowShow(a.ctx)
}

// FinishSelection is called by the frontend once the user has drawn a region in
// the fullscreen overlay: it leaves fullscreen and restores the small results
// window so the OCR output can be shown.
func (a *App) FinishSelection() {
	runtime.WindowUnfullscreen(a.ctx)
	runtime.WindowSetSize(a.ctx, resultsWidth, resultsHeight)
	runtime.WindowCenter(a.ctx)
}

// CancelSelection is called by the frontend when the user aborts the overlay
// (Escape): it leaves fullscreen and hides back to the tray.
func (a *App) CancelSelection() {
	runtime.WindowUnfullscreen(a.ctx)
	runtime.WindowSetSize(a.ctx, resultsWidth, resultsHeight)
	runtime.WindowHide(a.ctx)
}
