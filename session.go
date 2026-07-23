package main

import (
	"fmt"
	"image"
	"image/png"
	"math/bits"
	"os"
	"path/filepath"
	"time"

	xdraw "golang.org/x/image/draw"
)

// Session tuning. These govern the cheap live filtering that runs during a
// recording session; the expensive OCR is deferred to when the session stops.
const (
	// settleDuration is how long a new on-screen state must persist before we
	// commit it. Filters out transitions/animations so we OCR settled text.
	settleDuration = 400 * time.Millisecond

	// dHash sampling grid. The frame is sampled on a hashCols×hashRows lattice
	// and horizontally-adjacent samples are compared, yielding
	// (hashCols-1)*hashRows comparison bits — which must fit in hashWords*64.
	//
	// This is the change-detection knob. A finer grid puts sample points closer
	// together so smaller, localised changes (e.g. a few characters of small
	// text) land on one; a lower hashThreshold lets fewer changed bits count as
	// "the screen changed". Both increase sensitivity — and both also make the
	// detector react more to on-screen noise (blinking cursor, a clock ticking,
	// background animations), which means more frames committed / OCR'd.
	//
	//   • Small changes missed?   Densify the grid and/or LOWER hashThreshold.
	//   • Too many frames (noise)? Coarsen the grid and/or RAISE hashThreshold.
	//
	// Reference: on 1920×1080 a 41×24 grid samples roughly every 48×45 px
	// (vs ~240×154 px for the old 9×8 grid).
	hashCols      = 41
	hashRows      = 24
	hashWords     = 16 // (41-1)*24 = 960 bits ≤ 16*64 = 1024
	hashThreshold = 4  // max differing bits still treated as "the same frame"

	// maxFrameWidth caps the stored frame width; frames are downscaled to this
	// before being written to disk, trading a little small-text fidelity for
	// much faster OCR and smaller files. Full 4K OCR would be needlessly slow.
	maxFrameWidth = 1920
)

// frameHash holds a dHash wide enough for the hashCols×hashRows sampling grid.
type frameHash [hashWords]uint64

// FrameMeta is one retained frame handed to the frontend for OCR at stop time.
type FrameMeta struct {
	Data       string `json:"data"`       // base64-encoded PNG
	DurationMs int64  `json:"durationMs"` // how long this state stayed on screen
}

// frameRecord tracks a committed frame on disk plus its on-screen lifetime.
type frameRecord struct {
	path       string
	start      time.Time
	durationMs int64
}

// sessionProcessor turns a stream of raw frames into a small set of distinct,
// settled frames written to disk. It is driven entirely from the capture
// goroutine (consider/finalize); results (frames) are read only after that
// goroutine has stopped, so it needs no internal locking.
type sessionProcessor struct {
	dir string

	// pending: a candidate new state waiting to settle.
	pendingHash  frameHash
	pendingImg   *image.RGBA
	pendingSince time.Time
	havePending  bool

	// committed: the last state we actually wrote to disk.
	committedHash frameHash
	haveCommitted bool

	frames []frameRecord
	nextID int
}

func newSessionProcessor(dir string) *sessionProcessor {
	return &sessionProcessor{dir: dir}
}

// consider ingests one capture tick. changed reports whether img is a fresh
// frame; now is the wall-clock time of the tick.
func (p *sessionProcessor) consider(img *image.RGBA, changed bool, now time.Time) {
	if changed {
		h := dhash(img)
		if !p.havePending || hamming(h, p.pendingHash) > hashThreshold {
			// A new candidate state appeared; (re)start its settle timer.
			p.pendingHash = h
			p.pendingImg = cloneRGBA(img)
			p.pendingSince = now
			p.havePending = true
		}
	}

	// Commit the pending state once it has been stable long enough.
	if p.havePending && now.Sub(p.pendingSince) >= settleDuration {
		if !p.haveCommitted || hamming(p.pendingHash, p.committedHash) > hashThreshold {
			p.commit(now)
		}
		// Whether committed or a duplicate of the last commit, this candidate
		// is resolved; wait for the next change.
		p.havePending = false
		p.pendingImg = nil
	}
}

func (p *sessionProcessor) commit(now time.Time) {
	// Close out the previous frame's on-screen duration.
	if n := len(p.frames); n > 0 {
		p.frames[n-1].durationMs = now.Sub(p.frames[n-1].start).Milliseconds()
	}

	path := filepath.Join(p.dir, fmt.Sprintf("frame_%05d.png", p.nextID))
	if err := writeFramePNG(path, p.pendingImg); err != nil {
		return // skip this frame; keep the session going
	}
	p.frames = append(p.frames, frameRecord{path: path, start: now})
	p.committedHash = p.pendingHash
	p.haveCommitted = true
	p.nextID++
}

// finalize closes the last frame's duration once capture has stopped.
func (p *sessionProcessor) finalize(now time.Time) {
	if n := len(p.frames); n > 0 && p.frames[n-1].durationMs == 0 {
		p.frames[n-1].durationMs = now.Sub(p.frames[n-1].start).Milliseconds()
	}
}

// ── image helpers ────────────────────────────────────────────────────────────

func cloneRGBA(src *image.RGBA) *image.RGBA {
	dst := image.NewRGBA(src.Bounds())
	copy(dst.Pix, src.Pix)
	return dst
}

// dhash computes a difference hash by sampling luminance on a hashCols×hashRows
// grid and comparing horizontally adjacent samples. Cheap enough to run on every
// captured frame (~hashCols*hashRows pixel reads).
func dhash(img *image.RGBA) frameHash {
	b := img.Bounds()
	dx, dy := b.Dx(), b.Dy()
	var hash frameHash
	if dx < hashCols || dy < hashRows {
		return hash
	}
	var row [hashCols]uint8
	bit := 0
	for ry := 0; ry < hashRows; ry++ {
		sy := b.Min.Y + ry*(dy-1)/(hashRows-1)
		for cx := 0; cx < hashCols; cx++ {
			sx := b.Min.X + cx*(dx-1)/(hashCols-1)
			c := img.RGBAAt(sx, sy)
			row[cx] = uint8((uint32(c.R) + uint32(c.G) + uint32(c.B)) / 3)
		}
		for cx := 0; cx < hashCols-1; cx++ {
			if row[cx] < row[cx+1] {
				hash[bit>>6] |= 1 << uint(bit&63)
			}
			bit++
		}
	}
	return hash
}

func hamming(a, b frameHash) int {
	n := 0
	for i := 0; i < hashWords; i++ {
		n += bits.OnesCount64(a[i] ^ b[i])
	}
	return n
}

// writeFramePNG downscales src to at most maxFrameWidth wide (preserving aspect)
// and writes it as a PNG.
func writeFramePNG(path string, src *image.RGBA) error {
	b := src.Bounds()
	dw, dh := b.Dx(), b.Dy()
	if dw > maxFrameWidth {
		dh = dh * maxFrameWidth / dw
		dw = maxFrameWidth
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, xdraw.Over, nil)

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, dst)
}
