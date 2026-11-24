#!/usr/bin/env bash
# scripts/setup.sh : one-time setup (safe to re-run).
#   1. checks the prerequisites   2. gets Hyperledger Fabric (binaries, images, test-network) if missing
#   3. installs the npm packages  4. compiles the contracts  5. writes the local configuration (.env files)
# Use an existing fabric-samples checkout with:  FABRIC_SAMPLES=/path/to/fabric-samples scripts/setup.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"
FABRIC_VERSION=2.5.16
CA_VERSION=1.5.15

info "Prerequisites"
missing=0
need() { command -v "$1" >/dev/null 2>&1 && ok "$1: $($1 --version 2>&1 | head -1)" || { warn "$1 missing: $2"; missing=1; }; }
need node "install Node.js 20 or 22 (https://nodejs.org or nvm)"
need npm  "comes with Node.js"
need git  "sudo apt install git"
need curl "sudo apt install curl"
need jq   "sudo apt install jq (used by the Fabric scripts)"
need docker "install Docker (on Windows: Docker Desktop with WSL integration for this distro)"
[ "$missing" = 0 ] || die "Install the missing tools, then run this script again."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node.js 20 or newer is required."
docker_ok || die "Docker is installed but not reachable: start Docker (Desktop) first."

info "Hyperledger Fabric $FABRIC_VERSION ($FABRIC_SAMPLES)"
if [ -x "$FABRIC_SAMPLES/bin/peer" ] && [ -d "$NET" ]; then
  ok "already installed"
else
  mkdir -p "$(dirname "$FABRIC_SAMPLES")"
  cd "$(dirname "$FABRIC_SAMPLES")"
  curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
  chmod +x install-fabric.sh
  ./install-fabric.sh --fabric-version "$FABRIC_VERSION" --ca-version "$CA_VERSION" docker samples binary
  [ -x "$FABRIC_SAMPLES/bin/peer" ] || die "Fabric install failed: $FABRIC_SAMPLES/bin/peer not found"
  cd "$ROOT"
fi
echo "FABRIC_SAMPLES=$FABRIC_SAMPLES" >"$RUN/config.sh"

info "npm packages (apps, sync engine, monitor)"
(cd "$ROOT" && npm install --no-audit --no-fund)
info "npm packages (Ethereum contracts)"
(cd "$ROOT/ledgers/ethereum" && npm install --no-audit --no-fund)

info "Compiling the contracts"
(cd "$ROOT/ledgers/ethereum" && npx hardhat build >/dev/null) && ok "MedicalRecord, HashSyncHTLC"

info "Local configuration"
(cd "$ROOT" && FABRIC_SAMPLES=$FABRIC_SAMPLES node scripts/configure.js)

info "Done. Next: npm start   (or scripts/start.sh)"
