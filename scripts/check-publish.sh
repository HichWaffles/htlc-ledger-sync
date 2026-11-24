#!/usr/bin/env bash
# scripts/check-publish.sh : run before every push (npm run check:publish).
# Checks: every commit has the repository's author identity with a GitHub noreply email (no personal email),
# no file that must stay local is tracked, no absolute path appears.
# Optional: ANON_TERMS="word,word" also searches for words that must not appear (whole words, files and messages).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
bad() { printf '\033[31m  %s\033[0m\n' "$*"; fail=1; }
good() { printf '\033[32m  %s\033[0m\n' "$*"; }

echo "Commit identities"
expected="$(git config user.name) <$(git config user.email)>"
ids=$(git log --format='%an <%ae>%n%cn <%ce>' | sort -u)
case "$expected" in *@users.noreply.github.com\>) ;; *) bad "git config user.email should be a GitHub noreply address, not a personal email";; esac
if [ "$ids" = "$expected" ]; then good "$ids"; else bad "commits by someone other than $expected:"; echo "$ids" | sed 's/^/    /'; fi

echo "Tracked files that must stay local"
local_files=$(git ls-files | grep -E '(^|/)\.env|\.sqlite|ignition/parameters\.json|node_modules/|(^|/)\.run/' || true)
[ -z "$local_files" ] && good "none" || { bad "tracked:"; echo "$local_files" | sed 's/^/    /'; }

echo "Absolute paths"
paths=$(git grep -nIE '/home/[a-z]|/Users/[A-Za-z]|[A-Z]:\\\\Users|\\\\wsl' -- . ':!scripts/check-publish.sh' || true)
[ -z "$paths" ] && good "none" || { bad "found:"; echo "$paths" | sed 's/^/    /'; }

if [ -n "${ANON_TERMS:-}" ]; then
  echo "Words that must not appear"
  IFS=',' read -ra terms <<<"$ANON_TERMS"
  for t in "${terms[@]}"; do
    t=$(echo "$t" | xargs); [ -z "$t" ] && continue
    hits=$( { git grep -nIiw -F -- "$t"; git log --format='%h %s%n%b' | grep -iw -F -- "$t"; } 2>/dev/null || true)
    [ -z "$hits" ] && good "'$t': not found" || { bad "'$t' found:"; echo "$hits" | head -5 | sed 's/^/    /'; }
  done
fi

[ "$fail" = 0 ] && echo "OK: ready to push." || { echo "Fix the items above before pushing."; exit 1; }
