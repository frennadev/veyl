# Veyl on Solana

> New here? Start with **HANDOFF.md** (state, setup, the ordered task list), then CLAUDE.md.

Private liquidity on Solana. Concentrated (DLMM-style) pools where nobody can link a position, a swap or the fees it earns back to your wallet. **Phase 3** adds sealed batch swaps: each swap's size is encrypted to a 2-of-3 committee key inside its proof, swaps are batched per pool and epoch, only each direction's total is decrypted, and the batch clears with one net swap (two new circuits, `swap` and `claim`; `committee/`). **Phase 2** hides balances, transfers and liquidity position sizes in one shielded pool (two new circuits, `transact` and `position`); entry and exit amounts, every amount at a pool, bin reserves and prices stay public (PRIVACY.md). Phase 1 adds Meteora-grade LP mechanics with that ownership model intact: bin bitmaps (swaps skip empty ranges), claimable per-position fees and a protocol share, limit orders, one-instruction rebalancing, zaps and farm rewards, each with a private variant (one-time keys, proofs, the relayer). Port of the EVM project (`veyl3/`, Robinhood Chain) to three Anchor programs, with the original withdraw circuit and its keys **unchanged** (Phases 2 and 3 added the other four circuits).

**Status: testnet / devnet only.** Not audited. The five proving keys (withdraw, transact, position, swap, claim) were generated on a single machine, and the local batch committee runs on one machine; a proper multi-party key ceremony (public Powers of Tau + a phase-2 ceremony with independent contributors) is required before mainnet. The ceremony kit covers all five circuits and is rehearsed (`ceremony/`), the ceremony itself has not happened. An internal security review (`REVIEW.md`) found and fixed 1 High and 6 Medium issues; it is not an external audit. Nothing here should hold real money.

```
veyl/
  programs/veyl_pool/   the shielded pool (one tree, every token: post_proof, shield_deposit/approve/cancel, shield_transact, entry-only CPIs)
                        + the Phase 1 per-mint pools: Poseidon note tree, Groth16 verify (groth16-solana, 3 vkeys), nullifier PDAs, ASP roots, ragequit
  programs/veyl_bin/    bin pools + factory: 128.128 price maths, volatility fee, bitmaps, mint/burn/swap/quote, fee growth + claims,
                        protocol fee, limit orders, rebalance, zap (swap_and_add), farm rewards
  programs/veyl_entry/  shield_lp (add/claim/remove/rebalance/zap) / shield_swap / shield_order(_withdraw) / shield_migrate, the shielded aggregate;
                        relay / private_swap / private_add / private_remove + private_claim_fees / private_claim_reward /
                        private_place_order / private_withdraw_order / private_rebalance / private_zap + the public router
  zk/                   transact.circom (2-in/2-out notes), position.circom (shielded positions), swap.circom + claim.circom (sealed batches),
                        + withdraw.circom byte-identical to the EVM build; dev keys for all five in zk/keys/ (single machine)
  sdk/veyl.js           plain @solana/web3.js client: encoders, PDAs, decoders, events, exact JS twin of the bin maths, Merkle helpers
  sdk/shield.js         Phase 2: keys, Veyl addresses, note encryption, tree, witness builders, ShieldWallet (scan, balances, coin selection)
  sdk/prover.js         snarkjs proving in Node (tests)
  sdk/sealed.js, bjj.js Phase 3: batch keys, swap/claim witnesses, PDAs + instructions, decoders; Baby Jubjub ElGamal, DKG, DLEQ, BSGS
  committee/            the batch committee: dealerless DKG (dkg.js), the member node (node.js: /health, shares, settlement), Dockerfile
  relayer/              relayer + approved-set publisher (the "postman"), HTTP on 8843: relayer.js composes fees, notes (Phase 1),
                        shielded (Phase 2/3), sealed, postman, faucet; http.js serves it
  engine/               the browser engine: sol-entry.js + shield-engine.js + sealed-engine.js, the Sandbox (sandbox-*.js), market data
                        (market.js, markets.js); npm run bundle -> site/veyl-sol.js
  web/                  the pages as a Next.js project (static export: index.html, docs.html, app.html); web/README.md
  site/                 the scripts and assets the pages load: app.js, home.js, app.css, veyl.css, the bundle (site/*.html superseded);
                        prove-worker.js proves in a Web Worker
  tests/harness.js      shared by the runners: check/refused/compute units, a fresh validator; tests/phase-only.js <2|3> runs one phase
  tests/run.js          298 tests on a local validator (RPC 8933), real proofs verified on-chain, a regression test per review finding;
  tests/phase1.js       its Phase 1 part: bitmaps, fee conservation, limit orders, rebalance, zap, rewards, private variants
  tests/phase2.js       its Phase 2 part (56): shielded pool, refusals, inflation/conservation properties, shielded liquidity (npm run test:phase2 alone)
  tests/phase3.js       its Phase 3 part: sealed batches, committee, refusals, conservation, refunds, k-floor, node-driven settlement
  e2e/run.js            Playwright: dist/site under the production CSP, a mock Phantom wallet, proofs made in a Web Worker (67 checks)
  ceremony/             the multi-party trusted-setup kit for all five circuits: init / contribute (one command) / verify / beacon / finalize, rehearsal
  scripts/              build.sh (+ mainnet profile), vkey-to-rust.js, lib.js, deploy.js, preflight.js, keys-mainnet.js, handover.js, roles.js, build-site.js, ...
  config/               local / devnet / mainnet settings (mainnet values marked VERIFY), blockers.json, SETUP hashes in zk/keys/
  REVIEW.md             internal security review: findings, exploit sketches, fixes, tests     PRIVACY.md  what is hidden, what is not
```

## Run it

Node 20+, the Solana CLI (`/opt/solana/bin` or `~/.local/share/solana/install/active_release/bin`), Rust + `cargo-build-sbf` only if you rebuild the programs (they ship prebuilt in `target/deploy/`).

```bash
npm install
npm run build        # regenerates programs/veyl_pool/src/vkey*.rs from zk/keys/*_vkey.json, then builds the three programs
npm test             # local validator on 8933 → deploy → 298 tests (about nineteen minutes: Phase 3 waits out batch epochs and settlement windows; real Groth16 proofs are made in Node)
npm run e2e          # local validator + relayer + the real app in Chromium with a mock wallet (67 checks; about 17 minutes)
npm run e2e:smoke    # the production build, every page and view on a desktop and a phone, every control clicked, zero console errors; a 4x slower CPU, a slow network, a reload mid-proof, two tabs, localStorage blocked (about 3 minutes)
npm run ceremony:rehearse -- --ptau <prepared ptau>   # the whole key ceremony (5 circuits) on one machine, then on-chain transact proofs and a full sealed batch with its keys
./GO-LIVE.command    # everything local; FUND=<your wallet> gives it mock tokens; site on http://localhost:8873
./VEYL-DEVNET.command          # devnet: throwaway deployer key, faucet SOL, deploy + seed, relayer + site + public links (START-HERE-DEVNET.md)
```

Ports: validator RPC **8933** (websocket 8934, gossip 11933), relayer **8843**, site **8873**, local committee nodes **8863-8865**. The brief assigned RPC 8913, but a test validator always takes rpc+1 for pubsub and 8914 is a sibling project's RPC port, so the two could not run side by side; `RPC_PORT=8913 npm test` still works when nothing is on 8914.

Deploying (devnet, and mainnet once the ceremony and an audit are done): **DEPLOY.md**. One entrypoint, `npm run deploy -- --network <local|devnet|mainnet>`, with `npm run preflight` and `npm run build:site`. Keys are read from paths you give in env and never printed; mainnet needs `--confirm-mainnet`, a typed confirmation and a green preflight, fresh program IDs (`npm run keys:mainnet`, a separate `--features mainnet` build profile; devnet IDs unchanged) and, after the deploy, `npm run handover` to move every role to a multisig.

## What is unchanged, what is ported

| | |
|---|---|
| Circuit, zkey, vkey, wasm | Identical files (`zk/`). `scripts/vkey-to-rust.js` re-encodes the same BN254 points for `groth16-solana` (G1 = x‖y, G2 = x.c1‖x.c0‖y.c1‖y.c0, big-endian); the output `vkey.rs` is committed. |
| Poseidon | `sol_poseidon` syscall (`solana-poseidon`, circomlib parameters). Tests check it against `poseidon-lite` in JS: the empty-tree root, a deposit commitment and a 32-level Merkle root all match. |
| Proof verification | `groth16-solana` 0.2 over the alt_bn128 syscalls: ~124k compute units, in a dedicated `post_withdrawal` instruction. A's y is negated on-chain so clients send the proof in the EVM verifier's layout. |
| Public inputs | Exactly the circuit's: `[newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, aspRoot, context]`, 32-byte big-endian each. |
| Bin maths | Same formulas and rounding. The 128.128 price stays 256-bit; `mulDiv` uses a 512-bit intermediate (`uint` crate), so results are bit-identical to OpenZeppelin's `Math.mulDiv`. Token amounts are u64 (SPL), shares u128; `variableFeeControl` is a u64 (the fee formula overflows u128 only above 2^72, far beyond any sane value). `sdk/veyl.js` carries the same maths in BigInt and the tests compare an on-chain `quote` (via `simulateTransaction`) with the JS twin and with the executed swap. |

## EVM → Solana mapping

| EVM | Solana | Notes |
|---|---|---|
| `VeylPrivacyPool` (one contract per token) | `veyl_pool` program, `Pool` PDA `["pool", mint]` (zero-copy, 9 KB) | tree zeros, filled subtrees, a 192-slot root ring (one entry per slot) and 16-root ASP ring live in the account; only the program's upgrade authority creates a pool |
| `deposit` / `depositFor` | `deposit(amount, precommitment, beneficiary)` | `payer` owns the tokens, `rent_payer` pays the `DepositRecord` PDA `["dep", pool, label]`; label = sha256(pool, nonce) masked to 253 bits instead of keccak mod p |
| `withdraw(w, proof)` (one call) | `post_withdrawal(proof, pubs, processor, ttl)` then `withdraw(data)` | Solana's 1232-byte transaction limit: the proof is verified and parked in the nullifier PDA `["null", pool, nullifierHash]`, the entry program executes it by CPI (the relayer does both in one transaction for a relay). A parked post is not a lock: a newer valid proof replaces it (refunding its poster), `ragequit` overrides it, `cancel_post` frees it (poster any time, anyone after `ttl` ≤ 9000 slots) |
| `context = keccak(w, chainid, pool) % p` | `sha256("veyl-context", processor, tag‖borsh(data), pool)` masked to 253 bits | same binding: action tag, recipient, fee, route, deadline, processor, pool |
| `spent[nullifierHash]` | the `Spend` PDA's existence; status Posted/Spent | ragequit creates the same PDA |
| `ragequit` | `ragequit(value, label, nullifier, secret)` | closes the deposit record (rent back) |
| `updateAspRoot` / `resetAspRoots` / `setPostman` / Ownable2Step | same names, snake_case; `propose_authority` / `accept_authority` | |
| `VeylFactory.createPool` | `veyl_bin.create_pool`, `BinPool` PDA `["bin", mintX, mintY, binStep]` | "listed pool" = an account owned by `veyl_bin` with the right discriminator; no registry to re-point; the factory itself is created by the upgrade authority |
| `mapping(int24 => Bin)` | `BinArray` PDA `["bins", pool, chunk]`, 60 bins each (zero-copy: reserves, shares, fee / reward growth, limit orders, a bit per bin per side) | created on demand (`init_bin_array`), passed as remaining accounts; the pool keeps a bit per array per side so swaps skip empty ranges |
| `sharesOf[id][owner]` | `ShareAccount` PDA `["shares", pool, owner, authority, chunk]` | per bin: shares, fee / reward checkpoints, limit-order shares; settled balances per account. `authority` may burn, claim and withdraw: the owner for a public LP, the entry's signer PDA for a private position owned by a one-time key |
| `mint / burn / swap / quote` | same, `quote` returns via return data | `MIN_LIQUIDITY` locked in the bin (no dead address) |
| `VeylRouter.swap` | `veyl_entry.swap_route` | hop accounts as remaining accounts; up to 3 hops per route |
| `VeylEntrypoint` + `poolOf` registry | `veyl_entry`; pools are derived, no registry, no owner | processor = signer PDA `["signer"]`; its ATAs hold funds only within one instruction |
| `relay / privateSwap / privateAdd / privateRemove` | `relay / private_swap / private_add / private_remove` | |
| EIP-712 remove signature | ed25519 instruction + instructions-sysvar introspection; digest = sha256("veyl-remove-v1", program id, borsh(RemoveData)); `Nonce` PDA `["nonce", owner]` | |
| gas table | compute units (see `DEPLOY.md`) | big relayer transactions use a v0 transaction with an address lookup table the deploy creates |

## Audit findings (EVM report) and what changed

Fixed in this port:
- **Engine did not save the change note before submitting / deleted unresolved notes after 60 s** — the browser engine now writes the change note (with secrets) to the device before anything is sent, resolves it from the chain afterwards, and never deletes a note.
- **Owner could redirect swap and remove proceeds by re-registering a pool** — there is no registry; the pool for a mint is a derived address, and the entry program has no owner at all.
- **Zero-value withdrawals flush the root history for free** — refused at post time.
- Postman and authority are separate keys from the start (tests use distinct keypairs).

Fixed by the October 2026 internal review (`REVIEW.md`, each with a regression test): pool and factory squatting (High: only the upgrade authority creates them now); the relayer's missing fee floor; a parked proof that froze a note and blocked its ragequit (a newer post replaces it now); a pre-created vault blocking a listing; root-history flushing (one entry per slot, 192 slots); `private_add` without minimum shares; `private_remove` failing on a dust side; public-payout removals misordered by the relayer; the rate limit behind a proxy.

Still open (documented on the site as well): the single-machine trusted setup (Critical; mainnet blocker until the ceremony is run); screening is bypassed by one hop; the publisher can freeze private exits; change notes cannot ragequit. New to the Solana shape: the deposit-record PDA for a swap/remove output is derived from the pool's next nonce, so two outputs landing in the same pool in the same slot make the second transaction fail (the relayer cancels the post and the client retries with a fresh proof).

## Phase 1: Meteora-grade LP mechanics (programs only; the circuit, zkey and vkey are unchanged)

| Feature | Public (veyl_bin) | Private (veyl_entry, via the relayer) | SDK (`sdk/veyl.js`) |
|---|---|---|---|
| Bitmaps: swaps jump over empty ranges | `swap`, `quote` | `private_swap`, `swap_route` | `chunksForSwap`, `simulateSwap` (exact twin), `liveChunks` |
| Fees: growth per share per token, claimable; volatility fee kept | `claim_fees` | `private_claim_fees` (ed25519; notes or a wallet) | `position()` (unclaimed fees, rewards, orders), `claimFeesIx`, `privateClaimFeesIx` |
| Protocol fee: 10% default, 25% max, fee authority only | `set_protocol_share`, `withdraw_protocol_fee` | — | `protocolFees`, `setProtocolShareIx`, `withdrawProtocolFeeIx` |
| Limit orders: one bin away from the active bin, fill and stay filled | `place_limit_order`, `withdraw_limit_order` | `private_place_order` (proof), `private_withdraw_order` (ed25519) | `placeOrderIx`, `withdrawOrderIx`, `privatePlaceOrderIx`, `privateWithdrawOrderIx` |
| Rebalance: burn + re-add by weights in one instruction, `min_shares` | `rebalance_position` | `private_rebalance` (ed25519, relayer fee withheld) | `rebalanceIx`, `privateRebalanceIx`, `shapeWeights` (spot / curve / bidAsk), `sideWeights`, `distribute` |
| Zap: one token in, swapped through the pool itself | `swap_and_add` | `private_zap` (proof, needs `min_swap_out` and `min_shares`) | `planZap`, `swapAndAddIx`, `privateZapIx` |
| Farm rewards: 2 mints, per-second rate, active bin | `init_reward`, `fund_reward`, `claim_reward`, `withdraw_ineligible_reward` | `private_claim_reward` (ed25519) | `initRewardIx`, `fundRewardIx`, `claimRewardIx`, `privateClaimRewardIx` |

Signed private actions use `V.signAction(kind, oneTimeSecretKey, d)` + `V.signedSigIx(kind, owner, sig, d)`; the relayer
accepts them as `{ kind: 'claim' | 'reward' | 'orderWithdraw' | 'rebalance', d, sig }` and proof-bound ones as
`{ kind: 'order' | 'zap', d, legs: [{ mint, p }] }`, with the same fee range and cost floor as before (`POST /fee` first).
Variable fee: Veyl's `variable_fee_control` x 100 = Meteora's (DEPLOY.md). Compute per action and the 70-bin call limit:
DEPLOY.md, "Position limits and compute". Self-review and audit focus: REVIEW.md, "Phase 1 self-review".

## Phase 2: hidden balances, transfers and position sizes

| | |
|---|---|
| `transact` circuit | 2 notes in, 2 out; note = `Poseidon(asset, amount, Poseidon(sk), blinding)`; membership (depth 32), nullifiers, per-asset conservation with a signed public amount, 64-bit ranges, asset binding, external-data hash (recipient, relayer, fee, action, ciphertexts). **18,475 constraints**, 8 public signals, phase-1 2^15 |
| `position` circuit | a position note: shares in a 16-bin window + a fee checkpoint per token; claims computed in the proof. **17,219 constraints**, 8 public signals, phase-1 2^15 |
| keys | Poseidon spending key (`pk = Poseidon(sk)`, ~240 constraints vs ~6k for BabyJubjub), separate X25519 viewing key; Veyl address `veyl:` + both public keys; notes encrypted with NaCl box |
| tree | one new tree for every token (PDA `["shield"]`, depth 32, 192-slot root history): per-token trees would reveal the token of every spend |
| deposits | pending until the postman admits them; the depositor can take a pending deposit back |
| liquidity | every shielded share is held by one aggregate (`["shielded"]` of veyl_entry); fees harvested per bin into a fee-per-share counter (LpAcc); exact-share mints (`mint_exact`) |
| legacy | Phase 1 notes stay spendable (withdraw circuit unchanged) and migrate in with one proof (`shield_migrate`) |
| compute | post_proof 133k · deposit 47k · approve 65k · relayed transfer 95-102k · migrate 140k · swap 258k · LP add (2 legs) 638k · claim 295k · remove 478k · zap 542k · order 210k / withdraw 283k; every transaction under 1,232 bytes (post_proof 806, transfer 798, LP execute 612) |
| proving | Node: transact ~5.3 s, position ~5.1 s; browser (Web Worker, headless Chromium, same machine): transact ~11.5 s, position ~11.4 s |
| cut | shielded positions earn no farm rewards; one position note per 16-bin window; relayer fees are flat amounts (they reveal the token) |

Every Phase 1 action has a shielded variant in the app: deposit, send to a Veyl address, withdraw, swap, add, zap, claim,
rebalance, remove, limit orders. What is hidden and what is public, precisely: PRIVACY.md. Self-review: REVIEW.md, "Phase 2
self-review". Compute, transaction sizes and the heap frame: DEPLOY.md, "Shielded pool (Phase 2)".

## Phase 3: sealed batch swaps

| | |
|---|---|
| batch | per bin pool and epoch (`epoch_slots`, 150 on devnet); a swap joins the open batch; at the epoch end anyone closes it; an empty batch extends, a direction under the k-floor (3) rolls to the next epoch up to `max_rollovers` times, then refunds |
| `swap` circuit | spends 2 notes into a swap commitment `Poseidon(batchKey, direction, amount, Poseidon(sk), blinding)` + change; encrypts the amount to the committee key (exponent ElGamal on Baby Jubjub) and proves the ciphertext encrypts exactly that amount, 40-bit range, at least the pool's minimum. **23,426 constraints**, 8 public signals, phase-1 2^15 |
| `claim` circuit | spends a swap commitment into a note of `floor(amount x num / den) - fee` (the batch's clearing ratio; 1/1 refund when it failed). **9,942 constraints**, 6 public signals, phase-1 2^14 |
| curve | Baby Jubjub: native in the BN254 circuit; on chain in software (veyl_entry `bjj.rs`, ~900 CU per field multiplication); totals < 2^46, decoded by baby-step giant-step |
| program | `submit_swap` adds the ciphertext per direction; `post_share` + `share_step` verify one member's partial decryption with a Chaum–Pedersen proof (5 transactions); `settle_verify` checks each total from t shares; `settle_batch` nets the two directions at the active bin's price and makes ONE swap of the excess; `claim_swap`; `fail_batch` after the window |
| committee | `committee/`: t-of-n (2 of 3), joint Feldman DKG over HTTP, a node per member (Docker, `/health`), shares + DLEQ proofs + settlement; anyone can close, verify, settle or fail; a withholding committee only delays, then everything refunds. Arcium as an alternative: committee/README.md |
| public | each sealed swap's pool, batch and direction; per batch and direction: the total, the seller count, the net swap, the clearing ratio, the timing. Hidden: each swap's size and its claim's size, who sealed it |
| trust | privacy of individual sizes holds while fewer than t members collude: **a colluding 2 of 3 could decrypt every individual sealed amount**. Soundness and funds never depend on the committee |
| compute | submit_swap ~165k (+ post_proof ~161k) · close_batch ~265k · one share ~5.5M over 5 txs · settle_verify ~200k per direction · settle_batch ~125k · claim_swap ~84k |
| proving | Node: swap ~6.5 s, claim ~3.4 s; browser (Web Worker, six pages open in one headless Chromium): swap ~27-64 s, claim ~10-38 s |
| cut | no per-swap limit price (the batch's drift bound only); k counts swaps, not people; DKG without the GJKR bias fix; claim needs a second proof |

In the app, the pool page's swap panel has **Sealed** (default when the pool has sealed batches) and **Instant** (labelled with
what it reveals): epoch countdown, sellers per direction (never amounts), then claim or refund in the same panel. Self-review:
REVIEW.md, "Phase 3 self-review"; hosting the committee: DEPLOY.md, "Batch committee and sealed swaps".

## Tests

`npm test` — 298 passed, 0 failed: 188 Phase 1 and earlier, 56 Phase 2, 54 Phase 3 (`tests/phase3.js`: the DKG and committee registration (refused when the shares do not interpolate, or from a non-authority); swap proofs bound to direction, ciphertext and key; six sealed swaps through the relayer with no amount in any transaction; homomorphic aggregation; DLEQ forgery, wrong share, non-member and off-curve points refused; t-1 shares cannot decrypt; wrong total refused; one net swap with ratios equal to the JS twin; claim inflation and cross-direction claims refused; double claim refused; conservation per batch and direction; empty-batch extension, k-floor rollover and failure; withholding committee → refund after the window; pause; three committee node processes running the DKG over HTTP and settling a batch on their own). Phase 2 (`tests/phase2.js`: deposit / admit / take back, hidden transfers incl. hidden token, withdrawals, double spend, wrong asset, range overflow, external-data tamper, inflation, unknown root, foreign processor, a griefer pre-funding a nullifier, a random-sequence conservation property, migration of a legacy note, shielded swap, shielded add / claim / remove / rebalance / zap with the dilution rule, shielded limit orders, end-of-run conservation: vault == notes + fee pot). Phase 1 part in `tests/phase1.js`: a sparse pool where one swap skips 1,500 empty bins; seeded random swap sequences where the on-chain quote, the JS twin and the executed swap agree to the atom, bin state included; fee conservation (vault == reserves + orders + protocol + unclaimed + floor dust, dust < 1 atom per LP per bin); protocol share bounds and withdrawal; limit orders placed, filled, not un-filled, withdrawn, partially filled; public and private rebalance and zap against the twin's figures; reward accrual per position, active-bin-only, ineligible emission back to the funder, emission == paid + dust; every private variant through the relayer service with refusals for a missing / foreign / cross-domain signature, replay and missing minimums; the compute per bin behind the 70-bin limit). Covers: Poseidon cross-check, deposits and tree roots, ASP publication and emergency reset, a real proof verified on-chain (tampered proof, altered value, unknown roots refused), withdraw and change-note spend, double spend, cancel/expiry of posted spends, ragequit (and twice), two-step authority, bin pool mint/burn/swap/quote with the JS twin, MIN_LIQUIDITY lock, fee accrual, the public router (two hops), relay with a relayer that tries to redirect / raise the fee / expire, private swap into a new note (v0 transaction with the lookup table), spending that note, private add, ed25519-signed private remove (wrong key, wrong data, wrong nonce, replay), fee cap, wrong mint and wrong token program; one regression test per review finding (H-1, M-1..M-6, L-1, L-2: squatting, the relayer service's fee floor and one-transaction relay, post replacement and ragequit over a parked proof, a pre-created vault, a same-slot deposit burst, minimum shares, a dust swap output, a public-payout removal through the relayer); the authority handover (dry run, every role moved, the old key refused).

`npm run e2e` — 67 passed, 0 failed: the production build (dist/site) served with its CSP and cache headers (transact and position circuits content-hashed, the proving worker), the real app in Chromium with a mock Phantom; a shielded deposit (transact proof made in a Web Worker, ~11.5 s), taking a pending deposit back, the publisher admitting the other, a hidden send to another Veyl address (the receiver decrypts it), a withdrawal to a fresh wallet, a shielded swap, a shielded add (two legs + a position proof), a shielded zap, a shielded limit order filled and withdrawn, a shielded fee claim, a shielded rebalance and removal, the public Phase 1 actions alongside, encrypted backup and restore of the shielded account, the privacy check (the user's wallet appears in none of the relayer's transactions), Phase 3: three committee nodes (DKG over HTTP), six separate browser users sealing swaps into one batch from the pool page (sealed is the default mode, instant labelled), the relayer seeing no amount, the nodes closing, decrypting and settling, six UI claims paying exactly floor(amount x num / den) - fee, a lone seller refunded from the UI, phone layout; a 390 px phone, the static pages, no CSP violations. Browser proving (Web Worker, headless Chromium, six pages open): swap ~27-64 s, claim ~10-38 s; transact ~12 s with one page.

## Sandbox (the app's default mode)

`app.html` opens in **Sandbox** mode: a chain simulated in the page (`engine/sandbox-chain.js`), driven by the app's own engine (`engine/sandbox-engine.js` subclasses the browser Engine, so every shielded, sealed and liquidity flow is the real one). Bin pools are `programs/veyl_bin` ported onto the SDK's exact twin (`simulateSwap` is the executed swap; mint / burn / settle / claims / limit orders / rebalance / swap_and_add / mint_exact / harvest / farm rewards follow the Rust); the shielded pool applies veyl_pool's checks and veyl_entry's shield_swap / shield_order / shield_lp steps over the SDK's Poseidon tree; sealed batches run sealed.rs (aggregation, k floor, rollovers, settlement at the active bin) with a 2-of-3 committee made by `dkgLocal` in the page, partial decryptions with Chaum-Pedersen proofs verified, totals by BSGS in `committee-worker.js`. Proofs are real Groth16 (transact, position, swap, claim) made in `prove-worker.js` (proving keys split into parts under 8 MB, downloaded once per visit) and verified with snarkjs against the circuits' verifying keys before anything is applied. Simulated, and labelled so: the clock, the committee, the approved-set publisher (admits deposits after ~3 s), bots (public swaps; sealed swaps with real ciphertexts but no proofs), the faucet. Transactions are `sandbox #N`, never signatures. State is in memory and localStorage; Reset clears it. The legacy Phase 1 withdraw circuit is not used in the Sandbox. A Devnet switch in the app bar shows the deployment (pending until `veyl.config.js` has one). The homepage's "Try it" card lazy-loads the same sandbox. `npm run e2e:sandbox` — 64 checks (market prices mocked in the APIs' shapes, including the unavailable path) (sandbox flows, the pools table: sort, columns, filters, categories, intervals; row to pool page; phone cards and drawer).

## Real data: market prices, and on-chain figures

- **Market prices** (`engine/market.js`): four keyless sources in turn, 3-second timeout each, until every symbol (SOL, USDC, USDT, JUP, BONK) has a price: Pyth Hermes (only when `VEYL_KEYS.pyth` is set: Pyth's Core upgrade of 26 Aug 2026 put Hermes behind an API key), Jupiter Price API v3 (`api.jup.ag`, keyless at 0.5 requests/s, spaced accordingly; `VEYL_KEYS.jupiter` raises the limit), CoinGecko `simple/price`, then Coinbase Exchange tickers. The label always names the source and age ("Jupiter · 3 s ago"), the mode chip's tooltip says why a source was skipped or refused (`market.why()`), and `npm run check:prices` probes the same chain from a terminal. The last 24 hours come from Coinbase's public 5-minute candles. Used for the stats strip's SOL price, every dollar figure, and the Sandbox: its pools open at the price of 24 hours ago, bots trade them along the real path to now, then keep trading toward the live price (a market maker adds liquidity ahead of it). Without a market: fallback prices, a random walk, and the app says "market price unavailable". Parsers and the chain: `node tests/market.js` (part of `npm test`) against recorded response shapes.
- **Devnet / Local mode reads the chain only**: liquidity = vault balances − protocol fees; volume, fees, APR, swap counts, price path and age from each pool's transactions (`getSignaturesForAddress`, `getTransactions`, the `Swapped` / `PoolCreated` events); bins from the bin arrays; positions and fees from share accounts. Dollar values use market prices (tokens without one are valued through their pool). Nothing is simulated; with no deployment, chain figures are dashes. `npm run e2e:local` (32 checks) deploys to a local validator, runs `scripts/seed.js`, opens the app and checks every figure in the pools table, the pool page and the stats strip against the chain read independently.
- **`npm run seed -- --network devnet`** (DEPLOYER_KEYPAIR = the deployer): liquidity (a curve around each pool's price) and a few trades in every curated pool, from the deployer, which is the mock mints' authority; refuses mainnet.
- CSP: `connect-src` names the price APIs (and the RPC + websocket, relayer) in `dist/site/_headers`, `vercel.json` and `netlify.toml`.

## Markets (external Solana pools)

The app's **Markets** page lists live liquidity pools across Solana DEXes (GeckoTerminal, DexScreener, Meteora DLMM, Raydium, Orca: keyless public APIs, read in the browser; `engine/markets.js`). One row per pool: the DEX's own API supplies bin step / fee tier / APR, aggregators supply price and change; the row names its sources and their age. External pools are labelled so and never enter Veyl's figures. Honest states: per-source badges (down, rate-limited with a countdown), stale rows, loading. A pool's drawer shows GeckoTerminal candles, copyable addresses, links, and "Mirror on Veyl", which only queues a request for the factory authority. Parsers and the merge: `node tests/markets.js` (in `npm test`, against recorded response shapes); the page: `npm run e2e:sandbox` with the APIs mocked. Keys (Birdeye, Helius, Jupiter Pro, Pyth) are optional slots: see DEPLOY.md.

## Site

`app.html` without a `veyl.config.js` runs its labelled demonstration; `GO-LIVE.command` writes the config. `PREVIEW=1 npm run dist` builds the shareable demonstration preview.
