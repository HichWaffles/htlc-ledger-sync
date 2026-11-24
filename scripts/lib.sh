# scripts/lib.sh : shared helpers, sourced by the other scripts.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN=$ROOT/.run                      # pids, logs and local config (git-ignored)
LOGS=$RUN/logs
mkdir -p "$LOGS"
[ -f "$RUN/config.sh" ] && . "$RUN/config.sh"       # FABRIC_SAMPLES, written by setup.sh
FABRIC_SAMPLES=${FABRIC_SAMPLES:-$ROOT/.fabric/fabric-samples}
NET=$FABRIC_SAMPLES/test-network
CHANNEL=mychannel
FABRIC_CONTAINERS="orderer.example.com peer0.org1.example.com peer0.org2.example.com"

info() { printf '\033[36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Docker Desktop can hang instead of failing while it is (re)starting: never wait more than 20 s
docker_ok() { timeout 20 docker info >/dev/null 2>&1; }

listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }

wait_for() {   # wait_for <what> <seconds> <command...>
  local what=$1 secs=$2; shift 2
  for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  die "timeout waiting for $what (logs: $LOGS)"
}

# start_bg <name> <dir> <command...> : runs in its own session, pid in .run/<name>.pid, log in .run/logs/<name>.log
start_bg() {
  local name=$1 dir=$2; shift 2
  rm -f "$RUN/$name.pid"
  # Only the command goes to the background (not a subshell that would wait for it and keep our output open).
  # setsid may fork, so $! could be the wrong pid: the new session leader writes its own pid, then execs the command.
  ( cd "$dir" || exit 1
    setsid bash -c 'echo $$ >"$0"; exec "$@"' "$RUN/$name.pid" "$@" >"$LOGS/$name.log" 2>&1 </dev/null & ) >/dev/null 2>&1
  for _ in $(seq 1 25); do [ -s "$RUN/$name.pid" ] && break; sleep 0.2; done
}

# stop_bg <name> : stops the whole process group started by start_bg
stop_bg() {
  local pidfile=$RUN/$1.pid
  [ -f "$pidfile" ] || return 0
  local pid; pid=$(cat "$pidfile")
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  rm -f "$pidfile"
}

running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

# Fabric CLI as Org1 admin (same environment as test-network's own scripts)
peer_env() {
  export PATH=$FABRIC_SAMPLES/bin:$PATH FABRIC_CFG_PATH=$FABRIC_SAMPLES/config/ CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID=Org1MSP CORE_PEER_ADDRESS=localhost:7051
  export CORE_PEER_TLS_ROOTCERT_FILE=$NET/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=$NET/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
  export ORDERER_CA=$NET/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem
}
