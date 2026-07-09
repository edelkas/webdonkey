// pacer.js — outbound rate limiter for the relay.
//
// Enforces, GLOBALLY across every connected browser client (§2.3), two limits on
// UDP sent to ed2k servers, so the relay's single IP does not get rate-limited or
// banned:
//   1. a global token bucket (packets/sec overall), and
//   2. per-destination-server pacing (min interval between packets to one server).
//
// Datagrams are queued and drained by a timer; when the queue (or a single
// client's share of it) is full, new datagrams are shed and the caller is told to
// signal backpressure. The scheduling core is `pump(now)` — pure w.r.t. the clock
// (time is passed in) so it can be unit-tested without real timers.

const nowMs = () => Date.now();

export class Pacer {
  /**
   * @param {object} opts
   * @param {number} [opts.globalPps]           global packets/sec cap (bucket refill + burst)
   * @param {number} [opts.perServerIntervalMs] min ms between packets to one server
   * @param {number} [opts.maxQueue]            global queue cap (shed beyond this)
   * @param {number} [opts.perClientMax]        max queued datagrams per client
   * @param {(item:any)=>void} opts.send        actually send one queued item
   * @param {()=>number} [opts.now]             clock (injectable for tests)
   * @param {(cb:Function,ms:number)=>any} [opts.setTimer]
   * @param {(h:any)=>void} [opts.clearTimer]
   */
  constructor({
    globalPps = 60,
    perServerIntervalMs = 250,
    maxQueue = 2000,
    perClientMax = 200,
    send,
    now = nowMs,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.capacity = Math.max(1, globalPps);
    this.refillPerMs = globalPps / 1000;
    this.perServerIntervalMs = perServerIntervalMs;
    this.maxQueue = maxQueue;
    this.perClientMax = perClientMax;
    this.send = send;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;

    this.tokens = this.capacity;
    this.lastRefill = now();
    this.queue = [];
    this.lastSent = new Map(); // serverKey -> last send ms
    this._perClient = new Map(); // clientId -> queued count
    this.dropped = 0;
    this._timer = null;
    this._timerAt = Infinity;
  }

  get queued() {
    return this.queue.length;
  }

  /**
   * Queue a datagram for sending. Item must have {serverKey, clientId} plus
   * whatever `send` needs. Returns {ok} or {ok:false, reason} when shed.
   */
  enqueue(item) {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++;
      return { ok: false, reason: 'relay queue full' };
    }
    const c = this._perClient.get(item.clientId) || 0;
    if (c >= this.perClientMax) {
      this.dropped++;
      return { ok: false, reason: 'client backlog full' };
    }
    this._perClient.set(item.clientId, c + 1);
    this.queue.push(item);
    this._kick(0);
    return { ok: true };
  }

  /** Drop a disconnected client's queued datagrams. */
  dropClient(clientId) {
    if (this._perClient.has(clientId)) {
      this.queue = this.queue.filter((it) => it.clientId !== clientId);
      this._perClient.delete(clientId);
    }
  }

  /**
   * Send everything eligible at time `t`, then return the ms to wait before the
   * next drain (or null if the queue is empty). Pure w.r.t. the clock.
   */
  pump(t) {
    this._refill(t);
    while (this.tokens >= 1 && this.queue.length) {
      const idx = this._firstEligible(t);
      if (idx === -1) break; // all remaining are per-server-paced
      const item = this.queue.splice(idx, 1)[0];
      this._decClient(item.clientId);
      this.lastSent.set(item.serverKey, t);
      this.tokens -= 1;
      try {
        this.send(item);
      } catch {
        /* a single failed send must not stall the pump */
      }
    }
    return this.queue.length ? this._nextDelay(t) : null;
  }

  _refill(t) {
    const dt = t - this.lastRefill;
    if (dt > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerMs);
      this.lastRefill = t;
    }
  }

  // Index of the first queued item whose destination server is off cooldown.
  // A server we've never sent to (undefined) is always eligible.
  _firstEligible(t) {
    for (let i = 0; i < this.queue.length; i++) {
      const last = this.lastSent.get(this.queue[i].serverKey);
      if (last === undefined || t - last >= this.perServerIntervalMs) return i;
    }
    return -1;
  }

  _nextDelay(t) {
    const tokenDelay = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    let serverDelay = Infinity;
    for (const item of this.queue) {
      const last = this.lastSent.get(item.serverKey);
      const wait = last === undefined ? 0 : Math.max(0, this.perServerIntervalMs - (t - last));
      if (wait < serverDelay) serverDelay = wait;
      if (serverDelay === 0) break;
    }
    if (serverDelay === Infinity) serverDelay = 0;
    return Math.max(1, Math.max(tokenDelay, serverDelay));
  }

  _decClient(clientId) {
    const c = (this._perClient.get(clientId) || 1) - 1;
    if (c <= 0) this._perClient.delete(clientId);
    else this._perClient.set(clientId, c);
  }

  // --- timer glue (not exercised by pump tests) ---
  _kick(delay) {
    const at = this._now() + delay;
    if (this._timer && this._timerAt <= at) return; // an earlier drain is already set
    if (this._timer) this._clearTimer(this._timer);
    this._timerAt = at;
    this._timer = this._setTimer(() => this._drain(), Math.max(0, delay));
  }

  _drain() {
    this._timer = null;
    this._timerAt = Infinity;
    const delay = this.pump(this._now());
    if (delay != null) this._kick(delay);
  }
}
