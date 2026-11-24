#!/usr/bin/env bash
# scripts/test.sh : unit tests of the contracts and the chaincodes (no running network needed).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
info "Ethereum contracts (Hardhat)"
(cd "$ROOT/ledgers/ethereum" && npx hardhat test mocha 2>&1 | grep -E "passing|failing|✔|[0-9]+\)")
# Chaincode tests run in a temporary copy, so no node_modules end up in the folders packaged by deployCC
for cc in documents hashsync-htlc; do
  info "Fabric chaincode $cc"
  tmp=$(mktemp -d)
  cp -r "$ROOT/ledgers/fabric/$cc/." "$tmp"
  (cd "$tmp" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm test 2>&1 | grep -E "passing|failing|Lines|[0-9]+\)")
  rm -rf "$tmp"
done
