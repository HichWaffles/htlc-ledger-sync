// sync/ledgers.js
// Same interface for both ledgers. Hashes are handled internally as 64 lowercase hex chars (no 0x).
//   writes : addRecord(h, origin) lock(id, h, q, deadline, origin) claim(id, s) refund(id)
//   reads  : hasRecord(h) getAttempt(id) getAllRecords() now()
//   events : lockEvents(cursor) -> { events: [{ syncId, recordHash, hashlock, deadline, origin, block, txId }], next }
//            cursorKey() identifies the event stream, so a new contract / chain starts again from block 0
// getAttempt returns { status: 'NONE'|'LOCKED'|'CLAIMED'|'EXPIRED', recordHash, hashlock, deadline, origin, secret }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const strip = (h) => String(h).toLowerCase().replace(/^0x/, '');
const ETH_STATUS = ['NONE', 'LOCKED', 'CLAIMED', 'EXPIRED'];

const ETH_ABI = [
  'function addRecord(bytes32 recordHash, string origin)',
  'function lock(bytes32 syncId, bytes32 recordHash, bytes32 hashlock, uint64 deadline, string origin)',
  'function claim(bytes32 syncId, bytes32 secret)',
  'function refund(bytes32 syncId)',
  'function hasRecord(bytes32 recordHash) view returns (bool)',
  'function getRecord(bytes32 recordHash) view returns (tuple(bool exists, string origin, uint64 addedAt))',
  'function getAttempt(bytes32 syncId) view returns (tuple(bytes32 recordHash, bytes32 hashlock, uint64 deadline, uint8 status, string origin, bytes32 secret))',
  'function recordCount() view returns (uint256)',
  'function getRecords(uint256 offset, uint256 limit) view returns (bytes32[])',
  'function owner() view returns (address)',
  'function operators(address) view returns (bool)',
  'event Locked(bytes32 indexed syncId, bytes32 indexed recordHash, bytes32 hashlock, uint64 deadline, string origin)',
];

class EthereumLedger {
  // rpcUrl, addressesFile (ignition deployed_addresses.json)
  // operatorKey: TP1's own private key. Transactions are signed HERE and sent raw (eth_sendRawTransaction):
  // the node never signs for us. Without a key the ledger is read only.
  constructor({ rpcUrl, addressesFile, operatorKey }) {
    this.name = 'ethereum';
    this.rpcUrl = rpcUrl;
    this.addressesFile = addressesFile;
    this.operatorKey = operatorKey || null;
    this.contract = null;
    this.address = null;
  }

  async _contract() {
    const { ethers } = require('ethers');
    const addresses = JSON.parse(fs.readFileSync(this.addressesFile, 'utf8'));
    const address = addresses['HashSyncHTLCModule#HashSyncHTLC'];
    if (!address) throw new Error('HashSyncHTLC non déployé');
    if (!this.contract || this.address !== address) {
      // staticNetwork: no network auto-detection retries when the node is down
      // cacheTimeout -1: no 250 ms cache of identical calls, or two transactions in a row get the same nonce
      const provider = new ethers.JsonRpcProvider(this.rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
      // the nonce is read from the node for each transaction (no cache): the key may also be used by a tool
      const runner = this.operatorKey ? new ethers.Wallet(this.operatorKey, provider) : provider;
      this.contract = new ethers.Contract(address, ETH_ABI, runner);
      this.address = address;
      this.provider = provider;
      this.signer = this.operatorKey ? runner : null;
    }
    return this.contract;
  }

  async _send(fn, ...args) {
    if (!this.operatorKey) throw new Error('Ethereum en lecture seule pour cette application');
    const c = await this._contract();
    const tx = await c[fn](...args);
    const receipt = await tx.wait();
    return { txId: receipt.hash, block: receipt.blockNumber, from: receipt.from };
  }

  addRecord(h, origin) { return this._send('addRecord', '0x' + strip(h), origin); }
  lock(id, h, q, deadline, origin) { return this._send('lock', '0x' + strip(id), '0x' + strip(h), '0x' + strip(q), deadline, origin); }
  claim(id, s) { return this._send('claim', '0x' + strip(id), '0x' + strip(s)); }
  refund(id) { return this._send('refund', '0x' + strip(id)); }

  async hasRecord(h) { return (await this._contract()).hasRecord('0x' + strip(h)); }

  async getAttempt(id) {
    const a = await (await this._contract()).getAttempt('0x' + strip(id));
    const status = ETH_STATUS[Number(a.status)];
    if (status === 'NONE') return { status };
    return {
      status, recordHash: strip(a.recordHash), hashlock: strip(a.hashlock), deadline: Number(a.deadline),
      origin: a.origin, secret: /^0x0+$/.test(a.secret) ? null : strip(a.secret),
    };
  }

  async getAllRecords() {
    const c = await this._contract();
    const n = Number(await c.recordCount());
    const out = [];
    for (let i = 0; i < n; i += 100) {
      for (const h of await c.getRecords(i, 100)) {
        const r = await c.getRecord(h);
        out.push({ hash: strip(h), origin: r.origin, addedAt: Number(r.addedAt) });
      }
    }
    return out;
  }

  // Locked events from block `from` to the latest block
  async lockEvents(from) {
    const c = await this._contract();
    const latest = await this.provider.getBlockNumber();
    if (from > latest + 1) from = 0;          // the Hardhat node restarted: new chain, read it from the start
    if (from > latest) return { events: [], next: from };
    const logs = await c.queryFilter(c.filters.Locked(), from, latest);
    return {
      events: logs.map((l) => ({
        syncId: strip(l.args.syncId), recordHash: strip(l.args.recordHash), hashlock: strip(l.args.hashlock),
        deadline: Number(l.args.deadline), origin: l.args.origin, block: l.blockNumber, txId: l.transactionHash,
      })),
      next: latest + 1,
    };
  }

  cursorKey() { return `ethereum:${this.address}`; }

  // Hardhat mines on demand: the next block gets max(previous + 1, wall clock), so an idle chain's last
  // timestamp lags. The time a transaction will see is therefore the later of the two.
  async now() {
    await this._contract();
    const last = (await this.provider.getBlock('latest')).timestamp;
    return Math.max(last + 1, Math.floor(Date.now() / 1000));
  }

  async signerAddress() {
    await this._contract();
    return this.signer ? this.signer.getAddress() : null;
  }

  describe() {
    return { ledger: 'Ethereum (Hardhat)', contract: 'HashSyncHTLC', address: this.address, rpc: this.rpcUrl };
  }
}

class FabricLedger {
  constructor({ cryptoPath, user, mspId, peerEndpoint, peerHostAlias, channel, chaincode }) {
    Object.assign(this, { cryptoPath, user, mspId, peerEndpoint, peerHostAlias, channel, chaincode });
    this.name = 'fabric';
    this.contract = null;
    this.buffer = [];                         // Locked events received by the stream, not handed out yet
    this.streaming = false;
    this.next = null;                         // block to restart the stream from
  }

  _contract() {
    if (this.contract) return this.contract;
    const grpc = require('@grpc/grpc-js');
    const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
    const first = (dir) => path.join(dir, fs.readdirSync(dir)[0]);
    const msp = path.join(this.cryptoPath, 'users', this.user, 'msp');
    const client = new grpc.Client(this.peerEndpoint,
      grpc.credentials.createSsl(fs.readFileSync(path.join(this.cryptoPath, 'peers', this.peerHostAlias, 'tls', 'ca.crt'))),
      { 'grpc.ssl_target_name_override': this.peerHostAlias });
    const gateway = connect({
      client,
      identity: { mspId: this.mspId, credentials: fs.readFileSync(first(path.join(msp, 'signcerts'))) },
      signer: signers.newPrivateKeySigner(crypto.createPrivateKey(fs.readFileSync(first(path.join(msp, 'keystore'))))),
      hash: hash.sha256,
      evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
      endorseOptions: () => ({ deadline: Date.now() + 15000 }),
      submitOptions: () => ({ deadline: Date.now() + 5000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });
    this.network = gateway.getNetwork(this.channel);
    this.contract = this.network.getContract(this.chaincode);
    return this.contract;
  }

  async _eval(fn, ...args) {
    return new TextDecoder().decode(await this._contract().evaluateTransaction(fn, ...args.map(String)));
  }

  async _send(fn, ...args) {
    const commit = await this._contract().submitAsync(fn, { arguments: args.map(String) });
    const status = await commit.getStatus();
    if (!status.successful) throw new Error(`Transaction Fabric ${status.transactionId} refusée (code ${status.code})`);
    return { txId: status.transactionId, block: Number(status.blockNumber), from: `${this.user} (${this.mspId})` };
  }

  addRecord(h, origin) { return this._send('AddRecord', strip(h), origin); }
  lock(id, h, q, deadline, origin) { return this._send('Lock', strip(id), strip(h), strip(q), deadline, origin); }
  claim(id, s) { return this._send('Claim', strip(id), strip(s)); }
  refund(id) { return this._send('Refund', strip(id)); }

  async hasRecord(h) { return JSON.parse(await this._eval('HasRecord', strip(h))); }

  async getAttempt(id) {
    const a = JSON.parse(await this._eval('GetAttempt', strip(id)));
    if (!a) return { status: 'NONE' };
    return { status: a.status, recordHash: a.recordHash, hashlock: a.hashlock, deadline: a.deadline, origin: a.origin, secret: a.secret };
  }

  async getAllRecords() {
    return JSON.parse(await this._eval('GetAllRecords')).map((r) => ({ hash: r.hash, origin: r.origin, addedAt: r.addedAt }));
  }

  // Chaincode events arrive on a stream (peer deliver service). The stream runs in the background and fills
  // a buffer; each call hands out what arrived. If the stream drops (peer down) it restarts from the last block
  // seen: events of that block may come twice, the engine ignores what it already knows.
  _stream(from) {
    this.streaming = true;
    this.next = from;
    (async () => {
      try {
        this._contract();
        const events = await this.network.getChaincodeEvents(this.chaincode, { startBlock: BigInt(from) });
        for await (const ev of events) {
          this.next = Number(ev.blockNumber);
          if (ev.eventName !== 'Locked') continue;
          const a = JSON.parse(Buffer.from(ev.payload).toString('utf8'));
          this.buffer.push({
            syncId: a.syncId, recordHash: a.recordHash, hashlock: a.hashlock, deadline: a.deadline, origin: a.origin,
            block: Number(ev.blockNumber), txId: ev.transactionId,
          });
        }
      } catch (err) { /* peer unreachable or stream closed: restarted on the next call */ }
      this.streaming = false;
    })();
  }

  async lockEvents(from) {
    if (!this.streaming) this._stream(this.next ?? from);
    return { events: this.buffer.splice(0), next: this.next ?? from };
  }

  cursorKey() { return `fabric:${this.channel}:${this.chaincode}`; }

  async now() { return Math.floor(Date.now() / 1000); }

  async signerAddress() { return `${this.user} (${this.mspId})`; }

  describe() { return { ledger: 'Hyperledger Fabric', contract: `chaincode ${this.chaincode}`, channel: this.channel, identity: `${this.user} (${this.mspId})` }; }
}

module.exports = { EthereumLedger, FabricLedger, strip };
