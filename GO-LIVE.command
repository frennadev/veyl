#!/bin/bash
# Veyl on Solana in one click. Calls the one deploy entrypoint (scripts/deploy.js, see DEPLOY.md).
#   ./GO-LIVE.command              local validator + programs + relayer/publisher + site -> http://localhost:8873  (FUND=<your wallet> to get mock tokens)
#   NET=devnet ./GO-LIVE.command   same as ./VEYL-DEVNET.command (the devnet launcher)
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
# devnet has one launcher: prices, funding, deploy, seeding, relayer, site and public links (START-HERE-DEVNET.md)
exec ./VEYL-DEVNET.command
