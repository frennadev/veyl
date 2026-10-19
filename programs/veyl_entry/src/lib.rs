//! Veyl entry on Solana. Port of `VeylEntrypoint.sol` + `VeylRouter.sol`: everything private goes through here, submitted
//! by a relayer so the user's wallet never appears.
//!
//!  relay           private balance -> any wallet (a fresh one, usually)
//!  private_swap    private balance -> routed swap through bin pools -> back into the private balance as a new note
//!  private_add     private balance -> liquidity position owned by a one-time key
//!  private_remove  position (signed by its one-time key, ed25519) -> back into the private balance
//!  private_claim_fees / private_claim_reward   fees / farm rewards a position earned (ed25519) -> new notes or a wallet
//!  private_place_order   private balance -> a limit order owned by a one-time key (proof)
//!  private_withdraw_order  a limit order, filled or not (ed25519) -> new notes or a wallet
//!  private_rebalance     move a position to a new range / shape in one instruction (ed25519)
//!  private_zap           private balance (one token) -> swap part through the pool -> a position (proof)
//!  swap_route      the public router: one swap split across several routes of up to a few hops each
//!
//! Each spend's parameters (including which action it is) are hashed into the proof's `context` by the pool program,
//! and each removal's into an ed25519 signature checked through the instructions sysvar (the EIP-712 replacement), so a
//! relayer can submit them but cannot change where the money goes. The relayer is paid a capped fee; every action has a
//! deadline.
//!
//! Solana shape: the processor is this program's signer PDA `["signer"]`; its associated token accounts hold funds only
//! for the duration of one instruction. Private pools are derived (`["pool", mint]` in veyl_pool), so there is no
//! `registerPool` and no owner who could re-point a token to another pool (an open finding in the EVM audit).
#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv as sha256v;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use veyl_bin::program::VeylBin;
use veyl_pool::program::VeylPool;

/// The heap: a bump allocator like the runtime's default, but growing upwards from the heap's start, giving back the most
/// recent allocation when it is freed and growing it in place (Vec growth, temporary encodings for CPIs), and allowed up to
/// 256 KB. A transaction gets 32 KB unless it asks for more (ComputeBudget `request_heap_frame`): every instruction fits in
/// 32 KB except the shielded liquidity actions, whose transactions request 256 KB (the relayer does).
#[cfg(all(target_os = "solana", feature = "custom-heap", not(feature = "no-entrypoint")))]
mod heap {
    use std::alloc::{GlobalAlloc, Layout};
    const HEAP_START: usize = 0x300000000;
    pub const HEAP_LEN: usize = 256 * 1024;
    struct Heap;
    #[inline] unsafe fn top() -> *mut usize { HEAP_START as *mut usize }
    unsafe impl GlobalAlloc for Heap {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let t = top(); let mut p = *t; if p == 0 { p = HEAP_START + core::mem::size_of::<usize>(); }
            let start = (p + l.align() - 1) & !(l.align() - 1);
            let end = match start.checked_add(l.size()) { Some(e) if e <= HEAP_START + HEAP_LEN => e, _ => return core::ptr::null_mut() };
            *t = end; start as *mut u8
        }
        unsafe fn dealloc(&self, ptr: *mut u8, l: Layout) { let t = top(); if ptr as usize + l.size() == *t { *t = ptr as usize; } }
        unsafe fn realloc(&self, ptr: *mut u8, l: Layout, new: usize) -> *mut u8 {
            let t = top();
            if ptr as usize + l.size() == *t { let end = ptr as usize + new; if end <= HEAP_START + HEAP_LEN { *t = end; return ptr; } return core::ptr::null_mut(); }
            let n = self.alloc(Layout::from_size_align_unchecked(new, l.align())); if !n.is_null() { core::ptr::copy_nonoverlapping(ptr, n, l.size().min(new)); } n
        }
    }
    #[global_allocator] static A: Heap = Heap;
}

pub mod bjj;
pub mod bjj_consts;
pub mod bjj_mul;
pub mod sealed;
pub use sealed::*;

#[cfg(not(feature = "mainnet"))]
declare_id!("4q6p4io7m3pgxpMqRDSKBRsAb6gCBGCKvTRabZtp1QHn");
#[cfg(feature = "mainnet")]
declare_id!("11111111111111111111111111111111"); // mainnet veyl_entry (npm run keys:mainnet)

pub const MAX_FEE_BPS: u16 = 100; // 1%
pub const RELAY: u8 = 1;
pub const SWAP: u8 = 2;
pub const ADD: u8 = 3;
pub const ORDER: u8 = 4;
pub const ZAP: u8 = 5;
/// Domain tags of what a one-time key signs (one per action, so a signature for one can never be replayed as another).
pub const TAG_REMOVE: &[u8] = b"veyl-remove-v1";
pub const TAG_CLAIM: &[u8] = b"veyl-claim-v1";
pub const TAG_REWARD: &[u8] = b"veyl-reward-v1";
pub const TAG_ORDER: &[u8] = b"veyl-order-v1";
pub const TAG_REBALANCE: &[u8] = b"veyl-rebalance-v1";
pub const MAX_HOPS: usize = 3;
pub const ED25519_PROGRAM: Pubkey = anchor_lang::solana_program::ed25519_program::ID;

// ------------------------------------------------------------------------------------------------ action data

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RelayData { pub recipient: Pubkey, pub fee_recipient: Pubkey, pub fee_bps: u16, pub deadline: i64 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Hop { pub pool: Pubkey, pub x_for_y: bool, pub n_arrays: u8 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Route { pub amount_in: u64, pub hops: Vec<Hop> }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapData {
    pub token_out: Pubkey, pub routes: Vec<Route>, pub min_out: u64,
    pub recipient: Option<Pubkey>, // None = deposit the output back into the private balance
    pub out_precommitment: [u8; 32],
    pub refund_to: Pubkey, // who can ragequit the new note if it is never approved (a one-time key)
    pub fee_recipient: Pubkey, pub fee_bps: u16, pub deadline: i64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AddData {
    pub bin_pool: Pubkey, pub ids: Vec<i32>, pub amounts_x: Vec<u64>, pub amounts_y: Vec<u64>, pub min_shares: Vec<u128>,
    pub owner: Pubkey, // one-time key; never holds funds or sends a transaction
    pub fee_recipient: Pubkey, pub fee_bps: u16, pub deadline: i64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RemoveData {
    pub owner: Pubkey, pub bin_pool: Pubkey, pub ids: Vec<i32>, pub shares: Vec<u128>,
    pub precommit_x: [u8; 32], pub precommit_y: [u8; 32],
    pub recipient: Option<Pubkey>, // None = back to the private balance, otherwise paid out publicly to its token accounts
    pub fee_recipient: Pubkey, pub fee_bps: u16, pub nonce: u64, pub deadline: i64,
}

/// Fees a private position earned, paid into new notes (or to `recipient`). Signed by the position's one-time key.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimData {
    pub owner: Pubkey, pub bin_pool: Pubkey, pub ids: Vec<i32>, pub precommit_x: [u8; 32], pub precommit_y: [u8; 32],
    pub recipient: Option<Pubkey>, pub fee_recipient: Pubkey, pub fee_bps: u16, pub nonce: u64, pub deadline: i64,
}
/// Farm reward `index` a private position earned, into a new note of the reward mint (or to `recipient`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RewardClaimData {
    pub owner: Pubkey, pub bin_pool: Pubkey, pub index: u8, pub ids: Vec<i32>, pub precommit: [u8; 32],
    pub recipient: Option<Pubkey>, pub fee_recipient: Pubkey, pub fee_bps: u16, pub nonce: u64, pub deadline: i64,
}
/// A limit order paid from the private balance (one leg: X for an ask, Y for a bid), owned by a one-time key. Proof-bound.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderData { pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub owner: Pubkey, pub fee_recipient: Pubkey, pub fee_bps: u16, pub deadline: i64 }
/// Withdraw `shares` of a private limit order (unfilled and filled parts) into new notes (or to `recipient`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderWithdrawData {
    pub owner: Pubkey, pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub shares: u128, pub precommit_x: [u8; 32], pub precommit_y: [u8; 32],
    pub recipient: Option<Pubkey>, pub fee_recipient: Pubkey, pub fee_bps: u16, pub nonce: u64, pub deadline: i64,
}
/// Burn `burn_shares` of `burn_ids` and re-add to `ids` by weights, the relayer fee withheld from the proceeds. A side with
/// no weights goes to new notes (or `recipient`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RebalanceData {
    pub owner: Pubkey, pub bin_pool: Pubkey, pub burn_ids: Vec<i32>, pub burn_shares: Vec<u128>,
    pub ids: Vec<i32>, pub weights_x: Vec<u16>, pub weights_y: Vec<u16>, pub min_shares: Vec<u128>,
    pub precommit_x: [u8; 32], pub precommit_y: [u8; 32], pub recipient: Option<Pubkey>,
    pub fee_recipient: Pubkey, pub fee_bps: u16, pub nonce: u64, pub deadline: i64,
}
/// One-token entry from the private balance: `swap_amount` of it is swapped through the pool (at least `min_swap_out`
/// back), the rest and the swap's output added to `ids` by weights. Proof-bound.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ZapData {
    pub bin_pool: Pubkey, pub x_in: bool, pub swap_amount: u64, pub min_swap_out: u64,
    pub ids: Vec<i32>, pub weights_x: Vec<u16>, pub weights_y: Vec<u16>, pub min_shares: Vec<u128>,
    pub owner: Pubkey, pub fee_recipient: Pubkey, pub fee_bps: u16, pub deadline: i64,
}

/// The bytes the pool hashes into the context: action tag + borsh(data). The same bytes the browser encodes.
pub fn encode<T: AnchorSerialize>(action: u8, d: &T) -> Result<Vec<u8>> { let mut v = vec![action]; d.serialize(&mut v)?; Ok(v) }
/// What the one-time key signs for a removal: sha256("veyl-remove-v1" || entry program id || borsh(RemoveData)).
pub fn remove_digest(d: &RemoveData) -> Result<[u8; 32]> { signed_digest(TAG_REMOVE, d) }
/// What a one-time key signs for any position action: sha256(tag || entry program id || borsh(data)).
pub fn signed_digest<T: AnchorSerialize>(tag: &[u8], d: &T) -> Result<[u8; 32]> { let mut v = Vec::new(); d.serialize(&mut v)?; Ok(sha256v(&[tag, crate::ID.as_ref(), &v]).to_bytes()) }

fn fee_of(v: u64, bps: u16) -> Result<u64> { require!(bps <= MAX_FEE_BPS, EntryError::FeeTooHigh); Ok(((v as u128 * bps as u128) / 10_000) as u64) }
pub(crate) fn signer_seeds(bump: u8) -> [[u8; 1]; 1] { [[bump]] }


// ------------------------------------------------------------------------------------------------ Phase 2: shielded actions
//
// Every action below is funded from the shielded pool (veyl_pool's one tree, notes with hidden amounts) and pays back into
// it. Value reaches a bin pool only as a public amount (a transact proof's withdrawal to this program's vault, bound to the
// action by `ext.action`), and what comes back out (swap output, removal proceeds, order shares, leftovers) is a receipt
// note whose amount is public but whose owner is a one-time key. Shielded liquidity is held by one aggregate owner per bin
// pool (`shield_owner()`), and each user's share of it is a position note (zk/circuits/position.circom), so the chain shows
// the aggregate and each action's change, never one holder's size.

pub const MIGRATE: u8 = 6;
/// Bins in a shielded position's window (= K in position.circom).
pub const K: usize = 16;
/// Largest aggregate share count per bin (the circuit range-checks shares to 112 bits).
pub const MAX_SHIELD_SHARES: u128 = 1u128 << 112;
pub const SHIELD_OWNER_SEED: &[u8] = b"shielded";
/// The owner of the shielded aggregate's share accounts (a PDA of this program that never signs; authority = signer PDA).
pub fn shield_owner() -> Pubkey { Pubkey::find_program_address(&[SHIELD_OWNER_SEED], &crate::ID).0 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ZapSwap { pub x_in: bool, pub amount: u64, pub min_out: u64 }
/// A shielded liquidity action on the window [lo, lo + 16): signed share changes per bin (add, remove, or both: an
/// in-window rebalance), optionally funded by up to two transact legs and a zap swap. Hashed into the position proof
/// (`lp_ext_hash`) and into every leg (`lp_action`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LpCore {
    pub bin_pool: Pubkey, pub lo: i32, pub deltas: Vec<i128>, pub hint_x: Vec<u64>, pub hint_y: Vec<u64>,
    pub zap: Option<ZapSwap>,
    /// relayer fee taken from the claimed fees (inside the proof) and paid from the shielded pool's vaults
    pub claim_fee: [u64; 2],
    /// relayer fee taken from the public leftovers (proceeds of a removal, unspent funding)
    pub leftover_fee: [u64; 2],
    /// one-time owners and blindings of the leftover receipts (X, Y)
    pub receipt_owner: [[u8; 32]; 2], pub receipt_blinding: [[u8; 32]; 2],
    /// most an add may pay for fees collected before it joined (see `shield_lp`)
    pub max_charge: [u64; 2],
    pub relayer: Pubkey, pub deadline: i64,
    /// the new position note, encrypted to its owner's viewing key
    pub ciphertext: Vec<u8>,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LpRequest { pub core: LpCore, pub legs: Vec<veyl_pool::TransactExt> }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapCore { pub token_out: Pubkey, pub routes: Vec<Route>, pub min_out: u64, pub receipt_owner: [u8; 32], pub receipt_blinding: [u8; 32], pub deadline: i64 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapRequest { pub core: SwapCore, pub leg: veyl_pool::TransactExt }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderCore { pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub receipt_owner: [u8; 32], pub receipt_blinding: [u8; 32], pub deadline: i64 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderRequest { pub core: OrderCore, pub leg: veyl_pool::TransactExt }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderWithdrawCore { pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub leftover_fee: [u64; 2], pub receipt_owner: [[u8; 32]; 2], pub receipt_blinding: [[u8; 32]; 2], pub relayer: Pubkey, pub deadline: i64 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderWithdrawRequest { pub core: OrderWithdrawCore, pub leg: veyl_pool::TransactExt }
/// A legacy note (Phase 1 pool, withdraw circuit) moved into the shielded pool as one receipt note.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MigrateData { pub owner: [u8; 32], pub blinding: [u8; 32], pub fee_recipient: Pubkey, pub fee_bps: u16, pub deadline: i64 }

fn tagged<T: AnchorSerialize>(tag: &[u8], d: &T) -> Result<[u8; 32]> { let mut v = Vec::new(); d.serialize(&mut v)?; Ok(sha256v(&[tag, &v]).to_bytes()) }
pub fn lp_action(c: &LpCore) -> Result<[u8; 32]> { tagged(b"veyl-lp-action", c) }
pub fn lp_ext_hash(c: &LpCore) -> Result<[u8; 32]> { let mut v = Vec::new(); c.serialize(&mut v)?; Ok(veyl_pool::hash_to_field(&[b"veyl-lp", &v])) }
pub fn swap_action(c: &SwapCore) -> Result<[u8; 32]> { tagged(b"veyl-swap-action", c) }
pub fn order_action(c: &OrderCore) -> Result<[u8; 32]> { tagged(b"veyl-order-action", c) }
pub fn order_withdraw_action(c: &OrderWithdrawCore) -> Result<[u8; 32]> { tagged(b"veyl-order-withdraw-action", c) }
/// Poseidon(Poseidon8(v[0..8]), Poseidon8(v[8..16])) = Hash16 in position.circom.
pub fn hash16(v: &[[u8; 32]]) -> Result<[u8; 32]> {
    require!(v.len() == K, EntryError::BadLegs);
    let a: Vec<&[u8; 32]> = v[..8].iter().collect(); let b: Vec<&[u8; 32]> = v[8..].iter().collect();
    veyl_pool::poseidon2(&veyl_pool::poseidon(&a)?, &veyl_pool::poseidon(&b)?)
}

/// Fee growth per shielded share for 60 bins of one bin pool (Q64.64 per token, monotone, raised only by what the
/// aggregate was actually paid). PDA ["lpacc", bin pool, chunk].
#[account(zero_copy)]
#[repr(C)]
pub struct LpAcc { pub pool: Pubkey, pub chunk: i32, pub _pad: [u8; 4], pub hx: [[u64; 2]; 60], pub hy: [[u64; 2]; 60] }
impl LpAcc { pub const SIZE: usize = 8 + 32 + 8 + 16 * 60 * 2; }
/// Request bytes written by the relayer in pieces (a shielded action's data and encrypted payload exceed one
/// transaction). PDA ["buf", owner, id]; consumed (closed) by the action.
#[account]
pub struct Buffer { pub owner: Pubkey, pub data: Vec<u8> }

// ------------------------------------------------------------------------------------------------ program

#[program]
pub mod veyl_entry {
    use super::*;

    pub fn init_entry(ctx: Context<InitEntry>) -> Result<()> {
        let e = &mut ctx.accounts.entry; e.bump = ctx.bumps.entry; e.signer_bump = ctx.bumps.signer; Ok(())
    }

    /// Create the entry's token account for a mint (anyone may pay for it).
    pub fn init_vault(_ctx: Context<InitVault>) -> Result<()> { Ok(()) }

    /// Private balance -> a wallet. EVM: relay(pool, w, p).
    pub fn relay(ctx: Context<Relay>, d: RelayData) -> Result<()> {
        require!(Clock::get()?.unix_timestamp <= d.deadline, EntryError::Expired);
        require_keys_eq!(ctx.accounts.recipient_token.owner, d.recipient, EntryError::WrongRecipient);
        require_keys_eq!(ctx.accounts.fee_token.owner, d.fee_recipient, EntryError::WrongRecipient);
        let bump = ctx.accounts.entry.signer_bump;
        let data = encode(RELAY, &d)?;
        let v = withdraw_cpi(&ctx.accounts.veyl_pool, &ctx.accounts.signer, &ctx.accounts.pool, &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.spend, &ctx.accounts.entry_vault, &ctx.accounts.token_program, bump, data)?;
        let fee = fee_of(v, d.fee_bps)?;
        if fee > 0 { pay(&ctx.accounts.token_program, &ctx.accounts.entry_vault, &ctx.accounts.mint, &ctx.accounts.fee_token, &ctx.accounts.signer, bump, fee)?; }
        pay(&ctx.accounts.token_program, &ctx.accounts.entry_vault, &ctx.accounts.mint, &ctx.accounts.recipient_token, &ctx.accounts.signer, bump, v - fee)?;
        emit!(Relayed { pool: ctx.accounts.pool.key(), recipient: d.recipient, value: v, fee });
        Ok(())
    }

    /// Private balance -> routed swap -> a new private note (or a public recipient). EVM: privateSwap.
    /// Remaining accounts, per hop in route order: bin pool, mint_x, mint_y, vault_x, vault_y, token_program_x,
    /// token_program_y, the entry's token account for the hop's output, then `n_arrays` bin arrays.
    pub fn private_swap<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateSwap<'info>>, d: SwapData) -> Result<()> {
        require!(Clock::get()?.unix_timestamp <= d.deadline, EntryError::Expired);
        require_keys_eq!(ctx.accounts.fee_token.owner, d.fee_recipient, EntryError::WrongRecipient);
        require_keys_eq!(ctx.accounts.mint_out.key(), d.token_out, EntryError::UnknownToken);
        let bump = ctx.accounts.entry.signer_bump;
        let data = encode(SWAP, &d)?;
        let v = withdraw_cpi(&ctx.accounts.veyl_pool, &ctx.accounts.signer, &ctx.accounts.pool_in, &ctx.accounts.mint_in, &ctx.accounts.vault_in, &ctx.accounts.spend, &ctx.accounts.entry_vault_in, &ctx.accounts.token_program_in, bump, data)?;
        let fee = fee_of(v, d.fee_bps)?;
        if fee > 0 { pay(&ctx.accounts.token_program_in, &ctx.accounts.entry_vault_in, &ctx.accounts.mint_in, &ctx.accounts.fee_token, &ctx.accounts.signer, bump, fee)?; }
        let mut total = 0u64; for r in &d.routes { total = total.checked_add(r.amount_in).ok_or(EntryError::AmountMismatch)?; }
        require!(total == v - fee, EntryError::AmountMismatch);
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]];
        let out = run_routes(&ctx.accounts.veyl_bin, ctx.accounts.signer.to_account_info(), Some(&s), &ctx.accounts.mint_in.key(), &d.token_out, &d.routes, &ctx.accounts.entry_vault_in, &ctx.accounts.entry_vault_out, ctx.remaining_accounts)?;
        require!(out >= d.min_out, EntryError::Slippage);
        payout(&ctx.accounts.token_program_out, &ctx.accounts.entry_vault_out, &ctx.accounts.mint_out, &ctx.accounts.signer, bump, out, d.recipient.as_ref(), &ctx.accounts.payout_token,
            &ctx.accounts.veyl_pool, ctx.accounts.pool_out.to_account_info(), ctx.accounts.vault_out.to_account_info(), &ctx.accounts.deposit_record, &ctx.accounts.relayer, &ctx.accounts.system_program, d.out_precommitment, d.refund_to)?;
        emit!(PrivateSwapped { token_in: ctx.accounts.mint_in.key(), token_out: d.token_out, amount_in: total, amount_out: out, fee });
        Ok(())
    }

    /// Private balance -> a bin-pool position owned by a one-time key. One leg per token being added (1 or 2).
    /// Remaining accounts: `legs` x [private pool, pool vault, posted spend], then the bin arrays and the
    /// (owner, entry signer) share accounts for every chunk touched. EVM: privateAdd(legs).
    pub fn private_add<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateAdd<'info>>, d: AddData, legs: u8) -> Result<()> {
        require!(Clock::get()?.unix_timestamp <= d.deadline, EntryError::Expired);
        require!(legs == 1 || legs == 2, EntryError::BadLegs);
        require_keys_eq!(ctx.accounts.bin_pool.key(), d.bin_pool, EntryError::UnknownPool);
        require_keys_eq!(ctx.accounts.fee_token_x.owner, d.fee_recipient, EntryError::WrongRecipient);
        require_keys_eq!(ctx.accounts.fee_token_y.owner, d.fee_recipient, EntryError::WrongRecipient);
        let n = d.ids.len();
        require!(n > 0 && d.amounts_x.len() == n && d.amounts_y.len() == n, EntryError::BadLegs);
        // a private add always carries per-bin minimum shares (REVIEW.md M-5): it is executed after its proof is public, so
        // without a bound the active bin can be moved first and the composition fee (up to 10%) taken from the position
        require!(d.min_shares.len() == n, EntryError::MinSharesRequired);
        let bump = ctx.accounts.entry.signer_bump;
        let data = encode(ADD, &d)?;
        let rem = ctx.remaining_accounts;
        require!(rem.len() >= 3 * legs as usize, EntryError::BadLegs);
        let (mut net_x, mut net_y, mut got_x, mut got_y) = (0u64, 0u64, false, false);
        for l in 0..legs as usize {
            let pool = &rem[3 * l]; let vault = &rem[3 * l + 1]; let spend = &rem[3 * l + 2];
            let pool_acc: AccountLoader<'info, veyl_pool::Pool> = AccountLoader::try_from(pool)?;
            let mint_key = pool_acc.load()?.mint;
            let (mint, entry_vault, tp, fee_token, is_x) = if mint_key == ctx.accounts.mint_x.key() { (&ctx.accounts.mint_x, &ctx.accounts.entry_vault_x, &ctx.accounts.token_program_x, &ctx.accounts.fee_token_x, true) }
                else if mint_key == ctx.accounts.mint_y.key() { (&ctx.accounts.mint_y, &ctx.accounts.entry_vault_y, &ctx.accounts.token_program_y, &ctx.accounts.fee_token_y, false) }
                else { return err!(EntryError::BadLegs); };
            require!(if is_x { !got_x } else { !got_y }, EntryError::BadLegs);
            let v = withdraw_cpi_raw(&ctx.accounts.veyl_pool, &ctx.accounts.signer, pool, mint.to_account_info(), vault.clone(), spend.clone(), entry_vault.to_account_info(), tp.to_account_info(), bump, data.clone())?;
            let fee = fee_of(v, d.fee_bps)?;
            if fee > 0 { pay(tp, entry_vault, mint, fee_token, &ctx.accounts.signer, bump, fee)?; }
            if is_x { net_x = v - fee; got_x = true; } else { net_y = v - fee; got_y = true; }
        }
        let (mut sum_x, mut sum_y) = (0u64, 0u64);
        for i in 0..n { sum_x = sum_x.checked_add(d.amounts_x[i]).ok_or(EntryError::AmountMismatch)?; sum_y = sum_y.checked_add(d.amounts_y[i]).ok_or(EntryError::AmountMismatch)?; }
        require!(sum_x == net_x && sum_y == net_y, EntryError::AmountMismatch);
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(ctx.accounts.veyl_bin.to_account_info(), veyl_bin::cpi::accounts::MintLiquidity {
            from: ctx.accounts.signer.to_account_info(), pool: ctx.accounts.bin_pool.to_account_info(),
            mint_x: ctx.accounts.mint_x.to_account_info(), mint_y: ctx.accounts.mint_y.to_account_info(),
            vault_x: ctx.accounts.bin_vault_x.to_account_info(), vault_y: ctx.accounts.bin_vault_y.to_account_info(),
            from_x: ctx.accounts.entry_vault_x.to_account_info(), from_y: ctx.accounts.entry_vault_y.to_account_info(),
            token_program_x: ctx.accounts.token_program_x.to_account_info(), token_program_y: ctx.accounts.token_program_y.to_account_info() }, &sg)
            .with_remaining_accounts(rem[3 * legs as usize..].to_vec());
        let minted = veyl_bin::cpi::mint(cpi, d.owner, ctx.accounts.signer.key(), d.ids.clone(), d.amounts_x.clone(), d.amounts_y.clone(), d.min_shares.clone(), d.deadline)?.get();
        emit!(PrivateAdded { owner: d.owner, bin_pool: d.bin_pool, ids: d.ids, shares: minted });
        Ok(())
    }

    /// Burn some or all of a private position (its reserves; earned fees stay claimable with `private_claim_fees`).
    /// The instruction right before this one must be an ed25519 verification of `remove_digest(d)` by `d.owner`.
    /// Remaining accounts: the bin arrays (with the active bin's) and the (owner, entry signer) share accounts.
    /// EVM: privateRemove(d, sig).
    pub fn private_remove<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateRemove<'info>>, d: RemoveData) -> Result<()> {
        require!(d.ids.len() == d.shares.len() && !d.ids.is_empty(), EntryError::BadLegs);
        check_signed(&mut *ctx.accounts, d.owner, d.bin_pool, d.fee_recipient, d.fee_bps, d.deadline, d.nonce, &signed_digest(TAG_REMOVE, &d)?)?;
        let bump = ctx.accounts.entry.signer_bump;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(ctx.accounts.veyl_bin.to_account_info(), burn_accs(&ctx.accounts), &sg).with_remaining_accounts(ctx.remaining_accounts.to_vec());
        let (ax, ay) = veyl_bin::cpi::burn(cpi, d.owner, d.ids.clone(), d.shares.clone())?.get();
        payout_pair(&ctx.accounts, bump, ax, ay, fee_of(ax, d.fee_bps)?, fee_of(ay, d.fee_bps)?, d.recipient.as_ref(), d.precommit_x, d.precommit_y, d.owner)?;
        emit!(PrivateRemoved { owner: d.owner, bin_pool: d.bin_pool, amount_x: ax, amount_y: ay });
        Ok(())
    }

    /// Claim the swap fees a private position earned, into new notes (or to `recipient`), minus the relayer's capped fee.
    /// Signed by the one-time key (ed25519 instruction right before). Remaining accounts as in `private_remove`.
    pub fn private_claim_fees<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateRemove<'info>>, d: ClaimData) -> Result<()> {
        check_signed(&mut *ctx.accounts, d.owner, d.bin_pool, d.fee_recipient, d.fee_bps, d.deadline, d.nonce, &signed_digest(TAG_CLAIM, &d)?)?;
        let bump = ctx.accounts.entry.signer_bump;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(ctx.accounts.veyl_bin.to_account_info(), burn_accs(&ctx.accounts), &sg).with_remaining_accounts(ctx.remaining_accounts.to_vec());
        let (fx, fy) = veyl_bin::cpi::claim_fees(cpi, d.owner, d.ids.clone())?.get();
        payout_pair(&ctx.accounts, bump, fx, fy, fee_of(fx, d.fee_bps)?, fee_of(fy, d.fee_bps)?, d.recipient.as_ref(), d.precommit_x, d.precommit_y, d.owner)?;
        emit!(PrivateFeesClaimed { owner: d.owner, bin_pool: d.bin_pool, amount_x: fx, amount_y: fy });
        Ok(())
    }

    /// Withdraw (cancel, or collect once filled) a private limit order into new notes (or to `recipient`). Signed by the
    /// one-time key. Remaining accounts: the order bin's array and the (owner, entry signer) share account.
    pub fn private_withdraw_order<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateRemove<'info>>, d: OrderWithdrawData) -> Result<()> {
        check_signed(&mut *ctx.accounts, d.owner, d.bin_pool, d.fee_recipient, d.fee_bps, d.deadline, d.nonce, &signed_digest(TAG_ORDER, &d)?)?;
        let bump = ctx.accounts.entry.signer_bump;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(ctx.accounts.veyl_bin.to_account_info(), burn_accs(&ctx.accounts), &sg).with_remaining_accounts(ctx.remaining_accounts.to_vec());
        let (ax, ay) = veyl_bin::cpi::withdraw_limit_order(cpi, d.owner, d.id, d.is_ask, d.shares)?.get();
        payout_pair(&ctx.accounts, bump, ax, ay, fee_of(ax, d.fee_bps)?, fee_of(ay, d.fee_bps)?, d.recipient.as_ref(), d.precommit_x, d.precommit_y, d.owner)?;
        emit!(PrivateOrderWithdrawn { owner: d.owner, bin_pool: d.bin_pool, id: d.id, is_ask: d.is_ask, amount_x: ax, amount_y: ay });
        Ok(())
    }

    /// Move a private position to a new range / shape in one instruction (veyl_bin `rebalance_position`, authority = the
    /// entry's signer). The relayer's capped fee is withheld from the burned amounts; everything else is re-added, except a
    /// side given no weights, which goes to new notes (or `recipient`). Every new bin needs a minimum share count.
    pub fn private_rebalance<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateRemove<'info>>, d: RebalanceData) -> Result<()> {
        require!(d.min_shares.len() == d.ids.len(), EntryError::MinSharesRequired);
        check_signed(&mut *ctx.accounts, d.owner, d.bin_pool, d.fee_recipient, d.fee_bps, d.deadline, d.nonce, &signed_digest(TAG_REBALANCE, &d)?)?;
        let bump = ctx.accounts.entry.signer_bump;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(ctx.accounts.veyl_bin.to_account_info(), burn_accs(&ctx.accounts), &sg).with_remaining_accounts(ctx.remaining_accounts.to_vec());
        let r = veyl_bin::cpi::rebalance_position(cpi, d.owner, d.burn_ids.clone(), d.burn_shares.clone(), d.ids.clone(), d.weights_x.clone(), d.weights_y.clone(), d.min_shares.clone(), d.fee_bps, d.deadline)?.get();
        // the bin program paid (withheld + any side without weights) to the entry's vaults: the withheld part is the fee
        let (lx, ly) = (r.burned_x - r.withheld_x - r.readded_x, r.burned_y - r.withheld_y - r.readded_y);
        payout_pair(&ctx.accounts, bump, lx + r.withheld_x, ly + r.withheld_y, r.withheld_x, r.withheld_y, d.recipient.as_ref(), d.precommit_x, d.precommit_y, d.owner)?;
        emit!(PrivateRebalanced { owner: d.owner, bin_pool: d.bin_pool, burned_x: r.burned_x, burned_y: r.burned_y, readded_x: r.readded_x, readded_y: r.readded_y, fee_x: r.withheld_x, fee_y: r.withheld_y });
        Ok(())
    }

    /// Claim farm reward `d.index` a private position earned, into a new note of the reward mint (when it has a private
    /// pool) or to `recipient`. Signed by the one-time key.
    pub fn private_claim_reward<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateClaimReward<'info>>, d: RewardClaimData) -> Result<()> {
        let a = &mut *ctx.accounts;
        require!(Clock::get()?.unix_timestamp <= d.deadline, EntryError::Expired);
        require_keys_eq!(a.bin_pool.key(), d.bin_pool, EntryError::UnknownPool);
        require_keys_eq!(a.fee_token.owner, d.fee_recipient, EntryError::WrongRecipient);
        fee_of(0, d.fee_bps)?;
        check_ed25519(&a.instructions, &d.owner, &signed_digest(TAG_REWARD, &d)?)?;
        bump_nonce(&mut a.nonce, d.owner, d.nonce)?;
        let bump = ctx.accounts.entry.signer_bump;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let a = &ctx.accounts;
        let cpi = CpiContext::new_with_signer(a.veyl_bin.to_account_info(), veyl_bin::cpi::accounts::ClaimReward {
            authority: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(), reward_mint: a.reward_mint.to_account_info(),
            reward_vault: a.reward_vault.to_account_info(), to: a.entry_vault.to_account_info(), token_program: a.token_program.to_account_info() }, &sg)
            .with_remaining_accounts(ctx.remaining_accounts.to_vec());
        let amt = veyl_bin::cpi::claim_reward(cpi, d.owner, d.index, d.ids.clone())?.get();
        if amt > 0 {
            let fee = fee_of(amt, d.fee_bps)?;
            if fee > 0 { pay(&a.token_program, &a.entry_vault, &a.reward_mint, &a.fee_token, &a.signer, bump, fee)?; }
            payout(&a.token_program, &a.entry_vault, &a.reward_mint, &a.signer, bump, amt - fee, d.recipient.as_ref(), &a.payout_token, &a.veyl_pool, a.pool.to_account_info(), a.pool_vault.to_account_info(), &a.deposit_record, &a.relayer, &a.system_program, d.precommit, d.owner)?;
        }
        emit!(PrivateRewardClaimed { owner: d.owner, bin_pool: d.bin_pool, index: d.index, amount: amt });
        Ok(())
    }

    /// Private balance -> a limit order owned by a one-time key: one leg (X for an ask, Y for a bid), its value minus the
    /// relayer fee placed at `d.id`. Remaining accounts: [private pool, pool vault, posted spend], then the order bin's array
    /// and the (owner, entry signer) share account.
    pub fn private_place_order<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateAdd<'info>>, d: OrderData) -> Result<()> {
        add_checks(&ctx.accounts, d.bin_pool, d.fee_recipient, d.deadline)?;
        let rem = ctx.remaining_accounts; require!(rem.len() >= 3, EntryError::BadLegs);
        let bump = ctx.accounts.entry.signer_bump;
        let amount = spend_leg(&ctx.accounts, &rem[..3], d.is_ask, encode(ORDER, &d)?, d.fee_bps, bump)?;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(ctx.accounts.veyl_bin.to_account_info(), mint_accs(&ctx.accounts), &sg).with_remaining_accounts(rem[3..].to_vec());
        let shares = veyl_bin::cpi::place_limit_order(cpi, d.owner, ctx.accounts.signer.key(), d.id, d.is_ask, amount, d.deadline)?.get();
        emit!(PrivateOrderPlaced { owner: d.owner, bin_pool: d.bin_pool, id: d.id, is_ask: d.is_ask, amount, shares });
        Ok(())
    }

    /// Private balance (one token) -> zap into a position owned by a one-time key: `swap_amount` swapped through the pool
    /// itself (at least `min_swap_out`), everything added by weights with a minimum per bin. Remaining accounts: [private
    /// pool, pool vault, posted spend], then the bin arrays (swap path, new bins, active bin) and the share accounts.
    pub fn private_zap<'info>(ctx: Context<'_, '_, 'info, 'info, PrivateAdd<'info>>, d: ZapData) -> Result<()> {
        add_checks(&ctx.accounts, d.bin_pool, d.fee_recipient, d.deadline)?;
        require!(d.min_shares.len() == d.ids.len(), EntryError::MinSharesRequired);
        require!(d.swap_amount == 0 || d.min_swap_out > 0, EntryError::Slippage); // a swap executed after its proof is public needs a bound
        let rem = ctx.remaining_accounts; require!(rem.len() >= 3, EntryError::BadLegs);
        let bump = ctx.accounts.entry.signer_bump;
        let amount = spend_leg(&ctx.accounts, &rem[..3], d.x_in, encode(ZAP, &d)?, d.fee_bps, bump)?;
        require!(d.swap_amount <= amount, EntryError::AmountMismatch);
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(ctx.accounts.veyl_bin.to_account_info(), mint_accs(&ctx.accounts), &sg).with_remaining_accounts(rem[3..].to_vec());
        let shares = veyl_bin::cpi::swap_and_add(cpi, d.owner, ctx.accounts.signer.key(), d.x_in, amount, d.swap_amount, d.min_swap_out, d.ids.clone(), d.weights_x.clone(), d.weights_y.clone(), d.min_shares.clone(), d.deadline)?.get();
        emit!(PrivateZapped { owner: d.owner, bin_pool: d.bin_pool, x_in: d.x_in, amount_in: amount, swap_amount: d.swap_amount, ids: d.ids, shares });
        Ok(())
    }

    /// The public router: a swap split across routes, each a chain of bin pools, atomically, with one minimum output.
    /// The user signs and their own token accounts are used at every hop. Remaining accounts as in `private_swap`
    /// (with the user's token account for each hop's output). EVM: VeylRouter.swap.
    pub fn swap_route<'info>(ctx: Context<'_, '_, 'info, 'info, SwapRoute<'info>>, token_in: Pubkey, token_out: Pubkey, routes: Vec<Route>, min_out: u64, deadline: i64) -> Result<u64> {
        require!(Clock::get()?.unix_timestamp <= deadline, EntryError::Expired);
        require!(ctx.accounts.user_in.mint == token_in && ctx.accounts.user_out.mint == token_out, EntryError::UnknownToken);
        let mut total = 0u64; for r in &routes { total = total.checked_add(r.amount_in).ok_or(EntryError::AmountMismatch)?; }
        require!(!routes.is_empty() && total > 0, EntryError::BadRoute);
        let out = run_routes(&ctx.accounts.veyl_bin, ctx.accounts.user.to_account_info(), None, &token_in, &token_out, &routes, &ctx.accounts.user_in, &ctx.accounts.user_out, ctx.remaining_accounts)?;
        require!(out >= min_out, EntryError::Slippage);
        emit!(Routed { sender: ctx.accounts.user.key(), token_in, token_out, amount_in: total, amount_out: out, routes: routes.len() as u8 });
        Ok(out)
    }

    // ============================================================================================ Phase 3: sealed batch swaps
    // (logic in sealed.rs)
    pub fn init_committee(ctx: Context<InitCommittee>) -> Result<()> { sealed::init_committee(ctx) }
    pub fn set_committee(ctx: Context<CommitteeAdmin>, t: u8, n: u8, kind: u8, pk: [u8; 64], members: Vec<[u8; 64]>, nodes: Vec<Pubkey>, transcript: [u8; 32]) -> Result<()> { sealed::set_committee(ctx, t, n, kind, pk, members, nodes, transcript) }
    pub fn propose_committee_authority(ctx: Context<CommitteeAdmin>, next: Pubkey) -> Result<()> { sealed::propose_committee_authority(ctx, next) }
    pub fn accept_committee_authority(ctx: Context<AcceptCommitteeAuthority>) -> Result<()> { sealed::accept_committee_authority(ctx) }
    pub fn init_sealed_pool(ctx: Context<InitSealedPool>, p: SealedParams) -> Result<()> { sealed::init_sealed_pool(ctx, p) }
    pub fn set_sealed_params(ctx: Context<SealedAdmin>, p: SealedParams, paused: bool) -> Result<()> { sealed::set_sealed_params(ctx, p, paused) }
    pub fn submit_swap(ctx: Context<SubmitSwap>, direction: u8, c1: [u8; 64], c2: [u8; 64], ext: SwapExt) -> Result<()> { sealed::submit_swap(ctx, direction, c1, c2, ext) }
    pub fn close_batch(ctx: Context<CloseBatch>) -> Result<()> { sealed::close_batch(ctx) }
    pub fn post_share(ctx: Context<PostShare>, member: u8, da: [u8; 64], db: [u8; 64], a: [u8; 64], ba: [u8; 64], bb: [u8; 64], s: [u8; 32]) -> Result<()> { sealed::post_share(ctx, member, da, db, a, ba, bb, s) }
    pub fn share_step(ctx: Context<ShareStep>) -> Result<()> { sealed::share_step(ctx) }
    pub fn cancel_share(ctx: Context<CancelShare>) -> Result<()> { sealed::cancel_share(ctx) }
    pub fn settle_verify(ctx: Context<SettleVerify>, direction: u8, total: u64) -> Result<()> { sealed::settle_verify(ctx, direction, total) }
    pub fn settle_batch<'info>(ctx: Context<'_, '_, 'info, 'info, SettleBatch<'info>>) -> Result<()> { sealed::settle_batch(ctx) }
    pub fn fail_batch(ctx: Context<FailBatch>) -> Result<()> { sealed::fail_batch(ctx) }
    pub fn claim_swap(ctx: Context<ClaimSwap>, direction: u8, ext: ClaimExt) -> Result<()> { sealed::claim_swap(ctx, direction, ext) }

    // ============================================================================================ Phase 2: shielded actions

    /// Storage for the fee growth per shielded share of 60 bins (anyone may pay for it).
    pub fn init_lp_acc(ctx: Context<InitLpAcc>, chunk: i32) -> Result<()> {
        require!(chunk >= veyl_bin::MIN_CHUNK && chunk < veyl_bin::MIN_CHUNK + veyl_bin::CHUNKS as i32, EntryError::BadLegs);
        let mut a = ctx.accounts.lp_acc.load_init()?; a.pool = ctx.accounts.bin_pool.key(); a.chunk = chunk; Ok(())
    }
    /// A request buffer of `len` bytes, written with `write_buffer` and consumed by one shielded action.
    pub fn open_buffer(ctx: Context<OpenBuffer>, _id: u64, len: u32) -> Result<()> {
        require!(len as usize <= MAX_BUFFER, EntryError::BadRequest);
        let b = &mut ctx.accounts.buffer; b.owner = ctx.accounts.owner.key(); b.data = vec![0u8; len as usize]; Ok(())
    }
    pub fn write_buffer(ctx: Context<WriteBuffer>, _id: u64, offset: u32, bytes: Vec<u8>) -> Result<()> {
        let b = &mut ctx.accounts.buffer; let o = offset as usize;
        require!(o.checked_add(bytes.len()).map_or(false, |e| e <= b.data.len()), EntryError::BadRequest);
        b.data[o..o + bytes.len()].copy_from_slice(&bytes); Ok(())
    }
    /// Give up a buffer that was never used (rent back to its owner).
    pub fn close_buffer(_ctx: Context<CloseBuffer>, _id: u64) -> Result<()> { Ok(()) }

    /// A shielded liquidity action (add, remove, claim fees, in-window rebalance, zap), all in one instruction:
    ///  1. legs: transact proofs bound to this action pay their public amounts into this program's vaults;
    ///  2. the position proof must be for this window, this request, and the bundle of the current fee growth H of the
    ///     window, the deltas, the two token assets and the relayer's claim fee;
    ///  3. a zap swaps part of the funding through the pool;
    ///  4. harvest: the aggregate's fees in the window are collected into the shielded pool's vaults and H rises by
    ///     floor(collected * 2^64 / aggregate shares) per bin (never more than was collected: the fee pot stays solvent);
    ///  5. the proof priced the new position at the old H, so a share added now would also earn what was collected for the
    ///     shares that were there before: an add pays ceil(sum(delta * dH) / 2^64) into the pot (at most `max_charge`) and a
    ///     removal is paid floor(sum(|delta| * dH) / 2^64) out of it, exactly what its shares earned up to now;
    ///  6. burns (negative deltas) and exact mints (positive deltas) on the aggregate;
    ///  7. relayer fees, then whatever is left in the vaults goes back into the shielded pool as receipt notes;
    ///  8. the position note is replaced (nullifier, new note, fee notes, and its ciphertext as PositionCiphertext): done by
    ///     veyl_pool right after the proof check (2b), whose event CPI carries every tree event (logs past ~10 KB are dropped).
    /// Remaining accounts: `n_lp_acc` LpAcc accounts of the window, then 4 per leg [posted proof, its poster, nullifier 0,
    /// nullifier 1], then the bin arrays (window, active bin, swap path) and the aggregate's share accounts.
    pub fn shield_lp<'info>(ctx: Context<'_, '_, 'info, 'info, ShieldLp<'info>>, n_lp_acc: u8) -> Result<()> {
        // (split into steps that each run in their own stack frame: SBF frames are 4 KB)
        let req = Box::new(LpRequest::try_from_slice(&ctx.accounts.buffer.data).map_err(|_| error!(EntryError::BadRequest))?);
        lp_checks(&ctx.accounts, &req)?;
        let bump = ctx.accounts.entry.signer_bump;
        let action = lp_action(&req.core)?; let ext_hash = lp_ext_hash(&req.core)?;
        let rem = ctx.remaining_accounts; let nl = n_lp_acc as usize; let nlegs = req.legs.len();
        require!(nl >= 1 && nl <= 2 && rem.len() >= nl + 4 * nlegs, EntryError::BadLegs);
        let lp_infos = &rem[..nl]; let leg_infos = &rem[nl..nl + 4 * nlegs]; let bin_infos = &rem[nl + 4 * nlegs..];
        let start = (ctx.accounts.entry_vault_x.amount, ctx.accounts.entry_vault_y.amount);
        // 1. funding legs
        lp_legs(&ctx.accounts, &req, leg_infos, &action, bump)?;
        // 2. the position proof: window, request, bundle of the current H
        let pubs = lp_check_proof(&ctx.accounts, &req.core, lp_infos, &ext_hash)?;
        // 2b. the position note: nullifier, new note, fee notes, its payload (consumed before the bin CPIs, so that the log
        //     copies of its events come early too: readers of the logs need every leaf; any later failure reverts it all)
        lp_consume(&ctx.accounts, &ext_hash, &req.core.ciphertext, bump)?;
        // 3. zap: part of the funding swapped through this pool (its fees reach the bins before the harvest)
        if req.core.zap.is_some() { lp_zap(&ctx.accounts, &req.core, bin_infos, bump)?; }
        // 4. harvest: collect the aggregate's fees in the window into the shielded pool, raise H by floor(c * 2^64 / S)
        let (supply, dh, got) = lp_harvest(&ctx.accounts, &req.core, lp_infos, bin_infos, bump)?;
        // 5. what the new shares would otherwise earn from fees collected before they existed (or the old ones would lose)
        let (mut charge, pay) = lp_adjust(&req.core, &dh)?;
        // 6. burns then exact mints on the aggregate
        lp_burn_mint(&mut *ctx.accounts, &req.core, bin_infos, &supply, start, bump)?;
        // 6b. a charge in a token this action does not hold (a one-sided add) is not taken: its new shares are counted in that
        //     harvest's divisor instead (H lowered to floor(c * 2^64 / (S + delta))). Solvent; the existing holders share
        //     those fees with the new shares (bounded by the fees collected since the bins' last harvest).
        let diluted = lp_settle(&mut *ctx.accounts, &req.core, lp_infos, &supply, &dh, &got, start, &mut charge, &pay)?;
        // 7. the pot (charge an add, pay a removal), relayer fees, then leftovers back as receipt notes
        lp_pot(&ctx.accounts, &req.core, charge, pay, bump)?;
        let left = receipts(&mut *ctx.accounts, start.0, start.1, req.core.receipt_owner, req.core.receipt_blinding, bump)?;
        emit!(ShieldLpExecuted { bin_pool: req.core.bin_pool, lo: req.core.lo, deltas: req.core.deltas.clone(), legs: nlegs as u8, charge, pay, claim_fee: req.core.claim_fee, leftover_fee: req.core.leftover_fee, receipts: left, nullifier: pubs[1], diluted });
        Ok(())
    }

    /// Shielded balance -> routed swap -> a receipt note of the output token (amount public, owner a one-time key).
    /// Request in the buffer: SwapRequest. Remaining accounts: the route's (as in private_swap).
    pub fn shield_swap<'info>(ctx: Context<'_, '_, 'info, 'info, ShieldSwap<'info>>) -> Result<()> {
        let req = SwapRequest::try_from_slice(&ctx.accounts.buffer.data).map_err(|_| error!(EntryError::BadRequest))?;
        let c = &req.core;
        require!(Clock::get()?.unix_timestamp <= c.deadline, EntryError::Expired);
        require!(req.leg.action == swap_action(c)?, EntryError::BadContext);
        require_keys_eq!(req.leg.mint, ctx.accounts.mint_in.key(), EntryError::UnknownToken);
        require_keys_eq!(ctx.accounts.mint_out.key(), c.token_out, EntryError::UnknownToken);
        let bump = ctx.accounts.entry.signer_bump;
        let a = &ctx.accounts;
        let legs = [a.posted.to_account_info(), a.poster.to_account_info(), a.nullifier0.to_account_info(), a.nullifier1.to_account_info()];
        let v = leg_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.relayer, &a.shield, &legs, Some((a.mint_in.to_account_info(), a.shield_vault_in.to_account_info(), a.entry_vault_in.to_account_info(), a.fee_token.to_account_info(), a.token_program_in.to_account_info())), &a.system_program, bump, req.leg.clone(), None)?;
        let mut total = 0u64; for r in &c.routes { total = total.checked_add(r.amount_in).ok_or(EntryError::AmountMismatch)?; }
        require!(!c.routes.is_empty() && total == v, EntryError::AmountMismatch);
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]];
        let out = run_routes(&a.veyl_bin, a.signer.to_account_info(), Some(&s), &a.mint_in.key(), &c.token_out, &c.routes, &a.entry_vault_in, &a.entry_vault_out, ctx.remaining_accounts)?;
        require!(out >= c.min_out, EntryError::Slippage);
        receipt_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.shield, Some((a.mint_out.to_account_info(), a.shield_vault_out.to_account_info(), a.entry_vault_out.to_account_info(), a.token_program_out.to_account_info())), bump, None, out, c.receipt_owner, c.receipt_blinding)?;
        emit!(ShieldSwapped { token_in: a.mint_in.key(), token_out: c.token_out, amount_in: v, amount_out: out, fee: req.leg.fee });
        Ok(())
    }

    /// Shielded balance -> a limit order held by the shielded aggregate; the order's shares come back as a receipt note of
    /// the order's virtual asset (bin pool, bin, side). Remaining accounts: the order bin's array and the aggregate's share
    /// account of that chunk.
    pub fn shield_order<'info>(ctx: Context<'_, '_, 'info, 'info, ShieldOrder<'info>>) -> Result<()> {
        let req = OrderRequest::try_from_slice(&ctx.accounts.buffer.data).map_err(|_| error!(EntryError::BadRequest))?;
        let c = &req.core;
        require!(Clock::get()?.unix_timestamp <= c.deadline, EntryError::Expired);
        require_keys_eq!(ctx.accounts.bin_pool.key(), c.bin_pool, EntryError::UnknownPool);
        require!(req.leg.action == order_action(c)?, EntryError::BadContext);
        let bump = ctx.accounts.entry.signer_bump;
        let a = &ctx.accounts;
        let (mint, ev, tp) = if c.is_ask { (&a.mint_x, &a.entry_vault_x, &a.token_program_x) } else { (&a.mint_y, &a.entry_vault_y, &a.token_program_y) };
        require_keys_eq!(req.leg.mint, mint.key(), EntryError::BadLegs);
        let legs = [a.posted.to_account_info(), a.poster.to_account_info(), a.nullifier0.to_account_info(), a.nullifier1.to_account_info()];
        let amount = leg_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.relayer, &a.shield, &legs, Some((mint.to_account_info(), a.shield_vault.to_account_info(), ev.to_account_info(), a.fee_token.to_account_info(), tp.to_account_info())), &a.system_program, bump, req.leg.clone(), None)?;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let accs = veyl_bin::cpi::accounts::MintLiquidity { from: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(), mint_x: a.mint_x.to_account_info(), mint_y: a.mint_y.to_account_info(), vault_x: a.bin_vault_x.to_account_info(), vault_y: a.bin_vault_y.to_account_info(), from_x: a.entry_vault_x.to_account_info(), from_y: a.entry_vault_y.to_account_info(), token_program_x: a.token_program_x.to_account_info(), token_program_y: a.token_program_y.to_account_info() };
        let shares = veyl_bin::cpi::place_limit_order(CpiContext::new_with_signer(a.veyl_bin.to_account_info(), accs, &sg).with_remaining_accounts(ctx.remaining_accounts.to_vec()), shield_owner(), a.signer.key(), c.id, c.is_ask, amount, c.deadline)?.get();
        require!(shares <= i64::MAX as u128, EntryError::AmountMismatch); // a note amount is 64 bits; ext_amount is an i64
        receipt_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.shield, None, bump, Some(veyl_pool::order_asset_of(&c.bin_pool, c.id, c.is_ask)), shares as u64, c.receipt_owner, c.receipt_blinding)?;
        emit!(ShieldOrderPlaced { bin_pool: c.bin_pool, id: c.id, is_ask: c.is_ask, amount, shares });
        Ok(())
    }

    /// Order-share notes -> withdraw that many shares of the aggregate's order (unfilled and filled parts) -> receipt notes.
    pub fn shield_order_withdraw<'info>(ctx: Context<'_, '_, 'info, 'info, ShieldOrderWithdraw<'info>>) -> Result<()> {
        let req = OrderWithdrawRequest::try_from_slice(&ctx.accounts.buffer.data).map_err(|_| error!(EntryError::BadRequest))?;
        let c = &req.core;
        require!(Clock::get()?.unix_timestamp <= c.deadline, EntryError::Expired);
        require_keys_eq!(ctx.accounts.bin_pool.key(), c.bin_pool, EntryError::UnknownPool);
        require!(req.leg.action == order_withdraw_action(c)?, EntryError::BadContext);
        require_keys_eq!(ctx.accounts.fee_token_x.owner, c.relayer, EntryError::WrongRecipient);
        require_keys_eq!(ctx.accounts.fee_token_y.owner, c.relayer, EntryError::WrongRecipient);
        let bump = ctx.accounts.entry.signer_bump;
        let (start_x, start_y) = (ctx.accounts.entry_vault_x.amount, ctx.accounts.entry_vault_y.amount);
        {
            let a = &ctx.accounts;
            let legs = [a.posted.to_account_info(), a.poster.to_account_info(), a.nullifier0.to_account_info(), a.nullifier1.to_account_info()];
            let shares = leg_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.relayer, &a.shield, &legs, None, &a.system_program, bump, req.leg.clone(), Some(veyl_pool::order_asset_of(&c.bin_pool, c.id, c.is_ask)))?;
            require!(shares > 0, EntryError::AmountMismatch);
            let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
            let cpi = CpiContext::new_with_signer(a.veyl_bin.to_account_info(), bin_out_accs_w(a.signer.to_account_info(), a.bin_pool.to_account_info(), &a.mint_x, &a.mint_y, &a.bin_vault_x, &a.bin_vault_y, a.entry_vault_x.to_account_info(), a.entry_vault_y.to_account_info(), &a.token_program_x, &a.token_program_y), &sg).with_remaining_accounts(ctx.remaining_accounts.to_vec());
            veyl_bin::cpi::withdraw_limit_order(cpi, shield_owner(), c.id, c.is_ask, shares as u128)?;
            for t in 0..2 { if c.leftover_fee[t] > 0 { let (mint, ev, ft, tp) = if t == 0 { (&a.mint_x, &a.entry_vault_x, &a.fee_token_x, &a.token_program_x) } else { (&a.mint_y, &a.entry_vault_y, &a.fee_token_y, &a.token_program_y) }; pay_tok(tp, ev, mint, ft, &a.signer, bump, c.leftover_fee[t])?; } }
        }
        let a = &mut *ctx.accounts;
        a.entry_vault_x.reload()?; a.entry_vault_y.reload()?;
        let (lx, ly) = (a.entry_vault_x.amount.saturating_sub(start_x), a.entry_vault_y.amount.saturating_sub(start_y));
        if lx > 0 { receipt_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.shield, Some((a.mint_x.to_account_info(), a.shield_vault_x.to_account_info(), a.entry_vault_x.to_account_info(), a.token_program_x.to_account_info())), bump, None, lx, c.receipt_owner[0], c.receipt_blinding[0])?; }
        if ly > 0 { receipt_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.shield, Some((a.mint_y.to_account_info(), a.shield_vault_y.to_account_info(), a.entry_vault_y.to_account_info(), a.token_program_y.to_account_info())), bump, None, ly, c.receipt_owner[1], c.receipt_blinding[1])?; }
        emit!(ShieldOrderWithdrawn { bin_pool: c.bin_pool, id: c.id, is_ask: c.is_ask, amount_x: lx, amount_y: ly });
        Ok(())
    }

    /// A legacy note (withdraw circuit, approved set) -> one receipt note in the shielded pool, minus the relayer's capped
    /// fee. The legacy proof's context binds the new note's one-time owner and blinding.
    pub fn shield_migrate(ctx: Context<ShieldMigrate>, d: MigrateData) -> Result<()> {
        require!(Clock::get()?.unix_timestamp <= d.deadline, EntryError::Expired);
        require_keys_eq!(ctx.accounts.fee_token.owner, d.fee_recipient, EntryError::WrongRecipient);
        let bump = ctx.accounts.entry.signer_bump;
        let a = &ctx.accounts;
        let v = withdraw_cpi(&a.veyl_pool, &a.signer, &a.pool, &a.mint, &a.vault, &a.spend, &a.entry_vault, &a.token_program, bump, encode(MIGRATE, &d)?)?;
        let fee = fee_of(v, d.fee_bps)?;
        if fee > 0 { pay(&a.token_program, &a.entry_vault, &a.mint, &a.fee_token, &a.signer, bump, fee)?; }
        receipt_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.shield, Some((a.mint.to_account_info(), a.shield_vault.to_account_info(), a.entry_vault.to_account_info(), a.token_program.to_account_info())), bump, None, v - fee, d.owner, d.blinding)?;
        emit!(Migrated { mint: a.mint.key(), amount: v - fee, fee });
        Ok(())
    }

    /// Farm rewards earned by the shielded aggregate cannot be split among its holders (shielded positions do not earn
    /// farm rewards in Phase 2); anyone may send them back to the farm's funder, so they are not stuck.
    pub fn shield_return_rewards<'info>(ctx: Context<'_, '_, 'info, 'info, ShieldReturnRewards<'info>>, index: u8, ids: Vec<i32>) -> Result<()> {
        let funder = { let p = ctx.accounts.bin_pool.load()?; p.rewards.get(index as usize).map(|r| r.funder).ok_or(EntryError::BadLegs)? };
        require_keys_eq!(ctx.accounts.to.owner, funder, EntryError::WrongRecipient);
        let bump = ctx.accounts.entry.signer_bump;
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let a = &ctx.accounts;
        let cpi = CpiContext::new_with_signer(a.veyl_bin.to_account_info(), veyl_bin::cpi::accounts::ClaimReward { authority: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(), reward_mint: a.reward_mint.to_account_info(), reward_vault: a.reward_vault.to_account_info(), to: a.to.to_account_info(), token_program: a.token_program.to_account_info() }, &sg)
            .with_remaining_accounts(ctx.remaining_accounts.to_vec());
        let amt = veyl_bin::cpi::claim_reward(cpi, shield_owner(), index, ids)?.get();
        emit!(ShieldRewardsReturned { bin_pool: a.bin_pool.key(), index, amount: amt });
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------------ internals

fn withdraw_cpi<'info>(prog: &Program<'info, VeylPool>, signer: &UncheckedAccount<'info>, pool: &AccountLoader<'info, veyl_pool::Pool>, mint: &InterfaceAccount<'info, Mint>, vault: &InterfaceAccount<'info, TokenAccount>, spend: &Account<'info, veyl_pool::Spend>, entry_vault: &InterfaceAccount<'info, TokenAccount>, tp: &Interface<'info, TokenInterface>, bump: u8, data: Vec<u8>) -> Result<u64> {
    withdraw_cpi_raw(prog, signer, &pool.to_account_info(), mint.to_account_info(), vault.to_account_info(), spend.to_account_info(), entry_vault.to_account_info(), tp.to_account_info(), bump, data)
}
fn withdraw_cpi_raw<'info>(prog: &Program<'info, VeylPool>, signer: &UncheckedAccount<'info>, pool: &AccountInfo<'info>, mint: AccountInfo<'info>, vault: AccountInfo<'info>, spend: AccountInfo<'info>, entry_vault: AccountInfo<'info>, tp: AccountInfo<'info>, bump: u8, data: Vec<u8>) -> Result<u64> {
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let cpi = CpiContext::new_with_signer(prog.to_account_info(), veyl_pool::cpi::accounts::Withdraw {
        processor: signer.to_account_info(), pool: pool.clone(), mint, vault, spend, processor_token: entry_vault, token_program: tp }, &sg);
    Ok(veyl_pool::cpi::withdraw(cpi, data)?.get())
}
fn pay<'info>(tp: &Interface<'info, TokenInterface>, from: &InterfaceAccount<'info, TokenAccount>, mint: &InterfaceAccount<'info, Mint>, to: &InterfaceAccount<'info, TokenAccount>, signer: &UncheckedAccount<'info>, bump: u8, amount: u64) -> Result<()> {
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    token_interface::transfer_checked(CpiContext::new_with_signer(tp.to_account_info(), TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: signer.to_account_info() }, &sg), amount, mint.decimals)
}
/// `_payout`: to a public recipient's token account, or back into the private balance as a new note for `refund_to`.
/// `pool` must be veyl_pool's pool for `mint` (checked here by owner, discriminator and mint; the deposit CPI checks its seeds).
fn payout<'info>(tp: &Interface<'info, TokenInterface>, ev: &InterfaceAccount<'info, TokenAccount>, mint: &InterfaceAccount<'info, Mint>, signer: &UncheckedAccount<'info>, bump: u8, amt: u64, recipient: Option<&Pubkey>, payout_token: &InterfaceAccount<'info, TokenAccount>,
    pool_prog: &Program<'info, VeylPool>, pool: AccountInfo<'info>, vault: AccountInfo<'info>, record: &UncheckedAccount<'info>, rent_payer: &Signer<'info>, system: &Program<'info, System>, precommit: [u8; 32], refund_to: Pubkey) -> Result<()> {
    if amt == 0 { return Ok(()); }
    if let Some(r) = recipient {
        require!(payout_token.owner == *r && payout_token.mint == mint.key(), EntryError::WrongRecipient);
        return pay(tp, ev, mint, payout_token, signer, bump, amt);
    }
    {
        require_keys_eq!(*pool.owner, veyl_pool::ID, EntryError::UnknownToken);
        let data = pool.try_borrow_data()?;
        require!(data.len() >= 136 && data[..8] == *veyl_pool::Pool::DISCRIMINATOR && data[104..136] == mint.key().to_bytes(), EntryError::UnknownToken);
    }
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let cpi = CpiContext::new_with_signer(pool_prog.to_account_info(), veyl_pool::cpi::accounts::Deposit {
        payer: signer.to_account_info(), rent_payer: rent_payer.to_account_info(), pool, mint: mint.to_account_info(), vault,
        payer_token: ev.to_account_info(), deposit_record: record.to_account_info(), token_program: tp.to_account_info(), system_program: system.to_account_info() }, &sg);
    veyl_pool::cpi::deposit(cpi, amt, precommit, refund_to)
}
/// Both sides of a position action: the relayer's fee (computed by the caller, capped) then the rest to notes / recipient.
fn payout_pair<'info>(a: &PrivateRemove<'info>, bump: u8, ax: u64, ay: u64, fee_x: u64, fee_y: u64, recipient: Option<&Pubkey>, pre_x: [u8; 32], pre_y: [u8; 32], refund_to: Pubkey) -> Result<()> {
    for (amt, fee, tp, ev, mint, ft, pool, vault, rec, pt, pre) in [
        (ax, fee_x, &a.token_program_x, &a.entry_vault_x, &a.mint_x, &a.fee_token_x, a.pool_x.to_account_info(), a.pool_vault_x.to_account_info(), &a.deposit_record_x, &a.payout_x, pre_x),
        (ay, fee_y, &a.token_program_y, &a.entry_vault_y, &a.mint_y, &a.fee_token_y, a.pool_y.to_account_info(), a.pool_vault_y.to_account_info(), &a.deposit_record_y, &a.payout_y, pre_y),
    ] {
        if amt == 0 { continue; }
        if fee > 0 { pay(tp, ev, mint, ft, &a.signer, bump, fee)?; }
        payout(tp, ev, mint, &a.signer, bump, amt - fee, recipient, pt, &a.veyl_pool, pool, vault, rec, &a.relayer, &a.system_program, pre, refund_to)?;
    }
    Ok(())
}
/// Every action signed by a position's one-time key: deadline, pool, fee recipient, fee cap, the ed25519 signature over
/// `digest` in the previous instruction, and the owner's nonce (replay).
fn check_signed(a: &mut PrivateRemove, owner: Pubkey, bin_pool: Pubkey, fee_recipient: Pubkey, fee_bps: u16, deadline: i64, nonce: u64, digest: &[u8; 32]) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= deadline, EntryError::Expired);
    require_keys_eq!(a.bin_pool.key(), bin_pool, EntryError::UnknownPool);
    require_keys_eq!(a.fee_token_x.owner, fee_recipient, EntryError::WrongRecipient);
    require_keys_eq!(a.fee_token_y.owner, fee_recipient, EntryError::WrongRecipient);
    fee_of(0, fee_bps)?;
    check_ed25519(&a.instructions, &owner, digest)?;
    bump_nonce(&mut a.nonce, owner, nonce)
}
fn bump_nonce(n: &mut Account<Nonce>, owner: Pubkey, nonce: u64) -> Result<()> {
    if n.owner == Pubkey::default() { n.owner = owner; }
    require!(n.nonce == nonce, EntryError::BadNonce);
    n.nonce = n.nonce.checked_add(1).ok_or(EntryError::BadNonce)?; Ok(())
}
fn burn_accs<'info>(a: &PrivateRemove<'info>) -> veyl_bin::cpi::accounts::BurnLiquidity<'info> {
    veyl_bin::cpi::accounts::BurnLiquidity {
        authority: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(),
        mint_x: a.mint_x.to_account_info(), mint_y: a.mint_y.to_account_info(),
        vault_x: a.bin_vault_x.to_account_info(), vault_y: a.bin_vault_y.to_account_info(),
        to_x: a.entry_vault_x.to_account_info(), to_y: a.entry_vault_y.to_account_info(),
        token_program_x: a.token_program_x.to_account_info(), token_program_y: a.token_program_y.to_account_info() }
}
fn mint_accs<'info>(a: &PrivateAdd<'info>) -> veyl_bin::cpi::accounts::MintLiquidity<'info> {
    veyl_bin::cpi::accounts::MintLiquidity {
        from: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(),
        mint_x: a.mint_x.to_account_info(), mint_y: a.mint_y.to_account_info(),
        vault_x: a.bin_vault_x.to_account_info(), vault_y: a.bin_vault_y.to_account_info(),
        from_x: a.entry_vault_x.to_account_info(), from_y: a.entry_vault_y.to_account_info(),
        token_program_x: a.token_program_x.to_account_info(), token_program_y: a.token_program_y.to_account_info() }
}
fn add_checks(a: &PrivateAdd, bin_pool: Pubkey, fee_recipient: Pubkey, deadline: i64) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= deadline, EntryError::Expired);
    require_keys_eq!(a.bin_pool.key(), bin_pool, EntryError::UnknownPool);
    require_keys_eq!(a.fee_token_x.owner, fee_recipient, EntryError::WrongRecipient);
    require_keys_eq!(a.fee_token_y.owner, fee_recipient, EntryError::WrongRecipient);
    Ok(())
}
/// Spend one posted note (leg = [private pool, pool vault, posted spend]) of X (`want_x`) or Y into the entry's vault,
/// pay the relayer's capped fee, and return what is left.
fn spend_leg<'info>(a: &PrivateAdd<'info>, leg: &'info [AccountInfo<'info>], want_x: bool, data: Vec<u8>, fee_bps: u16, bump: u8) -> Result<u64> {
    let pool_acc: AccountLoader<'info, veyl_pool::Pool> = AccountLoader::try_from(&leg[0])?;
    let (mint, ev, tp, ft) = if want_x { (&a.mint_x, &a.entry_vault_x, &a.token_program_x, &a.fee_token_x) } else { (&a.mint_y, &a.entry_vault_y, &a.token_program_y, &a.fee_token_y) };
    require_keys_eq!(pool_acc.load()?.mint, mint.key(), EntryError::BadLegs);
    let v = withdraw_cpi_raw(&a.veyl_pool, &a.signer, &leg[0], mint.to_account_info(), leg[1].clone(), leg[2].clone(), ev.to_account_info(), tp.to_account_info(), bump, data)?;
    let fee = fee_of(v, fee_bps)?;
    if fee > 0 { pay(tp, ev, mint, ft, &a.signer, bump, fee)?; }
    Ok(v - fee)
}

/// Execute every route hop by hop through veyl_bin, with `who` as the swapper (the entry's signer PDA, or the user).
fn run_routes<'info>(bin_prog: &Program<'info, VeylBin>, who: AccountInfo<'info>, who_seeds: Option<&Vec<&[u8]>>, token_in: &Pubkey, token_out: &Pubkey, routes: &[Route], first_in: &InterfaceAccount<'info, TokenAccount>, final_out: &InterfaceAccount<'info, TokenAccount>, rem: &'info [AccountInfo<'info>]) -> Result<u64> {
    let mut out = 0u64; let mut k = 0usize;
    for r in routes {
        require!(!r.hops.is_empty() && r.hops.len() <= MAX_HOPS, EntryError::BadRoute);
        let mut amt = r.amount_in; let mut cur = *token_in; let mut cur_acc = first_in.to_account_info();
        for h in &r.hops {
            require!(rem.len() >= k + 8 + h.n_arrays as usize, EntryError::BadRoute);
            let (pool, mint_x, mint_y, vault_x, vault_y, tp_x, tp_y, out_acc) = (&rem[k], &rem[k + 1], &rem[k + 2], &rem[k + 3], &rem[k + 4], &rem[k + 5], &rem[k + 6], &rem[k + 7]);
            let arrays = rem[k + 8..k + 8 + h.n_arrays as usize].to_vec(); k += 8 + h.n_arrays as usize;
            require_keys_eq!(*pool.key, h.pool, EntryError::UnknownPool);
            let bp: AccountLoader<'info, veyl_bin::BinPool> = AccountLoader::try_from(pool)?; // owner + discriminator checked: a listed pool
            let (pin, pout) = { let p = bp.load()?; if h.x_for_y { (p.mint_x, p.mint_y) } else { (p.mint_y, p.mint_x) } };
            require!(pin == cur, EntryError::BadRoute);
            let out_tok: InterfaceAccount<'info, TokenAccount> = InterfaceAccount::try_from(out_acc)?;
            require!(out_tok.mint == pout && out_tok.owner == *who.key, EntryError::BadRoute);
            let accs = veyl_bin::cpi::accounts::Swap { user: who.clone(), pool: pool.clone(), mint_x: mint_x.clone(), mint_y: mint_y.clone(), vault_x: vault_x.clone(), vault_y: vault_y.clone(), user_in: cur_acc.clone(), user_out: out_acc.clone(), token_program_x: tp_x.clone(), token_program_y: tp_y.clone() };
            let empty: Vec<&[u8]> = Vec::new(); let sg = [who_seeds.unwrap_or(&empty).as_slice()];
            let cpi = match who_seeds { Some(_) => CpiContext::new_with_signer(bin_prog.to_account_info(), accs, &sg), None => CpiContext::new(bin_prog.to_account_info(), accs) }.with_remaining_accounts(arrays);
            amt = veyl_bin::cpi::swap(cpi, h.x_for_y, amt, 0)?.get();
            cur = pout; cur_acc = out_acc.clone();
        }
        require!(cur == *token_out && *cur_acc.key == final_out.key(), EntryError::BadRoute);
        out = out.checked_add(amt).ok_or(EntryError::AmountMismatch)?;
    }
    Ok(out)
}

/// The instruction before this one must be the ed25519 program verifying `owner`'s signature over exactly `digest`.
fn check_ed25519(instructions: &UncheckedAccount, owner: &Pubkey, digest: &[u8; 32]) -> Result<()> {
    let idx = load_current_index_checked(instructions)?;
    require!(idx > 0, EntryError::BadSignature);
    let ix = load_instruction_at_checked(idx as usize - 1, instructions)?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM, EntryError::BadSignature);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, EntryError::BadSignature);
    let rd = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
    let (sig_off, sig_ix, pk_off, pk_ix, msg_off, msg_size, msg_ix) = (rd(2), rd(4), rd(6), rd(8), rd(10), rd(12), rd(14));
    require!(sig_ix == u16::MAX as usize && pk_ix == u16::MAX as usize && msg_ix == u16::MAX as usize, EntryError::BadSignature);
    require!(d.len() >= pk_off + 32 && d.len() >= msg_off + msg_size && d.len() >= sig_off + 64, EntryError::BadSignature);
    require!(&d[pk_off..pk_off + 32] == owner.as_ref(), EntryError::BadSignature);
    require!(msg_size == 32 && &d[msg_off..msg_off + 32] == &digest[..], EntryError::BadSignature);
    Ok(())
}


// ---- Phase 2 internals
pub const MAX_BUFFER: usize = 4096;
type TokAccs<'info> = (AccountInfo<'info>, AccountInfo<'info>, AccountInfo<'info>, AccountInfo<'info>, AccountInfo<'info>);
/// veyl_pool's shield PDA.
pub fn shield_pda() -> Pubkey { Pubkey::find_program_address(&[veyl_pool::SHIELD_SEED], &veyl_pool::ID).0 }
/// Execute one funding leg: a posted transact proof (`leg` = [posted, poster, nullifier 0, nullifier 1]) whose public amount
/// is paid to this program's vault (`tok` = mint, shield vault, entry vault, relayer fee token account, token program),
/// or burned as a virtual asset. Returns the amount.
fn leg_cpi<'info>(prog: &Program<'info, VeylPool>, events: &UncheckedAccount<'info>, signer: &UncheckedAccount<'info>, payer: &Signer<'info>, shield: &UncheckedAccount<'info>, leg: &[AccountInfo<'info>], tok: Option<TokAccs<'info>>, system: &Program<'info, System>, bump: u8, ext: veyl_pool::TransactExt, virt: Option<[u8; 32]>) -> Result<u64> {
    require!(leg.len() == 4, EntryError::BadLegs);
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let (mint, vault, ptok, rtok, tp) = match tok { Some((m, v, p, r, t)) => (Some(m), Some(v), Some(p), Some(r), Some(t)), None => (None, None, None, None, None) };
    let cpi = CpiContext::new_with_signer(prog.to_account_info(), veyl_pool::cpi::accounts::TransactCpi { processor: signer.to_account_info(), payer: payer.to_account_info(), shield: shield.to_account_info(),
        posted: leg[0].clone(), poster: leg[1].clone(), nullifier0: leg[2].clone(), nullifier1: leg[3].clone(), mint, vault, processor_token: ptok, relayer_token: rtok, token_program: tp, system_program: system.to_account_info(), event_authority: events.to_account_info(), program: prog.to_account_info() }, &sg);
    Ok(veyl_pool::cpi::transact_cpi(cpi, ext, virt)?.get())
}
/// A receipt note: `amount` of a token from this program's vault (`tok` = mint, shield vault, entry vault, token program)
/// or of a virtual asset, for a one-time owner.
fn receipt_cpi<'info>(prog: &Program<'info, VeylPool>, events: &UncheckedAccount<'info>, signer: &UncheckedAccount<'info>, shield: &UncheckedAccount<'info>, tok: Option<(AccountInfo<'info>, AccountInfo<'info>, AccountInfo<'info>, AccountInfo<'info>)>, bump: u8, virt: Option<[u8; 32]>, amount: u64, owner: [u8; 32], blinding: [u8; 32]) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let (mint, vault, from, tp) = match tok { Some((m, v, f, t)) => (Some(m), Some(v), Some(f), Some(t)), None => (None, None, None, None) };
    let cpi = CpiContext::new_with_signer(prog.to_account_info(), veyl_pool::cpi::accounts::DepositReceipt { processor: signer.to_account_info(), shield: shield.to_account_info(), mint, vault, processor_token: from, token_program: tp, event_authority: events.to_account_info(), program: prog.to_account_info() }, &sg);
    veyl_pool::cpi::deposit_receipt(cpi, virt, amount, owner, blinding)?; Ok(())
}
fn shield_pay_cpi<'info>(prog: &Program<'info, VeylPool>, signer: &UncheckedAccount<'info>, shield: &UncheckedAccount<'info>, mint: &InterfaceAccount<'info, Mint>, vault: &InterfaceAccount<'info, TokenAccount>, to: &InterfaceAccount<'info, TokenAccount>, tp: &Interface<'info, TokenInterface>, bump: u8, amount: u64) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let cpi = CpiContext::new_with_signer(prog.to_account_info(), veyl_pool::cpi::accounts::ShieldPay { processor: signer.to_account_info(), shield: shield.to_account_info(), mint: mint.to_account_info(), vault: vault.to_account_info(), to: to.to_account_info(), token_program: tp.to_account_info() }, &sg);
    veyl_pool::cpi::shield_pay(cpi, amount)
}
fn pay_tok<'info>(tp: &Interface<'info, TokenInterface>, from: &InterfaceAccount<'info, TokenAccount>, mint: &InterfaceAccount<'info, Mint>, to: &InterfaceAccount<'info, TokenAccount>, signer: &UncheckedAccount<'info>, bump: u8, amount: u64) -> Result<()> { if amount == 0 { return Ok(()); } pay(tp, from, mint, to, signer, bump, amount) }
fn bin_out_accs_w<'info>(authority: AccountInfo<'info>, pool: AccountInfo<'info>, mx: &InterfaceAccount<'info, Mint>, my: &InterfaceAccount<'info, Mint>, vx: &InterfaceAccount<'info, TokenAccount>, vy: &InterfaceAccount<'info, TokenAccount>, to_x: AccountInfo<'info>, to_y: AccountInfo<'info>, tpx: &Interface<'info, TokenInterface>, tpy: &Interface<'info, TokenInterface>) -> veyl_bin::cpi::accounts::BurnLiquidity<'info> {
    veyl_bin::cpi::accounts::BurnLiquidity { authority, pool, mint_x: mx.to_account_info(), mint_y: my.to_account_info(), vault_x: vx.to_account_info(), vault_y: vy.to_account_info(), to_x, to_y, token_program_x: tpx.to_account_info(), token_program_y: tpy.to_account_info() }
}
fn bin_out_accs<'info>(a: &ShieldLp<'info>, to_x: AccountInfo<'info>, to_y: AccountInfo<'info>) -> veyl_bin::cpi::accounts::BurnLiquidity<'info> {
    bin_out_accs_w(a.signer.to_account_info(), a.bin_pool.to_account_info(), &a.mint_x, &a.mint_y, &a.bin_vault_x, &a.bin_vault_y, to_x, to_y, &a.token_program_x, &a.token_program_y)
}

// ---- shield_lp steps (each #[inline(never)]: its own 4 KB stack frame)
#[inline(never)]
fn lp_checks(a: &ShieldLp, req: &LpRequest) -> Result<()> {
    let c = &req.core;
    require!(Clock::get()?.unix_timestamp <= c.deadline, EntryError::Expired);
    require_keys_eq!(a.bin_pool.key(), c.bin_pool, EntryError::UnknownPool);
    require!(c.deltas.len() == K && c.hint_x.len() == K && c.hint_y.len() == K && req.legs.len() <= 2 && c.ciphertext.len() <= 1024, EntryError::BadLegs);
    require_keys_eq!(a.fee_token_x.owner, c.relayer, EntryError::WrongRecipient);
    require_keys_eq!(a.fee_token_y.owner, c.relayer, EntryError::WrongRecipient);
    Ok(())
}
#[inline(never)]
fn lp_legs<'info>(a: &ShieldLp<'info>, req: &LpRequest, leg_infos: &'info [AccountInfo<'info>], action: &[u8; 32], bump: u8) -> Result<()> {
    for (i, ext) in req.legs.iter().enumerate() {
        require!(ext.action == *action, EntryError::BadContext);
        let is_x = ext.mint == a.mint_x.key(); require!(is_x || ext.mint == a.mint_y.key(), EntryError::BadLegs);
        let (mint, sv, ev, ft, tp) = if is_x { (&a.mint_x, &a.shield_vault_x, &a.entry_vault_x, &a.fee_token_x, &a.token_program_x) } else { (&a.mint_y, &a.shield_vault_y, &a.entry_vault_y, &a.fee_token_y, &a.token_program_y) };
        leg_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.relayer, &a.shield, &leg_infos[4 * i..4 * i + 4], Some((mint.to_account_info(), sv.to_account_info(), ev.to_account_info(), ft.to_account_info(), tp.to_account_info())), &a.system_program, bump, ext.clone(), None)?;
    }
    Ok(())
}
fn lp_loaders<'info>(lp_infos: &'info [AccountInfo<'info>], pool: &Pubkey) -> Result<Vec<AccountLoader<'info, LpAcc>>> {
    let mut lp = Vec::with_capacity(lp_infos.len());
    for info in lp_infos { let l: AccountLoader<'info, LpAcc> = AccountLoader::try_from(info)?; require_keys_eq!(l.load()?.pool, *pool, EntryError::UnknownPool); lp.push(l); }
    Ok(lp)
}
fn lp_index(lp: &[AccountLoader<LpAcc>], id: i32) -> Result<usize> { let ch = veyl_bin::chunk_of(id); lp.iter().position(|l| l.load().map(|a| a.chunk == ch).unwrap_or(false)).ok_or_else(|| error!(EntryError::MissingLpAcc)) }
#[inline(never)]
fn lp_check_proof<'info>(a: &ShieldLp<'info>, c: &LpCore, lp_infos: &'info [AccountInfo<'info>], ext_hash: &[u8; 32]) -> Result<Box<[[u8; 32]; 8]>> {
    let pubs = { let p = &a.posted; require!(p.kind == veyl_pool::KIND_POSITION, EntryError::BadContext); Box::new(p.pubs) };
    require!(pubs[3] == veyl_pool::pos_asset_of(&c.bin_pool, c.lo) && pubs[7] == *ext_hash, EntryError::BadContext);
    let lp = lp_loaders(lp_infos, &c.bin_pool)?;
    let mut hx: Vec<[u8; 32]> = Vec::with_capacity(K); let mut hy: Vec<[u8; 32]> = Vec::with_capacity(K); let mut hd: Vec<[u8; 32]> = Vec::with_capacity(K);
    for b in 0..K { let id = c.lo + b as i32; let acc = lp[lp_index(&lp, id)?].load()?; let s = veyl_bin::slot_of(id);
        hx.push(veyl_pool::u128_to_field(veyl_bin::g(&acc.hx[s]))); hy.push(veyl_pool::u128_to_field(veyl_bin::g(&acc.hy[s]))); hd.push(veyl_pool::signed_field(c.deltas[b])); }
    let (ax, ay) = (veyl_pool::asset_of(&a.mint_x.key()), veyl_pool::asset_of(&a.mint_y.key()));
    let (fx, fy) = (veyl_pool::u64_to_field(c.claim_fee[0]), veyl_pool::u64_to_field(c.claim_fee[1]));
    let bundle = veyl_pool::poseidon(&[&hash16(&hx)?, &hash16(&hy)?, &hash16(&hd)?, &ax, &ay, &fx, &fy])?;
    require!(bundle == pubs[4], EntryError::BadContext);
    Ok(pubs)
}
#[inline(never)]
fn lp_zap<'info>(a: &ShieldLp<'info>, c: &LpCore, bin_infos: &'info [AccountInfo<'info>], bump: u8) -> Result<()> {
    let z = c.zap.as_ref().unwrap();
    require!(z.amount > 0 && z.min_out > 0, EntryError::Slippage);
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let (uin, uout) = if z.x_in { (&a.entry_vault_x, &a.entry_vault_y) } else { (&a.entry_vault_y, &a.entry_vault_x) };
    let accs = veyl_bin::cpi::accounts::Swap { user: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(), mint_x: a.mint_x.to_account_info(), mint_y: a.mint_y.to_account_info(), vault_x: a.bin_vault_x.to_account_info(), vault_y: a.bin_vault_y.to_account_info(), user_in: uin.to_account_info(), user_out: uout.to_account_info(), token_program_x: a.token_program_x.to_account_info(), token_program_y: a.token_program_y.to_account_info() };
    veyl_bin::cpi::swap(CpiContext::new_with_signer(a.veyl_bin.to_account_info(), accs, &sg).with_remaining_accounts(bin_infos.to_vec()), z.x_in, z.amount, z.min_out)?;
    Ok(())
}
/// Returns the aggregate's shares per window bin before the action and the rise of H per token per bin (2 x 16, flat).
#[inline(never)]
fn lp_harvest<'info>(a: &ShieldLp<'info>, c: &LpCore, lp_infos: &'info [AccountInfo<'info>], bin_infos: &'info [AccountInfo<'info>], bump: u8) -> Result<(Vec<u128>, Vec<u128>, Vec<u64>)> {
    let owner = shield_owner(); let signer = a.signer.key();
    let mut supply = vec![0u128; K]; let mut cache: Vec<(i32, Option<usize>)> = Vec::new();
    for b in 0..K { let id = c.lo + b as i32; let ch = veyl_bin::chunk_of(id);
        let idx = match cache.iter().find(|(k, _)| *k == ch) { Some((_, i)) => *i, None => { let key = Pubkey::find_program_address(&[b"shares", c.bin_pool.as_ref(), owner.as_ref(), signer.as_ref(), &ch.to_le_bytes()], &veyl_bin::ID).0; let i = bin_infos.iter().position(|x| x.key == &key && x.owner == &veyl_bin::ID); cache.push((ch, i)); i } };
        if let Some(i) = idx { let l: AccountLoader<'info, veyl_bin::ShareAccount> = AccountLoader::try_from(&bin_infos[i])?; supply[b] = veyl_bin::g(&l.load()?.slots[veyl_bin::slot_of(id)].shares); } }
    let hv: Vec<i32> = (0..K).filter(|b| supply[*b] > 0).map(|b| c.lo + b as i32).collect();
    let mut dh = vec![0u128; 2 * K]; let mut gotv = vec![0u64; 2 * K];
    if !hv.is_empty() {
        let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
        let cpi = CpiContext::new_with_signer(a.veyl_bin.to_account_info(), bin_out_accs(a, a.shield_vault_x.to_account_info(), a.shield_vault_y.to_account_info()), &sg).with_remaining_accounts(bin_infos.to_vec());
        let got = veyl_bin::cpi::harvest(cpi, owner, hv.clone())?.get();
        require!(got.len() == 2 * hv.len() + 2, EntryError::BadLegs);
        let lp = lp_loaders(lp_infos, &c.bin_pool)?;
        for (k, id) in hv.iter().enumerate() {
            let b = (*id - c.lo) as usize; let sup = supply[b]; gotv[b] = got[2 * k]; gotv[K + b] = got[2 * k + 1];
            dh[b] = ((got[2 * k] as u128) << 64) / sup; dh[K + b] = ((got[2 * k + 1] as u128) << 64) / sup;
            let mut acc = lp[lp_index(&lp, *id)?].load_mut()?; let s_ = veyl_bin::slot_of(*id);
            let nx = veyl_bin::g(&acc.hx[s_]).checked_add(dh[b]).ok_or(EntryError::AmountMismatch)?; veyl_bin::st(&mut acc.hx[s_], nx);
            let ny = veyl_bin::g(&acc.hy[s_]).checked_add(dh[K + b]).ok_or(EntryError::AmountMismatch)?; veyl_bin::st(&mut acc.hy[s_], ny);
        }
    }
    Ok((supply, dh, gotv))
}
/// ceil(sum over added bins of delta * dH / 2^64) charged, floor(sum over removed bins of |delta| * dH / 2^64) paid, per token.
#[inline(never)]
fn lp_adjust(c: &LpCore, dh: &[u128]) -> Result<([u64; 2], [u64; 2])> {
    let mut charge = [0u64; 2]; let mut pay = [0u64; 2];
    for t in 0..2 {
        let (mut pos, mut neg) = (veyl_bin::U512::zero(), veyl_bin::U512::zero());
        for b in 0..K { let d = c.deltas[b]; let h = dh[t * K + b]; if d == 0 || h == 0 { continue; } let p = veyl_bin::U512::from(d.unsigned_abs()) * veyl_bin::U512::from(h); if d > 0 { pos = pos + p; } else { neg = neg + p; } }
        let ch = (pos + (veyl_bin::U512::one() << 64) - veyl_bin::U512::one()) >> 64; let py = neg >> 64;
        require!(ch.bits() <= 64 && py.bits() <= 64, EntryError::AmountMismatch);
        charge[t] = ch.low_u64(); pay[t] = py.low_u64(); // max_charge is checked once settled (lp_settle): a diluted charge is not taken
    }
    Ok((charge, pay))
}
#[inline(never)]
fn lp_settle<'info>(a: &mut ShieldLp<'info>, c: &LpCore, lp_infos: &'info [AccountInfo<'info>], supply: &[u128], dh: &[u128], got: &[u64], start: (u64, u64), charge: &mut [u64; 2], pay: &[u64; 2]) -> Result<[bool; 2]> {
    a.entry_vault_x.reload()?; a.entry_vault_y.reload()?;
    let avail = [a.entry_vault_x.amount.saturating_sub(start.0), a.entry_vault_y.amount.saturating_sub(start.1)];
    let mut diluted = [false; 2];
    for t in 0..2 {
        if charge[t] <= pay[t] { continue; }
        let need = (charge[t] - pay[t]).checked_add(c.leftover_fee[t]).ok_or(EntryError::AmountMismatch)?;
        if avail[t] >= need { continue; }
        let lp = lp_loaders(lp_infos, &c.bin_pool)?;
        for b in 0..K {
            let d = c.deltas[b]; let g_ = got[t * K + b]; if d <= 0 || g_ == 0 { continue; }
            let id = c.lo + b as i32; let s_ = veyl_bin::slot_of(id);
            let nd = ((g_ as u128) << 64) / (supply[b] + d as u128);
            let mut acc = lp[lp_index(&lp, id)?].load_mut()?;
            if t == 0 { let h = veyl_bin::g(&acc.hx[s_]); veyl_bin::st(&mut acc.hx[s_], h - dh[b] + nd); }
            else { let h = veyl_bin::g(&acc.hy[s_]); veyl_bin::st(&mut acc.hy[s_], h - dh[K + b] + nd); }
        }
        charge[t] = 0; diluted[t] = true;
    }
    for t in 0..2 { require!(charge[t] <= c.max_charge[t], EntryError::Slippage); }
    Ok(diluted)
}
#[inline(never)]
fn lp_burn_mint<'info>(a: &mut ShieldLp<'info>, c: &LpCore, bin_infos: &'info [AccountInfo<'info>], supply: &[u128], start: (u64, u64), bump: u8) -> Result<()> {
    let owner = shield_owner();
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let burn: Vec<(i32, u128)> = (0..K).filter(|b| c.deltas[*b] < 0).map(|b| (c.lo + b as i32, c.deltas[b].unsigned_abs())).collect();
    if !burn.is_empty() {
        let cpi = CpiContext::new_with_signer(a.veyl_bin.to_account_info(), bin_out_accs(a, a.entry_vault_x.to_account_info(), a.entry_vault_y.to_account_info()), &sg).with_remaining_accounts(bin_infos.to_vec());
        veyl_bin::cpi::burn(cpi, owner, burn.iter().map(|x| x.0).collect(), burn.iter().map(|x| x.1).collect())?;
    }
    let mint_ix: Vec<usize> = (0..K).filter(|b| c.deltas[*b] > 0).collect();
    if !mint_ix.is_empty() {
        for b in &mint_ix { require!(supply[*b].checked_add(c.deltas[*b] as u128).map_or(false, |x| x < MAX_SHIELD_SHARES), EntryError::AmountMismatch); }
        a.entry_vault_x.reload()?; a.entry_vault_y.reload()?;
        let (max_x, max_y) = (a.entry_vault_x.amount.saturating_sub(start.0), a.entry_vault_y.amount.saturating_sub(start.1));
        let accs = veyl_bin::cpi::accounts::MintLiquidity { from: a.signer.to_account_info(), pool: a.bin_pool.to_account_info(), mint_x: a.mint_x.to_account_info(), mint_y: a.mint_y.to_account_info(), vault_x: a.bin_vault_x.to_account_info(), vault_y: a.bin_vault_y.to_account_info(), from_x: a.entry_vault_x.to_account_info(), from_y: a.entry_vault_y.to_account_info(), token_program_x: a.token_program_x.to_account_info(), token_program_y: a.token_program_y.to_account_info() };
        let cpi = CpiContext::new_with_signer(a.veyl_bin.to_account_info(), accs, &sg).with_remaining_accounts(bin_infos.to_vec());
        veyl_bin::cpi::mint_exact(cpi, owner, a.signer.key(), mint_ix.iter().map(|b| c.lo + *b as i32).collect(), mint_ix.iter().map(|b| c.deltas[*b] as u128).collect(),
            mint_ix.iter().map(|b| c.hint_x[*b]).collect(), mint_ix.iter().map(|b| c.hint_y[*b]).collect(), max_x, max_y, c.deadline)?;
    }
    Ok(())
}
#[inline(never)]
fn lp_pot<'info>(a: &ShieldLp<'info>, c: &LpCore, charge: [u64; 2], pay: [u64; 2], bump: u8) -> Result<()> {
    for t in 0..2 {
        let (mint, sv, ev, ft, tp) = if t == 0 { (&a.mint_x, &a.shield_vault_x, &a.entry_vault_x, &a.fee_token_x, &a.token_program_x) } else { (&a.mint_y, &a.shield_vault_y, &a.entry_vault_y, &a.fee_token_y, &a.token_program_y) };
        if charge[t] > pay[t] { pay_tok(tp, ev, mint, sv, &a.signer, bump, charge[t] - pay[t])?; }
        else if pay[t] > charge[t] { shield_pay_cpi(&a.veyl_pool, &a.signer, &a.shield, mint, sv, ev, tp, bump, pay[t] - charge[t])?; }
        if c.claim_fee[t] > 0 { shield_pay_cpi(&a.veyl_pool, &a.signer, &a.shield, mint, sv, ft, tp, bump, c.claim_fee[t])?; }
        if c.leftover_fee[t] > 0 { pay_tok(tp, ev, mint, ft, &a.signer, bump, c.leftover_fee[t])?; }
    }
    Ok(())
}
#[inline(never)]
fn lp_consume<'info>(a: &ShieldLp<'info>, ext_hash: &[u8; 32], ciphertext: &[u8], bump: u8) -> Result<()> {
    let seeds = signer_seeds(bump); let s: Vec<&[u8]> = vec![b"signer", &seeds[0]]; let sg = [s.as_slice()];
    let cpi = CpiContext::new_with_signer(a.veyl_pool.to_account_info(), veyl_pool::cpi::accounts::ConsumePosition { processor: a.signer.to_account_info(), payer: a.relayer.to_account_info(), shield: a.shield.to_account_info(), posted: a.posted.to_account_info(), poster: a.poster.to_account_info(), nullifier: a.nullifier.to_account_info(), system_program: a.system_program.to_account_info(), event_authority: a.pool_events.to_account_info(), program: a.veyl_pool.to_account_info() }, &sg);
    veyl_pool::cpi::consume_position(cpi, *ext_hash, ciphertext.to_vec())
}

/// The shielded aggregate's shares in bin `id` (0 when its share account for that chunk is not among `infos`).
fn agg_shares<'info>(infos: &'info [AccountInfo<'info>], pool: &Pubkey, owner: &Pubkey, auth: &Pubkey, id: i32) -> Result<u128> {
    let ch = veyl_bin::chunk_of(id);
    let key = Pubkey::find_program_address(&[b"shares", pool.as_ref(), owner.as_ref(), auth.as_ref(), &ch.to_le_bytes()], &veyl_bin::ID).0;
    match infos.iter().find(|i| i.key == &key) {
        Some(i) if i.owner == &veyl_bin::ID => { let l: AccountLoader<'info, veyl_bin::ShareAccount> = AccountLoader::try_from(i)?; let a = l.load()?; Ok(veyl_bin::g(&a.slots[veyl_bin::slot_of(id)].shares)) }
        _ => Ok(0),
    }
}
/// Whatever this action left in the vaults since it started goes back into the shielded pool as receipt notes.
fn receipts<'info>(a: &mut ShieldLp<'info>, start_x: u64, start_y: u64, owners: [[u8; 32]; 2], blindings: [[u8; 32]; 2], bump: u8) -> Result<[u64; 2]> {
    a.entry_vault_x.reload()?; a.entry_vault_y.reload()?;
    let (lx, ly) = (a.entry_vault_x.amount.saturating_sub(start_x), a.entry_vault_y.amount.saturating_sub(start_y));
    receipt_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.shield, Some((a.mint_x.to_account_info(), a.shield_vault_x.to_account_info(), a.entry_vault_x.to_account_info(), a.token_program_x.to_account_info())), bump, None, lx, owners[0], blindings[0])?;
    receipt_cpi(&a.veyl_pool, &a.pool_events, &a.signer, &a.shield, Some((a.mint_y.to_account_info(), a.shield_vault_y.to_account_info(), a.entry_vault_y.to_account_info(), a.token_program_y.to_account_info())), bump, None, ly, owners[1], blindings[1])?;
    Ok([lx, ly])
}

// ------------------------------------------------------------------------------------------------ state / accounts

#[account]
pub struct Entry { pub bump: u8, pub signer_bump: u8 }
/// EVM `nonces[owner]`
#[account]
pub struct Nonce { pub owner: Pubkey, pub nonce: u64 }

#[derive(Accounts)]
pub struct InitEntry<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + 2, seeds = [b"entry"], bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: PDA that acts as the processor; holds no data
    #[account(seeds = [b"signer"], bump)] pub signer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, associated_token::mint = mint, associated_token::authority = signer, associated_token::token_program = token_program)] pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Relay<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA (the processor)
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump, seeds::program = veyl_pool.key())] pub pool: AccountLoader<'info, veyl_pool::Pool>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub spend: Box<Account<'info, veyl_pool::Spend>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = signer, associated_token::token_program = token_program)] pub entry_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint)] pub fee_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint)] pub recipient_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
}
#[derive(Accounts)]
pub struct PrivateSwap<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"pool", mint_in.key().as_ref()], bump, seeds::program = veyl_pool.key())] pub pool_in: AccountLoader<'info, veyl_pool::Pool>,
    pub mint_in: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub vault_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub spend: Box<Account<'info, veyl_pool::Spend>>,
    #[account(mut, associated_token::mint = mint_in, associated_token::authority = signer, associated_token::token_program = token_program_in)] pub entry_vault_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_in)] pub fee_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint_out: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint_out, associated_token::authority = signer, associated_token::token_program = token_program_out)] pub entry_vault_out: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The public recipient's token account for `token_out` (ignored when the output goes back into the private balance).
    #[account(mut)] pub payout_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"pool", mint_out.key().as_ref()], bump, seeds::program = veyl_pool.key())] pub pool_out: AccountLoader<'info, veyl_pool::Pool>,
    #[account(mut)] pub vault_out: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the new note's deposit record, created by veyl_pool
    #[account(mut)] pub deposit_record: UncheckedAccount<'info>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub token_program_out: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct PrivateAdd<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(address = bin_pool.load()?.mint_x @ EntryError::UnknownToken)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = bin_pool.load()?.mint_y @ EntryError::UnknownToken)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub bin_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub bin_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = signer, associated_token::token_program = token_program_x)] pub entry_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = signer, associated_token::token_program = token_program_y)] pub entry_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_x)] pub fee_token_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_y)] pub fee_token_y: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
}
/// Every action signed by a position's one-time key (remove, claim fees, withdraw a limit order, rebalance): the data of
/// each starts with `owner`, whose nonce PDA guards replay.
#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct PrivateRemove<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, for the ed25519 check
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = relayer, space = 8 + 32 + 8, seeds = [b"nonce", owner.as_ref()], bump)] pub nonce: Box<Account<'info, Nonce>>,
    #[account(mut)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(address = bin_pool.load()?.mint_x @ EntryError::UnknownToken)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = bin_pool.load()?.mint_y @ EntryError::UnknownToken)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub bin_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub bin_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = signer, associated_token::token_program = token_program_x)] pub entry_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = signer, associated_token::token_program = token_program_y)] pub entry_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_x)] pub fee_token_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_y)] pub fee_token_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"pool", mint_x.key().as_ref()], bump, seeds::program = veyl_pool.key())] pub pool_x: AccountLoader<'info, veyl_pool::Pool>,
    #[account(mut)] pub pool_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: new note record for X, created by veyl_pool when the proceeds go back into the private balance
    #[account(mut)] pub deposit_record_x: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"pool", mint_y.key().as_ref()], bump, seeds::program = veyl_pool.key())] pub pool_y: AccountLoader<'info, veyl_pool::Pool>,
    #[account(mut)] pub pool_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: new note record for Y
    #[account(mut)] pub deposit_record_y: UncheckedAccount<'info>,
    /// Public recipient's token accounts (ignored when the proceeds go back into the private balance).
    #[account(mut)] pub payout_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub payout_y: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct PrivateClaimReward<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, for the ed25519 check
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = relayer, space = 8 + 32 + 8, seeds = [b"nonce", owner.as_ref()], bump)] pub nonce: Box<Account<'info, Nonce>>,
    #[account(mut)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the bin pool's reward vault (veyl_bin checks it against the pool)
    #[account(mut)] pub reward_vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = reward_mint, associated_token::authority = signer, associated_token::token_program = token_program)] pub entry_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = reward_mint)] pub fee_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: veyl_pool's pool for the reward mint (only used, and then checked, when the reward goes into a new note)
    #[account(mut)] pub pool: UncheckedAccount<'info>,
    /// CHECK: that pool's vault (checked by veyl_pool's deposit)
    #[account(mut)] pub pool_vault: UncheckedAccount<'info>,
    /// CHECK: the new note's deposit record, created by veyl_pool
    #[account(mut)] pub deposit_record: UncheckedAccount<'info>,
    /// Public recipient's token account (ignored when the reward goes into a new note).
    #[account(mut)] pub payout_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SwapRoute<'info> {
    pub user: Signer<'info>,
    #[account(mut)] pub user_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub user_out: Box<InterfaceAccount<'info, TokenAccount>>,
    pub veyl_bin: Program<'info, VeylBin>,
}


// ---- Phase 2 accounts
#[derive(Accounts)]
#[instruction(chunk: i32)]
pub struct InitLpAcc<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(init, payer = payer, space = LpAcc::SIZE, seeds = [b"lpacc".as_ref(), bin_pool.key().as_ref(), &chunk.to_le_bytes()], bump)] pub lp_acc: AccountLoader<'info, LpAcc>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(id: u64, len: u32)]
pub struct OpenBuffer<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + 32 + 4 + len as usize, seeds = [b"buf".as_ref(), owner.key().as_ref(), &id.to_le_bytes()], bump)] pub buffer: Box<Account<'info, Buffer>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct WriteBuffer<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"buf".as_ref(), owner.key().as_ref(), &id.to_le_bytes()], bump, has_one = owner @ EntryError::BadRequest)] pub buffer: Box<Account<'info, Buffer>>,
}
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CloseBuffer<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(mut, close = owner, seeds = [b"buf".as_ref(), owner.key().as_ref(), &id.to_le_bytes()], bump, has_one = owner @ EntryError::BadRequest)] pub buffer: Box<Account<'info, Buffer>>,
}
#[derive(Accounts)]
pub struct ShieldLp<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut, close = relayer, constraint = buffer.owner == relayer.key() @ EntryError::BadRequest)] pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: veyl_pool's shield
    #[account(mut, address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    #[account(mut)] pub posted: Box<Account<'info, veyl_pool::PostedProof>>,
    /// CHECK: the posted proof's poster (veyl_pool checks it)
    #[account(mut)] pub poster: UncheckedAccount<'info>,
    /// CHECK: the position's nullifier PDA (veyl_pool creates and checks it)
    #[account(mut)] pub nullifier: UncheckedAccount<'info>,
    #[account(mut)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(address = bin_pool.load()?.mint_x @ EntryError::UnknownToken)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = bin_pool.load()?.mint_y @ EntryError::UnknownToken)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub bin_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub bin_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = signer, associated_token::token_program = token_program_x)] pub entry_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = signer, associated_token::token_program = token_program_y)] pub entry_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The shielded pool's vaults: harvested fees go straight here, so they must be exactly these accounts.
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = shield, associated_token::token_program = token_program_x)] pub shield_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = shield, associated_token::token_program = token_program_y)] pub shield_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_x)] pub fee_token_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_y)] pub fee_token_y: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
    pub system_program: Program<'info, System>,
    /// CHECK: veyl_pool's event authority PDA ["__event_authority"] (veyl_pool checks its seeds): signs the self-CPI that
    /// carries the tree's events
    pub pool_events: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct ShieldSwap<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut, close = relayer, constraint = buffer.owner == relayer.key() @ EntryError::BadRequest)] pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: veyl_pool's shield
    #[account(mut, address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    /// CHECK: posted transact proof (veyl_pool checks and closes it)
    #[account(mut)] pub posted: UncheckedAccount<'info>,
    /// CHECK: its poster
    #[account(mut)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier1: UncheckedAccount<'info>,
    pub mint_in: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub shield_vault_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_in, associated_token::authority = signer, associated_token::token_program = token_program_in)] pub entry_vault_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_in)] pub fee_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint_out: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint_out, associated_token::authority = signer, associated_token::token_program = token_program_out)] pub entry_vault_out: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub shield_vault_out: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub token_program_out: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
    pub system_program: Program<'info, System>,
    /// CHECK: veyl_pool's event authority PDA ["__event_authority"] (veyl_pool checks its seeds): signs the self-CPI that
    /// carries the tree's events
    pub pool_events: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct ShieldOrder<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut, close = relayer, constraint = buffer.owner == relayer.key() @ EntryError::BadRequest)] pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: veyl_pool's shield
    #[account(mut, address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    /// CHECK: posted transact proof
    #[account(mut)] pub posted: UncheckedAccount<'info>,
    /// CHECK: its poster
    #[account(mut)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier1: UncheckedAccount<'info>,
    #[account(mut)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(address = bin_pool.load()?.mint_x @ EntryError::UnknownToken)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = bin_pool.load()?.mint_y @ EntryError::UnknownToken)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub bin_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub bin_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = signer, associated_token::token_program = token_program_x)] pub entry_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = signer, associated_token::token_program = token_program_y)] pub entry_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub shield_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub fee_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
    pub system_program: Program<'info, System>,
    /// CHECK: veyl_pool's event authority PDA ["__event_authority"] (veyl_pool checks its seeds): signs the self-CPI that
    /// carries the tree's events
    pub pool_events: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct ShieldOrderWithdraw<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut, close = relayer, constraint = buffer.owner == relayer.key() @ EntryError::BadRequest)] pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: veyl_pool's shield
    #[account(mut, address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    /// CHECK: posted transact proof
    #[account(mut)] pub posted: UncheckedAccount<'info>,
    /// CHECK: its poster
    #[account(mut)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier1: UncheckedAccount<'info>,
    #[account(mut)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    #[account(address = bin_pool.load()?.mint_x @ EntryError::UnknownToken)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = bin_pool.load()?.mint_y @ EntryError::UnknownToken)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub bin_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub bin_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_x, associated_token::authority = signer, associated_token::token_program = token_program_x)] pub entry_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_y, associated_token::authority = signer, associated_token::token_program = token_program_y)] pub entry_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub shield_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub shield_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_x)] pub fee_token_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_y)] pub fee_token_y: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    pub veyl_bin: Program<'info, VeylBin>,
    pub system_program: Program<'info, System>,
    /// CHECK: veyl_pool's event authority PDA ["__event_authority"] (veyl_pool checks its seeds): signs the self-CPI that
    /// carries the tree's events
    pub pool_events: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct ShieldMigrate<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA (the processor)
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump, seeds::program = veyl_pool.key())] pub pool: AccountLoader<'info, veyl_pool::Pool>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub spend: Box<Account<'info, veyl_pool::Spend>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = signer, associated_token::token_program = token_program)] pub entry_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint)] pub fee_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: veyl_pool's shield
    #[account(mut, address = shield_pda() @ EntryError::UnknownPool)] pub shield: UncheckedAccount<'info>,
    #[account(mut)] pub shield_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub veyl_pool: Program<'info, VeylPool>,
    /// CHECK: veyl_pool's event authority PDA ["__event_authority"] (veyl_pool checks its seeds): signs the self-CPI that
    /// carries the tree's events
    pub pool_events: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct ShieldReturnRewards<'info> {
    #[account(seeds = [b"entry"], bump = entry.bump)] pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's signer PDA
    #[account(seeds = [b"signer"], bump = entry.signer_bump)] pub signer: UncheckedAccount<'info>,
    #[account(mut)] pub bin_pool: AccountLoader<'info, veyl_bin::BinPool>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the reward vault (veyl_bin checks it)
    #[account(mut)] pub reward_vault: UncheckedAccount<'info>,
    #[account(mut, token::mint = reward_mint)] pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub veyl_bin: Program<'info, VeylBin>,
}

// ------------------------------------------------------------------------------------------------ events / errors

#[event] pub struct Relayed { pub pool: Pubkey, pub recipient: Pubkey, pub value: u64, pub fee: u64 }
#[event] pub struct PrivateSwapped { pub token_in: Pubkey, pub token_out: Pubkey, pub amount_in: u64, pub amount_out: u64, pub fee: u64 }
#[event] pub struct PrivateAdded { pub owner: Pubkey, pub bin_pool: Pubkey, pub ids: Vec<i32>, pub shares: Vec<u128> }
#[event] pub struct PrivateRemoved { pub owner: Pubkey, pub bin_pool: Pubkey, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct PrivateFeesClaimed { pub owner: Pubkey, pub bin_pool: Pubkey, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct PrivateRewardClaimed { pub owner: Pubkey, pub bin_pool: Pubkey, pub index: u8, pub amount: u64 }
#[event] pub struct PrivateOrderPlaced { pub owner: Pubkey, pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub amount: u64, pub shares: u128 }
#[event] pub struct PrivateOrderWithdrawn { pub owner: Pubkey, pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct PrivateRebalanced { pub owner: Pubkey, pub bin_pool: Pubkey, pub burned_x: u64, pub burned_y: u64, pub readded_x: u64, pub readded_y: u64, pub fee_x: u64, pub fee_y: u64 }
#[event] pub struct PrivateZapped { pub owner: Pubkey, pub bin_pool: Pubkey, pub x_in: bool, pub amount_in: u64, pub swap_amount: u64, pub ids: Vec<i32>, pub shares: Vec<u128> }
#[event] pub struct ShieldLpExecuted { pub bin_pool: Pubkey, pub lo: i32, pub deltas: Vec<i128>, pub legs: u8, pub charge: [u64; 2], pub pay: [u64; 2], pub claim_fee: [u64; 2], pub leftover_fee: [u64; 2], pub receipts: [u64; 2], pub nullifier: [u8; 32], pub diluted: [bool; 2] }
#[event] pub struct ShieldSwapped { pub token_in: Pubkey, pub token_out: Pubkey, pub amount_in: u64, pub amount_out: u64, pub fee: u64 }
#[event] pub struct ShieldOrderPlaced { pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub amount: u64, pub shares: u128 }
#[event] pub struct ShieldOrderWithdrawn { pub bin_pool: Pubkey, pub id: i32, pub is_ask: bool, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct Migrated { pub mint: Pubkey, pub amount: u64, pub fee: u64 }
#[event] pub struct ShieldRewardsReturned { pub bin_pool: Pubkey, pub index: u8, pub amount: u64 }
#[event] pub struct Routed { pub sender: Pubkey, pub token_in: Pubkey, pub token_out: Pubkey, pub amount_in: u64, pub amount_out: u64, pub routes: u8 }

#[error_code]
pub enum EntryError {
    #[msg("fee too high")] FeeTooHigh,
    #[msg("unknown pool")] UnknownPool,
    #[msg("unknown token")] UnknownToken,
    #[msg("bad legs")] BadLegs,
    #[msg("amount mismatch")] AmountMismatch,
    #[msg("expired")] Expired,
    #[msg("bad nonce")] BadNonce,
    #[msg("bad signature")] BadSignature,
    #[msg("bad route")] BadRoute,
    #[msg("slippage")] Slippage,
    #[msg("wrong recipient account")] WrongRecipient,
    #[msg("a private add needs min_shares for every bin")] MinSharesRequired,
    #[msg("bad request buffer")] BadRequest,
    #[msg("the window's LpAcc is missing")] MissingLpAcc,
    #[msg("action data mismatch")] BadContext,
    // Phase 3: sealed batches
    #[msg("sealed swaps are paused for this pool")] SealedPaused,
    #[msg("the batch is not open")] BatchNotOpen,
    #[msg("the batch is full in this direction")] BatchFull,
    #[msg("the batch's epoch is not over")] EpochNotOver,
    #[msg("the batch is not closed")] BatchNotClosed,
    #[msg("not a curve point")] BadPoint,
    #[msg("partial decryption refused")] BadShare,
    #[msg("not a committee member")] NotMember,
    #[msg("already verified")] ShareKnown,
    #[msg("fewer verified shares than the threshold")] NotEnoughShares,
    #[msg("wrong batch total")] BadTotal,
    #[msg("nothing to claim in this batch")] NotClaimable,
    #[msg("the price moved too far since the batch closed")] PriceDrift,
    #[msg("the batch is past its settlement window")] SettleTimeout,
    #[msg("bad committee")] BadCommittee,
    #[msg("only the authority")] NotAuthority,
    #[msg("bad parameters")] BadParams,
}
