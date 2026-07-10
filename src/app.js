// app.js — application wiring (CLAUDE.md §5, §6).
//
// Bootstraps the transport (relay, or the optional local-UDP extension when it
// lands), the SearchEngine, and the DOM. Owns tab state: each tab is one search
// with its own query, results, progress and log (§5.5).

import { buildEd2kLink, FILETYPE } from './protocol.js';
import { buildSearchTree } from './expr.js';
import { createTransport, detectExtension } from './transport.js';
import { SearchEngine } from './search.js';
import { BUILTIN_SERVERS, parseServerLines, normalizeServer } from './servers.js';
import { loadSettings, saveSettings, loadHistory, addHistory, clearHistory, ResultsCache, persistent } from './cache.js';
import { ResultsTable, LogPanel, Progress, ContextMenu, renderTabs, humanSize } from './ui.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#search-form'),
  query: $('#query'),
  type: $('#type'),
  format: $('#format'),
  minSize: $('#min-size'),
  maxSize: $('#max-size'),
  sizeUnit: $('#size-unit'),
  minSources: $('#min-sources'),
  minBitrate: $('#min-bitrate'),
  maxBitrate: $('#max-bitrate'),
  minLength: $('#min-length'),
  maxLength: $('#max-length'),
  codec: $('#codec'),
  search: $('#btn-search'),
  cancel: $('#btn-cancel'),
  reset: $('#btn-reset'),
  history: $('#history'),
  tabs: $('#tabs'),
  table: $('#results-table'),
  log: $('#log'),
  progress: $('#progress'),
  menu: $('#context-menu'),
  status: $('#relay-status'),
  extNote: $('#ext-note'),
  settings: $('#settings-dialog'),
  settingsBtn: $('#btn-settings'),
  relayUrl: $('#relay-url'),
  serverList: $('#server-list'),
  settingsSave: $('#btn-settings-save'),
  serverCount: $('#server-count'),
  toast: $('#toast'),
};

// --- state ---
let settings = loadSettings();
let servers = [];
let engine = null;
let transport = null;
const resultsCache = new ResultsCache();
const tabs = new Map(); // id -> tab
let tabSeq = 0;
let activeId = null;

const SIZE_UNITS = { B: 1n, KiB: 1024n, MiB: 1024n ** 2n, GiB: 1024n ** 3n };

// --- components ---
const table = new ResultsTable(els.table, {
  onActivate: (r) => openEd2kLink(r),
  onContext: (ev, r) => showRowMenu(ev, r),
});
const logPanel = new LogPanel(els.log);
const progress = new Progress(els.progress);
const menu = new ContextMenu(els.menu);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function loadServers() {
  const { servers: parsed, errors } = parseServerLines(settings.serverList);
  servers = [...BUILTIN_SERVERS.map(normalizeServer).filter(Boolean), ...parsed];
  els.serverCount.textContent = servers.length
    ? `${servers.length} server${servers.length === 1 ? '' : 's'}`
    : 'no servers configured';
  els.serverCount.classList.toggle('warn', servers.length === 0);
  if (errors.length) toast(`Ignored ${errors.length} unparseable server line(s)`);
}

async function connect() {
  if (transport) {
    try {
      transport.close();
    } catch {
      /* ignore */
    }
    transport = null;
  }
  if (engine) engine.stop();

  const usingExtension = detectExtension();
  if (!usingExtension && !settings.relayUrl) {
    setStatus('no relay configured', 'bad');
    return;
  }

  setStatus('connecting…', 'pending');
  try {
    transport = createTransport({ relayUrl: settings.relayUrl });
    transport.onStatus(onTransportStatus);
    await transport.connect();
    setStatus(usingExtension ? 'extension' : 'relay connected', 'good');
  } catch (err) {
    setStatus('relay unreachable', 'bad');
    logToActive(`Relay connection failed: ${err.message}`);
    return;
  }

  engine = new SearchEngine({ transport, servers }).start();
}

function onTransportStatus(ev) {
  if (ev.type === 'close') setStatus('relay disconnected', 'bad');
  if (ev.type === 'error') setStatus('relay error', 'bad');
  if (ev.type === 'control') {
    // Relay backpressure / telemetry — surface it, since it slows searches (§2.3).
    if (ev.event === 'throttle') logToActive(`Relay throttling: ${ev.reason || 'busy'}`);
    else if (ev.event === 'error') logToActive(`Relay refused a datagram: ${ev.reason}`);
  }
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status ${kind || ''}`;
}

// ---------------------------------------------------------------------------
// Form <-> fields
// ---------------------------------------------------------------------------

function toBytes(value, unit) {
  if (value === '' || value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return BigInt(Math.trunc(n)) * (SIZE_UNITS[unit] || 1n);
}

function numOrUndef(v) {
  return v === '' || v == null ? undefined : Number(v);
}

function readFields() {
  const unit = els.sizeUnit.value;
  return {
    query: els.query.value.trim(),
    type: els.type.value || undefined,
    format: els.format.value.trim() || undefined,
    minSize: toBytes(els.minSize.value, unit),
    maxSize: toBytes(els.maxSize.value, unit),
    minSources: numOrUndef(els.minSources.value),
    minBitrate: numOrUndef(els.minBitrate.value),
    maxBitrate: numOrUndef(els.maxBitrate.value),
    minLength: numOrUndef(els.minLength.value),
    maxLength: numOrUndef(els.maxLength.value),
    codec: els.codec.value.trim() || undefined,
    _unit: unit,
  };
}

function writeFields(f) {
  els.query.value = f.query || '';
  els.type.value = f.type || '';
  els.format.value = f.format || '';
  els.sizeUnit.value = f._unit || 'MiB';
  const div = SIZE_UNITS[els.sizeUnit.value] || 1n;
  els.minSize.value = f.minSize != null ? String(BigInt(f.minSize) / div) : '';
  els.maxSize.value = f.maxSize != null ? String(BigInt(f.maxSize) / div) : '';
  els.minSources.value = f.minSources ?? '';
  els.minBitrate.value = f.minBitrate ?? '';
  els.maxBitrate.value = f.maxBitrate ?? '';
  els.minLength.value = f.minLength ?? '';
  els.maxLength.value = f.maxLength ?? '';
  els.codec.value = f.codec || '';
}

function describeFields(f) {
  const bits = [];
  if (f.query) bits.push(f.query);
  if (f.type) bits.push(`type:${f.type}`);
  if (f.format) bits.push(`.${f.format}`);
  if (f.minSize != null) bits.push(`>${humanSize(f.minSize)}`);
  if (f.maxSize != null) bits.push(`<${humanSize(f.maxSize)}`);
  if (f.minSources != null) bits.push(`src≥${f.minSources}`);
  return bits.join(' ') || '(empty)';
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function createTab(fields) {
  const tab = {
    id: ++tabSeq,
    label: describeFields(fields),
    fields,
    search: null,
    running: false,
    results: new Map(),
    logs: [],
    progress: null,
    sort: { key: 'sources', dir: 'desc' },
  };
  tabs.set(tab.id, tab);
  activeId = tab.id;
  return tab;
}

function activeTab() {
  return tabs.get(activeId) || null;
}

function selectTab(id) {
  if (!tabs.has(id)) return;
  const prev = activeTab();
  if (prev) prev.sort = { ...table.sort }; // remember this tab's sort
  activeId = id;
  paintActiveTab();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.search && !tab.search.finished) tab.search.cancel();
  tabs.delete(id);
  if (activeId === id) activeId = [...tabs.keys()].pop() ?? null;
  paintActiveTab();
}

function paintActiveTab() {
  const tab = activeTab();
  syncTabs();
  if (!tab) {
    table.setData([]);
    logPanel.clear();
    progress.reset();
    els.cancel.disabled = true;
    return;
  }
  table.setSort(tab.sort);
  table.setData(tab.results.values());
  logPanel.setAll(tab.logs);
  progress.update(tab.progress);
  els.cancel.disabled = !tab.running;
  writeFields(tab.fields);
}

function syncTabs() {
  renderTabs(els.tabs, [...tabs.values()], activeId, { onSelect: selectTab, onClose: closeTab });
}

function logToTab(tab, message) {
  const entry = { time: Date.now(), message };
  tab.logs.push(entry);
  if (tab.id === activeId) logPanel.append(entry);
}

function logToActive(message) {
  const tab = activeTab();
  if (tab) logToTab(tab, message);
}

// ---------------------------------------------------------------------------
// Running a search
// ---------------------------------------------------------------------------

async function runSearch(ev) {
  ev?.preventDefault();
  if (!servers.length) return toast('No servers configured — open Settings and add some.');
  if (!engine) {
    await connect();
    if (!engine) return toast('Not connected to a relay.');
  }

  const fields = readFields();
  let tree;
  try {
    tree = buildSearchTree(fields);
  } catch (err) {
    return toast(`Bad query: ${err.message}`);
  }
  if (!tree) return toast('Enter a search term or at least one filter.');

  const tab = createTab(fields);
  addHistory(fields, tab.label);
  renderHistory();
  paintActiveTab();

  // §5.4: short-lived in-memory results cache stops a misclick re-running a search.
  const cached = resultsCache.get(fields);
  if (cached) {
    for (const r of cached) tab.results.set(r.hashHex, r);
    logToTab(tab, `Loaded ${cached.length} result(s) from cache (not re-querying servers)`);
    tab.progress = { total: servers.length, settled: servers.length, fraction: 1, responded: 0, timedout: 0, skipped: 0, results: cached.length };
    paintActiveTab();
    return;
  }

  const search = engine.createSearch(tree, { query: fields.query });
  tab.search = search;
  tab.running = true;
  els.cancel.disabled = false;

  search.on('log', (entry) => logToTab(tab, entry.message));
  search.on('progress', (p) => {
    tab.progress = p;
    if (tab.id === activeId) progress.update(p);
  });
  search.on('results', () => {
    if (tab.id === activeId) table.setData(tab.results.values());
    syncTabs();
  });
  search.on('done', ({ results, cancelled }) => {
    tab.running = false;
    if (!cancelled && results.length) resultsCache.set(fields, results);
    if (tab.id === activeId) {
      els.cancel.disabled = true;
      table.setData(tab.results.values());
    }
    syncTabs();
  });

  tab.results = search.results; // live-merged map, shared by reference
  search.start();
  syncTabs();
}

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

function linkFor(r) {
  return buildEd2kLink({
    name: r.name || 'file',
    size: r.size,
    hashHex: r.hashHex,
    aich: typeof r.aich === 'string' ? r.aich : undefined,
  });
}

function openEd2kLink(r) {
  const link = linkFor(r);
  logToActive(`Opening ${link}`);
  window.location.href = link; // hands off to the registered ed2k:// handler
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast(`Could not copy ${what.toLowerCase()}`);
  }
}

// Extensible: add entries here for future row actions (§5.2).
function showRowMenu(ev, r) {
  menu.show(ev.clientX, ev.clientY, [
    { label: 'Copy ed2k link', onClick: () => copy(linkFor(r), 'ed2k link') },
    { label: 'Copy file hash', onClick: () => copy(r.hashHex, 'Hash') },
    { label: 'Copy file name', onClick: () => copy(r.name || '', 'Name') },
    { label: 'Open ed2k link', onClick: () => openEd2kLink(r) },
  ]);
}

// ---------------------------------------------------------------------------
// History, settings, misc
// ---------------------------------------------------------------------------

function renderHistory() {
  const entries = loadHistory();
  els.history.replaceChildren();
  if (!entries.length) {
    els.history.hidden = true;
    return;
  }
  els.history.hidden = false;
  for (const e of entries.slice(0, 12)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = e.label;
    b.title = `${e.label}\n${new Date(e.ts).toLocaleString()}`;
    b.addEventListener('click', () => {
      writeFields(e.fields);
      els.query.focus();
    });
    els.history.appendChild(b);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'chip chip-clear';
  clear.textContent = 'clear';
  clear.addEventListener('click', () => {
    clearHistory();
    renderHistory();
  });
  els.history.appendChild(clear);
}

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
}

function openSettings() {
  els.relayUrl.value = settings.relayUrl || '';
  els.serverList.value = settings.serverList || '';
  els.settings.showModal();
}

async function saveSettingsAndReconnect(ev) {
  ev.preventDefault();
  settings = { relayUrl: els.relayUrl.value.trim(), serverList: els.serverList.value };
  saveSettings(settings);
  els.settings.close();
  loadServers(); // connect() builds the engine from the refreshed server list
  await connect();
}

function initTypeOptions() {
  const opts = [['', 'Any type'], ...Object.values(FILETYPE).map((v) => [v, v])];
  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    els.type.appendChild(o);
  }
}

function initExtensionNote() {
  // §2.2: advertise the optional local-UDP extension, which bypasses relay limits.
  if (detectExtension()) {
    els.extNote.hidden = true;
    return;
  }
  els.extNote.hidden = false;
  els.extNote.querySelector('.dismiss').addEventListener('click', () => (els.extNote.hidden = true));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

initTypeOptions();
initExtensionNote();
loadServers();
renderHistory();
paintActiveTab();

if (!persistent) toast('localStorage unavailable — search history will not persist.');

els.form.addEventListener('submit', runSearch);
els.cancel.addEventListener('click', () => activeTab()?.search?.cancel());
els.reset.addEventListener('click', () => {
  els.form.reset();
  els.query.focus();
});
els.settingsBtn.addEventListener('click', openSettings);
els.settingsSave.addEventListener('click', saveSettingsAndReconnect);

// Ctrl/Cmd+K focuses the query box — power-user muscle memory.
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'k') {
    ev.preventDefault();
    els.query.select();
  }
});

if (settings.relayUrl) connect();
else setStatus('no relay configured', 'bad');
