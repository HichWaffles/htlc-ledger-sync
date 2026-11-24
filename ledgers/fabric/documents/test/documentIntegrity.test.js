/*
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';
const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;

const { Context } = require('fabric-contract-api');
const { ChaincodeStub } = require('fabric-shim');

const DocumentIntegrity = require('../lib/documentIntegrity.js');

chai.use(sinonChai);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function iteratorOf(items) {
    let i = 0;
    return {
        next: async () => (i < items.length ? { value: items[i++], done: false } : { done: true }),
        close: sinon.stub().resolves(),
    };
}

async function expectError(promise, message) {
    try {
        await promise;
    } catch (err) {
        expect(err.message).to.contain(message);
        return;
    }
    expect.fail(`expected an error containing "${message}"`);
}

describe('Document Integrity', () => {
    let ctx, stub, contract;

    beforeEach(() => {
        ctx = new Context();
        stub = sinon.createStubInstance(ChaincodeStub);
        ctx.setChaincodeStub(stub);
        ctx.setClientIdentity({ getMSPID: () => 'Org1MSP' });
        contract = new DocumentIntegrity();

        stub.states = {};
        stub.history = {};
        stub.getDateTimestamp.returns(new Date('2026-10-28T10:00:00.000Z'));
        stub.getTxID.returns('tx1');
        stub.putState.callsFake(async (key, value) => {
            stub.states[key] = value;
            (stub.history[key] = stub.history[key] || []).push({ txId: 'tx1', isDelete: false, value });
        });
        stub.getState.callsFake(async (key) => stub.states[key]);
        stub.getStateByRange.callsFake(async () => iteratorOf(Object.values(stub.states).map(value => ({ value }))));
        stub.getHistoryForKey.callsFake(async (key) => iteratorOf(stub.history[key] || []));
    });

    describe('parameters', () => {
        it('rejects a missing or malformed id', async () => {
            await expectError(contract.RegisterDocument(ctx, undefined, HASH_A), 'Identifiant invalide');
            await expectError(contract.RegisterDocument(ctx, 'DOC 001', HASH_A), 'Identifiant invalide');
            await expectError(contract.RegisterDocument(ctx, 'x'.repeat(65), HASH_A), 'Identifiant invalide');
        });

        it('rejects a missing or malformed hash', async () => {
            await expectError(contract.RegisterDocument(ctx, 'DOC001', undefined), 'Hash invalide');
            await expectError(contract.RegisterDocument(ctx, 'DOC001', 'abc'), 'Hash invalide');
            await expectError(contract.RegisterDocument(ctx, 'DOC001', 'z'.repeat(64)), 'Hash invalide');
        });

        it('normalises 0x / uppercase hashes', async () => {
            const doc = JSON.parse(await contract.RegisterDocument(ctx, 'DOC001', '0x' + 'A'.repeat(64)));
            expect(doc.Hash).to.equal(HASH_A);
        });
    });

    describe('RegisterDocument / DocumentExists', () => {
        it('registers a new document with its metadata', async () => {
            expect(await contract.DocumentExists(ctx, 'DOC001')).to.equal(false);
            const doc = JSON.parse(await contract.RegisterDocument(ctx, 'DOC001', HASH_A));
            expect(doc).to.deep.equal({
                ID: 'DOC001', Hash: HASH_A, Timestamp: '2026-10-28T10:00:00.000Z',
                Version: 1, Owner: 'Org1MSP', TxID: 'tx1',
            });
            expect(await contract.DocumentExists(ctx, 'DOC001')).to.equal(true);
        });

        it('refuses to register the same id twice', async () => {
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            await expectError(contract.RegisterDocument(ctx, 'DOC001', HASH_B), 'existe déjà');
        });

        it('treats an empty state as missing', async () => {
            stub.states.DOC001 = Buffer.from('');
            expect(await contract.DocumentExists(ctx, 'DOC001')).to.equal(false);
        });
    });

    describe('UpdateDocument', () => {
        it('needs an existing document', async () => {
            await expectError(contract.UpdateDocument(ctx, 'DOC404', HASH_A), 'Document introuvable');
        });

        it('refuses an identical hash', async () => {
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            await expectError(contract.UpdateDocument(ctx, 'DOC001', HASH_A), 'identique');
        });

        it('stores a new version', async () => {
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            stub.getTxID.returns('tx2');
            const doc = JSON.parse(await contract.UpdateDocument(ctx, 'DOC001', HASH_B));
            expect(doc.Hash).to.equal(HASH_B);
            expect(doc.Version).to.equal(2);
            expect(doc.TxID).to.equal('tx2');
        });
    });

    describe('ReadDocument / GetHash', () => {
        it('returns the record and the hash', async () => {
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            expect(JSON.parse(await contract.ReadDocument(ctx, 'DOC001')).ID).to.equal('DOC001');
            expect(await contract.GetHash(ctx, 'DOC001')).to.equal(HASH_A);
        });

        it('Cas 1 : Document introuvable', async () => {
            await expectError(contract.ReadDocument(ctx, 'DOC404'), 'Document introuvable');
            await expectError(contract.GetHash(ctx, 'DOC404'), 'Document introuvable');
        });
    });

    describe('VerifyDocument', () => {
        it('Cas 1 : Document introuvable', async () => {
            const res = JSON.parse(await contract.VerifyDocument(ctx, 'DOC404', HASH_A));
            expect(res).to.deep.equal({ ID: 'DOC404', Status: 'Document introuvable', Valid: false, Exists: false });
        });

        it('Cas 2 : Intégrité valide', async () => {
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            const res = JSON.parse(await contract.VerifyDocument(ctx, 'DOC001', '0x' + HASH_A));
            expect(res.Status).to.equal('Intégrité valide');
            expect(res.Valid).to.equal(true);
        });

        it('Cas 3 : Intégrité invalide', async () => {
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            const res = JSON.parse(await contract.VerifyDocument(ctx, 'DOC001', HASH_B));
            expect(res.Status).to.equal('Intégrité invalide');
            expect(res.Valid).to.equal(false);
            expect(res.StoredHash).to.equal(HASH_A);
            expect(res.ProvidedHash).to.equal(HASH_B);
        });
    });

    describe('consultation', () => {
        it('lists every document', async () => {
            expect(JSON.parse(await contract.GetAllDocuments(ctx))).to.deep.equal([]);
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            await contract.RegisterDocument(ctx, 'DOC002', HASH_B);
            expect(JSON.parse(await contract.GetAllDocuments(ctx)).map(d => d.ID)).to.deep.equal(['DOC001', 'DOC002']);
        });

        it('returns the history of a document, deletions included', async () => {
            await expectError(contract.GetDocumentHistory(ctx, 'DOC001'), 'Document introuvable');
            await contract.RegisterDocument(ctx, 'DOC001', HASH_A);
            await contract.UpdateDocument(ctx, 'DOC001', HASH_B);
            stub.history.DOC001.push({ txId: 'tx3', isDelete: true, value: Buffer.from('') });
            const history = JSON.parse(await contract.GetDocumentHistory(ctx, 'DOC001'));
            expect(history.map(h => h.Value && h.Value.Version)).to.deep.equal([1, 2, null]);
            expect(history[2].IsDelete).to.equal(true);
        });
    });
});
