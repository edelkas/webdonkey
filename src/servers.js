// servers.js — the ed2k server list (CLAUDE.md §7).
//
// ⚠️ `host` MUST be an IPv4 literal: the relay frame packs it as 4 raw bytes
//    (src/transport.js), so hostnames are rejected. Resolve them beforehand.
//
// `udpPort` is conventionally `tcpPort + 4`, but always prefer the server's
// actually-advertised UDP port when you know it.
//
// The built-in list below is intentionally EMPTY: server IPs churn constantly and
// shipping stale/wrong ones is worse than shipping none. Populate it with a list
// you trust, or paste one into the app's Settings panel at runtime (persisted to
// localStorage, parsed by `parseServerLines` below).
//
// Example entries:
//   { name: 'Some Server', host: '203.0.113.10', tcpPort: 4661, udpPort: 4665 },

/** @typedef {{name?:string, host:string, tcpPort:number, udpPort:number}} Server */

/** @type {Server[]} */
export const BUILTIN_SERVERS = [];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(host) {
  const m = IPV4.exec(host);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** Normalize/validate a server entry; returns null if unusable. */
export function normalizeServer(s) {
  if (!s || !isIpv4(s.host)) return null;
  const tcpPort = Number(s.tcpPort) || 0;
  const udpPort = Number(s.udpPort) || (tcpPort ? tcpPort + 4 : 0);
  if (!udpPort || udpPort > 65535) return null;
  return { name: s.name || s.host, host: s.host, tcpPort, udpPort };
}

/**
 * Parse a pasted server list. One server per line; blank lines and `#` comments
 * ignored. Accepted forms:
 *   1.2.3.4:4661                 (udp = tcp + 4)
 *   1.2.3.4:4661:4665            (explicit udp)
 *   Name|1.2.3.4|4661|4665       (server.met-ish, udp optional)
 * @returns {{servers:Server[], errors:string[]}}
 */
export function parseServerLines(text) {
  const servers = [];
  const errors = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let parsed = null;
    if (line.includes('|')) {
      const [name, host, tcp, udp] = line.split('|').map((s) => s.trim());
      parsed = normalizeServer({ name, host, tcpPort: tcp, udpPort: udp });
    } else {
      const [host, tcp, udp] = line.split(':').map((s) => s.trim());
      parsed = normalizeServer({ host, tcpPort: tcp, udpPort: udp });
    }
    if (parsed) servers.push(parsed);
    else errors.push(line);
  }
  return { servers, errors };
}

/** Serialize servers back to the `Name|ip|tcp|udp` line form. */
export function formatServerLines(servers) {
  return servers.map((s) => `${s.name}|${s.host}|${s.tcpPort}|${s.udpPort}`).join('\n');
}
