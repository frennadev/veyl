# Veyl on Solana: internal security review

> File paths below are as they were at review time. Since then (Oct 2026) the relayer was split into `relayer/*.js` (same
> code, one module per job) and the browser engine moved from `site/` to `engine/`.

**This is not an external audit.** It is a line-by-line review written as a fresh reviewer would, to find and fix what can be
found before an independent firm looks at the code. The external audit stays open in `DEPLOY.md` and `config/blockers.json`.

| | |
|---|---|
| Scope | `programs/veyl_pool`, `programs/veyl_bin`, `programs/veyl_entry` (all instructions, account constraints, CPI), `relayer/relayer.js`, and the parts of `sdk/veyl.js` / `site/sol-entry.js` that build what the programs check |
| Out of scope | the circuit's logic (unchanged by rule; only its keys are being replaced, see `ceremony/`), the static site's design, third-party crates (anchor 0.31.1, groth16-solana 0.2.0, solana-poseidon 2) beyond how they are used |
| Date | October 2026 |
| Result | 1 High, 6 Medium: all fixed, each with a regression test (`npm test`, test names start with the finding ID). 6 Low: 2 fixed, 4 acknowledged. 8 informational notes. Phase 1 (fees, rewards, limit orders, rebalance, zap, bitmaps): self-review below, 1 Low + 7 Info acknowledged, auditor focus list. Phase 2 (shielded pool, `transact` + `position` circuits): self-review below, 1 Critical (ops: the keys) + 1 Medium + 2 Low + 5 Info acknowledged |

Severity: **High** = theft, or permanent loss of control of a deployment. **Medium** = funds frozen or a user's action
defeated without theft, cheap repeatable denial of service, or value skimmed from users. **Low** = narrow, costly or
self-inflicted. **Info** = design notes and things checked and found sound.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| H-1 | High | Anyone can create the canonical private pool of a mint (and the bin factory) first and own its approved-set publisher | Fixed |
| M-1 | Medium | The relayer can be drained: no absolute fee floor, while every request leaves it paying rent it never gets back | Fixed |
| M-2 | Medium | A posted proof works as a lock: anyone holding a copy can freeze the note indefinitely and block its ragequit | Fixed |
| M-3 | Medium | Creating a pool's vault token account in advance blocks that pool from ever being listed | Fixed |
| M-4 | Medium | The 128-root history can be flushed with a burst of cheap, refundable deposits, invalidating every proof in flight | Fixed |
| M-5 | Medium | `private_add` has no lower bound on shares: the composition fee (up to 10%) can be forced on the position | Fixed |
| M-6 | Medium | A dust side (below the pool's minimum deposit) makes `private_remove` and small private swaps revert | Fixed |
| L-1 | Low | The relayer puts token-account creation between the ed25519 instruction and `private_remove`: public-payout removals always fail | Fixed |
| L-2 | Low | The relayer's rate limit is keyed on the proxy's address behind Render | Fixed |
| L-3 | Low | Listing does not screen Token-2022 extensions (transfer fee, hooks, permanent delegate) | Acknowledged (listing is authority-only after H-1; DEPLOY.md) |
| L-4 | Low | An expired post can still be executed, and cancelled by anyone: a race, both outcomes as signed | Acknowledged |
| L-5 | Low | A bin with shares but zero value mints new shares 1:1 | Acknowledged (same as EVM; not reachable profitably) |
| L-6 | Low | A user can make the relayer post, then make execution fail, costing it a few signature fees | Acknowledged (fee floor + rate limit) |
| I-1..I-8 | Info | Trust in the postman, screening, deposit-record collisions, rent, lookup table, ed25519, context coverage, Groth16 and arithmetic | Notes |

---

## H-1: Anyone can create the canonical private pool of a mint (and the bin factory) first

**Location.** `programs/veyl_pool/src/lib.rs` `init_pool` / `InitPool` (before: any signer); `programs/veyl_bin/src/lib.rs`
`init_factory` / `InitFactory` (before: any signer).

**Problem.** A mint's private pool lives at the fixed address `["pool", mint]`, and the first caller of `init_pool` became its
`authority` and chose its `postman`. The factory is `["factory"]`, and the first caller of `init_factory` became its authority.

**Exploit sketch.** Watch for the mainnet program deployment (it is public), then call
`init_pool(USDC, min_deposit = 1, postman = attacker)` before the deployer's `deploy.js` gets there. The app, the SDK and the
entry program all derive the USDC pool from the mint, so every user deposits into it. As postman the attacker decides which
deposits are approved (approve their own stolen funds), can freeze every private exit (`reset_asp_roots`), and nobody can
replace the pool: the only recovery is a new program ID. `init_factory` gives the same attacker the bin-pool listing.

**Fix.** Both instructions now take the program and its `ProgramData` account and require the signer to be the program's
**upgrade authority** (`program.programdata_address() == program_data`, `program_data.upgrade_authority_address == signer`).
After the handover that is the multisig.

**Regression tests.** `H-1: a stranger cannot create (squat) the private pool of a mint`; `H-1: a stranger could not create the
bin factory right after the deploy (upgrade authority only); the deployer did` (the test deploys the programs, lets a stranger
try first, then runs the normal initialisation).

## M-1: The relayer can be drained (no absolute fee floor)

**Location.** `relayer/relayer.js` `submit` (before: only `MIN_FEE_BPS`); the `Spend` PDA (250 bytes, never closed: it is the
spent marker), recipient token accounts, deposit records and nonce PDAs the relayer pays for.

**Problem.** The fee is a percentage of the amount. Every relay leaves the relayer paying about 0.00263 SOL of rent for the
spent marker, 0.00204 SOL for the recipient's token account and two signature fees, none of which come back.

**Exploit sketch.** Deposit 1 USDC, then request a thousand relays of 1 micro-USDC each to fresh addresses at 5 bps. The fee
rounds to zero; the relayer spends about 4.7 SOL. The attacker's capital (the 1 USDC, minus nothing) comes back as change
notes. The per-IP rate limit did not help (see L-2).

**Fix.** The relayer computes what each request costs it exactly (rent of every account the request creates, checked on
chain, plus signature fees: `costOf`) and refuses unless the fee covers it at the configured prices (`deploy.<network>.json`
prices, `PRICES_JSON`, multiplied by `FEE_COVER`). `POST /fee` tells the app the smallest fee it will accept for a request, and
the app uses it (a small amount pays a higher rate; an amount whose cost would exceed the on-chain 1% cap is refused with a
clear message). `/info` publishes a worst-case table per action and token.

**Regression tests.** `M-1: /fee refuses an amount whose fee could not pay the relayer back within the 1% cap`;
`M-1: /fee prices the request's real cost ...`; `M-1: /submit refuses a fee that does not cover the relayer's cost before
sending anything`.

## M-2: A posted proof works as a lock

**Location.** `veyl_pool` `post_withdrawal` (before: `init` of `["null", pool, nullifierHash]` with a free `processor`),
`cancel_post` (before expiry: poster only), `ragequit` (before: `init` of the same PDA).

**Problem.** Posting created the nullifier PDA. Only the poster could cancel before the TTL, the processor named in the post
was arbitrary, and `ragequit` needs that PDA not to exist.

**Exploit sketch.** A relayer that receives a user's proof (relayers are untrusted by design), or anyone who saw a proof on
chain after a failed attempt, posts it with `processor = itself` and `ttl = 9000`. It cannot execute it (the context binds the
entry's signer), but nobody else can post the note either. Just before expiry it cancels and posts again, and can keep doing
so as long as the proof's roots are in the history. Meanwhile the depositor's `ragequit`, the exit that is supposed to always
work, fails because the PDA exists. The README's "at most the post's TTL (one hour)" bound did not hold.

**Fix.** A posted spend is no longer a lock. `post_withdrawal` uses `init_if_needed`: a newer valid proof for the same nullifier
**replaces** a spend that has not been executed (the new poster pays the previous one back exactly the rent-exempt minimum, so
lamports donated to the PDA cannot make replacing expensive); a spent one is final (`AlreadySpent`). `ragequit` overrides a
posted-but-unexecuted spend. The relayer now posts and executes a relay in **one** transaction, so its proof is never parked on
chain; it fills in the previous poster when it has to replace one.

**Regression tests.** `M-2: replacing a post must name its poster`; `M-2: a squatter can re-post a public proof with its own
processor, but pays the earlier poster back`; `M-2: ...and the next valid post replaces the squatter at once`; `M-2: bob
ragequits his deposit although a squatter posted its proof`; `M-2: the service posts and executes a relay in ONE transaction`;
plus `posting a spent nullifier again is refused (AlreadySpent)`.

## M-3: Creating a pool's vault token account in advance blocks the listing

**Location.** `InitPool.vault`, `CreatePool.vault_x` / `vault_y` (before: `init` of the associated token account).

**Problem / exploit.** The vault is the associated token account of the pool PDA, whose address is known before the pool
exists, and anyone may create an associated token account for any owner (about 0.002 SOL). Creating it first made `init_pool`
for that mint fail with "already in use" forever: there is no other address the pool could use. One cheap transaction blocks
USDC.

**Fix.** `init_if_needed` with the same `associated_token::mint/authority/token_program` constraints, so an existing account
is accepted only if it is exactly that ATA (anything already in it simply belongs to the pool).

**Regression test.** `M-3: the upgrade authority lists the pool even though a stranger created its vault token account first`.

## M-4: The root history can be flushed cheaply

**Location.** `Pool::insert`, `ROOT_HISTORY` (before: 128 entries, one per insert).

**Problem / exploit.** A proof names a state root, which must be one of the last 128. 128 minimum deposits (1 USDC each, five or
six per transaction; all refundable later through `ragequit`, rent included) push every root out, so every proof made before
fails with `UnknownStateRoot`. Repeating it costs signature fees only, which blocks private withdrawals for everyone.

**Fix.** One history entry **per slot**: inserts in the same slot update that slot's entry (clients only ever see end-of-slot
roots), and the history holds 192 entries (the most the 10 KiB a program may allocate by CPI allows). A root now stays valid
for at least 192 slots, about 77 seconds, however many deposits an attacker sends; a browser proof takes 10 to 30 seconds.
Keeping proofs failing now needs a deposit landed in every single slot, sustained, rather than one burst. `Pool` gains a
`root_slot` field (the SDK decodes it).

**Regression test.** `M-4: five deposits in one slot: 5 leaves, 1 new root-history entry (the end-of-slot root)`.

## M-5: `private_add` has no lower bound on shares

Carried over from the EVM review (open there as Medium).

**Location.** `veyl_entry` `private_add` (`min_shares` could be empty), `site/sol-entry.js` `addLiquidity` (sent `[]`).

**Problem / exploit.** A private add is executed after its proof is public (post, then execute). A searcher who moves the active
bin onto the user's bins in between makes the one-sided add pay the composition fee, up to 10%, to the bin's existing
liquidity providers, which can be the searcher. Nothing bounded the shares the user got.

**Fix.** `private_add` requires a minimum for every bin (`MinSharesRequired`); the relayer refuses a request without them; the
app computes what each bin gives right now with the exact JavaScript twin of the bin maths and allows 1% less.

**Regression tests.** `M-5: a mint that would give fewer shares than its min_shares is refused (TooFewShares)`; `M-5: a private
add without min_shares is refused (MinSharesRequired)`; the private add test now passes real minimums.

## M-6: A dust side makes `private_remove` (and small private swaps) revert

Carried over from the EVM review (open there as Medium).

**Location.** `veyl_pool` `deposit` (minimum deposit applied to the entry's payouts), reached from `veyl_entry` `payout`.

**Problem / exploit.** After trading, one side of a position often holds a little: say 0.0003 SOL, below SOL's 0.0005 minimum.
`private_remove` puts each side back into the private balance as a deposit, which reverted, so the whole removal failed. The
only other way out, a public payout, also failed through the relayer (L-1). The same applied to any private swap whose output
was below the minimum.

**Fix.** Deposits made by the entry program's signer PDA (swap and removal proceeds) are exempt from the minimum (they must
still be above zero); wallets still pay at least the minimum. `veyl_pool` knows the entry program ID per build profile
(`ENTRY_PROGRAM`, written by `npm run keys:mainnet` for mainnet).

**Regression tests.** `M-6: a private swap whose output (... lamports) is below the SOL pool's 0.0005 minimum still becomes a
note`; `M-6: a wallet's own deposit below the minimum is still refused`.

---

## L-1: Public-payout removals through the relayer always failed

`relayer/relayer.js` (remove): the ed25519 instruction came first, then the recipient's token-account creations, then
`private_remove`, but `check_ed25519` requires the signature instruction **immediately** before. Fixed: token accounts are
created first. Test: `L-1: a removal to a public wallet goes through the relayer service`.

## L-2: Rate limit keyed on the proxy

Behind Render every request came from the proxy's address, so one client could use up everyone's 30 requests a minute (and an
attacker was never limited per client). Fixed: `TRUST_PROXY=<n>` keys on the address the n-th proxy from the right appended to
`X-Forwarded-For` (a client cannot spoof the entries a proxy appends); `render.yaml` sets 1. Still never logged. Test: `L-2`.

## L-3: Token-2022 extensions are not screened at listing

A mint with a transfer fee would make the bin pool's accounting assume amounts it does not receive; a permanent delegate could
move funds out of a vault; a transfer hook would make transfers fail. `deposit` measures what arrived, but swaps and payouts do
not. Since H-1, only the upgrade authority can list a pool, and `DEPLOY.md` says to list classic SPL Token mints (USDC, USDT,
wrapped SOL) only. USDC and USDT have a freeze authority: their issuers can freeze any vault. That is inherent to those tokens.

## L-4: Expired posts stay executable

`withdraw` does not check the post's TTL; after it, anyone may also `cancel_post`. Whichever lands first wins. Both outcomes are
ones the user signed (execution as committed in the context, or the note back unspent), so this is kept.

## L-5: A bin with shares and zero value mints 1:1

`veyl_bin` `mint`: when a bin has shares but `x * price + y` rounds to zero, new shares are minted 1:1 with liquidity, so
earlier shares (including the locked `MIN_LIQUIDITY`) claim part of the new deposit. Reaching that state needs a bin drained to
dust at a price where dust rounds to zero, and the dilution is bounded by the locked 1,000 shares. Same formula as the EVM
build; kept for bit-identical maths.

## L-6: Making the relayer post a request that then fails

A user can set a swap's `min_out` just above what execution will give: the relayer posts (one fee), execution fails (dry-run,
no fee), and the relayer cancels (one fee; the rent comes back). Two signature fees per attempt, rate-limited. Kept.

---

## Informational

**I-1 Trust in the postman.** The postman (approved-set publisher) can stop approving deposits or reset the approved set, which
freezes private exits. Original deposits can always `ragequit` (now even against a parked proof, M-2), but change notes have no
deposit record and cannot. This is the design of the unchanged circuit. Mitigation: the postman on its own key or a multisig
(`npm run handover -- --postman`), never the relayer's hot wallet (preflight checks).

**I-2 Screening is address-based.** The publisher screens a deposit's payer and beneficiary; one public hop before depositing
avoids the list. Inherent to address lists.

**I-3 Deposit-record collisions.** A swap or removal output's deposit record is derived from the pool's next deposit nonce, so
two outputs into one pool in the same slot make the second fail (the relayer cancels; the user retries).

**I-4 Rent that never comes back.** Spent markers, removal nonces and the records of deposits that were later spent privately
stay on chain; the relayer pays for them and its fee floor (M-1) now covers it.

**I-5 Lookup table.** The relayer's address lookup table stays under the deployer's authority (it cannot be transferred). Once
the relayer works, `npm run handover -- --freeze-lut` freezes it.

**I-6 ed25519 introspection (checked, sound).** `check_ed25519` loads the instruction at `current_index - 1` from the
instructions sysvar (address-checked), requires the ed25519 program, exactly one signature, all offsets pointing into that same
instruction (`u16::MAX`), the owner's public key, and a 32-byte message equal to
`sha256("veyl-remove-v1" || entry program id || borsh(RemoveData))`. `RemoveData` contains every field that moves value (owner,
pool, bins, shares, both output commitments, recipient, fee recipient and rate, nonce, deadline). The `["nonce", owner]` PDA
stops replay; the program ID in the digest stops cross-deployment replay (mainnet now has its own IDs). Invoking
`private_remove` by CPI does not help an attacker: the check still reads the transaction's top-level instructions.

**I-7 What the proof's context binds (checked, no gap).** `context = sha256("veyl-context", processor, tag || borsh(data),
pool)`, masked to 253 bits; `withdrawnValue`, the nullifier and the change note are public signals of the proof itself.

| action | bound by the proof / context | checked by the programs |
|---|---|---|
| relay | value; recipient, fee recipient, fee rate, deadline; the entry's signer as processor; the pool (so the mint) | recipient and fee accounts' owners; fee <= 1%; deadline |
| private_swap | value; output token, every route (amount, pools, direction, number of bin arrays), minimum out, recipient or output commitment, refund key, fee recipient and rate, deadline | route accounts are the named pools; each hop's output account is the entry's; final output token; sum of routes = value - fee |
| private_add | value per leg; pool, bins, amounts per bin, minimum shares (now required), owner, fee recipient and rate, deadline | amounts per side = value - fee; minimum shares per bin |
| private_remove | ed25519 signature over `RemoveData` (I-6) | nonce; fee <= 1% |

**I-8 Groth16, CPI and arithmetic (checked, sound).** Proof A's y is negated on chain; `groth16-solana` rejects public inputs
outside the field; zero roots are never "known"; the syscalls check points are on the curve and in the subgroup. Program
accounts in CPIs are `Program<VeylPool>` / `Program<VeylBin>` (ID-checked); the entry's signer PDA is the only processor and
signs only inside instructions whose amounts are computed, never caller-chosen; its token accounts are checked as its own ATAs.
`veyl_bin` checks every bin array and share account against its PDA seeds and pool; amounts use checked adds, 512-bit
intermediates for `mulDiv`, and round in the pool's favour (shares down, inputs up, outputs down); the fee formula cannot
overflow u128 for any `variable_fee_control` (bounds in the code). Return data from `withdraw` / `swap` is read right after
the CPI that set it.

## Areas reviewed

Account validation and owner checks; signer and authority checks (two-step transfers, postman, factory); PDA seeds of every
account; nullifiers and double spend (post, execute, ragequit, cancel); Merkle root history and the approved-set ring;
approved-set update authority; public-input binding; front-running of `post_withdrawal` and `cancel_post`; bin maths
(rounding, overflow, fee extraction, `MIN_LIQUIDITY`, composition fee); CPI privileges between the three programs; ed25519
introspection; relayer fee caps, griefing and rate limiting; rent and account closing.

## Phase 1 self-review (October 2026): Meteora-grade LP mechanics

**Still not an external audit.** This section reviews the code added for Phase 1 the same way as above: what it does,
how each new instruction validates its accounts, what was checked and found sound, what is acknowledged, and where an
external auditor should spend their time. The circuit, zkey, vkey and `veyl_pool` are unchanged (`veyl_pool.so` is
byte-identical to the recorded build).

### What was added

| Program | Instruction | Signer that moves value | Notes |
|---|---|---|---|
| veyl_bin | `swap` (rewritten), `quote` | the swapper | bitmaps skip empty ranges; fee split (protocol / market makers / limit orders) |
| veyl_bin | `mint`, `burn` (changed) | `from` / share authority | settle fees and rewards before shares change; bitmaps; burn pays reserves only |
| veyl_bin | `claim_fees`, `claim_reward` | share authority | pays settled + accrued balances; duplicates in remaining accounts dropped |
| veyl_bin | `place_limit_order`, `withdraw_limit_order` | `from` / share authority | per-bin, per-side order pools apart from market-making liquidity |
| veyl_bin | `rebalance_position`, `swap_and_add` | share authority / `from` | burn + re-add by weights; zap swaps through the pool itself, output never leaves the vault |
| veyl_bin | `set_protocol_share`, `withdraw_protocol_fee`, `propose/accept_fee_authority` | factory **fee authority** | share capped at 25%; withdrawal capped at the accounted balance |
| veyl_bin | `init_reward`, `fund_reward`, `set_reward_funder`, `withdraw_ineligible_reward` | factory authority / reward funder | the funder can take back only emission that fell on an empty active bin |
| veyl_entry | `private_claim_fees`, `private_withdraw_order`, `private_rebalance`, `private_claim_reward` | ed25519 by the position's one-time key | same check as `private_remove`, one domain tag per action, shared nonce |
| veyl_entry | `private_place_order`, `private_zap` | Groth16 proof (context binds the whole action) | one note leg; zap needs a minimum per bin and a swap minimum |

### Account validation, per REVIEW standards

- **Pools, arrays, share accounts.** Every bin instruction takes the pool as `AccountLoader<BinPool>` (owner + discriminator),
  and its mints, vaults and token programs by `address = pool.<field>`. Bin arrays and share accounts come through
  `find_accounts`: owner = `veyl_bin`, discriminator, and the stored `pool` (and `owner` / `authority` for share
  accounts). Phase 1 dropped the per-account `find_program_address` re-derivation (up to ~10k CU each): the stored
  `pool / owner / authority / chunk` are written only by `init_bin_array` / `init_shares`, from exactly the values in the
  PDA seeds, so stored identity == PDA identity. Duplicate accounts are dropped (a share account listed twice would
  otherwise pay its pending balance twice; regression-tested by the fee conservation checks).
- **Who may move value.** Out of the vaults: `burn`, `claim_fees`, `withdraw_limit_order`, `rebalance_position` need the
  share authority's signature (and only touch share accounts naming it); `claim_reward` likewise from the reward vault;
  `withdraw_protocol_fee` needs the factory's fee authority (PDA seeds + `has_one`) and is capped at the accounted
  balance; `withdraw_ineligible_reward` needs the slot's funder and pays only `ineligible`. In the entry program every
  new private action either spends a proof (context = `tag || borsh(data)`, so owner, bins, weights, minimums, fee and
  deadline are all bound) or verifies the one-time key's ed25519 signature over `sha256(tag || program id || borsh(data))`
  with a per-action tag (`veyl-claim-v1`, `veyl-order-v1`, `veyl-rebalance-v1`, `veyl-reward-v1`, `veyl-remove-v1`) and
  the owner's nonce. Tests: a stranger cannot claim, withdraw an order, rebalance, withdraw protocol fees or ineligible
  rewards; a private position cannot be touched through `veyl_bin` directly (its authority is the entry's signer PDA);
  missing signature, wrong key, a valid signature from another action's domain, and replay are all refused.
- **Checked math.** Token amounts use checked adds/subs (`add64` / `sub64` / `ck`), shares and growth are u128 with checked
  adds except the two growth accumulators (fees, rewards), which wrap on purpose (checkpoint differences stay exact while
  one settlement period's growth is below 2^128 per share, as in Uniswap v3). 128.128 products use an exact 4x4-limb
  multiplication and, when dividing by 2^128, a shift: both bit-identical to the previous `U512` path (the JS twin and the
  executed swap still agree to the atom).
- **Events.** Every new instruction emits one (`FeesClaimed`, `RewardClaimed`, `LimitOrderPlaced/Withdrawn`, `Rebalanced`,
  `ZapAdded`, `ProtocolShareSet`, `ProtocolFeeWithdrawn`, `FeeAuthoritySet`, `RewardInitialized/Funded/FunderSet`,
  `IneligibleRewardWithdrawn`, and the `Private*` events); `Swapped` gained `protocol_fee`. The SDK decodes all of them.

### Checked and found sound

- **Fee conservation.** Per bin: `used = mm_in + lo_in + lo_fee + mm_fee + protocol` exactly; the market makers' share is
  divided by `supply - MIN_LIQUIDITY` (the locked shares are not owed anything); with no eligible share it goes to the
  protocol balance. Property test (seeded): after random swaps and every LP claiming, `vault == bin reserves + protocol
  balance + dust` to the atom, `fees in == claimed + protocol + dust`, `0 <= dust < 1 atom per LP per bin` (floors favour
  the pool). Same with limit orders in the books.
- **Settlement order.** `settle` runs before any change of a slot's shares (mint, burn, rebalance) and before a claim, so a
  late joiner never earns fees or rewards accrued before it joined; rewards are brought up to date before the active
  bin's supply changes or the active bin moves (`update_active(required = true)` in swap, zap, and any mint / burn /
  rebalance touching the active bin), so just-in-time liquidity cannot capture emission from an idle period.
- **Active bin proof of emptiness.** When rewards run, a swap must pass the active bin's array, or its PDA as an empty
  system account (proving the bin has no liquidity). The real array cannot be passed off as empty; lamports sent to the
  PDA do not change that and do not block `init_bin_array` (Anchor `init` allocates/assigns a pre-funded PDA).
- **Bitmaps.** Every write path (`mint_inner`, `burn_inner`, `swap_inner`, `place_limit_order`, `withdraw_limit_order`)
  refreshes the bin's two bits and the pool's array bits for the arrays it touched; the swap reads only the token-bought
  side, never revisits a bin, and refuses an inconsistent bit (`BitmapMismatch`). Tested on a pool with liquidity 700,
  1,500 and 2,400 bins apart (the old 256-step walk failed there) and by a seeded random swap sequence.
- **Limit orders.** Placement is guarded by side (the slippage check: the active bin moving across the order makes it fail
  rather than fill instantly); fills convert at the bin's own price plus the orders' pro-rata fee share and are never
  un-filled (filled tokens are not offered to later swaps); withdrawals floor (remaining holders keep the dust).
- **Zap / rebalance.** Weights apply against the active bin at execution (a side's weights on the wrong side are dropped),
  the last weighted bin takes the rounding remainder (nothing left in the entry's vaults), `min_shares` per bin bound the
  value; the private zap also requires `min_swap_out` when it swaps. The zap's swap output is added from the vault without
  a transfer: the vault equation above still holds (tested).
- **Rewards.** `rate = (amount + not-yet-emitted) << 64 / duration` (floor) and `emitted = rate * dt` (< 2^128); claims floor;
  the vault can only be over-funded by rounding. Tested: exact per-position claims, only the active bin earns, and
  `emitted == paid + ineligible + dust` (dust <= 1 atom per position update).

### Acknowledged (Phase 1)

| ID | Severity | Item |
|---|---|---|
| P1-1 | Low | Rebalance and zap read weights against the active bin at execution: a trade in between changes the distribution (bounded by `min_shares` / `min_swap_out`, which the relayer and the private variants require) |
| P1-2 | Info | Floor dust from fee and reward division stays in the vaults and belongs to nobody (< 1 atom per LP per bin per settlement) |
| P1-3 | Info | Growth accumulators wrap; a single position's unsettled growth would have to exceed 2^128 per share (more than 2^64 fee atoms per share) to misaccount |
| P1-4 | Info | Limit orders earn their pro-rata share of the fee (no 50% protocol cut as in Meteora) and no farm rewards; market makers get the < 1 atom rounding of the split |
| P1-5 | Info | Protocol fees are an accounted balance inside the pool's vaults (as Meteora's `protocol_fee` in `LbPair`), not a separate token account; withdrawals are capped by it |
| P1-6 | Info | Bin arrays (~0.068 SOL) and share accounts (~0.049 SOL) are never closed (no `close_position` yet); the relayer's fee floor charges their rent |
| P1-7 | Info | Compute, not MAX_STEPS, bounds a swap in practice (~12-18k CU per bin traded): roughly 80 bins per transaction; the SDK passes 4 bin arrays per swap by default (`SWAP_ARRAYS`) |
| P1-8 | Info | Bin ids are limited to -61,440..61,439 (2,048 arrays in the pool bitmap); `create_pool` refuses an active bin outside |

### Where an external auditor should focus

1. `simulate` / `swap_inner`: the per-bin split (protocol, market makers, limit orders), u128 bounds, and the bitmap jumps;
   compare with `simulateSwap` in `sdk/veyl.js`.
2. `settle`, `mint_inner`, `burn_inner`, `claim_*`: settlement before every share change, the wrapping accumulators, the
   `MIN_LIQUIDITY` exclusion and the `proto_extra` path.
3. `update_active` and `BinPool::update_rewards`: which instructions require the active array, the empty-PDA proof, and
   `fund_reward`'s rate recomputation.
4. `find_accounts` without PDA re-derivation (confirm nothing else writes the identity fields), and duplicate handling.
5. Limit-order share pricing (`place_limit_order`) and fill irreversibility.
6. `rebalance_position` / `swap_and_add`: `side_weights`, `distribute`, the withheld fee, leftovers, and the zap's
   transfer-free swap output.
7. `veyl_entry`: `check_signed` and the shared nonce across actions, `#[instruction(owner)]` reuse of `PrivateRemove`,
   `payout`'s manual pool validation (reward claims into a note), `spend_leg`.
8. Roles: the new protocol fee authority and reward funders in `handover` / `roles` / preflight.
9. The relayer's new kinds: cost floor and fee base (read through `position()` from RPC; a lying RPC can only make the
   relayer refuse or under-charge itself).

## Phase 2 self-review (October 2026): hidden balances, transfers and position sizes

**Still not an external audit, and the new keys come from one machine.** This section reviews Phase 2 like the sections
above. What Phase 2 hides and what stays public is in PRIVACY.md; in short: note amounts, owners, transfers inside the
pool and position sizes are hidden; deposit and withdrawal amounts, every amount that enters or leaves a pool, each LP
action's change per bin, bin reserves and prices stay public. The withdraw circuit, its keys and every legacy pool
instruction are unchanged; legacy notes stay spendable and can migrate in.

### Circuits

| | `transact` (`zk/circuits/transact.circom`) | `position` (`zk/circuits/position.circom`) |
|---|---|---|
| shape | 2 inputs, 2 outputs (UTXO), depth-32 tree | one position note in, one out, 16-bin window, 2 claim notes |
| constraints / public | 18,475 / 8 (phase-1 2^15) | 17,219 / 8 (phase-1 2^15) |
| public signals | root, publicAmount (signed, field), extDataHash, publicAsset, 2 nullifiers, 2 commitments | root, nullifier, new commitment, posAsset, H bundle, 2 claim commitments, extDataHash |
| note | `Poseidon(asset, amount, Poseidon(sk), blinding)` | `Poseidon(posAsset, Poseidon(Poseidon16(shares), debtX, debtY), pk, blinding)` |
| key checks | membership (skipped for amount-0 dummies), nullifier = `Poseidon(c, index, Poseidon(sk, c, index))`, distinct nullifiers, 64-bit range on every amount, `sum(in) + publicAmount == sum(out)`, `publicAmount * (asset - publicAsset) == 0`, extDataHash squared into the system | membership unless the input is empty, ownership, shares 112-bit, `claim = floor((sum s*H - debt) / 2^64) - fee` with the remainder kept in the checkpoint, 64-bit claim and fee, claim commitment 0 when the claim is 0, H bundle = Poseidon7 of the window's H and the deltas |

Owner key: **Poseidon-keyed** (`pk = Poseidon(sk)`), not BabyJubjub. A spend proves knowledge of `sk` inside the
circuit, which costs one Poseidon (~240 constraints) instead of a scalar multiplication (~6,000) and needs no signature
scheme; nobody but the prover ever needs to verify ownership. The viewing key is separate (X25519) so it can be shared
without the spending key. Tree: **one new tree for every token** (PDA `["shield"]`, same depth 32, same zeros, same
192-slot root history as the legacy pools). Per-token trees would reveal the token of every spend through the tree it
names; the legacy notes' commitment format also differs, so they migrate by proof rather than sharing a tree.

### What was added

| Program | Instruction | Who moves value | Notes |
|---|---|---|---|
| veyl_pool | `init_shield`, `set_shield_postman`, `propose/accept_shield_authority` | upgrade authority / shield authority | the shielded pool is a fixed PDA |
| veyl_pool | `post_proof(kind, proof, pubs, ttl)`, `cancel_proof` | anyone (a valid proof) | Groth16 verify (transact or position vkey by kind), parked under `sha256(kind, pubs)`; split from execution for the 1,232-byte limit |
| veyl_pool | `shield_deposit`, `approve_deposit`, `cancel_deposit` | depositor / postman / depositor | the vault takes `publicAmount` at once; the two commitments wait in a `PendingDeposit` until the postman inserts them; until then the depositor can take it back in full |
| veyl_pool | `shield_transact` | the proof (relayer submits) | transfers, merges, withdrawals; nullifier PDAs `["nf", n]`; recipient, relayer, fee, mint, action and ciphertexts bound by extDataHash |
| veyl_pool | `transact_cpi`, `consume_position`, `deposit_receipt`, `shield_pay` | **entry signer PDA only** | the trust boundary below |
| veyl_bin | `mint_exact`, `harvest` | share authority | exact shares (the proof fixes them before execution), fee collection per bin to a given account |
| veyl_entry | `init_lp_acc`, `open/write/close_buffer`, `shield_lp`, `shield_swap`, `shield_order`, `shield_order_withdraw`, `shield_migrate`, `shield_return_rewards` | proofs (relayer submits) | the shielded aggregate `["shielded"]` holds every shielded share; LpAcc `["lpacc", pool, chunk]` stores H per bin |

### Account validation, per REVIEW standards

- **Proofs.** `post_proof` verifies against the vkey chosen by `kind` (a transact proof posted as a position proof fails:
  tested). Executions read the parked proof by PDA (`proof_id(kind, pubs)`) and re-check: root known to the shield's
  history, extDataHash == hash of the request actually executed, publicAsset == asset of the mint moved, processor.
- **Nullifiers.** `use_nullifier` creates `["nf", n]` (allocate + assign when a griefer pre-funded the address: tested);
  existence = spent. Double spends, a note twice in one proof, and the same proof twice are refused (tested).
- **Ext data.** `TransactExt` (recipient, signed external amount, relayer, fee, processor, action, mint, ciphertexts) is
  hashed into the proof. Tampering with the recipient, amount, fee or action is refused (BadContext; tested), and the
  token accounts paid must equal the bound recipient / relayer (WrongRecipient).
- **Trust boundary veyl_pool <-> veyl_entry.** `transact_cpi`, `consume_position`, `deposit_receipt` and `shield_pay`
  require the entry program's signer PDA (`require_keys_eq!(processor, entry_signer())`). `deposit_receipt` with a
  *virtual* asset (limit-order shares, `order_asset_of`) inserts a note with no tokens moving, and `shield_pay` pays from
  the vault: both trust that veyl_entry only does so for what the aggregate actually received (order shares minted,
  harvested fees). This is the most important thing to audit: a bug in `shield_lp` / `shield_order*` could mint unbacked
  notes. The conservation property test checks it end to end (vault == notes + pot, pot >= every fee still claimable).
- **Leg binding.** Every leg of an entry action is a transact proof whose `action` field is
  `sha256(tag || borsh(core))` of that action, and whose processor is the entry signer: a leg cannot be replayed into
  another action or a lower minimum (tested), and nobody else can execute it (NotProcessor; tested).
- **Position proofs.** `shield_lp` checks posAsset == hash(pool, lo), extDataHash == hash(core), and the H bundle against
  the window's LpAcc values **before** the harvest; deltas, window, fees, minimum and ciphertext are in the hash
  (tampering tested). Shares are minted with `mint_exact` (refuses if the vault's token budget is exceeded).

### Checked and found sound

- **No inflation (transact).** Conservation is per asset in the circuit; amounts are range-checked to 64 bits so a field
  wrap cannot balance (a 2^64 output against a "negative" one: refused by the range check; tested); the public amount must
  be 0 or of the declared asset. Property test (seed 7): after random deposits, hidden transfers and withdrawals, the USDT
  vault == the sum of public amounts in and out == the sum of every unspent note, after each step.
- **Fee accrual (position).** MasterChef style: the note's debt checkpoints `sum(s * H)`; H rises at a harvest by
  `floor(c * 2^64 / S)` (S = the aggregate's shares in the bin), so the pot always covers every claim (floors favour the
  pool; tested: pot - owed < 100 atoms at the end). A proof uses H as it was before its own transaction's harvest, so new
  shares would earn that harvest: an add pays a **dilution charge** `ceil(sum delta * dH / 2^64)` per token (bounded by
  its `max_charge`) and a removal is paid `floor(sum |delta| * dH / 2^64)`. When the action does not hold the token of a
  charge (a one-sided add), the charge is not taken; instead its new shares are counted in that harvest's divisor (H
  lowered to `floor(c * 2^64 / (S + delta))`): still solvent, and the existing holders share the fees collected since the
  bin's last harvest with the new shares (P2-3). Tested both ways.
- **Exact shares.** The proof fixes the share deltas, so `mint_exact` mints exactly those and takes the tokens it needs
  (hints let the program find the amount without an iterative search); leftovers return as receipt notes.
- **Stack and heap.** `shield_lp` is split into `#[inline(never)]` steps (4 KB frames) and veyl_entry uses a 256 KB bump
  allocator with reclaim; the relayer requests the heap frame. Measured: 638k CU for an add with two legs (DEPLOY.md has the table).

### Acknowledged (Phase 2)

| ID | Severity | Item |
|---|---|---|
| P2-1 | Critical (ops) | `transact` and `position` keys are single-machine dev keys like the withdraw key; the ceremony covers all three (`ceremony/`, rehearsed) and mainnet preflight is red until it runs |
| P2-2 | Medium | The veyl_pool <-> veyl_entry boundary (virtual-asset receipts, `shield_pay`) trusts veyl_entry's accounting; an entry bug could mint unbacked notes. Both programs share an upgrade authority |
| P2-3 | Low | One-sided adds dilute instead of paying a charge in the missing token (bounded by fees since the bins' last harvest) |
| P2-4 | Low | Each LP action's per-bin deltas, leg amounts and receipts are public; a fresh position's first add shows its starting size (not its owner) |
| P2-5 | Info | Relayer fees are flat amounts in a token, so a relayed transfer's token is public (fee-0 transfers hide it) |
| P2-6 | Info | Shielded positions earn no farm rewards in Phase 2; `shield_return_rewards` returns the aggregate's share to the funder |
| P2-7 | Info | A position note covers a 16-bin window; wider ranges are several notes. A rebalance outside the window is remove + add (two proofs, linkable by timing) |
| P2-8 | Info | Deposits wait for the postman (it can refuse or delay one; the depositor can take it back); admitted notes never need it |
| P2-9 | Info | Receipt notes have public amounts (they leave a pool); their owner is a one-time key derived from the seed |

### Where an external auditor should focus

1. `transact.circom` / `position.circom`: conservation, range checks, dummy inputs, the claim maths and the bundle.
2. `check_transact`, `insert_outputs`, `use_nullifier`, `post_proof` kinds; `scripts/vkey-to-rust.js --all`.
3. The entry-only instructions in veyl_pool and every caller in veyl_entry (`shield_lp` steps, `receipts`, `lp_pot`,
   `lp_settle`, `shield_order*`): can any path insert a note or pay from the vault for value the aggregate did not receive?
4. `harvest` / `mint_exact` in veyl_bin, LpAcc H updates and the dilution rule.
5. The browser engine (`site/shield-engine.js`, `sdk/shield.js`): key derivation, note scanning, coin selection, ciphertexts.

## Phase 3 self-review (October 2026): sealed batch swaps

**Still not an external audit; the swap and claim keys come from one machine, and the local committee key from one
machine's three processes.** A sealed swap hides its size: the amount is encrypted to a t-of-n committee key inside the
swap proof, the program adds the ciphertexts per pool, batch and direction, and only the two totals are ever decrypted.
Each direction's total and seller count, the one net swap, the clearing ratios and the timing are public (PRIVACY.md).

### Circuits

| | `swap` (`zk/circuits/swap.circom`) | `claim` (`zk/circuits/claim.circom`) |
|---|---|---|
| shape | 2 notes in, 1 change note out, 1 swap commitment out, ElGamal ciphertext | 1 swap commitment in, 1 note out |
| constraints / public | 23,426 / 8 (phase-1 2^15) | 9,942 / 6 (phase-1 2^14; posted padded to 8 with zeros, checked) |
| public signals | root, 2 nullifiers, change, swap commitment, batch key, bundle, extDataHash | root, nullifier, out note, batch key, bundle, extDataHash |
| swap commitment | `Poseidon5(batchKey, direction, amount, Poseidon(sk), blinding)`, a leaf of the shielded tree | spent with the notes' nullifier construction |
| key checks | notes as `transact` (membership, nullifiers, 64-bit ranges); `sum(in) == change + amount + fee`, one asset; amount 40 bits, `amount >= minIn > 0`; `C1 = r·B8`, `C2 = amount·B8 + r·PK` (fixed-base for B8, complete double-and-add for PK); bundle = Poseidon10(dir, asset, fee, minIn, C1, C2, PK) | `q = floor(amount·num/den)` by `amount·num = q·den + rem`, `rem < den`, every value range-checked (no field wrap); `out = q - fee >= 0`; bundle = Poseidon5(dir, assetOut, num, den, fee) |

**Curve: Baby Jubjub**, not BN254 G1: native in a BN254 circuit (~2.5k constraints per variable-base multiplication
instead of ~10^6 for non-native G1). Its cost moves on chain, where Solana has no syscall for it: veyl_entry carries a
software implementation (`bjj.rs`, radix-2^29 Montgomery field, a = -1 isomorphic model, extended coordinates; ~900 CU per
field multiplication, measured against 32-bit and u64 limbs). Amounts are bounded (2^40 per swap, 64 swaps per direction)
so a total is below 2^46 and baby-step giant-step decodes it off chain; the program only checks the claimed total.

### What was added

| Program | Instruction | Who | Notes |
|---|---|---|---|
| veyl_entry | `init_committee`, `set_committee`, `propose/accept_committee_authority` | upgrade authority / committee authority | `set_committee` checks n <= 6, t <= n, every key on the curve and in the subgroup, and that the member keys interpolate to PK (Lagrange in the exponent) |
| veyl_entry | `init_sealed_pool`, `set_sealed_params` | committee authority | per bin pool: epoch slots, settlement window, minimum input per token, k-floor, rollovers, drift bound (bins), pause |
| veyl_entry | `submit_swap` | a swap proof (relayer submits) | via veyl_pool `consume_swap` (entry only): nullifies, inserts change + swap commitment, pays the relayer; adds (C1, C2) to the direction's aggregate |
| veyl_entry | `close_batch`, `post_share`, `share_step`, `cancel_share`, `settle_verify`, `settle_batch`, `fail_batch` | anyone (a share: its member's node key) | close at epoch end (empty: extend; under k: roll, then fail); a share's DLEQ checked over ~5 transactions in a `ShareJob`; totals checked; one net swap; refunds after the window |
| veyl_entry | `claim_swap` | a claim proof (relayer submits) | via veyl_pool `consume_claim` (entry only): one nullifier, inserts the out note; ratio from the batch (or 1/1 when failed) |
| veyl_pool | `post_proof` kinds 3 (swap) and 4 (claim) | anyone (a valid proof) | claim proofs carry 6 signals: pubs[6..8] must be zero |

### Account validation, per REVIEW standards

- **Batches** are PDAs `["batch", pool, seq]`; the batch key every proof binds is `hash_to_field("veyl-batch", pool, seq)`,
  so a swap or claim proof is valid for one batch of one pool only (tested: a claim against another batch's ratio fails).
  `submit_swap` requires `state == OPEN`, the pool's current `seq`, the epoch not over, the batch's committee epoch ==
  the registered one (an empty batch adopts a rotated key; a non-empty one keeps it), fewer than 64 swaps in the direction.
- **Bundles** are recomputed by the program from what it actually uses: the direction, the mint moved, the fee in the
  ext data, the pool's minimum, the ciphertext added to the aggregate and the registered PK (swap); the direction, the
  output mint, the batch's recorded num/den (or 1/1) and the fee (claim). A relayer cannot swap the ciphertext, the PK,
  the ratio or the direction (tested: a claim against an inflated ratio and against the other direction's ratio fail).
- **Shares.** `post_share` requires the signer to be member i's registered node key, a closed batch under the current
  committee, the member not yet verified; every point is decoded with an on-curve check, s < l. The DLEQ check is
  `8·(z1·(s·B8 - c·PK_i - A) + (s·C1a - c·Da - Ba) + z3·(s·C1b - c·Db - Bb)) == O` with c and z from sha256 over every
  input (Fiat–Shamir), as one 9-term MSM split into resumable stages (the job PDA is per batch and member; anyone may
  crank it; a wrong proof fails at the last stage and the job is closed). Tested: a forgery (a partial decryption under
  another key), a wrong D_b with the proof made for the right one, a non-member's share, a point off the curve.
- **Totals.** `settle_verify` takes exactly t verified shares and checks `8·(Δ·C2 - Σ Δλ_i·D_i) == (8·Δ·total)·B8` with
  integer Lagrange weights Δλ_i (Δ = n!); `total < 2^46`; an empty direction must claim 0. Tested: a wrong total; t-1
  shares cannot decrypt (JS, and on chain `NotEnoughShares`).
- **Net swap.** `settle_batch` needs both totals verified, the window open and the active bin within `max_drift` bins of
  the bin at close. It pays the excess from the shield vault (`shield_pay`, entry only) into `veyl_bin::swap` with a
  minimum equal to the quote and checks the received amount equals the swap's output (AmountMismatch otherwise).

### Checked and found sound

- **Conservation per batch.** Direction X: sellers receive `num_X = matched_Y + out_Y` in Y for `den_X = A` of X, where
  matched_Y is the opposite side's whole input B (or the price-matched part of it); each claim pays
  `floor(amount·num/den)`, so the sum of claims <= num and the dust (< 1 atom per claim) stays in the vault, unowned. Tested
  per direction: sum of claims + dust == net output + opposite inputs, dust < 3 atoms.
- **No inflation through the claim.** q is bound to amount·num/den by an exact division with a range-checked remainder;
  num and den are the program's (in the bundle); the swap commitment can be claimed once (nullifier; tested twice).
- **Refunds.** A batch that misses the window becomes FAILED (`fail_batch`, or lazily at the first claim); every swap
  claims num = den = 1 in the token sold. A failed batch cannot settle afterwards (tested).
- **k-floor.** A non-empty direction with fewer than `k_min` sellers at close rolls the batch (same seq, new end slot) up to
  `max_rollovers` times, then fails it: a total of fewer than k sellers is never decrypted (tested both).
- **Stack / compute.** Every Baby Jubjub stage is `#[inline(never)]` with tables built in place (4 KB frames). Measured:
  post_share / share_step <= 1.31M CU each (5 transactions, ~5.4-5.6M per share), close_batch ~265k (four points to affine,
  one batched inversion), settle_verify ~200k per direction, settle_batch ~125k, submit_swap ~160-167k, claim_swap ~84k.

### Acknowledged (Phase 3)

| ID | Severity | Item |
|---|---|---|
| P3-1 | High (trust) | **A colluding t-quorum of the committee can decrypt every individual sealed amount**: every ciphertext is on chain. The protocol only decrypts totals but cannot stop t members off chain. Key rotation bounds what a later compromise of old shares exposes. Arcium (committee/README.md) would change this to "one honest MXE node" |
| P3-2 | Critical (ops) | `swap` / `claim` keys are single-machine dev keys; the 5-circuit ceremony is rehearsed (including a full batch with the rehearsal keys), not run. The registered committee is local; mainnet preflight is red without a real DKG transcript |
| P3-3 | Medium | No per-swap limit price: a seller gets the batch's clearing price. The settler chooses when to settle within the window, and the active bin may have moved up to `max_drift` bins since close (a sandwich around `settle_batch` is bounded by that, not prevented) |
| P3-4 | Medium | The k-floor counts swaps, not people: one person with several notes (or a few sybils) can meet k, and then their own swaps make up most of a direction's total |
| P3-5 | Low | Joint Feldman DKG lets a rushing dealer bias the joint key's distribution (GJKR 1999); secrecy against t-1 holds. Any complaint aborts the run (no public complaint resolution) |
| P3-6 | Low | A withholding committee (or one below t) delays a batch by up to `settle_timeout` slots; then every swap is refunded minus two relayer fees |
| P3-7 | Info | The direction of each sealed swap is public (a hidden direction would make a lone seller's direction total equal their size); its pool, batch and time too |
| P3-8 | Info | Share verification costs ~5.5M CU per member per batch, paid by the node (a fee market for this is not built) |
| P3-9 | Info | Swap commitments live in the shielded tree; a swap and its claim are not linked on chain (different nullifier and note), but timing per batch is public |

### Where an external auditor should focus

1. `swap.circom` / `claim.circom`: the ElGamal relation (complete addition for r·PK, subgroup), the amount range and
   minimum, the division with remainder, the bundles.
2. `bjj.rs`, `bjj_mul.rs` (generated by `scripts/gen-bjj-mul.py`), `bjj_consts.rs`: lazy-carry bounds in the radix-2^29
   Montgomery multiplication, `decode` (on-curve, canonical), the isomorphism to a = -1, the signed-digit recoding.
3. `sealed.rs`: the DLEQ challenge and weights, the ShareJob stages (resumption, who may crank, closing), `settle_verify`'s
   integer Lagrange weights, the netting maths and rounding, `settle_batch`'s `shield_pay` path, state transitions
   (OPEN/CLOSED/SETTLED/FAILED, rollovers, committee epoch).
4. `consume_swap` / `consume_claim` in veyl_pool (entry-only) and the claim proof padding.
5. `committee/dkg.js` (share encryption, signatures, transcript) and `committee/node.js` (share storage).

## What changed for users (also in PRIVACY.md)

- A relayer that receives a proof can no longer hold the note: any other relayer's newer post replaces it, and ragequit always
  works for an original deposit.
- Small amounts pay a higher relayer rate (its costs are fixed); the app asks the relayer and shows the real figure.
- Liquidity adds carry a minimum per bin (1% below the current figure), and dust no longer makes a removal fail.
- Phase 2: balances, transfers inside the pool and liquidity position sizes are hidden; every amount at a pool, deposits and
  withdrawals stay public (PRIVACY.md). Shielded positions earn swap fees, not farm rewards.
- Phase 3: sealed batch swaps hide each swap's size; the batch's totals, clearing price, seller count and timing are public, and
  a colluding 2-of-3 committee could decrypt individual sizes (PRIVACY.md). Instant swaps stay available and reveal the amount.
