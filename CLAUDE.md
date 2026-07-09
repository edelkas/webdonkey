# CLAUDE.md — ed2k Web Search Engine

> Project working notes and shared context. This file is the source of truth for
> **what we are building and why**. Keep it updated as decisions are made.

---

## 1. Project Overview

A **web-based search engine for the ed2k (eDonkey2000) network**. It queries a
predefined set of ed2k servers using the network's **UDP global search** and
**aggregates the results** in the browser, the same way eMule performs a global
search across all known servers in parallel.

### Core principles

- **Client-side only.** The website itself indexes nothing. Every search is
  executed *from the user's machine* each time. The site is meant to be hosted on
  **GitHub Pages** (static hosting, no backend of our own).
- **No dependencies, no frameworks.** Plain **HTML + CSS + JS**. CSS hand-written
  (no Tailwind/Bootstrap). JS vanilla (no React/Vue/build step ideally).
- **Crisp, minimal, power-user UI.** Lightweight, fast, information-dense. No
  decorative fluff.
- **Static server list for now.** A hardcoded base list of servers. Later:
  discover more servers at runtime by asking known servers for their server lists.

---

## 2. ⚠️ Critical Constraint & Transport Decision

### 2.1 Browsers cannot send raw UDP — how we work around it

The spec assumes the client's browser sends UDP global-search packets directly to
ed2k servers. **This is not possible with standard browser APIs.** Browser
JavaScript has **no access to raw UDP (or raw TCP) sockets**. The only network
primitives available to a page are:

- `fetch` / `XMLHttpRequest` — HTTP(S) only.
- `WebSocket` — a TCP-based framed protocol, and only to a WebSocket server.
- `WebRTC` (`RTCDataChannel`) — uses UDP under the hood, but only to a WebRTC
  peer after an ICE/STUN/DTLS handshake. It **cannot** send an arbitrary UDP
  datagram to an arbitrary ed2k server that doesn't speak WebRTC.

So a page served from GitHub Pages cannot open a UDP socket to `server:port`
itself. Something with real socket access must relay for it.

### 2.2 DECISION: relay server now, optional local UDP extension later

Two transports, behind the **same abstract interface** (`sendDatagram(server,
bytes)` + `onDatagram(cb)` — never hardcode which one is in use):

- **① Relay server (primary, build this first).** The user already owns a server
  hosting other tools; it will run a small **UDP-over-WebSocket relay**. The
  browser connects to the relay via **WSS**; the relay forwards datagrams to ed2k
  servers over real UDP and streams responses back. Site stays 100% static on
  GitHub Pages; only the relay is server-side.
- **② Local UDP browser extension (later, optional).** An extension providing
  native UDP (via native messaging) that lets the page send directly from the
  user's own machine. **Not required** — the tool must fully work without it. When
  present it is preferred, because it bypasses the relay and its rate limits. The
  UI should **detect it and show a help note** advertising this option to users
  who want to avoid shared rate limits. Deferred; design the transport interface
  so this drops in cleanly.

> Rejected for now: WebRTC (can't reach ed2k servers), local helper daemon
> (heavier than an extension for the user), desktop wrapper (drops the "website"
> goal).

### 2.3 Relay server constraints (important)

The relay runs on the user's **modest, already-loaded** box. Design accordingly:

- **All ed2k traffic appears to come from the relay's single IP.** Servers will
  see every user's queries as one source → **real risk of rate-limiting / IP
  bans**. Therefore the relay MUST enforce a **global (server-wide) rate limiter**
  on outbound UDP to each ed2k server (and overall), independent of how many
  browser clients are connected. Prefer per-destination-server pacing plus a
  global cap. Better to queue/throttle/slow searches than to get the relay's IP
  banned.
- **Minimal CPU.** Relaying must be lightweight — plain datagram
  forwarding, no heavy per-packet processing. Protocol parsing/dedup stays in the
  **browser**, not the relay. The relay should be a dumb, efficient pipe +
  rate limiter.
- **Bandwidth is limited but probably fine** at small scale; could become a
  problem if the tool gets many users. The relay should **monitor traffic**
  (bandwidth, active connections, per-server request rates) and **throttle / shed
  load** when limits are approached.
- Keep the relay stateless where possible; per-connection state minimal. Consider
  simple backpressure to browser clients when throttling.

> The relay's throttling can make searches slower under load — that's acceptable
> and expected. Surface such delays in the UI log/progress. Heavy users are the
> ones we point at transport ②.

### 2.4 Other open questions

- Exact server list to ship with (see §7).
- Whether to attempt UDP obfuscation (servers may advertise
  `SRV_UDPFLG_UDP_OBFUSCATION`). Deferred; start with plaintext UDP.

---

## 3. Architecture

```
┌──────────────────────────────────────────────┐        ┌────────────────────────┐
│  Static site (HTML/CSS/JS) — GitHub Pages      │        │  Relay (user's server) │
│                                                │        │                        │
│  UI ──► SearchController ──► ProtocolCodec      │        │  WS endpoint (WSS)      │
│              │                    │             │        │      │                 │
│              ▼                    ▼             │  WSS   │      ▼                 │
│       ResultAggregator      Transport iface ───┼───────►│  global rate limiter   │
│       (dedupe by hash)      sendDatagram()      │◄───────┤  + traffic monitor     │
│              │              onDatagram()        │        │      │                 │
│              ▼                    ▲             │        │      ▼  real UDP        │
│        Results table              │             │        │  ed2k servers  ◄──►     │
│                        [transport ②: local UDP  │        └────────────────────────┘
│                         extension, optional]    │
└──────────────────────────────────────────────┘
```

All protocol parsing/dedup happens in the **browser**; the relay is a dumb,
rate-limited UDP pipe (see §2.3).

Suggested module boundaries (files, no build step required):

**Frontend (static site):**
- `protocol.js` — encode/decode ed2k UDP packets (search req variants, status
  req/res, result parsing), tag/meta encoding, ed2k link building.
- `transport.js` — abstract datagram transport (§2.1–2.2). Backends: `relay`
  (UDP-over-WSS, primary) and future `extension` (local native UDP). Detects the
  extension and prefers it when available; else falls back to relay.
- `search.js` — orchestrates a search: pick opcode per server (from cached
  status/flags), fan out, collect, dedupe, expose progress + events.
- `expr.js` — parse the user's boolean search text into a search tree; combine
  with structured form fields (size/type/meta) into the final expression.
- `ui.js` / `app.js` — DOM wiring, tabs, table sorting, context menu, log, and
  the help note advertising the optional extension (§2.2).
- `cache.js` — in-memory + persisted (localStorage) caches.
- `servers.js` — static server list (+ future discovery).

**Relay (separate, server-side — not part of the GitHub Pages deploy):**
- Small WSS ↔ UDP forwarder. Lightweight (minimal CPU), **global rate limiter**
  (per ed2k server + overall cap), **traffic monitor** (bandwidth, active
  connections, per-server rates) with throttle/shed under load. See §2.3.

Keep protocol logic pure and unit-testable (byte in / byte out), independent of
the DOM and the transport.

### Implementation status

- ✅ `src/protocol.js` — constants (headers/opcodes/flags/tags/types), little-endian
  `ByteWriter`/`ByteReader`, search-tree node model + serializer (REQ1/2/3, 32/64-bit),
  status/search request builders, status + result parsers (full ed2k tag decoding,
  large-file sizes), `buildEd2kLink`, `chooseSearchVariant`.
- ✅ `src/expr.js` — eMule boolean-syntax parser (AND/OR/NOT, quotes, parens,
  implicit-AND, precedence NOT>AND>OR) + `buildSearchTree(fields)` combining query
  with structured form fields.
- ✅ `src/transport.js` — abstract `Transport` (`connect`/`sendDatagram`/
  `onDatagram`/`onStatus`/`close`/`ready`); backends: `RelayTransport` (UDP-over-
  WSS, primary; injectable WebSocket for tests), `LoopbackTransport` (in-process
  mock for tests/offline), + `detectExtension()` stub for transport ②. Relay wire
  protocol = binary frames: `DATAGRAM [0x01][ip:4 BE][port:u16 BE][payload]`
  (packed IPv4 so the relay drops it straight into a sockaddr) and
  `CONTROL [0x02][json]` for relay telemetry. **PACKED (0xD4) datagrams
  are inflated to 0xE3 on receive** (`inflateIfPacked`, via `DecompressionStream`)
  so consumers always get plaintext.
- ✅ `src/search.js` — orchestration. `SearchEngine` owns the transport + shared
  per-session flags cache + datagram router (status replies matched by random u32
  challenge; result datagrams routed to searches awaiting that server). `Search`
  (per tab) pings→plans (`planServerRequest`)→fans out→live-merges. Dedupe by
  hash: **sources summed** across servers, per-file **name histogram** (`names`
  Map + derived most-popular `name`), `servers` Set. Per-server lifecycle is a
  `ServerState` enum; emits `progress`/`results`/`log`/`done`; supports `cancel()`.
- ✅ `relay/` — the relay server (Node, **separate deploy**, one dep: `ws`).
  `relay.js` (HTTP+WS server, per-client UDP socket for unambiguous reply
  routing, monitor + periodic stats + load shedding), `pacer.js` (global token
  bucket + per-server pacing + queue/per-client shedding; pure `pump(now)` core),
  `guard.js` (blocks private/reserved IPv4 by default; optional `ip:port`
  allowlist). Speaks the `transport.js` frame protocol; emits `CONTROL` throttle
  frames as backpressure. TLS terminated by the operator's reverse proxy
  (browser→WSS→proxy→`ws://`→relay). Config via env; see `relay/README.md`.
- ✅ `test/protocol.test.mjs` (66) + `test/transport.test.mjs` (25) +
  `test/search.test.mjs` (26) + `relay/test.mjs` (36) — 153 assertions, no
  framework. NOTE: in this WSL box `npm` is the Windows binary and can't run from
  a `\\wsl.localhost` path; run the test files directly with the Linux `node`.
  The relay also needs `npm install ws` in `relay/` before `node relay.js` runs
  (tests don't need it — they exercise pure pacer/guard/frame logic).
- ✅ **Protocol layer fully verified against eMule source** — no remaining VERIFY
  items:
  - `Opcodes.h`: opcodes, FT tags, tag types, file-type strings, `SEARCH_OP`.
  - `Server.h`: `UDPFLG` / `TCPFLG` values.
  - `WriteMetaDataSearchParam` / `WriteBoolean*`: full search-node encoding
    (bool/string/meta/numeric; `type 3`=u32 / `type 8`=u64).
  - `CSearchResultsWnd::OnTimer`: variant selection (`chooseSearchVariant`/
    `planServerRequest`), REQ3 `<tagcount><CT_SERVER_UDPSEARCH_FLAGS newtag>`
    prefix, skip-64-bit-on-non-large rule (`treeUses64Bit`).
  - `CUDPSocket::ProcessPacket` + `ProcessUDPSearchAnswer`: `OP_GLOBSEARCHRES`
    framing (no count prefix; one entry per `E3 99` frame; bundled per datagram),
    and full `OP_GLOBSERVSTATRES` field layout incl. obfuscation ports/udpKey +
    default-port rule (`applyObfuscationPortDefaults`).
- ✅ PACKED (0xD4/zlib) result inflation — implemented in the transport receive
  path (`inflateIfPacked`). REQ2 vs REQ1 bodies are identical (bare tree, only
  opcode differs) — correct per OnTimer.
- ⏳ Next: the **UI** (form, results table, tabs, progress, log — §5);
  `servers.js` static list. After that: end-to-end wiring against a live relay.
- `package.json` sets `"type":"module"`; source uses native ES modules (loaded in
  the browser via `<script type="module">`, no build step).

---

## 4. ed2k Protocol Reference

> ⚠️ **Verify byte-level details against the user's protocol docs and eMule source
> (`opcodes.h`, `SearchList.cpp`, `SearchExpr.cpp`, `Packet.cpp`) before/while
> implementing.** Values below are the working reference; treat exact framing of
> the three search-request variants and the search-expression node encoding as
> "confirm before shipping". All multi-byte integers are **little-endian**.
> Strings are length-prefixed (2-byte length + bytes); modern servers expect
> **UTF-8** (advertise `SRV_UDPFLG_UNICODE`).

### 4.1 Packet framing (UDP)

Every UDP packet starts with a 1-byte **protocol header**, then a 1-byte
**opcode**, then the opcode-specific body. (Unlike TCP, UDP packets do **not**
carry the 4-byte length field.)

| Header | Meaning |
|---|---|
| `0xE3` | `PROTO_EDONKEY` — base eDonkey protocol |
| `0xC5` | `PROTO_EMULE` — eMule extended |
| `0xD4` | `PROTO_PACKED` — zlib-compressed body |

Server UDP port is the server's advertised UDP port (commonly `TCP port + 4`,
e.g. TCP `4661` → UDP `4665`, but always use the server's listed UDP port).

### 4.2 Relevant UDP opcodes

| Opcode | Name | Direction | Purpose |
|---|---|---|---|
| `0x96` | `OP_GLOBSERVSTATREQ` | → server | Status/ping (get user/file count + flags) |
| `0x97` | `OP_GLOBSERVSTATRES` | ← server | Status response (includes **UDP flags**) |
| `0x98` | `OP_GLOBSEARCHREQ`  | → server | Global search (legacy / original) |
| `0x92` | `OP_GLOBSEARCHREQ2` | → server | Global search (extended) |
| `0x90` | `OP_GLOBSEARCHREQ3` | → server | Global search (**64-bit / large-file capable**) |
| `0x99` | `OP_GLOBSEARCHRES`  | ← server | Search results |
| `0x9A` / `0x94` | `OP_GLOBGETSOURCES(2)` | → server | Get sources for a hash (future) |
| `0x9B` | `OP_GLOBFOUNDSOURCES` | ← server | Sources response (future) |
| `0xA2`/`0xA3` | `OP_SERVER_DESC_REQ/RES` | ↔ | Server name/description (future) |

### 4.3 The three global-search request opcodes

All three send the same conceptual **search tree**; they differ in framing.
**Preferred: `OP_GLOBSEARCHREQ3` (0x90)** because it supports **large files
(>4 GiB)** with 64-bit sizes, which is standard today.

**Selection strategy (per server) — VERIFIED against `CSearchResultsWnd::OnTimer`:**
1. Ping each server with `OP_GLOBSERVSTATREQ`; read UDP flags from the response.
2. `LARGEFILES && EXT_GETFILES` → **REQ3 (0x90)**.
3. else `EXT_GETFILES` → **REQ2 (0x92)**.
4. else → **REQ (0x98)**.
5. **Skip** a server entirely if the search tree contains a 64-bit value and the
   server lacks large-file support (eMule does not clamp at send time). The tree
   is built **once** (64-bit where the value needs it); `treeUses64Bit()` reports
   whether the skip rule applies. `planServerRequest(flags, uses64)` implements
   steps 2–5.
6. Cache flags per server for the session.

> **Framing (VERIFIED):**
> - REQ / REQ2: `header(0xE3) + opcode + <search_tree>`.
> - **REQ3:** `header + 0x90 + <u32 tagCount=1> + <new-ed2k-tag> + <search_tree>`,
>   where the single tag is `CT_SERVER_UDPSEARCH_FLAGS (0x0E) =
>   SRVCAP_UDP_NEWTAGS_LARGEFILES (0x01)`. As a *new ed2k tag* (int-type
>   optimized + special single-byte name via the 0x80 type flag) it serializes to
>   bytes `89 0E 01`, so the whole prefix is `01 00 00 00 89 0E 01`.
>
> 64-bitness of numeric values is per-value (§4.5), decided once at build time.

### 4.4 Server status: `OP_GLOBSERVSTATREQ` / `RES` and UDP flags

- **Request** `0x96`: header `0xE3`, opcode `0x96`, then a 4-byte random
  **challenge/key** (echoed back so we can match the response to the request /
  server).
- **Response** `0x97` — **body layout VERIFIED** (`CUDPSocket::ProcessPacket`),
  little-endian, with cumulative size gates ("size" = body = datagram − 2):

  | Off | Field | Type | Present when body ≥ |
  |---|---|---|---|
  | 0  | challenge (echoed) | u32 | 12 |
  | 4  | users | u32 | 12 |
  | 8  | files | u32 | 12 |
  | 12 | maxUsers | u32 | 16 |
  | 16 | softFiles | u32 | 24 |
  | 20 | hardFiles | u32 | 24 |
  | 24 | **udpFlags** | u32 | 28 |
  | 28 | lowIdUsers | u32 | 32 |
  | 32 | udpObfPort | u16 | 40 |
  | 34 | tcpObfPort | u16 | 40 |
  | 36 | udpKey | u32 | 40 |

  Body < 12 → ignore. Caller must check the echoed challenge matches its ping.
  **Default obf ports** (short packets): if the obf flag is set but no port sent,
  TCP obf → server TCP port, UDP obf → TCP port + 12 (`applyObfuscationPortDefaults`).
  ⚠️ Note: `udpFlags` is at **offset 24**, after maxUsers/soft/hard — an earlier
  draft wrongly read it at 20.

**UDP flags (`SRV_UDPFLG_*`) — bitfield, VERIFIED against Server.h:**

| Flag | Value | Meaning |
|---|---|---|
| `EXT_GETSOURCES`   | `0x01` | Extended GetSources |
| `EXT_GETFILES`     | `0x02` | **Gates REQ2/REQ3 (extended global search); without it → REQ1** |
| `NEWTAGS`          | `0x08` | Supports new tag format |
| `UNICODE`          | `0x10` | UTF-8 strings |
| `EXT_GETSOURCES2`  | `0x20` | GetSources v2 |
| `LARGEFILES`       | `0x100`| **>4 GiB files / 64-bit sizes → (with EXT_GETFILES) use REQ3** |
| `UDP_OBFUSCATION`  | `0x200`| UDP obfuscation supported |
| `TCP_OBFUSCATION`  | `0x400`| TCP obfuscation supported |

### 4.5 Search expression ("search tree") encoding

The search bar + form fields compile into **one boolean expression tree** sent to
the server. Each node is a leading type byte + payload. All node encodings below
are **VERIFIED** against `WriteBoolean*` / `WriteMetaDataSearchParam`:

- **Boolean operator node:** `0x00` + 1 op byte — `0x00 = AND`, `0x01 = OR`,
  `0x02 = NOT`. Boolean nodes are **prefix operators** over the following two
  sub-expressions (NOT effectively AND-NOT in eMule usage).
- **Name/keyword term:** `0x01` + 2-byte length + UTF-8 string. Matched against
  the filename.
- **Metadata string term:** `0x02` + (2-byte len + value string) + **tag name**.
  Used for file **type** and **format** (e.g. type = `"Audio"`, format = `"mp3"`).
- **Numeric restriction (VERIFIED, snippets `WriteMetaDataSearchParam`):**
  `<type><value><operator:u8><tagname>` where **`type = 3` → 32-bit value (u32)**
  and **`type = 8` → 64-bit value (u64)**. 64-bit is emitted only when the value
  `> 0xFFFFFFFF` **and** the server supports large files; otherwise the value is
  clamped to `0xFFFFFFFF` and sent 32-bit. Operator is an `ED2K_SEARCH_OP_*` code.

**Tag name encoding** (in meta/numeric nodes): `<u16 len><name>`. For a special
single-byte tag, `len = 1` and name = the FT byte; for a string-named tag,
`WriteString` (u16 len + UTF-8).

**Comparison operators (`ED2K_SEARCH_OP_*`, VERIFIED):**
`EQUAL=0`, `GREATER=1`, `LESS=2`, `GREATER_EQUAL=3`, `LESS_EQUAL=4`,
`NOT_EQUAL=5`. `0,3,4,5` need eserver 16.45+; `1,2` also understood by old
dserver. We map **min → GREATER_EQUAL(3)**, **max → LESS_EQUAL(4)** (fine for the
modern eservers we target via REQ3).

**eMule's search-bar boolean syntax** (to replicate in `expr.js`): supports
`AND`, `OR`, `NOT`, quoted phrases `"..."`, and parentheses for grouping. Parse
that into the tree, then **AND it together** with the structured form fields
(type, size min/max, other meta) to produce the final tree.

### 4.6 Meta tag names (single-byte special tags)

| Tag | Value | Use |
|---|---|---|
| `FT_FILENAME`        | `0x01` | Filename (keyword terms) |
| `FT_FILESIZE`        | `0x02` | Size (low 32 bits) |
| `FT_FILESIZE_HI`     | `0x3A` | Size high 32 bits (large files) |
| `FT_FILETYPE`        | `0x03` | File type string (see §4.7) |
| `FT_FILEFORMAT`      | `0x04` | File format/extension (e.g. "mp3") |
| `FT_SOURCES`         | `0x15` | Availability / source count |
| `FT_COMPLETE_SOURCES`| `0x30` | Complete source count |
| `FT_MEDIA_ARTIST`    | `0xD0` | Media: artist |
| `FT_MEDIA_ALBUM`     | `0xD1` | Media: album |
| `FT_MEDIA_TITLE`     | `0xD2` | Media: title |
| `FT_MEDIA_LENGTH`    | `0xD3` | Media: length (seconds) |
| `FT_MEDIA_BITRATE`   | `0xD4` | Media: bitrate |
| `FT_MEDIA_CODEC`     | `0xD5` | Media: codec |

> Media tags are sometimes carried as string-named tags (e.g. `"length"`,
> `"bitrate"`, `"codec"`). Handle both single-byte and string tag names when
> parsing results.

### 4.7 File type strings (`ED2KFTSTR_*`)

For the file-type dropdown / `FT_FILETYPE` meta term:

`Audio`, `Video`, `Image`, `Doc` (documents), `Pro` (programs), `Arc`
(archives), `Iso` (CD images), `EmuleCollection`.

### 4.8 Parsing `OP_GLOBSEARCHRES` (0x99) — VERIFIED

Datagram structure (from `CUDPSocket::ProcessPacket` + `ProcessUDPSearchAnswer`):

- **No `uint32` count prefix** (this differs from the TCP `OP_SEARCHRESULT`
  handler `ProcessSearchAnswer`, which *does* read a count).
- Each result is **exactly one file entry**. Multiple results are **bundled** in
  one datagram by repeating the `0xE3 0x99` (protocol+opcode) header before each
  subsequent entry. Parser: read one entry, then if the next two bytes are
  `E3 99` consume them and read the next; otherwise stop.

Each **file entry**:

- 16-byte **file hash** (MD4).
- 4-byte client ID + 2-byte port (typically `0` for global results — ignore).
- 4-byte **tag count**, then that many tags.

Relevant tags per result: `FT_FILENAME`, `FT_FILESIZE` (+ `FT_FILESIZE_HI` for
large files), `FT_SOURCES` (availability), `FT_COMPLETE_SOURCES`, `FT_AICH_HASH`
(root hash for the ed2k link `h=` field when present), plus media tags (byte- or
string-named).

⚠️ **Compression:** servers frequently send this **zlib/PACKED** with protocol
header `0xD4` instead of `0xE3`. Such datagrams must be **inflated** to a `0xE3`
datagram before `parseSearchResults` (do it in the transport/search layer, e.g.
`DecompressionStream('deflate')`). Not yet implemented — see roadmap.

A search spans **several `0x99` datagrams** per server; aggregate across them and
correlate to the originating server by source address (note eMule logs the server
UDP port as `nUDPPort - 4`, i.e. TCP port = UDP − 4).

### 4.9 ed2k link format (built client-side)

Basic:
```
ed2k://|file|<filename>|<size-bytes>|<ed2k-hash-hex-uppercase>|/
```
With AICH root hash (if known):
```
ed2k://|file|<filename>|<size>|<ed2k-hash>|h=<AICH-root-base32>|/
```
- `<ed2k-hash>`: 32 hex chars (MD4 of the file's hashset).
- `h=`: AICH root hash, **base32-encoded SHA1**.
- URL-encode the filename (spaces, `|`, etc.).
- Left-click a row → navigate to / trigger this `ed2k://` URI so a registered
  handler (eMule, etc.) starts the download.

---

## 5. Frontend Specification

### 5.1 Search form

- **Search term** text field (supports eMule boolean syntax — §4.5).
- **Min size** / **Max size** (with unit selector: B/KB/MB/GB).
- **File type** dropdown (§4.7 values, + "Any").
- Extra **metadata fields**: file **format/extension**, **min source count**,
  and room to add more (bitrate, length, codec, artist/album/title…).
- Buttons: **Search**, **Cancel** (abort in-flight search), **Reset** (clear all
  fields).

### 5.2 Results table

Columns (power-user oriented):

- File name
- Size (human-readable; raw bytes for sorting)
- **Sources** (availability)
- **Complete sources**
- File **hash**
- **AICH** hash (when available)
- File type / format
- Metadata tags (media length, bitrate, codec, etc. where present)
- (consider) responding-server count / which servers reported it

Behavior:

- **Clickable headers** → sort by that column, toggling **asc/desc**.
- **Live merge:** results tabulate as soon as the first datagrams arrive and keep
  merging as more come in, **deduplicating by file hash** (accumulate max/most
  complete source counts; union of servers reporting).
- **Left-click a row** → trigger the built `ed2k://` link.
- **Right-click a row** → **context menu** (extensible). First action:
  **"Copy ed2k link"** to clipboard. Leave hooks for more actions later.

### 5.3 Progress & log

- **Progress indicator** estimated from how many servers are being queried
  (pinged / searched / responded / timed out).
- **Log panel** below everything: document requests sent, responses received,
  fallbacks, timeouts, errors — a running trace of the search process.

### 5.4 Caching

| What | Where | Lifetime |
|---|---|---|
| Previous **searches** (the queries) | in-memory always; **localStorage** if available | persist across sessions so they can be relaunched |
| **Search results** | in-memory only | short-lived; **not** persisted (avoid re-running on misclicks / accidental repeats) |
| Per-server **status/UDP flags** | in-memory | per session |

Use `localStorage` (not literal cookies) for persisted query history; degrade
gracefully when unavailable/disabled.

### 5.5 Tabbed searches

Multiple searches open at once as **tabs**; user can switch back to earlier ones.
Each tab owns its own query, results set, progress, and log.

---

## 6. Search flow (per search)

1. Build the search tree from form + boolean bar (`expr.js`).
2. For each server: ensure we know its UDP flags (ping via `OP_GLOBSERVSTATREQ`
   if not cached); choose the search opcode (§4.3).
3. Serialize the tree for the chosen opcode; send via `transport.sendDatagram`.
4. As `0x99` datagrams arrive: parse, dedupe by hash, merge into the tab's result
   set, update table + progress + log.
5. Finish when all servers responded or timed out; user can **Cancel** anytime.

---

## 7. Server list

- **Now:** a small static, hardcoded list in `servers.js` (host, TCP port, UDP
  port). Host must be an **IPv4 literal** (the relay frame packs it as 4 bytes;
  §3) — resolve any hostname servers to IPs in the list. *(Populate with a
  known-good current list — TBD with user.)*
- **Later:** runtime discovery by requesting server lists from known servers
  (`OP_SERVER_LIST` / server-description exchange), merging into the working set.

---

## 8. Roadmap / future ideas

- **Optional local-UDP browser extension** as transport ② (§2.2) — bypasses the
  relay and its rate limits; UI detects it and advertises it via a help note.
- Runtime server discovery (§7).
- GetSources for a selected file (`OP_GLOBGETSOURCES`).
- UDP obfuscation support.
- Richer context-menu actions.
- Per-server health/stats display.
- Relay hardening at scale (auth/abuse controls if usage grows).

---

## 9. Conventions & reminders for future work

- Keep **protocol code pure** and DOM/transport-agnostic; unit-test byte encoding.
- **Abstract the transport** — never assume a specific UDP-bridge mechanism.
- All ed2k integers **little-endian**; strings **UTF-8, length-prefixed**.
- Prefer **`OP_GLOBSEARCHREQ3`**; fall back per-server by advertised flags.
- Dedupe results **by file hash**.
- No frameworks, no build step unless we deliberately decide otherwise.
- **When protocol byte details matter, cross-check the user's docs / eMule source
  rather than guessing.**
