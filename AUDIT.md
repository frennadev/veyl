# Veyl: audit scope (for quotes)

Veyl is private concentrated liquidity on Solana: DLMM-style bin pools (Meteora-like) where positions, swaps and fees can't be
linked to a wallet. Users hold Poseidon note commitments in one shared Merkle tree and act through Groth16 proofs; a relayer
submits private actions so the user's wallet never signs them. Sealed batch swaps encrypt amounts to a 2-of-3 committee
(exponent ElGamal on Baby Jubjub) that decrypts only batch totals.

Status: code complete, live on Solana devnet, never audited. We want one audit covering programs and circuits together (the
safety of each depends on the other), with the off-chain components that hold keys or move funds as a secondary scope.

## In scope

| part | where | size | notes |
|---|---|---|---|
| `veyl_pool`: shielded tree, Groth16 verification, nullifiers, deposits/withdrawals | `programs/veyl_pool/src/` | ~1,600 lines Rust | anchor-lang 0.31.1, groth16-solana 0.2.0, event-cpi |
| `veyl_bin`: bin pools, swaps, fees, positions, limit orders, rewards, permissionless listing (fee tiers, bond) | `programs/veyl_bin/src/` | ~1,360 lines | the `devnet-migrate` feature is devnet-only and out of scope |
| `veyl_entry`: private actions, shielded aggregate position, sealed batches, committee share checks (Baby Jubjub in software) | `programs/veyl_entry/src/` | ~2,600 lines | |
| Circuits: `transact`, `position`, `swap`, `claim`, `withdraw` | `zk/circuits/` | ~890 lines circom | circom 2.2.3, circomlib 2.0.5; 9.9k to 23.4k constraints each |
| Program ↔ circuit binding: public-input order, field encoding, hash-to-field, verifying keys baked into `veyl_pool` | `sdk/veyl.js`, `scripts/vkey-to-rust`, `zk/` | | |

Total on-chain + circuits: about 5,600 lines of Rust and 900 lines of circom.

## Secondary scope (off-chain, holds keys or decides what's admitted)

| part | where | size |
|---|---|---|
| Relayer: fee pricing, signing private actions, deposit admission (postman), denylist screening | `relayer/` | |
| Batch committee: dealerless DKG, partial decryption with Chaum–Pedersen proofs, settlement | `committee/` | ~290 lines JS |
| Client note handling: key derivation, note encryption, backup format | `engine/`, `sdk/` | |

The relayer, engine and SDK together are about 5,900 lines of JS.

## Out of scope
The web app (`web/`, `site/`), deploy and ops scripts, the devnet migration, and the trusted-setup ceremony tooling (`ceremony/`).
The ceremony itself will be run before mainnet. Reviewing the tooling is welcome as an optional add-on.

## What we most want checked
1. **Soundness.** No proof, account substitution or replay can create value, spend a note twice, or move a position or fee
   that isn't the prover's. Circuit constraints should match what the programs assume.
2. **Privacy leaks.** Anything on chain, in the relayer or in timing that links a wallet to a note, position, swap or fee.
   PRIVACY.md states what we claim is hidden.
3. **DLMM maths.** Bin swaps, the fee split (0.2% protocol fee on top of tier LP fees), limit orders, rebalance/zap, rounding.
   REVIEW.md lists our self-review's "Where an external auditor should focus".
4. **Permissionless listing.** Pool creation by anyone, the Token-2022 allowlist, the bond, delisting.
5. **Sealed batches.** ElGamal aggregation, the on-chain share verification, total recovery bounds, the claim and refund paths.
6. **Liveness and griefing.** Tree and root-history flooding, log truncation (events now go through event-cpi), relayer drain.

## Materials
- README.md (architecture), PRIVACY.md (privacy claims), REVIEW.md (internal security review, findings and fixes), DEPLOY.md
  ("Before mainnet").
- Build: Solana CLI 3.1.10, `bash scripts/build.sh`. Hashes of the reproducible builds are in `config/program-hashes.json`.
- Tests: `npm test` (~310 checks, local validator), `node e2e/run.js` (browser end to end), `node e2e/devnet.js` (live devnet).
- Devnet program IDs: `veyl_pool` BudA5kQySdfhfocWhPiDUP888tuoqL9aRxNiq9Qon73V, `veyl_bin`
  6yKrpy8JDoxFfbWdCKUre7Q7PVdvLzmzdSYWa86X4YLk, `veyl_entry` 4q6p4io7m3pgxpMqRDSKBRsAb6gCBGCKvTRabZtp1QHn.

## What we'd like in a quote
The cost and duration for the main scope, and separately for the secondary scope. Also: whether a fix review is included, the
earliest start date, and who covers the circuits (ZK reviewers) versus the Solana programs.
