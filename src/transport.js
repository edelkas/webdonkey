// transport.js — abstract datagram transport for ed2k UDP.
//
// The rest of the app talks to servers through ONE small contract and never
// knows how bytes actually leave the machine (see CLAUDE.md §2.1–2.2):
//
//   transport.connect()                 -> Promise<void>
//   transport.sendDatagram(server, u8)  -> void      (server = {host, port})
//   transport.onDatagram((server, u8))  -> unsubscribe
//   transport.onStatus((event))         -> unsubscribe
//   transport.close()                   -> void
//   transport.ready                     -> boolean
//
// Backends (all behind the same contract):
//   ① RelayTransport   — UDP-over-WebSocket (WSS) via the user's relay. PRIMARY.
//   ② (future) extension — native local UDP; preferred when present, bypasses
//      the relay's rate limits. `detectExtension()` is the drop-in point.
//   • LoopbackTransport — in-process mock for tests / offline dev.
//
// Datagrams delivered by `onDatagram` are always plaintext eDonkey datagrams
// (protocol header 0xE3): PACKED (0xD4/zlib) datagrams are inflated on receive
// (§4.8) so consumers never deal with compression.

import { PROTO } from './protocol.js';

// ---------------------------------------------------------------------------
// Relay wire protocol (browser <-> relay, over the WebSocket, binary frames)
// ---------------------------------------------------------------------------
//
// Kept deliberately simple so the relay stays a dumb, low-CPU pipe (§2.3). Each
// WS message is one frame with a 1-byte type:
//
//   DATAGRAM (0x01): [0x01][ip:4 BE][port:u16 BE][payload...]   (fixed 7B header)
//       browser->relay: forward <payload> as UDP to ip:port
//       relay->browser: <payload> is a UDP datagram received from ip:port
//   CONTROL  (0x02): [0x02][json:utf8]
//       relay->browser control/telemetry, e.g. {event:'throttle'|'stats'|'error'}
//
// The destination is a packed 4-byte IPv4 (network order) + big-endian port, so
// the relay can drop it straight into a sockaddr with no parsing. Our server list
// is IPv4 literals (ed2k servers are IP-based). This is the contract the relay
// must implement — change both ends together.

export const FRAME = { DATAGRAM: 0x01, CONTROL: 0x02 };

const utf8d = new TextDecoder('utf-8');

/** Parse an IPv4 literal "a.b.c.d" into 4 bytes. Throws on anything else. */
export function ipv4ToBytes(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4) throw new Error(`not an IPv4 literal: ${host}`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`bad IPv4 octet in ${host}`);
    out[i] = n;
  }
  return out;
}

/** Render 4 bytes (at offset) back to "a.b.c.d". */
export function bytesToIpv4(u8, off = 0) {
  return `${u8[off]}.${u8[off + 1]}.${u8[off + 2]}.${u8[off + 3]}`;
}

/** Encode an outbound datagram frame. @param {{host,port}} server (host = IPv4) */
export function encodeDatagramFrame(server, payload) {
  const ip = ipv4ToBytes(server.host);
  const out = new Uint8Array(1 + 4 + 2 + payload.length);
  out[0] = FRAME.DATAGRAM;
  out.set(ip, 1);
  out[5] = (server.port >>> 8) & 0xff; // big-endian port
  out[6] = server.port & 0xff;
  out.set(payload, 7);
  return out;
}

/**
 * Decode a frame from the relay.
 * @returns {{type:0x01, server:{host,port}, payload:Uint8Array}
 *          |{type:0x02, control:object}}
 */
export function decodeFrame(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const type = u8[0];
  if (type === FRAME.DATAGRAM) {
    const host = bytesToIpv4(u8, 1);
    const port = (u8[5] << 8) | u8[6];
    const payload = u8.subarray(7);
    return { type, server: { host, port }, payload };
  }
  if (type === FRAME.CONTROL) {
    let control = {};
    try {
      control = JSON.parse(utf8d.decode(u8.subarray(1)));
    } catch {
      /* ignore malformed control frame */
    }
    return { type, control };
  }
  throw new Error(`unknown frame type 0x${(type ?? -1).toString(16)}`);
}

// ---------------------------------------------------------------------------
// PACKED (0xD4/zlib) inflation
// ---------------------------------------------------------------------------

/**
 * If `datagram` is a PACKED datagram ([0xD4][opcode][zlib body]), inflate it to
 * an eDonkey datagram ([0xE3][opcode][body]); otherwise return it unchanged.
 * Uses the platform DecompressionStream (browser + Node >= 17).
 * @returns {Promise<Uint8Array>}
 */
export async function inflateIfPacked(datagram) {
  if (datagram.length < 2 || datagram[0] !== PROTO.PACKED) return datagram;
  const opcode = datagram[1];
  const inflated = await inflateZlib(datagram.subarray(2));
  const out = new Uint8Array(2 + inflated.length);
  out[0] = PROTO.EDONKEY;
  out[1] = opcode;
  out.set(inflated, 2);
  return out;
}

async function inflateZlib(bytes) {
  const ds = new DecompressionStream('deflate'); // zlib (RFC 1950), as eMule uses
  const writer = ds.writable.getWriter();
  const chunks = [];
  const readAll = (async () => {
    const reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  await writer.write(bytes);
  await writer.close();
  await readAll;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base transport (listener plumbing + contract)
// ---------------------------------------------------------------------------

export class Transport {
  constructor() {
    this._onDatagram = new Set();
    this._onStatus = new Set();
    this._ready = false;
  }
  get ready() {
    return this._ready;
  }
  /** @param {(server:{host,port}, bytes:Uint8Array)=>void} cb */
  onDatagram(cb) {
    this._onDatagram.add(cb);
    return () => this._onDatagram.delete(cb);
  }
  /** @param {(event:{type:string,[k:string]:any})=>void} cb */
  onStatus(cb) {
    this._onStatus.add(cb);
    return () => this._onStatus.delete(cb);
  }
  _emitDatagram(server, bytes) {
    for (const cb of this._onDatagram) cb(server, bytes);
  }
  _emitStatus(event) {
    for (const cb of this._onStatus) cb(event);
  }
  // Subclasses implement:
  async connect() {}
  // eslint-disable-next-line no-unused-vars
  sendDatagram(server, bytes) {
    throw new Error('not implemented');
  }
  close() {}
}

// ---------------------------------------------------------------------------
// Relay backend (UDP-over-WSS) — PRIMARY
// ---------------------------------------------------------------------------

export class RelayTransport extends Transport {
  /**
   * @param {string} url  wss:// relay endpoint
   * @param {{WebSocketImpl?:Function}} [opts]  inject a WebSocket for testing
   */
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this._WS = opts.WebSocketImpl || globalThis.WebSocket;
    this._ws = null;
    this._sendQueue = []; // frames buffered until the socket opens
  }

  connect() {
    if (!this._WS) throw new Error('no WebSocket implementation available');
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this._WS(this.url);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;
      ws.onopen = () => {
        this._ready = true;
        for (const frame of this._sendQueue) ws.send(frame);
        this._sendQueue.length = 0;
        this._emitStatus({ type: 'open', url: this.url });
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onerror = (ev) => {
        this._emitStatus({ type: 'error', error: ev?.message || 'websocket error' });
        if (!settled) {
          settled = true;
          reject(new Error('relay connection failed'));
        }
      };
      ws.onclose = (ev) => {
        this._ready = false;
        this._emitStatus({ type: 'close', code: ev?.code, reason: ev?.reason });
      };
    });
  }

  sendDatagram(server, bytes) {
    const frame = encodeDatagramFrame(server, bytes);
    if (this._ready && this._ws) this._ws.send(frame);
    else this._sendQueue.push(frame); // flushed on open
  }

  async _onMessage(data) {
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (err) {
      this._emitStatus({ type: 'error', error: String(err) });
      return;
    }
    if (frame.type === FRAME.CONTROL) {
      this._emitStatus({ type: 'control', ...frame.control });
      return;
    }
    // datagram: inflate PACKED before handing up so consumers see 0xE3
    let payload = frame.payload;
    try {
      payload = await inflateIfPacked(payload);
    } catch (err) {
      this._emitStatus({ type: 'error', error: `inflate failed: ${err}` });
      return;
    }
    this._emitDatagram(frame.server, payload);
  }

  close() {
    this._ready = false;
    if (this._ws) this._ws.close();
  }
}

// ---------------------------------------------------------------------------
// Loopback backend — in-process mock for tests / offline development
// ---------------------------------------------------------------------------

export class LoopbackTransport extends Transport {
  constructor() {
    super();
    this._responder = null;
  }
  /**
   * Register a function that simulates the network: given an outbound datagram it
   * returns the datagrams servers would send back. Each returned datagram may be
   * PACKED (0xD4) — it is inflated on the way in, just like the relay path.
   * @param {(server:{host,port}, bytes:Uint8Array)=>Array<{server:{host,port},bytes:Uint8Array}>} fn
   */
  setResponder(fn) {
    this._responder = fn;
  }
  async connect() {
    this._ready = true;
    this._emitStatus({ type: 'open', url: 'loopback' });
  }
  sendDatagram(server, bytes) {
    if (!this._responder) return;
    const replies = this._responder(server, bytes) || [];
    // Deliver asynchronously to mimic real network ordering.
    Promise.resolve().then(async () => {
      for (const r of replies) {
        const payload = await inflateIfPacked(r.bytes);
        this._emitDatagram(r.server, payload);
      }
    });
  }
  close() {
    this._ready = false;
  }
}

// ---------------------------------------------------------------------------
// Factory + extension detection
// ---------------------------------------------------------------------------

/**
 * Detect the optional local-UDP browser extension (transport ②). Deferred —
 * always false for now; wire real detection here later. When it returns true the
 * factory should prefer the extension backend (bypasses relay rate limits).
 */
export function detectExtension() {
  return false;
}

/**
 * Build a transport. Call `.connect()` on the result before sending.
 * @param {{loopback?:boolean, relayUrl?:string, WebSocketImpl?:Function}} [opts]
 */
export function createTransport(opts = {}) {
  if (opts.loopback) return new LoopbackTransport();
  if (detectExtension()) {
    // TODO: return new ExtensionTransport() once implemented.
  }
  if (!opts.relayUrl) throw new Error('relayUrl required for relay transport');
  return new RelayTransport(opts.relayUrl, opts);
}
