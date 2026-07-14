package main

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync/atomic"

	"github.com/energye/systray"
	"github.com/godbus/dbus/v5"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"context"
)

type App struct {
	ctx context.Context
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// energye/systray on Linux talks to the desktop tray over DBus (the
	// StatusNotifierItem/AppIndicator spec) — no GTK, so it coexists with
	// Wails' GTK main loop. Run it in a goroutine; handlers use a.ctx.
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

// Capture hides the window, asks the desktop's native screenshot picker (via the
// XDG portal) to select + capture a region, then hands the cropped PNG to JS for
// OCR and reveals the results window. Selection is done by the OS — not a webview
// overlay — so it is unaffected by the WebKitGTK HiDPI/Wayland fullscreen scaling
// bug that broke the in-app overlay.
func (a *App) Capture() {
	runtime.WindowHide(a.ctx)

	b64, err := captureRegionViaPortal()
	if err != nil {
		runtime.LogErrorf(a.ctx, "Capture: %v", err)
		return
	}
	if b64 == "" {
		return // user cancelled — stay in the tray
	}

	runtime.EventsEmit(a.ctx, "capture:done", b64)
	runtime.WindowCenter(a.ctx)
	runtime.WindowShow(a.ctx)
}

var portalToken uint64

// captureRegionViaPortal drives org.freedesktop.portal.Screenshot in interactive
// mode (the desktop's native area picker) and returns the captured PNG as a
// base64 string. Returns "" if the user cancels.
func captureRegionViaPortal() (string, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return "", fmt.Errorf("connect session bus: %w", err)
	}
	defer conn.Close()

	// Match the Response signal before issuing the request to avoid a race.
	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.portal.Request"),
		dbus.WithMatchMember("Response"),
	); err != nil {
		return "", fmt.Errorf("add match: %w", err)
	}
	ch := make(chan *dbus.Signal, 4)
	conn.Signal(ch)

	token := fmt.Sprintf("chineseocr%d", atomic.AddUint64(&portalToken, 1))
	options := map[string]dbus.Variant{
		"interactive":  dbus.MakeVariant(true),
		"handle_token": dbus.MakeVariant(token),
	}

	obj := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
	var requestPath dbus.ObjectPath
	if err := obj.Call("org.freedesktop.portal.Screenshot.Screenshot", 0, "", options).Store(&requestPath); err != nil {
		return "", fmt.Errorf("call Screenshot: %w", err)
	}

	for sig := range ch {
		if sig.Path != requestPath || len(sig.Body) < 2 {
			continue
		}
		response, _ := sig.Body[0].(uint32)
		if response != 0 {
			return "", nil // 1 = cancelled, 2 = ended some other way
		}
		results, _ := sig.Body[1].(map[string]dbus.Variant)
		uriV, ok := results["uri"]
		if !ok {
			return "", fmt.Errorf("portal response had no uri")
		}
		uri, _ := uriV.Value().(string)
		path := strings.TrimPrefix(uri, "file://")
		if p, err := url.PathUnescape(path); err == nil {
			path = p
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read screenshot %q: %w", path, err)
		}
		_ = os.Remove(path) // best-effort cleanup of the portal's temp file
		return base64.StdEncoding.EncodeToString(data), nil
	}
	return "", nil
}
