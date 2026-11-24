// monitor/server.js : read-only view of the HTLC synchronisation between Ethereum and Fabric.
// It reads both ledgers (contract HashSyncHTLC, chaincode hashsync-htlc) and the sync logs of both apps.
// It never sends a transaction and takes no part in the protocol (it is not a bridge).
//   npm start -w monitor   ->  http://localhost:3200 (config: monitor/.env, written by scripts/setup.sh)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const express = require('express');
const { EthereumLedger, FabricLedger } = require('@htlc/sync/ledgers');

const PORT = Number(process.env.MONITOR_PORT || 3200);
const APPS = { TP1: process.env.TP1_URL || 'http://localhost:3000', TP2: process.env.TP2_URL || 'http://localhost:3001' };

const ethereum = new EthereumLedger({
  rpcUrl: process.env.ETH_RPC || 'http://127.0.0.1:8545',
  addressesFile: path.resolve(__dirname, process.env.ETH_ADDRESSES),
});
const fabric = new FabricLedger({
  cryptoPath: process.env.SYNC_FABRIC_CRYPTO_PATH,       // read with TP1's Org2 identity
  user: process.env.SYNC_FABRIC_USER,
  mspId: process.env.SYNC_FABRIC_MSP,
  peerEndpoint: process.env.SYNC_FABRIC_PEER,
  peerHostAlias: process.env.SYNC_FABRIC_PEER_ALIAS,
  channel: process.env.FABRIC_CHANNEL || 'mychannel',
  chaincode: 'hashsync-htlc',
});

async function ledgerState(ledger) {
  try {
    const records = await ledger.getAllRecords();
    return { ok: true, records, now: await ledger.now(), info: ledger.describe() };
  } catch (err) {
    return { ok: false, info: ledger.describe(), error: err.shortMessage || err.message, records: [] };
  }
}

async function appState(name, url) {
  try {
    const res = await fetch(`${url}/api/sync/attempts`, { signal: AbortSignal.timeout(4000) });
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    return { ok: false, app: name, error: `${name} injoignable (${url})`, attempts: [], events: [] };
  }
}

// One synchronisation = the origin row (one app) + the responder row (other app) + both timelines
function mergeAttempts(apps) {
  const byId = new Map();
  for (const a of apps) {
    for (const row of a.attempts) {
      const s = byId.get(row.sync_id) || { syncId: row.sync_id, recordHash: row.record_hash, hashlock: row.hashlock, sides: {}, events: [] };
      s.sides[row.role] = { app: a.app, ledger: a.ledger, ...row };
      byId.set(row.sync_id, s);
    }
    for (const e of a.events) {
      const s = byId.get(e.sync_id);
      if (s) s.events.push({ ...e, detail: e.detail ? JSON.parse(e.detail) : null });
    }
  }
  return [...byId.values()].map((s) => {
    const o = s.sides.origin;
    const r = s.sides.responder;
    s.originApp = o ? o.app : (r ? r.origin_app : '?');
    s.from = o ? o.ledger : (r && r.ledger === 'ethereum' ? 'fabric' : 'ethereum');
    s.to = s.from === 'ethereum' ? 'fabric' : 'ethereum';
    s.state = o ? o.state : (r ? r.state : '?');
    s.source = o ? o.source : null;
    s.originDeadline = o ? o.own_deadline : (r ? r.peer_deadline : null);
    s.destDeadline = r ? r.own_deadline : (o ? o.peer_deadline : null);
    s.lastError = (o && o.last_error) || (r && r.last_error) || null;
    s.createdAt = Math.min(...[o, r].filter(Boolean).map((x) => x.created_at));
    s.updatedAt = Math.max(...[o, r].filter(Boolean).map((x) => x.updated_at));
    s.events.sort((a, b) => a.at - b.at || a.id - b.id);
    return s;
  }).sort((a, b) => b.createdAt - a.createdAt);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/state', async (req, res) => {
  const [eth, fab, tp1, tp2] = await Promise.all([
    ledgerState(ethereum), ledgerState(fabric), appState('TP1', APPS.TP1), appState('TP2', APPS.TP2),
  ]);
  const E = new Set(eth.records.map((r) => r.hash));
  const F = new Set(fab.records.map((r) => r.hash));
  res.json({
    at: Date.now(),
    ethereum: eth,
    fabric: fab,
    apps: { TP1: { ok: tp1.ok, error: tp1.error, signer: tp1.signer }, TP2: { ok: tp2.ok, error: tp2.error, signer: tp2.signer } },
    convergence: {
      ethereumOnly: [...E].filter((h) => !F.has(h)),
      fabricOnly: [...F].filter((h) => !E.has(h)),
      both: [...E].filter((h) => F.has(h)).length,
    },
    syncs: mergeAttempts([tp1, tp2].filter((a) => a.ok)),
  });
});

// On-demand check (button "Vérifier la synchronisation"): lists both record sets, then asks EACH ledger
// directly, record by record, whether it holds the hash (hasRecord on the contract and on the chaincode).
app.get('/api/verify', async (req, res) => {
  const started = Date.now();
  try {
    const [eth, fab] = await Promise.all([ethereum.getAllRecords(), fabric.getAllRecords()]);
    const all = [...new Set([...eth, ...fab].map((r) => r.hash))];
    const origin = Object.fromEntries([...eth, ...fab].map((r) => [r.hash, r.origin]));
    const rows = await Promise.all(all.map(async (h) => {
      const [onEthereum, onFabric] = await Promise.all([ethereum.hasRecord(h), fabric.hasRecord(h)]);
      return { hash: h, origin: origin[h], onEthereum, onFabric };
    }));
    const missing = rows.filter((r) => !r.onEthereum || !r.onFabric);
    res.json({
      at: Date.now(),
      ms: Date.now() - started,
      inSync: missing.length === 0,
      total: rows.length,
      counts: { ethereum: eth.length, fabric: fab.length },
      ethereumBlock: await ethereum.provider.getBlockNumber(),
      missing,
    });
  } catch (err) {
    res.status(503).json({ at: Date.now(), error: `Vérification impossible : ${err.shortMessage || err.message}` });
  }
});

app.listen(PORT, () => console.log(`Moniteur de synchronisation HTLC sur http://localhost:${PORT}`));
