// Self-tests for transport.js. Run: node test/transport.test.mjs
// Covers the relay frame codec, PACKED inflation, and the loopback backend
// end-to-end (send -> responder -> inflate -> onDatagram).

import {
  FRAME,
  ipv4ToBytes,
  bytesToIpv4,
  encodeDatagramFrame,
  decodeFrame,
  inflateIfPacked,
  LoopbackTransport,
  RelayTransport,
  createTransport,
} from '../src/transport.js';
import { PROTO, OP, ByteWriter, buildStatusRequest, parseSearchResults, FT, hexToBytes } from '../src/protocol.js';

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

// zlib deflate helper (mirror of the inflate path) to synthesize PACKED datagrams
async function deflateZlib(bytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const chunks = [];
  const readAll = (async () => {
    const reader = cs.readable.getReader();
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

async function main() {
  // --- IPv4 helpers ---
  {
    eq([...ipv4ToBytes('192.168.1.50')], [192, 168, 1, 50], 'ipv4ToBytes');
    eq(bytesToIpv4(new Uint8Array([10, 0, 0, 1])), '10.0.0.1', 'bytesToIpv4');
    let threw = false;
    try {
      ipv4ToBytes('example.com');
    } catch {
      threw = true;
    }
    ok(threw, 'ipv4ToBytes rejects hostnames');
    let threw2 = false;
    try {
      ipv4ToBytes('1.2.3.999');
    } catch {
      threw2 = true;
    }
    ok(threw2, 'ipv4ToBytes rejects out-of-range octet');
  }

  // --- frame codec round-trip ---
  {
    const payload = buildStatusRequest(0x12345678);
    const frame = encodeDatagramFrame({ host: '192.168.1.50', port: 4665 }, payload);
    eq(frame[0], FRAME.DATAGRAM, 'frame type = DATAGRAM');
    const dec = decodeFrame(frame);
    eq(dec.type, FRAME.DATAGRAM, 'decoded type');
    eq(dec.server, { host: '192.168.1.50', port: 4665 }, 'decoded server');
    eq([...dec.payload], [...payload], 'decoded payload round-trips');
  }

  // --- decode a control frame ---
  {
    const json = JSON.stringify({ event: 'throttle', perServer: 3 });
    const bytes = new Uint8Array(1 + json.length);
    bytes[0] = FRAME.CONTROL;
    bytes.set(new TextEncoder().encode(json), 1);
    const dec = decodeFrame(bytes);
    eq(dec.type, FRAME.CONTROL, 'control frame type');
    eq(dec.control.event, 'throttle', 'control payload parsed');
  }

  // --- inflateIfPacked: passthrough for plaintext ---
  {
    const plain = new Uint8Array([PROTO.EDONKEY, OP.GLOBSEARCHRES, 1, 2, 3]);
    const out = await inflateIfPacked(plain);
    eq([...out], [...plain], 'plaintext datagram passes through unchanged');
  }

  // --- inflateIfPacked: real PACKED datagram round-trips to 0xE3 ---
  {
    const body = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const packed = new Uint8Array(2 + (await deflateZlib(body)).length);
    packed[0] = PROTO.PACKED;
    packed[1] = OP.GLOBSEARCHRES;
    packed.set(await deflateZlib(body), 2);
    const out = await inflateIfPacked(packed);
    eq(out[0], PROTO.EDONKEY, 'inflated header -> 0xE3');
    eq(out[1], OP.GLOBSEARCHRES, 'inflated opcode preserved');
    eq([...out.subarray(2)], [...body], 'inflated body matches original');
  }

  // --- loopback end-to-end: a PACKED search result is inflated + parsed ---
  {
    // Build a real search-result datagram, then compress it as the server would.
    const w = new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSEARCHRES);
    w.raw(hexToBytes('0123456789abcdef0123456789abcdef')).u32(0).u16(0).u32(2);
    w.u8(0x02).u16(1).u8(FT.FILENAME).str('packed-result.bin');
    w.u8(0x03).u16(1).u8(FT.FILESIZE).u32(123456);
    const plainDatagram = w.toUint8Array();
    const compressedBody = await deflateZlib(plainDatagram.subarray(2));
    const packed = new Uint8Array(2 + compressedBody.length);
    packed[0] = PROTO.PACKED;
    packed[1] = OP.GLOBSEARCHRES;
    packed.set(compressedBody, 2);

    const t = new LoopbackTransport();
    const server = { host: '10.0.0.1', port: 4665 };
    t.setResponder((dst, bytes) => {
      ok(bytes[1] === OP.GLOBSERVSTATREQ || bytes[1] === OP.GLOBSEARCHREQ3, 'responder saw a request opcode');
      return [{ server: dst, bytes: packed }];
    });

    const received = [];
    t.onDatagram((from, bytes) => received.push({ from, bytes }));
    await t.connect();
    ok(t.ready, 'loopback ready after connect');
    t.sendDatagram(server, buildStatusRequest(1));
    await new Promise((r) => setTimeout(r, 10)); // let the async delivery run

    eq(received.length, 1, 'one datagram delivered');
    eq(received[0].from, server, 'delivered with source server');
    eq(received[0].bytes[0], PROTO.EDONKEY, 'delivered datagram is inflated (0xE3)');
    const results = parseSearchResults(received[0].bytes);
    eq(results.length, 1, 'inflated datagram parses to one result');
    eq(results[0].name, 'packed-result.bin', 'result name after inflation');
    eq(results[0].size, 123456n, 'result size after inflation');
  }

  // --- factory guards ---
  {
    ok(createTransport({ loopback: true }) instanceof LoopbackTransport, 'factory: loopback');
    ok(createTransport({ relayUrl: 'wss://x' }) instanceof RelayTransport, 'factory: relay');
    let threw = false;
    try {
      createTransport({});
    } catch {
      threw = true;
    }
    ok(threw, 'factory: relay requires relayUrl');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
