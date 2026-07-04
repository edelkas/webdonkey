// search.js — search orchestration (browser side).
//
// Ties protocol + transport together and drives one global search across many
// servers (CLAUDE.md §6): ping each server for its UDP flags (cached per
// session), pick the request variant per server (or skip), fan out, then
// aggregate/dedupe incoming results by file hash and surface progress + a log.
//
// Transport-agnostic: works over any Transport (relay or LoopbackTransport).
// No DOM here — the UI subscribes to Search events.
//
// A `SearchEngine` owns the transport + shared per-session flags cache and can
// run several `Search`es at once (one per UI tab). Each Search emits:
//   'progress' {total, settled, fraction, results, <per-state counts>}
//   'results'  {batch:[merged...], total}     (live-merge as datagrams arrive)
//   'log'      {time, message}
//   'done'     {results:[...], cancelled}
//
// ⚠️ Protocol limitation: UDP search results carry no per-query correlator, and
// the relay funnels every user through one IP, so results are attributed to the
// searches currently awaiting that server. Two concurrent searches hitting the
// *same* server in the same window may see each other's results (dedupe by hash
// makes this benign, but note it). Status replies ARE unambiguous (matched by
// the random 32-bit challenge we send).

import {
  PROTO,
  OP,
  buildStatusRequest,
  buildSearchRequest,
  parseStatusResponse,
  parseSearchResults,
  planServerRequest,
  treeUses64Bit,
} from './protocol.js';

/** Per-server lifecycle states. Terminal states end that server's work. */
export const ServerState = Object.freeze({
  PENDING: 'pending',
  PINGING: 'pinging',
  SEARCHED: 'searched',
  RESPONDING: 'responding',
  RESPONDED: 'responded',
  TIMEDOUT: 'timedout',
  SKIPPED: 'skipped',
});

const TERMINAL = new Set([ServerState.RESPONDED, ServerState.TIMEDOUT, ServerState.SKIPPED]);

/** Stable per-server key based on host + UDP port. */
export function serverKey(s) {
  return `${s.host}:${s.udpPort ?? s.port}`;
}

/** Destination {host, port} for the transport, using the server's UDP port. */
function udpDest(s) {
  return { host: s.host, port: s.udpPort ?? s.port };
}

function randomU32() {
  if (globalThis.crypto?.getRandomValues) {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** The most frequently seen key in a Map<name,count> (insertion order breaks ties). */
function mostPopular(counts) {
  let best = null;
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tiny event emitter (framework-free)
// ---------------------------------------------------------------------------

class Emitter {
  constructor() {
    this._handlers = new Map();
  }
  on(event, cb) {
    let set = this._handlers.get(event);
    if (!set) this._handlers.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }
  _emit(event, data) {
    const set = this._handlers.get(event);
    if (set) for (const cb of set) cb(data);
  }
}

// ---------------------------------------------------------------------------
// SearchEngine — transport owner, flags cache, datagram router
// ---------------------------------------------------------------------------

export class SearchEngine {
  /**
   * @param {object} opts
   * @param {import('./transport.js').Transport} opts.transport  connected transport
   * @param {Array<{host,tcpPort?,udpPort?,port?,name?}>} [opts.servers]
   * @param {object} [opts.config]  {pingTimeoutMs, serverTimeoutMs, flagsTtlMs}
   */
  constructor({ transport, servers = [], config = {} }) {
    this.transport = transport;
    this.servers = servers;
    this.config = {
      pingTimeoutMs: 3000,
      serverTimeoutMs: 4000, // per-server window to collect result datagrams
      flagsTtlMs: 30 * 60 * 1000, // per-session flags cache lifetime
      ...config,
    };
    this.flagsCache = new Map(); // key -> {flags, ts, status}
    this._pendingPings = new Map(); // challenge -> {key, resolve, reject, timer}
    this._pingByKey = new Map(); // key -> Promise<flags> (coalesce in-flight pings)
    this._awaiting = new Map(); // key -> Set<Search>
    this._searches = new Set();
    this._unsub = null;
  }

  /** Subscribe to the transport. Call once after the transport is connected. */
  start() {
    if (!this._unsub) this._unsub = this.transport.onDatagram((from, bytes) => this._onDatagram(from, bytes));
    return this;
  }

  stop() {
    if (this._unsub) this._unsub();
    this._unsub = null;
  }

  /** Create a search over `tree` (build it with expr.buildSearchTree). */
  createSearch(tree, opts = {}) {
    const search = new Search(this, tree, {
      servers: opts.servers || this.servers,
      query: opts.query,
    });
    this._searches.add(search);
    return search;
  }

  /**
   * Resolve a server's UDP flags: cached (within TTL) or by pinging. Coalesces
   * concurrent requests for the same server. Rejects on ping timeout.
   * @returns {Promise<number>}
   */
  getFlags(server) {
    const key = serverKey(server);
    const cached = this.flagsCache.get(key);
    if (cached && Date.now() - cached.ts < this.config.flagsTtlMs) return Promise.resolve(cached.flags);
    if (this._pingByKey.has(key)) return this._pingByKey.get(key);

    const p = new Promise((resolve, reject) => {
      const challenge = randomU32();
      const timer = setTimeout(() => {
        this._pendingPings.delete(challenge);
        reject(new Error('ping timeout'));
      }, this.config.pingTimeoutMs);
      this._pendingPings.set(challenge, { key, resolve, reject, timer });
      this.transport.sendDatagram(udpDest(server), buildStatusRequest(challenge));
    });
    this._pingByKey.set(key, p);
    const clear = () => this._pingByKey.delete(key);
    p.then(clear, clear);
    return p;
  }

  _onDatagram(from, bytes) {
    if (bytes.length < 2 || bytes[0] !== PROTO.EDONKEY) return;
    const opcode = bytes[1];
    if (opcode === OP.GLOBSERVSTATRES) this._onStatus(from, bytes);
    else if (opcode === OP.GLOBSEARCHRES) this._onResults(from, bytes);
  }

  _onStatus(from, bytes) {
    const status = parseStatusResponse(bytes);
    if (!status) return;
    const pend = this._pendingPings.get(status.challenge);
    if (!pend) return; // unknown/stale challenge
    clearTimeout(pend.timer);
    this._pendingPings.delete(status.challenge);
    this.flagsCache.set(pend.key, { flags: status.flags, ts: Date.now(), status });
    pend.resolve(status.flags);
  }

  _onResults(from, bytes) {
    const set = this._awaiting.get(serverKey(from));
    if (!set || set.size === 0) return; // unsolicited / after window closed
    const results = parseSearchResults(bytes);
    if (results.length === 0) return;
    for (const search of set) search._ingest(from, results);
  }

  _await(key, search) {
    let set = this._awaiting.get(key);
    if (!set) this._awaiting.set(key, (set = new Set()));
    set.add(search);
  }
  _unawait(key, search) {
    const set = this._awaiting.get(key);
    if (set) {
      set.delete(search);
      if (set.size === 0) this._awaiting.delete(key);
    }
  }
  _removeSearch(search) {
    this._searches.delete(search);
  }
}

// ---------------------------------------------------------------------------
// Search — one query across the server set
// ---------------------------------------------------------------------------

export class Search extends Emitter {
  constructor(engine, tree, { servers, query }) {
    super();
    this.engine = engine;
    this.tree = tree;
    this.uses64 = treeUses64Bit(tree);
    this.servers = servers;
    this.query = query; // opaque, for history/UI
    this.results = new Map(); // hashHex -> merged result (with .names Map, .servers Set)
    this._serverState = new Map(); // key -> {server, state, gotResults, timer}
    this._pending = 0;
    this.cancelled = false;
    this.finished = false;
  }

  /** Begin the search. Returns this. */
  start() {
    for (const s of this.servers) {
      this._serverState.set(serverKey(s), { server: s, state: ServerState.PENDING, gotResults: false, timer: null });
    }
    this._pending = this.servers.length;
    this._log(`Starting search across ${this.servers.length} server(s)`);
    this._emitProgress();
    for (const s of this.servers) this._pingAndSearch(s);
    if (this._pending === 0) this._finish();
    return this;
  }

  /** Abort an in-flight search. */
  cancel() {
    if (this.finished) return;
    this.cancelled = true;
    this._log('Search cancelled');
    this._finish(); // handles timer + await cleanup
  }

  /** Snapshot of merged results as an array. */
  getResults() {
    return [...this.results.values()];
  }

  async _pingAndSearch(server) {
    const key = serverKey(server);
    let flags;
    try {
      this._setState(key, ServerState.PINGING);
      flags = await this.engine.getFlags(server);
    } catch {
      if (this.cancelled) return;
      this._log(`No status reply from ${key} (timeout)`);
      this._finalizeServer(key, ServerState.TIMEDOUT);
      return;
    }
    if (this.cancelled) return;

    const plan = planServerRequest(flags, this.uses64);
    if (plan.skip) {
      this._log(`Skipping ${key}: ${plan.reason}`);
      this._finalizeServer(key, ServerState.SKIPPED);
      return;
    }

    let packet;
    try {
      packet = buildSearchRequest({ variant: plan.variant, tree: this.tree });
    } catch (err) {
      this._log(`Cannot build request for ${key}: ${err.message}`);
      this._finalizeServer(key, ServerState.SKIPPED);
      return;
    }

    this.engine._await(key, this);
    this.engine.transport.sendDatagram(udpDest(server), packet);
    this._setState(key, ServerState.SEARCHED);
    this._log(`Search sent to ${key} (REQ${plan.variant})`);

    const st = this._serverState.get(key);
    st.timer = setTimeout(() => this._resultWindowElapsed(key), this.engine.config.serverTimeoutMs);
    this._emitProgress();
  }

  // Called by the engine when result datagrams arrive from a server we await.
  _ingest(from, results) {
    if (this.cancelled || this.finished) return;
    const key = serverKey(from);
    const batch = [];
    for (const res of results) batch.push(this._merge(res, key));
    const st = this._serverState.get(key);
    if (st) {
      st.gotResults = true;
      if (st.state === ServerState.SEARCHED) this._setState(key, ServerState.RESPONDING);
    }
    this._emit('results', { batch, total: this.results.size });
    this._emitProgress();
  }

  _merge(res, fromKey) {
    let cur = this.results.get(res.hashHex);
    if (!cur) {
      // Drop the scalar `name`; names are tracked in the histogram below.
      const { name, ...rest } = res;
      cur = { ...rest, media: { ...res.media }, names: new Map(), name: '', servers: new Set() };
      this.results.set(res.hashHex, cur);
    } else {
      cur.sources += res.sources; // accumulate availability across servers
      cur.completeSources += res.completeSources;
      if ((!cur.size || cur.size === 0n) && res.size) cur.size = res.size;
      if (!cur.type && res.type) cur.type = res.type;
      if (!cur.format && res.format) cur.format = res.format;
      if (!cur.aich && res.aich) cur.aich = res.aich;
      for (const [k, v] of Object.entries(res.media)) if (cur.media[k] == null) cur.media[k] = v;
    }
    if (res.name) {
      cur.names.set(res.name, (cur.names.get(res.name) || 0) + 1);
      cur.name = mostPopular(cur.names); // convenience primary (most reported)
    }
    cur.servers.add(fromKey);
    return cur;
  }

  _resultWindowElapsed(key) {
    const st = this._serverState.get(key);
    if (!st) return;
    this._finalizeServer(key, st.gotResults ? ServerState.RESPONDED : ServerState.TIMEDOUT);
  }

  /** Transition a server's state. Returns false if unknown or already terminal. */
  _setState(key, state) {
    const st = this._serverState.get(key);
    if (!st || TERMINAL.has(st.state)) return false;
    st.state = state;
    return true;
  }

  _finalizeServer(key, state) {
    const st = this._serverState.get(key);
    if (!this._setState(key, state)) return; // unknown or already terminal
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    this.engine._unawait(key, this);
    this._pending--;
    this._emitProgress();
    if (this._pending <= 0) this._finish();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    for (const [key, st] of this._serverState) {
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      this.engine._unawait(key, this);
    }
    this.engine._removeSearch(this);
    this._log(`Search finished: ${this.results.size} unique file(s)`);
    this._emit('done', { results: this.getResults(), cancelled: this.cancelled });
  }

  _emitProgress() {
    const counts = { total: 0 };
    for (const s of Object.values(ServerState)) counts[s] = 0;
    for (const st of this._serverState.values()) {
      counts.total++;
      counts[st.state]++;
    }
    const settled = counts[ServerState.RESPONDED] + counts[ServerState.TIMEDOUT] + counts[ServerState.SKIPPED];
    this._emit('progress', {
      ...counts,
      settled,
      fraction: counts.total ? settled / counts.total : 1,
      results: this.results.size,
    });
  }

  _log(message) {
    this._emit('log', { time: Date.now(), message });
  }
}
