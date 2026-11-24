// config/fabric.js
// Connexion au reseau Hyperledger Fabric via le service Gateway de peer0.org1,
// avec l'identite User1@org1 (certificat + cle privee de son dossier MSP).
// Seule l'empreinte SHA-256 des dossiers est envoyee a Fabric (chaincode "documents").

const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const channelName = process.env.FABRIC_CHANNEL || 'mychannel';
const chaincodeName = process.env.FABRIC_CHAINCODE || 'documents';
const mspId = process.env.FABRIC_MSP_ID || 'Org1MSP';
const cryptoPath = process.env.FABRIC_CRYPTO_PATH;
const fabricUser = process.env.FABRIC_USER || 'User1@org1.example.com';
const peerEndpoint = process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051';
const peerHostAlias = process.env.FABRIC_PEER_HOST_ALIAS || 'peer0.org1.example.com';

const decoder = new TextDecoder();
let contract = null;
let identity = null;

function firstFile(dir) {
  return path.join(dir, fs.readdirSync(dir)[0]);
}

// Connexion paresseuse : l'application demarre meme si le reseau Fabric n'est pas encore lance
function getContract() {
  if (contract) return contract;

  const userMsp = path.join(cryptoPath, 'users', fabricUser, 'msp');
  const tlsRootCert = fs.readFileSync(path.join(cryptoPath, 'peers', peerHostAlias, 'tls', 'ca.crt'));
  const certPem = fs.readFileSync(firstFile(path.join(userMsp, 'signcerts')));
  const keyPem = fs.readFileSync(firstFile(path.join(userMsp, 'keystore')));

  const client = new grpc.Client(peerEndpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': peerHostAlias,
  });
  const gateway = connect({
    client,
    identity: { mspId, credentials: certPem },
    signer: signers.newPrivateKeySigner(crypto.createPrivateKey(keyPem)),
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
    endorseOptions: () => ({ deadline: Date.now() + 15000 }),
    submitOptions: () => ({ deadline: Date.now() + 5000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });

  const cert = new crypto.X509Certificate(certPem);
  identity = {
    mspId,
    user: (cert.subject.match(/CN=([^\n,]+)/) || [])[1] || fabricUser,
    channel: channelName,
    chaincode: chaincodeName,
    peer: peerEndpoint,
  };
  contract = gateway.getNetwork(channelName).getContract(chaincodeName);
  return contract;
}

// Lecture (execute sur un peer, rien n'est ecrit)
async function evaluate(fn, ...args) {
  return decoder.decode(await getContract().evaluateTransaction(fn, ...args));
}

// Transaction : endorsement par Org1 et Org2, ordering, puis commit dans un bloc
async function submit(fn, ...args) {
  const commit = await getContract().submitAsync(fn, { arguments: args });
  const result = decoder.decode(commit.getResult());
  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(`Transaction ${status.transactionId} refusee (code ${status.code})`);
  }
  return { result, txId: status.transactionId, block: Number(status.blockNumber) };
}

// Le message d'erreur du chaincode est dans les details de l'erreur gRPC
function errorMessage(err) {
  const detail = (err.details || []).map((d) => d.message).find(Boolean);
  return (detail || err.message || String(err)).replace(/^.*?(chaincode response \d+, |message: )/s, '').trim();
}

function getIdentity() {
  getContract();
  return identity;
}

module.exports = { evaluate, submit, errorMessage, getIdentity };
