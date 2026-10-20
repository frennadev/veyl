//! Phase 3: sealed batch swaps. Individual trade sizes are hidden; each batch's totals, clearing ratios, participant
//! counts per direction and timing are public.
//!
//!   batch      one per bin pool per epoch (`epoch_slots`). `submit_swap` executes a swap proof (zk/circuits/swap.circom):
//!              shielded notes of the token sold are spent into a swap commitment (in the shielded tree, amount hidden)
//!              and the amount's ElGamal ciphertext (Baby Jubjub, under the committee's threshold key) is added into the
//!              batch's aggregate for its direction. Nobody, the relayer included, sees the amount.
//!   close      anyone, once the epoch is over. A direction with 1..k_min-1 swaps (its total would be one person's size,
//!              or a few people's) holds the batch open for another epoch (`max_rollovers` times), then fails it: every
//!              swap is refunded. Otherwise the batch is sealed: no more swaps, the next batch opens.
//!   shares     each committee member posts its partial decryption of the two aggregates (D = sk_i·C1) with a
//!              Chaum–Pedersen proof that log_B PK_i = log_C1a D_a = log_C1b D_b. The proof is checked here, in software
//!              Baby Jubjub arithmetic (no syscall exists for this curve): one multi-scalar multiplication of ~5.5k field
//!              multiplications, run as a resumable job over a few transactions (`post_share`, then `share_step`).
//!   totals     with t verified shares anyone can recover each direction's total m·B = C2 - Σ λ_i·D_i (off-chain, baby-step
//!              giant-step) and `settle_verify` checks it with integer Lagrange weights (Δ = n!, so no full-size scalar
//!              ever multiplies a share): 8·(Δ·C2 - Σ Δλ_i·D_i) == (8·Δ·m)·B.
//!   settle     the two directions are netted at the active bin's price (the matched part crosses at that price, no pool
//!              fee); the excess is ONE swap through the bin pool. Each direction's clearing ratio num/den is recorded:
//!              what its sellers receive in the other token over what they put in.
//!   claim      a claim proof (zk/circuits/claim.circom) spends a swap commitment into a hidden note of
//!              floor(amount·num/den) - fee. A batch that fails (rollovers exhausted, or not settled within
//!              `settle_timeout` slots of closing) refunds instead: the same proof with num = den = 1 and the token sold.
//!
//! Liveness: close, settle_verify, settle_batch and fail_batch are permissionless. A committee that withholds its shares
//! can only delay a batch until `settle_timeout`, after which every swap in it is refunded. Privacy: individual amounts are
//! never decrypted by the protocol, but every individual ciphertext is on chain, so any t members colluding could decrypt
//! them (PRIVACY.md).
#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv as sha256v;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use veyl_bin::u512::U512;
use veyl_bin::program::VeylBin;
use veyl_pool::program::VeylPool;
use crate::bjj::{self, Cached, Ext, Fe};
use crate::{signer_seeds, shield_pda, Entry, EntryError};

pub const MAX_MEMBERS: usize = 6;
pub const MAX_PER_DIRECTION: u32 = 64;
pub const AMOUNT_BITS: u32 = 40;
/// A direction's total stays below 2^46 (64 swaps of < 2^40): what baby-step giant-step recovers.
pub const TOTAL_LIMIT: u64 = 1 << 46;
pub const OPEN: u8 = 0;
pub const CLOSED: u8 = 1;
pub const SETTLED: u8 = 2;
pub const FAILED: u8 = 3;
/// Work per transaction for a resumable share check, in compute units: a fixed budget charged per stage, because devnet
/// and mainnet have not activated sol_remaining_compute_units. Stage costs are the worst measured on a local validator
/// (tests/phase3.js) plus a margin: a table 65.3k, a window 28k + 8.1k per non-zero digit (8 digits: 93.1k), the final
/// stage 36.6k. post_share spends up to ~100k before its first stage, share_step ~5k; each budget leaves >= 150k of the
/// 1.4M transaction limit spare.
const TABLE_CU: u32 = 68_000;
const WINDOW_CU: u32 = 28_500;
const DIGIT_CU: u32 = 8_400;
const FINAL_CU: u32 = 40_000;
const POST_SHARE_BUDGET: u32 = 1_100_000;
const SHARE_STEP_BUDGET: u32 = 1_200_000;

// ------------------------------------------------------------------------------------------------ hashing (= sdk/sealed.js)
/// The batch's key: a field element naming (bin pool, sequence number). In every swap commitment and claim.
pub fn batch_key(bin_pool: &Pubkey, seq: u64) -> [u8; 32] { veyl_pool::hash_to_field(&[b"veyl-batch", bin_pool.as_ref(), &seq.to_le_bytes()]) }
fn half(b: &[u8; 64], i: usize) -> [u8; 32] { b[32 * i..32 * i + 32].try_into().unwrap() }
/// Poseidon(direction, asset, fee, minIn, C1, C2, PK) = the swap proof's bundle.
pub fn swap_bundle(direction: u8, asset: &[u8; 32], fee: u64, min_in: u64, c1: &[u8; 64], c2: &[u8; 64], pk: &[u8; 64]) -> Result<[u8; 32]> {
    let (d, f, m) = (veyl_pool::u64_to_field(direction as u64), veyl_pool::u64_to_field(fee), veyl_pool::u64_to_field(min_in));
    let (a, b, c, e, g, h) = (half(c1, 0), half(c1, 1), half(c2, 0), half(c2, 1), half(pk, 0), half(pk, 1));
    veyl_pool::poseidon(&[&d, asset, &f, &m, &a, &b, &c, &e, &g, &h])
}
/// Poseidon(direction, assetOut, num, den, fee) = the claim proof's bundle.
pub fn claim_bundle(direction: u8, asset_out: &[u8; 32], num: u64, den: u64, fee: u64) -> Result<[u8; 32]> {
    veyl_pool::poseidon(&[&veyl_pool::u64_to_field(direction as u64), asset_out, &veyl_pool::u64_to_field(num), &veyl_pool::u64_to_field(den), &veyl_pool::u64_to_field(fee)])
}
/// What a swap proof's extDataHash commits to.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapExt { pub relayer: Pubkey, pub fee: u64, pub enc_change: Vec<u8>, pub enc_swap: Vec<u8> }
/// What a claim proof's extDataHash commits to.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimExt { pub relayer: Pubkey, pub fee: u64, pub enc_out: Vec<u8> }
pub fn swap_ext_hash(e: &SwapExt) -> Result<[u8; 32]> { let mut v = Vec::new(); e.serialize(&mut v)?; Ok(veyl_pool::hash_to_field(&[b"veyl-sealed-swap", &v])) }
pub fn claim_ext_hash(e: &ClaimExt) -> Result<[u8; 32]> { let mut v = Vec::new(); e.serialize(&mut v)?; Ok(veyl_pool::hash_to_field(&[b"veyl-sealed-claim", &v])) }
/// Fiat–Shamir for a member's partial decryption: c, then the two weights that combine its three equations.
pub fn dleq_challenge(key: &[u8; 32], index: u8, pts: [&[u8; 64]; 8]) -> ([u64; 4], [u64; 4], [u64; 4]) {
    let mut parts: Vec<&[u8]> = vec![b"veyl-dleq", key.as_ref()]; let ix = [index]; parts.push(&ix); for p in pts.iter() { parts.push(p.as_ref()); }
    let h = sha256v(&parts).to_bytes();
    let w = |b: &[u8]| -> [u64; 4] { [u64::from_be_bytes(b[8..16].try_into().unwrap()), u64::from_be_bytes(b[0..8].try_into().unwrap()), 0, 0] };
    let z = |k: u8| sha256v(&[b"veyl-dleq-z", &h[..16], &[k]]).to_bytes();
    (w(&h[..16]), w(&z(1)[..16]), w(&z(3)[..16]))
}
fn le_of_be(b: &[u8; 32]) -> [u64; 4] { let mut w = [0u64; 4]; for i in 0..4 { w[i] = u64::from_be_bytes(b[24 - 8 * i..32 - 8 * i].try_into().unwrap()); } w }
fn u512(w: &[u64; 4]) -> U512 { U512([w[0], w[1], w[2], w[3], 0, 0, 0, 0]) }
fn mul_mod_l(a: &[u64; 4], b: &[u64; 4]) -> [u64; 4] { let r = (u512(a) * u512(b)) % u512(&crate::bjj_consts::L); [r.0[0], r.0[1], r.0[2], r.0[3]] }
fn lt_l(a: &[u64; 4]) -> bool { u512(a) < u512(&crate::bjj_consts::L) }
/// Integer Lagrange weights at 0 for the index set S, scaled by Δ = n!: (Δ, Δ·λ_i). Exact for n <= MAX_MEMBERS.
pub fn lagrange_int(s: &[u8], n: u8) -> (i64, Vec<i64>) {
    let mut delta: i64 = 1; for k in 2..=n as i64 { delta *= k; }
    let mu = s.iter().map(|&i| { let (mut num, mut den) = (1i64, 1i64); for &j in s { if j != i { num *= j as i64; den *= j as i64 - i as i64; } } delta * num / den }).collect();
    (delta, mu)
}

// ------------------------------------------------------------------------------------------------ limbs <-> account storage
type Limbs = [u32; 9];
fn fe_of(l: &Limbs) -> Fe { let mut r = [0u64; 9]; for i in 0..9 { r[i] = l[i] as u64; } r }
fn limbs_of(f: &Fe) -> Limbs { let mut r = [0u32; 9]; for i in 0..9 { r[i] = f[i] as u32; } r }
fn ext_of(p: &[Limbs; 4]) -> Ext { Ext { x: fe_of(&p[0]), y: fe_of(&p[1]), z: fe_of(&p[2]), t: fe_of(&p[3]) } }
fn store_ext(p: &Ext) -> [Limbs; 4] { [limbs_of(&p.x), limbs_of(&p.y), limbs_of(&p.z), limbs_of(&p.t)] }
fn cached_of(p: &[Limbs; 4]) -> Cached { Cached { ymx: fe_of(&p[0]), ypx: fe_of(&p[1]), t2d: fe_of(&p[2]), z2: fe_of(&p[3]) } }
fn store_cached(c: &Cached) -> [Limbs; 4] { [limbs_of(&c.ymx), limbs_of(&c.ypx), limbs_of(&c.t2d), limbs_of(&c.z2)] }
fn signed_add(acc: &Ext, c: &Cached, d: i8) -> Ext { if d < 0 { bjj::add_cached(acc, &bjj::neg_cached(c)) } else { bjj::add_cached(acc, c) } }
/// A posted proof (veyl_pool account: the owner is checked by the accounts struct, the discriminator here).
fn read_posted(info: &AccountInfo) -> Result<veyl_pool::PostedProof> { let d = info.try_borrow_data()?; veyl_pool::PostedProof::try_deserialize(&mut &d[..]) }

// ------------------------------------------------------------------------------------------------ state
/// The batch committee: its threshold public key and each member's public key share (from the DKG transcript, whose hash
/// is kept here), and the node key each member posts with. PDA ["committee"].
#[account]
pub struct Committee {
    pub authority: Pubkey, pub pending_authority: Pubkey,
    pub epoch: u32, pub t: u8, pub n: u8,
    /// 0 = dev (a key made on one machine), 1 = dealerless DKG with a public transcript
    pub kind: u8, pub bump: u8,
    pub pk: [u8; 64],
    pub members: [[u8; 64]; MAX_MEMBERS],
    pub nodes: [Pubkey; MAX_MEMBERS],
    pub transcript: [u8; 32],
}
impl Committee { pub const SIZE: usize = 8 + 64 + 8 + 64 + 64 * MAX_MEMBERS + 32 * MAX_MEMBERS + 32; }
/// A bin pool's sealed-swap settings and its current batch. PDA ["sealed", bin pool].
#[account]
pub struct SealedPool {
    pub bin_pool: Pubkey, pub mint_x: Pubkey, pub mint_y: Pubkey,
    pub seq: u64, pub epoch_slots: u64, pub settle_timeout: u64,
    /// smallest swap per direction (> 0): with the fee, what a fake participant costs
    pub min_in: [u64; 2],
    /// swaps a non-empty direction needs before the batch may settle
    pub k_min: u8, pub max_rollovers: u8,
    /// most bins the active bin may move between close and settlement
    pub max_drift: u16, pub paused: u8, pub bump: u8,
}
impl SealedPool { pub const SIZE: usize = 8 + 3 * 32 + 3 * 8 + 16 + 6; }
/// One batch. PDA ["batch", bin pool, seq (u64 LE)]. Direction 0 sells X for Y, 1 sells Y for X.
#[account(zero_copy)]
#[repr(C)]
pub struct Batch {
    pub bin_pool: Pubkey,
    pub key: [u8; 32],
    pub seq: u64, pub start_slot: u64, pub end_slot: u64, pub closed_slot: u64, pub settled_slot: u64,
    /// recovered totals per direction; clearing ratios num/den per direction; the net swap
    pub totals: [u64; 2], pub num: [u64; 2], pub den: [u64; 2], pub net_in: u64, pub net_out: u64,
    pub count: [u32; 2], pub claims: [u32; 2],
    pub committee_epoch: u32, pub active_at_close: i32, pub settle_id: i32,
    pub state: u8, pub rollovers: u8, pub verified: u8, pub totals_ok: u8,
    pub x_for_y: u8, pub _pad: [u8; 7],
    /// aggregates [C1 sell-X, C2 sell-X, C1 sell-Y, C2 sell-Y], extended coordinates (Montgomery limbs)
    pub agg: [[[u32; 9]; 4]; 4],
    /// the same, affine (circomlib x || y), set when the batch closes
    pub agg_aff: [[u8; 64]; 4],
    /// verified partial decryptions per member (D_a, D_b)
    pub shares: [[[u8; 64]; 2]; MAX_MEMBERS],
}
impl Batch { pub const SIZE: usize = 8 + std::mem::size_of::<Batch>(); }
/// A member's partial decryption being checked (resumable multi-scalar multiplication). PDA ["sharejob", batch, member].
#[account(zero_copy)]
#[repr(C)]
pub struct ShareJob {
    pub batch: Pubkey, pub node: Pubkey,
    pub window: i32, pub member: u8, pub stage: u8, pub tables_done: u8, pub _p: u8,
    /// signed 4-bit digits of the 8 scalars (sign included), see `post_share`
    pub digits: [[i8; 65]; 8], pub _p2: [u8; 4],
    /// the member's points: D_a, D_b, A, B_a, B_b
    pub pts: [[u8; 64]; 5],
    pub acc: [[u32; 9]; 4],
    /// multiples 1..8 of the 7 variable points, cached form
    pub tabs: [[[[u32; 9]; 4]; 8]; 7],
}
impl ShareJob { pub const SIZE: usize = 8 + std::mem::size_of::<ShareJob>(); }

fn new_aggregates() -> [[[u32; 9]; 4]; 4] { let id = store_ext(&bjj::IDENTITY); [id, id, id, id] }
fn now_slot() -> Result<u64> { Ok(Clock::get()?.slot) }

// ------------------------------------------------------------------------------------------------ handlers
pub fn init_committee(ctx: Context<InitCommittee>) -> Result<()> {
    let c = &mut ctx.accounts.committee; c.authority = ctx.accounts.authority.key(); c.bump = ctx.bumps.committee; Ok(())
}
/// Register (or rotate to) a committee: threshold t of n, the joint key, each member's key share and node key, the DKG
/// transcript hash. Batches opened under an older key cannot settle (their shares would not match): they refund.
pub fn set_committee(ctx: Context<CommitteeAdmin>, t: u8, n: u8, kind: u8, pk: [u8; 64], members: Vec<[u8; 64]>, nodes: Vec<Pubkey>, transcript: [u8; 32]) -> Result<()> {
    require!(t >= 1 && t <= n && n as usize <= MAX_MEMBERS && members.len() == n as usize && nodes.len() == n as usize && kind <= 1, EntryError::BadCommittee);
    let pkp = bjj::decode(&pk).ok_or(EntryError::BadPoint)?; require!(!bjj::is_identity(&pkp), EntryError::BadPoint);
    let pts: Vec<Ext> = members.iter().map(|m| bjj::decode(m).ok_or(error!(EntryError::BadPoint))).collect::<Result<_>>()?;
    // the shares must interpolate to the key: Δ·PK == Σ Δλ_i·PK_i over members 1..t
    let s: Vec<u8> = (1..=t).collect(); let (delta, mu) = lagrange_int(&s, n);
    let mut r = bjj::neg(&bjj::mul_small(&pkp, delta)); for (i, m) in mu.iter().enumerate() { r = bjj::add_ext(&r, &bjj::mul_small(&pts[i], *m)); }
    require!(bjj::is_identity(&bjj::times8(&r)), EntryError::BadCommittee);
    let c = &mut ctx.accounts.committee;
    c.t = t; c.n = n; c.kind = kind; c.pk = pk; c.transcript = transcript; c.epoch = c.epoch.wrapping_add(1);
    c.members = [[0u8; 64]; MAX_MEMBERS]; c.nodes = [Pubkey::default(); MAX_MEMBERS];
    for i in 0..n as usize { c.members[i] = members[i]; c.nodes[i] = nodes[i]; }
    emit!(CommitteeSet { epoch: c.epoch, t, n, kind, pk, transcript });
    Ok(())
}
pub fn propose_committee_authority(ctx: Context<CommitteeAdmin>, next: Pubkey) -> Result<()> { ctx.accounts.committee.pending_authority = next; Ok(()) }
pub fn accept_committee_authority(ctx: Context<AcceptCommitteeAuthority>) -> Result<()> {
    let c = &mut ctx.accounts.committee; require_keys_eq!(c.pending_authority, ctx.accounts.next.key(), EntryError::NotAuthority);
    c.authority = ctx.accounts.next.key(); c.pending_authority = Pubkey::default(); Ok(())
}
fn check_params(p: &SealedParams) -> Result<()> {
    require!(p.epoch_slots >= 1 && p.epoch_slots <= 216_000 && p.settle_timeout >= 10 && p.settle_timeout <= 216_000 && p.k_min >= 1 && p.k_min as u32 <= MAX_PER_DIRECTION
        && p.min_in[0] > 0 && p.min_in[1] > 0 && p.min_in[0] < (1u64 << AMOUNT_BITS) && p.min_in[1] < (1u64 << AMOUNT_BITS), EntryError::BadParams);
    Ok(())
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SealedParams { pub epoch_slots: u64, pub settle_timeout: u64, pub min_in: [u64; 2], pub k_min: u8, pub max_rollovers: u8, pub max_drift: u16 }
/// Sealed swaps for a bin pool (committee authority): its settings and batch 0, open from now.
pub fn init_sealed_pool(ctx: Context<InitSealedPool>, p: SealedParams) -> Result<()> {
    check_params(&p)?;
    let (mx, my) = { let b = ctx.accounts.bin_pool.load()?; (b.mint_x, b.mint_y) };
    let s = &mut ctx.accounts.sealed;
    s.bin_pool = ctx.accounts.bin_pool.key(); s.mint_x = mx; s.mint_y = my; s.seq = 0; s.bump = ctx.bumps.sealed;
    s.epoch_slots = p.epoch_slots; s.settle_timeout = p.settle_timeout; s.min_in = p.min_in; s.k_min = p.k_min; s.max_rollovers = p.max_rollovers; s.max_drift = p.max_drift;
    let now = now_slot()?;
    let mut b = ctx.accounts.batch.load_init()?;
    init_batch(&mut b, &ctx.accounts.bin_pool.key(), 0, now, now + p.epoch_slots, ctx.accounts.committee.epoch);
    emit!(BatchOpened { bin_pool: b.bin_pool, seq: 0, end_slot: b.end_slot });
    Ok(())
}
pub fn set_sealed_params(ctx: Context<SealedAdmin>, p: SealedParams, paused: bool) -> Result<()> {
    check_params(&p)?; let s = &mut ctx.accounts.sealed;
    s.epoch_slots = p.epoch_slots; s.settle_timeout = p.settle_timeout; s.min_in = p.min_in; s.k_min = p.k_min; s.max_rollovers = p.max_rollovers; s.max_drift = p.max_drift; s.paused = paused as u8;
    Ok(())
}
fn init_batch(b: &mut Batch, bin_pool: &Pubkey, seq: u64, start: u64, end: u64, epoch: u32) {
    b.bin_pool = *bin_pool; b.key = batch_key(bin_pool, seq); b.seq = seq; b.start_slot = start; b.end_slot = end; b.state = OPEN; b.committee_epoch = epoch; b.agg = new_aggregates();
}

/// A sealed swap: execute a posted swap proof into the current batch. The proof's bundle fixes the direction, the token
/// sold, the relayer's fee, the pool's minimum, the ciphertext and the committee key; the ciphertext is added into the
/// direction's aggregate. Submitted by the relayer: the user's wallet never appears and nobody learns the amount.
pub fn submit_swap(ctx: Context<SubmitSwap>, direction: u8, c1: [u8; 64], c2: [u8; 64], ext: SwapExt) -> Result<()> {
    let a = &ctx.accounts; let s = &a.sealed;
    require!(s.paused == 0, EntryError::SealedPaused);
    require!(direction < 2, EntryError::BadParams);
    let (seq, key, count) = { let mut b = a.batch.load_mut()?;
        require!(b.state == OPEN && b.seq == s.seq && now_slot()? < b.end_slot, EntryError::BatchNotOpen);
        // an empty batch adopts a rotated committee key (nothing was encrypted to the old one yet)
        if b.count[0] + b.count[1] == 0 { b.committee_epoch = a.committee.epoch; }
        require!(b.committee_epoch == a.committee.epoch, EntryError::BadCommittee);
        require!(b.count[direction as usize] < MAX_PER_DIRECTION, EntryError::BatchFull);
        (b.seq, b.key, b.count) };
    let mint = if direction == 0 { s.mint_x } else { s.mint_y };
    require_keys_eq!(a.mint_in.key(), mint, EntryError::UnknownToken);
    let posted = read_posted(&a.posted)?;
    require!(posted.kind == veyl_pool::KIND_SWAP && posted.pubs[5] == key, EntryError::BadContext);
    require!(bjj::decode_trusted(&c1).is_some() && bjj::decode_trusted(&c2).is_some(), EntryError::BadPoint);
    let bundle = swap_bundle(direction, &veyl_pool::asset_of(&mint), ext.fee, s.min_in[direction as usize], &c1, &c2, &a.committee.pk)?;
    require!(posted.pubs[6] == bundle, EntryError::BadContext);
    if ext.fee > 0 { require_keys_eq!(a.relayer_token.as_ref().ok_or(EntryError::WrongRecipient)?.key(), ext.relayer, EntryError::WrongRecipient); }
    let eh = swap_ext_hash(&ext)?;
    let bump = a.entry.signer_bump; let seeds = signer_seeds(bump); let sg: &[&[u8]] = &[b"signer", &seeds[0]]; let sgs = [sg];
    let cpi = CpiContext::new_with_signer(a.veyl_pool.to_account_info(), veyl_pool::cpi::accounts::ConsumeSealed { processor: a.signer.to_account_info(), payer: a.relayer.to_account_info(), shield: a.shield.to_account_info(),
        posted: a.posted.to_account_info(), poster: a.poster.to_account_info(), nullifier0: a.nullifier0.to_account_info(), nullifier1: Some(a.nullifier1.to_account_info()),
        mint: Some(a.mint_in.to_account_info()), vault: Some(a.shield_vault.to_account_info()), relayer_token: a.relayer_token.as_ref().map(|x| x.to_account_info()), token_program: Some(a.token_program.to_account_info()), system_program: a.system_program.to_account_info(), event_authority: a.pool_events.to_account_info(), program: a.veyl_pool.to_account_info() }, &sgs);
    veyl_pool::cpi::consume_swap(cpi, eh, ext.fee, vec![ext.enc_change.clone(), ext.enc_swap.clone()])?;
    // the ciphertext joins its direction's aggregate (valid curve points: the proof computed them)
    let mut b = ctx.accounts.batch.load_mut()?; let d = direction as usize;
    for (k, ct) in [(2 * d, &c1), (2 * d + 1, &c2)] { let p = bjj::decode_trusted(ct).unwrap(); let sum = bjj::add_cached(&ext_of(&b.agg[k]), &bjj::to_cached(&p)); b.agg[k] = store_ext(&sum); }
    b.count[d] += 1;
    emit!(SealedSwapSubmitted { bin_pool: b.bin_pool, seq, direction, count: [count[0] + (d == 0) as u32, count[1] + (d == 1) as u32] });
    Ok(())
}

/// End an epoch (anyone). Too few swaps in a direction: the batch stays open one more epoch, up to `max_rollovers` times,
/// then fails (refunds). Otherwise it is sealed and its aggregates published in affine form; the next batch opens.
pub fn close_batch(ctx: Context<CloseBatch>) -> Result<()> {
    let now = now_slot()?; let s = &mut ctx.accounts.sealed; let bin_pool = s.bin_pool;
    let (seq, close) = {
        let mut b = ctx.accounts.batch.load_mut()?;
        require!(b.state == OPEN && b.seq == s.seq, EntryError::BatchNotOpen);
        require!(now >= b.end_slot, EntryError::EpochNotOver);
        let k = s.k_min as u32; let under = (0..2).any(|d| b.count[d] > 0 && b.count[d] < k);
        if b.count[0] + b.count[1] == 0 { b.end_slot = now + s.epoch_slots; b.committee_epoch = ctx.accounts.committee.epoch; emit!(BatchRolled { bin_pool, seq: b.seq, end_slot: b.end_slot, rollovers: b.rollovers, count: b.count }); return Ok(()); }
        if under && b.rollovers < s.max_rollovers { b.rollovers += 1; b.end_slot = now + s.epoch_slots; emit!(BatchRolled { bin_pool, seq: b.seq, end_slot: b.end_slot, rollovers: b.rollovers, count: b.count }); return Ok(()); }
        b.closed_slot = now;
        if under { b.state = FAILED; emit!(BatchFailed { bin_pool, seq: b.seq, count: b.count, reason: 0 }); (b.seq, false) }
        else {
            b.state = CLOSED; b.active_at_close = ctx.accounts.bin_pool.load()?.active_id;
            let pts: Vec<Ext> = (0..4).map(|k| ext_of(&b.agg[k])).collect(); let aff = bjj::encode_many(&pts);
            for k in 0..4 { b.agg_aff[k] = aff[k]; }
            emit!(BatchClosed { bin_pool, seq: b.seq, count: b.count, aggregates: b.agg_aff });
            (b.seq, true)
        }
    };
    let _ = close;
    // the next batch
    let next = seq + 1; let seed = next.to_le_bytes();
    let (addr, bump) = Pubkey::find_program_address(&[b"batch", bin_pool.as_ref(), &seed], &crate::ID);
    require_keys_eq!(ctx.accounts.next_batch.key(), addr, EntryError::BadParams);
    let rent = Rent::get()?.minimum_balance(Batch::SIZE);
    anchor_lang::system_program::create_account(CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), anchor_lang::system_program::CreateAccount { from: ctx.accounts.payer.to_account_info(), to: ctx.accounts.next_batch.to_account_info() },
        &[&[b"batch", bin_pool.as_ref(), &seed, &[bump]]]), rent, Batch::SIZE as u64, &crate::ID)?;
    {
        let info = ctx.accounts.next_batch.to_account_info(); let mut data = info.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&<Batch as anchor_lang::Discriminator>::DISCRIMINATOR[..8]);
        let b: &mut Batch = bytemuck::from_bytes_mut(&mut data[8..Batch::SIZE]);
        init_batch(b, &bin_pool, next, now, now + s.epoch_slots, ctx.accounts.committee.epoch);
    }
    s.seq = next;
    emit!(BatchOpened { bin_pool, seq: next, end_slot: now + s.epoch_slots });
    Ok(())
}

/// A committee member's partial decryption of a closed batch's two aggregates, with its Chaum–Pedersen proof (A, B_a,
/// B_b, s): checked as 8·(z1·(s·B - c·PK_i - A) + (s·C1a - c·D_a - B_a) + z3·(s·C1b - c·D_b - B_b)) == O, c, z1, z3 from
/// the transcript. Starts the check; `share_step` continues it until it is done (the share is then recorded).
pub fn post_share(ctx: Context<PostShare>, member: u8, da: [u8; 64], db: [u8; 64], ap: [u8; 64], ba: [u8; 64], bb: [u8; 64], s: [u8; 32]) -> Result<()> {
    let c = &ctx.accounts.committee;
    require!(member >= 1 && member <= c.n, EntryError::NotMember);
    require_keys_eq!(c.nodes[member as usize - 1], ctx.accounts.node.key(), EntryError::NotMember);
    let (key, c1a, c1b) = { let b = ctx.accounts.batch.load()?;
        require!(b.state == CLOSED, EntryError::BatchNotClosed); require!(b.committee_epoch == c.epoch, EntryError::BadCommittee);
        require!(b.verified & (1 << (member - 1)) == 0, EntryError::ShareKnown);
        (b.key, b.agg_aff[0], b.agg_aff[2]) };
    for p in [&da, &db, &ap, &ba, &bb] { require!(bjj::decode(p).is_some(), EntryError::BadPoint); }
    let sw = le_of_be(&s); require!(lt_l(&sw), EntryError::BadShare);
    let pki = c.members[member as usize - 1];
    let (cc, z1, z3) = dleq_challenge(&key, member, [&pki, &c1a, &c1b, &da, &db, &ap, &ba, &bb]);
    let neg = |d: [i8; 65]| { let mut o = d; for x in o.iter_mut() { *x = -*x; } o };
    emit!(SharePosted { batch: ctx.accounts.batch.key(), member });
    // (the discriminator is written when the instruction exits: work through the init borrow)
    let done = { let mut j = ctx.accounts.job.load_init()?;
        j.batch = ctx.accounts.batch.key(); j.node = ctx.accounts.node.key(); j.member = member; j.window = 64;
        j.digits = [bjj::recode(&mul_mod_l(&sw, &z1)), neg(bjj::recode(&mul_mod_l(&cc, &z1))), neg(bjj::recode(&z1)), bjj::recode(&sw), neg(bjj::recode(&cc)), bjj::recode(&mul_mod_l(&sw, &z3)), neg(bjj::recode(&mul_mod_l(&cc, &z3))), neg(bjj::recode(&z3))];
        j.pts = [da, db, ap, ba, bb]; j.acc = store_ext(&bjj::IDENTITY);
        let b = ctx.accounts.batch.load()?; run_job(&mut j, &b, c, POST_SHARE_BUDGET)? };
    if done { finish_job(&ctx.accounts.job.to_account_info(), &ctx.accounts.batch, &ctx.accounts.node.to_account_info())?; }
    Ok(())
}
/// Continue a share check (anyone may crank it; the rent goes back to the member's node when it completes).
pub fn share_step(ctx: Context<ShareStep>) -> Result<()> {
    let node = { let j = ctx.accounts.job.load()?; require_keys_eq!(j.batch, ctx.accounts.batch.key(), EntryError::BadParams); j.node };
    require_keys_eq!(ctx.accounts.node.key(), node, EntryError::NotMember);
    { let b = ctx.accounts.batch.load()?; require!(b.state == CLOSED && b.committee_epoch == ctx.accounts.committee.epoch, EntryError::BatchNotClosed); }
    let done = { let mut j = ctx.accounts.job.load_mut()?; let b = ctx.accounts.batch.load()?; run_job(&mut j, &b, &ctx.accounts.committee, SHARE_STEP_BUDGET)? };
    if done { finish_job(&ctx.accounts.job.to_account_info(), &ctx.accounts.batch, &ctx.accounts.node.to_account_info())?; }
    Ok(())
}
/// Give up a share check (its node; e.g. one that failed): rent back.
pub fn cancel_share(_ctx: Context<CancelShare>) -> Result<()> { Ok(()) }

/// Runs the share check for up to `budget` compute units (see TABLE_CU). Stages: 0 = window tables of the 7 variable
/// points, 1 = the 65 windows (4 doublings, then the signed digit of every term), 2 = the last term, the cofactor and the verdict.
fn run_job(j: &mut ShareJob, b: &Batch, c: &Committee, budget: u32) -> Result<bool> {
    let mut left = budget;
    loop {
        let cost = match j.stage { 0 => TABLE_CU, 1 => { let w = j.window as usize; WINDOW_CU + DIGIT_CU * j.digits.iter().filter(|d| d[w] != 0).count() as u32 } _ => FINAL_CU };
        if cost > left { return Ok(false); }
        left -= cost;
        match j.stage { 0 => stage_table(j, b, c)?, 1 => stage_window(j), _ => { stage_final(j)?; return Ok(true); } }
    }
}
#[inline(never)]
fn stage_table(j: &mut ShareJob, b: &Batch, c: &Committee) -> Result<()> {
    let i = j.tables_done as usize;
    let src: [u8; 64] = match i { 0 => c.members[j.member as usize - 1], 1 => j.pts[2], 2 => b.agg_aff[0], 3 => j.pts[0], 4 => b.agg_aff[2], 5 => j.pts[1], _ => j.pts[4] };
    let p = bjj::decode_trusted(&src).ok_or(EntryError::BadPoint)?;
    build_table(&p, &mut j.tabs[i]);
    j.tables_done += 1; if j.tables_done == 7 { j.stage = 1; }
    Ok(())
}
/// 1P..8P of p, cached, written straight into the job (SBF frames are 4 KB: few points alive at a time).
#[inline(never)]
fn build_table(p: &Ext, out: &mut [[Limbs; 4]; 8]) {
    let c1 = bjj::to_cached(p); out[0] = store_cached(&c1);
    let p2 = bjj::dbl(p); out[1] = store_cached(&bjj::to_cached(&p2));
    let p3 = bjj::add_cached(&p2, &c1); out[2] = store_cached(&bjj::to_cached(&p3));
    let p4 = bjj::dbl(&p2); out[3] = store_cached(&bjj::to_cached(&p4));
    let p5 = bjj::add_cached(&p4, &c1); out[4] = store_cached(&bjj::to_cached(&p5));
    let p6 = bjj::dbl(&p3); out[5] = store_cached(&bjj::to_cached(&p6));
    let p7 = bjj::add_cached(&p6, &c1); out[6] = store_cached(&bjj::to_cached(&p7));
    let p8 = bjj::dbl(&p4); out[7] = store_cached(&bjj::to_cached(&p8));
}
#[inline(never)]
fn stage_window(j: &mut ShareJob) {
    let w = j.window as usize; let mut acc = ext_of(&j.acc);
    if j.window != 64 { acc = bjj::dbl(&bjj::dbl(&bjj::dbl(&bjj::dbl(&acc)))); }
    let d0 = j.digits[0][w]; if d0 != 0 { acc = signed_add(&acc, &bjj::btab(0, d0.unsigned_abs() as usize), d0); }
    for t in 0..7 { let d = j.digits[t + 1][w]; if d != 0 { acc = signed_add(&acc, &cached_of(&j.tabs[t][d.unsigned_abs() as usize - 1]), d); } }
    j.acc = store_ext(&acc); j.window -= 1; if j.window < 0 { j.stage = 2; }
}
#[inline(never)]
fn stage_final(j: &mut ShareJob) -> Result<()> {
    let ba = bjj::decode_trusted(&j.pts[3]).ok_or(EntryError::BadPoint)?;
    let r = bjj::times8(&bjj::add_ext(&ext_of(&j.acc), &bjj::neg(&ba)));
    require!(bjj::is_identity(&r), EntryError::BadShare);
    Ok(())
}
fn finish_job<'info>(job: &AccountInfo<'info>, batch: &AccountLoader<'info, Batch>, node: &AccountInfo<'info>) -> Result<()> {
    let (member, da, db) = { let d = job.try_borrow_data()?; let j: &ShareJob = bytemuck::from_bytes(&d[8..ShareJob::SIZE]); (j.member, j.pts[0], j.pts[1]) };
    { let mut b = batch.load_mut()?; b.shares[member as usize - 1] = [da, db]; b.verified |= 1 << (member - 1); emit!(ShareVerified { bin_pool: b.bin_pool, seq: b.seq, member }); }
    // close the job: rent back to the node
    let l = job.lamports(); **node.try_borrow_mut_lamports()? += l; **job.try_borrow_mut_lamports()? = 0;
    job.assign(&anchor_lang::system_program::ID); job.resize(0)?;
    Ok(())
}

/// Check one direction's recovered total (anyone): with t verified shares S, 8·(Δ·C2 - Σ_{i∈S} Δλ_i·D_i) == (8·Δ·total)·B.
pub fn settle_verify(ctx: Context<SettleVerify>, direction: u8, total: u64) -> Result<()> {
    let c = &ctx.accounts.committee; let mut b = ctx.accounts.batch.load_mut()?; let d = direction as usize;
    require!(direction < 2 && b.state == CLOSED && b.committee_epoch == c.epoch, EntryError::BatchNotClosed);
    require!(b.totals_ok & (1 << d) == 0, EntryError::ShareKnown);
    if b.count[d] == 0 { require!(total == 0, EntryError::BadTotal); }
    else {
        require!(total > 0 && total < TOTAL_LIMIT, EntryError::BadTotal);
        let s: Vec<u8> = (1..=c.n).filter(|i| b.verified & (1 << (i - 1)) != 0).take(c.t as usize).collect();
        require!(s.len() == c.t as usize, EntryError::NotEnoughShares);
        let (delta, mu) = lagrange_int(&s, c.n);
        let mut r = bjj::mul_small(&ext_of(&b.agg[2 * d + 1]), delta);
        for (i, m) in s.iter().zip(mu.iter()) { let di = bjj::decode_trusted(&b.shares[*i as usize - 1][d]).ok_or(EntryError::BadPoint)?; r = bjj::add_ext(&r, &bjj::mul_small(&di, -*m)); }
        let m8 = (total as u128) * 8 * (delta as u128); require!(m8 < (1u128 << 62), EntryError::BadTotal);
        require!(bjj::pt_eq(&bjj::times8(&r), &bjj::mul_base_small(m8 as u64)), EntryError::BadTotal);
    }
    b.totals[d] = total; b.totals_ok |= 1 << d;
    emit!(TotalVerified { bin_pool: b.bin_pool, seq: b.seq, direction, total });
    Ok(())
}

/// Settle a closed batch whose two totals are verified (anyone, within `settle_timeout` slots of closing): net the
/// directions at the active bin's price, swap the excess through the bin pool once, record the clearing ratios.
pub fn settle_batch<'info>(ctx: Context<'_, '_, 'info, 'info, SettleBatch<'info>>) -> Result<()> {
    let now = now_slot()?; let s = &ctx.accounts.sealed;
    let (ta, tb, seq) = { let b = ctx.accounts.batch.load()?;
        require!(b.state == CLOSED && b.totals_ok == 3, EntryError::BatchNotClosed);
        require!(now <= b.closed_slot + s.settle_timeout, EntryError::SettleTimeout);
        let id = ctx.accounts.bin_pool.load()?.active_id;
        require!((id as i64 - b.active_at_close as i64).unsigned_abs() <= s.max_drift as u64, EntryError::PriceDrift);
        (b.totals[0], b.totals[1], b.seq) };
    let (price, active, bps) = { let p = ctx.accounts.bin_pool.load()?; (veyl_bin::price_of(&p.base_price, &p.step_q, p.active_id)?, p.active_id, p.protocol_fee_bps) };
    let q128 = U512::one() << 128;
    let value_a = (U512::from(ta) * price) >> 128; /* what all of X sold is worth in Y at this price */
    let a = &ctx.accounts; let bump = a.entry.signer_bump;
    let (x_for_y, net_in, out, matched_x, matched_y);
    if value_a >= U512::from(tb) {
        let mx = ((U512::from(tb) * q128) / price).low_u64().min(ta); let net = ta - mx;
        let o = if net > 0 { net_swap(a, ctx.remaining_accounts, true, net, bump)? } else { 0 };
        x_for_y = true; net_in = net; out = o; matched_x = mx; matched_y = tb;
    } else {
        let my = value_a.low_u64(); let net = tb - my;
        let o = net_swap(a, ctx.remaining_accounts, false, net, bump)?;
        x_for_y = false; net_in = net; out = o; matched_x = ta; matched_y = my;
    }
    // The matched part pays the protocol fee too (the net part paid it in its swap): only totals are known, so the fee on
    // each side's matched value comes off what that side receives (X sellers get Y: fee on matched_y, in Y; Y sellers get
    // X: fee on matched_x, in X), rounded up, out of the shielded vaults into the bin pool's protocol balance.
    let fee_x = veyl_bin::protocol_fee_of(matched_x, bps); let fee_y = veyl_bin::protocol_fee_of(matched_y, bps);
    let (recv_y, recv_x) = if x_for_y { (tb.checked_add(out), Some(matched_x)) } else { (Some(matched_y), ta.checked_add(out)) };
    let num = [recv_y.and_then(|v| v.checked_sub(fee_y)).ok_or(EntryError::AmountMismatch)?, recv_x.and_then(|v| v.checked_sub(fee_x)).ok_or(EntryError::AmountMismatch)?];
    let den = [ta, tb];
    if fee_x > 0 || fee_y > 0 { pay_matched_fee(a, fee_x, fee_y, bump)?; }
    let mut b = ctx.accounts.batch.load_mut()?;
    b.state = SETTLED; b.settled_slot = now; b.x_for_y = x_for_y as u8; b.net_in = net_in; b.net_out = out; b.num = num; b.den = den; b.settle_id = active;
    let pb = price.to_big_endian();
    emit!(BatchSettled { bin_pool: b.bin_pool, seq, totals: [ta, tb], count: b.count, x_for_y, net_in, net_out: out, active_id: active, price: pb[32..].try_into().unwrap(), num, den, protocol_fee: [fee_x, fee_y] });
    Ok(())
}
/// The protocol fee on a batch's matched part: out of the shielded vaults, through the entry vaults, into the bin pool.
fn pay_matched_fee<'info>(a: &SettleBatch<'info>, fee_x: u64, fee_y: u64, bump: u8) -> Result<()> {
    let seeds = signer_seeds(bump); let sg: &[&[u8]] = &[b"signer", &seeds[0]]; let sgs = [sg];
    for (amt, mint, sv, ev, tp) in [(fee_x, &a.mint_x, &a.shield_vault_x, &a.entry_vault_x, &a.token_program_x), (fee_y, &a.mint_y, &a.shield_vault_y, &a.entry_vault_y, &a.token_program_y)] {
        if amt == 0 { continue; }
        veyl_pool::cpi::shield_pay(CpiContext::new_with_signer(a.veyl_pool.to_account_info(), veyl_pool::cpi::accounts::ShieldPay { processor: a.signer.to_account_info(), shield: a.shield.to_account_info(), mint: mint.to_account_info(), vault: sv.to_account_info(), to: ev.to_account_info(), token_program: tp.to_account_info() }, &sgs), amt)?; }
    let accs = veyl_bin::cpi::accounts::MintLiquidity { from: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(), mint_x: a.mint_x.to_account_info(), mint_y: a.mint_y.to_account_info(), vault_x: a.bin_vault_x.to_account_info(), vault_y: a.bin_vault_y.to_account_info(),
        from_x: a.entry_vault_x.to_account_info(), from_y: a.entry_vault_y.to_account_info(), token_program_x: a.token_program_x.to_account_info(), token_program_y: a.token_program_y.to_account_info() };
    veyl_bin::cpi::pay_protocol_fee(CpiContext::new_with_signer(a.veyl_bin.to_account_info(), accs, &sgs), fee_x, fee_y)
}
/// The batch's one swap: `amount` of the excess token out of the shielded vault, through the bin pool, the output back in.
fn net_swap<'info>(a: &SettleBatch<'info>, rem: &'info [AccountInfo<'info>], x_for_y: bool, amount: u64, bump: u8) -> Result<u64> {
    let seeds = signer_seeds(bump); let sg: &[&[u8]] = &[b"signer", &seeds[0]]; let sgs = [sg];
    let (mi, sv_in, ev_in, tpi, mo, sv_out, ev_out, tpo) = if x_for_y { (&a.mint_x, &a.shield_vault_x, &a.entry_vault_x, &a.token_program_x, &a.mint_y, &a.shield_vault_y, &a.entry_vault_y, &a.token_program_y) }
        else { (&a.mint_y, &a.shield_vault_y, &a.entry_vault_y, &a.token_program_y, &a.mint_x, &a.shield_vault_x, &a.entry_vault_x, &a.token_program_x) };
    veyl_pool::cpi::shield_pay(CpiContext::new_with_signer(a.veyl_pool.to_account_info(), veyl_pool::cpi::accounts::ShieldPay { processor: a.signer.to_account_info(), shield: a.shield.to_account_info(), mint: mi.to_account_info(), vault: sv_in.to_account_info(), to: ev_in.to_account_info(), token_program: tpi.to_account_info() }, &sgs), amount)?;
    let amount_of = |i: &AccountInfo| -> Result<u64> { Ok(u64::from_le_bytes(i.try_borrow_data()?[64..72].try_into().unwrap())) };
    let before = amount_of(&ev_out.to_account_info())?;
    let accs = veyl_bin::cpi::accounts::Swap { user: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(), mint_x: a.mint_x.to_account_info(), mint_y: a.mint_y.to_account_info(), vault_x: a.bin_vault_x.to_account_info(), vault_y: a.bin_vault_y.to_account_info(),
        user_in: ev_in.to_account_info(), user_out: ev_out.to_account_info(), token_program_x: a.token_program_x.to_account_info(), token_program_y: a.token_program_y.to_account_info() };
    let out = veyl_bin::cpi::swap(CpiContext::new_with_signer(a.veyl_bin.to_account_info(), accs, &sgs).with_remaining_accounts(rem.to_vec()), x_for_y, amount, 0)?.get();
    let after = amount_of(&ev_out.to_account_info())?;
    require!(after.checked_sub(before) == Some(out), EntryError::AmountMismatch);
    token_interface::transfer_checked(CpiContext::new_with_signer(tpo.to_account_info(), TransferChecked { from: ev_out.to_account_info(), mint: mo.to_account_info(), to: sv_out.to_account_info(), authority: a.signer.to_account_info() }, &sgs), out, mo.decimals)?;
    Ok(out)
}
/// A closed batch that was not settled within `settle_timeout` slots fails (anyone): its swaps are refunded.
pub fn fail_batch(ctx: Context<FailBatch>) -> Result<()> {
    let now = now_slot()?; let mut b = ctx.accounts.batch.load_mut()?;
    require!(b.state == CLOSED && now > b.closed_slot + ctx.accounts.sealed.settle_timeout, EntryError::SettleTimeout);
    b.state = FAILED; emit!(BatchFailed { bin_pool: b.bin_pool, seq: b.seq, count: b.count, reason: 1 }); Ok(())
}

/// Claim a sealed swap's output (settled batch) or its refund (failed batch) with a posted claim proof: one hidden note.
pub fn claim_swap(ctx: Context<ClaimSwap>, direction: u8, ext: ClaimExt) -> Result<()> {
    require!(direction < 2, EntryError::BadParams);
    let now = now_slot()?; let s = &ctx.accounts.sealed; let d = direction as usize;
    let (key, refund, num, den) = { let mut b = ctx.accounts.batch.load_mut()?;
        if b.state == CLOSED && now > b.closed_slot + s.settle_timeout { b.state = FAILED; emit!(BatchFailed { bin_pool: b.bin_pool, seq: b.seq, count: b.count, reason: 1 }); }
        match b.state { SETTLED => { require!(b.den[d] > 0, EntryError::NotClaimable); (b.key, false, b.num[d], b.den[d]) } FAILED => (b.key, true, 1, 1), _ => return err!(EntryError::NotClaimable) } };
    let (mint_in, mint_other) = if d == 0 { (s.mint_x, s.mint_y) } else { (s.mint_y, s.mint_x) };
    let mint_out = if refund { mint_in } else { mint_other };
    let a = &ctx.accounts;
    require_keys_eq!(a.mint_out.key(), mint_out, EntryError::UnknownToken);
    let posted = read_posted(&a.posted)?;
    require!(posted.kind == veyl_pool::KIND_CLAIM && posted.pubs[3] == key, EntryError::BadContext);
    require!(posted.pubs[4] == claim_bundle(direction, &veyl_pool::asset_of(&mint_out), num, den, ext.fee)?, EntryError::BadContext);
    if ext.fee > 0 { require_keys_eq!(a.relayer_token.as_ref().ok_or(EntryError::WrongRecipient)?.key(), ext.relayer, EntryError::WrongRecipient); }
    let eh = claim_ext_hash(&ext)?;
    let bump = a.entry.signer_bump; let seeds = signer_seeds(bump); let sg: &[&[u8]] = &[b"signer", &seeds[0]]; let sgs = [sg];
    let cpi = CpiContext::new_with_signer(a.veyl_pool.to_account_info(), veyl_pool::cpi::accounts::ConsumeSealed { processor: a.signer.to_account_info(), payer: a.relayer.to_account_info(), shield: a.shield.to_account_info(),
        posted: a.posted.to_account_info(), poster: a.poster.to_account_info(), nullifier0: a.nullifier.to_account_info(), nullifier1: None,
        mint: Some(a.mint_out.to_account_info()), vault: Some(a.shield_vault.to_account_info()), relayer_token: a.relayer_token.as_ref().map(|x| x.to_account_info()), token_program: Some(a.token_program.to_account_info()), system_program: a.system_program.to_account_info(), event_authority: a.pool_events.to_account_info(), program: a.veyl_pool.to_account_info() }, &sgs);
    veyl_pool::cpi::consume_claim(cpi, eh, ext.fee, vec![ext.enc_out.clone()])?;
    let mut b = ctx.accounts.batch.load_mut()?; b.claims[d] += 1;
    emit!(SealedClaimed { bin_pool: b.bin_pool, seq: b.seq, direction, refund });
    Ok(())
}

// ------------------------------------------------------------------------------------------------ accounts
#[derive(Accounts)]
pub struct InitCommittee<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ EntryError::NotAuthority)]
    pub program: Program<'info, crate::program::VeylEntry>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ EntryError::NotAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = Committee::SIZE, seeds = [b"committee"], bump)] pub committee: Box<Account<'info, Committee>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CommitteeAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"committee"], bump = committee.bump, constraint = committee.authority == authority.key() @ EntryError::NotAuthority)] pub committee: Box<Account<'info, Committee>>,
}
#[derive(Accounts)]
pub struct AcceptCommitteeAuthority<'info> { pub next: Signer<'info>, #[account(mut, seeds = [b"committee"], bump = committee.bump)] pub committee: Box<Account<'info, Committee>> }
#[derive(Accounts)]
pub struct InitSealedPool<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(seeds = [b"committee"], bump = committee.bump, constraint = committee.authority == authority.key() @ EntryError::NotAuthority)] pub committee: Box<Account<'info, Committee>>,
    pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(init, payer = authority, space = SealedPool::SIZE, seeds = [b"sealed", bin_pool.key().as_ref()], bump)] pub sealed: Box<Account<'info, SealedPool>>,
    #[account(init, payer = authority, space = Batch::SIZE, seeds = [b"batch", bin_pool.key().as_ref(), &0u64.to_le_bytes()], bump)] pub batch: AccountLoader<'info, Batch>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SealedAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"committee"], bump = committee.bump, constraint = committee.authority == authority.key() @ EntryError::NotAuthority)] pub committee: Box<Account<'info, Committee>>,
    #[account(mut, seeds = [b"sealed", sealed.bin_pool.as_ref()], bump = sealed.bump)] pub sealed: Box<Account<'info, SealedPool>>,
}
#[derive(Accounts)]
pub struct SubmitSwap<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(seeds = [b"sealed", sealed.bin_pool.as_ref()], bump = sealed.bump)] pub sealed: Box<Account<'info, SealedPool>>,
    #[account(mut, seeds = [b"batch", sealed.bin_pool.as_ref(), &sealed.seq.to_le_bytes()], bump)] pub batch: AccountLoader<'info, Batch>,
    #[account(seeds = [b"committee"], bump = committee.bump)] pub committee: Box<Account<'info, Committee>>,
    /// CHECK: veyl_pool's shield
    #[account(mut, address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    /// CHECK: posted swap proof (kind and pubs read here; veyl_pool closes it)
    #[account(mut, owner = veyl_pool::ID)] pub posted: UncheckedAccount<'info>,
    /// CHECK: its poster (veyl_pool checks)
    #[account(mut)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier1: UncheckedAccount<'info>,
    pub mint_in: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the shielded vault of mint_in (veyl_pool checks)
    #[account(mut)] pub shield_vault: UncheckedAccount<'info>,
    #[account(mut)] pub relayer_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub system_program: Program<'info, System>,
    /// CHECK: veyl_pool's event authority PDA ["__event_authority"] (veyl_pool checks its seeds): signs the self-CPI that
    /// carries the tree's events
    pub pool_events: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct CloseBatch<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, seeds = [b"sealed", sealed.bin_pool.as_ref()], bump = sealed.bump)] pub sealed: Box<Account<'info, SealedPool>>,
    #[account(mut, seeds = [b"batch", sealed.bin_pool.as_ref(), &sealed.seq.to_le_bytes()], bump)] pub batch: AccountLoader<'info, Batch>,
    /// CHECK: the next batch's PDA (created here when the batch closes or fails)
    #[account(mut)] pub next_batch: UncheckedAccount<'info>,
    #[account(address = sealed.bin_pool @ EntryError::UnknownPool)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(seeds = [b"committee"], bump = committee.bump)] pub committee: Box<Account<'info, Committee>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(member: u8)]
pub struct PostShare<'info> {
    #[account(mut)] pub node: Signer<'info>,
    #[account(seeds = [b"committee"], bump = committee.bump)] pub committee: Box<Account<'info, Committee>>,
    #[account(mut)] pub batch: AccountLoader<'info, Batch>,
    #[account(init, payer = node, space = ShareJob::SIZE, seeds = [b"sharejob", batch.key().as_ref(), &[member]], bump)] pub job: AccountLoader<'info, ShareJob>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ShareStep<'info> {
    pub cranker: Signer<'info>,
    #[account(seeds = [b"committee"], bump = committee.bump)] pub committee: Box<Account<'info, Committee>>,
    #[account(mut)] pub batch: AccountLoader<'info, Batch>,
    #[account(mut)] pub job: AccountLoader<'info, ShareJob>,
    /// CHECK: the job's node (gets the rent back); checked against the job
    #[account(mut)] pub node: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct CancelShare<'info> {
    #[account(mut)] pub node: Signer<'info>,
    #[account(mut, close = node, constraint = job.load()?.node == node.key() @ EntryError::NotMember)] pub job: AccountLoader<'info, ShareJob>,
}
#[derive(Accounts)]
pub struct SettleVerify<'info> {
    #[account(seeds = [b"committee"], bump = committee.bump)] pub committee: Box<Account<'info, Committee>>,
    #[account(mut)] pub batch: AccountLoader<'info, Batch>,
}
#[derive(Accounts)]
pub struct SettleBatch<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(seeds = [b"sealed", sealed.bin_pool.as_ref()], bump = sealed.bump)] pub sealed: Box<Account<'info, SealedPool>>,
    #[account(mut, constraint = batch.load()?.bin_pool == sealed.bin_pool @ EntryError::UnknownPool)] pub batch: AccountLoader<'info, Batch>,
    #[account(mut, address = sealed.bin_pool @ EntryError::UnknownPool)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(address = sealed.mint_x @ EntryError::UnknownToken)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = sealed.mint_y @ EntryError::UnknownToken)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the bin pool's vaults (veyl_bin checks)
    #[account(mut)] pub bin_vault_x: UncheckedAccount<'info>,
    /// CHECK: as above
    #[account(mut)] pub bin_vault_y: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = signer, associated_token::token_program = token_program_x)] pub entry_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = signer, associated_token::token_program = token_program_y)] pub entry_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: veyl_pool's shield
    #[account(address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = shield, associated_token::token_program = token_program_x)] pub shield_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = shield, associated_token::token_program = token_program_y)] pub shield_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
}
#[derive(Accounts)]
pub struct FailBatch<'info> {
    #[account(seeds = [b"sealed", sealed.bin_pool.as_ref()], bump = sealed.bump)] pub sealed: Box<Account<'info, SealedPool>>,
    #[account(mut, constraint = batch.load()?.bin_pool == sealed.bin_pool @ EntryError::UnknownPool)] pub batch: AccountLoader<'info, Batch>,
}
#[derive(Accounts)]
pub struct ClaimSwap<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(seeds = [b"sealed", sealed.bin_pool.as_ref()], bump = sealed.bump)] pub sealed: Box<Account<'info, SealedPool>>,
    #[account(mut, constraint = batch.load()?.bin_pool == sealed.bin_pool @ EntryError::UnknownPool)] pub batch: AccountLoader<'info, Batch>,
    /// CHECK: veyl_pool's shield
    #[account(mut, address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    /// CHECK: posted claim proof (kind and pubs read here; veyl_pool closes it)
    #[account(mut, owner = veyl_pool::ID)] pub posted: UncheckedAccount<'info>,
    /// CHECK: its poster (veyl_pool checks)
    #[account(mut)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA of the swap commitment
    #[account(mut)] pub nullifier: UncheckedAccount<'info>,
    pub mint_out: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the shielded vault of mint_out (veyl_pool checks)
    #[account(mut)] pub shield_vault: UncheckedAccount<'info>,
    #[account(mut)] pub relayer_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub system_program: Program<'info, System>,
    /// CHECK: veyl_pool's event authority PDA ["__event_authority"] (veyl_pool checks its seeds): signs the self-CPI that
    /// carries the tree's events
    pub pool_events: UncheckedAccount<'info>,
}

// ------------------------------------------------------------------------------------------------ events
#[event] pub struct CommitteeSet { pub epoch: u32, pub t: u8, pub n: u8, pub kind: u8, pub pk: [u8; 64], pub transcript: [u8; 32] }
#[event] pub struct BatchOpened { pub bin_pool: Pubkey, pub seq: u64, pub end_slot: u64 }
#[event] pub struct SealedSwapSubmitted { pub bin_pool: Pubkey, pub seq: u64, pub direction: u8, pub count: [u32; 2] }
#[event] pub struct BatchRolled { pub bin_pool: Pubkey, pub seq: u64, pub end_slot: u64, pub rollovers: u8, pub count: [u32; 2] }
#[event] pub struct BatchClosed { pub bin_pool: Pubkey, pub seq: u64, pub count: [u32; 2], pub aggregates: [[u8; 64]; 4] }
#[event] pub struct BatchFailed { pub bin_pool: Pubkey, pub seq: u64, pub count: [u32; 2], pub reason: u8 }
#[event] pub struct SharePosted { pub batch: Pubkey, pub member: u8 }
#[event] pub struct ShareVerified { pub bin_pool: Pubkey, pub seq: u64, pub member: u8 }
#[event] pub struct TotalVerified { pub bin_pool: Pubkey, pub seq: u64, pub direction: u8, pub total: u64 }
#[event] pub struct BatchSettled { pub bin_pool: Pubkey, pub seq: u64, pub totals: [u64; 2], pub count: [u32; 2], pub x_for_y: bool, pub net_in: u64, pub net_out: u64, pub active_id: i32, pub price: [u8; 32], pub num: [u64; 2], pub den: [u64; 2], pub protocol_fee: [u64; 2] }
#[event] pub struct SealedClaimed { pub bin_pool: Pubkey, pub seq: u64, pub direction: u8, pub refund: bool }
