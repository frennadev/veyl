#!/usr/bin/env bash
# Run the devnet stack on this machine for testing: the relayer (with the approved-set publisher and the test-token faucet)
# on :8843, optionally the 3 sealed-batch committee nodes on :8863-8865, and the site on :8895, built against the devnet
# deployment (deploy.devnet.json) and this relayer. Nothing is public; Ctrl-C stops everything.
#
#   RPC_URL=<dedicated devnet RPC> scripts/devnet-local.sh              # relayer + site
#   RPC_URL=<dedicated devnet RPC> COMMITTEE=1 scripts/devnet-local.sh  # + committee nodes (sealed swaps)
#
# Keys: ~/keys/veyl/devnet-{relayer,postman,deployer}.json and ~/keys/veyl/committee-devnet/ (KEYS=<dir> to change).
# The public devnet RPC (the default) rate-limits one machine running all of this; use a dedicated one (Helius etc.).
# The RPC URL goes into dist/site/veyl.config.js (build output, not committed) and the relayer's environment, nowhere else.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS="${KEYS:-$HOME/keys/veyl}"; RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
SITE_PORT="${SITE_PORT:-8895}"; RELAYER_PORT="${RELAYER_PORT:-8843}"
for k in relayer postman deployer; do [ -f "$KEYS/devnet-$k.json" ] || { echo "Missing $KEYS/devnet-$k.json"; exit 1; }; done
[[ "$RPC_URL" == *api.devnet.solana.com* ]] && echo "Note: the public devnet RPC rate-limits this setup. Set RPC_URL to a dedicated devnet RPC."

pids=(); cleanup() { kill "${pids[@]}" 2>/dev/null || true; }; trap cleanup EXIT INT TERM

RELAYER_URL="http://127.0.0.1:$RELAYER_PORT" SITE_RPC_URL="$RPC_URL" npm run -s build:site -- --network devnet

NETWORK=devnet PORT=$RELAYER_PORT RPC_URL="$RPC_URL" ALLOWED_ORIGINS="http://localhost:$SITE_PORT,http://127.0.0.1:$SITE_PORT" \
  RELAYER_KEY="$KEYS/devnet-relayer.json" POSTMAN_KEY="$KEYS/devnet-postman.json" FAUCET_KEY="$KEYS/devnet-deployer.json" \
  node relayer/relayer.js 2>&1 | sed -u 's/^/[relayer] /' & pids+=($!)

if [ "${COMMITTEE:-0}" = "1" ]; then
  C="$KEYS/committee-devnet"
  for i in 1 2 3; do
    NETWORK=devnet RPC_URL="$RPC_URL" PORT=$((8862 + i)) COMMITTEE_CONFIG="$C/config-$i.json" NODE_KEY="$C/node-$i.json" STATE_DIR="$C/state-$i" \
      node committee/node.js 2>&1 | sed -u "s/^/[node-$i] /" & pids+=($!)
    sleep 3   # staggered: each node reads the chain as it starts
  done
fi

node scripts/serve-dist.js "$SITE_PORT" & pids+=($!)
echo
echo "  App:           http://localhost:$SITE_PORT/app.html?mode=devnet"
echo "  Relayer:       http://127.0.0.1:$RELAYER_PORT/health"
echo
wait
