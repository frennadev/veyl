#!/bin/bash
# Build the programs one at a time (a joint workspace build unifies the `no-entrypoint` feature and empties the dependency's .so).
# Regenerates the Groth16 verifying key constants first (withdraw: the unchanged snarkjs vkey; Phase 2: transact, position).
#   bash scripts/build.sh            devnet/local profile -> target/deploy/ (the repo's dev program IDs); veyl_bin with
#                                    --features devnet-migrate (the one-off devnet migration, scripts/migrate-devnet.js)
#   bash scripts/build.sh mainnet    mainnet profile (--features mainnet: the IDs `npm run keys:mainnet` wrote) -> target/deploy-mainnet/,
#                                    in its own cargo target dir so the two profiles never overwrite each other's outputs
set -e; cd "$(dirname "$0")/.."
export PATH="${SOLANA_BIN:-/opt/solana/bin}:$HOME/.cargo/bin:$PATH"
node scripts/vkey-to-rust.js --all
if [ "$1" = "mainnet" ]; then
  if grep -q 'declare_id!("11111111111111111111111111111111"); // mainnet' programs/*/src/lib.rs; then echo "mainnet IDs not set: run npm run keys:mainnet" >&2; exit 1; fi
  export CARGO_TARGET_DIR="$PWD/target/mainnet" # absolute: cargo-build-sbf runs cargo from each program directory
  # first build: start from the dev build's compiled dependencies (same versions and flags) instead of compiling them again
  if [ ! -d target/mainnet ] && [ -d target/sbpf-solana-solana ]; then mkdir -p target/mainnet && cp -a target/release target/sbpf-solana-solana target/mainnet/ 2>/dev/null || true; fi
  mkdir -p target/deploy-mainnet
  for p in veyl_pool veyl_bin veyl_entry; do cargo-build-sbf --manifest-path programs/$p/Cargo.toml --features mainnet --sbf-out-dir target/deploy-mainnet; done
  rm -f target/deploy-mainnet/*-keypair.json # cargo-build-sbf drops random keypairs next to the .so; the real ones live outside the repo
  # the devnet-only migration must never ship: its instructions log their names ("Instruction: MigrateFactory")
  if LC_ALL=C grep -q -a -E 'Instruction: Migrate(Factory|Pool)' target/deploy-mainnet/veyl_bin.so; then echo "mainnet veyl_bin contains the devnet-migrate instructions" >&2; exit 1; fi
  ls -la target/deploy-mainnet/*.so
else
  for p in veyl_pool veyl_bin veyl_entry; do f=""; if [ $p = veyl_bin ]; then f="--features devnet-migrate"; fi; cargo-build-sbf --manifest-path programs/$p/Cargo.toml $f; done
  ls -la target/deploy/*.so
fi
