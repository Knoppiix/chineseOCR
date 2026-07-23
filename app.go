package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"os"
	"sync"
	"time"

	"github.com/energye/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Window dimensions for the small results card (must match main.go / style.css).
const (
	resultsWidth  = 480
	resultsHeight = 300

	// Larger window used to show the end-of-session character summary.
	sessionWinWidth  = 540
	sessionWinHeight = 640
)

// UI views. Go is the single source of truth for which view the window shows;
// it pushes the current view to the frontend (the "view:change" event) and the
// frontend renders exactly that view — nothing else. Adding a future mode is a
// new constant here, a container in index.html, and a case in applyView().
const (
	viewCapture = "capture" // the small screenshot → OCR results card (default/home)
	viewSession = "session" // the learning-session processing + summary screen
	viewOverlay = "overlay" // the transparent, click-through hover-lookup overlay
)

type App struct {
	ctx context.Context

	// Current UI view (guarded by viewMu). See the view* constants.
	viewMu sync.Mutex
	view   string

	// Learning-session state (guarded by sessMu).
	sessMu     sync.Mutex
	recording  bool
	sessCancel context.CancelFunc
	sessDone   chan struct{}
	sessProc   *sessionProcessor
	sessDir    string

	// Hover-overlay state (guarded by ovMu).
	ovMu        sync.Mutex
	overlayOn   bool
	overlayStop chan struct{}
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.view = viewCapture
	// energye/systray on Linux talks to the desktop tray over DBus (the
	// StatusNotifierItem/AppIndicator spec) — no GTK, so it coexists with
	// Wails' GTK main loop. On Windows/macOS it uses the native tray. Run it in
	// a goroutine; handlers use a.ctx.
	go systray.Run(a.onTrayReady, func() {})

	// Register the global hotkey that toggles the hover-lookup overlay
	// (Windows-only; a no-op elsewhere).
	a.initHotkey()
}

func (a *App) shutdown(_ context.Context) {
	a.sessMu.Lock()
	if a.recording && a.sessCancel != nil {
		a.sessCancel()
	}
	dir := a.sessDir
	a.sessMu.Unlock()
	if dir != "" {
		_ = os.RemoveAll(dir) // best-effort cleanup of session frames
	}
	systray.Quit()
}

// onTrayReady builds the tray icon + menu. Clicking the tray icon shows this
// menu (rendered by the desktop shell over DBus).
func (a *App) onTrayReady() {
	systray.SetIcon(trayIcon)
	systray.SetTitle("Chinese OCR")
	systray.SetTooltip("Chinese OCR — screenshot to Chinese text")

	mCapture := systray.AddMenuItem("Capture", "Select a screen region to OCR")
	mSession := systray.AddMenuItem("Start learning session", sessionStartTip)
	mShow := systray.AddMenuItem("Show window", "Open the results window")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Exit Chinese OCR")

	// Capture blocks while the user picks a region, so run it off the DBus callback.
	mCapture.Click(func() { go a.Capture() })
	mSession.Click(func() { go a.toggleSession(mSession) })
	mShow.Click(func() { a.showCaptureWindow() })
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

// ── View state ───────────────────────────────────────────────────────────────

// GetView returns the current view, so the frontend can sync on boot.
func (a *App) GetView() string {
	a.viewMu.Lock()
	defer a.viewMu.Unlock()
	if a.view == "" {
		return viewCapture
	}
	return a.view
}

// setView records the current view and pushes it to the frontend.
func (a *App) setView(v string) {
	a.viewMu.Lock()
	a.view = v
	a.viewMu.Unlock()
	runtime.EventsEmit(a.ctx, "view:change", v)
}

// returnToCapture drops any finished session, resizes back to the small results
// card, and switches the frontend to the capture view. It does NOT touch window
// visibility (callers decide) and never clears a session that is still recording.
func (a *App) returnToCapture() {
	a.sessMu.Lock()
	var dir string
	if !a.recording {
		dir = a.sessDir
		a.sessProc = nil
		a.sessDir = ""
	}
	a.sessMu.Unlock()
	if dir != "" {
		_ = os.RemoveAll(dir) // best-effort cleanup of retained frames
	}
	runtime.WindowSetSize(a.ctx, resultsWidth, resultsHeight)
	a.setView(viewCapture)
}

// showCaptureWindow (tray "Show window") always brings up the base capture view,
// discarding any lingering session summary so the window never opens on stale
// learning-mode UI.
func (a *App) showCaptureWindow() {
	a.returnToCapture()
	runtime.WindowShow(a.ctx)
}

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

	runtime.WindowSetSize(a.ctx, resultsWidth, resultsHeight)
	a.setView(viewCapture)
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
	a.setView(viewCapture)
}

// CancelSelection is called by the frontend when the user aborts the overlay
// (Escape): it leaves fullscreen and hides back to the tray.
func (a *App) CancelSelection() {
	runtime.WindowUnfullscreen(a.ctx)
	runtime.WindowSetSize(a.ctx, resultsWidth, resultsHeight)
	runtime.WindowHide(a.ctx)
}

// ── Learning session (screen-recording → deferred OCR summary) ───────────────
//
// A session captures the screen (Windows-only, via the DXGI recorder) and, using
// a cheap live dedup/settle filter, keeps only the distinct on-screen states as
// PNGs on disk. All OCR is deferred to StopSession time, so the game/app stays
// smooth while recording. The frontend then pulls each retained frame, OCRs it,
// and tallies the most-shown Chinese characters (by count and on-screen time).

const (
	sessionStartTip = "Record the screen; get a Chinese-character summary when you stop"
	sessionStopTip  = "Stop recording and build the character summary"
)

// toggleSession flips between start and stop, updating the tray item's label.
func (a *App) toggleSession(item *systray.MenuItem) {
	a.sessMu.Lock()
	running := a.recording
	a.sessMu.Unlock()

	if running {
		if _, err := a.StopSession(); err != nil {
			runtime.LogErrorf(a.ctx, "stop session: %v", err)
			return
		}
		item.SetTitle("Start learning session")
		item.SetTooltip(sessionStartTip)
		return
	}

	if err := a.StartSession(); err != nil {
		runtime.LogErrorf(a.ctx, "start session: %v", err)
		runtime.EventsEmit(a.ctx, "session:error", err.Error())
		return
	}
	item.SetTitle("Stop learning session")
	item.SetTooltip(sessionStopTip)
}

// StartSession begins recording the screen. Returns an error on unsupported
// platforms or if a session is already running.
func (a *App) StartSession() error {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()

	if a.recording {
		return errors.New("a session is already running")
	}
	rec, err := newRecorder()
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "chineseocr-session-*")
	if err != nil {
		return fmt.Errorf("create session dir: %w", err)
	}
	runtime.LogInfof(a.ctx, "session: writing captured frames to %s", dir)

	proc := newSessionProcessor(dir)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	a.recording = true
	a.sessCancel = cancel
	a.sessDone = done
	a.sessProc = proc
	a.sessDir = dir

	runtime.WindowHide(a.ctx) // get out of the way while recording

	go func() {
		defer close(done)
		if err := rec.run(ctx, func(img *image.RGBA, changed bool) {
			proc.consider(img, changed, time.Now())
		}); err != nil {
			runtime.LogErrorf(a.ctx, "session capture: %v", err)
		}
		proc.finalize(time.Now())
	}()
	return nil
}

// StopSession stops recording, waits for the capture loop to finish, shows the
// window, and returns the number of retained frames. The frontend then pulls
// them via SessionFrame and runs OCR.
func (a *App) StopSession() (int, error) {
	a.sessMu.Lock()
	if !a.recording {
		a.sessMu.Unlock()
		return 0, nil
	}
	a.recording = false
	cancel := a.sessCancel
	done := a.sessDone
	proc := a.sessProc
	a.sessMu.Unlock()

	cancel()
	<-done // capture loop has now exited and finalized durations

	count := len(proc.frames)
	runtime.WindowSetSize(a.ctx, sessionWinWidth, sessionWinHeight)
	runtime.WindowCenter(a.ctx)
	a.setView(viewSession)
	runtime.WindowShow(a.ctx)
	runtime.EventsEmit(a.ctx, "session:stopped", count)
	return count, nil
}

// SessionFrameCount reports how many frames the last session retained.
func (a *App) SessionFrameCount() int {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	if a.sessProc == nil {
		return 0
	}
	return len(a.sessProc.frames)
}

// SessionFrame returns the i-th retained frame (base64 PNG + on-screen duration)
// for OCR. Valid only after StopSession and before ClearSession.
func (a *App) SessionFrame(i int) (FrameMeta, error) {
	a.sessMu.Lock()
	proc := a.sessProc
	a.sessMu.Unlock()

	if proc == nil || i < 0 || i >= len(proc.frames) {
		return FrameMeta{}, fmt.Errorf("frame %d out of range", i)
	}
	rec := proc.frames[i]
	data, err := os.ReadFile(rec.path)
	if err != nil {
		return FrameMeta{}, fmt.Errorf("read frame %d: %w", i, err)
	}
	return FrameMeta{
		Data:       base64.StdEncoding.EncodeToString(data),
		DurationMs: rec.durationMs,
	}, nil
}

// ClearSession deletes the retained frames from disk once the frontend is done
// processing them (the summary's "Done" button), and returns to the capture view.
func (a *App) ClearSession() error {
	a.returnToCapture()
	return nil
}

// SaveCSV prompts for a destination via the native save dialog and writes the
// given content there. Returns the written path, or "" if the user cancelled.
func (a *App) SaveCSV(defaultName, content string) (string, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export session summary",
		DefaultFilename: defaultName,
		Filters:         []runtime.FileFilter{{DisplayName: "CSV files (*.csv)", Pattern: "*.csv"}},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil // cancelled
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("write CSV %q: %w", path, err)
	}
	return path, nil
}
