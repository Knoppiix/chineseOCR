// Chinese dictionary loader for the hover-lookup overlay.
//
// Files live in /dicts/ and use the CC-CEDICT/CFDICT line format:
//   Traditional Simplified [pin1 yin1] /gloss 1/gloss 2/
// (comment lines start with '#'). The same parser handles any dictionary in
// this format — e.g. drop in cfdict.u8 for French and change DICT_PATH.
//
// Loaded lazily (the file is ~10 MB) and indexed by BOTH simplified and
// traditional forms so lookups work whatever the game uses.

const DICT_PATH = "/dicts/cedict_ts.u8"; // TODO: make user-selectable via the UI

let dict = null;      // Map<string, { pinyin, senses[] }>
let loadPromise = null;

export function loadDictionary(path = DICT_PATH) {
  if (dict) return Promise.resolve(dict);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`dictionary fetch ${path}: HTTP ${res.status}`);
    dict = parseCedict(await res.text());
    return dict;
  })();
  return loadPromise;
}

export function lookup(word) {
  return dict ? dict.get(word) ?? null : null;
}

function parseCedict(text) {
  const m = new Map();
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const sp1 = line.indexOf(" ");
    const sp2 = line.indexOf(" ", sp1 + 1);
    const lb = line.indexOf("[");
    const rb = line.indexOf("]", lb + 1);
    const g1 = line.indexOf("/", rb);
    if (sp1 < 0 || sp2 < 0 || lb < 0 || rb < 0 || g1 < 0) continue;

    const trad = line.slice(0, sp1);
    const simp = line.slice(sp1 + 1, sp2);
    const entry = {
      pinyin: numberedToDiacritics(line.slice(lb + 1, rb)),
      senses: line.slice(g1 + 1).split("/").filter(Boolean),
    };
    // Keep the first definition for a given headword (entries are roughly
    // frequency-ordered in CC-CEDICT).
    if (!m.has(simp)) m.set(simp, entry);
    if (!m.has(trad)) m.set(trad, entry);
  }
  return m;
}

// ── Numbered pinyin → diacritics (ni3 hao3 → nǐ hǎo) ─────────────────────────
const TONE = {
  a: ["a", "ā", "á", "ǎ", "à"],
  e: ["e", "ē", "é", "ě", "è"],
  i: ["i", "ī", "í", "ǐ", "ì"],
  o: ["o", "ō", "ó", "ǒ", "ò"],
  u: ["u", "ū", "ú", "ǔ", "ù"],
  "ü": ["ü", "ǖ", "ǘ", "ǚ", "ǜ"],
};

function markSyllable(syl) {
  const m = syl.match(/^([a-zü:]+)([1-5])$/i);
  if (!m) return syl.replace(/u:/gi, "ü").replace(/v/gi, "ü");
  let body = m[1].replace(/u:/gi, "ü").replace(/v/gi, "ü");
  const tone = +m[2];
  if (tone === 5) return body;

  const lower = body.toLowerCase();
  let idx;
  if (lower.includes("a")) idx = lower.indexOf("a");
  else if (lower.includes("e")) idx = lower.indexOf("e");
  else if (lower.includes("ou")) idx = lower.indexOf("o");
  else {
    idx = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      if ("aeiouü".includes(lower[i])) { idx = i; break; }
    }
  }
  if (idx < 0) return body;
  const table = TONE[lower[idx]];
  if (!table) return body;
  return body.slice(0, idx) + table[tone] + body.slice(idx + 1);
}

function numberedToDiacritics(pinyin) {
  return pinyin.split(/\s+/).map(markSyllable).join(" ");
}
