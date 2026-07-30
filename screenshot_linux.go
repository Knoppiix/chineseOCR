//go:build linux

package main

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync/atomic"

	"github.com/godbus/dbus/v5"
)

// captureScreenshot on Linux drives the desktop's native screenshot picker via
// the XDG portal. The portal does the interactive region selection itself and
// returns an already-cropped PNG, so NeedsSelect is false and no in-app overlay
// is needed. This works on Wayland and on X11 desktops that ship an
// xdg-desktop-portal backend (GNOME, KDE, wlroots, …).
//
// Selection is done by the OS — not a webview overlay — so it is unaffected by
// the WebKitGTK HiDPI/Wayland fullscreen scaling bug that broke the in-app
// overlay on Linux.
//
// Returns (nil, nil) if the user cancels. The display argument is ignored: the
// XDG portal lets the user pick the area (and screen) interactively.
func captureScreenshot(_ int) (*CaptureResult, error) {
	b64, err := captureRegionViaPortal()
	if err != nil {
		return nil, err
	}
	if b64 == "" {
		return nil, nil // user cancelled
	}
	return &CaptureResult{Image: b64, NeedsSelect: false}, nil
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
