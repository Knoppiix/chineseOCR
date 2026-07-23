//go:build !windows

package main

import "errors"

// newRecorder is unsupported off Windows: screen-recording sessions rely on the
// D3D11 Desktop Duplication API (via go-d3d), which is Windows-only. macOS
// (ScreenCaptureKit) and Linux (PipeWire) would each need their own backend.
func newRecorder() (recorder, error) {
	return nil, errors.New("screen-recording sessions are only supported on Windows")
}
