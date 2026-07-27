package main

// cursorPos is the mouse position (physical pixels) pushed to the frontend while
// the overlay is active, via the "overlay:cursor" event. The frontend subtracts
// the captured display's origin and hit-tests against the OCR word boxes.
type cursorPos struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// overlayFrame is the snapshot handed to the frontend when the overlay opens
// (the "overlay:analyze" event): a base64 PNG of the captured display plus that
// display's top-left origin in virtual-screen coordinates, so the frontend can
// map cursor positions (screen space) to image/box coordinates.
type overlayFrame struct {
	Image   string `json:"image"`
	OriginX int    `json:"originX"`
	OriginY int    `json:"originY"`
	Width   int    `json:"width"`  // captured display width in the cursor's coord space
	Height  int    `json:"height"` // captured display height in the cursor's coord space
}
