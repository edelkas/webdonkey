// Self-tests for search.js orchestration, driven end-to-end over the in-process
// LoopbackTransport. Run: node test/search.test.mjs

import { LoopbackTransport } from '../src/transport.js';
import { SearchEngine, ServerState, serverKey } from '../src/search.js';
import { ByteWriter, PROTO, OP, FT, UDPFLG, hexToBytes, node } from '../src/protocol.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗ FAIL:', msg);
  }
}
const ser = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
function eq(a, b, msg) {
  ok(ser(a) === ser(b), `${msg} (got ${ser(a)}, want ${ser(b)})`);
}

// --- datagram builders (simulate a server) ---
const readU32LE = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function statusRes(challenge, flags) {
  return new ByteWriter()
    .u8(PROTO.EDONKEY).u8(OP.GLOBSERVSTATRES)
    .u32(challenge) // challenge (echoed)
    .u32(100).u32(200) // users, files
    .u32(0).u32(0).u32(0) // maxUsers, soft, hard
    .u32(flags) // udpFlags @ offset 24
    .toUint8Array();
}

function searchRes(hashHex, name, size, sources) {
  const w = new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSEARCHRES);
  w.raw(hexToBytes(hashHex)).u32(0).u16(0).u32(3);
  w.u8(0x02).u16(1).u8(FT.FILENAME).str(name);
  w.u8(0x03).u16(1).u8(FT.FILESIZE).u32(Number(size));
  w.u8(0x03).u16(1).u8(FT.SOURCES).u32(sources);
  return w.toUint8Array();
}

function runToDone(search) {
  return new Promise((resolve) => {
    const progress = [];
    const results = [];
    const logs = [];
    search.on('progress', (p) => progress.push(p));
    search.on('results', (r) => results.push(r));
    search.on('log', (l) => logs.push(l.message));
    search.on('done', (d) => resolve({ done: d, progress, results, logs }));
    search.start();
  });
}

const FAST = { pingTimeoutMs: 150, serverTimeoutMs: 40, flagsTtlMs: 60_000 };
const SHARED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function main() {
  // ============================================================
  // 1. Two servers, different flags -> different variants; dedupe/merge
  // ============================================================
  {
    const A = { host: '10.0.0.1', udpPort: 4665, name: 'A' };
    const B = { host: '10.0.0.2', udpPort: 4665, name: 'B' };
    const flagsFor = {
      [serverKey(A)]: UDPFLG.LARGEFILES | UDPFLG.EXT_GETFILES, // -> REQ3 (0x90)
      [serverKey(B)]: UDPFLG.EXT_GETFILES, // -> REQ2 (0x92)
    };
    const nameFor = { [serverKey(A)]: 'ubuntu-a.iso', [serverKey(B)]: 'ubuntu-b.iso' };
    const sourcesFor = { [serverKey(A)]: 10, [serverKey(B)]: 20 };
    const seenOpcode = {};

    const t = new LoopbackTransport();
    t.setResponder((dst, bytes) => {
      const key = `${dst.host}:${dst.port}`;
      if (bytes[1] === OP.GLOBSERVSTATREQ) {
        return [{ server: dst, bytes: statusRes(readU32LE(bytes, 2), flagsFor[key]) }];
      }
      seenOpcode[key] = bytes[1];
      return [
        { server: dst, bytes: searchRes(SHARED, nameFor[key], 1000n, sourcesFor[key]) },
        { server: dst, bytes: searchRes(`${key === serverKey(A) ? '11' : '22'}`.repeat(16), `only-${key}`, 2000n, 5) },
      ];
    });
    await t.connect();

    const engine = new SearchEngine({ transport: t, servers: [A, B], config: FAST }).start();
    const { done, progress } = await runToDone(engine.createSearch(node.str('ubuntu'), { query: 'ubuntu' }));

    eq(seenOpcode[serverKey(A)], OP.GLOBSEARCHREQ3, 'server A queried with REQ3 (LARGEFILES+EXT_GETFILES)');
    eq(seenOpcode[serverKey(B)], OP.GLOBSEARCHREQ2, 'server B queried with REQ2 (EXT_GETFILES only)');

    const byHash = new Map(done.results.map((r) => [r.hashHex, r]));
    eq(done.results.length, 3, 'three unique files (1 shared + 2 unique)');
    const shared = byHash.get(SHARED);
    ok(shared, 'shared-hash result present');
    eq(shared.servers.size, 2, 'shared file reported by both servers (deduped)');
    eq(shared.sources, 30, 'shared sources summed across servers (10+20)');
    eq(shared.names.size, 2, 'both filenames recorded in histogram');
    ok(shared.names.get('ubuntu-a.iso') === 1 && shared.names.get('ubuntu-b.iso') === 1, 'name counts');
    ok(shared.name === 'ubuntu-a.iso' || shared.name === 'ubuntu-b.iso', 'primary name is one of the reported names');

    const last = progress[progress.length - 1];
    eq(last.settled, 2, 'both servers settled');
    eq(last.fraction, 1, 'progress fraction reaches 1');
    eq(last[ServerState.RESPONDED], 2, 'both servers responded');
    eq(done.cancelled, false, 'not cancelled');
  }

  // ============================================================
  // 2. 64-bit search skips a server lacking large-file support
  // ============================================================
  {
    const big = { host: '10.0.1.1', udpPort: 4665 }; // LARGEFILES+EXT -> REQ3
    const small = { host: '10.0.1.2', udpPort: 4665 }; // EXT only -> would be REQ2, but skip
    const flagsFor = {
      [serverKey(big)]: UDPFLG.LARGEFILES | UDPFLG.EXT_GETFILES,
      [serverKey(small)]: UDPFLG.EXT_GETFILES,
    };
    const queried = new Set();

    const t = new LoopbackTransport();
    t.setResponder((dst, bytes) => {
      const key = `${dst.host}:${dst.port}`;
      if (bytes[1] === OP.GLOBSERVSTATREQ) return [{ server: dst, bytes: statusRes(readU32LE(bytes, 2), flagsFor[key]) }];
      queried.add(key);
      return [{ server: dst, bytes: searchRes(SHARED, 'huge.bin', 1000n, 1) }];
    });
    await t.connect();

    const engine = new SearchEngine({ transport: t, servers: [big, small], config: FAST }).start();
    // maxSize > 4 GiB forces a 64-bit numeric node.
    const tree = node.and(node.str('huge'), node.max(FT.FILESIZE, 5_000_000_000n));
    const { done, progress, logs } = await runToDone(engine.createSearch(tree));

    ok(queried.has(serverKey(big)), 'large-file server was queried');
    ok(!queried.has(serverKey(small)), 'non-large-file server was NOT queried (skipped)');
    ok(logs.some((l) => l.includes('Skipping') && l.includes('large file')), 'skip logged with reason');
    const last = progress[progress.length - 1];
    eq(last[ServerState.SKIPPED], 1, 'one server skipped');
    eq(last[ServerState.RESPONDED], 1, 'one server responded');
    eq(last.fraction, 1, 'all servers settled');
    ok(done.finished !== false, 'search completed');
  }

  // ============================================================
  // 3. Ping timeout -> server marked timedout, no results
  // ============================================================
  {
    const dead = { host: '10.0.2.1', udpPort: 4665 };
    const t = new LoopbackTransport();
    t.setResponder((dst, bytes) => {
      if (bytes[1] === OP.GLOBSERVSTATREQ) return []; // never answers the ping
      return [];
    });
    await t.connect();
    const engine = new SearchEngine({ transport: t, servers: [dead], config: { ...FAST, pingTimeoutMs: 50 } }).start();
    const { done, progress, logs } = await runToDone(engine.createSearch(node.str('nothing')));
    eq(done.results.length, 0, 'no results from dead server');
    const last = progress[progress.length - 1];
    eq(last[ServerState.TIMEDOUT], 1, 'dead server timed out');
    ok(logs.some((l) => l.includes('No status reply')), 'ping timeout logged');
  }

  // ============================================================
  // 4. Flags cache: second search reuses cached flags (no re-ping)
  // ============================================================
  {
    const S = { host: '10.0.3.1', udpPort: 4665 };
    let pings = 0;
    const t = new LoopbackTransport();
    t.setResponder((dst, bytes) => {
      if (bytes[1] === OP.GLOBSERVSTATREQ) {
        pings++;
        return [{ server: dst, bytes: statusRes(readU32LE(bytes, 2), UDPFLG.EXT_GETFILES) }];
      }
      return [{ server: dst, bytes: searchRes(SHARED, 'x.bin', 1000n, 1) }];
    });
    await t.connect();
    const engine = new SearchEngine({ transport: t, servers: [S], config: FAST }).start();
    await runToDone(engine.createSearch(node.str('a')));
    await runToDone(engine.createSearch(node.str('b')));
    eq(pings, 1, 'server pinged once; second search reused cached flags');
  }

  // ============================================================
  // 5. Cancel mid-flight
  // ============================================================
  {
    const S = { host: '10.0.4.1', udpPort: 4665 };
    const t = new LoopbackTransport();
    t.setResponder((dst, bytes) => {
      if (bytes[1] === OP.GLOBSERVSTATREQ) return [{ server: dst, bytes: statusRes(readU32LE(bytes, 2), UDPFLG.EXT_GETFILES) }];
      return []; // sends nothing back, so the search would sit in its result window
    });
    await t.connect();
    const engine = new SearchEngine({ transport: t, servers: [S], config: { ...FAST, serverTimeoutMs: 10_000 } }).start();
    const search = engine.createSearch(node.str('c'));
    const donePromise = new Promise((resolve) => search.on('done', resolve));
    search.start();
    await new Promise((r) => setTimeout(r, 30)); // let it ping + send the search
    search.cancel();
    const done = await donePromise;
    eq(done.cancelled, true, 'done reports cancelled');
    ok(search.finished, 'search marked finished after cancel');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
