package main

import (
	"context"
	"image"
)

// recorder grabs frames from a display for a learning session. Implementations
// are platform-specific (recorder_windows.go uses go-d3d / Desktop Duplication;
// other platforms return an error from newRecorder).
//
// run blocks until ctx is cancelled, calling onTick once per capture attempt:
//
//   - changed == true:  img holds a freshly captured frame.
//   - changed == false: nothing changed since the last frame (heartbeat). img
//     still holds the last frame; the heartbeat lets the caller's settle timer
//     advance even while the screen is static (a static screen produces no new
//     frames at all from the duplication API).
//
// The *image.RGBA is owned by the recorder and reused between ticks — callers
// that need to retain a frame must copy it.
type recorder interface {
	run(ctx context.Context, onTick func(img *image.RGBA, changed bool)) error
}
