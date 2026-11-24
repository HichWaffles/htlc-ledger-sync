// Shows who may write to HashSyncHTLC: Hardhat's unlocked test accounts (signed by the node) are refused,
// only TP1's operator key is accepted.  usage: npm run demo:unauthorized
require('dotenv').config({ path: require('path').join(__dirname, '..', 'apps', 'tp1-ethereum', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ABI = [
  'function addRecord(bytes32, string)', 'function setOperator(address, bool)',
  'function owner() view returns (address)', 'function operators(address) view returns (bool)',
  'error NotOperator()',
];

(async () => {
  const addresses = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'apps', 'tp1-ethereum', process.env.ETH_ADDRESSES), 'utf8'));
  const address = addresses['HashSyncHTLCModule#HashSyncHTLC'];
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC || 'http://127.0.0.1:8545');
  const view = new ethers.Contract(address, ABI, provider);
  const operator = new ethers.Wallet(process.env.SYNC_ETH_OPERATOR_KEY).address;
  console.log(`HashSyncHTLC ${address}`);
  console.log(`owner              ${await view.owner()}`);
  console.log(`TP1 operator       ${operator}  operator=${await view.operators(operator)}`);

  const h = ethers.keccak256(ethers.toUtf8Bytes(`intrus ${Date.now()}`));
  for (const i of [0, 19]) {
    const signer = await provider.getSigner(i);                 // unlocked in the node, no key needed
    const c = new ethers.Contract(address, ABI, signer);
    for (const [label, call] of [['addRecord', () => c.addRecord(h, 'TP1')], ['setOperator', () => c.setOperator(signer.address, true)]]) {
      try {
        await (await call()).wait();
        console.log(`account #${i} ${label}: ACCEPTED (problem)`);
      } catch (e) {
        const data = e.data || (e.info && e.info.error && e.info.error.data);
        const parsed = data ? c.interface.parseError(typeof data === 'string' ? data : data.data) : null;
        const reason = parsed ? `revert ${parsed.name}` : (e.shortMessage || e.message);
        console.log(`account #${i} ${signer.address} ${label}: refused (${reason})`);
      }
    }
  }
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
