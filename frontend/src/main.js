import { EventsOn } from "../wailsjs/runtime/runtime.js";
import { Capture, HideWindow, CancelSelection, FinishSelection, ClearSession, SessionFrame, GetView, SaveCSV, GetConfig, UpdateConfig, ListDicts, DisplayCount, CloseSettings } from "../wailsjs/go/main/App.js";
import * as ort from "onnxruntime-web";
import { PaddleOcrService } from "ppu-paddle-ocr/web";
import { loadDictionary, lookup } from "./dict.js";

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

// charAdvance approximates a character's relative horizontal width, so that
// subdividing a detected region into per-word boxes tracks real glyph positions
// even on mixed lines: full-width CJK = 1, half-width ASCII ≈ 0.5, spaces less.
// Uniform (width/n) subdivision drifts whenever a line isn't pure Han.
function charAdvance(ch) {
  if (ch === " " || ch === "\t") return 0.4;
  const code = ch.codePointAt(0);
  if ((code >= 0x2e80 && code <= 0x9fff) || // CJK (radicals … unified)
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
      (code >= 0xff00 && code <= 0xffef) || // full-width forms
      (code >= 0x3000 && code <= 0x303f)) {  // CJK symbols & punctuation
    return 1;
  }
  return 0.5; // half-width latin / digits / punctuation
}

// segmentWordsWithSpans is like segmentWords but also reports each word's
// character span (UTF-16 offsets) within the line, so the overlay can carve a
// per-word sub-box out of the line's bounding box.
function segmentWordsWithSpans(line) {
  const out = [];
  if (!wordSeg) {
    for (let i = 0; i < line.length; i++) {
      if (isHan(line[i])) out.push({ word: line[i], start: i, end: i + 1 });
    }
    return out;
  }
  for (const s of wordSeg.segment(line)) {
    if (s.isWordLike && [...s.segment].some(isHan)) {
      out.push({ word: s.segment, start: s.index, end: s.index + s.segment.length });
    }
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
  hint.innerHTML =
    'Glissez pour sélectionner une zone &nbsp;·&nbsp; <kbd>Échap</kbd> pour annuler';

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
  // Go has already switched us to the session view (view:change); just reset the
  // sub-state so a previous summary never flashes before the new progress bar.
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

// summaryToCSV serialises the current tally as CSV (sorted by count, desc).
// A UTF-8 BOM is prepended so Excel opens the Chinese text correctly.
function summaryToCSV() {
  const rows = [...(sessionTally?.entries() ?? [])]
    .map(([word, e]) => ({ word, count: e.count, sec: e.ms / 1000 }))
    .sort((a, b) => b.count - a.count);
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ["Word,Count,SecondsOnScreen"];
  for (const r of rows) lines.push(`${cell(r.word)},${r.count},${r.sec.toFixed(1)}`);
  const bom = String.fromCharCode(0xfeff); // UTF-8 BOM so Excel reads UTF-8
  return bom + lines.join("\r\n") + "\r\n";
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

// ── Hover-lookup overlay ─────────────────────────────────────────────────────
// Go captured the screen (overlay:analyze) and streams the cursor (overlay:cursor,
// physical px). We OCR the snapshot once, segment each detected line into words,
// carve a per-word sub-box out of the line box, and look each word up. Hit-test
// happens here (the click-through window gets no DOM mouse events).
let overlayWords = [];              // [{ box:{x,y,w,h} image px, word, pinyin, senses }]
let overlayOrigin = { x: 0, y: 0 }; // captured display's origin (cursor coord space)
// Coordinate spaces can differ (DPI virtualisation): OCR boxes are in the decoded
// image's pixels, the cursor is in Go's GetDisplayBounds space, and the DOM is in
// CSS px. We rescale between them from measured sizes rather than assuming.
let overlayGoW = 1, overlayGoH = 1;   // display size in the cursor's coord space
let overlayImgW = 1, overlayImgH = 1; // decoded image size (box coord space)

// Runtime settings, loaded from Go config at boot (see GetConfig / config:change).
let overlayMinConfidence = 0.7;             // hide OCR regions below this confidence
let overlayDictPath = "/dicts/cedict_ts.u8"; // dictionary served path

async function analyzeOverlay({ image, originX, originY, width, height }) {
  overlayOrigin = { x: originX, y: originY };
  overlayWords = [];
  overlayGoW = width || 1;
  overlayGoH = height || 1;
  overlayImgW = overlayGoW; // until the image decodes (scale 1 fallback)
  overlayImgH = overlayGoH;
  hideOverlayCard();

  const dpr = window.devicePixelRatio || 1;
  console.log(`[overlay] analyze: origin(${originX},${originY}) go-size(${width}x${height}) inner(${window.innerWidth}x${window.innerHeight}) dpr=${dpr}`); // DEBUG
  const probe = new Image();
  probe.onload = () => {
    overlayImgW = probe.naturalWidth;
    overlayImgH = probe.naturalHeight;
    console.log(`[overlay] image natural=${overlayImgW}x${overlayImgH} → cursorScale=${(overlayImgW / overlayGoW).toFixed(3)} cardScale=${(window.innerWidth / overlayImgW).toFixed(3)}`); // DEBUG
  };
  probe.src = "data:image/png;base64," + image;
  if (!ocrService) return;

  try {
    await loadDictionary(overlayDictPath);
    const res = await ocrService.recognize(b64ToBytes(image).buffer);
    const items = (res.lines ?? []).flat();
    console.log(`[overlay] OCR: ${items.length} regions`); // DEBUG
    for (const item of items) {
      const text = item.text ?? "";
      const box = item.box;
      if (!box || !text) continue;
      if ((item.confidence ?? 1) < overlayMinConfidence) continue; // low-confidence → skip
      // Cumulative advance before each character (UTF-16 units, matching the
      // segmenter's .index) so word sub-boxes track real positions on mixed lines.
      const cum = [0];
      for (let i = 0; i < text.length; i++) cum.push(cum[i] + charAdvance(text[i]));
      const total = cum[text.length] || 1;
      for (const w of segmentWordsWithSpans(text)) {
        const entry = lookup(w.word);
        overlayWords.push({
          box: {
            x: box.x + (box.width * cum[w.start]) / total,
            y: box.y,
            w: (box.width * (cum[w.end] - cum[w.start])) / total,
            h: box.height,
          },
          word: w.word,
          pinyin: entry?.pinyin ?? "",
          senses: entry?.senses ?? [],
        });
      }
    }
    console.log(`[overlay] ${overlayWords.length} words indexed`); // DEBUG
    if (overlayWords.length) { // DEBUG: first word's box in image coords
      const w0 = overlayWords[0];
      console.log(`[overlay] word0 "${w0.word}" box img x=${w0.box.x.toFixed(0)} y=${w0.box.y.toFixed(0)} w=${w0.box.w.toFixed(0)} h=${w0.box.h.toFixed(0)}`);
    }
    drawDebugBoxes(); // DEBUG
  } catch (err) {
    console.error("overlay analyze", err);
  }
}

let _lastCurLog = 0;
function onOverlayCursor({ x, y }) {
  // Cursor (Go/GetDisplayBounds space) → image/box space.
  const ix = (x - overlayOrigin.x) * (overlayImgW / overlayGoW);
  const iy = (y - overlayOrigin.y) * (overlayImgH / overlayGoH);
  const hit = overlayWords.find(
    (w) => ix >= w.box.x && ix <= w.box.x + w.box.w && iy >= w.box.y && iy <= w.box.y + w.box.h,
  );
  const now = Date.now(); // DEBUG (throttled)
  if (now - _lastCurLog > 250) {
    _lastCurLog = now;
    let extra = `hit=${hit ? hit.word : "—"}`;
    if (!hit && overlayWords.length) {
      let best = null, bd = Infinity;
      for (const w of overlayWords) {
        const d = Math.hypot(w.box.x + w.box.w / 2 - ix, w.box.y + w.box.h / 2 - iy);
        if (d < bd) { bd = d; best = w; }
      }
      if (best) {
        extra += ` nearest="${best.word}" box(${best.box.x.toFixed(0)},${best.box.y.toFixed(0)},${best.box.w.toFixed(0)}x${best.box.h.toFixed(0)}) d=(${(best.box.x - ix).toFixed(0)},${(best.box.y - iy).toFixed(0)})`;
      }
    }
    console.log(`[overlay] cur screen(${x},${y}) img(${ix.toFixed(0)},${iy.toFixed(0)}) ${extra}`);
  }
  if (hit) showOverlayCard(hit); else hideOverlayCard();
}

function showOverlayCard(w) {
  const card = document.getElementById("overlay-card");
  card.querySelector(".oc-word").textContent = w.word;
  card.querySelector(".oc-pinyin").textContent = w.pinyin || "—";
  card.querySelector(".oc-sense").textContent =
    w.senses.length ? w.senses.slice(0, 4).join("; ") : "(not in dictionary)";
  // Image/box space → CSS px (the overlay window spans innerWidth CSS px).
  const sx = window.innerWidth / overlayImgW;
  const sy = window.innerHeight / overlayImgH;
  card.style.left = `${w.box.x * sx}px`;
  card.style.top = `${(w.box.y + w.box.h) * sy + 4}px`;
  card.hidden = false;
}

function hideOverlayCard() {
  document.getElementById("overlay-card").hidden = true;
}

// DEBUG: draw each hit-box over the text (image space → CSS), to see the offset.
function drawDebugBoxes() {
  const layer = document.getElementById("overlay-debug");
  layer.textContent = "";
  const sx = window.innerWidth / overlayImgW;
  const sy = window.innerHeight / overlayImgH;
  for (const w of overlayWords) {
    const d = document.createElement("div");
    d.className = "dbg-box";
    d.style.left = `${w.box.x * sx}px`;
    d.style.top = `${w.box.y * sy}px`;
    d.style.width = `${w.box.w * sx}px`;
    d.style.height = `${w.box.h * sy}px`;
    layer.appendChild(d);
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

// ── Views ────────────────────────────────────────────────────────────────────
// Go owns the current view and pushes it via "view:change"; the frontend is a
// pure function of it — show exactly this view's container, hide the rest. A new
// mode = a new container + a branch here.
function applyView(view) {
  const isOverlay = view === "overlay";
  document.getElementById("content").hidden = view !== "capture";
  document.getElementById("session-view").hidden = view !== "session";
  document.getElementById("overlay-view").hidden = !isOverlay;
  document.getElementById("settings-view").hidden = view !== "settings";
  // The in-app titlebar must vanish in overlay mode (only the cards should show).
  document.getElementById("titlebar").hidden = false;
  // Transparent page background only in overlay mode (so the game shows through).
  document.body.classList.toggle("view-overlay", isOverlay);
  if (!isOverlay) {
    document.getElementById("overlay-card").hidden = true;
    document.getElementById("overlay-debug").textContent = ""; // DEBUG: clear hit-boxes
  }
  if (view === "settings") renderSettings();
}

// ── Settings form ────────────────────────────────────────────────────────────
let currentConfig = null;
let settingsWired = false;

async function renderSettings() {
  if (!currentConfig) {
    try { currentConfig = await GetConfig(); } catch (e) { console.error(e); }
  }
  const cfg = currentConfig || {};

  const dictSel = document.getElementById("set-dict");
  try {
    const dicts = await ListDicts();
    dictSel.innerHTML = "";
    for (const name of dicts) {
      const o = document.createElement("option");
      o.value = "/dicts/" + name;
      o.textContent = name;
      dictSel.appendChild(o);
    }
  } catch (e) { console.error(e); }
  if (cfg.dictPath) dictSel.value = cfg.dictPath;

  const dispSel = document.getElementById("set-display");
  try {
    const n = Math.max(1, await DisplayCount());
    dispSel.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `Display ${i}`;
      dispSel.appendChild(o);
    }
  } catch (e) { console.error(e); }
  dispSel.value = String(cfg.captureDisplay ?? 0);

  document.getElementById("set-hk-overlay").value = cfg.overlayHotkey || "";
  document.getElementById("set-hk-capture").value = cfg.captureHotkey || "";
  const conf = document.getElementById("set-conf");
  conf.value = String(cfg.overlayMinConfidence ?? 0.7);
  document.getElementById("set-conf-val").textContent = Number(conf.value).toFixed(2);
  document.getElementById("set-maxside").value = String(cfg.detectionMaxSide ?? 0);
  setSettingsMsg("");

  if (!settingsWired) { wireSettings(); settingsWired = true; }
}

function wireSettings() {
  const save = async (patch) => {
    const next = { ...currentConfig, ...patch };
    try {
      await UpdateConfig(next);
      currentConfig = next;
      setSettingsMsg("Saved ✓");
    } catch (err) {
      setSettingsMsg(String(err.message || err), true);
      try { await UpdateConfig(currentConfig); } catch (_) {} // re-apply last-good (restores hotkeys)
      renderSettings();
    }
  };

  document.getElementById("set-dict").addEventListener("change", (e) => save({ dictPath: e.target.value }));
  document.getElementById("set-display").addEventListener("change", (e) => save({ captureDisplay: parseInt(e.target.value, 10) }));
  document.getElementById("set-maxside").addEventListener("change", (e) => save({ detectionMaxSide: parseInt(e.target.value, 10) }));

  const conf = document.getElementById("set-conf");
  conf.addEventListener("input", () => { document.getElementById("set-conf-val").textContent = Number(conf.value).toFixed(2); });
  conf.addEventListener("change", () => save({ overlayMinConfidence: Number(conf.value) }));

  wireHotkeyInput("set-hk-overlay", "overlayHotkey", save);
  wireHotkeyInput("set-hk-capture", "captureHotkey", save);
  document.getElementById("set-close").addEventListener("click", () => CloseSettings());
}

// wireHotkeyInput turns a readonly text field into a shortcut recorder.
function wireHotkeyInput(id, field, save) {
  const input = document.getElementById(id);
  input.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (e.key === "Escape") { input.blur(); return; }
    if (e.key === "Backspace" || e.key === "Delete") { input.value = ""; save({ [field]: "" }); return; }
    const k = codeToKey(e.code);
    if (!k) return; // waiting for a non-modifier key
    const parts = [];
    if (e.ctrlKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
    if (e.metaKey) parts.push("win");
    parts.push(k);
    const spec = parts.join("+");
    input.value = spec;
    save({ [field]: spec });
  });
}

function codeToKey(code) {
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === "Space") return "space";
  if (code === "Enter") return "enter";
  return null;
}

function setSettingsMsg(text, isErr = false) {
  const el = document.getElementById("set-msg");
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

EventsOn("overlay:analyze", (frame) => analyzeOverlay(frame));
EventsOn("overlay:cursor", (pos) => onOverlayCursor(pos));

// ── Wails wiring ───────────────────────────────────────────────────────────
EventsOn("capture:done", (b64) => runOCR(b64));
EventsOn("capture:select", (b64) => startRegionSelection(b64));
EventsOn("session:stopped", (count) => processSession(count));
EventsOn("session:error", (msg) => showStatus("Session error: " + msg));
EventsOn("view:change", (view) => applyView(view));

// Live-apply settings changed from the (upcoming) settings UI. Hotkeys are
// hot-swapped in Go; here we pick up the values the frontend owns.
EventsOn("config:change", (cfg) => {
  if (!cfg) return;
  currentConfig = cfg;
  if (typeof cfg.overlayMinConfidence === "number") overlayMinConfidence = cfg.overlayMinConfidence;
  if (cfg.dictPath) overlayDictPath = cfg.dictPath; // reloaded on next overlay analyze
});

// Sync to Go's current view on load so the window never opens on a stale view.
GetView().then(applyView).catch((err) => console.error(err));

document.getElementById("capture-btn").addEventListener("click", () => Capture());

document.getElementById("copy-btn").addEventListener("click", () => {
  const text = document.getElementById("result").textContent;
  if (text) navigator.clipboard.writeText(text);
});

document.getElementById("sort-count").addEventListener("click", () => renderSummary("count"));
document.getElementById("sort-time").addEventListener("click", () => renderSummary("time"));

// Export the summary as a CSV via the native save dialog (Go writes the file).
document.getElementById("export-csv").addEventListener("click", async () => {
  if (!sessionTally || sessionTally.size === 0) return;
  try {
    await SaveCSV("chinese-session-summary.csv", summaryToCSV());
  } catch (err) {
    console.error("export csv", err);
  }
});

// Done: drop the on-disk frames and return to the capture view (ClearSession
// switches the view via Go's "view:change"), then hide to the tray.
document.getElementById("session-done").addEventListener("click", async () => {
  try { await ClearSession(); } catch (err) { console.error(err); }
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
    // Load persisted settings (falls back to the defaults above on failure).
    let cfgMaxSide = 0;
    try {
      const cfg = await GetConfig();
      if (cfg) {
        currentConfig = cfg;
        if (typeof cfg.overlayMinConfidence === "number") overlayMinConfidence = cfg.overlayMinConfidence;
        if (cfg.dictPath) overlayDictPath = cfg.dictPath;
        if (cfg.detectionMaxSide > 0) cfgMaxSide = cfg.detectionMaxSide;
      }
    } catch (e) { console.error("GetConfig", e); }

    // The detector downscales its input to maxSideLength before finding text
    // (default 640 — far too low for a full screen, so most text is missed).
    // Match the display's native pixel resolution, capped to keep WASM detection
    // from blowing up on 4K+ screens (unless the user overrides it in settings).
    const DETECT_MAX_CAP = 2560;
    const nativeMax = Math.round(Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1));
    const maxSideLength = cfgMaxSide || Math.min(nativeMax, DETECT_MAX_CAP);
    console.log(`[ocr] detection maxSideLength = ${maxSideLength}`); // DEBUG
    // paddingHorizontal defaults to 0.6 (× line height), which extends each
    // detected box ~0.6 char-widths left of the real text and throws off the
    // per-word sub-box alignment (hover lands one word too far left). Hug the
    // text horizontally so the overlay boxes line up.
    const svc = new PaddleOcrService({
      model: LOCAL_MODEL,
      detection: { maxSideLength, paddingHorizontal: 0 },
    });
    await svc.initialize();
    ocrService = svc; // only set after successful init
    btn.disabled = false;
    showStatus("Ready — press Capture");
  } catch (err) {
    showStatus("Failed to load OCR: " + err.message);
    console.error(err);
  }
})();
