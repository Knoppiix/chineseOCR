//go:build !linux

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image/png"
	"time"

	"github.com/kbinani/screenshot"
)

// windowHideSettle gives the OS a moment to actually hide our window after
// Capture() calls WindowHide before we grab pixels. WindowHide is asynchronous
// and kbinani captures immediately (unlike the interactive XDG portal, which the
// user drives later), so without this the just-hidden window can still end up in
// the screenshot when Capture is triggered from the visible UI button.
const windowHideSettle = 300 * time.Millisecond

// captureScreenshot on Windows/macOS uses github.com/kbinani/screenshot, which
// grabs whole displays only — it has no interactive region picker. We capture
// the chosen display and hand it to the frontend with NeedsSelect=true; the
// frontend shows a fullscreen overlay, lets the user draw a region, and crops
// before OCR.
func captureScreenshot(display int) (*CaptureResult, error) {
	time.Sleep(windowHideSettle) // let WindowHide take effect first

	n := screenshot.NumActiveDisplays()
	if n <= 0 {
		return nil, fmt.Errorf("no active displays found")
	}
	if display < 0 || display >= n {
		display = 0
	}

	img, err := screenshot.CaptureRect(screenshot.GetDisplayBounds(display))
	if err != nil {
		return nil, fmt.Errorf("capture display %d: %w", display, err)
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return &CaptureResult{
		Image:       base64.StdEncoding.EncodeToString(buf.Bytes()),
		NeedsSelect: true,
	}, nil
}
