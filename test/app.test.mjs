// Self-tests for the DOM-free app modules: servers.js parsing and cache.js
// (history, keys, results cache). Run: node test/app.test.mjs
// No localStorage in Node -> cache.js falls back to its in-memory store.

import { parseServerLines, formatServerLines, normalizeServer, BUILTIN_SERVERS } from '../src/servers.js';
import { fieldsKey, addHistory, loadHistory, clearHistory, ResultsCache, persistent } from '../src/cache.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗ FAIL:', msg);
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// --- servers: normalization ---
{
  eq(normalizeServer({ host: '1.2.3.4', tcpPort: 4661 }), { name: '1.2.3.4', host: '1.2.3.4', tcpPort: 4661, udpPort: 4665 }, 'udpPort defaults to tcp+4');
  eq(normalizeServer({ name: 'S', host: '1.2.3.4', tcpPort: 4661, udpPort: 4672 }).udpPort, 4672, 'explicit udpPort kept');
  ok(normalizeServer({ host: 'example.com', tcpPort: 4661 }) === null, 'hostname rejected (relay frame is IPv4-only)');
  ok(normalizeServer({ host: '1.2.3.999', tcpPort: 4661 }) === null, 'bad octet rejected');
  ok(normalizeServer({ host: '1.2.3.4' }) === null, 'no ports -> rejected');
}

// --- servers: line parsing (all three accepted forms) ---
{
  const text = [
    '# a comment',
    '',
    '1.2.3.4:4661',
    '5.6.7.8:4661:4670',
    'My Server|9.8.7.6|4242|4246',
    'not-a-server',
    'example.com:4661',
  ].join('\n');
  const { servers, errors } = parseServerLines(text);
  eq(servers.length, 3, 'three servers parsed');
  eq(servers[0], { name: '1.2.3.4', host: '1.2.3.4', tcpPort: 4661, udpPort: 4665 }, 'ip:tcp form');
  eq(servers[1].udpPort, 4670, 'ip:tcp:udp form');
  eq(servers[2], { name: 'My Server', host: '9.8.7.6', tcpPort: 4242, udpPort: 4246 }, 'name|ip|tcp|udp form');
  eq(errors.length, 2, 'two unparseable lines reported');
  eq(parseServerLines('').servers.length, 0, 'empty input -> no servers');
}

// --- servers: round-trip through formatServerLines ---
{
  const { servers } = parseServerLines('A|1.1.1.1|4661|4665\nB|2.2.2.2|5000|5004');
  const { servers: again } = parseServerLines(formatServerLines(servers));
  eq(again, servers, 'format -> parse round-trips');
}

// --- servers: shipped list is empty on purpose (§7) ---
{
  eq(BUILTIN_SERVERS.length, 0, 'no fabricated servers shipped by default');
}

// --- cache: fieldsKey treats BigInt and its persisted string form identically ---
{
  const a = { query: 'x', minSize: 1024n };
  const b = { query: 'x', minSize: '1024' }; // as restored from localStorage JSON
  eq(fieldsKey(a), fieldsKey(b), 'BigInt and string sizes produce the same key');
  ok(fieldsKey({ query: 'x' }) !== fieldsKey({ query: 'y' }), 'different queries -> different keys');
  ok(fieldsKey({ query: 'x', maxSize: 1n }) !== fieldsKey({ query: 'x' }), 'filters affect the key');
  eq(fieldsKey({ query: '  x  ' }), fieldsKey({ query: 'x' }), 'query is trimmed');
}

// --- cache: history persists a BigInt-bearing field set without throwing ---
{
  clearHistory();
  addHistory({ query: 'ubuntu', minSize: 5_000_000_000n }, 'ubuntu >4GiB');
  const list = loadHistory();
  eq(list.length, 1, 'one history entry');
  eq(list[0].label, 'ubuntu >4GiB', 'label stored');
  eq(list[0].fields.minSize, '5000000000', 'BigInt round-trips as a decimal string');

  // Re-adding the same field set bubbles it up rather than duplicating.
  addHistory({ query: 'other' }, 'other');
  addHistory({ query: 'ubuntu', minSize: 5_000_000_000n }, 'ubuntu >4GiB');
  const list2 = loadHistory();
  eq(list2.length, 2, 'dedupe: still two entries');
  eq(list2[0].label, 'ubuntu >4GiB', 're-added search moves to the front');
  clearHistory();
  eq(loadHistory().length, 0, 'clearHistory empties');
}

// --- cache: results cache with TTL ---
{
  const c = new ResultsCache(1000);
  const fields = { query: 'abc' };
  ok(c.get(fields) === null, 'miss on empty cache');
  c.set(fields, [{ hashHex: 'aa' }]);
  eq(c.get(fields).length, 1, 'hit after set');
  eq(c.get({ query: 'abc' }).length, 1, 'hit by value-equal field set');
  ok(c.get({ query: 'zzz' }) === null, 'miss for a different query');

  const expired = new ResultsCache(-1); // everything is already stale
  expired.set(fields, [{ hashHex: 'bb' }]);
  ok(expired.get(fields) === null, 'entry past TTL is evicted');

  c.clear();
  ok(c.get(fields) === null, 'clear empties the cache');
}

// --- cache: degrades gracefully without localStorage ---
{
  ok(persistent === false, 'no localStorage in Node -> persistent=false, memory fallback used');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
