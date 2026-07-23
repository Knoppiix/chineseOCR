import { EventsOn } from "../wailsjs/runtime/runtime.js";
import { Capture, HideWindow, CancelSelection, FinishSelection, ClearSession, SessionFrame } from "../wailsjs/go/main/App.js";
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

const isHan = (c) => /\p{Script=Han}/u.test(c);

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ocrText runs the model on raw image bytes and returns the recognised text.
async function ocrText(bytes) {
  if (!ocrService) throw new Error("OCR model not loaded yet");
  const res = await ocrService.recognize(bytes.buffer);
  return res.text || "";
}

// recognize handles a single already-cropped image (portal / overlay path) and
// shows the Chinese text in the results card.
async function recognize(bytes) {
  if (!ocrService) { showStatus("OCR model still loading…"); return; }
  showStatus("Recognising…");
  try {
    const han = [...(await ocrText(bytes))].filter(isHan).join("");
    showResult(han || "(no Chinese text found)");
  } catch (err) {
    showStatus("OCR error: " + err.message);
    console.error(err);
  }
}

// runOCR handles the already-cropped image handed over as base64 (portal path).
async function runOCR(b64) {
  if (!b64) { showStatus("No image captured."); return; }
  await recognize(b64ToBytes(b64));
}

// ── Word segmentation ─────────────────────────────────────────────────────────
// Chinese has no spaces between words, so the OCR gives us character runs per
// line; we split those into meaningful words with the browser's built-in ICU
// segmenter (present in WebView2 / Chromium). Falls back to per-character.
const wordSeg = "Segmenter" in Intl ? new Intl.Segmenter("zh", { granularity: "word" }) : null;

// Optional OCR-noise filter — IMPLEMENTED BUT OFF by default. Flip
// ENABLE_CONFIDENCE_FILTER to true to drop low-confidence recognised items
// before segmentation (trims garbage tokens from badly-read lines).
const ENABLE_CONFIDENCE_FILTER = false;
const MIN_OCR_CONFIDENCE = 0.6;
const keepItem = (it) => !ENABLE_CONFIDENCE_FILTER || (it?.confidence ?? 1) >= MIN_OCR_CONFIDENCE;

// ocrLines runs the model and returns the recognised text grouped by line, with
// character order preserved (word segmentation needs adjacent characters). We
// segment each line separately so no word straddles a line boundary.
async function ocrLines(bytes) {
  if (!ocrService) throw new Error("OCR model not loaded yet");
  const res = await ocrService.recognize(bytes.buffer);
  if (Array.isArray(res.lines)) {
    return res.lines.map((line) => line.filter(keepItem).map((it) => it.text).join(""));
  }
  return [res.text || ""]; // fallback if the build doesn't expose per-line data
}

// segmentWords splits one line into words that contain Chinese characters.
function segmentWords(line) {
  if (!wordSeg) return [...line].filter(isHan); // fallback: per character
  const out = [];
  for (const s of wordSeg.segment(line)) {
    if (s.isWordLike && [...s.segment].some(isHan)) out.push(s.segment);
  }
  return out;
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

// ── Learning session summary ─────────────────────────────────────────────────
// The session capture + dedup happened natively (Go); on stop we get a frame
// count and pull each retained frame, OCR it here, segment the lines into words,
// and tally the most-shown Chinese words by occurrence count and on-screen time.
let sessionTally = null; // Map<word, {count, ms}>

async function processSession(count) {
  document.getElementById("content").hidden = true;
  document.getElementById("session-view").hidden = false;
  document.getElementById("session-progress-wrap").hidden = false;
  document.getElementById("session-summary").hidden = true;

  const progress = document.getElementById("session-progress");
  const bar = document.getElementById("session-bar");
  const tally = new Map();

  if (!count) {
    progress.textContent =
      "No frames captured — the screen never changed, or recording isn't supported here.";
  }

  for (let i = 0; i < count; i++) {
    progress.textContent = `Analysing frame ${i + 1} / ${count}…`;
    bar.style.width = `${Math.round((i / count) * 100)}%`;
    try {
      const meta = await SessionFrame(i);
      const lines = await ocrLines(b64ToBytes(meta.data));
      // Count each distinct word once per frame; add the frame's on-screen time
      // so a word shown longer ranks higher when sorting by time.
      const words = new Set(lines.flatMap(segmentWords));
      for (const w of words) {
        const e = tally.get(w) || { count: 0, ms: 0 };
        e.count += 1;
        e.ms += meta.durationMs || 0;
        tally.set(w, e);
      }
    } catch (err) {
      console.error("session frame", i, err);
    }
  }
  bar.style.width = "100%";
  sessionTally = tally;
  renderSummary("count");
}

function renderSummary(sortKey) {
  document.getElementById("session-progress-wrap").hidden = true;
  document.getElementById("session-summary").hidden = false;

  const rows = [...(sessionTally?.entries() ?? [])].map(([word, e]) => ({
    word, count: e.count, ms: e.ms,
  }));
  rows.sort((a, b) => (sortKey === "time" ? b.ms - a.ms : b.count - a.count));

  document.getElementById("summary-title").textContent = rows.length
    ? `${rows.length} distinct Chinese words`
    : "No Chinese words found";

  const tbody = document.getElementById("summary-body");
  tbody.textContent = "";
  for (const r of rows) {
    const tr = document.createElement("tr");

    const hz = document.createElement("td"); hz.className = "hz"; hz.textContent = r.word;
    const cnt = document.createElement("td"); cnt.textContent = String(r.count);
    const dur = document.createElement("td"); dur.textContent = `${(r.ms / 1000).toFixed(1)}s`;

    const copyTd = document.createElement("td");
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-word";
    copyBtn.textContent = "📋";
    copyBtn.title = `Copy “${r.word}”`;
    copyBtn.addEventListener("click", () => copyWord(copyBtn, r.word));
    copyTd.appendChild(copyBtn);

    tr.append(hz, cnt, dur, copyTd);
    tbody.appendChild(tr);
  }
  document.getElementById("sort-count").classList.toggle("active", sortKey !== "time");
  document.getElementById("sort-time").classList.toggle("active", sortKey === "time");
}

// copyWord copies a word to the clipboard with brief in-button feedback.
async function copyWord(btn, word) {
  try {
    await navigator.clipboard.writeText(word);
    btn.textContent = "✓";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "📋"; btn.classList.remove("copied"); }, 900);
  } catch (err) {
    console.error("copy word", err);
  }
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
EventsOn("session:stopped", (count) => processSession(count));
EventsOn("session:error", (msg) => showStatus("Session error: " + msg));

document.getElementById("capture-btn").addEventListener("click", () => Capture());

document.getElementById("copy-btn").addEventListener("click", () => {
  const text = document.getElementById("result").textContent;
  if (text) navigator.clipboard.writeText(text);
});

document.getElementById("sort-count").addEventListener("click", () => renderSummary("count"));
document.getElementById("sort-time").addEventListener("click", () => renderSummary("time"));

// Done: drop the on-disk frames, return to the results card, hide to tray.
document.getElementById("session-done").addEventListener("click", async () => {
  try { await ClearSession(); } catch (err) { console.error(err); }
  document.getElementById("session-view").hidden = true;
  document.getElementById("content").hidden = false;
  HideWindow();
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
