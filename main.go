package main

import (
	"embed"
	"net/http"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed assets/icon.ico
var iconData []byte

// trayIcon is a PNG (not .ico): Linux DBus/StatusNotifierItem trays render PNG.
//
//go:embed assets/icon.png
var trayIcon []byte

func main() {
	app := NewApp()
	wails.Run(&options.App{ //nolint:errcheck
		Title:     "Chinese OCR",
		Width:     480,
		Height:    300,
		Frameless: true,
		// Tray-driven app: start hidden (tray icon only), and the window's
		// close hides it back to the tray instead of quitting. Quit from the tray.
		StartHidden:       true,
		HideWindowOnClose: true,
		BackgroundColour:  &options.RGBA{R: 0, G: 0, B: 0, A: 0},
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: coopCoepMiddleware,
		},
		Linux: &linux.Options{
			Icon:                iconData,
			WindowIsTranslucent: true,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	})
}

// coopCoepMiddleware injects Cross-Origin-Isolation headers so SharedArrayBuffer
// is available, enabling ONNX Runtime to use multi-threaded WASM.
func coopCoepMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		// credentialless (not require-corp) allows cross-origin CDN fetches
		// (e.g. ppu-paddle-ocr model downloads) while still enabling SharedArrayBuffer.
		w.Header().Set("Cross-Origin-Embedder-Policy", "credentialless")
		next.ServeHTTP(w, r)
	})
}
