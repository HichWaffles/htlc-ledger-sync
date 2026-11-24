#!/usr/bin/env bash
# scripts/stop.sh : stops the apps, the monitor, the Hardhat node and the Fabric containers.
# The Fabric ledger is kept (scripts/reset.sh erases it); the Hardhat chain lives in memory and is lost.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
info "Stopping"
for p in monitor tp2 tp1 hardhat; do running "$p" && ok "$p"; stop_bg "$p"; done
if docker_ok; then
  docker stop $FABRIC_CONTAINERS >/dev/null 2>&1 && ok "Fabric containers (ledger kept)"
  docker ps -q --filter "name=dev-peer" | xargs -r docker stop >/dev/null && ok "chaincode containers"
fi
