#!/usr/bin/env bash
# Every wallet a mainnet launch needs, made on THIS machine by the owner (secrets never printed, never in the repo):
#
#   deployer.json        pays the deploy (~29 SOL), holds every role until the handover
#   authority.json       the admin key the roles move to after the deploy (npm run handover): keep it offline; or pass
#                        AUTHORITY=<pubkey> to use a wallet you already hold (a hardware wallet is best)
#   treasury             receives forfeited listing bonds: TREASURY=<pubkey> of your own wallet, else treasury.json is made
#   program keypairs     veyl_pool / veyl_bin / veyl_entry IDs, relayer-keypair.json (its fee-paying hot wallet),
#   relayer, postman     postman-keypair.json (admits deposits): all from npm run keys:mainnet (also builds the programs)
#
#   bash scripts/setup-mainnet-wallets.sh                      # into ~/keys/veyl/mainnet
#   KEYS=<dir> AUTHORITY=<pubkey> TREASURY=<pubkey> bash scripts/setup-mainnet-wallets.sh
#
# Re-running reuses what exists (IDs never change). Committee node keys are made by each operator (committee/OPERATOR.md).
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS="${KEYS:-$HOME/keys/veyl/mainnet}"
case "$(cd "$(dirname "$KEYS")" 2>/dev/null && pwd)/" in "$(pwd)/"*) echo "KEYS must be outside the repo"; exit 1;; esac
command -v solana-keygen >/dev/null || { echo "Needs the Solana CLI (solana-keygen)"; exit 1; }
mkdir -p "$KEYS" && chmod 700 "$KEYS"

newkey() { # $1 file, $2 what it is: a fresh keypair with a seed phrase shown ONCE for the owner to write down
  if [ -f "$1" ]; then echo "  reusing $(basename "$1")"; return; fi
  echo; echo "== $2: write the seed phrase below on paper; it is the only backup =="
  solana-keygen new --no-bip39-passphrase -o "$1"
  chmod 600 "$1"; }
pub() { solana-keygen pubkey "$1"; }

newkey "$KEYS/deployer.json" "deployer (pays the deploy)"
if [ -z "${AUTHORITY:-}" ]; then newkey "$KEYS/authority.json" "admin authority (receives every role after the deploy; keep offline)"; AUTHORITY="$(pub "$KEYS/authority.json")"; fi
if [ -z "${TREASURY:-}" ]; then newkey "$KEYS/treasury.json" "treasury (forfeited bonds)"; TREASURY="$(pub "$KEYS/treasury.json")"; fi

echo; echo "== program IDs, relayer and postman keys (npm run keys:mainnet; builds the mainnet programs) =="
MAINNET_KEYPAIR_DIR="$KEYS" npm run -s keys:mainnet

# the treasury is public: into config/mainnet.json
node -e "const fs=require('fs');const f='config/mainnet.json';const c=JSON.parse(fs.readFileSync(f,'utf8'));c.treasury=process.argv[1];fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')" "$TREASURY"

cat <<EOF

================================================================ mainnet wallets
  deployer    $(pub "$KEYS/deployer.json")    fund ~29 SOL (dry-run prints the exact figure)
  authority   $AUTHORITY    fund ~0.05 SOL (accepts the roles at handover)
  treasury    $TREASURY    nothing to fund (written into config/mainnet.json)
  relayer     $(pub "$KEYS/relayer-keypair.json")    fund 1-2 SOL (pays private actions; refilled by its fees)
  postman     $(pub "$KEYS/postman-keypair.json")    fund 0.2 SOL (admits deposits)
  committee   3 node keys, one per operator (committee/OPERATOR.md)    ~0.3 SOL each

Secrets stay in $KEYS (mode 600). Back the folder up offline (encrypted USB), and keep the seed phrases on paper.
Hosting secrets (paste the file's contents, never commit them):
  relayer service:  RELAYER_SECRET_KEY = $KEYS/relayer-keypair.json   POSTMAN_SECRET_KEY = $KEYS/postman-keypair.json
Still to fill in config/mainnet.json: relayerUrl (your relayer's https address).
Then: DEPLOYER_KEYPAIR=$KEYS/deployer.json PROGRAM_KEYPAIR_DIR=$KEYS RPC_URL=<Helius mainnet> npm run preflight -- --network mainnet
      ... npm run deploy -- --network mainnet --dry-run
      after the deploy: npm run handover -- --network mainnet --to $AUTHORITY --postman <postman above> --confirm-mainnet
EOF
