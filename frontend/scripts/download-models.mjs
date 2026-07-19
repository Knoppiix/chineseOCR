// Downloads the PP-OCRv6 small model files into public/models/ so vite can serve
// them at /models/ (see main.js LOCAL_MODEL). These files are ~30 MB total and
// are gitignored, so a fresh clone has none — this script fetches them on demand.
//
// URLs come from ppu-paddle-ocr's model-catalogue (V6_SMALL_MODEL). The .ort
// weights live behind Git LFS (media.githubusercontent.com); the dict is plain.
//
// Runs automatically via the predev/prebuild npm hooks, and can be invoked
// directly with `npm run models`. Existing files are skipped; pass --force to
// re-download.

import { createWriteStream } from "node:fs";
import { mkdir, stat, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODEL_BASE = "https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main";
const DICT_BASE = "https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main";

// Target filename (as referenced by main.js) → source URL.
const FILES = {
  "PP-OCRv6_small_det.ort": `${MODEL_BASE}/detection/ort/PP-OCRv6_small_det.ort`,
  "PP-OCRv6_small_rec.ort": `${MODEL_BASE}/recognition/ort/PP-OCRv6_small_rec.ort`,
  "ppocrv6_dict.txt":       `${DICT_BASE}/recognition/ppocrv6_dict.txt`,
};

const force = process.argv.includes("--force");
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "models");

async function exists(p) {
  try { return (await stat(p)).size > 0; } catch { return false; }
}

async function download(name, url) {
  const dest = join(outDir, name);
  if (!force && (await exists(dest))) {
    console.log(`✓ ${name} (already present)`);
    return;
  }
  console.log(`↓ ${name} …`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  // Write to a temp file first so an interrupted download never leaves a
  // truncated model that would fail to load later.
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);
  const { size } = await stat(dest);
  console.log(`✓ ${name} (${(size / 1_048_576).toFixed(1)} MB)`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const [name, url] of Object.entries(FILES)) {
    try {
      await download(name, url);
    } catch (err) {
      // Clean up any partial file before surfacing the error.
      await rm(join(outDir, `${name}.part`), { force: true });
      console.error(`✗ ${name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

await main();
