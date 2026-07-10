// ui.js — DOM components (CLAUDE.md §5.2–5.3, §5.5).
//
// Presentation only: no protocol, no transport. Each component owns a bit of DOM
// and exposes a small imperative API; app.js wires them to search events.
//
// All network-supplied text (filenames, media tags) is written with textContent —
// never innerHTML — since it is untrusted.

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Human-readable byte size. Accepts number or BigInt. */
export function humanSize(bytes) {
  let n = typeof bytes === 'bigint' ? Number(bytes) : Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let u = 0;
  while (n >= 1024 && u < UNITS.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u === 0 ? n : n.toFixed(n < 10 ? 2 : 1)} ${UNITS[u]}`;
}

/** Seconds -> m:ss or h:mm:ss. */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Compact one-line summary of a result's media tags. */
export function formatMedia(media = {}) {
  const parts = [];
  if (media.length) parts.push(formatDuration(media.length));
  if (media.bitrate) parts.push(`${media.bitrate} kbps`);
  if (media.codec) parts.push(String(media.codec));
  const who = [media.artist, media.title].filter(Boolean).join(' – ');
  if (who) parts.push(who);
  if (media.album) parts.push(String(media.album));
  return parts.join(' · ');
}

const timeFmt = (ts) => new Date(ts).toLocaleTimeString();

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

/** Column model. `sortable:false` columns are display-only. */
const COLUMNS = [
  { key: 'name', label: 'File name', cls: 'col-name' },
  { key: 'size', label: 'Size', cls: 'num' },
  { key: 'sources', label: 'Sources', cls: 'num' },
  { key: 'completeSources', label: 'Complete', cls: 'num' },
  { key: 'type', label: 'Type' },
  { key: 'format', label: 'Fmt' },
  { key: 'serverCount', label: 'Srv', cls: 'num' },
  { key: 'media', label: 'Metadata', sortable: false },
  { key: 'hashHex', label: 'Hash', cls: 'mono' },
  { key: 'aich', label: 'AICH', cls: 'mono' },
];

function sortValue(r, key) {
  switch (key) {
    case 'serverCount':
      return r.servers ? r.servers.size : 0;
    case 'size':
      return typeof r.size === 'bigint' ? r.size : BigInt(r.size || 0);
    case 'sources':
    case 'completeSources':
      return Number(r[key] || 0);
    case 'aich':
      return typeof r.aich === 'string' ? r.aich : '';
    default:
      return r[key] ?? '';
  }
}

function compare(a, b, key) {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (typeof va === 'bigint' || typeof vb === 'bigint') {
    const x = BigInt(va);
    const y = BigInt(vb);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
}

export class ResultsTable {
  /**
   * @param {HTMLTableElement} table
   * @param {{onActivate:(r)=>void, onContext:(ev, r)=>void}} handlers
   */
  constructor(table, { onActivate, onContext }) {
    this.table = table;
    this.thead = table.querySelector('thead tr');
    this.tbody = table.querySelector('tbody');
    this.empty = table.parentElement.querySelector('.empty');
    this.onActivate = onActivate;
    this.onContext = onContext;
    this.sort = { key: 'sources', dir: 'desc' };
    this.rows = [];
    this._raf = 0;
    this._byHash = new Map();

    this._buildHeader();

    this.tbody.addEventListener('click', (ev) => {
      const r = this._rowFrom(ev);
      if (r) this.onActivate(r);
    });
    this.tbody.addEventListener('contextmenu', (ev) => {
      const r = this._rowFrom(ev);
      if (!r) return;
      ev.preventDefault();
      this.onContext(ev, r);
    });
  }

  _rowFrom(ev) {
    const tr = ev.target.closest('tr[data-hash]');
    return tr ? this._byHash.get(tr.dataset.hash) : null;
  }

  _buildHeader() {
    for (const col of COLUMNS) {
      const th = document.createElement('th');
      th.textContent = col.label;
      if (col.cls) th.className = col.cls;
      if (col.sortable !== false) {
        th.classList.add('sortable');
        th.dataset.key = col.key;
        th.addEventListener('click', () => this._toggleSort(col.key));
      }
      this.thead.appendChild(th);
    }
  }

  _toggleSort(key) {
    if (this.sort.key === key) this.sort.dir = this.sort.dir === 'asc' ? 'desc' : 'asc';
    else this.sort = { key, dir: key === 'name' || key === 'type' || key === 'format' ? 'asc' : 'desc' };
    this.render();
  }

  setSort(sort) {
    if (sort) this.sort = { ...sort };
  }

  /** @param {Iterable} results merged result objects */
  setData(results) {
    this.rows = [...results];
    this.scheduleRender();
  }

  scheduleRender() {
    if (this._raf) return; // coalesce bursts of arriving datagrams into one paint
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  render() {
    const { key, dir } = this.sort;
    const sign = dir === 'asc' ? 1 : -1;
    const rows = [...this.rows].sort((a, b) => sign * compare(a, b, key));

    for (const th of this.thead.children) {
      th.classList.toggle('sorted', th.dataset.key === key);
      th.dataset.dir = th.dataset.key === key ? dir : '';
    }

    this._byHash.clear();
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      this._byHash.set(r.hashHex, r);
      frag.appendChild(this._renderRow(r));
    }
    this.tbody.replaceChildren(frag);

    if (this.empty) this.empty.hidden = rows.length > 0;
    this.table.hidden = rows.length === 0;
  }

  _renderRow(r) {
    const tr = document.createElement('tr');
    tr.dataset.hash = r.hashHex;

    // Name — plus the full name histogram (all names servers reported, by count).
    const name = document.createElement('td');
    name.className = 'col-name';
    name.textContent = r.name || '(unnamed)';
    if (r.names && r.names.size > 1) {
      const alt = document.createElement('span');
      alt.className = 'badge';
      alt.textContent = `+${r.names.size - 1}`;
      alt.title = [...r.names.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c}× ${n}`).join('\n');
      name.append(' ', alt);
      name.title = alt.title;
    } else {
      name.title = r.name || '';
    }
    tr.appendChild(name);

    tr.appendChild(cell(humanSize(r.size), 'num'));
    tr.appendChild(cell(String(r.sources || 0), 'num'));
    tr.appendChild(cell(String(r.completeSources || 0), 'num'));
    tr.appendChild(cell(r.type || ''));
    tr.appendChild(cell(r.format || ''));

    const srv = cell(String(r.servers ? r.servers.size : 0), 'num');
    if (r.servers && r.servers.size) srv.title = [...r.servers].join('\n');
    tr.appendChild(srv);

    tr.appendChild(cell(formatMedia(r.media)));
    tr.appendChild(cell(r.hashHex, 'mono'));
    tr.appendChild(cell(typeof r.aich === 'string' ? r.aich : '', 'mono'));
    return tr;
  }
}

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

// ---------------------------------------------------------------------------
// Log panel
// ---------------------------------------------------------------------------

export class LogPanel {
  constructor(el, { max = 500 } = {}) {
    this.el = el;
    this.max = max;
  }
  append({ time, message }) {
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 24;
    const line = document.createElement('div');
    line.className = 'log-line';
    const t = document.createElement('span');
    t.className = 'log-time';
    t.textContent = timeFmt(time);
    line.append(t, document.createTextNode(message));
    this.el.appendChild(line);
    while (this.el.childElementCount > this.max) this.el.firstElementChild.remove();
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }
  setAll(lines) {
    this.el.replaceChildren();
    for (const l of lines) this.append(l);
  }
  clear() {
    this.el.replaceChildren();
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export class Progress {
  constructor(root) {
    this.root = root;
    this.bar = root.querySelector('.bar-fill');
    this.text = root.querySelector('.progress-text');
  }
  update(p) {
    if (!p) return this.reset();
    this.root.hidden = false;
    this.bar.style.width = `${Math.round(p.fraction * 100)}%`;
    this.bar.classList.toggle('done', p.fraction >= 1);
    this.text.textContent =
      `${p.settled}/${p.total} servers · ${p.responded} responded, ` +
      `${p.timedout} timed out, ${p.skipped} skipped · ${p.results} files`;
  }
  reset() {
    this.root.hidden = true;
    this.bar.style.width = '0%';
    this.text.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export class ContextMenu {
  constructor(el) {
    this.el = el;
    this._hide = () => this.hide();
    document.addEventListener('click', this._hide);
    document.addEventListener('scroll', this._hide, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.hide();
    });
  }
  /** @param {Array<{label:string, onClick:Function}>} items */
  show(x, y, items) {
    this.el.replaceChildren();
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.label;
      b.addEventListener('click', () => {
        this.hide();
        item.onClick();
      });
      this.el.appendChild(b);
    }
    this.el.hidden = false;
    // Keep the menu inside the viewport.
    const { offsetWidth: w, offsetHeight: h } = this.el;
    this.el.style.left = `${Math.min(x, window.innerWidth - w - 4)}px`;
    this.el.style.top = `${Math.min(y, window.innerHeight - h - 4)}px`;
  }
  hide() {
    this.el.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

export function renderTabs(container, tabs, activeId, { onSelect, onClose }) {
  container.replaceChildren();
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeId ? ' active' : '');

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'tab-label';
    label.textContent = tab.label;
    label.title = tab.label;
    label.addEventListener('click', () => onSelect(tab.id));

    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = String(tab.results.size);
    label.appendChild(count);

    if (tab.running) el.classList.add('running');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClose(tab.id);
    });

    el.append(label, close);
    container.appendChild(el);
  }
}
