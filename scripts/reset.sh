#!/usr/bin/env bash
# scripts/reset.sh : back to a clean state. ERASES the Fabric ledger (network.sh down), both app databases and
# the Ethereum deployment record. Keeps the configuration (.env files, TP1's operator key).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
if [ "${1:-}" != "--yes" ]; then
  read -r -p "This erases the Fabric ledger and both app databases. Type 'reset' to continue: " answer
  [ "$answer" = reset ] || die "Cancelled."
fi
bash "$ROOT/scripts/stop.sh"
info "Removing the Fabric network"
(cd "$NET" && ./network.sh down >"$LOGS/fabric-down.log" 2>&1) && ok "network.sh down"
info "Removing local state"
rm -f "$ROOT"/apps/*/database.sqlite*
rm -rf "$ROOT/ledgers/ethereum/ignition/deployments"
ok "app databases and Ethereum deployment record removed"
