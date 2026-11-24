#!/usr/bin/env bash
# scripts/start.sh : starts everything, skipping what is already running.
#   Hardhat node + contracts, Fabric test-network + chaincodes, TP1 :3000, TP2 :3001, monitor :3200
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ -f "$ROOT/apps/tp1-ethereum/.env" ] || die "Not configured yet: run scripts/setup.sh first."
ETH=$ROOT/ledgers/ethereum
ADDRESSES=$ETH/ignition/deployments/chain-31337/deployed_addresses.json

# ---------------------------------------------------------------- Ethereum
info "Ethereum: Hardhat node (:8545)"
if listening 8545; then
  ok "already running"
else
  rm -rf "$ETH/ignition/deployments/chain-31337"       # in-memory chain: the old deployment record is stale
  start_bg hardhat "$ETH" npx hardhat node --hostname 0.0.0.0
  wait_for "the Hardhat node" 60 listening 8545
  ok "started (log: .run/logs/hardhat.log)"
fi
if [ ! -s "$ADDRESSES" ] || ! grep -q HashSyncHTLC "$ADDRESSES"; then
  info "Ethereum: deploying MedicalRecord and HashSyncHTLC"
  (cd "$ETH" && npx hardhat ignition deploy ignition/modules/MedicalRecord.ts --network localhost >"$LOGS/deploy.log" 2>&1 \
    && npx hardhat ignition deploy ignition/modules/HashSyncHTLC.ts --network localhost --parameters ignition/parameters.json >>"$LOGS/deploy.log" 2>&1) \
    || die "deployment failed, see .run/logs/deploy.log"
  jq -r 'to_entries[] | "    \(.key | split("#")[1]): \(.value)"' "$ADDRESSES"
else
  ok "contracts already deployed on this chain"
fi

# ---------------------------------------------------------------- Fabric
info "Fabric: test-network ($NET)"
docker_ok || die "Docker is not reachable: start Docker (Desktop) first, then run this script again."
if docker inspect peer0.org1.example.com >/dev/null 2>&1; then
  docker start $FABRIC_CONTAINERS >/dev/null && ok "containers started (existing ledger kept)"
else
  (cd "$NET" && ./network.sh up createChannel -c "$CHANNEL" >"$LOGS/fabric-network.log" 2>&1) \
    || die "network.sh failed, see .run/logs/fabric-network.log"
  ok "network created, channel $CHANNEL"
fi
peer_env
wait_for "peer0.org1 to join $CHANNEL" 60 bash -c "peer channel list 2>/dev/null | grep -q $CHANNEL"

# The Fabric Gateway needs anchor peers to reach Org2's peer for endorsement
# (after a restart the orderer can take a few seconds more than the peers)
wait_for "the orderer" 60 peer channel fetch config "$RUN/channel-config.pb" -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com -c "$CHANNEL" --tls --cafile "$ORDERER_CA"
if configtxlator proto_decode --input "$RUN/channel-config.pb" --type common.Block 2>/dev/null \
    | jq -e '[.data.data[0].payload.data.config.channel_group.groups.Application.groups[].values.AnchorPeers] | all' >/dev/null; then
  ok "anchor peers set"
else
  for org in 1 2; do (cd "$NET" && . scripts/envVar.sh && . scripts/setAnchorPeer.sh $org "$CHANNEL") >>"$LOGS/fabric-network.log" 2>&1; done
  peer_env
  ok "anchor peers set for Org1 and Org2"
fi

for cc in documents hashsync-htlc; do
  if peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$cc" >/dev/null 2>&1; then
    ok "chaincode $cc already committed"
  else
    info "Fabric: deploying chaincode $cc (a few minutes the first time)"
    (cd "$NET" && ./network.sh deployCC -c "$CHANNEL" -ccn "$cc" -ccp "$ROOT/ledgers/fabric/$cc" -ccl javascript >"$LOGS/deploy-$cc.log" 2>&1) \
      || die "deployCC $cc failed, see .run/logs/deploy-$cc.log"
    peer_env
    ok "chaincode $cc committed"
  fi
done

# ---------------------------------------------------------------- apps + monitor
start_app() {   # start_app <name> <dir> <port>
  if listening "$3"; then ok "$1 already running on :$3"; return; fi
  start_bg "$1" "$2" node server.js
  wait_for "$1" 30 listening "$3"
  ok "$1 http://localhost:$3 (log: .run/logs/$1.log)"
}
info "Apps"
(cd "$ROOT/apps/tp1-ethereum" && node seed.js | sed 's/^/    tp1: /')
(cd "$ROOT/apps/tp2-fabric" && node seed.js | sed 's/^/    tp2: /')
start_app tp1 "$ROOT/apps/tp1-ethereum" 3000
start_app tp2 "$ROOT/apps/tp2-fabric" 3001
start_app monitor "$ROOT/monitor" 3200

cat <<EOF

  TP1 (Ethereum)  http://localhost:3000
  TP2 (Fabric)    http://localhost:3001
  Sync monitor    http://localhost:3200
  Test accounts (both apps): ali.medecin@test.com / Medecin123!   ahmed.patient@test.com / Patient123!
  Stop: npm stop   Status: npm run status   Logs: .run/logs/
EOF
