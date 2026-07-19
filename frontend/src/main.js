import { EventsOn } from "../wailsjs/runtime/runtime.js";
import { Capture, HideWindow, CancelSelection, FinishSelection } from "../wailsjs/go/main/App.js";
import * as ort from "onnxruntime-web";
import { PaddleOcrService } from "ppu-paddle-ocr/web";

// ort builds its WASM URL relative to the JS chunk by default; point it at the
// static-copied binaries in /assets/ so the webview can load them locally.
ort.env.wasm.wasmPaths = "/assets/";

// Bundled local copies of the PP-OCRv6 small models (no CDN fetch required).
const LOCAL_MODEL = {
  detection:            "/models/PP-OCRv6_small_det.ort",
  recognition:          "/models/PP-OCRv6_small_rec.ort",
  charactersDictionary: "/models/ppocrv6_dict.txt",
};

let ocrService = null;

// ── OCR ────────────────────────────────────────────────────────────────────
// Two capture paths feed OCR, depending on the platform (routed from Go):
//   • "capture:done"   — Linux/XDG portal already cropped the region natively.
//   • "capture:select" — Windows/macOS captured the whole desktop; we crop it
//                        here via a fullscreen selection overlay.

// recognize runs the OCR model on raw PNG/JPEG bytes and shows the Chinese text.
async function recognize(bytes) {
  if (!ocrService) { showStatus("OCR model still loading…"); return; }
  showStatus("Recognising…");
  try {
    const res = await ocrService.recognize(bytes.buffer);
    const han = [...res.text].filter((c) => /\p{Script=Han}/u.test(c)).join("");
    showResult(han || "(no Chinese text found)");
  } catch (err) {
    showStatus("OCR error: " + err.message);
    console.error(err);
  }
}

// runOCR handles the already-cropped image handed over as base64 (portal path).
async function runOCR(b64) {
  if (!b64) { showStatus("No image captured."); return; }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await recognize(bytes);
}

// ── Region selection overlay (Windows/macOS) ─────────────────────────────────
// Go captured the full virtual desktop and put the window in fullscreen. We show
// the image and let the user drag a rectangle; on release we crop that region
// (at native resolution) and run OCR. Escape aborts back to the tray.
function startRegionSelection(b64) {
  const overlay = document.createElement("div");
  overlay.id = "overlay";

  const img = document.createElement("img");
  img.id = "overlay-img";

  const rect = document.createElement("div");
  rect.id = "overlay-rect";
  rect.style.display = "none";

  const hint = document.createElement("div");
  hint.id = "overlay-hint";
  hint.textContent = "Glissez pour sélectionner une zone · Échap pour annuler";

  overlay.append(img, rect, hint);
  document.body.appendChild(overlay);

  // Maps displayed (viewport) coordinates back to the image's native pixels.
  let geom = null;
  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const natW = img.naturalWidth, natH = img.naturalHeight;
    if (!natW || !natH) return;
    const scale = Math.min(vw / natW, vh / natH); // object-fit: contain
    const dispW = natW * scale, dispH = natH * scale;
    const offsetX = (vw - dispW) / 2, offsetY = (vh - dispH) / 2;
    Object.assign(img.style, {
      left: offsetX + "px", top: offsetY + "px",
      width: dispW + "px", height: dispH + "px",
    });
    geom = { scale, offsetX, offsetY, natW, natH };
  }

  img.onload = layout;
  img.src = "data:image/png;base64," + b64;

  let dragging = false, startX = 0, startY = 0;

  function updateRect(x, y) {
    const l = Math.min(startX, x), t = Math.min(startY, y);
    Object.assign(rect.style, {
      left: l + "px", top: t + "px",
      width: Math.abs(x - startX) + "px", height: Math.abs(y - startY) + "px",
    });
  }

  function onDown(e) {
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    rect.style.display = "block";
    updateRect(e.clientX, e.clientY);
  }
  function onMove(e) { if (dragging) updateRect(e.clientX, e.clientY); }

  async function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const l = Math.min(startX, e.clientX), t = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
    if (w < 5 || h < 5) { rect.style.display = "none"; return; } // ignore stray clicks
    await cropAndRecognize(l, t, w, h);
  }

  async function cropAndRecognize(selL, selT, selW, selH) {
    if (!geom) { finish(); return; }
    const { scale, offsetX, offsetY, natW, natH } = geom;
    // Viewport → native pixels, clamped to the image.
    let sx = Math.max(0, Math.min((selL - offsetX) / scale, natW));
    let sy = Math.max(0, Math.min((selT - offsetY) / scale, natH));
    let sw = Math.min(selW / scale, natW - sx);
    let sh = Math.min(selH / scale, natH - sy);
    if (sw < 1 || sh < 1) { cancel(); return; } // selection fell outside the image

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    finish();
    await FinishSelection(); // Go leaves fullscreen and restores the results window

    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await recognize(new Uint8Array(await blob.arrayBuffer()));
  }

  function onKey(e) { if (e.key === "Escape") cancel(); }

  function teardown() {
    window.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", layout);
    overlay.remove();
  }
  function finish() { teardown(); }
  function cancel() { teardown(); CancelSelection(); }

  window.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", layout);
}

// ── DOM helpers ────────────────────────────────────────────────────────────
function showStatus(msg) {
  document.getElementById("status").textContent = msg;
  document.getElementById("result").textContent = "";
}

function showResult(text) {
  document.getElementById("status").textContent = "";
  document.getElementById("result").textContent = text;
}

// ── Wails wiring ───────────────────────────────────────────────────────────
EventsOn("capture:done", (b64) => runOCR(b64));
EventsOn("capture:select", (b64) => startRegionSelection(b64));

document.getElementById("capture-btn").addEventListener("click", () => Capture());

document.getElementById("copy-btn").addEventListener("click", () => {
  const text = document.getElementById("result").textContent;
  if (text) navigator.clipboard.writeText(text);
});

// × returns the window to the tray; the app keeps running. Quit from the tray.
document.getElementById("close-btn").addEventListener("click", () => HideWindow());

// ── Boot ───────────────────────────────────────────────────────────────────
(async function boot() {
  const btn = document.getElementById("capture-btn");
  btn.disabled = true;
  showStatus("Loading OCR model…");
  try {
    const svc = new PaddleOcrService({ model: LOCAL_MODEL });
    await svc.initialize();
    ocrService = svc; // only set after successful init
    btn.disabled = false;
    showStatus("Ready — press Capture");
  } catch (err) {
    showStatus("Failed to load OCR: " + err.message);
    console.error(err);
  }
})();
