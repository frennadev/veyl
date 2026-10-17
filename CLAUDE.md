# Veyl: notes for Claude Code

This is the condensed brief; HANDOFF.md is the full one (state, setup, ordered tasks). Then README.md (architecture), DEPLOY.md
(deploy), PRIVACY.md (what's hidden), REVIEW.md (security review).

## What Veyl is
Private concentrated liquidity on Solana, "a private Meteora": DLMM-style bin pools where nobody can link a position, swap or
fees back to the wallet. Liquidity is the product; privacy is the edge; swap is a side feature. Positioning copy: "Concentrated
liquidity, kept private." Inspiration for format: Meteora and Delta Liquidity (take inspiration, never copy their copy or code).

## Status (mid-Oct 2026)
- Code complete for Phases 1–3 (LP mechanics, shielded pool, sealed batch swaps). Not deployed anywhere public yet.
- Devnet is the next step: `VEYL-DEVNET.command` (see START-HERE-DEVNET.md). Mainnet is NOT allowed until the key ceremony
  (`ceremony/`) and an independent audit are done (DEPLOY.md "Before mainnet"). Never run a mainnet deploy without the owner
  explicitly asking, and never handle the owner's mainnet private keys.
- The site/app was only ever published as a static preview (claude.ai artifact) with `window.VEYL_CONFIG=null`, so it can't
  transact there. A real deployment writes `site/veyl.config.js`; host `dist/site/` (Vercel/Netlify) and the relayer (Render,
  `render.yaml`) for a permanent link.

## Pools
- Built-in 12 (`scripts/lib.js` TOKENS/BIN_POOLS) + every major Meteora pair from `config/catalog.json` = 83 pools / 69 tokens on
  devnet (`config/devnet.json`). Devnet tokens are mock mints. `scripts/price-catalog.js` sets opening prices from Meteora's live
  API (CoinGecko fallback); unpriced pairs are skipped by the deploy.
- Local validator + tests deploy only the core 5 (`CORE_TOKENS`/`CORE_POOLS` in lib.js). Keep tests on that set.
- Pools are curated (Delta-style, not Meteora-style): only the factory authority lists pools; there is no Create page. Open pool
  creation is a roadmap item (ROADMAP.md "Later"), not a current feature: don't add one without the owner asking.
- Lookup tables: one table holds 256 addresses, so the deploy makes several (`dep.lookupTables`); SDK `V.lookupExtra`, engine `_luts()`.
- Cost on devnet: the launcher prints it (dry-run peak + ~0.25 SOL/pool seeding + 2 SOL faucet). `CORE_ONLY=1` (12 pools) ≈ 30;
  all 83 roughly twice that. Note: CORE_ONLY's 12 pools ≠ lib.js `CORE_POOLS` (5, for tests).

## Recent features (all tested)
- No-wallet mode ("Get started" → "No wallet needed"): an in-browser deposit address (`localKeypair/connectLocal/localSweep` in
  engine/sol-entry.js), funded from any wallet/exchange; key goes into the encrypted backup. Wallet connect is the second option.
- Native SOL is wrapped automatically on deposit (`wrapIxs`).
- Relayer faucet `POST /drip` (devnet/local only, `FAUCET_KEY` = key file path or `FAUCET_SECRET_KEY` = the key itself): core basket, or a pool's own pair (`tokens: [..]`), 6 h limits.
- Pro LP tools in the app (site/app.js): volatility-sized range presets (Tight/Balanced/Wide), position simulator (fees vs holding at ±30%),
  portfolio summary, per-position edge distance / USD worth / fee APR.
- Receive (Portfolio → Veyl address → Receive): QR code + payment link `app.html#pay=veyl:…&a=<amount>&t=<token>`; opening a link
  pre-fills Send as "Pay privately" (`openReceive`, `takePayLink`, `site/qrcode.js` = qrcode-generator, MIT). Inspired by NullCash's send flow.
- Privacy page + header chip (5 checks, crowd size), plain wording (Private/Public, Withdraw), no "launching soon"/test wording.

## Brand / site rules (from the owner)
- Black + green: `--paper #0A0B09`, accent `#C8F560` (tokens in site/veyl.css `:root`). Manrope + IBM Plex Mono, no serif.
- Logo: 4 pill bins (brand/*.svg). Hero animation = canvas "flow" in index.html (deposits → proof gate → bins).
- Must look professional, Apple-calibre, never generic/AI-made. No grid backgrounds. No fake stats, testimonials, partners,
  audit badges or security claims; keep the "not yet had an independent audit" line. Never put the owner's name or real details
  in the product, demos or fixtures (use made-up names).
- Short homepage (hero, how it works, liquidity tools, pools, privacy, CTA); detail lives in docs.html and the app.
- Don't change the circuits or crypto for UI work.

## Commands
- `npm ci` · `npm run bundle` (rebuild site/veyl-sol.js after editing anything in engine/ or sdk/)
- Layout: site/ = what is served (app.html markup + app.js + app.css); engine/ = browser engine sources (bundled);
  relayer/relayer.js composes relayer/{fees,notes,shielded,sealed,postman,faucet}.js; tests share tests/harness.js, e2e/harness.js.
- Tests (run ONE at a time: they share deploy.local.json and validator ports):
  `npm test` (298, ~20 min) · `node e2e/run.js` (67, ~17–25 min) · `node e2e/local.js` (32) · `node e2e/sandbox.js` (64) · `node e2e/smoke.js` (47)
- Demo mode in the browser: `app.html?mode=sandbox-dev` (in-browser chain, real proofs).
- Devnet: `./VEYL-DEVNET.command` (or the steps in DEPLOY.md). Needs Solana CLI 3.1.x, Node 20+.

## Next steps
The full ordered task list with estimates is in HANDOFF.md. Code lives in the private GitHub repo splashg22/Veyl (main).
1. Devnet launch (fund the deployer from faucet.solana.com), then host site + relayer for a permanent link.
2. Tester round and fixes; key ceremony; mainnet prep (HANDOFF.md).
3. Optional: rename "price bins" to "price levels" in user-facing copy (owner was asked, no answer yet).
4. Before mainnet: key ceremony, external audit, real mint addresses in config/mainnet.json (every "VERIFY:" removed).
