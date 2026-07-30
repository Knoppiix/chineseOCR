//go:build windows

package main

// Windows tray icons must be in ICO format (systray builds an HICON from them);
// the PNG that Linux uses won't render. Use the embedded .ico.
var trayIconBytes = iconData
