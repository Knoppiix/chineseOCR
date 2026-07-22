//go:build !linux

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/draw"
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
// the full virtual desktop (all displays stitched into one image) and hand it to
// the frontend with NeedsSelect=true; the frontend shows a fullscreen overlay,
// lets the user draw a region, and crops before OCR.
func captureScreenshot() (*CaptureResult, error) {
	time.Sleep(windowHideSettle) // let WindowHide take effect first

	img, err := captureVirtualDesktop()
	if err != nil {
		return nil, err
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

// captureVirtualDesktop returns a single image covering the bounding box of every
// active display, so multi-monitor setups are captured in full. Each display is
// grabbed at its native resolution and blitted into its place in the virtual
// coordinate space.
func captureVirtualDesktop() (*image.RGBA, error) {
	n := screenshot.NumActiveDisplays()
	if n <= 0 {
		return nil, fmt.Errorf("no active displays found")
	}

	// Bounding box of all displays in virtual-screen coordinates (origins can be
	// negative for monitors positioned left of / above the primary display).
	bounds := screenshot.GetDisplayBounds(0)
	for i := 1; i < n; i++ {
		bounds = bounds.Union(screenshot.GetDisplayBounds(i))
	}

	canvas := image.NewRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	for i := 0; i < n; i++ {
		db := screenshot.GetDisplayBounds(i)
		shot, err := screenshot.CaptureRect(db)
		if err != nil {
			return nil, fmt.Errorf("capture display %d: %w", i, err)
		}
		// Blit each display into its slot, offset so the virtual origin
		// (bounds.Min) maps to the canvas origin (0,0).
		dst := image.Rect(
			db.Min.X-bounds.Min.X, db.Min.Y-bounds.Min.Y,
			db.Max.X-bounds.Min.X, db.Max.Y-bounds.Min.Y,
		)
		draw.Draw(canvas, dst, shot, shot.Rect.Min, draw.Src)
	}
	return canvas, nil
}
