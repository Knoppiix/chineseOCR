package main

import (
	"image"
	"image/color"
	"math"
)

// recIconSize is the edge length of the generated recording icon.
const recIconSize = 32

// recordingDot draws the "recording" tray icon: a filled red circle with a
// slightly darker rim, antialiased at the edge. Generated in code so no extra
// asset file has to ship (and be kept in sync) just for this state.
func recordingDot() *image.RGBA {
	const s = recIconSize
	img := image.NewRGBA(image.Rect(0, 0, s, s))
	c := (s - 1) / 2.0
	r := s/2.0 - 1.5

	for y := 0; y < s; y++ {
		for x := 0; x < s; x++ {
			d := math.Hypot(float64(x)-c, float64(y)-c)
			// Antialias over the last pixel of the radius.
			alpha := (r - d) + 0.5
			if alpha <= 0 {
				continue
			}
			if alpha > 1 {
				alpha = 1
			}
			col := color.RGBA{R: 226, G: 52, B: 52, A: uint8(alpha * 255)}
			if d > r-2 { // darker rim for contrast on light backgrounds
				col = color.RGBA{R: 150, G: 26, B: 26, A: uint8(alpha * 255)}
			}
			img.SetRGBA(x, y, col)
		}
	}
	return img
}
