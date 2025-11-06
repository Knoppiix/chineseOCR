package main

import (
	"embed"
	"fmt"
	"github.com/getlantern/systray"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed assets/icon.ico
var iconData []byte

func main() {
	systray.Run(onReady, onExit)
}

func onReady() {
	systray.SetIcon(iconData) // []byte from embedded asset
	systray.SetTitle("OCR App")
	systray.SetTooltip("OCR Screenshot App")

	// Add menu items
	mOpen := systray.AddMenuItem("Open UI", "Open the main window")
	mQuit := systray.AddMenuItem("Quit", "Quit the app")

	go func() {
		for {
			select {
			case <-mOpen.ClickedCh:
				fmt.Println("Open UI clicked")
				// Here you can call a Wails function to show your main window
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func onExit() {
	fmt.Println("Tray closed.")
}
