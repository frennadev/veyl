# Veyl handoff: start here

Welcome. This is the brief for picking the project up. Read this, then the doc each task points to
(`CLAUDE.md` is the same brief, condensed for Claude Code). Everything an engineer needs is in this repo; secrets are not, and never go in it.

## What Veyl is (one paragraph)
A private DLMM on Solana: Meteora-style concentrated-liquidity bin pools where nobody can link a position, swap or fee claim
to the wallet behind it. Pools are curated (Delta-style: only the factory authority lists pools). Three Anchor programs
(`veyl_pool` shielded pool, `veyl_bin` DLMM, `veyl_entry` private entry points and sealed batch swaps), five Groth16 circuits
(`zk/circuits`), a browser engine that proves on the user's device (`site/`), a relayer (`relayer/`), and a t-of-n batch
committee for sealed swaps (`committee/`). `README.md` = architecture, `PRIVACY.md` = exactly what is and isn't hidden,
`REVIEW.md` = internal security review, `DEPLOY.md` = every deploy step.

## State on hand-off (mid-Oct 2026)
- Code complete for Phases 1–3. All suites green on this commit, run one at a time on a local validator:
  `npm test` 298 · `node e2e/run.js` 67 · `node e2e/local.js` 32 · `node e2e/sandbox.js` 64 · `node e2e/smoke.js` 47.
- Devnet: the owner's Mac is running `VEYL-DEVNET.command` with `CORE_ONLY=1` (12 pools). It is waiting on devnet SOL for
  its deployer. When it finishes it writes `deploy.devnet.json` (public addresses only, meant to be committed).
- Never deployed to mainnet. Mainnet is blocked by `npm run preflight -- --network mainnet` until the key ceremony, real
  config and (owner's call) an audit are done.

## Setup (about 30 minutes)
1. Node 20+, Solana CLI (Agave) **3.1.9**: `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"`.
   Rust + `cargo-build-sbf` only if you rebuild the programs (`npm run build`); the built `.so` files are in `target/deploy`.
2. `npm ci`
3. Quick check: `node e2e/smoke.js` (3 min, no validator). Then `node e2e/local.js` (starts a local validator, 2 min).
4. Browser demo with no chain at all: `npm run build:site -- --network local && npm run serve:site`, then open
   `http://localhost:8873/app.html?mode=sandbox-dev` (real proofs, simulated chain; the build writes the sandbox config).
5. `npm run bundle` after editing anything in `engine/` or `sdk/` (it writes `site/veyl-sol.js`).

Tests share `deploy.local.json` and the validator ports: never run two suites at once.

## Rules from the owner (keep these)
- No real names or personal details anywhere in the product, demos or fixtures. Invented names only.
- No fake stats, testimonials, partners, audit badges or security claims. Keep the "not yet had an independent audit" line
  until an audit is actually published.
- Look: black + green (`--paper #0A0B09`, accent `#C8F560`), Manrope + IBM Plex Mono, Apple-calibre, never generic.
- UI work never changes circuits or crypto. Protocol changes get tests and go through review.
- Mainnet keys are never committed, pasted into chat tools, or held by anyone but the owner/multisig signers.

## The work, in order

### Day 1: devnet live and permanent (≈ 1 day)
1. **Finish the devnet deploy.** Either the owner's Mac run completes (then commit `deploy.devnet.json`), or deploy your own
   devnet instance with your own throwaway key: `CORE_ONLY=1 ./VEYL-DEVNET.command` or the manual steps in `DEPLOY.md`.
   The launcher prints the SOL it needs: about 30 for the 12 core pools (faucet.solana.com, other devnet faucets, or any devnet wallet). A paid/free RPC key (Helius,
   QuickNode) avoids public-RPC rate limits during the program deploy: `RPC_URL=...`.
   If a program deploy dies half-way, reclaim the SOL in abandoned buffers: `solana program close --buffers -k <key> -u devnet`.
2. **Host it.** Site on Vercel (`RELAYER_URL=https://<relayer> npm run build:site -- --network devnet`, deploy `dist/site/`)
   and relayer on Render (`render.yaml`, Docker `relayer/Dockerfile`; it reads the committed `deploy.devnet.json`). Render env:
   `RPC_URL`, `RELAYER_SECRET_KEY`, `POSTMAN_SECRET_KEY`, `FAUCET_SECRET_KEY` (devnet deployer key: mock-mint authority, devnet
   only), `ALLOWED_ORIGINS` = the site origin. Keys go in the dashboard only.
3. **Walk the whole flow on devnet**, desktop and phone: Get started → No wallet needed and wallet connect (Phantom set to
   devnet) → Get test tokens → Move into private balance → add liquidity (Private) → instant swap → claim fees → Withdraw
   to a fresh address. Note proof times on a phone.

### Days 2–4: testers, fixes, ceremony (≈ 2–3 days)
4. **Tester round** (10–20 people). Expect devnet-only issues: RPC rate limits, blockhash expiry on slow proofs, priority
   fees, mobile proving time, wallet adapters on devnet. Fix, re-run the suites, redeploy (`--upgrade` for programs).
5. **Key ceremony** for all five circuits with 3–5 independent contributors: `ceremony/README.md` (rehearsed; see
   `ceremony/rehearsal/RESULT.json`). Then rebuild with the new keys and verifying keys (`npm run build`), re-run the suites,
   publish the transcript. Preflight re-verifies the whole ceremony.
6. **Deposit screening for mainnet.** `relayer/denylist.json` is a static list today. Before real money: fill it from a real
   sanctions/stolen-funds source and keep it updated (a scheduled job), since the approved-set publisher screens every deposit.

### Days 4–7: mainnet prep (≈ 2–3 days, in parallel with the audit)
7. **Audit package.** Freeze a commit; scope = the three programs, the five circuits, `engine/shield-engine.js` +
   `sealed-engine.js`, `relayer/`. Hand over `README.md`, `PRIVACY.md`, `REVIEW.md` (internal findings and fixes).
   Fix findings, re-run everything, get the fixes re-checked.
8. **`config/mainnet.json`**: clear every `VERIFY` (RPC, USDC/USDT mints checked against the issuers, launch prices,
   relayer URL and pubkeys, sealed params). `npm run keys:mainnet` creates fresh program IDs outside the repo.
9. **Multisig** (Squads) for upgrade, factory, fee and publisher authorities: `npm run handover -- --network mainnet ...`
   right after the deploy (`DEPLOY.md`).
10. **Guarded launch config**: 3 pools (SOL/USDC, SOL/USDT, USDT/USDC), sealed swaps off (no transcript = the deploy skips
    them), invite-only, small deposits (add a per-deposit size cap to the publisher's `isAllowed` in `relayer/screening.js`:
    not built yet; refused deposits can be taken back by the depositor), a "Beta, unaudited" banner until the audit is published.
    The owner runs the mainnet deploy with their own keys: `npm run preflight -- --network mainnet`, then
    `npm run deploy -- --network mainnet --confirm-mainnet`.

### Later (not blocking a guarded launch)
- Sealed swaps on mainnet need a real committee of independent operators (`committee/README.md`, dealerless DKG).
- Open pool creation (roadmap: listing bond + duplicate check + a Create page). Not before the owner asks.
- Batched liquidity actions ("Phase 4": hide each add/remove inside a per-minute batch, like sealed swaps). Proposed, not
  started; needs a new circuit, so it belongs before or inside the audit, not after.
- Copy: the owner may rename "price bins" to "price levels" in user-facing text (undecided).
- Rebrand directions are in `archive/design/rebrand-options/` (open the `.dc.html` boards in a browser; `canvas.json` lays them out).

## Time estimate for an experienced Solana + ZK engineer
- Devnet live, hosted and walked through: **1 day** (mostly waiting on devnet SOL).
- Tester round, fixes, key ceremony: **2–3 days** (ceremony time depends on contributors).
- Mainnet-ready minus the audit: **about 1 week**. Audit findings and re-checks add whatever the audit finds.

## What only the owner can do
- Add collaborators on GitHub; create the Vercel / Render accounts (or invite you); devnet SOL top-ups if using the
  owner's deployer.
- Pick ceremony contributors and multisig signers; buy the mainnet SOL (about 25 SOL peak, about 16.5 SOL stays as rent; `DEPLOY.md` Cost);
  provide launch liquidity; book the audit; get legal advice before taking public deposits.
- Run the mainnet deploy with their own keys.
