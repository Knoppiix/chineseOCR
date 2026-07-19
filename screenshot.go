package main

// CaptureResult carries a captured screenshot from the platform-specific backend
// back to Capture(), which routes it to the right frontend flow.
//
// The two supported backends differ in how region selection happens:
//
//   - Linux (screenshot_linux.go) drives the XDG desktop portal, which does the
//     region selection itself and hands back an already-cropped image. NeedsSelect
//     is false — the frontend runs OCR directly.
//
//   - Windows/macOS (screenshot_other.go) use github.com/kbinani/screenshot,
//     which can only grab whole displays. Image holds the full virtual desktop
//     and NeedsSelect is true — the frontend shows a fullscreen overlay so the
//     user can draw the region, then crops before OCR.
type CaptureResult struct {
	// Image is a base64-encoded PNG.
	Image string `json:"image"`
	// NeedsSelect is true when the frontend still has to crop a region out of Image.
	NeedsSelect bool `json:"needsSelect"`
}
