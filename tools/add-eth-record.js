// Test helper: adds a record straight into HashSyncHTLC on Ethereum with TP1's operator key, without going
// through the app. TP1's reconciliation must notice it is missing on Fabric and synchronise it.
// usage: npm run demo:eth-record [-- text]
require('dotenv').config({ path: require('path').join(__dirname, '..', 'apps', 'tp1-ethereum', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

(async () => {
  const addresses = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'apps', 'tp1-ethereum', process.env.ETH_ADDRESSES), 'utf8'));
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC || 'http://127.0.0.1:8545');
  const operator = new ethers.Wallet(process.env.SYNC_ETH_OPERATOR_KEY, provider);
  const c = new ethers.Contract(addresses['HashSyncHTLCModule#HashSyncHTLC'], ['function addRecord(bytes32, string)'], operator);
  const h = ethers.keccak256(ethers.toUtf8Bytes(process.argv[2] || `test record ${Date.now()}`));
  await (await c.addRecord(h, 'TP1')).wait();
  console.log(h);
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
