//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"image"
	"runtime"
	"time"

	"github.com/kirides/go-d3d/d3d11"
	"github.com/kirides/go-d3d/outputduplication"
	"github.com/kirides/go-d3d/win"
)

// captureFPS caps how often we grab/hash a frame. The Desktop Duplication API
// only delivers frames on change, so this is an upper bound: a static screen
// costs far less. 15 is plenty for catching on-screen text.
const captureFPS = 15

// dxgiRecorder captures a single display via D3D11 IDXGIOutputDuplication.
type dxgiRecorder struct {
	display uint // display index (0 = primary)
}

func newRecorder(display int) (recorder, error) {
	if display < 0 {
		display = 0
	}
	return &dxgiRecorder{display: uint(display)}, nil
}

func (r *dxgiRecorder) run(ctx context.Context, onTick func(*image.RGBA, bool)) error {
	// D3D11/DXGI keep thread-local state, so pin this goroutine to one OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// PerMonitorV2 DPI awareness lets Windows hand back correctly-scaled frames
	// and enables DuplicateOutput1 without an app manifest.
	if win.IsValidDpiAwarenessContext(win.DpiAwarenessContextPerMonitorAwareV2) {
		_, _ = win.SetThreadDpiAwarenessContext(win.DpiAwarenessContextPerMonitorAwareV2)
	}

	device, deviceCtx, err := d3d11.NewD3D11Device()
	if err != nil {
		return fmt.Errorf("create D3D11 device: %w", err)
	}
	defer device.Release()
	defer deviceCtx.Release()

	var ddup *outputduplication.OutputDuplicator
	defer func() {
		if ddup != nil {
			ddup.Release()
		}
	}()

	var imgBuf *image.RGBA
	var lastBounds image.Rectangle
	minInterval := time.Second / captureFPS

	for {
		iterStart := time.Now()

		select {
		case <-ctx.Done():
			return nil
		default:
		}

		// (Re)create the duplicator on first run or after a loss (e.g. resolution
		// change, fullscreen mode switch, alt-tab out of a game).
		if ddup == nil {
			ddup, err = outputduplication.NewIDXGIOutputDuplication(device, deviceCtx, r.display)
			if err != nil {
				time.Sleep(minInterval)
				continue
			}
			bounds, err := ddup.GetBounds()
			if err != nil {
				ddup.Release()
				ddup = nil
				continue
			}
			if bounds != lastBounds || imgBuf == nil {
				lastBounds = bounds
				imgBuf = image.NewRGBA(bounds)
			}
		}

		err = ddup.GetImage(imgBuf, 100)
		switch {
		case err == nil:
			onTick(imgBuf, true)
		case errors.Is(err, outputduplication.ErrNoImageYet):
			onTick(imgBuf, false) // heartbeat: screen unchanged
		default:
			// Duplicator lost — drop it and rebuild on the next iteration.
			ddup.Release()
			ddup = nil
		}

		if d := time.Since(iterStart); d < minInterval {
			time.Sleep(minInterval - d)
		}
	}
}
