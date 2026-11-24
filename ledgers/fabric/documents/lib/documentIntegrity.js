/*
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

// Deterministic JSON.stringify(): every endorsing peer must produce the exact same bytes
const stringify = require('json-stringify-deterministic');
const sortKeysRecursive = require('sort-keys-recursive');
const { Contract } = require('fabric-contract-api');

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const HASH_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/; // SHA-256 / keccak256, 32 bytes in hex

const STATUS_NOT_FOUND = 'Document introuvable';
const STATUS_VALID = 'Intégrité valide';
const STATUS_INVALID = 'Intégrité invalide';

class DocumentIntegrity extends Contract {

    // ---------------------------------------------------------------- helpers

    _checkId(id) {
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
            throw new Error(`Identifiant invalide "${id}" : 1 à 64 caractères parmi lettres, chiffres, . _ -`);
        }
    }

    // Accepts a 64 hex char hash, with or without 0x, and stores it in one canonical form
    _normalizeHash(hash) {
        if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
            throw new Error('Hash invalide : 64 caractères hexadécimaux attendus (empreinte SHA-256)');
        }
        return hash.toLowerCase().replace(/^0x/, '');
    }

    // The transaction timestamp is chosen by the client and identical on every peer,
    // unlike Date.now() which would differ between endorsers and break the endorsement.
    _txTime(ctx) {
        return ctx.stub.getDateTimestamp().toISOString();
    }

    async _get(ctx, id) {
        const bytes = await ctx.stub.getState(id);
        if (!bytes || bytes.length === 0) {
            return null;
        }
        return JSON.parse(bytes.toString());
    }

    async _put(ctx, doc) {
        await ctx.stub.putState(doc.ID, Buffer.from(stringify(sortKeysRecursive(doc))));
        return doc;
    }

    // ---------------------------------------------------------------- transactions

    // Vérifier l'existence : true if the document already has a registered fingerprint
    async DocumentExists(ctx, id) {
        this._checkId(id);
        return (await this._get(ctx, id)) !== null;
    }

    // Enregistrer une empreinte : create the document with its first hash
    async RegisterDocument(ctx, id, hash) {
        this._checkId(id);
        const normalized = this._normalizeHash(hash);
        if (await this._get(ctx, id)) {
            throw new Error(`Le document ${id} existe déjà, utilisez UpdateDocument pour enregistrer une nouvelle version`);
        }
        const doc = {
            ID: id,
            Hash: normalized,
            Timestamp: this._txTime(ctx),
            Version: 1,
            Owner: ctx.clientIdentity.getMSPID(),
            TxID: ctx.stub.getTxID(),
        };
        return JSON.stringify(await this._put(ctx, doc));
    }

    // New version of an existing document. The previous versions stay in the ledger history.
    async UpdateDocument(ctx, id, hash) {
        this._checkId(id);
        const normalized = this._normalizeHash(hash);
        const doc = await this._get(ctx, id);
        if (!doc) {
            throw new Error(`${STATUS_NOT_FOUND} : ${id}`);
        }
        if (doc.Hash === normalized) {
            throw new Error(`Le hash est identique à la version ${doc.Version}, aucune modification à enregistrer`);
        }
        doc.Hash = normalized;
        doc.Timestamp = this._txTime(ctx);
        doc.Version += 1;
        doc.Owner = ctx.clientIdentity.getMSPID();
        doc.TxID = ctx.stub.getTxID();
        return JSON.stringify(await this._put(ctx, doc));
    }

    // Récupérer une empreinte : the whole record (ID, Hash, Timestamp, Version, Owner, TxID)
    async ReadDocument(ctx, id) {
        this._checkId(id);
        const doc = await this._get(ctx, id);
        if (!doc) {
            throw new Error(`${STATUS_NOT_FOUND} : ${id}`);
        }
        return JSON.stringify(doc);
    }

    // Récupérer une empreinte : only the hash
    async GetHash(ctx, id) {
        return JSON.parse(await this.ReadDocument(ctx, id)).Hash;
    }

    // Vérifier une empreinte : never throws for a missing document, it answers
    // "Document introuvable" so the client can display the three cases the same way
    async VerifyDocument(ctx, id, hash) {
        this._checkId(id);
        const normalized = this._normalizeHash(hash);
        const doc = await this._get(ctx, id);
        if (!doc) {
            return JSON.stringify({ ID: id, Status: STATUS_NOT_FOUND, Valid: false, Exists: false });
        }
        const valid = doc.Hash === normalized;
        return JSON.stringify({
            ID: id,
            Status: valid ? STATUS_VALID : STATUS_INVALID,
            Valid: valid,
            Exists: true,
            StoredHash: doc.Hash,
            ProvidedHash: normalized,
            Version: doc.Version,
            Timestamp: doc.Timestamp,
        });
    }

    // Consultation : every registered document
    async GetAllDocuments(ctx) {
        const all = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();
        while (!result.done) {
            all.push(JSON.parse(Buffer.from(result.value.value.toString()).toString('utf8')));
            result = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(all);
    }

    // Consultation : every version of one document, read from the ledger history
    async GetDocumentHistory(ctx, id) {
        this._checkId(id);
        const history = [];
        const iterator = await ctx.stub.getHistoryForKey(id);
        let result = await iterator.next();
        while (!result.done) {
            const entry = result.value;
            history.push({
                TxID: entry.txId,
                IsDelete: entry.isDelete,
                Value: entry.isDelete ? null : JSON.parse(Buffer.from(entry.value).toString('utf8')),
            });
            result = await iterator.next();
        }
        await iterator.close();
        if (history.length === 0) {
            throw new Error(`${STATUS_NOT_FOUND} : ${id}`);
        }
        return JSON.stringify(history);
    }
}

module.exports = DocumentIntegrity;
