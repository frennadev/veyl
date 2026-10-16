#!/bin/bash
# Veyl on Solana in one click. Calls the one deploy entrypoint (scripts/deploy.js, see DEPLOY.md).
#   ./GO-LIVE.command              local validator + programs + relayer/publisher + site -> http://localhost:8873  (FUND=<your wallet> to get mock tokens)
#   NET=devnet ./GO-LIVE.command   uses DEPLOYER_KEYPAIR (or makes a throwaway devnet key), waits for devnet SOL,
#                                  runs  npm run deploy -- --network devnet,  builds dist/site, starts the relayer + publisher + site
# Mainnet is never done from here: DEPLOY.md (your own keys, the real USDC / USDT mints, a multi-party key ceremony and an audit first).
# Needs Node 20+ and the Solana CLI (https://solana.com/docs/intro/installation). The programs ship prebuilt in target/deploy.
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" SOLANA_BIN="${SOLANA_BIN:-$(dirname "$(command -v solana 2>/dev/null || echo /opt/solana/bin/solana)")}"
command -v node >/dev/null || { echo "Install Node 20+ first: https://nodejs.org"; read -n1; exit 1; }
[ -x "$SOLANA_BIN/solana" ] || { echo "Install the Solana CLI first: https://solana.com/docs/intro/installation"; read -n1; exit 1; }
[ -f .env ] && set -a && source .env && set +a
[ -d node_modules ] || npm ci
npm run bundle
NET=${NET:-local}
if [ "$NET" = "local" ]; then exec node scripts/demo.js; fi
[ "$NET" = "devnet" ] || { echo "NET must be local or devnet here; mainnet is DEPLOY.md, by hand"; exit 1; }
# throwaway devnet deployer (+ authority + relayer + postman), kept outside the repo; never reuse it on mainnet
KEY=${DEPLOYER_KEYPAIR:-$HOME/.config/veyl-sol/devnet-deployer.json}; [ -f .devnet-key.json ] && [ -z "$DEPLOYER_KEYPAIR" ] && KEY=.devnet-key.json
mkdir -p "$(dirname "$KEY")"; [ -f "$KEY" ] || "$SOLANA_BIN/solana-keygen" new --no-bip39-passphrase -s -o "$KEY" >/dev/null; chmod 600 "$KEY"
export DEPLOYER_KEYPAIR=$KEY; ADDR=$("$SOLANA_BIN/solana-keygen" pubkey "$KEY"); RPC_URL=${RPC_URL:-https://api.devnet.solana.com}; export RPC_URL
export RELAYER_URL=${RELAYER_URL:-http://127.0.0.1:8843}
echo "Deployer: $ADDR"
npm run deploy -- --network devnet --dry-run | grep -E "NEEDED|SPENT"
echo "Devnet SOL: https://faucet.solana.com (or: solana airdrop 5 $ADDR -u devnet, a few times). Waiting for ~14 SOL..."
until [ "$("$SOLANA_BIN/solana" balance "$ADDR" -u "$RPC_URL" 2>/dev/null | cut -d. -f1)" -ge 14 ] 2>/dev/null; do sleep 8; done
echo "Funded. Deploying."
npm run deploy -- --network devnet || exit 1
npm run build:site -- --network devnet || exit 1
node scripts/serve-dist.js 8873 & WEB=$!
echo; echo "Veyl on devnet: http://localhost:8873  (switch your wallet to devnet)"; echo
trap "kill $WEB" EXIT
NETWORK=devnet PORT=8843 RELAYER_KEY=$KEY POSTMAN_KEY=$KEY node relayer/relayer.js
