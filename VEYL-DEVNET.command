#!/bin/bash
# Veyl on Solana devnet, run from this Mac and shared with testers over two free Cloudflare links (no account needed).
# Double-click it (or: bash VEYL-DEVNET.command). Safe to re-run: the deploy skips what already exists.
#
# What it does, in order:
#   1. checks / installs the tools: Node (you install it), Solana CLI and cloudflared (installed here if missing)
#   2. makes a throwaway DEVNET deployer key outside this folder (~/.config/veyl-sol/devnet-deployer.json). Never use it on mainnet.
#   3. prices every token from Meteora's live pools, so each pool opens at today's price (a pair it can't price is skipped)
#   4. waits until that key holds enough devnet SOL (free: https://faucet.solana.com)
#   5. deploys the programs and every pool (83: the built-in 12 + every major Meteora pair), then seeds each with starting liquidity
#   6. opens two public https links (site + relayer), builds the site for them, and runs the relayer with a test-token faucet
# Keep this window open and the Mac awake while people test. Closing it takes the site offline.
cd "$(dirname "$0")" || exit 1
set -o pipefail
G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; N=$'\033[0m'
step(){ printf "\n${G}==> %s${N}\n" "$1"; }
die(){ printf "\n${R}%s${N}\n" "$1"; read -r -n1 -p "Press any key to close."; exit 1; }
mkdir -p .devnet-run; LOG="$PWD/.devnet-run"

step "1/6  Tools"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PWD/.devnet-run/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null || die "Install Node 20 or newer first (https://nodejs.org, the LTS button), then run this again."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node $(node -v) is too old: install Node 20 or newer from https://nodejs.org"
if ! command -v solana >/dev/null; then
  echo "Installing the Solana CLI (Agave 3.1.9)…"
  if ! { INST=$(curl -sSfL https://release.anza.xyz/v3.1.9/install) && sh -c "$INST"; }; then
    # release.anza.xyz unreachable (e.g. a locked-down network): the same release from GitHub
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64) T=x86_64-unknown-linux-gnu;; Darwin-arm64) T=aarch64-apple-darwin;; Darwin-x86_64) T=x86_64-apple-darwin;;
      *) die "Could not install the Solana CLI.";;
    esac
    mkdir -p .devnet-run && curl -sSfL "https://github.com/anza-xyz/agave/releases/download/v3.1.9/solana-release-$T.tar.bz2" | tar -xj -C .devnet-run || die "Could not install the Solana CLI."
    export PATH="$PWD/.devnet-run/solana-release/bin:$PATH"
  fi
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi
if ! command -v cloudflared >/dev/null; then
  echo "Installing cloudflared (for the public links)…"; mkdir -p .devnet-run/bin
  if command -v brew >/dev/null; then brew install cloudflared || true; fi
  if ! command -v cloudflared >/dev/null; then
    ARCH=$(uname -m); U="https://github.com/cloudflare/cloudflared/releases/latest/download"
    if [ "$(uname -s)" = "Linux" ]; then
      case "$ARCH" in aarch64|arm64) F=cloudflared-linux-arm64;; *) F=cloudflared-linux-amd64;; esac
      curl -sSfL -o .devnet-run/bin/cloudflared "$U/$F" || die "Could not download cloudflared."
    else
      [ "$ARCH" = "arm64" ] && F=cloudflared-darwin-arm64.tgz || F=cloudflared-darwin-amd64.tgz
      curl -sSfL "$U/$F" | tar -xz -C .devnet-run/bin || die "Could not download cloudflared."
    fi
    chmod +x .devnet-run/bin/cloudflared
  fi
fi
echo "node $(node -v) · $(solana --version | head -1) · cloudflared ok"
[ -d node_modules ] || { echo "Installing packages (one time)…"; npm ci --no-audit --no-fund || die "npm ci failed."; }
export SOLANA_BIN="$(dirname "$(command -v solana)")"

step "2/6  Devnet deployer key"
KEY="${DEPLOYER_KEYPAIR:-$HOME/.config/veyl-sol/devnet-deployer.json}"; mkdir -p "$(dirname "$KEY")"
[ -f "$KEY" ] || solana-keygen new --no-bip39-passphrase -s -o "$KEY" >/dev/null || die "Could not make a key."
chmod 600 "$KEY"; export DEPLOYER_KEYPAIR="$KEY"; ADDR=$(solana-keygen pubkey "$KEY")
export RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
echo "Deployer (devnet only): $ADDR"

step "3/6  Pools and today's prices"
# all 83 pools (the 12 built in + every major Meteora pair) by default; CORE_ONLY=1 ./VEYL-DEVNET.command keeps the 12 (cheaper)
if [ ! -f deploy.devnet.json ]; then
  if [ "${CORE_ONLY:-0}" = "1" ]; then node -e 'const fs=require("fs"),L=require("./scripts/lib.js"),p="config/devnet.json",c=JSON.parse(fs.readFileSync(p));c.tokens=c.tokens.filter(t=>L.BUILTIN_TOKENS.includes(t));c.binPools=c.binPools.filter(b=>L.BUILTIN_POOLS.includes(b));fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")'; fi
  node scripts/price-catalog.js --network devnet || echo "${Y}Could not fetch live prices: only the built-in pools open.${N}"
else echo "Already deployed: pools keep their opening prices."; fi
POOLS=$(node -p 'require("./config/devnet.json").binPools.length'); echo "Pools listed: $POOLS"

step "4/6  Devnet SOL"
NEED=$(npm run -s deploy -- --network devnet --dry-run 2>/dev/null | grep -Eo 'NEEDED[^0-9]*[0-9]+(\.[0-9]+)?' | grep -Eo '[0-9]+(\.[0-9]+)?$' | head -1)
NEED=${NEED:-40}; NEED=$(node -p "Math.ceil($NEED + 0.25 * $POOLS + 2)")   # + seeding (~0.25 SOL a pool, measured) + ~2 SOL for the test-token faucet
bal(){ solana balance "$ADDR" -u "$RPC_URL" 2>/dev/null | awk '{print int($1)}'; }
if [ "$(bal)" -lt "$NEED" ] && [ ! -f deploy.devnet.json ]; then
  echo "This needs about ${Y}$NEED devnet SOL${N} (free test SOL, worth nothing). Send it to:"
  echo; echo "    ${Y}$ADDR${N}"; echo
  echo "  - https://faucet.solana.com  (sign in with GitHub for more per request; repeat until it's enough)"
  echo "  - or from any devnet wallet. Limits change; it can take a few rounds."
  echo "Trying a free airdrop too…"; solana airdrop 2 "$ADDR" -u "$RPC_URL" >/dev/null 2>&1 || true
  printf "Waiting"; until [ "$(bal)" -ge "$NEED" ]; do printf " %s" "$(bal)"; sleep 15; done; echo " ✓"
fi
echo "Balance: $(solana balance "$ADDR" -u "$RPC_URL")"

step "5/6  Deploy and seed (re-runs skip what exists)"
npm run -s deploy -- --network devnet || die "Deploy stopped. Top up the deployer with devnet SOL and run this again: it picks up where it left off."
if [ ! -f .devnet-run/seeded ]; then npm run -s seed -- --network devnet --trades 2 --span 10 --usd 5000 && touch .devnet-run/seeded || echo "${Y}Seeding stopped (out of devnet SOL?). Top up and run this again: pools already seeded are skipped.${N}"; fi

step "6/6  Public links, site and relayer"
pkill -f "cloudflared tunnel --url http://localhost:887" 2>/dev/null; sleep 1
tunnel(){ cloudflared tunnel --no-autoupdate --url "http://localhost:$1" >"$LOG/tunnel-$1.log" 2>&1 & echo $! > "$LOG/tunnel-$1.pid"
  for i in $(seq 1 60); do U=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG/tunnel-$1.log" | head -1); [ -n "$U" ] && { echo "$U"; return 0; }; sleep 1; done; return 1; }
RELAY_URL=$(tunnel 8843) || die "Could not open the relayer link (cloudflared). Check the internet connection and run again."
SITE_URL=$(tunnel 8873) || die "Could not open the site link (cloudflared)."
RELAYER_URL="$RELAY_URL" npm run -s build:site -- --network devnet || die "Site build failed."
node scripts/serve-dist.js 8873 >"$LOG/site.log" 2>&1 & WEB=$!
cleanup(){ kill $WEB 2>/dev/null; kill "$(cat "$LOG/tunnel-8843.pid")" "$(cat "$LOG/tunnel-8873.pid")" 2>/dev/null; }
trap cleanup EXIT
caffeinate -dimsu -w $$ >/dev/null 2>&1 &
echo
echo "  ${G}Veyl is live on Solana devnet${N}"
echo "  Share this link:  ${Y}$SITE_URL${N}"
echo "  Testers press Get started, then 'Get test tokens'. Wallets need to be switched to devnet."
echo "  The link changes each time you run this. Keep this window open."
echo
NETWORK=devnet PORT=8843 RPC_URL="$RPC_URL" ALLOWED_ORIGINS="$SITE_URL" TRUST_PROXY=1 RELAYER_KEY="$KEY" POSTMAN_KEY="$KEY" FAUCET_KEY="$KEY" node relayer/relayer.js
