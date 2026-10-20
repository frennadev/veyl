//! Veyl bin pool on Solana: concentrated liquidity in discrete price bins for one pair. Port of `VeylBinPool.sol` and
//! `VeylFactory.sol`, extended in Phase 1 with Meteora-grade LP mechanics:
//!
//!  - Bin `id` has price  P(id) = basePrice * (1 + binStep/10_000)^id   (tokenY per tokenX, 128.128 fixed point).
//!    The 128.128 price is kept exactly as in Solidity: a 256-bit number; mulDiv uses a 512-bit intermediate, so the
//!    results (including rounding) are bit-identical to OpenZeppelin's Math.mulDiv.
//!  - Token amounts are u64 (SPL), per-bin liquidity and shares are u128 (stored as two u64 words in zero-copy accounts).
//!  - Bins live in `BinArray` PDAs of 60 consecutive ids (`["bins", pool, chunk]`), positions in `ShareAccount` PDAs
//!    (`["shares", pool, owner, authority, chunk]`). `authority` is who may burn / claim / withdraw: the owner itself for
//!    a public LP, the entry program's signer PDA for a private position owned by a one-time key.
//!  - Bitmaps: every bin array keeps one bit per bin per side ("has X to sell", "has Y to sell") and the pool keeps one bit
//!    per bin array per side (2,048 arrays, bins -61,440..61,439). A swap jumps straight to the next bin holding the token
//!    it buys, so empty ranges cost nothing; MAX_STEPS bounds the number of bins actually traded against.
//!  - Fees (Meteora-style): a swap fee is no longer folded into the bin's reserves. Every swap first pays the protocol
//!    fee, a fixed `protocol_fee_bps` (0.2%, copied from the factory when the pool is created, never changed) of the input
//!    amount, rounded up, accounted to the pool's protocol balance. The rest trades through the bins and pays the pool's LP
//!    fee, which goes 100% to liquidity: split between the bin's market-making liquidity (fee growth per share, per token,
//!    claimed with `claim_fees`) and its limit-order liquidity (paid into the order's filled amount), pro rata to what each
//!    sold. Shares of `MIN_LIQUIDITY` (locked forever) are excluded from the per-share division (a fee with no provider to
//!    pay goes to the protocol), so every fee atom ends up claimable or protocol, minus floor rounding left in the vault.
//!  - Listing (permissionless): anyone creates a pool for a canonical pair (mint_x < mint_y) at one of the factory's fee
//!    tiers (bin step + base fee + variable fee control; one pool per pair per tier, fixed forever), paying a refundable
//!    bond (`Bond` PDA, `release_bond` after the lock). The factory authority may delist a pool (`delist_pool`): its bond
//!    goes to the treasury, new liquidity is refused, exits (burn, claims, withdrawals) and swaps keep working.
//!  - Limit orders: single-sided liquidity in one bin away from the active bin, kept apart from market-making liquidity.
//!    When the price crosses the bin the order converts at the bin's price (plus its fee share) and stays converted.
//!  - Farm rewards: up to two reward mints per pool, emitted at a per-second rate to the active bin's shares.
//!  - The volatility accumulator, MIN_LIQUIDITY lock, composition fee on an unbalanced add to the active bin and the
//!    per-bin swap formula are unchanged. Variable-fee units: Veyl's fee is in pips (1e-6) and
//!    variable = (va * binStep)^2 * variable_fee_control / 1e12 (floored), so Meteora's `variable_fee_control` (fee
//!    denominator 1e9, divisor 1e11, ceiling) equals 100 x Veyl's.
#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use anchor_lang::ZeroCopy;
pub mod u512;
pub use u512::U512;

#[cfg(not(feature = "mainnet"))]
declare_id!("6yKrpy8JDoxFfbWdCKUre7Q7PVdvLzmzdSYWa86X4YLk");
#[cfg(feature = "mainnet")]
declare_id!("11111111111111111111111111111111"); // mainnet veyl_bin (npm run keys:mainnet)
#[cfg(all(feature = "mainnet", feature = "devnet-migrate"))]
compile_error!("devnet-migrate is a devnet-only migration: never build it with the mainnet feature");

pub const PIPS: u128 = 1_000_000; // 100%
pub const MAX_FEE: u128 = 100_000; // 10%
pub const FILTER_PERIOD: i64 = 30;
pub const DECAY_PERIOD: i64 = 600;
pub const REDUCTION_BPS: u128 = 5_000;
pub const MAX_VOL_ACC: u128 = 350_000;
/// Bins traded against (holding the token bought) per swap. Empty bins are skipped through the bitmaps and do not count.
pub const MAX_STEPS: usize = 256;
pub const MIN_LIQUIDITY: u128 = 1_000;
pub const BINS_PER_ARRAY: i32 = 60;
pub const CHUNKS: usize = 2_048;
pub const MIN_CHUNK: i32 = -1_024;
pub const BITMAP_WORDS: usize = CHUNKS / 64;
pub const MIN_BIN_ID: i32 = MIN_CHUNK * BINS_PER_ARRAY;
pub const MAX_BIN_ID: i32 = (MIN_CHUNK + CHUNKS as i32) * BINS_PER_ARRAY - 1;
/// Bins per mint / burn / rebalance call: bounded by compute (measured, see DEPLOY.md "Position limits"), not by
/// account size (a position spans as many share accounts as it needs).
pub const MAX_IDS: usize = 70;
pub const BPS: u128 = 10_000;
/// Protocol fee: bps of every swap's input, on top of the LP fee (0.2%). Fixed: set in the factory at init, copied into each pool.
pub const PROTOCOL_FEE_BPS: u16 = 20;
pub const MAX_TIERS: usize = 16;
pub const DEFAULT_BOND_LAMPORTS: u64 = 1_000_000_000; // 1 SOL until the factory authority sets it
pub const DEFAULT_BOND_LOCK: i64 = 30 * 86_400;
pub const MAX_BOND_LOCK: i64 = 365 * 86_400;
pub const NUM_REWARDS: usize = 2;
pub const MAX_REWARD_DURATION: u64 = 31_536_000; // one year

// ------------------------------------------------------------------------------------------------ 256-bit helpers

fn q() -> U512 { U512::one() << 128 }
fn u(x: u128) -> U512 { U512::from(x) }
fn be32(x: U512) -> Result<[u8; 32]> { require!(x.bits() <= 256, BinError::Overflow); let b = x.to_big_endian(); Ok(b[32..].try_into().unwrap()) }
fn from_be32(b: &[u8; 32]) -> U512 { U512::from_big_endian(b) }
fn to_u128(x: U512) -> Result<u128> { require!(x.bits() <= 128, BinError::Overflow); Ok(x.low_u128()) }
fn to_u64(x: U512) -> Result<u64> { require!(x.bits() <= 64, BinError::Overflow); Ok(x.low_u64()) }
/// floor(a * b / c), exact like OpenZeppelin Math.mulDiv (512-bit intermediate; result must fit 256 bits). Dividing by
/// Q = 2^128 (most calls: every 128.128 product) is a right shift, which is the same floor and avoids a 512-bit division.
fn mul_div(a: U512, b: U512, c: U512) -> Result<U512> {
    require!(!c.is_zero() && a.bits() <= 256 && b.bits() <= 256, BinError::Overflow);
    let p = mul_wide(&a, &b);
    let r = if c == q() { p >> 128 } else { p / c }; require!(r.bits() <= 256, BinError::Overflow); Ok(r)
}
/// The exact 512-bit product of two numbers below 2^256 (4 x 4 64-bit limbs, schoolbook): the same value as `a * b`, at a
/// quarter of the cost of the generic 8 x 8-limb multiplication.
fn mul_wide(a: &U512, b: &U512) -> U512 {
    let mut r = [0u64; 8];
    for i in 0..4 {
        let ai = a.0[i] as u128; if ai == 0 { continue; }
        let mut carry: u128 = 0;
        for j in 0..4 { let t = ai * (b.0[j] as u128) + r[i + j] as u128 + carry; r[i + j] = t as u64; carry = t >> 64; }
        r[i + 4] = carry as u64;
    }
    U512(r)
}
fn mul_div_ceil(a: U512, b: U512, c: U512) -> Result<U512> {
    require!(!c.is_zero() && a.bits() <= 256 && b.bits() <= 256, BinError::Overflow);
    let p = mul_wide(&a, &b);
    let r = if c == q() { let r = p >> 128; if !(p - (r << 128)).is_zero() { r + U512::one() } else { r } } else { let r = p / c; if !(p % c).is_zero() { r + U512::one() } else { r } };
    require!(r.bits() <= 256, BinError::Overflow); Ok(r)
}
/// u128 stored as two little-endian u64 words (keeps zero-copy structs 8-byte aligned).
#[inline] pub fn g(v: &[u64; 2]) -> u128 { (v[0] as u128) | ((v[1] as u128) << 64) }
#[inline] pub fn st(v: &mut [u64; 2], x: u128) { v[0] = x as u64; v[1] = (x >> 64) as u64; }
/// Checked add into a stored u128.
fn add_st(v: &mut [u64; 2], x: u128) -> Result<()> { let n = g(v).checked_add(x).ok_or(BinError::Overflow)?; st(v, n); Ok(()) }
/// Wrapping add into a stored growth accumulator (differences of checkpoints stay exact while a period's growth < 2^128).
fn wadd_st(v: &mut [u64; 2], x: u128) { let n = g(v).wrapping_add(x); st(v, n); }
pub fn chunk_of(id: i32) -> i32 { id.div_euclid(BINS_PER_ARRAY) }
pub fn slot_of(id: i32) -> usize { id.rem_euclid(BINS_PER_ARRAY) as usize }
fn add64(a: u64, b: u64) -> Result<u64> { a.checked_add(b).ok_or_else(|| error!(BinError::Overflow)) }
fn sub64(a: u64, b: u64) -> Result<u64> { a.checked_sub(b).ok_or_else(|| error!(BinError::Overflow)) }
/// ceil(amount * bps / 10_000): the protocol fee a swap of `amount` pays (taken from the input before it trades). veyl_entry
/// uses the same function for the matched (netted) part of a sealed batch, paid with `pay_protocol_fee`.
pub fn protocol_fee_of(amount: u64, bps: u16) -> u64 { ((amount as u128 * bps as u128 + BPS - 1) / BPS) as u64 }
/// floor(v * bps / 10_000): what a caller-chosen share (bps) of an amount is.
pub fn bps_of(v: u64, bps: u16) -> u64 { ((v as u128 * bps as u128) / BPS) as u64 }
/// Claimable amount for `shares` between a checkpoint and the current growth (Q64.64 per share, wrapping accumulators).
fn owed(now: u128, cp: u128, shares: u128) -> Result<u64> { let d = now.wrapping_sub(cp); if d == 0 || shares == 0 { return Ok(0); } to_u64(mul_wide(&u(d), &u(shares)) >> 64) }
/// Weights are applied against the active bin at execution: X weights on bins below it and Y weights above it are dropped
/// (a swap, or anyone's trade between signing and execution, may have moved it); `min_shares` per bin guards the value.
pub fn side_weights(ids: &[i32], wx: &[u16], wy: &[u16], active: i32) -> (Vec<u16>, Vec<u16>) {
    (ids.iter().zip(wx).map(|(id, w)| if *id >= active { *w } else { 0 }).collect(), ids.iter().zip(wy).map(|(id, w)| if *id <= active { *w } else { 0 }).collect())
}
/// Split `total` by `weights`; the last weighted entry takes the remainder so the parts sum to exactly `total`.
pub fn distribute(total: u64, weights: &[u16]) -> Result<Vec<u64>> {
    let w: u128 = weights.iter().map(|x| *x as u128).sum();
    if w == 0 { return Ok(vec![0; weights.len()]); }
    let last = weights.iter().rposition(|x| *x > 0).unwrap();
    let mut out = Vec::with_capacity(weights.len()); let mut sum = 0u64;
    for (i, wi) in weights.iter().enumerate() {
        let a = if i == last { sub64(total, sum)? } else { ((total as u128 * *wi as u128) / w) as u64 };
        sum = add64(sum, a)?; out.push(a);
    }
    Ok(out)
}

// ------------------------------------------------------------------------------------------------ program

#[program]
pub mod veyl_bin {
    use super::*;

    /// The factory: its authority manages the fee tiers, the listing bond, delisting and farm rewards; its fee authority
    /// sets the treasury and withdraws protocol fees. EVM: VeylFactory(owner). Only the program's upgrade authority may
    /// create it (REVIEW.md H-1). Both roles start with the creator (also the first treasury); `npm run handover` moves
    /// them to a multisig. Starts with no tier (nobody can list until `add_fee_tier`), a 1 SOL bond and a 30-day lock.
    pub fn init_factory(ctx: Context<InitFactory>) -> Result<()> {
        let f = &mut ctx.accounts.factory; f.authority = ctx.accounts.authority.key(); f.fee_authority = ctx.accounts.authority.key(); f.bump = ctx.bumps.factory;
        f.treasury = ctx.accounts.authority.key(); f.bond_lamports = DEFAULT_BOND_LAMPORTS; f.bond_lock = DEFAULT_BOND_LOCK; f.protocol_fee_bps = PROTOCOL_FEE_BPS; Ok(())
    }
    /// Approve a fee tier (factory authority). Each tier has its own bin step (the pool address includes it: one pool per
    /// pair per tier). Tiers are never removed or changed, only disabled for new pools; existing pools keep their fees.
    pub fn add_fee_tier(ctx: Context<FactoryAuthority>, bin_step: u16, base_fee: u32, variable_fee_control: u64) -> Result<()> {
        let f = &mut ctx.accounts.factory; let n = f.num_tiers as usize;
        require!(n < MAX_TIERS && bin_step > 0 && bin_step <= 500 && (base_fee as u128) <= MAX_FEE, BinError::BadParams);
        require!(!f.tiers[..n].iter().any(|t| t.bin_step == bin_step), BinError::BadParams);
        f.tiers[n] = FeeTier { bin_step, base_fee, variable_fee_control, enabled: 1 }; f.num_tiers += 1;
        emit!(FeeTierAdded { index: n as u8, bin_step, base_fee, variable_fee_control }); Ok(())
    }
    /// Enable / disable a tier for new pools (factory authority). Pools already created at it are not affected.
    pub fn set_fee_tier_enabled(ctx: Context<FactoryAuthority>, index: u8, enabled: bool) -> Result<()> {
        let f = &mut ctx.accounts.factory; require!((index as usize) < f.num_tiers as usize, BinError::BadTier);
        f.tiers[index as usize].enabled = enabled as u8; emit!(FeeTierSet { index, enabled }); Ok(())
    }
    /// The listing bond (lamports) and how long it stays locked (seconds), for pools created from now on (factory authority).
    pub fn set_bond(ctx: Context<FactoryAuthority>, lamports: u64, lock_seconds: i64) -> Result<()> {
        require!((0..=MAX_BOND_LOCK).contains(&lock_seconds), BinError::BadParams);
        let f = &mut ctx.accounts.factory; f.bond_lamports = lamports; f.bond_lock = lock_seconds;
        emit!(BondSet { lamports, lock_seconds }); Ok(())
    }
    /// Where forfeited bonds go (fee authority).
    pub fn set_treasury(ctx: Context<FeeAuthority>, treasury: Pubkey) -> Result<()> {
        require!(treasury != Pubkey::default(), BinError::BadParams);
        ctx.accounts.factory.treasury = treasury; emit!(TreasurySet { treasury }); Ok(())
    }
    pub fn propose_factory_authority(ctx: Context<FactoryAuthority>, next: Pubkey) -> Result<()> { ctx.accounts.factory.pending_authority = next; Ok(()) }
    pub fn accept_factory_authority(ctx: Context<AcceptFactoryAuthority>) -> Result<()> {
        let f = &mut ctx.accounts.factory; require_keys_eq!(f.pending_authority, ctx.accounts.next.key(), BinError::NotAuthority);
        f.authority = ctx.accounts.next.key(); f.pending_authority = Pubkey::default(); Ok(())
    }
    /// Two-step transfer of the protocol fee authority.
    pub fn propose_fee_authority(ctx: Context<FeeAuthority>, next: Pubkey) -> Result<()> { ctx.accounts.factory.pending_fee_authority = next; Ok(()) }
    pub fn accept_fee_authority(ctx: Context<AcceptFactoryAuthority>) -> Result<()> {
        let f = &mut ctx.accounts.factory; require_keys_eq!(f.pending_fee_authority, ctx.accounts.next.key(), BinError::NotAuthority);
        f.fee_authority = ctx.accounts.next.key(); f.pending_fee_authority = Pubkey::default();
        emit!(FeeAuthoritySet { fee_authority: f.fee_authority }); Ok(())
    }

    /// List a pool (anyone). The pair must be canonical (mint_x < mint_y, by bytes: A/B and B/A cannot both exist), both
    /// mints SPL Token or Token-2022 without a transfer-altering extension (`check_mint`), and `tier` an enabled factory
    /// tier, which fixes the pool's bin step and fees forever. The creator pays the factory's bond into the pool's `Bond`
    /// PDA (reclaimed with `release_bond` after the lock); the factory authority lists with a zero bond (the curated
    /// pools of the deploy). `base_price` is the 128.128 price at bin 0, as 32 big-endian bytes. EVM: VeylFactory.createPool.
    pub fn create_pool(ctx: Context<CreatePool>, tier: u8, base_price: [u8; 32], active_id: i32) -> Result<()> {
        let f = &ctx.accounts.factory; let t = f.tier(tier)?;
        require!(ctx.accounts.mint_x.key() < ctx.accounts.mint_y.key(), BinError::MintOrder);
        require!(from_be32(&base_price) != U512::zero() && (MIN_BIN_ID..=MAX_BIN_ID).contains(&active_id), BinError::BadParams);
        check_mint(&ctx.accounts.mint_x.to_account_info())?; check_mint(&ctx.accounts.mint_y.to_account_info())?;
        {
            let mut p = ctx.accounts.pool.load_init()?;
            p.factory = f.key(); p.mint_x = ctx.accounts.mint_x.key(); p.mint_y = ctx.accounts.mint_y.key();
            p.vault_x = ctx.accounts.vault_x.key(); p.vault_y = ctx.accounts.vault_y.key();
            p.token_program_x = ctx.accounts.token_program_x.key(); p.token_program_y = ctx.accounts.token_program_y.key();
            p.bin_step = t.bin_step; p.base_fee = t.base_fee; p.variable_fee_control = t.variable_fee_control; p.base_price = base_price;
            p.step_q = be32(q() + (q() * u(t.bin_step as u128)) / u(10_000))?; /* (1 + binStep/1e4) in 128.128 */
            p.active_id = active_id; p.id_ref = active_id; p.bump = ctx.bumps.pool; p.protocol_fee_bps = f.protocol_fee_bps; p.fee_tier = tier;
        }
        let now = Clock::get()?.unix_timestamp; let creator = ctx.accounts.creator.key();
        let amount = if creator == f.authority { 0 } else { f.bond_lamports };
        let unlock_at = now.saturating_add(f.bond_lock);
        { let b = &mut ctx.accounts.bond; b.pool = ctx.accounts.pool.key(); b.creator = creator; b.amount = amount; b.created_at = now; b.unlock_at = unlock_at; b.bump = ctx.bumps.bond; }
        if amount > 0 {
            anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), anchor_lang::system_program::Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.bond.to_account_info() }), amount)?;
        }
        emit!(PoolCreated { pool: ctx.accounts.pool.key(), mint_x: ctx.accounts.mint_x.key(), mint_y: ctx.accounts.mint_y.key(), bin_step: t.bin_step, base_fee: t.base_fee, tier, creator, bond: amount, unlock_at });
        Ok(())
    }
    /// The creator takes the bond back (with the bond account's rent) once its lock has passed, unless the pool was delisted.
    pub fn release_bond(ctx: Context<ReleaseBond>) -> Result<()> {
        require!(ctx.accounts.pool.load()?.delisted == 0, BinError::Delisted);
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.bond.unlock_at, BinError::BondLocked);
        emit!(BondReleased { pool: ctx.accounts.pool.key(), creator: ctx.accounts.creator.key(), amount: ctx.accounts.bond.amount }); Ok(())
    }
    /// Delist a pool (factory authority): its bond account (bond + rent), if not released yet, goes to the treasury. A
    /// delisted pool refuses new liquidity (mint, mint_exact, swap_and_add, limit orders, re-adds of a rebalance); burns,
    /// fee / reward claims, limit-order withdrawals and swaps keep working, so LPs can always exit at a sane price.
    pub fn delist_pool(ctx: Context<DelistPool>) -> Result<()> {
        { let mut p = ctx.accounts.pool.load_mut()?; require!(p.delisted == 0, BinError::Delisted); p.delisted = 1; }
        let bi = ctx.accounts.bond.to_account_info(); let mut forfeited = 0u64;
        if bi.owner == &crate::ID && !bi.data_is_empty() {
            forfeited = Bond::try_deserialize(&mut &bi.try_borrow_data()?[..])?.amount;
            let t = ctx.accounts.treasury.to_account_info(); let all = bi.lamports();
            **t.try_borrow_mut_lamports()? = t.lamports().checked_add(all).ok_or(BinError::Overflow)?; **bi.try_borrow_mut_lamports()? = 0;
            bi.assign(&anchor_lang::system_program::ID); bi.resize(0)?;
        }
        emit!(PoolDelisted { pool: ctx.accounts.pool.key(), forfeited }); Ok(())
    }

    // ---------------------------------------------------------------------------------------- devnet-only one-off migration
    // Built only with `--features devnet-migrate` (scripts/build.sh dev profile), never in the mainnet profile: they upgrade
    // the devnet deployment made before permissionless pools in place (scripts/migrate-devnet.js).

    /// Grow the ["factory"] PDA from its pre-tier layout (OLD_FACTORY_SIZE: discriminator, authority, pending_authority, bump,
    /// fee_authority, pending_fee_authority) to `Factory::SIZE` (the authority pays the extra rent), keep every old field and
    /// initialise the new ones: treasury = authority, 1 SOL bond, 30-day lock, 0.2% protocol fee, no tier. Factory authority
    /// only; refused once the account already has the new size.
    #[cfg(feature = "devnet-migrate")]
    pub fn migrate_factory(ctx: Context<MigrateFactory>) -> Result<()> {
        let fi = ctx.accounts.factory.to_account_info(); let auth = ctx.accounts.authority.key();
        require_keys_eq!(*fi.owner, crate::ID, BinError::WrongPool);
        {
            let d = fi.try_borrow_data()?;
            require!(d.len() == OLD_FACTORY_SIZE, BinError::BadParams);
            require!(&d[..8] == Factory::DISCRIMINATOR, BinError::BadParams);
            require!(d[8..40] == auth.to_bytes(), BinError::NotAuthority);
        }
        let need = Rent::get()?.minimum_balance(Factory::SIZE).saturating_sub(fi.lamports());
        if need > 0 {
            anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), anchor_lang::system_program::Transfer { from: ctx.accounts.authority.to_account_info(), to: fi.clone() }), need)?;
        }
        fi.resize(Factory::SIZE)?;
        {
            let mut d = fi.try_borrow_mut_data()?; let t = &mut d[OLD_FACTORY_SIZE..]; t.fill(0);
            t[0..32].copy_from_slice(auth.as_ref());
            t[32..40].copy_from_slice(&DEFAULT_BOND_LAMPORTS.to_le_bytes());
            t[40..48].copy_from_slice(&DEFAULT_BOND_LOCK.to_le_bytes());
            t[48..50].copy_from_slice(&PROTOCOL_FEE_BPS.to_le_bytes());
        }
        let f = Factory::try_deserialize(&mut &fi.try_borrow_data()?[..])?;
        require!(f.authority == auth && f.treasury == auth && f.protocol_fee_bps == PROTOCOL_FEE_BPS && f.num_tiers == 0, BinError::BadParams);
        msg!("factory migrated: {} -> {} bytes, {} lamports added", OLD_FACTORY_SIZE, Factory::SIZE, need); Ok(())
    }
    /// Bring one pool created before permissionless pools to the new rules: protocol fee 0.2% (overwrites the old
    /// `protocol_share` bytes), listed, `fee_tier` = the enabled factory tier with the pool's bin step (refused if none), and
    /// that tier's base fee and variable fee control. Idempotent: a pool already on the new rules keeps its tier and its
    /// delisted flag. Factory authority only; refused while the factory has its old layout (it does not deserialize).
    #[cfg(feature = "devnet-migrate")]
    pub fn migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
        let f = &ctx.accounts.factory; let n = f.num_tiers as usize; let mut p = ctx.accounts.pool.load_mut()?;
        let migrated = p.protocol_fee_bps == PROTOCOL_FEE_BPS;
        let keep = migrated && (p.fee_tier as usize) < n && f.tiers[p.fee_tier as usize].bin_step == p.bin_step;
        let i = if keep { p.fee_tier as usize } else { f.tiers[..n].iter().position(|t| t.enabled == 1 && t.bin_step == p.bin_step).ok_or(BinError::BadTier)? };
        let t = f.tiers[i];
        if !migrated { p.delisted = 0; p._pad = [0; 4]; }
        p.protocol_fee_bps = PROTOCOL_FEE_BPS; p.fee_tier = i as u8; p.base_fee = t.base_fee; p.variable_fee_control = t.variable_fee_control;
        msg!("pool migrated: tier {} (bin step {}, base fee {}, vfc {})", i, t.bin_step, t.base_fee, t.variable_fee_control); Ok(())
    }

    /// Storage for 60 bins (rent paid by whoever needs them first).
    pub fn init_bin_array(ctx: Context<InitBinArray>, chunk: i32) -> Result<()> {
        require!(chunk >= MIN_CHUNK && chunk < MIN_CHUNK + CHUNKS as i32, BinError::BadParams);
        let mut a = ctx.accounts.bins.load_init()?; a.pool = ctx.accounts.pool.key(); a.chunk = chunk; Ok(())
    }
    /// Position bookkeeping for one owner over 60 bins. `authority` is who may burn, claim and withdraw.
    pub fn init_shares(ctx: Context<InitShares>, owner: Pubkey, authority: Pubkey, chunk: i32) -> Result<()> {
        require!(chunk >= MIN_CHUNK && chunk < MIN_CHUNK + CHUNKS as i32, BinError::BadParams);
        let mut s = ctx.accounts.shares.load_init()?; s.pool = ctx.accounts.pool.key(); s.owner = owner; s.authority = authority; s.chunk = chunk; Ok(())
    }

    /// Add liquidity bin by bin. Shares are credited to the (owner, authority) share accounts passed as remaining
    /// accounts, together with the bin arrays (and the active bin's array when a bin is the active one). `min_shares`
    /// empty = no check. EVM: mint.
    pub fn mint<'info>(ctx: Context<'_, '_, 'info, 'info, MintLiquidity<'info>>, owner: Pubkey, authority: Pubkey, ids: Vec<i32>, amounts_x: Vec<u64>, amounts_y: Vec<u64>, min_shares: Vec<u128>, deadline: i64) -> Result<Vec<u128>> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= deadline, BinError::Expired);
        let n = ids.len();
        require!(n > 0 && n <= MAX_IDS && amounts_x.len() == n && amounts_y.len() == n && (min_shares.is_empty() || min_shares.len() == n), BinError::BadParams);
        let pool_key = ctx.accounts.pool.key(); listed(&ctx.accounts.pool)?;
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, authority)))?;
        let active = ctx.accounts.pool.load()?.active_id;
        if ids.contains(&active) { update_active(&ctx.accounts.pool, &acc, &pool_key, now, true)?; }
        let minted = mint_inner(&ctx.accounts.pool, &acc, &ids, &amounts_x, &amounts_y, &min_shares, false, now)?;
        let (mut total_x, mut total_y) = (0u64, 0u64);
        for i in 0..n { total_x = add64(total_x, amounts_x[i])?; total_y = add64(total_y, amounts_y[i])?; }
        if total_x > 0 { pull(&ctx.accounts.token_program_x, &ctx.accounts.from_x, &ctx.accounts.mint_x, &ctx.accounts.vault_x, &ctx.accounts.from, total_x)?; }
        if total_y > 0 { pull(&ctx.accounts.token_program_y, &ctx.accounts.from_y, &ctx.accounts.mint_y, &ctx.accounts.vault_y, &ctx.accounts.from, total_y)?; }
        emit!(Minted { pool: pool_key, sender: ctx.accounts.from.key(), owner, ids, amounts_x, amounts_y, shares: minted.clone() });
        Ok(minted)
    }

    /// Remove liquidity: the share of each bin's reserves to `to_x` / `to_y`. Signed by the share authority. Fees earned
    /// are not paid here; they stay claimable (`claim_fees`). EVM: burn.
    pub fn burn<'info>(ctx: Context<'_, '_, 'info, 'info, BurnLiquidity<'info>>, owner: Pubkey, ids: Vec<i32>, shares_in: Vec<u128>) -> Result<(u64, u64)> {
        let n = ids.len();
        require!(n > 0 && n <= MAX_IDS && shares_in.len() == n, BinError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, ctx.accounts.authority.key())))?;
        let active = ctx.accounts.pool.load()?.active_id;
        if ids.contains(&active) { update_active(&ctx.accounts.pool, &acc, &pool_key, now, true)?; }
        let (amount_x, amount_y) = burn_inner(&ctx.accounts.pool, &acc, &ids, &shares_in)?;
        pay_xy(&ctx.accounts.pool, &ctx.accounts.token_program_x, &ctx.accounts.token_program_y, &ctx.accounts.vault_x, &ctx.accounts.vault_y, &ctx.accounts.mint_x, &ctx.accounts.mint_y, &ctx.accounts.to_x, &ctx.accounts.to_y, amount_x, amount_y)?;
        emit!(Burned { pool: pool_key, authority: ctx.accounts.authority.key(), owner, ids, shares: shares_in, amount_x, amount_y });
        Ok((amount_x, amount_y))
    }

    /// Swap `amount_in` of one side for the other, from the active bin, jumping over empty ranges. Bin arrays as remaining
    /// accounts: the active bin's (initialised or not) and those holding the token bought.
    pub fn swap<'info>(ctx: Context<'_, '_, 'info, 'info, Swap<'info>>, x_for_y: bool, amount_in: u64, min_out: u64) -> Result<u64> {
        require!(amount_in > 0, BinError::BadParams);
        let pool_key = ctx.accounts.pool.key();
        let now = Clock::get()?.unix_timestamp;
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, None)?;
        let (tin, tout, min_in, min_out_, vin, vout, tp_in, tp_out) = if x_for_y {
            (&ctx.accounts.user_in, &ctx.accounts.user_out, &ctx.accounts.mint_x, &ctx.accounts.mint_y, &ctx.accounts.vault_x, &ctx.accounts.vault_y, &ctx.accounts.token_program_x, &ctx.accounts.token_program_y)
        } else {
            (&ctx.accounts.user_in, &ctx.accounts.user_out, &ctx.accounts.mint_y, &ctx.accounts.mint_x, &ctx.accounts.vault_y, &ctx.accounts.vault_x, &ctx.accounts.token_program_y, &ctx.accounts.token_program_x)
        };
        require!(tin.mint == min_in.key() && tout.mint == min_out_.key(), BinError::WrongMint);
        pull(tp_in, tin, min_in, vin, &ctx.accounts.user, amount_in)?;
        let r = swap_inner(&ctx.accounts.pool, &acc, &pool_key, x_for_y, amount_in, now)?;
        require!(r.out >= min_out, BinError::Slippage);
        let seeds_owned = pool_seeds(&ctx.accounts.pool)?; let seeds = seeds_ref(&seeds_owned);
        push(tp_out, vout, min_out_, tout, &ctx.accounts.pool.to_account_info(), &seeds, r.out)?;
        emit!(Swapped { pool: pool_key, sender: ctx.accounts.user.key(), to: tout.key(), x_for_y, amount_in, amount_out: r.out, fee: r.fee, active_id: r.end_id, protocol_fee: r.protocol_fee });
        Ok(r.out)
    }

    /// Exact result of a swap right now (for `simulateTransaction`): returns (amountOut, fee, endId). EVM: quote.
    pub fn quote<'info>(ctx: Context<'_, '_, 'info, 'info, Quote<'info>>, x_for_y: bool, amount_in: u64) -> Result<(u64, u64, i32)> {
        let acc = find_accounts(ctx.remaining_accounts, &ctx.accounts.pool.key(), None)?;
        let p = ctx.accounts.pool.load()?; let r = simulate(&p, &acc.arrays, x_for_y, amount_in, Clock::get()?.unix_timestamp)?;
        Ok((r.out, r.fee, r.end_id))
    }

    /// Pay out the swap fees a position has earned in `ids` (plus anything already settled into its share accounts) to
    /// `to_x` / `to_y`. Signed by the share authority (the owner, or the entry's signer PDA for a private position).
    pub fn claim_fees<'info>(ctx: Context<'_, '_, 'info, 'info, BurnLiquidity<'info>>, owner: Pubkey, ids: Vec<i32>) -> Result<(u64, u64)> {
        require!(ids.len() <= MAX_IDS, BinError::BadParams);
        let pool_key = ctx.accounts.pool.key();
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, ctx.accounts.authority.key())))?;
        require!(!acc.shares.is_empty(), BinError::MissingShareAccount);
        settle_ids(&acc, &ids)?;
        let (mut fx, mut fy) = (0u64, 0u64);
        for s in &acc.shares { let mut sa = s.loader.load_mut()?; fx = add64(fx, sa.pending_fee_x)?; fy = add64(fy, sa.pending_fee_y)?; sa.pending_fee_x = 0; sa.pending_fee_y = 0; }
        pay_xy(&ctx.accounts.pool, &ctx.accounts.token_program_x, &ctx.accounts.token_program_y, &ctx.accounts.vault_x, &ctx.accounts.vault_y, &ctx.accounts.mint_x, &ctx.accounts.mint_y, &ctx.accounts.to_x, &ctx.accounts.to_y, fx, fy)?;
        emit!(FeesClaimed { pool: pool_key, authority: ctx.accounts.authority.key(), owner, ids, amount_x: fx, amount_y: fy });
        Ok((fx, fy))
    }

    /// Pay out farm reward `index` earned by a position in `ids`. Signed by the share authority.
    pub fn claim_reward<'info>(ctx: Context<'_, '_, 'info, 'info, ClaimReward<'info>>, owner: Pubkey, index: u8, ids: Vec<i32>) -> Result<u64> {
        let i = index as usize; require!(i < NUM_REWARDS && ids.len() <= MAX_IDS, BinError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, ctx.accounts.authority.key())))?;
        require!(!acc.shares.is_empty(), BinError::MissingShareAccount);
        update_active(&ctx.accounts.pool, &acc, &pool_key, now, false)?;
        settle_ids(&acc, &ids)?;
        let mut amt = 0u64;
        for s in &acc.shares { let mut sa = s.loader.load_mut()?; amt = add64(amt, sa.pending_reward[i])?; sa.pending_reward[i] = 0; }
        if amt > 0 {
            let seeds_owned = pool_seeds(&ctx.accounts.pool)?; let seeds = seeds_ref(&seeds_owned);
            push(&ctx.accounts.token_program, &ctx.accounts.reward_vault, &ctx.accounts.reward_mint, &ctx.accounts.to, &ctx.accounts.pool.to_account_info(), &seeds, amt)?;
        }
        emit!(RewardClaimed { pool: pool_key, authority: ctx.accounts.authority.key(), owner, index, ids, amount: amt });
        Ok(amt)
    }

    /// Place a limit order: `amount` of X above the active bin (an ask, filled when the price rises through `id`) or of Y
    /// below it (a bid). `is_ask` must match the side, which is the slippage guard: if the active bin moved across `id`
    /// first, the placement fails instead of filling at once. Returns the order shares credited to (owner, authority).
    pub fn place_limit_order<'info>(ctx: Context<'_, '_, 'info, 'info, MintLiquidity<'info>>, owner: Pubkey, authority: Pubkey, id: i32, is_ask: bool, amount: u64, deadline: i64) -> Result<u128> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= deadline, BinError::Expired);
        require!(amount > 0 && (MIN_BIN_ID..=MAX_BIN_ID).contains(&id), BinError::BadParams);
        let pool_key = ctx.accounts.pool.key(); listed(&ctx.accounts.pool)?;
        let (active, base_price, step_q) = { let p = ctx.accounts.pool.load()?; (p.active_id, p.base_price, p.step_q) };
        require!((is_ask && id > active) || (!is_ask && id < active), BinError::WrongSide);
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, authority)))?;
        let arr = find(&acc.arrays, chunk_of(id))?; let sh = find_sh(&acc.shares, chunk_of(id))?; let s = slot_of(id);
        let price = price_of(&base_price, &step_q, id)?;
        let minted = {
            let mut bins = arr.loader.load_mut()?; let b = &mut bins.bins[s];
            let (supply, unfilled, filled) = if is_ask { (g(&b.ask_shares), b.ask_x, b.ask_filled_y) } else { (g(&b.bid_shares), b.bid_y, b.bid_filled_x) };
            // value of the order pool in the order's token, the filled side converted at this bin's (fixed) price
            let filled_conv = if is_ask { mul_div(u(filled as u128), q(), price)? } else { mul_div(u(filled as u128), price, q())? };
            let value = u(unfilled as u128) + filled_conv;
            let shares = if supply == 0 { amount as u128 } else { require!(!value.is_zero(), BinError::ZeroShares); to_u128(mul_div(u(amount as u128), u(supply), value)?)? };
            require!(shares > 0, BinError::ZeroShares);
            let ns = supply.checked_add(shares).ok_or(BinError::Overflow)?;
            if is_ask { b.ask_x = add64(b.ask_x, amount)?; st(&mut b.ask_shares, ns); } else { b.bid_y = add64(b.bid_y, amount)?; st(&mut b.bid_shares, ns); }
            bins.refresh(s);
            let mut sa = sh.loader.load_mut()?; let slot = &mut sa.slots[s];
            if is_ask { add_st(&mut slot.ask_shares, shares)?; } else { add_st(&mut slot.bid_shares, shares)?; }
            shares
        };
        { let mut p = ctx.accounts.pool.load_mut()?; sync_chunks(&mut p, &acc.arrays, &[chunk_of(id)])?; p.extend_range(id, id); }
        if is_ask { pull(&ctx.accounts.token_program_x, &ctx.accounts.from_x, &ctx.accounts.mint_x, &ctx.accounts.vault_x, &ctx.accounts.from, amount)?; }
        else { pull(&ctx.accounts.token_program_y, &ctx.accounts.from_y, &ctx.accounts.mint_y, &ctx.accounts.vault_y, &ctx.accounts.from, amount)?; }
        emit!(LimitOrderPlaced { pool: pool_key, sender: ctx.accounts.from.key(), owner, id, is_ask, amount, shares: minted });
        Ok(minted)
    }

    /// Withdraw (cancel, or collect after a fill) `shares` of a limit order: the unfilled part in the order's token and the
    /// filled part (converted, plus its fee share) in the other token. Signed by the share authority. Returns (x, y).
    pub fn withdraw_limit_order<'info>(ctx: Context<'_, '_, 'info, 'info, BurnLiquidity<'info>>, owner: Pubkey, id: i32, is_ask: bool, shares: u128) -> Result<(u64, u64)> {
        let pool_key = ctx.accounts.pool.key();
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, ctx.accounts.authority.key())))?;
        let arr = find(&acc.arrays, chunk_of(id))?; let sh = find_sh(&acc.shares, chunk_of(id))?; let s = slot_of(id);
        let (out_x, out_y, unfilled_left) = {
            let mut sa = sh.loader.load_mut()?; let slot = &mut sa.slots[s];
            let mine = if is_ask { g(&slot.ask_shares) } else { g(&slot.bid_shares) };
            require!(shares > 0 && shares <= mine, BinError::NotEnoughShares);
            if is_ask { st(&mut slot.ask_shares, mine - shares); } else { st(&mut slot.bid_shares, mine - shares); }
            let mut bins = arr.loader.load_mut()?; let b = &mut bins.bins[s];
            let supply = if is_ask { g(&b.ask_shares) } else { g(&b.bid_shares) };
            let (unfilled, filled) = if is_ask { (b.ask_x, b.ask_filled_y) } else { (b.bid_y, b.bid_filled_x) };
            let ou = to_u64(mul_div(u(unfilled as u128), u(shares), u(supply))?)?; let of = to_u64(mul_div(u(filled as u128), u(shares), u(supply))?)?;
            let r = if is_ask { b.ask_x -= ou; b.ask_filled_y -= of; st(&mut b.ask_shares, supply - shares); (ou, of, b.ask_x) }
                    else { b.bid_y -= ou; b.bid_filled_x -= of; st(&mut b.bid_shares, supply - shares); (of, ou, b.bid_y) };
            bins.refresh(s); r
        };
        { let mut p = ctx.accounts.pool.load_mut()?; sync_chunks(&mut p, &acc.arrays, &[chunk_of(id)])?; }
        pay_xy(&ctx.accounts.pool, &ctx.accounts.token_program_x, &ctx.accounts.token_program_y, &ctx.accounts.vault_x, &ctx.accounts.vault_y, &ctx.accounts.mint_x, &ctx.accounts.mint_y, &ctx.accounts.to_x, &ctx.accounts.to_y, out_x, out_y)?;
        emit!(LimitOrderWithdrawn { pool: pool_key, authority: ctx.accounts.authority.key(), owner, id, is_ask, shares, amount_x: out_x, amount_y: out_y, unfilled_left });
        Ok((out_x, out_y))
    }

    /// Move a position in one instruction: burn `burn_shares` of `burn_ids`, withhold `withhold_bps` of the proceeds (the
    /// entry program uses it for the relayer fee; public callers pass 0), and re-add the rest to `ids` split by
    /// `weights_x` / `weights_y` (applied against the active bin at execution: X only at or above it, Y only at or below;
    /// weights on the wrong side are dropped). A side left with no weight is paid out with the withheld part to `to_x` / `to_y`. `min_shares` per new bin bounds slippage. Signed by the
    /// share authority; fees earned so far stay claimable.
    pub fn rebalance_position<'info>(ctx: Context<'_, '_, 'info, 'info, BurnLiquidity<'info>>, owner: Pubkey, burn_ids: Vec<i32>, burn_shares: Vec<u128>, ids: Vec<i32>, weights_x: Vec<u16>, weights_y: Vec<u16>, min_shares: Vec<u128>, withhold_bps: u16, deadline: i64) -> Result<RebalanceResult> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= deadline, BinError::Expired);
        let n = ids.len();
        require!(!burn_ids.is_empty() && burn_ids.len() <= MAX_IDS && burn_shares.len() == burn_ids.len() && n <= MAX_IDS && weights_x.len() == n && weights_y.len() == n && (min_shares.is_empty() || min_shares.len() == n) && (withhold_bps as u128) <= BPS, BinError::BadParams);
        let pool_key = ctx.accounts.pool.key(); let authority = ctx.accounts.authority.key();
        if n > 0 { listed(&ctx.accounts.pool)?; }
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, authority)))?;
        let active = ctx.accounts.pool.load()?.active_id;
        if burn_ids.contains(&active) || ids.contains(&active) { update_active(&ctx.accounts.pool, &acc, &pool_key, now, true)?; }
        let (ox, oy) = burn_inner(&ctx.accounts.pool, &acc, &burn_ids, &burn_shares)?;
        let (wx, wy) = (bps_of(ox, withhold_bps), bps_of(oy, withhold_bps));
        let (ax, ay) = (ox - wx, oy - wy);
        let (weights_x, weights_y) = side_weights(&ids, &weights_x, &weights_y, active);
        let has_wx = weights_x.iter().any(|w| *w > 0); let has_wy = weights_y.iter().any(|w| *w > 0);
        let dx = if has_wx { distribute(ax, &weights_x)? } else { vec![0; n] }; let dy = if has_wy { distribute(ay, &weights_y)? } else { vec![0; n] };
        let shares = if n > 0 { mint_inner(&ctx.accounts.pool, &acc, &ids, &dx, &dy, &min_shares, true, now)? } else { vec![] };
        let (rx, ry) = (if has_wx { ax } else { 0 }, if has_wy { ay } else { 0 });
        pay_xy(&ctx.accounts.pool, &ctx.accounts.token_program_x, &ctx.accounts.token_program_y, &ctx.accounts.vault_x, &ctx.accounts.vault_y, &ctx.accounts.mint_x, &ctx.accounts.mint_y, &ctx.accounts.to_x, &ctx.accounts.to_y, ox - rx, oy - ry)?;
        let res = RebalanceResult { burned_x: ox, burned_y: oy, withheld_x: wx, withheld_y: wy, readded_x: rx, readded_y: ry };
        emit!(Rebalanced { pool: pool_key, authority, owner, burned_x: ox, burned_y: oy, withheld_x: wx, withheld_y: wy, readded_x: rx, readded_y: ry, ids, shares });
        Ok(res)
    }

    /// Zap in: one token in, part of it swapped through this pool for the other side (`swap_amount`, at least
    /// `min_swap_out` back), then everything added to `ids` split by weights (against the active bin after the swap), with
    /// `min_shares` per bin. The bin arrays for
    /// the swap path and for the new bins, and the share accounts, as remaining accounts.
    pub fn swap_and_add<'info>(ctx: Context<'_, '_, 'info, 'info, MintLiquidity<'info>>, owner: Pubkey, authority: Pubkey, x_in: bool, amount_in: u64, swap_amount: u64, min_swap_out: u64, ids: Vec<i32>, weights_x: Vec<u16>, weights_y: Vec<u16>, min_shares: Vec<u128>, deadline: i64) -> Result<Vec<u128>> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= deadline, BinError::Expired);
        let n = ids.len();
        require!(n > 0 && n <= MAX_IDS && weights_x.len() == n && weights_y.len() == n && (min_shares.is_empty() || min_shares.len() == n) && amount_in > 0 && swap_amount <= amount_in, BinError::BadParams);
        let pool_key = ctx.accounts.pool.key(); listed(&ctx.accounts.pool)?;
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, authority)))?;
        if x_in { pull(&ctx.accounts.token_program_x, &ctx.accounts.from_x, &ctx.accounts.mint_x, &ctx.accounts.vault_x, &ctx.accounts.from, amount_in)?; }
        else { pull(&ctx.accounts.token_program_y, &ctx.accounts.from_y, &ctx.accounts.mint_y, &ctx.accounts.vault_y, &ctx.accounts.from, amount_in)?; }
        let mut out = 0u64;
        if swap_amount > 0 {
            // the swap's output never leaves the vault: it is added to the new bins below
            let r = swap_inner(&ctx.accounts.pool, &acc, &pool_key, x_in, swap_amount, now)?;
            require!(r.out >= min_swap_out, BinError::Slippage);
            out = r.out;
            emit!(Swapped { pool: pool_key, sender: ctx.accounts.from.key(), to: pool_key, x_for_y: x_in, amount_in: swap_amount, amount_out: r.out, fee: r.fee, active_id: r.end_id, protocol_fee: r.protocol_fee });
        }
        let (tx, ty) = if x_in { (amount_in - swap_amount, out) } else { (out, amount_in - swap_amount) };
        let active = ctx.accounts.pool.load()?.active_id; // after the swap
        let (weights_x, weights_y) = side_weights(&ids, &weights_x, &weights_y, active);
        let has_wx = weights_x.iter().any(|w| *w > 0); let has_wy = weights_y.iter().any(|w| *w > 0);
        require!((tx == 0 || has_wx) && (ty == 0 || has_wy), BinError::BadParams);
        let dx = distribute(tx, &weights_x)?; let dy = distribute(ty, &weights_y)?;
        if ids.contains(&active) { update_active(&ctx.accounts.pool, &acc, &pool_key, now, true)?; }
        let shares = mint_inner(&ctx.accounts.pool, &acc, &ids, &dx, &dy, &min_shares, true, now)?;
        emit!(ZapAdded { pool: pool_key, sender: ctx.accounts.from.key(), owner, x_in, amount_in, swap_amount, swap_out: out, ids, shares: shares.clone() });
        Ok(shares)
    }


    // ---------------------------------------------------------------------------------------- Phase 2: shielded liquidity

    /// Mint exactly `shares[i]` in each bin, for the shielded aggregate (or anyone). A bin that has liquidity takes
    /// ceil(shares * reserve / supply) of each token (its own composition: no composition fee, and the depositor never pays
    /// less than the shares are worth); an empty bin takes `hint_x[i]` / `hint_y[i]` and must give exactly `shares[i]`
    /// (the first deposit's formula). Spends at most `max_x` / `max_y` from `from`. Returns (x, y) taken. A shielded position
    /// proves its new share counts before it executes, which is why it mints shares rather than amounts.
    pub fn mint_exact<'info>(ctx: Context<'_, '_, 'info, 'info, MintLiquidity<'info>>, owner: Pubkey, authority: Pubkey, ids: Vec<i32>, shares: Vec<u128>, hint_x: Vec<u64>, hint_y: Vec<u64>, max_x: u64, max_y: u64, deadline: i64) -> Result<(u64, u64)> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= deadline, BinError::Expired);
        let n = ids.len();
        require!(n > 0 && n <= MAX_IDS && shares.len() == n && hint_x.len() == n && hint_y.len() == n, BinError::BadParams);
        let pool_key = ctx.accounts.pool.key(); listed(&ctx.accounts.pool)?;
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, authority)))?;
        let active = ctx.accounts.pool.load()?.active_id;
        if ids.contains(&active) { update_active(&ctx.accounts.pool, &acc, &pool_key, now, true)?; }
        let (base_price, step_q) = { let p = ctx.accounts.pool.load()?; (p.base_price, p.step_q) };
        let mut prices = Prices::new(&base_price, &step_q);
        let (mut tx, mut ty) = (0u64, 0u64); let mut chunks: Vec<i32> = Vec::new(); let (mut lo, mut hi) = (i32::MAX, i32::MIN);
        for i in 0..n {
            let id = ids[i]; let s = shares[i];
            require!((MIN_BIN_ID..=MAX_BIN_ID).contains(&id) && s > 0, BinError::BadParams);
            let arr = find(&acc.arrays, chunk_of(id))?; let sh = find_sh(&acc.shares, chunk_of(id))?; let s_ = slot_of(id);
            let mut bins = arr.loader.load_mut()?; let b = &mut bins.bins[s_];
            let supply = g(&b.shares);
            let (x, y, new_supply) = if supply == 0 {
                let (x, y) = (hint_x[i], hint_y[i]);
                require!(!((id > active && y > 0) || (id < active && x > 0) || (x == 0 && y == 0)), BinError::WrongSide);
                let liq = mul_div(u(x as u128), prices.get(id)?, q())? + u(y as u128);
                require!(liq > u(MIN_LIQUIDITY), BinError::ZeroShares);
                require!(to_u128(liq - u(MIN_LIQUIDITY))? == s, BinError::TooFewShares); // the bin was seeded by someone else first
                (x, y, MIN_LIQUIDITY.checked_add(s).ok_or(BinError::Overflow)?)
            } else {
                require!(b.x > 0 || b.y > 0, BinError::ZeroShares);
                let x = to_u64(mul_div_ceil(u(s), u(b.x as u128), u(supply))?)?; let y = to_u64(mul_div_ceil(u(s), u(b.y as u128), u(supply))?)?;
                (x, y, supply.checked_add(s).ok_or(BinError::Overflow)?)
            };
            let mut sa = sh.loader.load_mut()?; settle(&mut sa, s_, b)?;
            b.x = add64(b.x, x)?; b.y = add64(b.y, y)?; st(&mut b.shares, new_supply);
            let cur = g(&sa.slots[s_].shares); st(&mut sa.slots[s_].shares, cur.checked_add(s).ok_or(BinError::Overflow)?);
            bins.refresh(s_);
            tx = add64(tx, x)?; ty = add64(ty, y)?; lo = lo.min(id); hi = hi.max(id);
            if !chunks.contains(&chunk_of(id)) { chunks.push(chunk_of(id)); }
        }
        require!(tx <= max_x && ty <= max_y, BinError::Slippage);
        { let mut p = ctx.accounts.pool.load_mut()?; sync_chunks(&mut p, &acc.arrays, &chunks)?; p.extend_range(lo, hi); }
        if tx > 0 { pull(&ctx.accounts.token_program_x, &ctx.accounts.from_x, &ctx.accounts.mint_x, &ctx.accounts.vault_x, &ctx.accounts.from, tx)?; }
        if ty > 0 { pull(&ctx.accounts.token_program_y, &ctx.accounts.from_y, &ctx.accounts.mint_y, &ctx.accounts.vault_y, &ctx.accounts.from, ty)?; }
        emit!(MintedExact { pool: pool_key, sender: ctx.accounts.from.key(), owner, ids, shares, amount_x: tx, amount_y: ty });
        Ok((tx, ty))
    }

    /// Settle the swap fees of (owner, authority) in `ids` bin by bin and pay everything settled to `to_x` / `to_y`.
    /// Returns what each bin added, flattened [x0, y0, x1, y1, ...], then what was already pending before (x, y): the
    /// shielded aggregate's fee growth per shielded share is raised bin by bin from exactly these amounts. Share authority.
    pub fn harvest<'info>(ctx: Context<'_, '_, 'info, 'info, BurnLiquidity<'info>>, owner: Pubkey, ids: Vec<i32>) -> Result<Vec<u64>> {
        require!(ids.len() <= 32, BinError::BadParams);
        let pool_key = ctx.accounts.pool.key();
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, Some((owner, ctx.accounts.authority.key())))?;
        let mut out = Vec::with_capacity(ids.len() * 2 + 2);
        let (mut px, mut py) = (0u64, 0u64);
        for s in &acc.shares { let sa = s.loader.load()?; px = add64(px, sa.pending_fee_x)?; py = add64(py, sa.pending_fee_y)?; }
        let (mut fx, mut fy) = (px, py);
        for (k, id) in ids.iter().enumerate() {
            require!(!ids[..k].contains(id), BinError::BadParams);
            let a = find(&acc.arrays, chunk_of(*id))?; let sh = find_sh(&acc.shares, chunk_of(*id))?;
            let bins = a.loader.load()?; let mut sa = sh.loader.load_mut()?;
            let (bx, by) = (sa.pending_fee_x, sa.pending_fee_y);
            settle(&mut sa, slot_of(*id), &bins.bins[slot_of(*id)])?;
            let (dx, dy) = (sa.pending_fee_x - bx, sa.pending_fee_y - by);
            out.push(dx); out.push(dy); fx = add64(fx, dx)?; fy = add64(fy, dy)?;
        }
        out.push(px); out.push(py);
        for s in &acc.shares { let mut sa = s.loader.load_mut()?; sa.pending_fee_x = 0; sa.pending_fee_y = 0; }
        pay_xy(&ctx.accounts.pool, &ctx.accounts.token_program_x, &ctx.accounts.token_program_y, &ctx.accounts.vault_x, &ctx.accounts.vault_y, &ctx.accounts.mint_x, &ctx.accounts.mint_y, &ctx.accounts.to_x, &ctx.accounts.to_y, fx, fy)?;
        emit!(FeesClaimed { pool: pool_key, authority: ctx.accounts.authority.key(), owner, ids, amount_x: fx, amount_y: fy });
        Ok(out)
    }

    // ---------------------------------------------------------------------------------------- protocol fee

    /// Pay protocol fees into the pool (anyone; accounted to its protocol balance like a swap's). veyl_entry pays the
    /// 0.2% of the matched part of a sealed batch with it (the netted excess pays it in its swap).
    pub fn pay_protocol_fee(ctx: Context<MintLiquidity>, amount_x: u64, amount_y: u64) -> Result<()> {
        { let mut p = ctx.accounts.pool.load_mut()?; p.protocol_fee_x = add64(p.protocol_fee_x, amount_x)?; p.protocol_fee_y = add64(p.protocol_fee_y, amount_y)?; }
        if amount_x > 0 { pull(&ctx.accounts.token_program_x, &ctx.accounts.from_x, &ctx.accounts.mint_x, &ctx.accounts.vault_x, &ctx.accounts.from, amount_x)?; }
        if amount_y > 0 { pull(&ctx.accounts.token_program_y, &ctx.accounts.from_y, &ctx.accounts.mint_y, &ctx.accounts.vault_y, &ctx.accounts.from, amount_y)?; }
        emit!(ProtocolFeePaid { pool: ctx.accounts.pool.key(), sender: ctx.accounts.from.key(), amount_x, amount_y }); Ok(())
    }
    /// Withdraw accrued protocol fees (at most what is accounted). Fee authority only.
    pub fn withdraw_protocol_fee(ctx: Context<WithdrawProtocolFee>, amount_x: u64, amount_y: u64) -> Result<()> {
        { let mut p = ctx.accounts.pool.load_mut()?;
          require!(amount_x <= p.protocol_fee_x && amount_y <= p.protocol_fee_y, BinError::NotEnoughFees);
          p.protocol_fee_x -= amount_x; p.protocol_fee_y -= amount_y; }
        pay_xy(&ctx.accounts.pool, &ctx.accounts.token_program_x, &ctx.accounts.token_program_y, &ctx.accounts.vault_x, &ctx.accounts.vault_y, &ctx.accounts.mint_x, &ctx.accounts.mint_y, &ctx.accounts.to_x, &ctx.accounts.to_y, amount_x, amount_y)?;
        emit!(ProtocolFeeWithdrawn { pool: ctx.accounts.pool.key(), to_x: ctx.accounts.to_x.key(), to_y: ctx.accounts.to_y.key(), amount_x, amount_y }); Ok(())
    }

    // ---------------------------------------------------------------------------------------- farm rewards

    /// Set up reward slot `index` (factory authority): its mint, a vault owned by the pool, who funds it and the emission
    /// period each funding spreads over.
    pub fn init_reward(ctx: Context<InitReward>, index: u8, duration: u64, funder: Pubkey) -> Result<()> {
        let i = index as usize; require!(i < NUM_REWARDS && duration > 0 && duration <= MAX_REWARD_DURATION && funder != Pubkey::default(), BinError::BadParams);
        let mut p = ctx.accounts.pool.load_mut()?;
        require!(p.rewards[i].mint == Pubkey::default(), BinError::BadParams);
        let r = &mut p.rewards[i];
        r.mint = ctx.accounts.reward_mint.key(); r.vault = ctx.accounts.reward_vault.key(); r.funder = funder; r.token_program = ctx.accounts.token_program.key();
        r.duration = duration; r.last_update = Clock::get()?.unix_timestamp;
        emit!(RewardInitialized { pool: ctx.accounts.pool.key(), index, mint: r.mint, funder, duration }); Ok(())
    }
    /// Add `amount` to reward slot `index` (its funder). Emission restarts over `duration` seconds from now at
    /// (amount + what was not emitted yet) / duration per second. The active bin's array as a remaining account.
    pub fn fund_reward<'info>(ctx: Context<'_, '_, 'info, 'info, FundReward<'info>>, index: u8, amount: u64) -> Result<()> {
        let i = index as usize; require!(i < NUM_REWARDS && amount > 0, BinError::BadParams);
        let now = Clock::get()?.unix_timestamp; let pool_key = ctx.accounts.pool.key();
        require_keys_eq!(ctx.accounts.pool.load()?.rewards[i].funder, ctx.accounts.funder.key(), BinError::NotAuthority);
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, None)?;
        update_active(&ctx.accounts.pool, &acc, &pool_key, now, true)?;
        let (rate, end) = {
            let mut p = ctx.accounts.pool.load_mut()?; let r = &mut p.rewards[i];
            let left = if now < r.end { to_u64(mul_wide(&u(g(&r.rate)), &u((r.end - now) as u128)) >> 64)? } else { 0 };
            let rate = to_u128((u(add64(amount, left)? as u128) << 64) / u(r.duration as u128))?;
            st(&mut r.rate, rate); r.end = now + r.duration as i64; r.last_update = now; (rate, r.end)
        };
        pull(&ctx.accounts.token_program, &ctx.accounts.from, &ctx.accounts.reward_mint, &ctx.accounts.reward_vault, &ctx.accounts.funder, amount)?;
        emit!(RewardFunded { pool: pool_key, index, amount, rate_q64: rate, end }); Ok(())
    }
    /// Hand reward slot `index` to another funder (signed by the current funder).
    pub fn set_reward_funder(ctx: Context<RewardFunder>, index: u8, funder: Pubkey) -> Result<()> {
        let i = index as usize; require!(i < NUM_REWARDS && funder != Pubkey::default(), BinError::BadParams);
        let mut p = ctx.accounts.pool.load_mut()?;
        require_keys_eq!(p.rewards[i].funder, ctx.accounts.funder.key(), BinError::NotAuthority);
        p.rewards[i].funder = funder;
        emit!(RewardFunderSet { pool: ctx.accounts.pool.key(), index, funder }); Ok(())
    }
    /// Emission that fell on an active bin with no liquidity provider earned nothing; its funder may take it back.
    pub fn withdraw_ineligible_reward<'info>(ctx: Context<'_, '_, 'info, 'info, WithdrawIneligible<'info>>, index: u8) -> Result<u64> {
        let i = index as usize; require!(i < NUM_REWARDS, BinError::BadParams);
        let now = Clock::get()?.unix_timestamp; let pool_key = ctx.accounts.pool.key();
        require_keys_eq!(ctx.accounts.pool.load()?.rewards[i].funder, ctx.accounts.funder.key(), BinError::NotAuthority);
        let acc = find_accounts(ctx.remaining_accounts, &pool_key, None)?;
        update_active(&ctx.accounts.pool, &acc, &pool_key, now, true)?;
        let amt = { let mut p = ctx.accounts.pool.load_mut()?; let a = p.rewards[i].ineligible; p.rewards[i].ineligible = 0; a };
        if amt > 0 { let seeds_owned = pool_seeds(&ctx.accounts.pool)?; let seeds = seeds_ref(&seeds_owned);
            push(&ctx.accounts.token_program, &ctx.accounts.reward_vault, &ctx.accounts.reward_mint, &ctx.accounts.to, &ctx.accounts.pool.to_account_info(), &seeds, amt)?; }
        emit!(IneligibleRewardWithdrawn { pool: pool_key, index, amount: amt }); Ok(amt)
    }
}

// ------------------------------------------------------------------------------------------------ maths

/// P(id) = basePrice * stepQ^id / Q, computed exactly as `priceOf` + `_pow` in Solidity (square-and-multiply, flooring at each step).
pub fn price_of(base_price: &[u8; 32], step_q: &[u8; 32], id: i32) -> Result<U512> { Prices::new(base_price, step_q).get(id) }
/// `price_of` for many bins of one pool: the squarings stepQ^(2^k) (floored, in `_pow`'s order) do not depend on the bin, so
/// they are computed once per instruction. Each price is bit-identical to `price_of`.
pub struct Prices { base: U512, pows: Vec<U512> }
impl Prices {
    pub fn new(base_price: &[u8; 32], step_q: &[u8; 32]) -> Self { Prices { base: from_be32(base_price), pows: vec![from_be32(step_q)] } }
    pub fn get(&mut self, id: i32) -> Result<U512> {
        let n = (id as i64).unsigned_abs(); let bits = 64 - n.leading_zeros() as usize;
        while self.pows.len() < bits { let b = *self.pows.last().unwrap(); self.pows.push(mul_div(b, b, q())?); }
        let mut r = q();
        for k in 0..bits { if (n >> k) & 1 == 1 { r = mul_div(r, self.pows[k], q())?; } }
        if id >= 0 { mul_div(self.base, r, q()) } else { mul_div(self.base, q(), r) }
    }
}

pub struct SwapResult { pub out: u64, pub fee: u64, pub protocol_fee: u64, pub end_id: i32, pub vol_acc: u128, pub vol_ref: u128, pub id_ref: i32, pub touched: Vec<(i32, Bin)> }

/// The next bin at or beyond `from` (downwards when selling X for Y) that holds the token bought, through the pool's
/// array bitmap and the array's bin bitmap. Ok(None) = no liquidity left on that side.
fn next_bin(p: &BinPool, arrays: &[Found<BinArray>], from: i32, x_for_y: bool) -> Result<Option<i32>> {
    let (side_y, down) = (x_for_y, x_for_y);
    let c = chunk_of(from); let s = slot_of(from) as u32;
    let pick = |bits: u64, c: i32| -> i32 { c * BINS_PER_ARRAY + if down { 63 - bits.leading_zeros() as i32 } else { bits.trailing_zeros() as i32 } };
    if p.chunk_bit(side_y, c) {
        let a = find(arrays, c)?; let arr = a.loader.load()?;
        let bits = if side_y { arr.bitmap_y } else { arr.bitmap_x };
        let mask = if down { if s >= 63 { u64::MAX } else { (1u64 << (s + 1)) - 1 } } else { !((1u64 << s) - 1) };
        if bits & mask != 0 { return Ok(Some(pick(bits & mask, c))); }
    }
    match p.next_chunk(side_y, c, down) {
        None => Ok(None),
        Some(c2) => { let a = find(arrays, c2)?; let arr = a.loader.load()?; let bits = if side_y { arr.bitmap_y } else { arr.bitmap_x };
            require!(bits != 0, BinError::BitmapMismatch); Ok(Some(pick(bits, c2))) }
    }
}

/// `_simulate`: the protocol fee (`protocol_fee_of(amount_in)`, rounded up) comes off the input first; the rest trades from
/// the active bin, bin by bin, until it is used up. Per bin the formula is the EVM's; the LP fee taken in each bin is split
/// between market makers and limit orders pro rata to what each sold. `fee` = LP fee + protocol fee (what the trader paid),
/// `protocol_fee` = the protocol fee + any LP fee that had no provider to pay.
pub fn simulate(p: &BinPool, arrays: &[Found<BinArray>], x_for_y: bool, amount_in: u64, now: i64) -> Result<SwapResult> {
    require!(p.seeded == 1, BinError::InsufficientLiquidity);
    let (vol_ref, id_ref) = p.refs(now);
    let proto_in = protocol_fee_of(amount_in, p.protocol_fee_bps);
    let mut r = SwapResult { out: 0, fee: proto_in, protocol_fee: proto_in, end_id: p.active_id, vol_acc: 0, vol_ref, id_ref, touched: Vec::new() };
    let mut left = (amount_in - proto_in) as u128; let mut id = p.active_id; let mut step = 0usize; let mut prices = Prices::new(&p.base_price, &p.step_q);
    while left > 0 {
        id = next_bin(p, arrays, id, x_for_y)?.ok_or(BinError::InsufficientLiquidity)?;
        require!(step < MAX_STEPS, BinError::TooManySteps); step += 1;
        r.vol_acc = p.acc(vol_ref, id_ref, id);
        let fee = p.fee(r.vol_acc);
        let mut b = { let a = find(arrays, chunk_of(id))?; let bins = a.loader.load()?; bins.bins[slot_of(id)] };
        let (mm_avail, lo_avail) = if x_for_y { (b.y as u128, b.bid_y as u128) } else { (b.x as u128, b.ask_x as u128) };
        let avail = mm_avail + lo_avail;
        require!(avail > 0, BinError::BitmapMismatch);
        let price = prices.get(id)?;
        let in_no_fee = if x_for_y { mul_div_ceil(u(avail), q(), price)? } else { mul_div_ceil(u(avail), price, q())? };
        let fee_max = mul_div_ceil(in_no_fee, u(fee), u(PIPS - fee))?;
        let max_in = to_u128(in_no_fee + fee_max)?;
        let (used, got, fee_amt);
        if left >= max_in { used = max_in; got = avail; fee_amt = to_u128(fee_max)?; }
        else {
            used = left; fee_amt = to_u128(mul_div_ceil(u(left), u(fee), u(PIPS))?)?;
            let net = left - fee_amt;
            let g_ = if x_for_y { mul_div(u(net), price, q())? } else { mul_div(u(net), q(), price)? };
            let g_ = to_u128(g_)?; got = if g_ > avail { avail } else { g_ };
        }
        // split the bin's trade (and its LP fee) between market makers and limit orders pro rata to what each sold
        let lp_fee = fee_amt;
        let net = used - fee_amt;
        let lo_got = got * lo_avail / avail; let mm_got = got - lo_got;
        let (lo_in, lo_fee) = if got == 0 { (0, 0) } else { (net * lo_got / got, lp_fee * lo_got / got) };
        let (mm_in, mm_fee) = (net - lo_in, lp_fee - lo_fee);
        let eligible = g(&b.shares).saturating_sub(MIN_LIQUIDITY);
        let mut proto_extra = 0u128;
        if mm_fee > 0 {
            if eligible > 0 { let add = (mm_fee << 64) / eligible; if x_for_y { wadd_st(&mut b.fee_gx, add); } else { wadd_st(&mut b.fee_gy, add); } }
            else { proto_extra = mm_fee; } // no liquidity provider to pay (only the locked MIN_LIQUIDITY): protocol
        }
        let ck = |v: u128| -> Result<u64> { require!(v <= u64::MAX as u128, BinError::Overflow); Ok(v as u64) };
        if x_for_y {
            b.x = ck(b.x as u128 + mm_in)?; b.y = ck(b.y as u128 - mm_got)?;
            b.bid_y = ck(b.bid_y as u128 - lo_got)?; b.bid_filled_x = ck(b.bid_filled_x as u128 + lo_in + lo_fee)?;
        } else {
            b.y = ck(b.y as u128 + mm_in)?; b.x = ck(b.x as u128 - mm_got)?;
            b.ask_x = ck(b.ask_x as u128 - lo_got)?; b.ask_filled_y = ck(b.ask_filled_y as u128 + lo_in + lo_fee)?;
        }
        r.touched.push((id, b));
        r.out = add64(r.out, ck(got)?)?; r.fee = add64(r.fee, ck(fee_amt)?)?; r.protocol_fee = add64(r.protocol_fee, ck(proto_extra)?)?;
        left -= used;
        if left > 0 { id = if x_for_y { id.checked_sub(1).ok_or(BinError::Overflow)? } else { id.checked_add(1).ok_or(BinError::Overflow)? }; }
    }
    r.end_id = id;
    Ok(r)
}

/// Simulate, then write the touched bins, bitmaps, active bin, volatility state and fee balances. Rewards are brought up
/// to date for the (old) active bin first.
fn swap_inner<'info>(pool: &AccountLoader<'info, BinPool>, acc: &Accs<'info>, pool_key: &Pubkey, x_for_y: bool, amount_in: u64, now: i64) -> Result<SwapResult> {
    update_active(pool, acc, pool_key, now, true)?;
    let r = { let p = pool.load()?; simulate(&p, &acc.arrays, x_for_y, amount_in, now)? };
    let mut chunks: Vec<i32> = Vec::new();
    for (id, b) in &r.touched {
        let a = find(&acc.arrays, chunk_of(*id))?; let mut bins = a.loader.load_mut()?; bins.bins[slot_of(*id)] = *b; bins.refresh(slot_of(*id));
        if !chunks.contains(&chunk_of(*id)) { chunks.push(chunk_of(*id)); }
    }
    let mut p = pool.load_mut()?;
    sync_chunks(&mut p, &acc.arrays, &chunks)?;
    p.active_id = r.end_id; p.vol_acc = r.vol_acc as u64; p.vol_ref = r.vol_ref as u64; p.id_ref = r.id_ref; p.last_swap_at = now;
    if x_for_y { p.protocol_fee_x = add64(p.protocol_fee_x, r.protocol_fee)?; p.total_fee_x = p.total_fee_x.saturating_add(r.fee); }
    else { p.protocol_fee_y = add64(p.protocol_fee_y, r.protocol_fee)?; p.total_fee_y = p.total_fee_y.saturating_add(r.fee); }
    Ok(r)
}

/// Bring a position slot's fee and reward accrual up to date (into its share account's pending balances) and move its
/// checkpoints to the bin's current growth. Must run before the slot's shares change.
fn settle(sa: &mut ShareAccount, s: usize, b: &Bin) -> Result<()> {
    let sh = g(&sa.slots[s].shares);
    if sh > 0 {
        let fx = owed(g(&b.fee_gx), g(&sa.slots[s].fee_cp_x), sh)?; let fy = owed(g(&b.fee_gy), g(&sa.slots[s].fee_cp_y), sh)?;
        sa.pending_fee_x = add64(sa.pending_fee_x, fx)?; sa.pending_fee_y = add64(sa.pending_fee_y, fy)?;
        for i in 0..NUM_REWARDS { let rw = owed(g(&b.reward_g[i]), g(&sa.slots[s].reward_cp[i]), sh)?; sa.pending_reward[i] = add64(sa.pending_reward[i], rw)?; }
    }
    let slot = &mut sa.slots[s]; slot.fee_cp_x = b.fee_gx; slot.fee_cp_y = b.fee_gy; slot.reward_cp = b.reward_g;
    Ok(())
}
fn settle_ids(acc: &Accs, ids: &[i32]) -> Result<()> {
    for id in ids { let a = find(&acc.arrays, chunk_of(*id))?; let sh = find_sh(&acc.shares, chunk_of(*id))?;
        let bins = a.loader.load()?; let mut sa = sh.loader.load_mut()?; settle(&mut sa, slot_of(*id), &bins.bins[slot_of(*id)])?; }
    Ok(())
}

/// Mint into each bin (same share maths as the EVM). `skip_empty`: a bin given nothing (weighted adds) is skipped when
/// its minimum is zero. Updates bitmaps and the seeded range; moves no tokens.
fn mint_inner<'info>(pool: &AccountLoader<'info, BinPool>, acc: &Accs<'info>, ids: &[i32], ax: &[u64], ay: &[u64], min_shares: &[u128], skip_empty: bool, now: i64) -> Result<Vec<u128>> {
    let (active, fee, base_price, step_q) = { let p = pool.load()?; let (r, iref) = p.refs(now); (p.active_id, p.fee(p.acc(r, iref, p.active_id)), p.base_price, p.step_q) };
    let mut minted = Vec::with_capacity(ids.len()); let mut chunks: Vec<i32> = Vec::new(); let mut prices = Prices::new(&base_price, &step_q);
    let (mut lo, mut hi) = (i32::MAX, i32::MIN);
    for i in 0..ids.len() {
        let id = ids[i]; let x = ax[i]; let y = ay[i];
        require!((MIN_BIN_ID..=MAX_BIN_ID).contains(&id), BinError::BadParams);
        if skip_empty && x == 0 && y == 0 { require!(min_shares.is_empty() || min_shares[i] == 0, BinError::TooFewShares); minted.push(0); continue; }
        require!(!((id > active && y > 0) || (id < active && x > 0) || (x == 0 && y == 0)), BinError::WrongSide);
        let price = prices.get(id)?;
        let arr = find(&acc.arrays, chunk_of(id))?; let sh = find_sh(&acc.shares, chunk_of(id))?; let s_ = slot_of(id);
        let mut bins = arr.loader.load_mut()?; let b = &mut bins.bins[s_];
        let mut supply = g(&b.shares);
        let xv = mul_div(u(x as u128), price, q())?; let mut liq = xv + u(y as u128);
        let bxv = mul_div(u(b.x as u128), price, q())?; let lb = bxv + u(b.y as u128);
        let s: u128;
        if supply == 0 || lb.is_zero() {
            if supply == 0 {
                require!(liq > u(MIN_LIQUIDITY), BinError::ZeroShares);
                s = to_u128(liq - u(MIN_LIQUIDITY))?; supply = MIN_LIQUIDITY; // MIN_LIQUIDITY shares locked forever (EVM: minted to the dead address)
            } else { s = to_u128(liq)?; }
        } else {
            if id == active {
                // one-sided add to the active bin is a partial swap: pay the current fee on the implied amount
                let ideal = mul_div(liq, bxv, lb)?;
                let excess = if xv > ideal { xv - ideal } else { ideal - xv };
                liq -= mul_div_ceil(excess, u(fee), u(PIPS))?;
            }
            s = to_u128(mul_div(liq, u(supply), lb)?)?;
        }
        require!(s > 0, BinError::ZeroShares);
        if !min_shares.is_empty() { require!(s >= min_shares[i], BinError::TooFewShares); }
        let mut sa = sh.loader.load_mut()?; settle(&mut sa, s_, b)?;
        b.x = add64(b.x, x)?; b.y = add64(b.y, y)?;
        st(&mut b.shares, supply.checked_add(s).ok_or(BinError::Overflow)?);
        let cur = g(&sa.slots[s_].shares); st(&mut sa.slots[s_].shares, cur.checked_add(s).ok_or(BinError::Overflow)?);
        bins.refresh(s_);
        minted.push(s); lo = lo.min(id); hi = hi.max(id);
        if !chunks.contains(&chunk_of(id)) { chunks.push(chunk_of(id)); }
    }
    let mut p = pool.load_mut()?;
    sync_chunks(&mut p, &acc.arrays, &chunks)?;
    if lo <= hi { p.extend_range(lo, hi); }
    Ok(minted)
}

/// Burn shares bin by bin (settling fees and rewards first); returns the reserves released. Moves no tokens.
fn burn_inner<'info>(pool: &AccountLoader<'info, BinPool>, acc: &Accs<'info>, ids: &[i32], shares_in: &[u128]) -> Result<(u64, u64)> {
    let (mut amount_x, mut amount_y) = (0u64, 0u64); let mut chunks: Vec<i32> = Vec::new();
    for i in 0..ids.len() {
        let id = ids[i]; let s = shares_in[i];
        let arr = find(&acc.arrays, chunk_of(id))?; let sh = find_sh(&acc.shares, chunk_of(id))?; let s_ = slot_of(id);
        let mut sa = sh.loader.load_mut()?; let mine = g(&sa.slots[s_].shares);
        require!(s > 0 && s <= mine, BinError::NotEnoughShares);
        let mut bins = arr.loader.load_mut()?; let b = &mut bins.bins[s_];
        settle(&mut sa, s_, b)?;
        let supply = g(&b.shares);
        let ox = to_u64(mul_div(u(b.x as u128), u(s), u(supply))?)?; let oy = to_u64(mul_div(u(b.y as u128), u(s), u(supply))?)?;
        b.x -= ox; b.y -= oy; st(&mut b.shares, supply - s);
        st(&mut sa.slots[s_].shares, mine - s);
        bins.refresh(s_);
        amount_x = add64(amount_x, ox)?; amount_y = add64(amount_y, oy)?;
        if !chunks.contains(&chunk_of(id)) { chunks.push(chunk_of(id)); }
    }
    let mut p = pool.load_mut()?; sync_chunks(&mut p, &acc.arrays, &chunks)?;
    Ok((amount_x, amount_y))
}

/// Bring farm rewards up to date for the active bin. `required`: the active bin's array must be among the remaining
/// accounts (or be passed as its not-yet-created PDA, proving the bin is empty).
fn update_active<'info>(pool: &AccountLoader<'info, BinPool>, acc: &Accs<'info>, pool_key: &Pubkey, now: i64, required: bool) -> Result<()> {
    let mut p = pool.load_mut()?;
    if !p.rewards.iter().any(|r| r.mint != Pubkey::default()) { return Ok(()); }
    let active = p.active_id; let c = chunk_of(active);
    if let Some(a) = acc.arrays.iter().find(|a| a.chunk == c) { let mut arr = a.loader.load_mut()?; p.update_rewards(Some(&mut arr.bins[slot_of(active)]), now) }
    else if !acc.empties.is_empty() && acc.empties.contains(&Pubkey::find_program_address(&[b"bins", pool_key.as_ref(), &c.to_le_bytes()], &crate::ID).0) { p.update_rewards(None, now) }
    else if required { err!(BinError::MissingBinArray) } else { Ok(()) }
}

fn sync_chunks(p: &mut BinPool, arrays: &[Found<BinArray>], chunks: &[i32]) -> Result<()> {
    for c in chunks { let a = find(arrays, *c)?; let arr = a.loader.load()?; p.set_chunk(*c, arr.bitmap_x != 0, arr.bitmap_y != 0); }
    Ok(())
}

fn pull<'info>(tp: &Interface<'info, TokenInterface>, from: &InterfaceAccount<'info, TokenAccount>, mint: &InterfaceAccount<'info, Mint>, to: &InterfaceAccount<'info, TokenAccount>, auth: &Signer<'info>, amount: u64) -> Result<()> {
    token_interface::transfer_checked(CpiContext::new(tp.to_account_info(), TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: auth.to_account_info() }), amount, mint.decimals)
}
fn push<'info>(tp: &Interface<'info, TokenInterface>, from: &InterfaceAccount<'info, TokenAccount>, mint: &InterfaceAccount<'info, Mint>, to: &InterfaceAccount<'info, TokenAccount>, pool: &AccountInfo<'info>, seeds: &[&[u8]], amount: u64) -> Result<()> {
    token_interface::transfer_checked(CpiContext::new_with_signer(tp.to_account_info(), TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: pool.clone() }, &[seeds]), amount, mint.decimals)
}
/// The pool PDA's signer seeds: ["bin", mint_x, mint_y, bin_step, bump].
fn pool_seeds(pool: &AccountLoader<BinPool>) -> Result<(Pubkey, Pubkey, [u8; 2], [u8; 1])> { let p = pool.load()?; Ok((p.mint_x, p.mint_y, p.bin_step.to_le_bytes(), [p.bump])) }
fn seeds_ref(s: &(Pubkey, Pubkey, [u8; 2], [u8; 1])) -> [&[u8]; 5] { [b"bin", s.0.as_ref(), s.1.as_ref(), &s.2, &s.3] }
fn pay_xy<'info>(pool: &AccountLoader<'info, BinPool>, tpx: &Interface<'info, TokenInterface>, tpy: &Interface<'info, TokenInterface>, vx: &InterfaceAccount<'info, TokenAccount>, vy: &InterfaceAccount<'info, TokenAccount>, mx: &InterfaceAccount<'info, Mint>, my: &InterfaceAccount<'info, Mint>, tx: &InterfaceAccount<'info, TokenAccount>, ty: &InterfaceAccount<'info, TokenAccount>, ax: u64, ay: u64) -> Result<()> {
    let seeds_owned = pool_seeds(pool)?; let seeds = seeds_ref(&seeds_owned);
    if ax > 0 { push(tpx, vx, mx, tx, &pool.to_account_info(), &seeds, ax)?; }
    if ay > 0 { push(tpy, vy, my, ty, &pool.to_account_info(), &seeds, ay)?; }
    Ok(())
}

/// New liquidity is refused once a pool is delisted.
fn listed(pool: &AccountLoader<BinPool>) -> Result<()> { require!(pool.load()?.delisted == 0, BinError::Delisted); Ok(()) }
/// Classic SPL Token mints are accepted as they are (a freeze authority included: USDC / USDT have one). Token-2022 mints
/// only with extensions that cannot alter a transfer or a balance: metadata / group pointers and data. Everything else is
/// refused, among them TransferFeeConfig, TransferHook, PermanentDelegate, DefaultAccountState, InterestBearingConfig,
/// NonTransferable, MintCloseAuthority and the confidential-transfer extensions (and any extension this build does not know).
fn check_mint(m: &AccountInfo) -> Result<()> {
    use anchor_spl::token_2022::spl_token_2022::{extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions}, state::Mint as Mint22};
    if m.owner == &anchor_spl::token::ID { return Ok(()); }
    require_keys_eq!(*m.owner, anchor_spl::token_2022::ID, BinError::BadMint);
    let data = m.try_borrow_data()?;
    let st = StateWithExtensions::<Mint22>::unpack(&data).map_err(|_| error!(BinError::BadMint))?;
    for e in st.get_extension_types().map_err(|_| error!(BinError::BadMint))? {
        require!(matches!(e, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata | ExtensionType::GroupPointer | ExtensionType::TokenGroup | ExtensionType::GroupMemberPointer | ExtensionType::TokenGroupMember), BinError::BadMint);
    }
    Ok(())
}

pub struct Found<'info, T: ZeroCopy + Owner> { pub chunk: i32, pub key: Pubkey, pub loader: AccountLoader<'info, T> }
pub struct Accs<'info> { pub arrays: Vec<Found<'info, BinArray>>, pub shares: Vec<Found<'info, ShareAccount>>, pub empties: Vec<Pubkey> }
fn find<'a, 'info>(arrays: &'a [Found<'info, BinArray>], chunk: i32) -> Result<&'a Found<'info, BinArray>> { arrays.iter().find(|a| a.chunk == chunk).ok_or_else(|| error!(BinError::MissingBinArray)) }
fn find_sh<'a, 'info>(shares: &'a [Found<'info, ShareAccount>], chunk: i32) -> Result<&'a Found<'info, ShareAccount>> { shares.iter().find(|a| a.chunk == chunk).ok_or_else(|| error!(BinError::MissingShareAccount)) }
/// Sort the remaining accounts into this pool's bin arrays and (optionally) the share accounts of (owner, authority).
/// Each is checked by owner (this program), discriminator and the pool / owner / authority / chunk it stores, which only
/// `init_bin_array` / `init_shares` write, from the same values as its PDA seeds: a foreign or forged account cannot pass.
/// Duplicates are dropped (a share account counted twice would pay its pending balance twice). Empty system-owned accounts
/// are recorded: one may be the not-yet-created array of the active bin.
fn find_accounts<'info>(infos: &'info [AccountInfo<'info>], pool: &Pubkey, shares_for: Option<(Pubkey, Pubkey)>) -> Result<Accs<'info>> {
    let mut arrays: Vec<Found<'info, BinArray>> = Vec::new(); let mut shares: Vec<Found<'info, ShareAccount>> = Vec::new(); let mut empties = Vec::new();
    for info in infos {
        if info.owner != &crate::ID {
            if info.owner == &anchor_lang::system_program::ID && info.data_is_empty() { empties.push(*info.key); }
            continue;
        }
        if arrays.iter().any(|a| a.key == *info.key) || shares.iter().any(|a| a.key == *info.key) { continue; }
        let data = info.try_borrow_data()?;
        if data.len() < 8 { continue; }
        let is_bins = &data[..8] == BinArray::DISCRIMINATOR; let is_shares = &data[..8] == ShareAccount::DISCRIMINATOR; drop(data);
        if is_bins {
            let l: AccountLoader<'info, BinArray> = AccountLoader::try_from(info)?;
            let chunk = { let a = l.load()?; require_keys_eq!(a.pool, *pool, BinError::WrongPool); a.chunk };
            arrays.push(Found { chunk, key: *info.key, loader: l });
        } else if is_shares {
            if let Some((owner, authority)) = shares_for {
                let l: AccountLoader<'info, ShareAccount> = AccountLoader::try_from(info)?;
                let chunk = { let a = l.load()?; require!(a.pool == *pool && a.owner == owner && a.authority == authority, BinError::WrongShareAccount); a.chunk };
                shares.push(Found { chunk, key: *info.key, loader: l });
            }
        }
    }
    Ok(Accs { arrays, shares, empties })
}

// ------------------------------------------------------------------------------------------------ state

#[account]
pub struct Factory {
    pub authority: Pubkey, pub pending_authority: Pubkey, pub bump: u8, pub fee_authority: Pubkey, pub pending_fee_authority: Pubkey,
    pub treasury: Pubkey,                       // receives forfeited bonds
    pub bond_lamports: u64, pub bond_lock: i64, // for pools created from now on
    pub protocol_fee_bps: u16,                  // PROTOCOL_FEE_BPS, copied into every new pool
    pub num_tiers: u8, pub tiers: [FeeTier; MAX_TIERS],
}
/// The factory's size before permissionless pools (discriminator, authority, pending_authority, bump, fee_authority,
/// pending_fee_authority): what `migrate_factory` grows from. devnet-migrate builds only.
#[cfg(feature = "devnet-migrate")]
pub const OLD_FACTORY_SIZE: usize = 8 + 32 * 4 + 1;
impl Factory {
    pub const SIZE: usize = 8 + 32 * 4 + 1 + 32 + 8 + 8 + 2 + 1 + FeeTier::SIZE * MAX_TIERS;
    /// The bin step of tier `i` (0 when there is no such tier: no pool PDA is ever derived from it).
    pub fn step_of(&self, i: u8) -> u16 { if (i as usize) < self.num_tiers as usize { self.tiers[i as usize].bin_step } else { 0 } }
    pub fn tier(&self, i: u8) -> Result<FeeTier> { require!((i as usize) < self.num_tiers as usize && self.tiers[i as usize].enabled == 1, BinError::BadTier); Ok(self.tiers[i as usize]) }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct FeeTier { pub bin_step: u16, pub base_fee: u32, pub variable_fee_control: u64, pub enabled: u8 }
impl FeeTier { pub const SIZE: usize = 2 + 4 + 8 + 1; }
/// The listing bond of a pool (["bond", pool]): lamports held for the creator until `unlock_at`; closed on release or delisting.
#[account]
pub struct Bond { pub pool: Pubkey, pub creator: Pubkey, pub amount: u64, pub created_at: i64, pub unlock_at: i64, pub bump: u8 }
impl Bond { pub const SIZE: usize = 8 + 32 * 2 + 8 * 3 + 1; }

#[zero_copy]
#[repr(C)]
pub struct RewardInfo {
    pub mint: Pubkey, pub vault: Pubkey, pub funder: Pubkey, pub token_program: Pubkey,
    pub rate: [u64; 2], // atoms per second, Q64.64
    pub duration: u64, pub end: i64, pub last_update: i64,
    pub ineligible: u64, // emitted while the active bin had no liquidity provider: the funder's to take back
}

#[account(zero_copy)]
#[repr(C)]
pub struct BinPool {
    pub factory: Pubkey, pub mint_x: Pubkey, pub mint_y: Pubkey, pub vault_x: Pubkey, pub vault_y: Pubkey, pub token_program_x: Pubkey, pub token_program_y: Pubkey,
    pub base_price: [u8; 32], // 128.128, big-endian
    pub step_q: [u8; 32],     // (1 + binStep/1e4) in 128.128, big-endian
    pub variable_fee_control: u64,
    pub vol_acc: u64, pub vol_ref: u64, pub last_swap_at: i64,
    pub active_id: i32, pub lowest_id: i32, pub highest_id: i32, pub id_ref: i32,
    pub base_fee: u32, pub bin_step: u16, pub seeded: u8, pub bump: u8,
    // Phase 1
    pub protocol_fee_bps: u16, pub delisted: u8, pub fee_tier: u8, pub _pad: [u8; 4], // protocol fee (bps of swap input, fixed), delisted flag, factory tier index
    pub protocol_fee_x: u64, pub protocol_fee_y: u64, // accounted in the vaults; the fee authority's to withdraw
    pub total_fee_x: u64, pub total_fee_y: u64,       // lifetime swap fees (analytics)
    pub bitmap_x: [u64; BITMAP_WORDS], pub bitmap_y: [u64; BITMAP_WORDS], // per bin array: holds X / Y to sell
    pub rewards: [RewardInfo; NUM_REWARDS],
}
impl BinPool {
    pub const SIZE: usize = 8 + 7 * 32 + 64 + 8 * 4 + 4 * 4 + 4 + 2 + 1 + 1 + 8 + 32 + 2 * 8 * BITMAP_WORDS + NUM_REWARDS * 176;
    /// `_refs`
    pub fn refs(&self, now: i64) -> (u128, i32) {
        let dt = now.saturating_sub(self.last_swap_at);
        let (mut r, mut i) = (self.vol_ref as u128, self.id_ref);
        if dt >= FILTER_PERIOD { i = self.active_id; r = if dt < DECAY_PERIOD { (self.vol_acc as u128 * REDUCTION_BPS) / 10_000 } else { 0 }; }
        (r, i)
    }
    /// `_acc`
    pub fn acc(&self, r: u128, iref: i32, id: i32) -> u128 { let dist = (iref as i64 - id as i64).unsigned_abs() as u128; let va = r + dist * 10_000; va.min(MAX_VOL_ACC) }
    /// `_fee`: baseFee + (va*binStep)^2 * variableFeeControl / 1e12, capped at MAX_FEE. All in u128 (va <= 350_000, binStep <= 500,
    /// so v^2 < 2^55 and variableFeeControl may be up to 2^64 without overflow).
    pub fn fee(&self, va: u128) -> u128 { let v = va * self.bin_step as u128; let f = self.base_fee as u128 + (v * v * self.variable_fee_control as u128) / 1_000_000_000_000; f.min(MAX_FEE) }
    fn idx(c: i32) -> Option<usize> { let i = c as i64 - MIN_CHUNK as i64; if i < 0 || i >= CHUNKS as i64 { None } else { Some(i as usize) } }
    pub fn chunk_bit(&self, y_side: bool, c: i32) -> bool { match Self::idx(c) { None => false, Some(i) => { let bm = if y_side { &self.bitmap_y } else { &self.bitmap_x }; bm[i / 64] >> (i % 64) & 1 == 1 } } }
    pub fn set_chunk(&mut self, c: i32, has_x: bool, has_y: bool) {
        if let Some(i) = Self::idx(c) { let m = 1u64 << (i % 64);
            if has_x { self.bitmap_x[i / 64] |= m } else { self.bitmap_x[i / 64] &= !m }
            if has_y { self.bitmap_y[i / 64] |= m } else { self.bitmap_y[i / 64] &= !m } }
    }
    /// The nearest bin array strictly beyond `c` (in the direction) whose bitmap bit is set.
    pub fn next_chunk(&self, y_side: bool, c: i32, down: bool) -> Option<i32> {
        let bm = if y_side { &self.bitmap_y } else { &self.bitmap_x };
        let i = c as i64 - MIN_CHUNK as i64;
        if down {
            let start = (i - 1).min(CHUNKS as i64 - 1); if start < 0 { return None; }
            let (mut w, b) = ((start / 64) as usize, (start % 64) as u32);
            let mut bits = bm[w] & if b == 63 { u64::MAX } else { (1u64 << (b + 1)) - 1 };
            loop { if bits != 0 { return Some((w * 64 + 63 - bits.leading_zeros() as usize) as i32 + MIN_CHUNK); } if w == 0 { return None; } w -= 1; bits = bm[w]; }
        } else {
            let start = (i + 1).max(0); if start >= CHUNKS as i64 { return None; }
            let (mut w, b) = ((start / 64) as usize, (start % 64) as u32);
            let mut bits = bm[w] & !((1u64 << b) - 1);
            loop { if bits != 0 { return Some((w * 64 + bits.trailing_zeros() as usize) as i32 + MIN_CHUNK); } w += 1; if w == BITMAP_WORDS { return None; } bits = bm[w]; }
        }
    }
    pub fn extend_range(&mut self, lo: i32, hi: i32) {
        if self.seeded == 0 { self.lowest_id = lo; self.highest_id = hi; self.seeded = 1; } else { self.lowest_id = self.lowest_id.min(lo); self.highest_id = self.highest_id.max(hi); }
    }
    /// Accrue every live reward slot up to `now` into the active bin's per-share growth (Q64.64; MIN_LIQUIDITY shares
    /// excluded), or into `ineligible` when the active bin has no liquidity provider.
    pub fn update_rewards(&mut self, mut active: Option<&mut Bin>, now: i64) -> Result<()> {
        let eligible = active.as_ref().map(|b| g(&b.shares).saturating_sub(MIN_LIQUIDITY)).unwrap_or(0);
        for i in 0..NUM_REWARDS {
            let r = &mut self.rewards[i];
            if r.mint == Pubkey::default() { continue; }
            let t = now.min(r.end);
            if t > r.last_update {
                let emitted = mul_wide(&u(g(&r.rate)), &u((t - r.last_update) as u128)); // < 2^128: rate * duration <= funded << 64
                if eligible > 0 { if let Some(b) = active.as_deref_mut() { let add = to_u128(emitted / u(eligible))?; wadd_st(&mut b.reward_g[i], add); } }
                else { r.ineligible = add64(r.ineligible, to_u64(emitted >> 64)?)?; }
            }
            if now > r.last_update { r.last_update = now; }
        }
        Ok(())
    }
}
#[zero_copy]
#[repr(C)]
pub struct Bin {
    pub x: u64, pub y: u64, pub shares: [u64; 2],          // market-making reserves and shares
    pub fee_gx: [u64; 2], pub fee_gy: [u64; 2],             // swap fee per share (Q64.64, wrapping), per token
    pub reward_g: [[u64; 2]; NUM_REWARDS],                  // farm reward per share (Q64.64, wrapping)
    pub ask_shares: [u64; 2], pub ask_x: u64, pub ask_filled_y: u64, // limit orders selling X (unfilled X, filled Y incl. fees)
    pub bid_shares: [u64; 2], pub bid_y: u64, pub bid_filled_x: u64, // limit orders selling Y
}
impl Bin {
    pub fn has_x(&self) -> bool { self.x > 0 || self.ask_x > 0 }
    pub fn has_y(&self) -> bool { self.y > 0 || self.bid_y > 0 }
}
#[account(zero_copy)]
#[repr(C)]
pub struct BinArray { pub pool: Pubkey, pub chunk: i32, pub _pad: [u8; 4], pub bitmap_x: u64, pub bitmap_y: u64, pub bins: [Bin; BINS_PER_ARRAY as usize] }
impl BinArray {
    pub const SIZE: usize = 8 + 32 + 8 + 16 + 160 * BINS_PER_ARRAY as usize;
    pub fn refresh(&mut self, s: usize) {
        let m = 1u64 << s; let (hx, hy) = (self.bins[s].has_x(), self.bins[s].has_y());
        if hx { self.bitmap_x |= m } else { self.bitmap_x &= !m }
        if hy { self.bitmap_y |= m } else { self.bitmap_y &= !m }
    }
}
#[zero_copy]
#[repr(C)]
pub struct Slot { pub shares: [u64; 2], pub fee_cp_x: [u64; 2], pub fee_cp_y: [u64; 2], pub reward_cp: [[u64; 2]; NUM_REWARDS], pub ask_shares: [u64; 2], pub bid_shares: [u64; 2] }
#[account(zero_copy)]
#[repr(C)]
pub struct ShareAccount {
    pub pool: Pubkey, pub owner: Pubkey, pub authority: Pubkey, pub chunk: i32, pub _pad: [u8; 4],
    pub pending_fee_x: u64, pub pending_fee_y: u64, pub pending_reward: [u64; NUM_REWARDS], // settled, not yet claimed
    pub slots: [Slot; BINS_PER_ARRAY as usize],
}
impl ShareAccount { pub const SIZE: usize = 8 + 96 + 8 + 16 + 8 * NUM_REWARDS + 112 * BINS_PER_ARRAY as usize; }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct RebalanceResult { pub burned_x: u64, pub burned_y: u64, pub withheld_x: u64, pub withheld_y: u64, pub readded_x: u64, pub readded_y: u64 }

// ------------------------------------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct InitFactory<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ BinError::NotAuthority)]
    pub program: Program<'info, crate::program::VeylBin>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ BinError::NotAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = Factory::SIZE, seeds = [b"factory"], bump)] pub factory: Account<'info, Factory>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct FactoryAuthority<'info> { pub authority: Signer<'info>, #[account(mut, seeds = [b"factory"], bump = factory.bump, has_one = authority @ BinError::NotAuthority)] pub factory: Account<'info, Factory> }
#[derive(Accounts)]
pub struct FeeAuthority<'info> { pub fee_authority: Signer<'info>, #[account(mut, seeds = [b"factory"], bump = factory.bump, has_one = fee_authority @ BinError::NotAuthority)] pub factory: Account<'info, Factory> }
#[derive(Accounts)]
pub struct AcceptFactoryAuthority<'info> { pub next: Signer<'info>, #[account(mut, seeds = [b"factory"], bump = factory.bump)] pub factory: Account<'info, Factory> }
#[derive(Accounts)]
#[instruction(tier: u8)]
pub struct CreatePool<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    #[account(seeds = [b"factory"], bump = factory.bump)] pub factory: Box<Account<'info, Factory>>,
    pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = creator, space = BinPool::SIZE, seeds = [b"bin", mint_x.key().as_ref(), mint_y.key().as_ref(), &factory.step_of(tier).to_le_bytes()], bump)] pub pool: AccountLoader<'info, BinPool>,
    #[account(init, payer = creator, space = Bond::SIZE, seeds = [b"bond", pool.key().as_ref()], bump)] pub bond: Box<Account<'info, Bond>>,
    /// init_if_needed: the vaults' addresses are known in advance and anyone may create them first (REVIEW.md M-3).
    #[account(init_if_needed, payer = creator, associated_token::mint = mint_x, associated_token::authority = pool, associated_token::token_program = token_program_x)] pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = creator, associated_token::mint = mint_y, associated_token::authority = pool, associated_token::token_program = token_program_y)] pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(chunk: i32)]
pub struct InitBinArray<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    pub pool: AccountLoader<'info, BinPool>,
    #[account(init, payer = payer, space = BinArray::SIZE, seeds = [b"bins", pool.key().as_ref(), &chunk.to_le_bytes()], bump)] pub bins: AccountLoader<'info, BinArray>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(owner: Pubkey, authority: Pubkey, chunk: i32)]
pub struct InitShares<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    pub pool: AccountLoader<'info, BinPool>,
    #[account(init, payer = payer, space = ShareAccount::SIZE, seeds = [b"shares", pool.key().as_ref(), owner.as_ref(), authority.as_ref(), &chunk.to_le_bytes()], bump)] pub shares: AccountLoader<'info, ShareAccount>,
    pub system_program: Program<'info, System>,
}
/// Tokens come in from `from` (mint, place_limit_order, swap_and_add).
#[derive(Accounts)]
pub struct MintLiquidity<'info> {
    pub from: Signer<'info>,
    #[account(mut)] pub pool: AccountLoader<'info, BinPool>,
    #[account(address = pool.load()?.mint_x @ BinError::WrongMint)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.load()?.mint_y @ BinError::WrongMint)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.load()?.vault_x @ BinError::WrongMint)] pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.load()?.vault_y @ BinError::WrongMint)] pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_x)] pub from_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_y)] pub from_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.load()?.token_program_x @ BinError::WrongTokenProgram)] pub token_program_x: Interface<'info, TokenInterface>,
    #[account(address = pool.load()?.token_program_y @ BinError::WrongTokenProgram)] pub token_program_y: Interface<'info, TokenInterface>,
}
/// Tokens go out to `to_x` / `to_y`, signed by the share authority (burn, claim_fees, withdraw_limit_order, rebalance_position).
#[derive(Accounts)]
pub struct BurnLiquidity<'info> {
    pub authority: Signer<'info>,
    #[account(mut)] pub pool: AccountLoader<'info, BinPool>,
    #[account(address = pool.load()?.mint_x @ BinError::WrongMint)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.load()?.mint_y @ BinError::WrongMint)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.load()?.vault_x @ BinError::WrongMint)] pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.load()?.vault_y @ BinError::WrongMint)] pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_x)] pub to_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_y)] pub to_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.load()?.token_program_x @ BinError::WrongTokenProgram)] pub token_program_x: Interface<'info, TokenInterface>,
    #[account(address = pool.load()?.token_program_y @ BinError::WrongTokenProgram)] pub token_program_y: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(mut)] pub pool: AccountLoader<'info, BinPool>,
    #[account(address = pool.load()?.mint_x @ BinError::WrongMint)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.load()?.mint_y @ BinError::WrongMint)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.load()?.vault_x @ BinError::WrongMint)] pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.load()?.vault_y @ BinError::WrongMint)] pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub user_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub user_out: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.load()?.token_program_x @ BinError::WrongTokenProgram)] pub token_program_x: Interface<'info, TokenInterface>,
    #[account(address = pool.load()?.token_program_y @ BinError::WrongTokenProgram)] pub token_program_y: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct Quote<'info> { pub pool: AccountLoader<'info, BinPool> }
#[derive(Accounts)]
#[instruction(owner: Pubkey, index: u8)]
pub struct ClaimReward<'info> {
    pub authority: Signer<'info>,
    #[account(mut)] pub pool: AccountLoader<'info, BinPool>,
    #[account(address = pool.load()?.rewards.get(index as usize).map(|r| r.mint).unwrap_or_default() @ BinError::WrongMint)] pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.load()?.rewards.get(index as usize).map(|r| r.vault).unwrap_or_default() @ BinError::WrongMint)] pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = reward_mint)] pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.load()?.rewards.get(index as usize).map(|r| r.token_program).unwrap_or_default() @ BinError::WrongTokenProgram)] pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct ReleaseBond<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    pub pool: AccountLoader<'info, BinPool>,
    #[account(mut, seeds = [b"bond", pool.key().as_ref()], bump = bond.bump, has_one = creator @ BinError::NotAuthority, close = creator)] pub bond: Account<'info, Bond>,
}
#[derive(Accounts)]
pub struct DelistPool<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"factory"], bump = factory.bump, has_one = authority @ BinError::NotAuthority, has_one = treasury @ BinError::NotAuthority)] pub factory: Box<Account<'info, Factory>>,
    #[account(mut, constraint = pool.load()?.factory == factory.key() @ BinError::WrongPool)] pub pool: AccountLoader<'info, BinPool>,
    /// CHECK: the pool's bond PDA (seeds checked); closed to the treasury when it still exists (not released yet).
    #[account(mut, seeds = [b"bond", pool.key().as_ref()], bump)] pub bond: UncheckedAccount<'info>,
    /// CHECK: the factory's treasury (has_one).
    #[account(mut)] pub treasury: UncheckedAccount<'info>,
}
#[cfg(feature = "devnet-migrate")]
#[derive(Accounts)]
pub struct MigrateFactory<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    /// CHECK: the factory PDA in its old layout, read by bytes (owner, size, discriminator and authority checked in the handler).
    #[account(mut, seeds = [b"factory"], bump)] pub factory: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[cfg(feature = "devnet-migrate")]
#[derive(Accounts)]
pub struct MigratePool<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"factory"], bump = factory.bump, has_one = authority @ BinError::NotAuthority)] pub factory: Box<Account<'info, Factory>>,
    #[account(mut, constraint = pool.load()?.factory == factory.key() @ BinError::WrongPool)] pub pool: AccountLoader<'info, BinPool>,
}
#[derive(Accounts)]
pub struct WithdrawProtocolFee<'info> {
    pub fee_authority: Signer<'info>,
    #[account(seeds = [b"factory"], bump = factory.bump, has_one = fee_authority @ BinError::NotAuthority)] pub factory: Box<Account<'info, Factory>>,
    #[account(mut, constraint = pool.load()?.factory == factory.key() @ BinError::WrongPool)] pub pool: AccountLoader<'info, BinPool>,
    #[account(address = pool.load()?.mint_x @ BinError::WrongMint)] pub mint_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pool.load()?.mint_y @ BinError::WrongMint)] pub mint_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.load()?.vault_x @ BinError::WrongMint)] pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.load()?.vault_y @ BinError::WrongMint)] pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_x)] pub to_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_y)] pub to_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.load()?.token_program_x @ BinError::WrongTokenProgram)] pub token_program_x: Interface<'info, TokenInterface>,
    #[account(address = pool.load()?.token_program_y @ BinError::WrongTokenProgram)] pub token_program_y: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
#[instruction(index: u8)]
pub struct InitReward<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(seeds = [b"factory"], bump = factory.bump, has_one = authority @ BinError::NotAuthority)] pub factory: Box<Account<'info, Factory>>,
    #[account(mut, constraint = pool.load()?.factory == factory.key() @ BinError::WrongPool)] pub pool: AccountLoader<'info, BinPool>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The reward vault: a token account owned by the pool at a PDA of its own, so it never collides with the pool's X / Y vaults.
    #[account(init, payer = authority, seeds = [b"reward_vault", pool.key().as_ref(), &[index]], bump, token::mint = reward_mint, token::authority = pool, token::token_program = token_program)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(index: u8)]
pub struct FundReward<'info> {
    pub funder: Signer<'info>,
    #[account(mut)] pub pool: AccountLoader<'info, BinPool>,
    #[account(address = pool.load()?.rewards.get(index as usize).map(|r| r.mint).unwrap_or_default() @ BinError::WrongMint)] pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.load()?.rewards.get(index as usize).map(|r| r.vault).unwrap_or_default() @ BinError::WrongMint)] pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = reward_mint)] pub from: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.load()?.rewards.get(index as usize).map(|r| r.token_program).unwrap_or_default() @ BinError::WrongTokenProgram)] pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct RewardFunder<'info> { pub funder: Signer<'info>, #[account(mut)] pub pool: AccountLoader<'info, BinPool> }
#[derive(Accounts)]
#[instruction(index: u8)]
pub struct WithdrawIneligible<'info> {
    pub funder: Signer<'info>,
    #[account(mut)] pub pool: AccountLoader<'info, BinPool>,
    #[account(address = pool.load()?.rewards.get(index as usize).map(|r| r.mint).unwrap_or_default() @ BinError::WrongMint)] pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.load()?.rewards.get(index as usize).map(|r| r.vault).unwrap_or_default() @ BinError::WrongMint)] pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = reward_mint)] pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.load()?.rewards.get(index as usize).map(|r| r.token_program).unwrap_or_default() @ BinError::WrongTokenProgram)] pub token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------------------------------------ events / errors

#[event] pub struct PoolCreated { pub pool: Pubkey, pub mint_x: Pubkey, pub mint_y: Pubkey, pub bin_step: u16, pub base_fee: u32, pub tier: u8, pub creator: Pubkey, pub bond: u64, pub unlock_at: i64 }
#[event] pub struct FeeTierAdded { pub index: u8, pub bin_step: u16, pub base_fee: u32, pub variable_fee_control: u64 }
#[event] pub struct FeeTierSet { pub index: u8, pub enabled: bool }
#[event] pub struct BondSet { pub lamports: u64, pub lock_seconds: i64 }
#[event] pub struct TreasurySet { pub treasury: Pubkey }
#[event] pub struct BondReleased { pub pool: Pubkey, pub creator: Pubkey, pub amount: u64 }
#[event] pub struct PoolDelisted { pub pool: Pubkey, pub forfeited: u64 }
#[event] pub struct ProtocolFeePaid { pub pool: Pubkey, pub sender: Pubkey, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct Minted { pub pool: Pubkey, pub sender: Pubkey, pub owner: Pubkey, pub ids: Vec<i32>, pub amounts_x: Vec<u64>, pub amounts_y: Vec<u64>, pub shares: Vec<u128> }
#[event] pub struct Burned { pub pool: Pubkey, pub authority: Pubkey, pub owner: Pubkey, pub ids: Vec<i32>, pub shares: Vec<u128>, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct Swapped { pub pool: Pubkey, pub sender: Pubkey, pub to: Pubkey, pub x_for_y: bool, pub amount_in: u64, pub amount_out: u64, pub fee: u64, pub active_id: i32, pub protocol_fee: u64 }
#[event] pub struct FeesClaimed { pub pool: Pubkey, pub authority: Pubkey, pub owner: Pubkey, pub ids: Vec<i32>, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct RewardClaimed { pub pool: Pubkey, pub authority: Pubkey, pub owner: Pubkey, pub index: u8, pub ids: Vec<i32>, pub amount: u64 }
#[event] pub struct LimitOrderPlaced { pub pool: Pubkey, pub sender: Pubkey, pub owner: Pubkey, pub id: i32, pub is_ask: bool, pub amount: u64, pub shares: u128 }
#[event] pub struct LimitOrderWithdrawn { pub pool: Pubkey, pub authority: Pubkey, pub owner: Pubkey, pub id: i32, pub is_ask: bool, pub shares: u128, pub amount_x: u64, pub amount_y: u64, pub unfilled_left: u64 }
#[event] pub struct Rebalanced { pub pool: Pubkey, pub authority: Pubkey, pub owner: Pubkey, pub burned_x: u64, pub burned_y: u64, pub withheld_x: u64, pub withheld_y: u64, pub readded_x: u64, pub readded_y: u64, pub ids: Vec<i32>, pub shares: Vec<u128> }
#[event] pub struct MintedExact { pub pool: Pubkey, pub sender: Pubkey, pub owner: Pubkey, pub ids: Vec<i32>, pub shares: Vec<u128>, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct ZapAdded { pub pool: Pubkey, pub sender: Pubkey, pub owner: Pubkey, pub x_in: bool, pub amount_in: u64, pub swap_amount: u64, pub swap_out: u64, pub ids: Vec<i32>, pub shares: Vec<u128> }
#[event] pub struct ProtocolFeeWithdrawn { pub pool: Pubkey, pub to_x: Pubkey, pub to_y: Pubkey, pub amount_x: u64, pub amount_y: u64 }
#[event] pub struct FeeAuthoritySet { pub fee_authority: Pubkey }
#[event] pub struct RewardInitialized { pub pool: Pubkey, pub index: u8, pub mint: Pubkey, pub funder: Pubkey, pub duration: u64 }
#[event] pub struct RewardFunded { pub pool: Pubkey, pub index: u8, pub amount: u64, pub rate_q64: u128, pub end: i64 }
#[event] pub struct RewardFunderSet { pub pool: Pubkey, pub index: u8, pub funder: Pubkey }
#[event] pub struct IneligibleRewardWithdrawn { pub pool: Pubkey, pub index: u8, pub amount: u64 }

#[error_code]
pub enum BinError {
    #[msg("bad params")] BadParams,
    #[msg("wrong side of the active bin")] WrongSide,
    #[msg("zero shares")] ZeroShares,
    #[msg("not enough shares")] NotEnoughShares,
    #[msg("insufficient liquidity")] InsufficientLiquidity,
    #[msg("too many steps")] TooManySteps,
    #[msg("slippage")] Slippage,
    #[msg("overflow")] Overflow,
    #[msg("expired")] Expired,
    #[msg("too few shares")] TooFewShares,
    #[msg("not the authority")] NotAuthority,
    #[msg("wrong mint")] WrongMint,
    #[msg("wrong token program")] WrongTokenProgram,
    #[msg("bin array missing from the accounts")] MissingBinArray,
    #[msg("share account missing from the accounts")] MissingShareAccount,
    #[msg("bin array belongs to another pool")] WrongPool,
    #[msg("share account does not match")] WrongShareAccount,
    #[msg("more than the accounted protocol fees")] NotEnoughFees,
    #[msg("bitmap and bins disagree")] BitmapMismatch,
    #[msg("mints must be in canonical order (mint_x < mint_y)")] MintOrder,
    #[msg("not an approved (enabled) fee tier")] BadTier,
    #[msg("mint not allowed (Token-2022 extension)")] BadMint,
    #[msg("pool is delisted")] Delisted,
    #[msg("bond is still locked")] BondLocked,
}
