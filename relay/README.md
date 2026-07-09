# ed2k relay

A small **UDP-over-WebSocket relay** for the ed2k web search engine. The static
site (GitHub Pages) can't open UDP sockets, so this relay forwards the browser's
datagrams to ed2k servers over real UDP and streams the replies back. It is a
**dumb, rate-limited pipe** — it does not parse the ed2k protocol (all
parsing/dedup/decompression happens in the browser). See `../CLAUDE.md` §2.2–2.3.

## What it does

- One WebSocket endpoint; each connected browser gets its **own UDP socket**, so
  server replies route back to exactly the right client.
- A **global rate limiter** (across all clients): a token bucket caps overall
  packets/sec, and per-destination pacing spaces out packets to each ed2k server
  — so the relay's single IP does not get throttled or banned.
- **Destination safety**: private/loopback/reserved IPv4 ranges are blocked by
  default (so the relay can't be abused to probe internal hosts); an optional
  allowlist pins it to specific servers.
- **Traffic monitoring + load shedding**: logs throughput periodically; sheds
  datagrams (with a `throttle` control message to the client) when the queue or a
  client's backlog fills, and refuses connections past `maxClients`.

## Run

```sh
cd relay
npm install      # installs ws (its only dependency)
npm start        # or: node relay.js
```

Listens on `ws://127.0.0.1:8765` by default. Health check: `GET /healthz`.

## TLS / deployment

The relay speaks **plain `ws://`** and is meant to sit behind the reverse proxy
you already run, which terminates TLS:

```
browser ──WSS──► reverse proxy (TLS) ──ws://127.0.0.1:8765──► relay ──UDP──► ed2k servers
```

Point the site's relay URL at `wss://your.host/path`. Example nginx location:

```nginx
location /ed2k-relay/ {
    proxy_pass http://127.0.0.1:8765/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

(Caddy: `reverse_proxy 127.0.0.1:8765` handles WebSocket upgrades automatically.)

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | bind address (keep on localhost behind a proxy) |
| `RELAY_PORT` | `8765` | listen port |
| `RELAY_MAX_CLIENTS` | `50` | refuse WS connections past this |
| `RELAY_GLOBAL_PPS` | `60` | global outbound packets/sec (bucket refill + burst) |
| `RELAY_PER_SERVER_INTERVAL_MS` | `250` | min ms between packets to one ed2k server |
| `RELAY_MAX_QUEUE` | `2000` | global outbound queue cap (shed beyond) |
| `RELAY_PER_CLIENT_MAX_QUEUED` | `200` | max queued datagrams per client |
| `RELAY_MAX_PAYLOAD` | `8192` | max UDP payload bytes accepted |
| `RELAY_STATS_INTERVAL_MS` | `10000` | stats log interval |
| `RELAY_ALLOWED_ORIGINS` | (any) | comma list of allowed `Origin` headers |
| `RELAY_SERVER_ALLOWLIST` | (off) | comma list of `ip:port`; when set, ONLY these destinations are allowed |
| `RELAY_ALLOW_PRIVATE` | `0` | set `1` to allow private/reserved IPs (local testing only) |

Tune `RELAY_GLOBAL_PPS` / `RELAY_PER_SERVER_INTERVAL_MS` conservatively — it is
better to slow searches down than to get the relay's IP banned. Throttling
appears in the browser log/progress.

## Wire protocol

Binary WebSocket frames, shared with `src/transport.js`:

- `DATAGRAM` `[0x01][ip:4 BE][port:u16 BE][payload]` — both directions (browser→relay
  = "send this UDP to ip:port"; relay→browser = "UDP reply from ip:port").
- `CONTROL` `[0x02][json]` — relay→browser telemetry / backpressure
  (`{event:'throttle'|'error', reason, ...}`).

## Tests

```sh
node test.mjs
```

Covers the pacer (global bucket, per-server pacing, queue/per-client shedding,
client cleanup) with an injected clock, the destination guard, and control-frame
interop with the browser codec. No network needed.
