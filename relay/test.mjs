// Relay unit tests: pacer scheduling + destination guard + control-frame interop.
// Pure logic only (no ws/dgram/network). Run: node relay/test.mjs
// The pacer's clock is injected so pacing is tested deterministically.

import { Pacer } from './pacer.js';
import { isForbiddenDestination, isValidPort, makeDestinationCheck } from './guard.js';
import { encodeControlFrame, decodeFrame, FRAME } from '../src/transport.js';

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

// --- guard: reserved ranges ---
{
  for (const bad of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255', '0.0.0.0', 'example.com', '1.2.3']) {
    ok(isForbiddenDestination(bad), `forbidden: ${bad}`);
  }
  for (const good of ['1.1.1.1', '8.8.8.8', '203.0.113.9', '212.63.206.126']) {
    ok(!isForbiddenDestination(good), `allowed: ${good}`);
  }
  ok(isValidPort(4665) && !isValidPort(0) && !isValidPort(70000), 'port validation');
}

// --- guard: allowlist + allowPrivate ---
{
  const list = makeDestinationCheck({ allowlist: ['1.2.3.4:4665'] });
  eq(list('1.2.3.4', 4665), { ok: true }, 'allowlisted destination passes');
  eq(list('8.8.8.8', 4665).ok, false, 'non-allowlisted destination blocked even if public');
  const priv = makeDestinationCheck({ allowPrivate: true });
  eq(priv('127.0.0.1', 4665), { ok: true }, 'allowPrivate lets loopback through (local dev)');
  eq(makeDestinationCheck({})('10.0.0.1', 4665).ok, false, 'default blocks private');
}

// --- control-frame interop with the browser codec ---
{
  const frame = encodeControlFrame({ event: 'throttle', reason: 'relay busy', queued: 42 });
  const dec = decodeFrame(frame);
  eq(dec.type, FRAME.CONTROL, 'control frame type');
  eq(dec.control, { event: 'throttle', reason: 'relay busy', queued: 42 }, 'control payload round-trips');
}

// --- pacer: global token bucket limits burst ---
{
  const sent = [];
  // 10 pps => 1 token / 100ms, burst capacity 10. now injected.
  const p = new Pacer({ globalPps: 10, perServerIntervalMs: 0, send: (i) => sent.push(i.serverKey), now: () => 0 });
  for (let i = 0; i < 15; i++) p.enqueue({ serverKey: `s${i}`, clientId: 1 });
  // At t=0, only the burst capacity (10) may go out.
  const d0 = p.pump(0);
  eq(sent.length, 10, 'burst capped at capacity (10)');
  ok(d0 > 0, 'pump reports a wait for the remainder');
  // After 500ms, 5 more tokens refill -> remaining 5 sent.
  p.pump(500);
  eq(sent.length, 15, 'remaining datagrams sent after refill');
}

// --- pacer: per-server pacing spaces packets to one server without blocking others ---
{
  const sent = [];
  const p = new Pacer({
    globalPps: 1000, // effectively unlimited globally
    perServerIntervalMs: 200,
    send: (i) => sent.push({ key: i.serverKey, tag: i.tag }),
    now: () => 0,
  });
  // Three datagrams to server A, one to server B.
  p.enqueue({ serverKey: 'A', clientId: 1, tag: 'a1' });
  p.enqueue({ serverKey: 'A', clientId: 1, tag: 'a2' });
  p.enqueue({ serverKey: 'A', clientId: 1, tag: 'a3' });
  p.enqueue({ serverKey: 'B', clientId: 1, tag: 'b1' });
  p.pump(0);
  // First A and B go immediately (different servers); the other two A's are paced.
  eq(sent.map((s) => s.tag).sort(), ['a1', 'b1'], 'one per server at t=0 (B not blocked behind A)');
  p.pump(200);
  eq(sent.length, 3, 'second A after 200ms');
  p.pump(400);
  eq(sent.length, 4, 'third A after another 200ms');
  eq(sent[sent.length - 1].tag, 'a3', 'A datagrams sent in order');
}

// --- pacer: queue + per-client caps shed with a reason ---
{
  const p = new Pacer({ globalPps: 1, perServerIntervalMs: 10_000, maxQueue: 3, perClientMax: 2, send: () => {}, now: () => 0 });
  eq(p.enqueue({ serverKey: 'x', clientId: 1 }).ok, true, 'first enqueue ok');
  eq(p.enqueue({ serverKey: 'x', clientId: 1 }).ok, true, 'second enqueue ok');
  eq(p.enqueue({ serverKey: 'x', clientId: 1 }), { ok: false, reason: 'client backlog full' }, 'per-client cap sheds');
  // A different client can still enqueue until the global queue cap.
  eq(p.enqueue({ serverKey: 'x', clientId: 2 }).ok, true, 'other client still queues');
  eq(p.enqueue({ serverKey: 'x', clientId: 2 }), { ok: false, reason: 'relay queue full' }, 'global queue cap sheds');
}

// --- pacer: dropClient removes a client's queued datagrams ---
{
  const p = new Pacer({ globalPps: 1, perServerIntervalMs: 10_000, send: () => {}, now: () => 0 });
  p.enqueue({ serverKey: 'x', clientId: 1 });
  p.enqueue({ serverKey: 'y', clientId: 2 });
  p.enqueue({ serverKey: 'z', clientId: 1 });
  eq(p.queued, 3, 'three queued');
  p.dropClient(1);
  eq(p.queued, 1, "client 1's datagrams dropped");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
