// guard.js — destination validation for the relay.
//
// The relay forwards arbitrary client-chosen UDP datagrams, so without checks it
// could be abused to probe or flood hosts the operator never intended (SSRF via
// UDP). We block private/loopback/reserved IPv4 ranges by default; an operator
// can also pin the relay to an explicit allowlist of ed2k servers.

/** Parse "a.b.c.d" into a uint32, or null if not a valid dotted IPv4. */
function ipv4ToInt(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

// [startInclusive, prefixBits] blocks to reject.
const BLOCKED = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (incl. 255.255.255.255 broadcast)
].map(([base, bits]) => {
  const start = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { start, mask };
});

/**
 * @param {string} host  IPv4 literal
 * @returns {boolean} true if this destination must NOT be forwarded to
 */
export function isForbiddenDestination(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return true; // not a plain IPv4 -> reject
  for (const { start, mask } of BLOCKED) {
    if ((ip & mask) === (start & mask)) return true;
  }
  return false;
}

/** True if port is a usable UDP port. */
export function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/**
 * Build a destination check honoring an optional allowlist of "ip:port" strings.
 * When the allowlist is non-empty, only those exact destinations are permitted;
 * otherwise the reserved-range block applies. `allowPrivate` disables the
 * reserved-range block (for local testing only).
 */
export function makeDestinationCheck({ allowlist = [], allowPrivate = false } = {}) {
  const allow = new Set(allowlist);
  return (host, port) => {
    if (!isValidPort(port)) return { ok: false, reason: 'invalid port' };
    if (allow.size > 0) {
      return allow.has(`${host}:${port}`) ? { ok: true } : { ok: false, reason: 'not in allowlist' };
    }
    if (!allowPrivate && isForbiddenDestination(host)) return { ok: false, reason: 'forbidden destination' };
    return { ok: true };
  };
}
