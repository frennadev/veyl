# Deploying Veyl on Solana

Devnet today. Mainnet is blocked until every item in **Before mainnet** is done; `npm run preflight -- --network mainnet` stays red until then. Security review: `REVIEW.md`. Privacy: `PRIVACY.md`. Key ceremony: `ceremony/README.md`.

## Prerequisites
Node 20+, Solana CLI (Agave) 3.1.x (tested 3.1.9). Rust + `cargo-build-sbf` (platform-tools v1.52) only to rebuild the programs. Keys live **outside the repo**; scripts read them from paths in env and never print them.

## Devnet
```bash
npm ci
solana-keygen new -o ~/keys/veyl/devnet-deployer.json      # pays rent, upgrade authority
solana-keygen new -o ~/keys/veyl/devnet-relayer.json       # relayer hot wallet (fee-only)
solana-keygen new -o ~/keys/veyl/devnet-postman.json       # publishes the approved set
export DEPLOYER_KEYPAIR=~/keys/veyl/devnet-deployer.json
export RELAYER_PUBKEY=$(solana-keygen pubkey ~/keys/veyl/devnet-relayer.json) POSTMAN_PUBKEY=$(solana-keygen pubkey ~/keys/veyl/devnet-postman.json)
solana airdrop 5 $(solana-keygen pubkey $DEPLOYER_KEYPAIR) -u devnet     # repeat (or faucet.solana.com): the dry-run below prints the amount (NEEDED)
npm run preflight -- --network devnet                      # all green except the dev-setup warning
npm run deploy -- --network devnet --dry-run               # plan + cost, sends nothing
npm run deploy -- --network devnet                         # writes deploy.devnet.json (+ site/veyl.config.js); re-runs skip what exists
git add deploy.devnet.json && git commit -m "devnet deploy" && git push   # public addresses only; the hosts build from it
```
Then create the Render blueprint (`render.yaml`: relayer + static site) and set the secrets below; or build the site yourself:
`RELAYER_URL=https://<relayer> npm run build:site -- --network devnet` and upload `dist/site/` (`vercel deploy dist/site`, `netlify deploy --dir dist/site`). `VEYL-DEVNET.command` does all of this on your Mac with one key, plus seeding and two public links (`START-HERE-DEVNET.md`).

## Hosting on Render (devnet)
`render.yaml` is a Render blueprint for two services: **veyl-sol-relayer** (Docker web service, starter plan, always on)
and **veyl-sol-site** (static site, built from `web/` by `npm run build:site`). Render builds from the Git repo, so push the
branch first; `deploy.devnet.json` (public addresses only) is committed and goes into both.

1. Render dashboard → New → Blueprint → this repo and branch. It reads `render.yaml` and creates both services. Each
   service's host is passed to the other: the site bakes `https://<relayer host>` into `veyl.config.js`, the relayer allows
   the site's host in CORS (`ALLOWED_ORIGINS`; a bare host means `https://<host>`).
2. Enter the secrets it asks for (never committed):
   | Service | Key | Value |
   |---|---|---|
   | relayer | `RPC_URL` | a dedicated devnet RPC (Helius etc.); the public one rate-limits it |
   | relayer | `RELAYER_SECRET_KEY` | the relayer hot wallet: the JSON byte array in `~/keys/veyl/devnet-relayer.json` (fee-only; keep its balance low) |
   | relayer | `FAUCET_SECRET_KEY` | devnet only: the devnet deployer key (mint authority of the mock tokens) for "Get test tokens". Never on mainnet |
   | relayer | `POSTMAN_SECRET_KEY` | optional: the approved-set publisher (never the relayer's key) |
   | relayer | `JUPITER_API_KEY`, `POOL_LOOKUP_TABLES` | optional (token data without the keyless limit; the relayer's tables for pools listed since the deploy, printed in its log when it makes one) |
   | site | `SITE_RPC_URL` | the RPC browsers use. **Public**: every visitor sees it. Use a separate key limited to the site's domain, not the relayer's |
3. The first deploy: the relayer starts, then the site builds. If the site built before the relayer had a host, redeploy
   the site once. Check `https://<relayer>/health` (`ok`, `balanceSol`), then open `https://<site>/app`.
4. After a relayer start its trade index reads 7 days of every pool's trades (about 2 minutes on devnet; until then the
   app reads the chain itself, more slowly), and token names and logos are fetched again. Nothing else is kept on disk:
   faucet limits also reset on a restart.
5. A custom domain: add it to the site in Render, then set the relayer's `ALLOWED_ORIGINS` by hand to both origins
   (`https://<site>.onrender.com,https://veyl.example`) instead of the value from the blueprint.

Costs: the relayer's starter plan (the free plan sleeps, and every wake would rebuild the trade index); the static site is
free. Keep the relayer wallet funded with devnet SOL (`/health` shows `lowBalance` under `LOW_BALANCE_SOL`). The starter
plan's 512 MB is why `ACTIVITY_MAX_SWAPS` is 100000 there.

Sealed swaps settle only while the batch committee runs (2 of 3 nodes). They are not in the blueprint by default: each
node keeps its key share on a persistent disk, and members should run on separate infrastructure. `render.yaml` has a
commented section for running all three on Render for devnet testing (private services with disks, a paid plan).

## Mainnet (only after Before mainnet)
```bash
export MAINNET_KEYPAIR_DIR=~/keys/veyl/mainnet                 # OUTSIDE the repo; never committed
npm run keys:mainnet        # fresh program keypairs there (reused if present), their IDs into the cfg(feature = "mainnet")
                            # lines of programs/*/src/lib.rs + Anchor.toml [programs.mainnet] + config/mainnet.json, then
                            # npm run build:mainnet -> target/deploy-mainnet/, and checks every .so carries the mainnet IDs
                            # (its own and the ones it calls) and no dev ID. Devnet/local IDs are unchanged.
# edit config/mainnet.json: remove every "VERIFY: ..." (RPC, USDC/USDT mints, launch prices, postman, relayer, relayerUrl)
export DEPLOYER_KEYPAIR=~/keys/veyl/mainnet-deployer.json PROGRAM_KEYPAIR_DIR=$MAINNET_KEYPAIR_DIR CEREMONY_PTAU_14=~/keys/veyl/powersOfTau28_hez_final_14.ptau CEREMONY_PTAU_15=~/keys/veyl/powersOfTau28_hez_final_15.ptau
npm run preflight -- --network mainnet                     # must be fully green (re-verifies the whole ceremony)
npm run deploy -- --network mainnet --dry-run
npm run deploy -- --network mainnet --confirm-mainnet      # asks you to type "mainnet"
npm run handover -- --network mainnet --to <multisig vault> --postman <publisher key> --dry-run
npm run handover -- --network mainnet --to <multisig vault> --postman <publisher key> --confirm-mainnet
# upgrade authority moves at once; pool + factory authority are two-step: the multisig executes the printed accept
# instructions. Once the relayer works: npm run handover -- ... --freeze-lut. Preflight then shows no role on the deployer.
```
Only the upgrade authority can create pools or the factory (`init_pool`, `init_factory`), so deploy and initialise before the
handover, and list only classic SPL Token mints (USDC, USDT, wrapped SOL): no transfer-fee, hook or permanent-delegate mints.

## Cost (computed by `--dry-run`)
Per program: rent(45+len) + rent(36) kept, plus a write buffer rent(37+len) held while that program uploads (refunded); rent(n) = (128+n) x 6,960 lamports; ~1 tx per KB x 5,000 lamports. Accounts: sizes in `config/account-sizes.json`.
Programs today: `veyl_pool` 768 KB, `veyl_bin` 782 KB, `veyl_entry` 1.6 MB, so the programs alone keep about 16 SOL on any network and the largest write buffer adds 8.1 SOL to the peak.
- **Devnet**, the 12 built-in pools, mock mints (dry-run, Oct 2026): **16.67 SOL** kept, **24.80 SOL** peak. Seeding adds ~0.25 SOL a pool; `VEYL-DEVNET.command` adds that and 2 SOL for the faucet, then prints the total (about 30 SOL for 12 pools; all 83 pools need roughly twice that).
- **Mainnet** (SOL/USDC/USDT, 3 bin pools): about **16.4 SOL** kept, **24.5 SOL** peak (same programs; run the dry-run for the exact figure). Plus priority fees if you set `PRIORITY_FEE_MICROLAMPORTS`.
- Paid later by whoever needs them (never refunded: there is no close instruction yet): a bin array (60 bins, 9,664 bytes) **0.0682 SOL**,
  a share account (one owner, 60 bins, 6,864 bytes) **0.0487 SOL**, a reward vault 0.0020 SOL. The relayer's fee floor charges
  the arrays and share accounts a private add, order, zap or rebalance creates.
- Relayer wallet: per withdrawal ~0.0026 SOL for the spent marker + ~0.0020 SOL when the recipient has no token account + 5,000 lamports per tx. Its fee floor charges that back (`POST /fee`; `FEE_COVER`, prices from the deploy file or `PRICES_JSON`), so a small amount pays a higher rate (never above the 1% on-chain cap) and an amount too small to cover it is refused. Keep ~0.5 SOL; `/health` flags `lowBalance` under `LOW_BALANCE_SOL`.

## Env on the hosts
- **Relayer (Render, Docker `relayer/Dockerfile`)**: `NETWORK`, `RPC_URL`, `RELAYER_SECRET_KEY` (JSON array or base58 of the relayer keypair; its own fee-only wallet, never user funds), `POSTMAN_SECRET_KEY` (optional; runs the approved-set publisher; never the relayer's key), `ALLOWED_ORIGINS` (site origin), `MIN_FEE_BPS`, `FEE_COVER` (fee floor multiple, default 1), `PRICES_JSON` (optional USD prices for the floor), `TRUST_PROXY` (1 on Render: rate-limit per client, not per proxy), `PORT`; for pools listed since the deploy: `POOL_LOOKUP_TABLES` (its own lookup tables, comma separated; it prints them when it makes one, else finds them on chain), `POOL_LUT_MAX_TABLES` / `POOL_LUT_PER_POOL` / `POOL_LUT_PER_HOUR` (4 / 24 / 200), `POOL_LUTS=0` (off), and the fee limits for their tokens `DISCOVERED_MIN_DEPTH_USD`, `DISCOVERED_BAND`, `DISCOVERED_HAIRCUT`, `DISCOVERED_MAX_COST_SOL`, `DISCOVERED_BUDGET_SOL`, `DISCOVERED_BUDGET_TOTAL_SOL` (REVIEW.md M-8, L-8). It reads `deploy.<NETWORK>.json` from the image, or `DEPLOY_JSON`.
- **Site**: `RELAYER_URL` (or `RELAYER_HOST` from the blueprint), optional `SITE_RPC_URL`. Every variable: `.env.example`.

## Live data: market prices and Solana markets (keys optional)

The app reads live data in the browser from keyless public APIs; nothing here needs a key. The build names every origin in the CSP (`scripts/site-headers.js` → `_headers`, `vercel.json`, `netlify.toml`).

| Source | Used for | Endpoint (keyless) | Limits |
|---|---|---|---|
| Pyth Hermes | SOL/USDC/USDT/JUP/BONK prices, only with `PYTH_API_KEY` | `hermes.pyth.network/v2/updates/price/latest` | since the Core upgrade (26 Aug 2026) a key is required; skipped without one |
| Jupiter Price v3 | prices, first keyless source | `api.jup.ag/price/v3` | keyless 0.5 rps (the app spaces its calls); `JUPITER_API_KEY` raises it |
| CoinGecko | prices when Jupiter refuses or omits a token | `api.coingecko.com/api/v3/simple/price` | ~30 requests/min, CORS open |
| Coinbase Exchange | prices as the last resort; 24h price history for the Sandbox | `api.exchange.coinbase.com/products/<SYM>-USD/ticker`, `/candles` | public |

`npm run check:prices` probes this chain from a terminal and prints each source's answer; the app's mode chip shows the same on hover.
| GeckoTerminal | Markets: pools, trending, search, OHLCV | `api.geckoterminal.com/api/v2` | ~30 requests/min, cached 60 s |
| DexScreener | Markets: pair detail, search | `api.dexscreener.com` | ~300/min |
| Meteora DLMM | Markets: DLMM pools with bin step, fees, APR | `dlmm-api.meteora.ag/pair/all_by_groups` | public |
| Raydium | Markets: pools with TVL, 24h volume/fees/APR | `api-v3.raydium.io/pools/info/list` (legacy endpoint) | cached 60 s |
| Orca | Markets: whirlpools with TVL, 24h stats | `api.orca.so/v2/solana/pools` | public, 429 on abuse |

All of these allow browser calls (CORS `*`) as far as their docs say; `engine/markets.js` keeps a per-source cache and backs a source off after a 429 or 5xx (doubling to 5 minutes) and the UI shows the countdown. If a source ever refuses browser origins, set `proxy` in `window.VEYL_KEYS` to a relayer path and add a pass-through there (the relayer's CSP is the same list).

**Optional keys** (the owner signs up; the app says "add a key for more" until then). Put them in `site/veyl.keys.js` as `window.VEYL_KEYS={...}` (never commit it) or as build env `BIRDEYE_API_KEY`, `HELIUS_API_KEY`, `JUPITER_API_KEY`, `PYTH_API_KEY`:

| Key | Sign up | Adds |
|---|---|---|
| `birdeye` | birdeye.so → Developers | token security, holders, OHLCV for every pool |
| `helius` | helius.dev | a fast, high-limit RPC for Devnet / mainnet reads (`RPC_URL`) |
| `jupiter` | developers.jup.ag/portal | higher rate limits on prices and routes |
| `pyth` | docs.pyth.network (Core API key) | first-party oracle prices instead of the Jupiter fallback |

## Fees, rewards, limit orders (Phase 1)
- **Protocol fee.** A fixed **0.2%** (`protocol_fee_bps = 20`) of every swap's input, on top of the pool's LP fee, goes to an
  accounted protocol balance in its vaults; LPs keep the whole LP fee (claimable per position) and limit orders are paid into
  the filled amount. Sealed batches pay it on the matched part too (`pay_protocol_fee`). LP fees come from the factory's fee
  tiers (`"feeTiers"` in `config/<network>.json`; a listed tier cannot be edited). Pools anyone lists post a refundable bond
  (`"bond": { sol, lockDays }`); `"treasury"` receives delisted bonds. Only the factory's **protocol fee authority** may withdraw: the
  deployer at first; `npm run handover` proposes it to the multisig (two-step, the multisig accepts), like the factory
  authority. Withdraw from the multisig with the SDK: `V.protocolFees(pool)` then
  `V.withdrawProtocolFeeIx(feeAuthority, pool, amountX, amountY, toX, toY)` (capped at the accounted balance).
- **Farm rewards.** Up to two reward mints per pool, emitted per second to the active bin's liquidity providers. The factory
  authority opens a slot: `V.initRewardIx(authority, pool, index, rewardMint, durationSeconds, funder)`; the funder funds it:
  `V.fundRewardIx(funder, pool, index, amount)` (rate = (amount + not yet emitted) / duration). Emission while the active bin
  is empty is ineligible; the funder takes it back with `withdrawIneligibleRewardIx`. `setRewardFunderIx` hands the slot over
  (`npm run handover` moves slots funded by the deployer). List classic SPL Token reward mints only; for LPs to claim
  privately into a note, the reward mint needs a private pool (`init_pool`) and an entry vault (`init_vault`), as the deploy
  creates for its own tokens.
- **Limit orders** need no setup: any pool takes them (`place_limit_order` / `private_place_order`).
- **Variable fee units.** `vfc` in `scripts/lib.js` is Veyl's `variable_fee_control`: the fee is in pips (1e-6) and
  variable = (va x binStep)^2 x vfc / 1e12, floored. Meteora's `variable_fee_control` (denominator 1e9, / 1e11, ceiling) is
  **100x** Veyl's: Meteora's preset 40,000 = Veyl 400 (`S.vfcFromMeteora`). The deploy's pools use 10,000 (= Meteora 1,000,000),
  a deliberately steep volatility fee; lower it for calmer pairs before mainnet.

## Position limits and compute (measured on the local validator, `npm test`)
| | compute units |
|---|---|
| swap, 1 / 3 bins | 45k / 82k (each further bin traded ~12-18k; empty bins between cost nothing) |
| swap skipping 1,500 empty bins (sparse pool) | 92k |
| mint | 9.9k per bin near the active bin, 17.8k per bin at \|id\| ~3,000 (+ ~14k fixed) |
| burn | 3.1k per bin |
| claim_fees (7 bins) / claim_reward | 30k / 24k |
| place / withdraw limit order | 21k / 20k |
| rebalance_position (7 -> 11 bins) / swap_and_add (7 bins) | 117k / 97k |
| private_place_order / private_zap (5 bins) | 111k / 201k (proof already posted) |
| private_claim_fees / private_withdraw_order / private_rebalance (5 -> 7) / private_claim_reward | 214k / 130k / 175k / 115k |
| post_withdrawal (Groth16) | 118k |

**MAX_IDS = 70 bins per mint / burn / rebalance / zap call** (was 60). Compute allows ~77 bins per call at \|id\| ~3,000
(1.4M CU) and ~140 near the active bin; a bin costs 36 bytes of instruction data with its minimum shares, so a 4,096-byte v1
transaction fits ~95 (today's 1,232-byte packets: ~25; the relayer uses v0 transactions with its lookup table). A position is
not limited to one call: it spans as many 60-bin share accounts as needed. A private rebalance carries both its old and new
bins: about 70 bins in total fit one 4,096-byte transaction. The local validator (Agave 3.1.9) and web3.js 1.x still send
1,232-byte packets, so the 4,096-byte figures are computed from the measured instruction layout, not sent.

## Shielded pool (Phase 2)
- **Created by the deploy**: `init_shield` (upgrade authority; the shielded pool is the PDA `["shield"]` of veyl_pool, with
  the postman you configure), its vault per token (the ATA of that PDA), and lookup-table entries for the shield, the
  shielded owner, the LpAcc and aggregate share accounts. `npm run handover` moves the shield authority and postman with the
  other roles; preflight checks the five verifying keys (withdraw, transact, position, swap, claim) baked into `veyl_pool.so`.
- **Postman**: the relayer process admits pending deposits every `ADMIT_INTERVAL_MS` (default 5 s) when it runs with
  `POSTMAN_SECRET_KEY`. Until admitted, a depositor can take a deposit back.
- **Relayer fees** for shielded actions are flat amounts (`POST /fee` with `kind` = `transact`, `shieldSwap`, `shieldLp`,
  `shieldOrder`, `shieldOrderWithdraw`), sized to what the action costs the relayer: rent of the nullifier and proof
  accounts (0.00089 SOL each, never refunded for nullifiers), any bin array / share account / LpAcc it must create, and
  5,000 lamports per transaction.
- **Transactions** (local validator, 1,232-byte packets, v0 + the deploy's lookup table): every proof is posted in its own
  transaction (`post_proof`, 806 bytes: 256-byte proof + 8 public inputs), then executed by reference. A shielded LP request
  (deltas, hints, legs, ciphertexts: more than one packet holds) is uploaded to a `Buffer` account in chunks first; the execute transaction then
  carries only accounts. Measured sizes: `shield_transact` 798 bytes, `shield_swap` 505, `shield_lp` (2 legs) 612, all under 1,232.
- **Heap**: `shield_lp`, `shield_swap` and `shield_order*` request a 256 KB heap frame (`ComputeBudgetProgram.requestHeapFrame`);
  veyl_entry's allocator (feature `custom-heap`, default) uses it. Without it they run out of memory.

| shielded action (compute units, measured by `npm test`) | CU |
|---|---|
| `post_proof` (Groth16 verify, 8 public inputs) | 133k |
| `shield_deposit` / `approve_deposit` (2 leaves) | 47k / 65k |
| `shield_transact` (hidden transfer or withdrawal, relayed) | 95k-102k |
| `shield_migrate` (legacy note -> receipt note) | 140k |
| `shield_swap` (1 hop) | 258k |
| `shield_lp`: add with 2 legs / claim / remove half / zap with 1 leg | 638k / 295k / 478k / 542k |
| `shield_order` / `shield_order_withdraw` | 210k / 283k |

Accounts: LpAcc (H per bin, one per 60-bin chunk) 1,968 bytes (0.0146 SOL), parked proof 306 bytes (refunded at
execution), pending deposit 153 bytes (refunded at admission or take-back), nullifier 0 bytes (0.00089 SOL).

## Batch committee and sealed swaps (Phase 3)
Sealed swaps need a t-of-n batch committee (devnet and the local setups: 2 of 3). Each member is a separate operator with
its own host, node key and backups; the protocol registers the committee's joint key from the key generation's transcript.
Without a transcript the deploy skips sealed swaps (the app then offers only instant swaps) and preflight says so.

**1. Members (each operator, on their own machine)**
```bash
solana-keygen new -o ~/keys/veyl/committee-node.json                 # node key: signs DKG messages, shares, settlements
NODE_KEY=~/keys/veyl/committee-node.json node committee/node.js keys  # prints { node, boxKey }: send both to the coordinator
```
**2. Peer list.** The coordinator writes one `committee.json` and gives every member the same file:
`{ "t": 2, "n": 3, "peers": [ { "index": 1, "url": "https://m1.example:8863", "node": "<pubkey>", "boxKey": "<base64>" }, ... ] }`
(each member adds its own `"index"` at the top level, or sets it in `COMMITTEE_JSON`). Pick a fresh session name, e.g.
`veyl-devnet-2026-10`, never one starting with `local-`.

**3. Key generation (all members within 10 minutes).** Each member starts its node (Docker or plain Node):
```bash
docker build -f committee/Dockerfile -t veyl-sol-committee .
docker run -d --name veyl-committee -p 8863:8863 -v veyl-committee:/data \
  -e COMMITTEE_JSON="$(cat committee.json)" -e NODE_SECRET_KEY="$(cat ~/keys/veyl/committee-node.json)" \
  -e DKG_SESSION=veyl-devnet-2026-10 -e NETWORK=devnet -e RPC_URL=https://api.devnet.solana.com veyl-sol-committee
curl -s http://localhost:8863/health        # {"ok":true,"index":1,"dkg":"done","registered":false,...}
```
The nodes run joint Feldman VSS over HTTP (signed rounds, shares encrypted to each member's box key). Any complaint aborts
the session: drop or fix the accused node and start a new session. When it is done every node holds `/data/share.json` (its
secret share, mode 0600; back it up offline, encrypted: losing more than n - t shares stops settlement for good and every
batch under that key refunds) and serves the same `GET /transcript`.

**4. Register.** The coordinator saves the transcript as `committee/transcript.<network>.json`, commits it (public), runs
`npm run preflight -- --network <network>` (re-verifies every signature, commitment and key; red on mainnet for a local
session or less than 2 of 3) and `npm run deploy -- --network <network>`: it creates the committee account, registers t, n,
the joint key, the member keys, the node keys and the transcript hash (`set_committee` checks the member keys interpolate to
the joint key), then the sealed pools of `config/<network>.json` → `sealed` (epoch 150 slots, settlement window 1,500 slots,
k = 3, 4 rollovers, drift 50 bins, a minimum per token). Fund each node key with ~0.5 SOL: a share costs 5 transactions and
the share job's rent (refunded); settling costs one.

**5. Run.** The nodes then close due batches, post and prove their partial decryptions, recover the totals and settle. The
relayer cranks too (`SEALED_CRANK=1` default, `CRANK_INTERVAL_MS` 4000): closing, verifying totals, settling and failing are
permissionless; only shares need members. Rotate with a new key generation and `set_committee` (the committee authority; it
moves to the multisig with `npm run handover`). Batches under the old key settle only with the old shares, so keep the old
nodes up until those batches are done or refunded.

| sealed action (compute units, measured by `npm test`) | CU |
|---|---|
| `set_committee` (2 of 3) / `init_sealed_pool` | 186k / 18k |
| `post_proof` (swap) + `submit_swap` | 161k-173k + 160k-167k |
| `close_batch` (four points to affine) | 265k |
| `post_share` + 4 x `share_step` (one member's Chaum–Pedersen check) | <= 1.31M each, ~5.4M-5.6M total |
| `settle_verify` (one direction) / `settle_batch` (net swap) | 200k / 119k-127k |
| `claim_swap` | 84k |

Accounts: committee 752 bytes, sealed pool 150, batch 1,816 (per batch, paid by whoever closes the previous one), share job
9,132 (refunded when the job ends). Proving: swap ~6.5 s and claim ~3.4 s in Node; in the browser (Web Worker, headless Chromium, six pages open) swap ~27-64 s, claim ~10-38 s.

## Smoke checks
```bash
curl -s https://<relayer>/health                       # {"ok":true,"version":"0.1.0","network":"devnet",...,"lowBalance":false}
curl -s https://<relayer>/info                         # relayer, entrySigner, lookupTable == deploy.devnet.json, minFee table
curl -s -X POST https://<relayer>/fee -d '{"kind":"relay","mint":"<USDC mint>","value":"100000000","d":{"recipient":"<fresh address>"}}'   # {"feeBps":..}
solana program show <pool program id> -u devnet        # upgrade authority = deployer (devnet) / multisig (mainnet)
npm run handover -- --network devnet --to <key> --dry-run   # every role and who holds it
curl -sI https://<site>/app.html | grep -i content-security-policy     # 'wasm-unsafe-eval', connect-src = RPC + relayer
npm run preflight -- --network devnet                  # programs on chain identical to target/deploy
```
Then in the app: connect, deposit 1 USDC, withdraw 0.5 to a fresh wallet (the proof is made in the browser).

## Before mainnet (open)
Mainnet stays blocked while any of these is open; `npm run preflight -- --network mainnet` is red until then.

1. **Run the multi-party key ceremony with real participants (Critical, hard blocker), for all five circuits.** The kit is
   ready and rehearsed for withdraw, transact, position, swap and claim together (`ceremony/README.md`; last rehearsal:
   `ceremony/rehearsal/RESULT.json`, including real transact proofs made with the rehearsal key verified and executed by
   `veyl_pool` on a local validator, and a full sealed batch proven with the rehearsal swap and claim keys). What is left is the ceremony itself: at least 3 independent contributors (one command
   each contributes to all five), the public `powersOfTau28_hez_final_14.ptau` and `_15.ptau` (blake2b in
   `ceremony/ptau.json`), a beacon from a pre-announced future Bitcoin block, `finalize`, publishing `ceremony/TRANSCRIPT.md`
   and every intermediate key, then `npm run build:mainnet`. Preflight is green for the setup only when, for every circuit,
   the transcript lists it, its chain re-verifies against its r1cs and the public ptau, at least 3 non-rehearsal
   contributions and a beacon are in its key, and that key's vkey is baked into `veyl_pool.so`.
2. **Batch committee key generation (Critical for sealed swaps).** Three independent operators run it (above) and publish
   the transcript; preflight is red on mainnet until `committee/transcript.mainnet.json` exists, re-verifies, is at least 2 of
   3 with distinct node keys and is not a local session. The local and e2e committees are one machine's three processes.
3. **External audit (recommended; a hard blocker in `config/blockers.json`).** An independent firm should audit the three
   programs, the circuit and the browser engine. `REVIEW.md` is an internal review (1 High and 6 Medium found and fixed, each
   with a regression test), a stand-in, not an audit. Only the team marks this item resolved, with the published report as
   evidence.
4. **Verify the mainnet values in `config/mainnet.json`.** Every `VERIFY:` value must be checked against its issuer and your own
   records and the prefix removed by hand: the USDC and USDT mint addresses (Circle, Tether; SPL Token program, 6 decimals;
   preflight checks they exist with the right owner and decimals), the RPC, launch prices, postman, relayer and relayer URL.
   The program IDs are written by `npm run keys:mainnet`.

Ready, run at deploy time (preflight checks each):
- Phase 1 roles: the protocol fee authority and any reward funder are handed over with the rest (`npm run handover`); preflight
  flags them while the deployer (or the relayer's wallet) holds them.
- Fresh program keypairs outside the repo and the mainnet build profile: `npm run keys:mainnet` (never the `target/deploy` dev keys).
- Authority handover after deploy: `npm run handover` moves the three upgrade authorities, every pool authority, the factory
  authority and every postman role to the multisig (postman to a dedicated key if publishing should stay automatic), with
  `--dry-run`; preflight flags any role still held by the deployer or a postman that is the relayer's wallet.
- The internal review's fixes (`REVIEW.md`) are in the programs, the relayer and the app.
