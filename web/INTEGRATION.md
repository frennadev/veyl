# How the app integrates the Veyl programs

How `/app` talks to the on-chain programs, how its React code is structured, and the rules for adding to it. Read web/README.md
first (how the export, the CSP and script loading work).

## The integration contract
Everything that touches the chain is in the **browser engine** (`engine/` + `sdk/`, bundled into `site/veyl-sol.js` as
`window.Veyl`). It builds the instructions, makes the proofs, signs with the wallet or a one-time key, and talks to the relayer.
The UI never imports `@solana/web3.js`, never builds an instruction and never calls the relayer directly; it calls the engine
through typed ports. That keeps the programs, the circuits and the privacy rules (what is public, what is hidden) in one audited
place, so a screen can't leak a wallet link by building its own transaction.

```
React components ──► hooks / services ──► ports (TypeScript interfaces, lib/veyl/types.ts)
                                              ▲
                                  lib/veyl/runtime.ts (the only file that reads window.Veyl / VEYL_CONFIG)
                                              ▲
                     site/veyl-sol.js (engine/ + sdk/)  ──►  RPC · relayer · prover worker · programs
```

Three runtime modes, picked from `?mode=` and `localStorage['veyl:mode']` (`lib/veyl/mode.ts`):
- **Sandbox** (`sandbox-dev`): `new Veyl.Sandbox(window.VEYL_SANDBOX)`, an in-browser chain with real proofs.
- **On-chain**: `new Veyl.Engine(window.VEYL_CONFIG)`, when the build wrote a deployment config.
- **Preview**: no config. The app shows the listed pools (`lib/veyl/previewPools.ts`) and can't transact.

| Program feature | Engine call | Owner in web/ |
|---|---|---|
| Wallets (Wallet Standard) / no-wallet deposit address | `Engine.wallets`/`walletList`/`onWallets` (engine/wallets.js), `connect`, `connectLocal`, `localSweep` | `features/session` |
| Shielded deposit / send / withdraw | `deposit`, `withdraw` (Veyl address → `send`, Solana address → `shieldWithdraw`), `cancelDeposit`, `migrate` | `features/portfolio` |
| Private and public balances | `refreshNotes`, `privateBalance`, `publicBalance`, `shieldNotes`, `shieldPendingNow`, `legacyNotes`, `veylAddress` | `lib/veyl/services/balances`, `features/portfolio/balances` |
| Pool reads and figures | `poolState`, `humanPrice`, `binForPrice`, `poolStats` (sandbox), `usdMap` + `poolStatsChain` (chain) | `lib/veyl/services/pools`, `features/pools`, `features/pool` |
| LP: add, zap, remove, claim, rewards, rebalance | `addLiquidity`, `zap`, `planZapPreview`, `removeLiquidity`, `claimFees`, `claimReward`, `rebalance`, `rebalanceLimit`, `positionInfo` | `features/pool/panel`, `features/positions` |
| Limit orders | `placeOrder`, `withdrawOrder`, `orderInfo`, `myOrders` | `features/pool/panel`, `features/positions` |
| Swaps | `quoteRoute`, `swap` (private), `swapPublic` | `features/swap`, `features/pool/panel` |
| Sealed batch swaps | `sealedState`, `sealedSwap`, `mySealedSwaps`, `sealedClaim` | `features/sealed` |
| Backup / restore | `exportEncrypted`, `importEncrypted` | `features/backup` |
| Market prices, external markets | `Market` (`usd`, `refresh`, `why`), `Markets` (`list`, `search`, `detail`) | `features/market`, `features/markets` |
| Devnet faucet | relayer `POST /drip` | `features/session/AccountDialogs` |
| Progress of long actions | `engine.onLog` (all modes), `engine.on('proving' / 'verified')` (sandbox) | `features/actions` |

## Architecture
| Layer | Where | Rule |
|---|---|---|
| Runtime | `lib/veyl/runtime.ts`, `lib/veyl/mode.ts` | The only code that reads `window.Veyl`, `VEYL_CONFIG`, `VEYL_SANDBOX`. Loads the scripts in order, then builds the engine for the mode. |
| Ports | `lib/veyl/types.ts` | Interfaces split by job (`WalletPort`, `BalancesPort`, `PoolReadPort`, `LiquidityPort`, `PositionsPort`, `SwapPort`, `SealedPort`, …). A component takes the one it needs. |
| Services | `lib/veyl/services/*` | Plain functions over ports: pool figures, filters and sorting, balances, liquidity maths (ranges, volatility, the simulator). No React, no DOM. |
| Helpers | `lib/format.ts`, `lib/storage.ts`, `lib/store.ts`, `lib/tokens.ts` | Formatting, safe `localStorage`, Zustand stores (`createStore` / `useStore`), token marks. |
| Client state | `features/session/session.ts`, `*/state.ts`, `lib/store.ts` | Zustand: the session (engine, mode, account, RPC and relayer status, `version`, `tick`) and one store per concern (UI state only: filters, panel, route, dialogs). |
| Server data | `features/session/query.tsx` | React Query, one `QueryClient`: every read (chain, relayer, market APIs) is a keyed query through `useChainQuery` (data, polling, streamed partial rows) or `useAsyncQuery` (debounced quotes, previews, token checks). Keys start with the network; account-specific data carries the account and is never persisted; public data marked `persist` is kept in this browser for an hour so return visits are instant. Polling pauses while hidden or busy; `invalidate()` and the Sandbox chain moving refetch every active query, never cancelling a running one. |
| Charts | `components/charts/CandleChart.tsx` | TradingView Lightweight Charts (Apache-2.0, attribution logo kept): candles or a line with volume. Pool candles come from the relayer's trade index (`GET /candles`, every pool at once); the Markets drawer uses GeckoTerminal. |
| Actions | `features/actions/runAction.tsx` | Every engine write: the steps for its kind (proof / sign / wallet), the engine's own progress messages, errors, the done screen, the activity entry, then `invalidate()`. A new action is an `ActionSpec`. |
| UI | `components/`, `features/<screen>/` | app.css classes and the element ids / `data-*` attributes the e2e suites select on. |

SOLID and DRY, concretely:
- **Single responsibility**: loading the runtime, reading data, formatting, running actions and rendering are separate modules.
- **Open/closed**: pages (`features/shell/pages.tsx`), pool-table columns (`features/pools/columns.tsx`), the panel's tabs
  (`features/pool/panel/tabs.tsx`), action kinds and price presets are lists. A new one is an entry, not an edit to a switch.
- **Liskov**: Sandbox, on-chain and preview satisfy the same ports; preview is a null engine plus the static pool list.
- **Interface segregation**: components get narrow ports, not the whole engine.
- **Dependency inversion**: screens depend on `types.ts`; only `runtime.ts` knows the engine is a global.
- **DRY**: one formatter set, one dialog, one action runner, one amount box, one "send to" picker, one icon sprite, one
  balance label, one `usdOf`.

## Rules for code in web/
- Engine writes go through `runAction()` only. Every read goes through `useChainQuery` / `useAsyncQuery` (or `queryClient` outside React), never a hand-rolled `useEffect` fetch. Server data never goes into a Zustand store.
- Account-specific queries pass `account: true` (the account joins the key; never persisted). Only public data passes `persist: true`.
- No `window.Veyl`, `window.VEYL_*` or `localStorage` outside `lib/veyl/runtime.ts`, `lib/veyl/mode.ts` and `lib/storage.ts`.
- No `dangerouslySetInnerHTML`: engine strings (errors, addresses) render as text.
- A `useSession`/`useStore` selector returns a primitive or a stable reference, never a fresh object or array.
- Copy follows CLAUDE.md: plain words (Private/Public, Withdraw), no fake stats, keep the audit line.
- Keep the element ids and `data-*` attributes the e2e suites use; add new ones only when needed.
- Static export: `<a href="app.html#…">`, never `next/link`.
- Don't change circuits, crypto or engine behaviour for UI work. If the UI needs something new from the engine, add it there
  (with a test), rebuild the bundle (`npm run bundle`), then add it to the port.

## History and verification
The app was rebuilt from the 158 KB `site/app.js` screen by screen, then took over `/app` (Oct 2026). `site/app.js`,
`site/app.html`, `site/index.html` and `site/docs.html` are gone; `scripts/demo.js` and `scripts/dist.js` build through
build-site. Verified on the React `/app`: `e2e/sandbox.js` 64/64, `e2e/smoke.js` 47/47, `e2e/local.js` 32/32, and an
end-to-end run on live devnet (all 28 pools priced from chain, deposit address, faucet, deposit, admission by the postman, a
private withdraw with a real proof through the relayer).

## Open pool creation and fees (built ahead of the engine)
The UI for permissionless pools and the 0.2% protocol fee is built against the agreed engine spec and switches on by
feature detection, so nothing shows until the engine ships each call or field:
- `listPools` → the pool list comes from chain (`features/pools/usePoolViews.ts`, the `poolDirectory` query); `status` / `tier` / `crowd`
  → Unverified/Delisted badges, the status chips and a "Delisted" toggle on Pools, the pool page notice, Add/Zap/Limit blocked
  on delisted pools (`features/pools/PoolBadge.tsx`, `features/pool/PoolStatus.tsx`).
- `createPool` (+ `listTiers`, `checkToken`, `poolFor`, `bondTerms`) → the Create pool page and its nav entry
  (`features/create/CreatePoolPage.tsx`); `bond` / `releaseBond` → the bond card on the pool page.
- `Engine.PROTOCOL_FEE_BPS` and quote `lpFee` / `protocolFee` → fee rows in swaps, the pool page cost line and parameters.
Checked against a stand-in for those calls injected into the Sandbox; re-check against the real engine when it lands.

## Follow-ups
- The 12 built-in pools are defined only in `scripts/lib.js`, so `lib/veyl/previewPools.ts` repeats them. Moving `BIN_POOLS`
  to `config/pools.json` would give the deploy, the tests and the site one list.
- The engine has no type declarations; `lib/veyl/types.ts` types what the app uses. An `engine/index.d.ts` would let the
  engine own them.
- First private-balance sync on a fresh device takes about a minute on devnet (the engine rebuilds every note by scanning the
  shielded tree). The app shows that it's reading; making the scan faster is engine work.
- Optional: import `engine/sol-entry.js` as an ES module through Next instead of the IIFE bundle (needs the Buffer polyfill,
  `global → window` and the snarkjs global solved in the Next build). Nothing above the ports changes.
