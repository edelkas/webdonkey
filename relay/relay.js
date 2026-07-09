// relay.js — UDP-over-WebSocket relay for the ed2k web search engine.
//
// A dumb, rate-limited pipe (CLAUDE.md §2.3): it forwards browser datagrams to
// ed2k servers over real UDP and streams replies back. It does NOT parse the ed2k
// protocol — all parsing/dedup/decompression happens in the browser. Server-side
// responsibilities here are exactly: framing, a GLOBAL rate limiter, destination
// safety, and traffic monitoring with load shedding.
//
// Deploy: run behind the operator's existing reverse proxy, which terminates TLS
// and forwards to this plain ws:// server (browser -> WSS -> proxy -> ws -> relay).
// See relay/README.md.
//
// Wire protocol (shared with src/transport.js):
//   client->relay  DATAGRAM [0x01][ip:4][port:2][payload]  -> send as UDP
//   relay->client  DATAGRAM [0x01][ip:4][port:2][payload]  <- UDP reply
//   relay->client  CONTROL  [0x02][json]                   telemetry/backpressure

import http from 'node:http';
import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';
import { FRAME, decodeFrame, encodeDatagramFrame, encodeControlFrame } from '../src/transport.js';
import { Pacer } from './pacer.js';
import { makeDestinationCheck } from './guard.js';

// --- configuration (env with sensible defaults) ---
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const cfg = {
  host: process.env.RELAY_HOST || '127.0.0.1',
  port: num(process.env.RELAY_PORT, 8765),
  maxClients: num(process.env.RELAY_MAX_CLIENTS, 50),
  globalPps: num(process.env.RELAY_GLOBAL_PPS, 60),
  perServerIntervalMs: num(process.env.RELAY_PER_SERVER_INTERVAL_MS, 250),
  maxQueue: num(process.env.RELAY_MAX_QUEUE, 2000),
  perClientMax: num(process.env.RELAY_PER_CLIENT_MAX_QUEUED, 200),
  maxPayload: num(process.env.RELAY_MAX_PAYLOAD, 8192),
  statsIntervalMs: num(process.env.RELAY_STATS_INTERVAL_MS, 10000),
  allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  allowlist: (process.env.RELAY_SERVER_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  allowPrivate: process.env.RELAY_ALLOW_PRIVATE === '1',
};

const checkDestination = makeDestinationCheck({ allowlist: cfg.allowlist, allowPrivate: cfg.allowPrivate });

// --- traffic monitor (counters + rolling snapshot) ---
const monitor = {
  connections: 0,
  forwarded: 0, // datagrams sent to ed2k servers
  fromServers: 0, // datagrams received from ed2k servers
  bytesToServers: 0,
  bytesFromServers: 0,
  shed: 0, // datagrams dropped by the pacer / caps
  rejectedConns: 0,
  _last: { bytesToServers: 0, bytesFromServers: 0, forwarded: 0, at: Date.now() },
};

const clients = new Map(); // id -> { ws, sock }
let nextClientId = 1;

const pacer = new Pacer({
  globalPps: cfg.globalPps,
  perServerIntervalMs: cfg.perServerIntervalMs,
  maxQueue: cfg.maxQueue,
  perClientMax: cfg.perClientMax,
  send: (item) => {
    // item = { serverKey, clientId, sock, host, port, payload, size }
    const client = clients.get(item.clientId);
    if (!client) return; // client left while queued
    try {
      item.sock.send(item.payload, item.port, item.host);
      monitor.forwarded++;
      monitor.bytesToServers += item.size;
    } catch {
      /* transient UDP send error; drop this datagram */
    }
  },
});

function sendControl(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(encodeControlFrame(obj));
}

// --- HTTP + WebSocket server ---
const server = http.createServer((req, res) => {
  // Minimal health endpoint; everything else is WebSocket upgrade.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, connections: monitor.connections }));
  } else {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Upgrade Required: this endpoint speaks WebSocket only.\n');
  }
});

const wss = new WebSocketServer({ server, maxPayload: cfg.maxPayload + 16 });

wss.on('connection', (ws, req) => {
  // Load shedding: refuse connections past the cap.
  if (clients.size >= cfg.maxClients) {
    monitor.rejectedConns++;
    ws.close(1013, 'relay at capacity');
    return;
  }
  // Optional origin pinning.
  if (cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(req.headers.origin)) {
    ws.close(1008, 'origin not allowed');
    return;
  }

  const id = nextClientId++;
  const sock = dgram.createSocket('udp4');
  clients.set(id, { ws, sock });
  monitor.connections = clients.size;

  sock.on('message', (msg, rinfo) => {
    // Reply from an ed2k server -> forward to just this client (own socket =
    // unambiguous routing). msg is a Buffer; frame it verbatim (still possibly
    // PACKED/0xD4 — the browser inflates).
    monitor.fromServers++;
    monitor.bytesFromServers += msg.length;
    if (ws.readyState === ws.OPEN) ws.send(encodeDatagramFrame({ host: rinfo.address, port: rinfo.port }, msg));
  });
  sock.on('error', () => {
    /* ignore per-socket errors; a bad reply must not kill the connection */
  });
  sock.bind(); // ephemeral local port

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return; // we only speak binary frames
    let frame;
    try {
      frame = decodeFrame(data);
    } catch {
      return;
    }
    if (frame.type !== FRAME.DATAGRAM) return; // clients only send datagrams
    const { server: dest, payload } = frame;
    if (payload.length === 0 || payload.length > cfg.maxPayload) return;

    const check = checkDestination(dest.host, dest.port);
    if (!check.ok) {
      sendControl(ws, { event: 'error', reason: check.reason, dest: `${dest.host}:${dest.port}` });
      return;
    }

    const res = pacer.enqueue({
      serverKey: `${dest.host}:${dest.port}`,
      clientId: id,
      sock,
      host: dest.host,
      port: dest.port,
      payload,
      size: payload.length,
    });
    if (!res.ok) {
      monitor.shed++;
      sendControl(ws, { event: 'throttle', reason: res.reason });
    }
  });

  const cleanup = () => {
    if (!clients.has(id)) return;
    clients.delete(id);
    pacer.dropClient(id);
    try {
      sock.close();
    } catch {
      /* already closed */
    }
    monitor.connections = clients.size;
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// --- periodic stats + soft backpressure broadcast ---
const statsTimer = setInterval(() => {
  const t = Date.now();
  const dt = (t - monitor._last.at) / 1000 || 1;
  const outBps = Math.round((monitor.bytesToServers - monitor._last.bytesToServers) / dt);
  const inBps = Math.round((monitor.bytesFromServers - monitor._last.bytesFromServers) / dt);
  const pps = Math.round((monitor.forwarded - monitor._last.forwarded) / dt);
  monitor._last = {
    bytesToServers: monitor.bytesToServers,
    bytesFromServers: monitor.bytesFromServers,
    forwarded: monitor.forwarded,
    at: t,
  };
  console.log(
    `[relay] conns=${monitor.connections} queued=${pacer.queued} out=${pps}pps/${outBps}B/s ` +
      `in=${inBps}B/s forwarded=${monitor.forwarded} shed=${monitor.shed} rejected=${monitor.rejectedConns}`,
  );
  // If the outbound queue is backing up, tell clients to ease off.
  if (pacer.queued > cfg.maxQueue * 0.5) {
    const msg = encodeControlFrame({ event: 'throttle', reason: 'relay busy', queued: pacer.queued });
    for (const { ws } of clients.values()) if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}, cfg.statsIntervalMs);
statsTimer.unref?.();

server.listen(cfg.port, cfg.host, () => {
  console.log(
    `[relay] listening ws://${cfg.host}:${cfg.port}  ` +
      `(globalPps=${cfg.globalPps}, perServer=${cfg.perServerIntervalMs}ms, maxClients=${cfg.maxClients}, ` +
      `allowlist=${cfg.allowlist.length || 'off'}, allowPrivate=${cfg.allowPrivate})`,
  );
});

function shutdown() {
  console.log('\n[relay] shutting down');
  clearInterval(statsTimer);
  for (const { ws, sock } of clients.values()) {
    try {
      ws.close(1001, 'relay shutting down');
    } catch {
      /* ignore */
    }
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
