# Veyl roadmap

What stands today, what is next, and what could come later. The homepage shows the same list in user terms; this file adds the technical note behind each line. Nothing here is a promise or a date.

## Now

| Milestone | State | Note |
|---|---|---|
| Built and tested | done | Three Anchor programs (`veyl_pool`, `veyl_bin`, `veyl_entry`), five Groth16 circuits, the relayer and the batch committee; `npm test` (298 on a local validator), `npm run e2e` (69), `npm run e2e:sandbox` (70), `npm run e2e:local` (26), `npm run e2e:smoke` (53). Internal review done, findings fixed (REVIEW.md). |
| Try it in your browser | done | The Sandbox: the app on a chain simulated in the page (`site/sandbox-chain.js`), real proofs in a Web Worker, a 2-of-3 committee in the page, play money, live market prices. |
| Testnet | next | Solana devnet with mock tokens: `GO-LIVE.command` / `npm run deploy -- --network devnet` (DEPLOY.md). Blocked only on funding the deployer. |
| Security | before mainnet | A multi-party key ceremony for the five circuits (`ceremony/`, rehearsed; the real one not run) and the committee's dealerless key generation among independent operators; then an external audit. Until both, the proving keys are single-machine and the protocol is testnet-only. |
| Curated pools | done | Like Delta, not Meteora: only the factory authority can list a pool (`veyl_bin.create_pool`), and the app has no Create page. The deployer key at first, a multisig after `npm run handover`. |
| Mainnet | after security | Real mints from `config/mainnet.json` (every `VERIFY` cleared), fresh program IDs, preflight green. |

## Later

Features that fit the codebase as it is. Each line says what a user gets, then where it would land.

| Feature | Technical note |
|---|---|
| Open pool creation: any project lists its own pair | Today listing is curated: `create_pool` is gated by the factory authority. Permissionless listing = a listing fee or bond and a duplicate check (one pool per pair per bin step), plus the app's Create page. |
| Bigger shielded positions: more bins per position | A shielded position covers a 16-bin window (`K` in `zk/circuits/position.circom`). Wider = a larger circuit (constraints grow about linearly with K; 32 bins ≈ 2× proving time) or several windows under one note, which the aggregate already allows. |
| Shielded farm rewards | Rewards accrue per share account; the shielded aggregate's shares are pooled, so rewards would be split by a per-bin reward checkpoint inside the position proof, like fees are today (`fee checkpoint` in `position.circom`). |
| A limit price on sealed swaps | A sealed swap settles at the batch's clearing price. A limit = a max/min price bound in the swap proof's public inputs, refunded by the settlement when the clearing price crosses it (`sealed.rs` refund path exists). |
| Multi-hop shielded swaps | `shield_swap` takes one route; the public router (`swap_route`) already does up to three hops. The shielded version needs the hub pools as intermediate vaults in one instruction, or two chained shielded swaps (two proofs). |
| Routing through Jupiter for the best price | The public side can CPI Jupiter v6 for the leg Veyl has no pool for. The shielded side cannot (the relayer's transaction would reveal the amount at Jupiter), so this is a public-mode feature with an honest label. |
| Viewing keys for accountants and reviewers | Notes are encrypted to an X25519 viewing key that derives from the account key (`shield-engine.js`). Exporting the viewing key alone gives read-only access to history without spending power; needs an export dialog and a read-only mode in the app. |
| Hardware-wallet support | Only the deposit is wallet-signed; everything after is a proof. Ledger/Trezor through Wallet Standard adapters for the deposit and the public actions; the shielded account key would be derived from a signed message, as it is now. |
| LP analytics | Fees, P&L and fee/TVL per position over time; the Sandbox ledger and `poolActivity` already compute the inputs. Shielded positions compute this locally from the viewing key, never on a server. |
| A mobile app | The app is a static page with a Web Worker prover; a wrapper (Capacitor) with the proving keys cached on device is the short path. Proving time on a phone is the limit (~2–4× a laptop). |

Not on the list on purpose: a launchpad, snipers, token launches, and any feature that needs an off-chain party to see amounts.
