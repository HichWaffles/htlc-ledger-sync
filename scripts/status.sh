#!/usr/bin/env bash
# scripts/status.sh : what is running.
. "$(dirname "$0")/lib.sh"
row() { printf '  %-28s %s\n' "$1" "$2"; }
port() { listening "$1" && echo up || echo down; }
row "Hardhat node      :8545" "$(port 8545)"
docker_ok || row "Docker" "not reachable"
for c in $FABRIC_CONTAINERS; do row "$c" "$(timeout 10 docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)"; done
row "TP1 (Ethereum)    :3000" "$(port 3000)"
row "TP2 (Fabric)      :3001" "$(port 3001)"
row "Sync monitor      :3200" "$(port 3200)"
