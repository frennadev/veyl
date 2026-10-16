# Veyl on Solana: what is hidden, what is not

Veyl hides **who owns a balance or a position, and how large it is**, and with sealed batch swaps (Phase 3) **how large
each trade is**. It does not hide the market: every amount that enters or leaves a pool, every bin reserve and every price
stays public, and a sealed batch's totals are public. No system can honestly promise "100% private"; this file says where
the lines are. Phase 2 (the shielded pool) is what the app uses for every private action; Phase 1 notes still work and can
be moved in.

## What's sealed (Phase 2, the shielded pool)
- **Balances.** A note is `Poseidon(asset, amount, owner, blinding)`; the chain stores only that hash and a ciphertext only
  the owner's viewing key opens. Nobody sees how much you hold, in which token, or that two notes are yours.
- **Transfers inside the pool** (to a Veyl address): the amount, the sender and the receiver. The chain sees two spent
  nullifiers, two new commitments, two ciphertexts and the relayer's flat fee. The fee's token is visible, so the token of a
  relayed transfer is public; a transfer with no fee hides the token too.
- **Which note paid for an action.** Every spend is a `transact` proof over one shared tree (all tokens, depth 32): it
  proves membership, ownership, a 64-bit range per amount and per-token conservation without naming the note.
- **Who owns a liquidity position and how large it is.** A position is a note (`position` circuit) holding its shares for
  a window of 16 bins and a fee checkpoint. On chain the shares are held by one shielded aggregate (a PDA that never signs),
  so the chain shows the aggregate's total per bin, not whose part is whose. The actions of one position are not linkable
  to each other on chain: each spends the previous note's nullifier and creates a new hidden commitment.
- **Fee claims from shielded positions.** The amount claimed is computed inside the proof from the note's checkpoint and
  becomes a new hidden note. The chain sees one nullifier, one commitment and the relayer's flat fee.
- **Who acts.** Only the relayer sends private actions. The end-to-end test checks that the user's wallet appears in none
  of the relayer's transactions.

## Sealed batch swaps (Phase 3)
A sealed swap sells one token of a pool inside that pool's current batch (one batch per pool per epoch, about a minute).
Its amount is encrypted on your device to the batch committee's threshold key; the program adds it into the batch's total
for its direction without decrypting it, and the committee only ever decrypts the totals. The two directions are netted
and ONE swap of the excess goes through the bins. When the batch settles you claim your share at its clearing ratio as a
new hidden note.

**Hidden**
- **The size of each sealed swap**, and so what it receives. The chain holds a commitment and a ciphertext; the relayer
  sees only those too. A claim pays `floor(amount x num / den)` into a new hidden note: its amount does not appear either.
- Who made it (the relayer submits; the notes it spends are shielded) and which of the batch's swaps a claim belongs to (a
  claim spends a swap commitment by nullifier, like any note).

**Public**
- That a sealed swap joined batch N of a pool, **its direction** (which token it sells) and the running count per
  direction. The relayer's flat fee and its token (the token sold; at the claim, the token received).
- Per batch: the **number of sellers per direction**, **each direction's total**, the **net swap** through the bins (its
  direction, amount in and out), the active bin's price used for the matched part, the **clearing ratio** per direction,
  and its timing (opened, closed, settled or failed, rollovers).
- Per claim: its batch and direction, and whether it is a claim or a refund.

**What that means**
- Your size is hidden among the other sellers in the same direction of the same batch, not absolutely: the direction's
  total is public. The program refuses to settle a direction with fewer than `k` sellers (k = 3 by default; an empty
  direction is fine): the batch runs another epoch, and after its rollovers fails and refunds everyone. A side with 3
  sellers still reveals a lot to any 2 of them (each learns the third's size from the total). More sellers, more privacy.
- **The k-floor counts swaps, not people.** Someone who fills a batch with their own swaps (paying the pool minimum and a
  relayer fee for each) learns the rest of that direction's total. Batches with ordinary traffic make this expensive, not
  impossible.
- Timing still links: sealing right after a public deposit of the same size, or claiming right after settlement every time.
- The price: the matched part of the two directions crosses at the active bin's price at settlement (no pool fee); the
  excess pays the pool's fee and price impact. The program refuses to settle if the active bin moved more than the pool's
  `max_drift` bins since the batch closed. There is no per-swap limit price in this phase.
- **"Instant"** swaps (the other mode on the pool page) settle at once and their amounts in and out are public at the pool,
  as in Phase 2; only who made them is hidden.

**The committee (trust)**
- t of n members (2 of 3 in the deployments here) must cooperate to decrypt a batch's totals; fewer learn nothing.
- **Any t members colluding could decrypt every individual sealed swap**: each swap's ciphertext is public and encrypted
  to the same committee key. The protocol never asks them to, and they never need to; privacy of individual sizes rests
  on fewer than t members colluding (and on their shares not being stolen, now or later). Key rotation limits a later
  compromise to the batches under that key. Arcium's MXEs are the documented alternative (committee/README.md).
- The committee cannot steal or misprice: a wrong partial decryption fails its on-chain Chaum–Pedersen check and a wrong
  total fails the settlement check. A committee that withholds its shares only delays a batch until its settlement window
  ends; then everyone in it is refunded through the claim circuit.

## What's public, always
- **Deposits**: the depositing wallet, the token and the amount. A deposit waits outside the tree until the approved-set
  publisher admits it; until then its depositor can take it back (public, to the same wallet).
- **Withdrawals** to a Solana address: the amount, the token and the recipient.
- **Everything at a pool**, including actions paid from shielded notes: the amount each leg pays into the pool and what
  comes back (receipts), the token, the bins and **each action's change per bin** (`ShieldLpExecuted.deltas`), the
  aggregate's shares per bin, the fees it harvests per bin, the dilution charge or payment, instant swap amounts and
  routes, a sealed batch's totals and net swap (not its individual swaps), limit orders' bin, side and size, reserves and
  prices.
  - A brand-new position's first add therefore shows its starting size (as that action's deltas), not its owner. Later
    adds, removals, rebalances and claims are not linked to it or to each other on chain, so its size from then on is not
    public unless timing and amounts give it away.
  - Receipt notes (swap outputs, removal proceeds, order shares, migrated legacy notes) carry a public amount, owned by a
    one-time key derived from your seed that nobody else can recognise. Spending one together with another note hides it.
- Relayer fees: a flat amount per action (never a rate: a rate would reveal the amount it is taken from) and its token.
- Nullifiers, commitments, ciphertext sizes, the tree root a proof used, and timing.

## Not earned while shielded
- Farm rewards: shielded positions do not earn them in Phase 2. The aggregate's share can be returned to the farm's funder
  (`shield_return_rewards`). Swap fees are earned in full.

## Ways users can still link themselves
1. Withdrawing to a wallet they already used (the app refuses a recipient with any on-chain history).
2. Withdrawing minutes after depositing, or exactly the deposited amount.
3. A distinctive first add (its per-bin deltas are public) followed soon by a matching removal.
4. Using a token or pool few others use: the crowd is the privacy.
5. Reaching the relayer and their wallet's RPC from the same IP. Use a VPN or Tor.
6. Sharing the viewing key: it shows every incoming note and amount (it cannot spend).
7. Taking a pending deposit back: a public exit to the depositor, by design.
8. Sealing a swap into a quiet batch (few sellers in its direction), or into one that someone else fills with their own
   swaps; sealing exactly the amount of a deposit made moments before.

## Keys
- One random seed per browser derives the spending key (`pk = Poseidon(sk)`), the X25519 viewing key and the one-time
  receipt keys. Your Veyl address (`veyl:` + base58 of the spending and viewing public keys) is what you share to be paid.
- The encrypted backup (PBKDF2 + AES-256-GCM) holds the seed and any Phase 1 note secrets; restoring it rescans the chain.

## Operators
- **Relayer**: sees the request and the IP it came from. It cannot redirect funds: recipient, fee, action and deadline are
  bound into the proof's external-data hash. It keeps no IP logs.
- **Approved-set publisher (postman)**: admits deposits into the shielded tree. It can refuse or delay one (the depositor
  can then take it back); once admitted, notes are spent without it. For Phase 1 notes it still approves exits.
- **Upgrade, pool and factory authorities**: the deployer key at first; `npm run handover` moves them to a multisig.

## Phase 1 notes (legacy pools)
- Still spendable with the withdraw circuit, exactly as before (their amounts were always public). The app offers "Move
  in": one legacy proof turns the note into a receipt note in the shielded pool (amount public once, then hidden when spent
  with other notes).

## Not done yet (before real money)
- The multi-party key ceremony for all five circuits (withdraw, transact, position, swap, claim; `ceremony/`, rehearsed):
  today's proving keys come from one machine. A soundness risk (forged spends, inflation), not a privacy risk. Mainnet
  preflight stays red until it is done.
- A real batch committee: independent operators running the dealerless key generation (`committee/`), its transcript
  published and registered. The local and test committees run every member on one machine, so whoever controls it could
  decrypt any sealed swap. Mainnet preflight stays red until the transcript is there.
- An external audit of the programs, the circuits and the browser engine.
