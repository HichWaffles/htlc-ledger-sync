// sync/engine.js
// HTLC synchronisation between this app's ledger (own) and the other app's ledger (other).
// No bridge and no message between the apps: each app WRITES only its own ledger and READS (watches) the
// other one. The ledgers carry every step of the protocol, including the secret.
//
//   Origin app A (record created here)                    Responder app B
//   NEW         addRecord(h) + lock(id,h,q,T_A) on A
//   LOCKED_OWN  ...................... Locked event on A -->  checks it, lock(id,h,q,T_B) on B, T_B = T_A + ttl
//               sees B's lock on B (checked)
//               claim(id,s) on A: s becomes public on A
//   REVEALED    ...................... Claimed on A ------->  reads s on A, claim(id,s) on B: h added on B
//               sees h + CLAIMED on B
//   DONE
//
// A reveals s on its own ledger first, so B's deadline must be the later one (T_B > T_A): B always has time
// to use the secret once it is public. Any attempt that runs out of time is refunded (EXPIRED) and the origin
// opens a new one (new secret) while h is still missing on the other ledger. Records are never removed.

const crypto = require('crypto');
const express = require('express');
const { strip } = require('./ledgers');

const sha256Hex = (...hexParts) => crypto.createHash('sha256')
  .update(Buffer.concat(hexParts.map((p) => Buffer.from(strip(p), 'hex')))).digest('hex');

const FINAL = ['DONE', 'EXPIRED', 'CLAIMED'];
const LABEL = { ethereum: 'Ethereum', fabric: 'Fabric' };   // ledger names as shown in the log
const NOT_FINAL = `state NOT IN (${FINAL.map((s) => `'${s}'`).join(',')})`;

class SyncEngine {
  // originTtl: lifetime of the origin lock. responderTtl: how much longer the responder lock lives.
  // margin: minimum time left to start a step that the other side still has to complete.
  constructor({ db, app, own, other, originTtl = 300, responderTtl = 150, margin = 30, tickMs = 2000, reconcileMs = 15000 }) {
    Object.assign(this, { db, app, own, other, originTtl, responderTtl, margin, tickMs, reconcileMs });
    this.peerApp = app === 'TP1' ? 'TP2' : 'TP1';
    this.otherLabel = LABEL[other.name];
    this.busy = false;
    this._schema();
  }

  // ---------------------------------------------------------------- storage (this app's own SQLite)
  _schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_attempts (
        sync_id TEXT PRIMARY KEY,
        record_hash TEXT NOT NULL,
        hashlock TEXT NOT NULL,
        secret TEXT,                    -- origin: chosen here; responder: read on the origin ledger
        role TEXT NOT NULL,             -- 'origin' | 'responder'
        origin_app TEXT NOT NULL,
        source TEXT,                    -- what created the attempt (dossier, réconciliation, Locked event)
        state TEXT NOT NULL,
        own_deadline INTEGER,
        peer_deadline INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_attempts_hash ON sync_attempts(record_hash);
      CREATE TABLE IF NOT EXISTS sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL,
        at INTEGER NOT NULL,            -- ms
        app TEXT NOT NULL,
        ledger TEXT,                    -- ledger written or read by this step (ethereum | fabric)
        step TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_cursor (
        stream TEXT PRIMARY KEY,        -- which event stream of the other ledger (contract / chaincode)
        next_block INTEGER NOT NULL
      );
    `);
  }

  _row(id) { return this.db.prepare('SELECT * FROM sync_attempts WHERE sync_id = ?').get(id); }

  _set(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE sync_attempts SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE sync_id = @sync_id`)
      .run({ ...fields, updated_at: Date.now(), sync_id: id });
  }

  _log(id, step, ledger, detail) {
    this.db.prepare('INSERT INTO sync_events (sync_id, at, app, ledger, step, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, Date.now(), this.app, ledger || null, step, detail ? JSON.stringify(detail) : null);
  }

  _active(h) {
    return this.db.prepare(`SELECT * FROM sync_attempts WHERE record_hash = ? AND role = 'origin' AND ${NOT_FINAL}`).get(strip(h));
  }

  // ---------------------------------------------------------------- origin side
  // Called right after the record is upserted on this app's ledger (and by reconciliation)
  start(recordHash, source = 'dossier') {
    const h = strip(recordHash);
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('hash invalide');
    const active = this._active(h);
    if (active) return active.sync_id;
    const s = crypto.randomBytes(32).toString('hex');
    const q = sha256Hex(s);
    const id = sha256Hex(h, q);
    const now = Date.now();
    this.db.prepare(`INSERT INTO sync_attempts (sync_id, record_hash, hashlock, secret, role, origin_app, source, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'origin', ?, ?, 'NEW', ?, ?)`).run(id, h, q, s, this.app, source, now, now);
    this._log(id, 'Nouvelle tentative', null, { recordHash: h, hashlock: q, source });
    setImmediate(() => this.tick());
    return id;
  }

  async _origin(r) {
    const now = await this.own.now();

    if (r.state === 'NEW') {
      // reading the other ledger first: no lock while it is unreachable, nothing to do if h is already there
      if (await this.other.hasRecord(r.record_hash)) {
        this._set(r.sync_id, { state: 'DONE', last_error: null });
        this._log(r.sync_id, `Déjà présent sur ${this.otherLabel}`, this.other.name);
        return;
      }
      if (!(await this.own.hasRecord(r.record_hash))) {         // once only, even if the lock below is retried
        const added = await this.own.addRecord(r.record_hash, this.app);
        this._log(r.sync_id, 'Enregistrement ajouté', this.own.name, added);
      }
      const deadline = now + this.originTtl;
      const tx = await this.own.lock(r.sync_id, r.record_hash, r.hashlock, deadline, this.app);
      this._set(r.sync_id, { state: 'LOCKED_OWN', own_deadline: deadline, last_error: null });
      this._log(r.sync_id, `Verrou HTLC posé (T=${deadline})`, this.own.name, tx);
      return;
    }

    if (r.state === 'LOCKED_OWN') {
      if (now >= r.own_deadline) return this._expire(r);
      const a = await this.other.getAttempt(r.sync_id);       // the responder's lock, read on its ledger
      if (a.status === 'NONE') return;                         // not locked yet
      if (a.status !== 'LOCKED' || a.recordHash !== r.record_hash || a.hashlock !== r.hashlock) {
        throw new Error(`Verrou inattendu sur ${this.otherLabel} (${a.status})`);
      }
      if (a.deadline < r.own_deadline + this.margin) throw new Error(`Échéance du verrou sur ${this.otherLabel} trop courte`);
      if (r.own_deadline - now < this.margin) return;           // too late to reveal: let it expire
      this._set(r.sync_id, { peer_deadline: a.deadline });
      this._log(r.sync_id, `Verrou de ${this.peerApp} vérifié sur ${this.otherLabel} (T=${a.deadline})`, this.other.name, { deadline: a.deadline });
      const tx = await this.own.claim(r.sync_id, r.secret);    // reveals s on our own ledger
      this._set(r.sync_id, { state: 'REVEALED', last_error: null });
      this._log(r.sync_id, 'Secret publié en réclamant le verrou', this.own.name, tx);
      return;
    }

    if (r.state === 'REVEALED') {
      const a = await this.other.getAttempt(r.sync_id);
      if (a.status === 'CLAIMED' && (await this.other.hasRecord(r.record_hash))) {
        this._set(r.sync_id, { state: 'DONE', last_error: null });
        this._log(r.sync_id, `Enregistrement confirmé sur ${this.otherLabel}, synchronisé`, this.other.name);
        return;
      }
      const otherNow = await this.other.now();
      if (a.status === 'EXPIRED' || (a.status === 'LOCKED' && otherNow >= a.deadline)) return this._expire(r);
    }
  }

  // ---------------------------------------------------------------- responder side
  // A Locked event on the other ledger: an attempt opened by the other app, unless it is our own responder lock
  async _onForeignLock(ev) {
    const id = strip(ev.syncId);
    if (ev.origin === this.app || this._row(id)) return;      // our own attempt, or already handled
    const h = strip(ev.recordHash); const q = strip(ev.hashlock);
    if (id !== sha256Hex(h, q)) return;
    const a = await this.other.getAttempt(id);                 // current state, not just the event
    if (a.status !== 'LOCKED' || a.recordHash !== h || a.hashlock !== q) return;
    const now = await this.own.now();
    if (a.deadline - Math.max(now, await this.other.now()) < 2 * this.margin) return;  // too late, A will retry
    if (await this.own.hasRecord(h)) return;                   // already here, the origin will see it

    const myDeadline = Math.max(a.deadline, now) + this.responderTtl;
    const t = Date.now();
    this.db.prepare(`INSERT INTO sync_attempts (sync_id, record_hash, hashlock, role, origin_app, source, state, own_deadline, peer_deadline, created_at, updated_at)
      VALUES (?, ?, ?, 'responder', ?, ?, 'LOCKING', ?, ?, ?, ?)`)
      .run(id, h, q, a.origin || '?', `événement Locked, bloc ${ev.block}`, myDeadline, a.deadline, t, t);
    this._log(id, `Verrou de ${a.origin} détecté sur ${this.otherLabel}`, this.other.name, { block: ev.block, txId: ev.txId, deadline: a.deadline });
    await this._responder(this._row(id));
  }

  async _responder(r) {
    const now = await this.own.now();

    if (r.state === 'LOCKING') {
      const mine = await this.own.getAttempt(r.sync_id);      // the lock may have gone through before a crash
      if (mine.status === 'NONE' && now >= r.own_deadline - this.margin) return this._expire(r);
      const tx = mine.status === 'NONE' ? await this.own.lock(r.sync_id, r.record_hash, r.hashlock, r.own_deadline, r.origin_app) : null;
      this._set(r.sync_id, { state: 'LOCKED', last_error: null });
      this._log(r.sync_id, `Verrou HTLC posé (T=${r.own_deadline})`, this.own.name, tx);
      return;
    }

    if (r.state === 'LOCKED') {
      const a = await this.other.getAttempt(r.sync_id);
      if (a.status === 'CLAIMED' && a.secret && sha256Hex(a.secret) === r.hashlock && now < r.own_deadline) {
        this._log(r.sync_id, `Secret lu sur ${this.otherLabel}`, this.other.name);
        const tx = await this.own.claim(r.sync_id, a.secret);
        this._set(r.sync_id, { state: 'CLAIMED', secret: a.secret, last_error: null });
        this._log(r.sync_id, 'Verrou réclamé : enregistrement ajouté', this.own.name, tx);
        return;
      }
      if (now >= r.own_deadline) return this._expire(r);
    }
  }

  // ---------------------------------------------------------------- expiry (both sides)
  async _expire(r) {
    const a = await this.own.getAttempt(r.sync_id);
    if (a.status === 'LOCKED') {
      const now = await this.own.now();
      if (now < a.deadline) return;                           // ledger clock not there yet, next tick
      const tx = await this.own.refund(r.sync_id);
      this._log(r.sync_id, 'Échéance dépassée : verrou remboursé', this.own.name, tx);
    }
    if (r.role === 'origin' && (await this.other.hasRecord(r.record_hash))) {
      this._set(r.sync_id, { state: 'DONE', last_error: null });
      this._log(r.sync_id, `Déjà présent sur ${this.otherLabel}`, this.other.name);
      return;
    }
    this._set(r.sync_id, { state: 'EXPIRED' });
    this._log(r.sync_id, 'Tentative expirée', null, { ledgerStatus: a.status });
    if (r.role === 'origin') {
      const id = this.start(r.record_hash, 'nouvelle tentative');
      this._log(r.sync_id, 'Nouvelle tentative ouverte', null, { syncId: id });
    }
  }

  // ---------------------------------------------------------------- worker
  // New Locked events on the other ledger, from the block saved in sync_cursor
  async _watch() {
    await this.other.getAllRecords().catch(() => {});        // make sure the contract (and its address) is loaded
    const key = this.other.cursorKey();
    const row = this.db.prepare('SELECT next_block FROM sync_cursor WHERE stream = ?').get(key);
    const { events, next } = await this.other.lockEvents(row ? row.next_block : 0);
    for (const ev of events) {
      try { await this._onForeignLock(ev); } catch (err) {
        const msg = err.shortMessage || err.message || String(err);
        if (this._row(strip(ev.syncId))) this._set(strip(ev.syncId), { last_error: msg });
      }
    }
    this.db.prepare('INSERT INTO sync_cursor (stream, next_block) VALUES (?, ?) ON CONFLICT(stream) DO UPDATE SET next_block = excluded.next_block')
      .run(key, next);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this._watch().catch(() => {});                    // other ledger down: next tick
      const rows = this.db.prepare(`SELECT * FROM sync_attempts WHERE ${NOT_FINAL} ORDER BY created_at`).all();
      for (const r of rows) {
        try {
          if (r.role === 'origin') await this._origin(r); else await this._responder(r);
        } catch (err) {
          const msg = err.shortMessage || err.message || String(err);
          if (msg !== r.last_error) this._log(r.sync_id, 'Erreur, nouvel essai', null, { error: msg });
          this._set(r.sync_id, { last_error: msg });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // Every record of this ledger must exist on the other one: covers an app that was down and ledger resets
  async reconcile() {
    try {
      for (const rec of await this.own.getAllRecords()) {
        if (this._active(rec.hash)) continue;
        if (this.db.prepare(`SELECT 1 FROM sync_attempts WHERE record_hash = ? AND role = 'responder' AND ${NOT_FINAL}`).get(rec.hash)) continue;
        if (!(await this.other.hasRecord(rec.hash))) this.start(rec.hash, 'réconciliation');
      }
    } catch (err) { /* a ledger is down: next round */ }
  }

  run() {
    setInterval(() => this.tick(), this.tickMs);
    setInterval(() => this.reconcile(), this.reconcileMs);
    setTimeout(() => this.reconcile(), 3000);
  }

  // ---------------------------------------------------------------- HTTP API (read only, for the monitor)
  router() {
    const r = express.Router();

    r.get('/health', async (req, res) => {
      res.json({ app: this.app, ledger: this.own.name, signer: await this.own.signerAddress().catch(() => null) });
    });

    r.get('/attempts', async (req, res) => {
      const attempts = this.db.prepare('SELECT sync_id, record_hash, hashlock, role, origin_app, source, state, own_deadline, peer_deadline, last_error, created_at, updated_at FROM sync_attempts ORDER BY created_at DESC LIMIT 200').all();
      const events = this.db.prepare('SELECT * FROM sync_events ORDER BY id DESC LIMIT 2000').all();
      res.json({ app: this.app, ledger: this.own.name, signer: await this.own.signerAddress().catch(() => null), attempts, events });
    });

    return r;
  }
}

module.exports = { SyncEngine, sha256Hex };
