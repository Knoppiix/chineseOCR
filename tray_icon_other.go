//go:build !windows

package main

import (
	"bytes"
	"image/png"
)

// Linux DBus/StatusNotifierItem (and macOS) tray icons render PNG.
var trayIconBytes = trayIcon

// recordingIconBytes is the tray icon shown while a learning session records.
var recordingIconBytes = encodeRecPNG()

func encodeRecPNG() []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, recordingDot()); err != nil {
		return trayIcon // fall back to the normal icon
	}
	return buf.Bytes()
}
