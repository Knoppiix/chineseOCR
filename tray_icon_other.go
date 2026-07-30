//go:build !windows

package main

// Linux DBus/StatusNotifierItem (and macOS) tray icons render PNG.
var trayIconBytes = trayIcon
