// protocol.js — ed2k (eDonkey2000) UDP protocol codec.
//
// PURE MODULE: no DOM, no network, no transport assumptions. Everything here is
// "bytes in / bytes out" so it can be unit-tested in isolation and reused
// regardless of how packets actually leave the machine (relay vs. extension).
//
// Conventions (see CLAUDE.md §4):
//   - All multi-byte integers are LITTLE-ENDIAN.
//   - Strings are UTF-8, length-prefixed with a uint16 unless noted.
//   - Sizes may exceed 2^32 (large files); those paths use BigInt.
//
// ⚠️ VERIFY-AGAINST-DOCS markers below flag the few byte layouts that must be
//    checked against the user's protocol docs / eMule source (opcodes.h,
//    SearchList.cpp, SearchExpr.cpp) before we trust them on the wire. They are
//    deliberately isolated so a correction is a one-spot change.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol header (first byte of every packet). */
export const PROTO = {
  EDONKEY: 0xe3, // base eDonkey protocol
  EMULE: 0xc5, // eMule extended
  PACKED: 0xd4, // zlib-compressed body
};

// UDP opcodes relevant to global search (see CLAUDE.md §4.2). All verified
// against eMule Opcodes.h (client <-> UDP server section). The comment after
// each value is the payload layout from that file.
export const OP = {
  GLOBSEARCHREQ3: 0x90, // <1 tag set><search_tree> — 64-bit / large-file capable
  GLOBSEARCHREQ2: 0x92, // <search_tree>
  GLOBGETSOURCES2: 0x94, // <HASH 16><FILESIZE 4>
  GLOBSERVSTATREQ: 0x96, // (null) — status/ping
  GLOBSERVSTATRES: 0x97, // <USER 4><FILES 4> (+ extended fields)
  GLOBSEARCHREQ: 0x98, // <search_tree> — legacy / original
  GLOBSEARCHRES: 0x99, // <- server: search results
  GLOBGETSOURCES: 0x9a, // <HASH 16>
  GLOBFOUNDSOURCES: 0x9b, // <- server: sources response (future)
  GLOBCALLBACKREQ: 0x9c, // <IP 4><PORT 2><client_ID 4>
  INVALID_LOWID: 0x9e, // <ID 4>
  SERVER_LIST_REQ: 0xa0, // <IP 4><PORT 2> — server discovery (future)
  SERVER_LIST_RES: 0xa1, // <count 1>(<ip 4><port 2>)[count]
  SERVER_DESC_REQ: 0xa2, // (null)
  SERVER_DESC_RES: 0xa3, // <name_len 2><name><desc_len 2><desc>
  SERVER_LIST_REQ2: 0xa4, // (null)
};

/**
 * Which global-search request variant a server supports, from newest to oldest.
 * Selection strategy: prefer REQ3 when the server advertises LARGEFILES; else
 * fall back to the newest the server supports.
 */
export const SEARCH_VARIANT = {
  REQ3: 3, // OP.GLOBSEARCHREQ3 (0x90) — 64-bit sizes, large files
  REQ2: 2, // OP.GLOBSEARCHREQ2 (0x92)
  REQ1: 1, // OP.GLOBSEARCHREQ  (0x98)
};

const VARIANT_OPCODE = {
  [SEARCH_VARIANT.REQ3]: OP.GLOBSEARCHREQ3,
  [SEARCH_VARIANT.REQ2]: OP.GLOBSEARCHREQ2,
  [SEARCH_VARIANT.REQ1]: OP.GLOBSEARCHREQ,
};

// Server UDP flags (SRV_UDPFLG_*), a bitfield carried in the status response
// (see CLAUDE.md §4.4). VERIFIED against eMule Server.h.
export const UDPFLG = {
  EXT_GETSOURCES: 0x01,
  EXT_GETFILES: 0x02,
  NEWTAGS: 0x08,
  UNICODE: 0x10,
  EXT_GETSOURCES2: 0x20,
  LARGEFILES: 0x100, // >4 GiB files / 64-bit sizes -> use REQ3
  UDP_OBFUSCATION: 0x200,
  TCP_OBFUSCATION: 0x400,
};

// Server TCP flags (SRV_TCPFLG_*), VERIFIED against Server.h. Received at TCP
// login, not used for UDP global search — kept for reference / future TCP work.
export const TCPFLG = {
  COMPRESSION: 0x01,
  NEWTAGS: 0x08,
  UNICODE: 0x10,
  RELATEDSEARCH: 0x40,
  TYPETAGINTEGER: 0x80, // server represents FT_FILETYPE as an integer tag (TCP)
  LARGEFILES: 0x100,
  TCPOBFUSCATION: 0x400,
};

// Server capability flags for CT_SERVER_FLAGS (sent client->server at login).
// Verified against Opcodes.h. Not used for UDP search yet, kept for reference /
// future TCP work; note the parallel LARGEFILES/crypt bits with UDPFLG above.
export const SRVCAP = {
  ZLIB: 0x0001,
  IP_IN_LOGIN: 0x0002,
  AUXPORT: 0x0004,
  NEWTAGS: 0x0008,
  UNICODE: 0x0010,
  LARGEFILES: 0x0100,
  SUPPORTCRYPT: 0x0200,
  REQUESTCRYPT: 0x0400,
  REQUIRECRYPT: 0x0800,
};

// Client tag names (CT_*), verified against Opcodes.h. Used in the REQ3 prefix.
export const CT = {
  SERVER_UDPSEARCH_FLAGS: 0x0e,
};

// Values for CT_SERVER_UDPSEARCH_FLAGS, verified against Opcodes.h.
export const SRVCAP_UDP = {
  NEWTAGS_LARGEFILES: 0x01,
};

// Special single-byte meta tag names (FT_*), all verified against Opcodes.h
// (file tags section). See CLAUDE.md §4.6.
export const FT = {
  FILENAME: 0x01, // <string>
  FILESIZE: 0x02, // <uint32> (or <uint64> when supported)
  FILETYPE: 0x03, // <string>
  FILEFORMAT: 0x04, // <string>
  LASTSEENCOMPLETE: 0x05, // <uint32>
  SOURCES: 0x15, // <uint32> availability / source count
  AICH_HASH: 0x27, // AICH root hash (for ed2k link h= field)
  FILEHASH: 0x28,
  COMPLETE_SOURCES: 0x30, // <uint32> eserver 16.46+
  FILESIZE_HI: 0x3a, // <uint32> high 32 bits of a large-file size
  MEDIA_ARTIST: 0xd0, // <string>
  MEDIA_ALBUM: 0xd1, // <string>
  MEDIA_TITLE: 0xd2, // <string>
  MEDIA_LENGTH: 0xd3, // <uint32>
  MEDIA_BITRATE: 0xd4, // <uint32>
  MEDIA_CODEC: 0xd5, // <string>
  FILERATING: 0xf7, // <uint8>
  FILECOMMENT: 0xf6, // <string>
};

// String-named media tags from eDonkeyHybrid (case-sensitive) — some peers/
// servers use these instead of the 0xD0–0xD5 byte tags. Verified against
// Opcodes.h (FT_ED2K_MEDIA_*). Note "length" is a <string> here, not uint32.
export const MEDIA_STR = {
  Artist: 'artist',
  Album: 'album',
  Title: 'title',
  length: 'length',
  bitrate: 'bitrate',
  codec: 'codec',
};

// File-type strings for FT.FILETYPE (ED2KFTSTR_*), verified against Opcodes.h.
// See CLAUDE.md §4.7. NOTE: Opcodes.h marks ARCHIVE ("Arc") and CDIMAGE ("Iso")
// as "eMule internal use only" — servers may not accept them as FT_FILETYPE
// search values (they get mapped to Pro/other on the wire). Confirm before
// exposing Arc/Iso as first-class dropdown options.
export const FILETYPE = {
  AUDIO: 'Audio',
  VIDEO: 'Video',
  IMAGE: 'Image',
  DOCUMENT: 'Doc',
  PROGRAM: 'Pro',
  ARCHIVE: 'Arc', // internal
  CDIMAGE: 'Iso', // internal
  COLLECTION: 'EmuleCollection',
};

// ed2k tag value types (TAGTYPE_*), verified against Opcodes.h. Used when
// parsing result file entries.
const TAGTYPE = {
  HASH16: 0x01, // TAGTYPE_HASH
  STRING: 0x02,
  UINT32: 0x03,
  FLOAT32: 0x04,
  BOOL: 0x05,
  BOOLARRAY: 0x06,
  BLOB: 0x07,
  UINT16: 0x08,
  UINT8: 0x09,
  BSOB: 0x0a,
  UINT64: 0x0b,
  // Inline strings: type in 0x11..0x20 => length (type - 0x10) = 1..16.
  // eMule additionally *accepts* 0x21..0x26 (STR17..STR22) on receive due to an
  // old flaw, so we tolerate up to 0x26 when parsing to be safe.
  STR_FIRST: 0x11,
  STR_LAST_STRICT: 0x20,
  STR_LAST_LENIENT: 0x26,
};

// Search-expression element type bytes, all VERIFIED against eMule
// SearchResultsWnd.cpp (WriteBoolean* / WriteMetaDataSearchParam):
//   0x00 <op>              boolean (op: 0x00 AND, 0x01 OR, 0x02 NOT), prefix form
//   0x01 <string>          filename keyword term
//   0x02 <string> <tag>    string meta (file type/format) + tag name
//   0x03 <u32> <op> <tag>  numeric param, 32-bit value
//   0x08 <u64> <op> <tag>  numeric param, 64-bit value
// (Strings via WriteString = uint16 length + bytes; UTF-8 for unicode servers.)
const EXPR = {
  BOOL: 0x00, // <op:u8> then two sub-expressions (NOT: one)
  STRING: 0x01, // filename keyword: <string>
  META: 0x02, // string meta (type/format): <string value><tagname>
  NUM32: 0x03, // numeric param, 32-bit value
  NUM64: 0x08, // numeric param, 64-bit value
  BOOL_AND: 0x00,
  BOOL_OR: 0x01,
  BOOL_NOT: 0x02,
};

// ed2k search-expression comparison operators (ED2K_SEARCH_OP_*), verified
// against Opcodes.h. EQUAL/GE/LE/NOTEQUAL need eserver 16.45+; GREATER/LESS are
// understood by older dserver too.
export const SEARCH_OP = {
  EQUAL: 0,
  GREATER: 1,
  LESS: 2,
  GREATER_EQUAL: 3,
  LESS_EQUAL: 4,
  NOT_EQUAL: 5,
};

// Map node operators to wire operator codes. 'min'/'max' are convenience aliases
// for the typical size/sources bounds. We use GREATER_EQUAL / LESS_EQUAL for
// them (semantically "at least" / "at most"); every large-file-capable server
// we target as REQ3 is a modern eserver that supports these.
const OP_TO_SEARCHOP = {
  eq: SEARCH_OP.EQUAL,
  gt: SEARCH_OP.GREATER,
  lt: SEARCH_OP.LESS,
  gte: SEARCH_OP.GREATER_EQUAL,
  lte: SEARCH_OP.LESS_EQUAL,
  neq: SEARCH_OP.NOT_EQUAL,
  min: SEARCH_OP.GREATER_EQUAL,
  max: SEARCH_OP.LESS_EQUAL,
};

// ---------------------------------------------------------------------------
// Byte writer / reader (little-endian)
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

export class ByteWriter {
  constructor() {
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v) {
    let n = BigInt(v);
    for (let i = 0; i < 8; i++) {
      this.bytes.push(Number(n & 0xffn));
      n >>= 8n;
    }
    return this;
  }
  /** uint16 length-prefixed UTF-8 string. */
  str(s) {
    const enc = utf8Encoder.encode(s ?? '');
    this.u16(enc.length);
    for (const b of enc) this.bytes.push(b);
    return this;
  }
  raw(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
    return this;
  }
  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

export class ByteReader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.bytes = bytes;
    this.pos = 0;
  }
  get remaining() {
    return this.bytes.byteLength - this.pos;
  }
  u8() {
    return this.view.getUint8(this.pos++);
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64() {
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  f32() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytesN(n) {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** uint16 length-prefixed UTF-8 string. */
  str() {
    const len = this.u16();
    return utf8Decoder.decode(this.bytesN(len));
  }
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/** Uint8Array(16) MD4 hash -> lowercase hex string (32 chars). */
export function hashToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Hex string -> Uint8Array. */
export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Search tree — normalized node model (shared with expr.js)
// ---------------------------------------------------------------------------
//
// Node shapes:
//   { t:'bool', op:'and'|'or'|'not', nodes:[child,...] }  n-ary; folded to binary
//   { t:'str',  value:'keyword' }                          filename keyword term
//   { t:'meta', value:'Audio', tag:FT.FILETYPE }           metadata string match
//   { t:'num',  op:'min'|'max', tag:FT.FILESIZE, value:n } numeric restriction

export const node = {
  and: (...nodes) => ({ t: 'bool', op: 'and', nodes: nodes.filter(Boolean) }),
  or: (...nodes) => ({ t: 'bool', op: 'or', nodes: nodes.filter(Boolean) }),
  not: (n) => ({ t: 'bool', op: 'not', nodes: [n] }),
  str: (value) => ({ t: 'str', value }),
  meta: (value, tag) => ({ t: 'meta', value, tag }),
  // numeric restriction; op is one of 'eq','gt','lt','gte','lte','neq','min','max'
  num: (tag, op, value) => ({ t: 'num', op, tag, value }),
  min: (tag, value) => ({ t: 'num', op: 'min', tag, value }),
  max: (tag, value) => ({ t: 'num', op: 'max', tag, value }),
};

/**
 * Fold an n-ary boolean node into right-leaning binary prefix form, since the
 * ed2k search expression only has binary boolean operators. Leaf/other nodes are
 * returned unchanged. AND([a,b,c]) => and(a, and(b, c)).
 */
function toBinary(n) {
  if (!n) return null;
  if (n.t !== 'bool') return n;
  if (n.op === 'not') return { t: 'bool', op: 'not', nodes: [toBinary(n.nodes[0])] };
  const kids = n.nodes.map(toBinary).filter(Boolean);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  let acc = kids[kids.length - 1];
  for (let i = kids.length - 2; i >= 0; i--) {
    acc = { t: 'bool', op: n.op, nodes: [kids[i], acc] };
  }
  return acc;
}

/** Write a meta tag name: uint16 length + name. Special tags => length 1 + id. */
function writeTagName(w, tag) {
  if (typeof tag === 'number') {
    w.u16(1).u8(tag);
  } else {
    w.str(tag); // string-named tag
  }
}

const U32_MAX = 0xffffffffn;

/**
 * Serialize a numeric restriction. Layout verified against eMule's
 * WriteMetaDataSearchParam (snippets_for_1.cpp):
 *   <type:u8=3|8> <value:u32|u64> <operator:u8> <tagname>
 * A 64-bit value is only emitted when the value exceeds 32 bits AND the server
 * supports it; otherwise the value is clamped to 0xFFFFFFFF and sent as 32-bit.
 */
function serializeNum(w, n, supports64) {
  const value = BigInt(n.value);
  const op = OP_TO_SEARCHOP[n.op];
  if (op === undefined) throw new Error(`unknown numeric operator: ${n.op}`);
  if (value > U32_MAX && supports64) {
    w.u8(EXPR.NUM64).u64(value);
  } else {
    w.u8(EXPR.NUM32).u32(Number(value > U32_MAX ? U32_MAX : value));
  }
  w.u8(op);
  writeTagName(w, n.tag);
}

/**
 * Serialize a single (binary-folded) node into the writer.
 * @param {boolean} supports64  Server supports 64-bit values (REQ3 / large files).
 */
function serializeNode(w, n, supports64) {
  switch (n.t) {
    case 'bool': {
      const opByte =
        n.op === 'and' ? EXPR.BOOL_AND : n.op === 'or' ? EXPR.BOOL_OR : EXPR.BOOL_NOT;
      w.u8(EXPR.BOOL).u8(opByte);
      if (n.op === 'not') {
        serializeNode(w, n.nodes[0], supports64);
      } else {
        serializeNode(w, n.nodes[0], supports64);
        serializeNode(w, n.nodes[1], supports64);
      }
      break;
    }
    case 'str':
      w.u8(EXPR.STRING).str(n.value);
      break;
    case 'meta':
      // 0x02 <value-str> <tagname>
      w.u8(EXPR.META).str(n.value);
      writeTagName(w, n.tag);
      break;
    case 'num':
      serializeNum(w, n, supports64);
      break;
    default:
      throw new Error(`unknown search node type: ${n.t}`);
  }
}

/**
 * Serialize a search tree to its wire bytes (the "search expression").
 * @param {object} tree
 * @param {boolean} [opts.supports64]  emit 64-bit numeric values when needed
 * @returns {Uint8Array}
 */
export function serializeSearchTree(tree, { supports64 = false } = {}) {
  const bin = toBinary(tree);
  if (!bin) throw new Error('empty search tree');
  const w = new ByteWriter();
  serializeNode(w, bin, supports64);
  return w.toUint8Array();
}

// ---------------------------------------------------------------------------
// Packet builders
// ---------------------------------------------------------------------------

/**
 * Build a status/ping request (OP_GLOBSERVSTATREQ). The 32-bit challenge is
 * echoed by the server so responses can be correlated to the request/server.
 * @param {number} challenge  random uint32
 */
export function buildStatusRequest(challenge) {
  return new ByteWriter().u8(PROTO.EDONKEY).u8(OP.GLOBSERVSTATREQ).u32(challenge >>> 0).toUint8Array();
}

/**
 * Build a global search request for a chosen variant.
 * @param {object}  opts
 * @param {number}  opts.variant  one of SEARCH_VARIANT.*
 * @param {object}  opts.tree     search tree (node model)
 *
 * Framing verified against eMule CSearchResultsWnd::OnTimer:
 *   - REQ/REQ2: header + opcode + <search_tree>.
 *   - REQ3:     header + opcode + <u32 tagCount=1> + <new-ed2k-tag
 *               CT_SERVER_UDPSEARCH_FLAGS = SRVCAP_UDP_NEWTAGS_LARGEFILES> +
 *               <search_tree>.
 */
export function buildSearchRequest({ variant, tree }) {
  const opcode = VARIANT_OPCODE[variant];
  if (!opcode) throw new Error(`unknown search variant: ${variant}`);
  const supports64 = variant === SEARCH_VARIANT.REQ3;
  const treeBytes = serializeSearchTree(tree, { supports64 });
  const w = new ByteWriter().u8(PROTO.EDONKEY).u8(opcode);
  if (variant === SEARCH_VARIANT.REQ3) {
    w.u32(1); // tag count
    writeNewEd2kIntTag(w, CT.SERVER_UDPSEARCH_FLAGS, SRVCAP_UDP.NEWTAGS_LARGEFILES);
  }
  return w.raw(treeBytes).toUint8Array();
}

/**
 * Write an integer as a "new ed2k tag" with a special single-byte name, matching
 * CTag::WriteNewEd2kTag: the smallest int type is chosen and the tag name is a
 * single byte flagged by setting the high bit (0x80) of the type byte.
 */
function writeNewEd2kIntTag(w, name, value) {
  let type;
  if (value <= 0xff) type = TAGTYPE.UINT8;
  else if (value <= 0xffff) type = TAGTYPE.UINT16;
  else type = TAGTYPE.UINT32;
  w.u8(type | 0x80).u8(name);
  if (type === TAGTYPE.UINT8) w.u8(value);
  else if (type === TAGTYPE.UINT16) w.u16(value);
  else w.u32(value);
}

/**
 * Choose the global-search variant for a server from its UDP flags. Verified
 * against eMule CSearchResultsWnd::OnTimer:
 *   REQ3 <- LARGEFILES && EXT_GETFILES; REQ2 <- EXT_GETFILES; else REQ1.
 * @param {number} flags  server UDP flags (0 if unknown)
 */
export function chooseSearchVariant(flags) {
  const large = (flags & UDPFLG.LARGEFILES) !== 0;
  const extGetFiles = (flags & UDPFLG.EXT_GETFILES) !== 0;
  if (large && extGetFiles) return SEARCH_VARIANT.REQ3;
  if (extGetFiles) return SEARCH_VARIANT.REQ2;
  return SEARCH_VARIANT.REQ1;
}

/** True if any numeric node in the tree needs a 64-bit value (> 0xFFFFFFFF). */
export function treeUses64Bit(tree) {
  if (!tree) return false;
  if (tree.t === 'num') return BigInt(tree.value) > U32_MAX;
  if (tree.t === 'bool') return tree.nodes.some(treeUses64Bit);
  return false;
}

/**
 * Decide how to query a server: which variant, or skip. Mirrors eMule's rule
 * that a 64-bit search is not sent to servers without large-file support (rather
 * than clamping the query). Build the tree once (supports64) and pass the same
 * `uses64` for every server.
 * @param {number}  flags  server UDP flags
 * @param {boolean} [uses64]  whether the search tree contains a 64-bit value
 * @returns {{variant:number}|{skip:true, reason:string}}
 */
export function planServerRequest(flags, uses64 = false) {
  const large = (flags & UDPFLG.LARGEFILES) !== 0;
  if (uses64 && !large) return { skip: true, reason: 'no large file support' };
  return { variant: chooseSearchVariant(flags) };
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse a status response (OP_GLOBSERVSTATRES). Field layout and cumulative size
 * gates VERIFIED against eMule CUDPSocket::ProcessPacket. "size" below is the
 * body length (datagram minus the 2-byte header+opcode). Offsets are into body:
 *   [0] challenge u32  [4] users u32  [8] files u32   (require size >= 12)
 *   [12] maxUsers u32                                 (size >= 16)
 *   [16] softFiles u32 [20] hardFiles u32             (size >= 24)
 *   [24] udpFlags u32                                 (size >= 28)
 *   [28] lowIdUsers u32                               (size >= 32)
 *   [32] udpObfPort u16 [34] tcpObfPort u16 [36] udpKey u32   (size >= 40)
 * The caller must verify `challenge` matches the ping it sent. Returns null if
 * the body is too short (< 12), which eMule ignores.
 * @returns {null|{challenge:number, users:number, files:number, maxUsers:number,
 *   softFiles:number, hardFiles:number, flags:number, lowIdUsers:number,
 *   udpObfuscationPort:number, tcpObfuscationPort:number, udpKey:number}}
 */
export function parseStatusResponse(bytes) {
  const bodyLen = bytes.byteLength - 2;
  if (bodyLen < 12) return null;
  const r = new ByteReader(bytes);
  r.u8(); // protocol header (0xE3)
  r.u8(); // opcode (0x97)
  const out = {
    challenge: r.u32(),
    users: r.u32(),
    files: r.u32(),
    maxUsers: 0,
    softFiles: 0,
    hardFiles: 0,
    flags: 0,
    lowIdUsers: 0,
    udpObfuscationPort: 0,
    tcpObfuscationPort: 0,
    udpKey: 0,
  };
  // Cumulative gates: each threshold implies all earlier fields are present, so
  // sequential reads stay aligned with eMule's absolute PeekUInt offsets.
  if (bodyLen >= 16) out.maxUsers = r.u32();
  if (bodyLen >= 24) {
    out.softFiles = r.u32();
    out.hardFiles = r.u32();
  }
  if (bodyLen >= 28) out.flags = r.u32();
  if (bodyLen >= 32) out.lowIdUsers = r.u32();
  if (bodyLen >= 40) {
    out.udpObfuscationPort = r.u16();
    out.tcpObfuscationPort = r.u16();
    out.udpKey = r.u32();
  }
  return out;
}

/**
 * Apply eMule's default-port rules for obfuscation ports omitted from a short
 * status response (from ProcessPacket): if the flag is set but no port was sent,
 * TCP obfuscation defaults to the server's TCP port and UDP obfuscation to TCP
 * port + 12. Only relevant once we support obfuscation. Mutates and returns.
 * @param {object} status  from parseStatusResponse
 * @param {number} serverTcpPort  the server's listed TCP port
 */
export function applyObfuscationPortDefaults(status, serverTcpPort) {
  if (!status.tcpObfuscationPort && status.flags & UDPFLG.TCP_OBFUSCATION) {
    status.tcpObfuscationPort = serverTcpPort;
  }
  if (!status.udpObfuscationPort && status.flags & UDPFLG.UDP_OBFUSCATION) {
    status.udpObfuscationPort = serverTcpPort + 12;
  }
  return status;
}

/** Read one ed2k tag (type + name + value). Returns {name, value}. */
function readTag(r) {
  let type = r.u8();
  let name;
  if (type & 0x80) {
    type &= 0x7f;
    name = r.u8(); // special single-byte tag name (new-tags format)
  } else {
    const nameLen = r.u16();
    name = nameLen === 1 ? r.u8() : utf8Decoder.decode(r.bytesN(nameLen));
  }
  let value;
  if (type >= TAGTYPE.STR_FIRST && type <= TAGTYPE.STR_LAST_LENIENT) {
    value = utf8Decoder.decode(r.bytesN(type - 0x10));
  } else {
    switch (type) {
      case TAGTYPE.HASH16:
        value = r.bytesN(16);
        break;
      case TAGTYPE.STRING:
        value = r.str();
        break;
      case TAGTYPE.UINT8:
      case TAGTYPE.BOOL:
        value = r.u8();
        break;
      case TAGTYPE.UINT16:
        value = r.u16();
        break;
      case TAGTYPE.UINT32:
        value = r.u32();
        break;
      case TAGTYPE.UINT64:
        value = r.u64();
        break;
      case TAGTYPE.FLOAT32:
        value = r.f32();
        break;
      case TAGTYPE.BLOB:
      case TAGTYPE.BSOB: {
        const len = r.u32();
        value = r.bytesN(len);
        break;
      }
      default:
        throw new Error(`unsupported tag type 0x${type.toString(16)}`);
    }
  }
  return { name, value };
}

/**
 * Parse a UDP global search response datagram (OP_GLOBSEARCHRES) into result
 * objects. Structure VERIFIED against eMule CUDPSocket::ProcessPacket +
 * CSearchList::ProcessUDPSearchAnswer:
 *   - NO uint32 count prefix (unlike the TCP OP_SEARCHRESULT path).
 *   - Each result is exactly one file entry.
 *   - Multiple results are bundled by repeating the <0xE3 0x99> protocol+opcode
 *     header before each subsequent entry; we consume it and read the next.
 * A single search may still span several datagrams; the caller aggregates and
 * dedupes by hash.
 *
 * NOTE: servers frequently send this compressed (protocol header 0xD4, PACKED /
 * zlib). Such datagrams MUST be inflated to a 0xE3 datagram before calling this
 * (do it in the transport/search layer, e.g. via DecompressionStream('deflate')).
 *
 * @returns {Array<object>} results with {hashHex, name, size, sources,
 *   completeSources, type, format, aich?, media:{...}, tags:{}}
 */
export function parseSearchResults(bytes) {
  const r = new ByteReader(bytes);
  r.u8(); // protocol header (0xE3)
  r.u8(); // opcode (0x99)
  const results = [];
  const MIN_ENTRY = 16 + 4 + 2 + 4; // hash + client ID + port + tag count
  while (r.remaining >= MIN_ENTRY) {
    try {
      results.push(readFileEntry(r));
    } catch {
      break; // malformed / partial trailing bytes
    }
    // Bundled results repeat <0xE3 0x99> before the next entry; consume and
    // continue. Anything else means the datagram is done.
    if (r.remaining >= 2 && r.bytes[r.pos] === PROTO.EDONKEY && r.bytes[r.pos + 1] === OP.GLOBSEARCHRES) {
      r.pos += 2;
    } else {
      break;
    }
  }
  return results;
}

function readFileEntry(r) {
  const hash = r.bytesN(16);
  r.u32(); // client ID (ignored for global results)
  r.u16(); // port (ignored)
  const tagCount = r.u32();
  const res = {
    hashHex: hashToHex(hash),
    name: '',
    size: 0n,
    sources: 0,
    completeSources: 0,
    type: '',
    format: '',
    media: {},
    tags: {},
  };
  let sizeLo = null;
  let sizeHi = 0n;
  for (let i = 0; i < tagCount; i++) {
    const { name, value } = readTag(r);
    res.tags[name] = value;
    // String-named media tags (eDonkeyHybrid) map to the same media fields.
    if (typeof name === 'string' && MEDIA_STR[name]) {
      res.media[MEDIA_STR[name]] = value;
      continue;
    }
    switch (name) {
      case FT.FILENAME:
        res.name = value;
        break;
      case FT.FILESIZE:
        sizeLo = typeof value === 'bigint' ? value : BigInt(value);
        break;
      case FT.FILESIZE_HI:
        sizeHi = BigInt(value);
        break;
      case FT.SOURCES:
        res.sources = Number(value);
        break;
      case FT.COMPLETE_SOURCES:
        res.completeSources = Number(value);
        break;
      case FT.FILETYPE:
        res.type = value;
        break;
      case FT.FILEFORMAT:
        res.format = value;
        break;
      case FT.AICH_HASH:
        // AICH root hash for the ed2k link h= field. May arrive as a base32
        // string or raw bytes depending on server; keep raw for later handling.
        res.aich = value;
        break;
      case FT.FILERATING:
        res.rating = Number(value);
        break;
      case FT.MEDIA_ARTIST:
        res.media.artist = value;
        break;
      case FT.MEDIA_ALBUM:
        res.media.album = value;
        break;
      case FT.MEDIA_TITLE:
        res.media.title = value;
        break;
      case FT.MEDIA_LENGTH:
        res.media.length = Number(value);
        break;
      case FT.MEDIA_BITRATE:
        res.media.bitrate = Number(value);
        break;
      case FT.MEDIA_CODEC:
        res.media.codec = value;
        break;
    }
  }
  if (sizeLo !== null) res.size = sizeLo + (sizeHi << 32n);
  return res;
}

// ---------------------------------------------------------------------------
// ed2k link building
// ---------------------------------------------------------------------------

/**
 * Build an ed2k:// file link from a result (see CLAUDE.md §4.9).
 *   ed2k://|file|<name>|<size>|<hash-hex>|[h=<aich-base32>|]/
 * @param {{name:string, size:(number|bigint), hashHex:string, aich?:string}} f
 */
export function buildEd2kLink({ name, size, hashHex, aich }) {
  const enc = encodeURIComponent(name).replace(/\|/g, '%7C');
  let link = `ed2k://|file|${enc}|${size.toString()}|${hashHex.toLowerCase()}|`;
  if (aich) link += `h=${aich}|`;
  return link + '/';
}
