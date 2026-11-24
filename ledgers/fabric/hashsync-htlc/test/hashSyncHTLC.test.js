/*
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';
const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const { Context } = require('fabric-contract-api');
const { ChaincodeStub } = require('fabric-shim');
const HashSyncHTLC = require('../lib/hashSyncHTLC.js');

const sha = (hex) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const H = crypto.randomBytes(32).toString('hex');
const S = crypto.randomBytes(32).toString('hex');
const Q = sha(S);
const ID = sha(H + Q);

async function rejects(p, msg) {
    try { await p; } catch (e) { expect(e.message).to.contain(msg); return; }
    expect.fail(`expected "${msg}"`);
}

describe('hashsync-htlc', () => {
    let ctx, stub, cc, now, msp;
    beforeEach(() => {
        ctx = new Context();
        stub = sinon.createStubInstance(ChaincodeStub);
        ctx.setChaincodeStub(stub);
        msp = 'Org1MSP';
        ctx.setClientIdentity({ getMSPID: () => msp });
        cc = new HashSyncHTLC();
        now = 1800000000;
        stub.states = {};
        stub.getDateTimestamp.callsFake(() => new Date(now * 1000));
        stub.getTxID.returns('tx');
        stub.putState.callsFake(async (k, v) => { stub.states[k] = v; });
        stub.getState.callsFake(async (k) => stub.states[k]);
        stub.getStateByRange.callsFake(async (a, b) => {
            const items = Object.keys(stub.states).filter((k) => k >= a && k < b).sort().map((k) => ({ value: stub.states[k] }));
            let i = 0;
            return { next: async () => (i < items.length ? { value: items[i++], done: false } : { done: true }), close: async () => {} };
        });
    });

    it('computes syncId = sha256(h || q) like Solidity', () => {
        expect(cc.SyncIdOf(ctx, H, '0x' + Q)).to.equal(ID);
    });

    it('adds a record once (idempotent, grow-only)', async () => {
        expect(JSON.parse(await cc.AddRecord(ctx, H, 'TP2')).added).to.equal(true);
        expect(JSON.parse(await cc.AddRecord(ctx, H, 'TP2')).added).to.equal(false);
        expect(await cc.HasRecord(ctx, H)).to.equal(true);
        expect(JSON.parse(await cc.GetAllRecords(ctx)).map((r) => r.hash)).to.deep.equal([H]);
    });

    it('lock then claim with the right secret adds the record', async () => {
        await cc.Lock(ctx, ID, H, Q, String(now + 600), 'TP1');
        expect(await cc.HasRecord(ctx, H)).to.equal(false);
        const a = JSON.parse(await cc.Claim(ctx, ID, S));
        expect(a.status).to.equal('CLAIMED');
        expect(a.secret).to.equal(S);
        expect(await cc.HasRecord(ctx, H)).to.equal(true);
    });

    it('rejects wrong secret, late claim, duplicate lock, bad syncId and past deadline', async () => {
        await rejects(cc.Lock(ctx, ID, H, Q, String(now), 'TP1'), 'Échéance');
        await rejects(cc.Lock(ctx, H, H, Q, String(now + 60), 'TP1'), 'syncId invalide');
        await cc.Lock(ctx, ID, H, Q, String(now + 60), 'TP1');
        await rejects(cc.Lock(ctx, ID, H, Q, String(now + 60), 'TP1'), 'déjà existante');
        await rejects(cc.Claim(ctx, ID, H), 'Secret incorrect');
        now += 120;
        await rejects(cc.Claim(ctx, ID, S), 'Échéance dépassée');
        await rejects(cc.Claim(ctx, H, S), 'introuvable');
    });

    it('refund only after the deadline; the record survives; retry works', async () => {
        await cc.AddRecord(ctx, H, 'TP2');
        await cc.Lock(ctx, ID, H, Q, String(now + 60), 'TP2');
        await rejects(cc.Refund(ctx, ID), 'non atteinte');
        now += 120;
        expect(JSON.parse(await cc.Refund(ctx, ID)).status).to.equal('EXPIRED');
        await rejects(cc.Refund(ctx, ID), 'non verrouillée');
        await rejects(cc.Claim(ctx, ID, S), 'non verrouillée');
        expect(await cc.HasRecord(ctx, H)).to.equal(true);
        const s2 = crypto.randomBytes(32).toString('hex');
        const q2 = sha(s2);
        await cc.Lock(ctx, sha(H + q2), H, q2, String(now + 600), 'TP2');
        expect(JSON.parse(await cc.Claim(ctx, sha(H + q2), s2)).status).to.equal('CLAIMED');
        expect(JSON.parse(await cc.GetAttempt(ctx, ID)).status).to.equal('EXPIRED');
    });

    it('only Org1MSP can write; reads are open; bad hex is rejected', async () => {
        msp = 'Org2MSP';
        await rejects(cc.AddRecord(ctx, H, 'TP2'), 'Seule');
        expect(await cc.HasRecord(ctx, H)).to.equal(false);
        msp = 'Org1MSP';
        await rejects(cc.AddRecord(ctx, 'abc', 'TP2'), 'invalide');
        await rejects(cc.Refund(ctx, ID), 'introuvable');
    });
});
