// cache.js — persistence + in-memory caches (CLAUDE.md §5.4).
//
//   Query history  -> in-memory + localStorage (survives sessions; relaunchable)
//   Settings       -> localStorage (relay URL, pasted server list)
//   Search results -> in-memory ONLY, short TTL (stops misclicks re-running a
//                     search; deliberately not persisted)
//
// localStorage may be unavailable (private mode, disabled). Everything degrades
// gracefully to memory-only.

const NS = 'ed2k:';
const HISTORY_KEY = `${NS}history`;
const SETTINGS_KEY = `${NS}settings`;
const MAX_HISTORY = 50;

const memory = new Map(); // fallback when localStorage is unusable

const storage = (() => {
  try {
    const probe = `${NS}probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
})();

/** True when queries will survive a reload. */
export const persistent = storage !== null;

// Size fields are BigInt (files exceed 2^53); JSON can't serialize those, so they
// round-trip as decimal strings. Readers (writeFields, buildSearchTree) accept both.
const bigintSafe = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

function readJSON(key, fallback) {
  try {
    const raw = storage ? storage.getItem(key) : memory.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  const raw = JSON.stringify(value, bigintSafe);
  try {
    if (storage) storage.setItem(key, raw);
    else memory.set(key, raw);
  } catch {
    memory.set(key, raw); // quota exceeded / blocked
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = { relayUrl: '', serverList: '' };

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  writeJSON(SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...settings });
}

// ---------------------------------------------------------------------------
// Query history — the full field set, so a past search can be relaunched as-is
// ---------------------------------------------------------------------------

/** @returns {Array<{fields:object, label:string, ts:number}>} newest first */
export function loadHistory() {
  const list = readJSON(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

/** Add (or bubble up) a search. Deduped by its serialized field set. */
export function addHistory(fields, label) {
  const key = fieldsKey(fields);
  const list = loadHistory().filter((e) => fieldsKey(e.fields) !== key);
  list.unshift({ fields, label: label || fields.query || '(no query)', ts: Date.now() });
  writeJSON(HISTORY_KEY, list.slice(0, MAX_HISTORY));
  return list;
}

export function clearHistory() {
  writeJSON(HISTORY_KEY, []);
}

/**
 * Stable identity for a field set (history dedupe + results cache). Every part is
 * stringified so BigInt sizes and their persisted string form key identically.
 */
export function fieldsKey(fields) {
  const f = fields || {};
  const s = (v) => (v == null ? '' : String(v));
  return JSON.stringify([
    s(f.query).trim(),
    s(f.type),
    s(f.format),
    s(f.minSize),
    s(f.maxSize),
    s(f.minSources),
    s(f.minBitrate),
    s(f.maxBitrate),
    s(f.minLength),
    s(f.maxLength),
    s(f.codec),
  ]);
}

// ---------------------------------------------------------------------------
// Results cache (memory only, TTL) — avoids re-running a search on a misclick
// ---------------------------------------------------------------------------

export class ResultsCache {
  /** @param {number} ttlMs how long a result set stays reusable */
  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this._map = new Map(); // key -> {results, ts}
  }
  get(fields) {
    const entry = this._map.get(fieldsKey(fields));
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this._map.delete(fieldsKey(fields));
      return null;
    }
    return entry.results;
  }
  set(fields, results) {
    this._map.set(fieldsKey(fields), { results, ts: Date.now() });
  }
  clear() {
    this._map.clear();
  }
}
