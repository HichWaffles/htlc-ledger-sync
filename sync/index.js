// sync/index.js : builds the HTLC sync engine of this app from .env
//   SYNC_APP=TP1|TP2   SYNC_OWN=ethereum|fabric
//   ETH_RPC, ETH_ADDRESSES (ignition deployed_addresses.json)
//   SYNC_ETH_OPERATOR_KEY  TP1 only: its own Ethereum key, sole operator of HashSyncHTLC (TP2 reads Ethereum only)
//   SYNC_FABRIC_CRYPTO_PATH, SYNC_FABRIC_USER, SYNC_FABRIC_MSP, SYNC_FABRIC_PEER, SYNC_FABRIC_PEER_ALIAS
//   SYNC_ORIGIN_TTL, SYNC_RESPONDER_TTL, SYNC_MARGIN (seconds)
const path = require('path');
const { EthereumLedger, FabricLedger } = require('./ledgers');
const { SyncEngine } = require('./engine');

function createSync(db, rootDir) {
  const e = process.env;
  const own = e.SYNC_OWN;
  if (own === 'ethereum' && !e.SYNC_ETH_OPERATOR_KEY) throw new Error('SYNC_ETH_OPERATOR_KEY manquant dans .env');
  const ethereum = new EthereumLedger({
    rpcUrl: e.ETH_RPC || 'http://127.0.0.1:8545',
    addressesFile: path.resolve(rootDir, e.ETH_ADDRESSES),
    operatorKey: own === 'ethereum' ? e.SYNC_ETH_OPERATOR_KEY : null,
  });
  const fabric = new FabricLedger({
    cryptoPath: e.SYNC_FABRIC_CRYPTO_PATH,
    user: e.SYNC_FABRIC_USER,
    mspId: e.SYNC_FABRIC_MSP,
    peerEndpoint: e.SYNC_FABRIC_PEER,
    peerHostAlias: e.SYNC_FABRIC_PEER_ALIAS,
    channel: e.FABRIC_CHANNEL || 'mychannel',
    chaincode: 'hashsync-htlc',
  });
  return new SyncEngine({
    db,
    app: e.SYNC_APP,
    own: own === 'ethereum' ? ethereum : fabric,
    other: own === 'ethereum' ? fabric : ethereum,
    originTtl: Number(e.SYNC_ORIGIN_TTL || 300),
    responderTtl: Number(e.SYNC_RESPONDER_TTL || 150),
    margin: Number(e.SYNC_MARGIN || 30),
  });
}

module.exports = { createSync };
