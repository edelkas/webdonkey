// Minimal self-tests for the pure protocol/expr modules. Run: node test/protocol.test.mjs
// No test framework — just assertions and a summary. Exit code != 0 on failure.

import {
  ByteWriter,
  ByteReader,
  serializeSearchTree,
  parseSearchResults,
  parseStatusResponse,
  buildStatusRequest,
  buildSearchRequest,
  applyObfuscationPortDefaults,
  buildEd2kLink,
  chooseSearchVariant,
  planServerRequest,
  treeUses64Bit,
  hashToHex,
  hexToBytes,
  node,
  PROTO,
  OP,
  FT,
  UDPFLG,
  SEARCH_VARIANT,
  SEARCH_OP,
} from '../src/protocol.js';
import { parseBooleanQuery, buildSearchTree } from '../src/expr.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('  ✗ FAIL:', msg);
  }
}
const ser = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
function eq(a, b, msg) {
  ok(ser(a) === ser(b), `${msg} (got ${ser(a)}, want ${ser(b)})`);
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// --- ByteWriter/Reader round-trip ---
{
  const w = new ByteWriter().u8(0xe3).u16(0x1234).u32(0xdeadbeef).u64(0x1_0000_0000n).str('hí');
  const r = new ByteReader(w.toUint8Array());
  eq(r.u8(), 0xe3, 'u8');
  eq(r.u16(), 0x1234, 'u16');
  eq(r.u32(), 0xdeadbeef, 'u32');
  eq(r.u64(), 0x1_0000_0000n, 'u64');
  eq(r.str(), 'hí', 'utf8 str');
}

// --- hash hex round-trip ---
{
  const h = 'ed20000000000000000000000000beef';
  eq(hashToHex(hexToBytes(h)), h, 'hash hex round-trip');
}

// --- boolean parser precedence ---
{
  // "a b" => AND(a,b)
  const t1 = parseBooleanQuery('a b');
  eq(t1, node.and(node.str('a'), node.str('b')), 'implicit AND');

  // "a OR b c" => OR(a, AND(b,c))  (AND binds tighter than OR)
  const t2 = parseBooleanQuery('a OR b c');
  eq(t2, node.or(node.str('a'), node.and(node.str('b'), node.str('c'))), 'OR/AND precedence');

  // "NOT a b" => AND(NOT a, b)
  const t3 = parseBooleanQuery('NOT a b');
  eq(t3, node.and(node.not(node.str('a')), node.str('b')), 'NOT binds to single term');

  // "(a OR b) c" grouping
  const t4 = parseBooleanQuery('(a OR b) c');
  eq(t4, node.and(node.or(node.str('a'), node.str('b')), node.str('c')), 'parenthesized OR');

  // quoted phrase kept whole
  const t5 = parseBooleanQuery('"hello world"');
  eq(t5, node.str('hello world'), 'quoted phrase');

  // empty
  eq(parseBooleanQuery('   '), null, 'empty query -> null');

  // tolerate missing close paren
  ok(parseBooleanQuery('(a b') !== null, 'missing close paren tolerated');
}

// --- buildSearchTree combines fields ---
{
  const tree = buildSearchTree({ query: 'ubuntu', type: 'Iso', minSize: 1000, maxSize: 5000 });
  // AND(ubuntu, meta Iso, min 1000, max 5000)
  eq(tree, node.and(
    node.str('ubuntu'),
    node.meta('Iso', FT.FILETYPE),
    node.min(FT.FILESIZE, 1000n),
    node.max(FT.FILESIZE, 5000n),
  ), 'buildSearchTree combines query + type + size');

  eq(buildSearchTree({}), null, 'no fields -> null tree');
  eq(buildSearchTree({ type: 'Audio' }), node.meta('Audio', FT.FILETYPE), 'single constraint unwrapped');
}

// --- serialize a simple tree (structural sanity, not wire-final) ---
{
  const bytes = serializeSearchTree(node.and(node.str('foo'), node.str('bar')));
  // 00 00  (AND)   01 03 00 'foo'   01 03 00 'bar'
  const expected = [0x00, 0x00, 0x01, 0x03, 0x00, 0x66, 0x6f, 0x6f, 0x01, 0x03, 0x00, 0x62, 0x61, 0x72];
  eq([...bytes], expected, 'serialize AND(foo,bar)');

  // meta: 02 <len 'Audio'> 'Audio' 01 00 03(FILETYPE)
  const m = serializeSearchTree(node.meta('Audio', FT.FILETYPE));
  eq([...m], [0x02, 0x05, 0x00, 0x41, 0x75, 0x64, 0x69, 0x6f, 0x01, 0x00, 0x03], 'serialize meta Audio');

  // numeric min size (fits in 32-bit): type 3, u32 1000, op GREATER_EQUAL(3),
  // namelen 1, FILESIZE(0x02).
  const nmin = serializeSearchTree(node.min(FT.FILESIZE, 1000));
  eq([...nmin], [0x03, 0xe8, 0x03, 0x00, 0x00, 0x03, 0x01, 0x00, 0x02], 'serialize min size 32-bit');

  // large value + supports64: type 8, u64, op LESS_EQUAL(4), namelen 1, FILESIZE.
  const big = 5_000_000_000n; // > 0xFFFFFFFF
  const nbig = serializeSearchTree(node.max(FT.FILESIZE, big), { supports64: true });
  const v = new ByteWriter().u64(big).toUint8Array();
  eq([...nbig], [0x08, ...v, 0x04, 0x01, 0x00, 0x02], 'serialize max size 64-bit');

  // large value but server lacks 64-bit support => clamp to 0xFFFFFFFF, type 3.
  const nclamp = serializeSearchTree(node.max(FT.FILESIZE, big), { supports64: false });
  eq([...nclamp], [0x03, 0xff, 0xff, 0xff, 0xff, 0x04, 0x01, 0x00, 0x02], 'clamp 64-bit to 32 when unsupported');

  // generic operators + string tag name.
  const ngt = serializeSearchTree(node.num(FT.SOURCES, 'gt', 10));
  eq([...ngt], [0x03, 0x0a, 0x00, 0x00, 0x00, SEARCH_OP.GREATER, 0x01, 0x00, FT.SOURCES], 'generic gt operator');
}

// --- packet builders ---
{
  const stat = buildStatusRequest(0xaabbccdd);
  eq([...stat], [PROTO.EDONKEY, OP.GLOBSERVSTATREQ, 0xdd, 0xcc, 0xbb, 0xaa], 'status request');

  // REQ1/REQ2: header + opcode + tree (no prefix).
  const req1 = buildSearchRequest({ variant: SEARCH_VARIANT.REQ1, tree: node.str('x') });
  eq([...req1], [PROTO.EDONKEY, OP.GLOBSEARCHREQ, 0x01, 0x01, 0x00, 0x78], 'REQ1 = header+opcode+tree');

  // REQ3: header + opcode + <u32 count=1> + newtag(89 0E 01) + tree.
  const req3 = buildSearchRequest({ variant: SEARCH_VARIANT.REQ3, tree: node.str('x') });
  eq(
    [...req3],
    [PROTO.EDONKEY, OP.GLOBSEARCHREQ3, 0x01, 0x00, 0x00, 0x00, 0x89, 0x0e, 0x01, 0x01, 0x01, 0x00, 0x78],
    'REQ3 prefix = tagcount + CT_SERVER_UDPSEARCH_FLAGS newtag + tree',
  );
}

// --- variant selection (per eMule OnTimer) ---
{
  eq(chooseSearchVariant(UDPFLG.LARGEFILES | UDPFLG.EXT_GETFILES), SEARCH_VARIANT.REQ3, 'LARGEFILES+EXT_GETFILES -> REQ3');
  eq(chooseSearchVariant(UDPFLG.EXT_GETFILES), SEARCH_VARIANT.REQ2, 'EXT_GETFILES -> REQ2');
  eq(chooseSearchVariant(UDPFLG.LARGEFILES), SEARCH_VARIANT.REQ1, 'LARGEFILES without EXT_GETFILES -> REQ1');
  eq(chooseSearchVariant(0), SEARCH_VARIANT.REQ1, 'no flags -> REQ1');

  // planServerRequest: skip 64-bit search on servers lacking large-file support.
  eq(planServerRequest(UDPFLG.EXT_GETFILES, true), { skip: true, reason: 'no large file support' }, 'skip 64-bit on non-large server');
  eq(planServerRequest(UDPFLG.LARGEFILES | UDPFLG.EXT_GETFILES, true), { variant: SEARCH_VARIANT.REQ3 }, '64-bit ok on large+ext server');
  eq(planServerRequest(UDPFLG.EXT_GETFILES, false), { variant: SEARCH_VARIANT.REQ2 }, '32-bit search -> REQ2');
}

// --- treeUses64Bit ---
{
  ok(treeUses64Bit(node.max(FT.FILESIZE, 5_000_000_000n)), 'detects 64-bit value');
  ok(!treeUses64Bit(node.and(node.str('a'), node.max(FT.FILESIZE, 1000))), 'no false positive on 32-bit');
}

// --- parse a full (40-byte body) status response ---
{
  const w = new ByteWriter()
    .u8(PROTO.EDONKEY).u8(OP.GLOBSERVSTATRES)
    .u32(0x11223344) // [0] challenge
    .u32(12345) // [4] users
    .u32(67890) // [8] files
    .u32(500) // [12] maxUsers
    .u32(1000) // [16] softFiles
    .u32(2000) // [20] hardFiles
    .u32(UDPFLG.LARGEFILES | UDPFLG.UNICODE | UDPFLG.EXT_GETFILES) // [24] flags
    .u32(42) // [28] lowIdUsers
    .u16(5000) // [32] udpObfPort
    .u16(6000) // [34] tcpObfPort
    .u32(0xdeadbeef); // [36] udpKey
  const st = parseStatusResponse(w.toUint8Array());
  eq(st.challenge, 0x11223344, 'status challenge');
  eq(st.users, 12345, 'status users');
  eq(st.files, 67890, 'status files');
  eq(st.maxUsers, 500, 'status maxUsers');
  eq(st.softFiles, 1000, 'status softFiles');
  eq(st.hardFiles, 2000, 'status hardFiles');
  ok((st.flags & UDPFLG.LARGEFILES) !== 0, 'status flags LARGEFILES set (offset 24)');
  ok((st.flags & UDPFLG.EXT_GETFILES) !== 0, 'status flags EXT_GETFILES set');
  eq(st.lowIdUsers, 42, 'status lowIdUsers');
  eq(st.udpObfuscationPort, 5000, 'status udpObfuscationPort');
  eq(st.tcpObfuscationPort, 6000, 'status tcpObfuscationPort');
  eq(st.udpKey, 0xdeadbeef, 'status udpKey');
}

// --- truncated status response (12-byte body: challenge+users+files only) ---
{
  const w = new ByteWriter()
    .u8(PROTO.EDONKEY).u8(OP.GLOBSERVSTATRES)
    .u32(0xaabbccdd).u32(7).u32(8);
  const st = parseStatusResponse(w.toUint8Array());
  eq(st.challenge, 0xaabbccdd, 'short status challenge');
  eq(st.flags, 0, 'short status flags default 0');
  eq(st.maxUsers, 0, 'short status maxUsers default 0');
  // body < 12 => null
  eq(parseStatusResponse(new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSERVSTATRES).u32(1).toUint8Array()), null, 'too-short body -> null');
}

// --- obfuscation default ports ---
{
  const st = { flags: UDPFLG.UDP_OBFUSCATION | UDPFLG.TCP_OBFUSCATION, udpObfuscationPort: 0, tcpObfuscationPort: 0 };
  applyObfuscationPortDefaults(st, 4661);
  eq(st.tcpObfuscationPort, 4661, 'default TCP obf port = server TCP port');
  eq(st.udpObfuscationPort, 4661 + 12, 'default UDP obf port = TCP port + 12');
}

// --- parse a synthesized search result (one file entry) ---
{
  const hash = hexToBytes('0123456789abcdef0123456789abcdef');
  // tag helper (old-format tag: type, u16 namelen=1, name byte, value)
  const w = new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSEARCHRES);
  w.raw(hash).u32(0).u16(0).u32(3); // hash, id, port, tagcount=3
  // filename (string tag)
  w.u8(0x02).u16(1).u8(FT.FILENAME).str('ubuntu.iso');
  // size (uint32 tag)
  w.u8(0x03).u16(1).u8(FT.FILESIZE).u32(4096);
  // sources (uint32 tag)
  w.u8(0x03).u16(1).u8(FT.SOURCES).u32(42);
  const results = parseSearchResults(w.toUint8Array());
  eq(results.length, 1, 'one result parsed');
  eq(results[0].name, 'ubuntu.iso', 'result name');
  eq(results[0].size, 4096n, 'result size');
  eq(results[0].sources, 42, 'result sources');
  eq(results[0].hashHex, '0123456789abcdef0123456789abcdef', 'result hash');
}

// --- large-file size via FILESIZE + FILESIZE_HI ---
{
  const hash = hexToBytes('ffffffffffffffffffffffffffffffff');
  const w = new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSEARCHRES);
  w.raw(hash).u32(0).u16(0).u32(2);
  w.u8(0x03).u16(1).u8(FT.FILESIZE).u32(0); // low = 0
  w.u8(0x03).u16(1).u8(FT.FILESIZE_HI).u32(2); // hi = 2 -> 2 * 2^32
  const [res] = parseSearchResults(w.toUint8Array());
  eq(res.size, 2n << 32n, 'large-file size = hi<<32 + lo');
}

// --- bundled UDP results: multiple <E3 99> <entry> frames in one datagram ---
{
  const mkEntry = (w, hashHex, name) => {
    w.raw(hexToBytes(hashHex)).u32(0).u16(0).u32(2);
    w.u8(0x02).u16(1).u8(FT.FILENAME).str(name);
    w.u8(0x03).u16(1).u8(FT.FILESIZE).u32(100);
  };
  const w = new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSEARCHRES);
  mkEntry(w, '11111111111111111111111111111111', 'first.bin');
  w.u8(PROTO.EDONKEY).u8(OP.GLOBSEARCHRES); // sub-packet frame before 2nd result
  mkEntry(w, '22222222222222222222222222222222', 'second.bin');
  const results = parseSearchResults(w.toUint8Array());
  eq(results.length, 2, 'two bundled results parsed');
  eq(results[0].name, 'first.bin', 'first bundled name');
  eq(results[1].name, 'second.bin', 'second bundled name');
  eq(results[1].hashHex, '22222222222222222222222222222222', 'second bundled hash');
}

// --- string-named media tags (eDonkeyHybrid) map into media fields ---
{
  const hash = hexToBytes('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
  const w = new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSEARCHRES);
  w.raw(hash).u32(0).u16(0).u32(2);
  // string tag named "bitrate" (uint32 value)
  w.u8(0x03).str('bitrate').u32(320);
  // string tag named "codec" (string value)
  w.u8(0x02).str('codec').str('mp3');
  const [res] = parseSearchResults(w.toUint8Array());
  eq(res.media.bitrate, 320, 'string-named bitrate tag');
  eq(res.media.codec, 'mp3', 'string-named codec tag');
}

// --- ed2k link building ---
{
  const link = buildEd2kLink({ name: 'my file.iso', size: 4096n, hashHex: 'ABCDEF0123456789ABCDEF0123456789' });
  eq(link, 'ed2k://|file|my%20file.iso|4096|abcdef0123456789abcdef0123456789|/', 'ed2k link');
  const linkAich = buildEd2kLink({ name: 'x', size: 1, hashHex: '00', aich: 'AICHBASE32' });
  ok(linkAich.includes('|h=AICHBASE32|'), 'ed2k link with AICH');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
