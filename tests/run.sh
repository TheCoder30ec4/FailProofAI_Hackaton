#!/bin/sh
# Offline checks of the finance agent's installed policies. Simulated sessions only:
# no agent runs, no Cloud sessions, nothing scored.
#   sh tests/run.sh          exact handbook rules (instant, stubbed failproofai)
#   sh tests/run.sh --jev    also the generic Jev guard against real Jev (~30 s)
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
POL="$REPO/agents/finance-agent/.failproofai/policies"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
# Policies import policykit four levels up, so mirror that layout in a temp dir.
mkdir -p "$T/node_modules/failproofai" "$T/a/b/c/d"
ln -s "$REPO/policykit" "$T/policykit"
cp "$POL"/*.mjs "$T/a/b/c/d/"
echo '{"name":"failproofai","type":"module","main":"index.mjs"}' > "$T/node_modules/failproofai/package.json"
cat > "$T/node_modules/failproofai/index.mjs" <<'STUB'
export const list=[]; export const customPolicies={add:(p)=>list.push(p)};
export const allow=()=>({d:"allow"}); export const deny=(r)=>({d:"deny",r});
STUB
cp "$REPO/tests/exact-rules.test.mjs" "$T/test.mjs"
echo "== exact handbook rules"
(cd "$T" && S="$T" WORLD="$REPO/agents/finance-agent/world.mjs" node test.mjs)
if [ "$1" = "--jev" ]; then
  echo "\n== generic Jev guard (live Jev)"
  GUARD="$T/a/b/c/d/jev-guard.mjs" node "$REPO/tests/jev-guard.test.mjs"
fi
