//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
)

// Windows tray icons must be in ICO format (systray builds an HICON from them);
// the PNG that Linux uses won't render. Use the embedded .ico.
var trayIconBytes = iconData

// recordingIconBytes is the tray icon shown while a learning session records.
var recordingIconBytes = encodeICO()

// encodeICO wraps the generated recording dot in a single-image .ico using an
// uncompressed 32-bit BGRA DIB — the format every Windows version accepts (a
// PNG-compressed ICO would need Vista+ and is riskier for no gain here).
func encodeICO() []byte {
	img := recordingDot()
	const s = recIconSize
	const xorLen = s * s * 4 // BGRA pixels
	const andLen = s * 4     // 1bpp mask, rows padded to 4 bytes
	const dibLen = 40 + xorLen + andLen

	buf := &bytes.Buffer{}
	le := func(v any) { _ = binary.Write(buf, binary.LittleEndian, v) }

	// ICONDIR
	le(uint16(0)) // reserved
	le(uint16(1)) // type: icon
	le(uint16(1)) // image count

	// ICONDIRENTRY
	buf.WriteByte(s) // width
	buf.WriteByte(s) // height
	buf.WriteByte(0) // palette colours (0 = truecolour)
	buf.WriteByte(0) // reserved
	le(uint16(1))    // colour planes
	le(uint16(32))   // bits per pixel
	le(uint32(dibLen))
	le(uint32(22)) // offset: 6 (ICONDIR) + 16 (this entry)

	// BITMAPINFOHEADER — height is doubled to cover the XOR + AND masks.
	le(uint32(40))
	le(int32(s))
	le(int32(s * 2))
	le(uint16(1))
	le(uint16(32))
	le(uint32(0)) // BI_RGB
	le(uint32(xorLen + andLen))
	le(int32(0))
	le(int32(0))
	le(uint32(0))
	le(uint32(0))

	// XOR bitmap: BGRA, bottom-up.
	for y := s - 1; y >= 0; y-- {
		for x := 0; x < s; x++ {
			c := img.RGBAAt(x, y)
			buf.WriteByte(c.B)
			buf.WriteByte(c.G)
			buf.WriteByte(c.R)
			buf.WriteByte(c.A)
		}
	}
	// AND mask: zeroed — transparency comes from the alpha channel above.
	buf.Write(make([]byte, andLen))

	return buf.Bytes()
}
