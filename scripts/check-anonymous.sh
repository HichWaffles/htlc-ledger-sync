#!/usr/bin/env bash
# scripts/check-anonymous.sh : run before every push to the anonymous repository.
#   ANON_TERMS="first name,last name,username" scripts/check-anonymous.sh
# The terms are given on the command line only, so they are never written into the repository.
# Checks: commit authors/committers, tracked files that must stay local, absolute paths, and the given terms
# (whole words, in every tracked file and in the commit messages). Exit code 1 if anything is found.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
bad() { printf '\033[31m  %s\033[0m\n' "$*"; fail=1; }
good() { printf '\033[32m  %s\033[0m\n' "$*"; }

echo "Commit identities"
ids=$(git log --format='%an <%ae>%n%cn <%ce>' | sort -u)
if [ "$ids" = "anonymous <anonymous@users.noreply.github.com>" ]; then good "$ids"; else bad "unexpected identities:"; echo "$ids" | sed 's/^/    /'; fi
[ "$(git config user.name)" = anonymous ] || bad "git config user.name is '$(git config user.name)': run  git config user.name anonymous"

echo "Tracked files that must stay local"
local_files=$(git ls-files | grep -E '(^|/)\.env|\.sqlite|ignition/parameters\.json|node_modules/|(^|/)\.run/' || true)
[ -z "$local_files" ] && good "none" || { bad "tracked:"; echo "$local_files" | sed 's/^/    /'; }

echo "Absolute paths"
paths=$(git grep -nIE '/home/[a-z]|/Users/[A-Za-z]|[A-Z]:\\\\Users|\\\\wsl' -- . ':!scripts/check-anonymous.sh' || true)
[ -z "$paths" ] && good "none" || { bad "found:"; echo "$paths" | sed 's/^/    /'; }

echo "Identifying terms"
if [ -z "${ANON_TERMS:-}" ]; then
  echo '  skipped (optional: ANON_TERMS="word,word" lists words that must not appear)'
else
  IFS=',' read -ra terms <<<"$ANON_TERMS"
  for t in "${terms[@]}"; do
    t=$(echo "$t" | xargs); [ -z "$t" ] && continue
    hits=$( { git grep -nIiw -F -- "$t"; git log --format='%h %s%n%b' | grep -iw -F -- "$t"; } 2>/dev/null || true)
    [ -z "$hits" ] && good "'$t': not found" || { bad "'$t' found:"; echo "$hits" | head -5 | sed 's/^/    /'; }
  done
  echo "  (PDF and image contents are compressed and not searched: regenerate them from the checked sources)"
fi

[ "$fail" = 0 ] && echo "OK: nothing identifying found." || { echo "Fix the items above before pushing."; exit 1; }
