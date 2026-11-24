/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * hashsync-htlc: grow-only registry of record hashes, synchronised with Ethereum (HashSyncHTLC)
 * through hash time-locked attempts. Same rules as the Solidity contract:
 *   syncId = sha256(h || q), q = sha256(s), lock -> claim(s) before deadline -> record added,
 *   refund after deadline -> attempt EXPIRED, the record is never removed.
 */

'use strict';

const crypto = require('crypto');
const stringify = require('json-stringify-deterministic');
const sortKeysRecursive = require('sort-keys-recursive');
const { Contract } = require('fabric-contract-api');

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
const WRITER_MSP = 'Org1MSP';          // TP2 (Fabric side) is the only writer
const STATUS = { LOCKED: 'LOCKED', CLAIMED: 'CLAIMED', EXPIRED: 'EXPIRED' };
const R = 'R_';                        // record keys:  R_<h>
const A = 'A_';                        // attempt keys: A_<syncId>

const hex = (v, name) => {
    if (typeof v !== 'string' || !HEX32.test(v)) {
        throw new Error(`${name} invalide : 32 octets en hexadécimal attendus`);
    }
    return v.toLowerCase().replace(/^0x/, '');
};
const sha256 = (...hexParts) => crypto.createHash('sha256').update(Buffer.concat(hexParts.map((p) => Buffer.from(p, 'hex')))).digest('hex');

class HashSyncHTLC extends Contract {

    _now(ctx) {
        return Math.floor(ctx.stub.getDateTimestamp().getTime() / 1000);
    }

    _checkWriter(ctx) {
        if (ctx.clientIdentity.getMSPID() !== WRITER_MSP) {
            throw new Error(`Seule l'organisation ${WRITER_MSP} peut écrire dans hashsync-htlc`);
        }
    }

    async _get(ctx, key) {
        const b = await ctx.stub.getState(key);
        return b && b.length ? JSON.parse(b.toString()) : null;
    }

    async _put(ctx, key, value) {
        await ctx.stub.putState(key, Buffer.from(stringify(sortKeysRecursive(value))));
    }

    async _add(ctx, h, origin) {
        if (await this._get(ctx, R + h)) {
            return false;
        }
        await this._put(ctx, R + h, { hash: h, origin, addedAt: this._now(ctx), txId: ctx.stub.getTxID() });
        return true;
    }

    SyncIdOf(ctx, recordHash, hashlock) {
        return sha256(hex(recordHash, 'recordHash'), hex(hashlock, 'hashlock'));
    }

    // Origin ledger: add a record created by TP2 (idempotent)
    async AddRecord(ctx, recordHash, origin) {
        this._checkWriter(ctx);
        const h = hex(recordHash, 'recordHash');
        const added = await this._add(ctx, h, origin || 'TP2');
        if (added) {
            ctx.stub.setEvent('RecordAdded', Buffer.from(JSON.stringify({ recordHash: h, origin })));
        }
        return JSON.stringify({ recordHash: h, added });
    }

    async Lock(ctx, syncId, recordHash, hashlock, deadline, origin) {
        this._checkWriter(ctx);
        const h = hex(recordHash, 'recordHash');
        const q = hex(hashlock, 'hashlock');
        const id = hex(syncId, 'syncId');
        if (id !== sha256(h, q)) {
            throw new Error('syncId invalide : sha256(recordHash || hashlock) attendu');
        }
        if (await this._get(ctx, A + id)) {
            throw new Error(`Tentative ${id} déjà existante`);
        }
        const d = Number(deadline);
        if (!Number.isInteger(d) || d <= this._now(ctx)) {
            throw new Error('Échéance invalide ou déjà passée');
        }
        const attempt = { syncId: id, recordHash: h, hashlock: q, deadline: d, status: STATUS.LOCKED, origin: origin || '', secret: null, lockedAt: this._now(ctx) };
        await this._put(ctx, A + id, attempt);
        ctx.stub.setEvent('Locked', Buffer.from(JSON.stringify(attempt)));
        return JSON.stringify(attempt);
    }

    // Reveal the secret before the deadline: closes the attempt and adds the record if missing
    async Claim(ctx, syncId, secret) {
        this._checkWriter(ctx);
        const id = hex(syncId, 'syncId');
        const s = hex(secret, 'secret');
        const a = await this._get(ctx, A + id);
        if (!a) {
            throw new Error(`Tentative ${id} introuvable`);
        }
        if (a.status !== STATUS.LOCKED) {
            throw new Error(`Tentative ${id} non verrouillée (${a.status})`);
        }
        if (this._now(ctx) >= a.deadline) {
            throw new Error(`Échéance dépassée pour ${id}`);
        }
        if (sha256(s) !== a.hashlock) {
            throw new Error(`Secret incorrect pour ${id}`);
        }
        a.status = STATUS.CLAIMED;
        a.secret = s;
        a.claimedAt = this._now(ctx);
        await this._put(ctx, A + id, a);
        await this._add(ctx, a.recordHash, a.origin);
        ctx.stub.setEvent('Claimed', Buffer.from(JSON.stringify({ syncId: id, recordHash: a.recordHash, secret: s })));
        return JSON.stringify(a);
    }

    // After the deadline: close an unclaimed attempt. The record (if any) is kept.
    async Refund(ctx, syncId) {
        this._checkWriter(ctx);
        const id = hex(syncId, 'syncId');
        const a = await this._get(ctx, A + id);
        if (!a) {
            throw new Error(`Tentative ${id} introuvable`);
        }
        if (a.status !== STATUS.LOCKED) {
            throw new Error(`Tentative ${id} non verrouillée (${a.status})`);
        }
        if (this._now(ctx) < a.deadline) {
            throw new Error(`Échéance non atteinte pour ${id}`);
        }
        a.status = STATUS.EXPIRED;
        a.expiredAt = this._now(ctx);
        await this._put(ctx, A + id, a);
        ctx.stub.setEvent('Refunded', Buffer.from(JSON.stringify({ syncId: id, recordHash: a.recordHash })));
        return JSON.stringify(a);
    }

    async HasRecord(ctx, recordHash) {
        return (await this._get(ctx, R + hex(recordHash, 'recordHash'))) !== null;
    }

    async GetAttempt(ctx, syncId) {
        const a = await this._get(ctx, A + hex(syncId, 'syncId'));
        return JSON.stringify(a);
    }

    async GetAllRecords(ctx) {
        const out = [];
        const it = await ctx.stub.getStateByRange(R, R + 'z');
        let r = await it.next();
        while (!r.done) {
            out.push(JSON.parse(Buffer.from(r.value.value.toString()).toString('utf8')));
            r = await it.next();
        }
        await it.close();
        return JSON.stringify(out);
    }
}

module.exports = HashSyncHTLC;
