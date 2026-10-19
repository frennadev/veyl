//! Veyl privacy pool on Solana: the private balance for one SPL mint. Port of `VeylPrivacyPool.sol` + `StateTree.sol`.
//!
//!   note       = Poseidon(value, label, Poseidon(nullifier, secret))         (circomlib Poseidon over BN254, via the
//!                                                                             `sol_poseidon` syscall)
//!   label      = fixed at deposit; follows the money through every change note
//!   withdraw   = Groth16 proof (same circuit, zkey and verifying key as the EVM build) that you own a note in the tree,
//!                its label is in the approved set (aspRoot) and you take `withdrawnValue` out. The remainder goes back
//!                in as a fresh change note.
//!   ragequit   = the beneficiary named at deposit can always take an unspent deposit back publicly.
//!
//! Solana shape: a spend is two instructions. `post_withdrawal` verifies the proof on-chain (alt_bn128 syscalls via
//! groth16-solana) and parks the result in the nullifier PDA `["null", pool, nullifierHash]`; `withdraw` is then called
//! by the processor (the entry program's signer PDA, via CPI) with the action data, which must hash to the context the
//! proof committed to. Splitting it keeps every transaction well under Solana's 1232-byte limit. A posted-but-never-
//! executed spend can be cancelled by its poster at any time, or by anyone after it expires; the note stays unspent.
#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv as sha256v;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod verifier;
pub mod vkey;
pub mod vkey_transact;
pub mod vkey_position;
pub mod vkey_swap;
pub mod vkey_claim;

// Program IDs. Devnet/local: the repo's public dev keypairs (target/deploy). The `mainnet` build profile
// (`npm run build:mainnet`) uses fresh IDs that `npm run keys:mainnet` writes into the cfg(feature = "mainnet") lines;
// until then they hold the system program as a placeholder, which preflight reports as red.
#[cfg(not(feature = "mainnet"))]
declare_id!("BudA5kQySdfhfocWhPiDUP888tuoqL9aRxNiq9Qon73V");
#[cfg(feature = "mainnet")]
declare_id!("11111111111111111111111111111111"); // mainnet veyl_pool (npm run keys:mainnet)
/// veyl_entry, whose signer PDA `["signer"]` deposits swap / removal proceeds (exempt from the minimum deposit).
#[cfg(not(feature = "mainnet"))]
pub const ENTRY_PROGRAM: Pubkey = anchor_lang::solana_program::pubkey!("4q6p4io7m3pgxpMqRDSKBRsAb6gCBGCKvTRabZtp1QHn");
#[cfg(feature = "mainnet")]
pub const ENTRY_PROGRAM: Pubkey = anchor_lang::solana_program::pubkey!("11111111111111111111111111111111"); // mainnet veyl_entry (npm run keys:mainnet)

pub const DEPTH: usize = 32; // = MerkleRoot(32) in zk/circuits/withdraw.circom
/// Known state roots. One entry per slot (every insert in the same slot updates that slot's entry), so a proof stays valid
/// for at least ROOT_HISTORY slots (~77 s) however many deposits an attacker crams in (REVIEW.md M-4). 192 keeps the
/// zero-copy Pool under the 10 KiB a program may allocate by CPI.
pub const ROOT_HISTORY: usize = 192;
pub const ASP_HISTORY: usize = 16;
pub const MAX_POST_TTL_SLOTS: u64 = 9_000; // ~1 hour: a posted spend that is never executed frees its nullifier after this
/// BN254 scalar field modulus (big-endian), the field every public signal lives in.
pub const SNARK_SCALAR_FIELD: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48,
    0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub const SPEND_POSTED: u8 = 1;
pub const SPEND_SPENT: u8 = 2;

// ------------------------------------------------------------------------------------------------ hashing helpers

/// circomlib-compatible Poseidon (BN254, t = n+1, the parameters circomlibjs / poseidon-lite use).
pub fn poseidon(inputs: &[&[u8; 32]]) -> Result<[u8; 32]> {
    let refs: Vec<&[u8]> = inputs.iter().map(|x| &x[..]).collect();
    let h = solana_poseidon::hashv(solana_poseidon::Parameters::Bn254X5, solana_poseidon::Endianness::BigEndian, &refs)
        .map_err(|_| error!(VeylError::BadField))?;
    Ok(h.to_bytes())
}
pub fn poseidon1(a: &[u8; 32]) -> Result<[u8; 32]> { poseidon(&[a]) }
pub fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> { poseidon(&[a, b]) }
pub fn poseidon3(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> Result<[u8; 32]> { poseidon(&[a, b, c]) }

/// Is a big-endian 256-bit number a valid, non-zero field element (0 < x < SNARK_SCALAR_FIELD)?
pub fn in_field(x: &[u8; 32]) -> bool { x.iter().any(|b| *b != 0) && *x < SNARK_SCALAR_FIELD }

/// sha256 of the parts, with the top three bits cleared so the result is < 2^253 < SNARK_SCALAR_FIELD.
/// (The EVM used keccak256 mod p; any hash-to-field works, the circuit only requires a field element.)
pub fn hash_to_field(parts: &[&[u8]]) -> [u8; 32] { let mut h = sha256v(parts).to_bytes(); h[0] &= 0x1f; h }
pub fn u64_to_field(v: u64) -> [u8; 32] { let mut b = [0u8; 32]; b[24..].copy_from_slice(&v.to_be_bytes()); b }
/// The deposit label: hash(pool, nonce) as a field element. Replaces keccak(chainid, pool, nonce) mod p.
pub fn label_of(pool: &Pubkey, nonce: u64) -> [u8; 32] { hash_to_field(&[b"veyl-label", pool.as_ref(), &nonce.to_le_bytes()]) }
/// The context a proof is bound to: who may execute it, what they must do (the encoded action) and which pool.
pub fn context_of(processor: &Pubkey, data: &[u8], pool: &Pubkey) -> [u8; 32] { hash_to_field(&[b"veyl-context", processor.as_ref(), data, pool.as_ref()]) }
/// The entry program's signer PDA (the processor of every private action).
pub fn entry_signer() -> Pubkey { Pubkey::find_program_address(&[b"signer"], &ENTRY_PROGRAM).0 }

// ------------------------------------------------------------------------------------------------ Phase 2 helpers

pub const SHIELD_SEED: &[u8] = b"shield";
pub const KIND_TRANSACT: u8 = 1;
pub const KIND_POSITION: u8 = 2;
/// Phase 3 (sealed batch swaps): a swap proof (zk/circuits/swap.circom, 8 public signals) and a claim proof
/// (claim.circom, 6 public signals; stored with two trailing zeros).
pub const KIND_SWAP: u8 = 3;
pub const KIND_CLAIM: u8 = 4;
pub const MAX_CIPHERTEXT: usize = 512;
/// A position note's payload (= the entry's limit on LpCore.ciphertext).
pub const MAX_POSITION_CIPHERTEXT: usize = 1024;
/// A token's asset id in the shielded pool (= assetOf in sdk/shield.js).
pub fn asset_of(mint: &Pubkey) -> [u8; 32] { hash_to_field(&[b"veyl-asset", mint.as_ref()]) }
/// Limit-order shares of one bin and side: a virtual asset (entry program).
pub fn order_asset_of(bin_pool: &Pubkey, id: i32, is_ask: bool) -> [u8; 32] { hash_to_field(&[b"veyl-order", bin_pool.as_ref(), &id.to_le_bytes(), &[is_ask as u8]]) }
/// A shielded position's window (bin pool, lowest bin of 16).
pub fn pos_asset_of(bin_pool: &Pubkey, lo: i32) -> [u8; 32] { hash_to_field(&[b"veyl-pos", bin_pool.as_ref(), &lo.to_le_bytes()]) }
pub fn u128_to_field(v: u128) -> [u8; 32] { let mut b = [0u8; 32]; b[16..].copy_from_slice(&v.to_be_bytes()); b }
/// a - b for big-endian 256-bit numbers (a >= b).
fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32]; let mut borrow = 0i16;
    for i in (0..32).rev() { let d = a[i] as i16 - b[i] as i16 - borrow; if d < 0 { out[i] = (d + 256) as u8; borrow = 1; } else { out[i] = d as u8; borrow = 0; } }
    out
}
/// A signed integer as a field element (negative x = p - |x|): what the circuits see for publicAmount and share deltas.
pub fn signed_field(v: i128) -> [u8; 32] { if v >= 0 { u128_to_field(v as u128) } else { sub_be(&SNARK_SCALAR_FIELD, &u128_to_field(v.unsigned_abs())) } }
/// The id a posted proof is stored under.
pub fn proof_id(kind: u8, pubs: &[[u8; 32]; 8]) -> [u8; 32] { let mut v = Vec::with_capacity(257); v.push(kind); for p in pubs { v.extend_from_slice(p); } sha256v(&[&v]).to_bytes() }

/// What a transact proof's extDataHash commits to (borsh; = encodeExt in sdk/shield.js).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct TransactExt {
    /// Token account a withdrawal is paid to (the entry's vault for an action).
    pub recipient: Pubkey,
    /// > 0 deposit, < 0 withdrawal, 0 transfer inside the pool.
    pub ext_amount: i64,
    /// Token account the relayer's fee is paid to.
    pub relayer: Pubkey,
    pub fee: u64,
    /// Who must sign the execution (default: anyone); the entry's signer PDA for an action.
    pub processor: Pubkey,
    /// The entry action this spend funds (sha256 of it), zero for a plain transact.
    pub action: [u8; 32],
    /// The token (default for a transfer that reveals none, or a virtual asset).
    pub mint: Pubkey,
    /// The two output notes, encrypted to their recipients' viewing keys.
    pub enc_out: Vec<Vec<u8>>,
}
pub fn ext_hash(ext: &TransactExt) -> Result<[u8; 32]> { let mut v = Vec::new(); ext.serialize(&mut v)?; Ok(hash_to_field(&[b"veyl-transact", &v])) }

/// Everything a transact execution checks against the posted proof: its kind, root, external data, public amount and
/// asset. `asset` = the asset the program will move (zero when nothing moves). Returns the public signals:
/// [root, publicAmount, extDataHash, publicAsset, nullifier0, nullifier1, commitment0, commitment1].
pub fn check_transact(s: &Shield, posted: &PostedProof, ext: &TransactExt, asset: &[u8; 32]) -> Result<[[u8; 32]; 8]> {
    require!(posted.kind == KIND_TRANSACT, VeylError::BadParams);
    let pubs = posted.pubs;
    require!(s.is_known_root(&pubs[0]), VeylError::UnknownStateRoot);
    require!(ext.enc_out.len() == 2 && ext.enc_out.iter().all(|c| c.len() <= MAX_CIPHERTEXT), VeylError::BadParams);
    require!(ext_hash(ext)? == pubs[2], VeylError::BadContext);
    require!(ext.fee <= i64::MAX as u64, VeylError::BadAmount);
    let public = ext.ext_amount as i128 - ext.fee as i128;
    require!(signed_field(public) == pubs[1], VeylError::BadAmount);
    if public != 0 { require!(pubs[3] == *asset && *asset != [0u8; 32], VeylError::WrongMint); } else { require!(pubs[3] == [0u8; 32], VeylError::WrongMint); }
    require!(in_field(&pubs[4]) && in_field(&pubs[5]) && in_field(&pubs[6]) && in_field(&pubs[7]), VeylError::BadField);
    Ok(pubs)
}
/// Mark a nullifier spent: create its PDA ["nf", nullifier] (owned by this program, no data). An existing one is a double
/// spend. Lamports someone sent to the address beforehand cannot block it (allocate + assign then, like Anchor's init).
pub fn use_nullifier<'info>(acc: &AccountInfo<'info>, payer: &AccountInfo<'info>, system: &Program<'info, System>, nullifier: &[u8; 32], ev: &mut Evs) -> Result<()> {
    let (key, bump) = Pubkey::find_program_address(&[b"nf", nullifier.as_ref()], &crate::ID);
    require_keys_eq!(acc.key(), key, VeylError::BadParams);
    require!(acc.owner != &crate::ID, VeylError::AlreadySpent);
    let seeds: &[&[u8]] = &[b"nf", nullifier.as_ref(), &[bump]];
    let rent = Rent::get()?.minimum_balance(0);
    use anchor_lang::system_program as sp;
    if acc.lamports() == 0 {
        sp::create_account(CpiContext::new_with_signer(system.to_account_info(), sp::CreateAccount { from: payer.clone(), to: acc.clone() }, &[seeds]), rent, 0, &crate::ID)?;
    } else {
        let need = rent.saturating_sub(acc.lamports());
        if need > 0 { sp::transfer(CpiContext::new(system.to_account_info(), sp::Transfer { from: payer.clone(), to: acc.clone() }), need)?; }
        sp::assign(CpiContext::new_with_signer(system.to_account_info(), sp::Assign { account_to_assign: acc.clone() }, &[seeds]), &crate::ID)?;
    }
    ev.push(&Nullified { nullifier: *nullifier });
    Ok(())
}
/// The shielded tree's events (NoteInserted, NoteCiphertext, PositionCiphertext, ReceiptNote, Nullified, DepositPending /
/// Approved / Cancelled), from every instruction that changes the tree or its notes:
///  - logged as they happen (`push`: `sol_log_data`, exactly what `emit!` writes), as before, except the note payloads
///    (`quiet`): those are the bulk of a transaction's logs, and a log reader still finds them in the instruction data;
///  - all of them in ONE self-CPI at the end (`flush`), Anchor's event-cpi format extended to several events: instruction
///    data = EVENT_IX_TAG (8 bytes, LE 0x1d9acb512ea545e4) followed by each event as Anchor encodes it (8-byte discriminator
///    sha256("event:<Name>")[..8] + borsh), back to back. The event authority PDA ["__event_authority"] signs it, so no other
///    program can fake one in a successful transaction.
/// Solana keeps only ~10 KB of logs per transaction and silently drops the rest, and anyone may put a log-flooding
/// instruction in front of a shield instruction they submit themselves: a NoteInserted cut from the logs breaks the tree for
/// every reader. Inner-instruction data is recorded in full (the transaction fails as a whole if it cannot be), so readers
/// take the self-CPI first and the logs only for transactions from before it existed (sdk/shield.js readShield). One CPI per
/// instruction, not one per event: a merging shield_lp creates ~20 events and a transaction may run only 64 instructions.
pub struct Evs(Vec<u8>);
impl Evs {
    pub fn new() -> Self { Evs(Vec::with_capacity(640)) }
    pub fn push<E: anchor_lang::Event>(&mut self, e: &E) { let d = e.data(); anchor_lang::solana_program::log::sol_log_data(&[&d]); self.0.extend_from_slice(&d); }
    pub fn quiet<E: anchor_lang::Event>(&mut self, e: &E) { self.0.extend_from_slice(&e.data()); }
    pub fn flush<'info>(self, authority: &AccountInfo<'info>, bump: u8) -> Result<()> {
        if self.0.is_empty() { return Ok(()); }
        let mut data = Vec::with_capacity(8 + self.0.len()); data.extend_from_slice(anchor_lang::event::EVENT_IX_TAG_LE); data.extend_from_slice(&self.0);
        let ix = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(crate::ID, &data, vec![AccountMeta::new_readonly(authority.key(), true)]);
        anchor_lang::solana_program::program::invoke_signed(&ix, &[authority.clone()], &[&[b"__event_authority", &[bump]]]).map_err(Into::into)
    }
}
/// The new notes' encrypted copies (event CPI only: see Evs).
fn emit_ciphertexts(ev: &mut Evs, commitments: &[[u8; 32]], enc: &[Vec<u8>]) { for (c, d) in commitments.iter().zip(enc.iter()) { if !d.is_empty() { ev.quiet(&NoteCiphertext { commitment: *c, data: d.clone() }); } } }
fn insert_outputs<'info>(ev: &mut Evs, shield: &AccountLoader<'info, Shield>, pubs: &[[u8; 32]; 8]) -> Result<()> {
    let mut s = shield.load_mut()?;
    for c in [pubs[6], pubs[7]] { let (i, _) = s.insert(&c)?; ev.push(&NoteInserted { index: i, commitment: c }); }
    Ok(())
}
fn shield_out<'info>(tp: &Interface<'info, TokenInterface>, vault: &InterfaceAccount<'info, TokenAccount>, mint: &InterfaceAccount<'info, Mint>, to: &InterfaceAccount<'info, TokenAccount>, shield: &AccountInfo<'info>, signer: &[&[u8]], amount: u64) -> Result<()> {
    token_interface::transfer_checked(CpiContext::new_with_signer(tp.to_account_info(), TransferChecked { from: vault.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: shield.clone() }, &[signer]), amount, mint.decimals)
}

// ------------------------------------------------------------------------------------------------ program

#[program]
pub mod veyl_pool {
    use super::*;

    /// Create the private pool for one mint. `authority` = the EVM owner, `postman` = the approved-set publisher.
    pub fn init_pool(ctx: Context<InitPool>, min_deposit: u64, postman: Pubkey) -> Result<()> {
        let mut p = ctx.accounts.pool.load_init()?;
        p.authority = ctx.accounts.authority.key();
        p.postman = postman;
        p.mint = ctx.accounts.mint.key();
        p.vault = ctx.accounts.vault.key();
        p.token_program = ctx.accounts.token_program.key();
        p.min_deposit = min_deposit;
        p.bump = ctx.bumps.pool;
        // Same construction as StateTree's constructor: zeros[i] = Poseidon(zeros[i-1], zeros[i-1]), roots[0] = zeros[DEPTH].
        let mut z = [0u8; 32];
        for i in 0..DEPTH { p.zeros[i] = z; p.filled[i] = z; z = poseidon2(&z, &z)?; }
        p.roots[0] = z; p.root_slot = 0;
        emit!(PostmanUpdated { pool: ctx.accounts.pool.key(), postman });
        Ok(())
    }

    pub fn set_postman(ctx: Context<OnlyAuthority>, postman: Pubkey) -> Result<()> {
        ctx.accounts.pool.load_mut()?.postman = postman;
        emit!(PostmanUpdated { pool: ctx.accounts.pool.key(), postman });
        Ok(())
    }
    /// Two-step ownership transfer (Ownable2Step).
    pub fn propose_authority(ctx: Context<OnlyAuthority>, next: Pubkey) -> Result<()> { ctx.accounts.pool.load_mut()?.pending_authority = next; Ok(()) }
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let mut p = ctx.accounts.pool.load_mut()?;
        require_keys_eq!(p.pending_authority, ctx.accounts.next.key(), VeylError::NotAuthority);
        p.authority = ctx.accounts.next.key(); p.pending_authority = Pubkey::default(); Ok(())
    }

    /// Publish a new approved set. `ipfs_cid` points at the full label list so anyone can rebuild the tree.
    pub fn update_asp_root(ctx: Context<OnlyPostman>, root: [u8; 32], ipfs_cid: String) -> Result<()> {
        require!(in_field(&root), VeylError::BadField);
        require!(ipfs_cid.len() <= 128, VeylError::BadParams);
        let mut p = ctx.accounts.pool.load_mut()?;
        p.asp_root = root;
        let i = (p.asp_index + 1) % ASP_HISTORY as u64;
        p.asp_roots[i as usize] = root; p.asp_index = i;
        emit!(AspRootUpdated { pool: ctx.accounts.pool.key(), root, ipfs_cid });
        Ok(())
    }
    /// Emergency: forget every older approved set, so proofs against them stop working at once.
    pub fn reset_asp_roots(ctx: Context<OnlyPostman>, root: [u8; 32], ipfs_cid: String) -> Result<()> {
        require!(in_field(&root), VeylError::BadField);
        require!(ipfs_cid.len() <= 128, VeylError::BadParams);
        let mut p = ctx.accounts.pool.load_mut()?;
        p.asp_roots = [[0u8; 32]; ASP_HISTORY]; p.asp_index = 0; p.asp_roots[0] = root; p.asp_root = root;
        emit!(AspRootUpdated { pool: ctx.accounts.pool.key(), root, ipfs_cid });
        Ok(())
    }

    /// Deposit `amount` for `beneficiary` (who can ragequit it if it is never approved). `precommitment` =
    /// Poseidon(nullifier, secret), made on the depositor's device. EVM: deposit / depositFor.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, precommitment: [u8; 32], beneficiary: Pubkey) -> Result<()> {
        require!(in_field(&precommitment), VeylError::BadField);
        require_keys_neq!(beneficiary, Pubkey::default(), VeylError::BadField);
        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.payer_token.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.payer.to_account_info() }),
            amount, ctx.accounts.mint.decimals)?;
        ctx.accounts.vault.reload()?;
        let value = ctx.accounts.vault.amount.checked_sub(before).ok_or(VeylError::BadAmount)?; // what actually arrived
        let pool_key = ctx.accounts.pool.key();
        let (label, commitment, index) = {
            let mut p = ctx.accounts.pool.load_mut()?;
            // the entry's signer PDA deposits swap / removal proceeds: those may be below the minimum (a dust side of a
            // position must not make the whole removal fail, REVIEW.md M-6); everyone else pays at least min_deposit
            require!(value > 0 && (value >= p.min_deposit || ctx.accounts.payer.key() == entry_signer()), VeylError::BadAmount);
            p.deposit_nonce += 1;
            let label = label_of(&pool_key, p.deposit_nonce);
            let commitment = poseidon3(&u64_to_field(value), &label, &precommitment)?;
            let (index, _root) = p.insert(&commitment)?;
            (label, commitment, index)
        };
        let d = &mut ctx.accounts.deposit_record;
        d.pool = pool_key; d.beneficiary = beneficiary; d.label = label; d.commitment = commitment; d.value = value; d.bump = ctx.bumps.deposit_record;
        emit!(Deposited { pool: pool_key, beneficiary, payer: ctx.accounts.payer.key(), commitment, label, value, precommitment, index });
        Ok(())
    }

    /// Step 1 of a private spend: verify the Groth16 proof on-chain and park it under its nullifier hash.
    /// `pubs` = the circuit's public signals, in snarkjs order:
    /// [newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, aspRoot, context].
    /// `proof` = A.x A.y | B.x.c1 B.x.c0 B.y.c1 B.y.c0 | C.x C.y, 32-byte big-endian each (the EVM verifier's layout).
    pub fn post_withdrawal(ctx: Context<PostWithdrawal>, proof: [u8; 256], pubs: [[u8; 32]; 6], processor: Pubkey, ttl_slots: u64) -> Result<()> {
        require!(ttl_slots > 0 && ttl_slots <= MAX_POST_TTL_SLOTS, VeylError::BadParams);
        let p = ctx.accounts.pool.load()?;
        // withdrawnValue must be a u64 (SPL amounts); zero-value spends are refused (they only churn the root history).
        require!(pubs[2][..24].iter().all(|b| *b == 0), VeylError::BadAmount);
        let value = u64::from_be_bytes(pubs[2][24..].try_into().unwrap());
        require!(value > 0, VeylError::BadAmount);
        require!(p.is_known_root(&pubs[3]), VeylError::UnknownStateRoot);
        require!(p.is_known_asp_root(&pubs[4]), VeylError::StaleAspRoot);
        require!(in_field(&pubs[0]) && in_field(&pubs[1]), VeylError::BadField);
        require!(verifier::verify(&proof, &pubs), VeylError::BadProof);
        drop(p);
        // A posted spend is not a lock (REVIEW.md M-2): any newer valid proof for the same nullifier replaces one that has not
        // been executed, so nobody holding a copy of a proof (a relayer, or anyone after a failed attempt) can freeze the
        // note by posting it with a useless processor. The previous poster gets its rent back from the new one.
        let (status, prev) = (ctx.accounts.spend.status, ctx.accounts.spend.poster);
        require!(status != SPEND_SPENT, VeylError::AlreadySpent);
        if status == SPEND_POSTED {
            require_keys_eq!(ctx.accounts.prev_poster.key(), prev, VeylError::NotProcessor);
            if prev != ctx.accounts.poster.key() {
                // exactly the rent-exempt minimum: lamports someone donated to the PDA must not raise the price of replacing it
                let rent = Rent::get()?.minimum_balance(Spend::SIZE);
                anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer { from: ctx.accounts.poster.to_account_info(), to: ctx.accounts.prev_poster.to_account_info() }), rent)?;
            }
        }
        let s = &mut ctx.accounts.spend;
        s.pool = ctx.accounts.pool.key(); s.poster = ctx.accounts.poster.key(); s.processor = processor; s.status = SPEND_POSTED;
        s.nullifier_hash = pubs[1]; s.new_commitment = pubs[0]; s.value = value; s.asp_root = pubs[4]; s.context = pubs[5];
        s.expires_at = Clock::get()?.slot.checked_add(ttl_slots).ok_or(VeylError::BadParams)?; s.bump = ctx.bumps.spend;
        emit!(Posted { pool: s.pool, nullifier_hash: s.nullifier_hash, processor, value, expires_at: s.expires_at });
        Ok(())
    }

    /// Step 2: the processor executes the spend. `data` is the encoded action; hash(processor, data, pool) must equal
    /// the context inside the proof, so nobody (not even the relayer) can change what happens to the funds.
    /// Funds go to the processor's token account. EVM: withdraw(w, p).
    pub fn withdraw(ctx: Context<Withdraw>, data: Vec<u8>) -> Result<u64> {
        let pool_key = ctx.accounts.pool.key();
        let s = &mut ctx.accounts.spend;
        require!(s.status == SPEND_POSTED, VeylError::AlreadySpent);
        require_keys_eq!(s.processor, ctx.accounts.processor.key(), VeylError::NotProcessor);
        require!(context_of(&ctx.accounts.processor.key(), &data, &pool_key) == s.context, VeylError::BadContext);
        let index = {
            let mut p = ctx.accounts.pool.load_mut()?;
            require!(p.is_known_asp_root(&s.asp_root), VeylError::StaleAspRoot); // an emergency reset in between still bites
            let (index, _) = p.insert(&s.new_commitment)?;
            index
        };
        s.status = SPEND_SPENT;
        let value = s.value;
        let mint_key = ctx.accounts.mint.key(); let bump = [ctx.accounts.pool.load()?.bump];
        let signer: &[&[u8]] = &[b"pool", mint_key.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.processor_token.to_account_info(), authority: ctx.accounts.pool.to_account_info() }, &[signer]),
            value, ctx.accounts.mint.decimals)?;
        emit!(Withdrawn { pool: pool_key, processor: ctx.accounts.processor.key(), value, nullifier_hash: s.nullifier_hash, new_commitment: s.new_commitment, index });
        Ok(value)
    }

    /// Give up a posted spend that was never executed: by the poster at any time, by anyone once it has expired.
    /// Nothing was paid, the nullifier is free again and the rent goes back to the poster.
    pub fn cancel_post(ctx: Context<CancelPost>) -> Result<()> {
        let s = &ctx.accounts.spend;
        require!(s.status == SPEND_POSTED, VeylError::AlreadySpent);
        let by_poster = ctx.accounts.canceller.key() == s.poster;
        require!(by_poster || Clock::get()?.slot > s.expires_at, VeylError::NotExpired);
        Ok(())
    }

    /// Take an unspent deposit back to the beneficiary named at deposit. Public by design. EVM: ragequit.
    pub fn ragequit(ctx: Context<Ragequit>, value: u64, label: [u8; 32], nullifier: [u8; 32], secret: [u8; 32]) -> Result<()> {
        let rec = &ctx.accounts.deposit_record;
        require!(rec.label == label && rec.value == value, VeylError::BadNote);
        let pre = poseidon2(&nullifier, &secret)?;
        require!(poseidon3(&u64_to_field(value), &label, &pre)? == rec.commitment, VeylError::BadNote);
        let nh = poseidon1(&nullifier)?;
        let s = &mut ctx.accounts.spend;
        // The public exit also overrides a posted-but-unexecuted spend of this note (REVIEW.md M-2): nobody can block it by
        // parking a proof. That post's rent stays in the spent marker.
        require!(s.status != SPEND_SPENT, VeylError::AlreadySpent);
        s.pool = ctx.accounts.pool.key(); s.poster = ctx.accounts.beneficiary.key(); s.processor = Pubkey::default(); s.status = SPEND_SPENT;
        s.nullifier_hash = nh; s.new_commitment = [0u8; 32]; s.value = value; s.asp_root = [0u8; 32]; s.context = [0u8; 32]; s.expires_at = 0; s.bump = ctx.bumps.spend;
        let mint_key = ctx.accounts.mint.key(); let bump = [ctx.accounts.pool.load()?.bump];
        let signer: &[&[u8]] = &[b"pool", mint_key.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.beneficiary_token.to_account_info(), authority: ctx.accounts.pool.to_account_info() }, &[signer]),
            value, ctx.accounts.mint.decimals)?;
        emit!(RagequitEvent { pool: ctx.accounts.pool.key(), depositor: ctx.accounts.beneficiary.key(), label, value });
        Ok(())
    }

    // ============================================================================================ Phase 2: the shielded pool
    //
    // One tree for every asset (the per-mint trees above reveal the token by which tree a note is in, and hold the old note
    // format), notes with hidden amounts spent by transact proofs (2 in, 2 out), shielded liquidity positions spent by
    // position proofs. A proof is verified once in its own transaction (`post_proof`) and executed by the instruction that
    // moves the money, which checks its external data hash, root and nullifiers. Value enters only through a deposit
    // (held pending until the approved-set publisher lets it into the tree, refundable by its depositor until then), a
    // migration from a legacy note (already screened by its proof), or a receipt the entry program creates from a pool
    // action's public proceeds; it leaves only through a withdrawal whose amount is public.

    /// Create the shielded pool (the tree). Upgrade authority only (REVIEW.md H-1: it is a fixed address).
    pub fn init_shield(ctx: Context<InitShield>, postman: Pubkey) -> Result<()> {
        let mut s = ctx.accounts.shield.load_init()?;
        s.authority = ctx.accounts.authority.key(); s.postman = postman; s.bump = ctx.bumps.shield;
        let mut z = [0u8; 32];
        for i in 0..DEPTH { s.zeros[i] = z; s.filled[i] = z; z = poseidon2(&z, &z)?; }
        s.roots[0] = z; s.root_slot = 0;
        emit!(ShieldPostmanUpdated { postman });
        Ok(())
    }
    pub fn set_shield_postman(ctx: Context<ShieldAuthority>, postman: Pubkey) -> Result<()> { ctx.accounts.shield.load_mut()?.postman = postman; emit!(ShieldPostmanUpdated { postman }); Ok(()) }
    pub fn propose_shield_authority(ctx: Context<ShieldAuthority>, next: Pubkey) -> Result<()> { ctx.accounts.shield.load_mut()?.pending_authority = next; Ok(()) }
    pub fn accept_shield_authority(ctx: Context<AcceptShieldAuthority>) -> Result<()> {
        let mut s = ctx.accounts.shield.load_mut()?;
        require_keys_eq!(s.pending_authority, ctx.accounts.next.key(), VeylError::NotAuthority);
        s.authority = ctx.accounts.next.key(); s.pending_authority = Pubkey::default(); Ok(())
    }

    /// Verify a transact (kind 1) or position (kind 2) proof and park its public signals under ["proof", sha256(kind ||
    /// pubs)]. Posting is not a lock: nothing is spent until an execution consumes it, any number of proofs may spend the
    /// same notes (the first executed wins), and the same proof posted twice is the same account.
    pub fn post_proof(ctx: Context<PostProof>, kind: u8, proof: [u8; 256], pubs: [[u8; 32]; 8], ttl_slots: u64) -> Result<()> {
        require!(ttl_slots > 0 && ttl_slots <= MAX_POST_TTL_SLOTS, VeylError::BadParams);
        for p in pubs.iter() { require!(*p < SNARK_SCALAR_FIELD, VeylError::BadField); }
        let ok = match kind {
            KIND_TRANSACT => verifier::verify_with(&proof, &pubs, &vkey_transact::VERIFYING_KEY),
            KIND_POSITION => verifier::verify_with(&proof, &pubs, &vkey_position::VERIFYING_KEY),
            KIND_SWAP => verifier::verify_with(&proof, &pubs, &vkey_swap::VERIFYING_KEY),
            KIND_CLAIM => { require!(pubs[6] == [0u8; 32] && pubs[7] == [0u8; 32], VeylError::BadParams); let six: [[u8; 32]; 6] = pubs[..6].try_into().unwrap(); verifier::verify_with(&proof, &six, &vkey_claim::VERIFYING_KEY) }
            _ => return err!(VeylError::BadParams),
        };
        require!(ok, VeylError::BadProof);
        let p = &mut ctx.accounts.posted;
        p.poster = ctx.accounts.poster.key(); p.kind = kind; p.pubs = pubs; p.bump = ctx.bumps.posted;
        p.expires_at = Clock::get()?.slot.checked_add(ttl_slots).ok_or(VeylError::BadParams)?;
        emit!(ProofPosted { id: proof_id(kind, &pubs), kind, expires_at: p.expires_at });
        Ok(())
    }
    /// Free a posted proof that was never executed: its poster at any time, anyone once it expired (rent to the poster).
    pub fn cancel_proof(ctx: Context<CancelProof>) -> Result<()> {
        let p = &ctx.accounts.posted;
        require!(ctx.accounts.canceller.key() == p.poster || Clock::get()?.slot > p.expires_at, VeylError::NotExpired);
        Ok(())
    }

    /// Deposit: public tokens from the depositor's wallet into two new notes (a transact proof with publicAmount =
    /// ext_amount > 0, no fee). The notes wait outside the tree until the approved-set publisher admits them
    /// (`approve_deposit`); until then the depositor can take the deposit back (`cancel_deposit`). The amount, the token and
    /// the depositing wallet are public; who the notes belong to and how they are split are not.
    pub fn shield_deposit(ctx: Context<ShieldDeposit>, ext: TransactExt) -> Result<()> {
        require!(ext.ext_amount > 0 && ext.fee == 0, VeylError::BadAmount);
        require!(ext.processor == Pubkey::default() || ext.processor == ctx.accounts.depositor.key(), VeylError::NotProcessor);
        require_keys_eq!(ext.mint, ctx.accounts.mint.key(), VeylError::WrongMint);
        let pubs = { let s = ctx.accounts.shield.load()?; check_transact(&s, &ctx.accounts.posted, &ext, &asset_of(&ctx.accounts.mint.key()))? };
        let mut ev = Evs::new(); emit_ciphertexts(&mut ev, &[pubs[6], pubs[7]], &ext.enc_out);
        let amount = ext.ext_amount as u64;
        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.depositor_token.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.depositor.to_account_info() }), amount, ctx.accounts.mint.decimals)?;
        ctx.accounts.vault.reload()?;
        // the proof fixed the amount: a token that takes a transfer fee would leave the notes unbacked
        require!(ctx.accounts.vault.amount.checked_sub(before) == Some(amount), VeylError::BadAmount);
        use_nullifier(&ctx.accounts.nullifier0, &ctx.accounts.depositor.to_account_info(), &ctx.accounts.system_program, &pubs[4], &mut ev)?;
        use_nullifier(&ctx.accounts.nullifier1, &ctx.accounts.depositor.to_account_info(), &ctx.accounts.system_program, &pubs[5], &mut ev)?;
        let d = &mut ctx.accounts.pending;
        d.depositor = ctx.accounts.depositor.key(); d.mint = ext.mint; d.amount = amount; d.commitments = [pubs[6], pubs[7]]; d.slot = Clock::get()?.slot; d.bump = ctx.bumps.pending;
        { let mut s = ctx.accounts.shield.load_mut()?; s.pending_deposits += 1; }
        ev.push(&DepositPending { pending: ctx.accounts.pending.key(), depositor: ctx.accounts.depositor.key(), mint: ext.mint, amount, commitments: [pubs[6], pubs[7]], nullifiers: [pubs[4], pubs[5]] });
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }
    /// The approved-set publisher admits a pending deposit: its two notes enter the tree (rent back to the depositor).
    pub fn approve_deposit(ctx: Context<ApproveDeposit>) -> Result<()> {
        let d = &ctx.accounts.pending;
        let (i0, i1) = { let mut s = ctx.accounts.shield.load_mut()?;
            let (i0, _) = s.insert(&d.commitments[0])?; let (i1, _) = s.insert(&d.commitments[1])?;
            s.pending_deposits = s.pending_deposits.saturating_sub(1); (i0, i1) };
        let mut ev = Evs::new();
        ev.push(&NoteInserted { index: i0, commitment: d.commitments[0] }); ev.push(&NoteInserted { index: i1, commitment: d.commitments[1] });
        ev.push(&DepositApproved { pending: ctx.accounts.pending.key(), indexes: [i0, i1] });
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }
    /// The depositor takes a deposit back before it is admitted (the shielded pool's ragequit). Public by design.
    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        let amount = ctx.accounts.pending.amount;
        let bump = [ctx.accounts.shield.load()?.bump]; let signer: &[&[u8]] = &[SHIELD_SEED, &bump];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.depositor_token.to_account_info(), authority: ctx.accounts.shield.to_account_info() }, &[signer]), amount, ctx.accounts.mint.decimals)?;
        { let mut s = ctx.accounts.shield.load_mut()?; s.pending_deposits = s.pending_deposits.saturating_sub(1); }
        let mut ev = Evs::new(); ev.push(&DepositCancelled { pending: ctx.accounts.pending.key(), depositor: ctx.accounts.depositor.key(), amount });
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }

    /// Withdraw (ext_amount < 0: |ext_amount| to `ext.recipient`, a token account) or transfer inside the pool
    /// (ext_amount = 0), optionally paying the relayer `fee` from the pool. Submitted by anyone (the relayer), unless the
    /// proof names a processor. With fee 0 and no withdrawal the token is not revealed at all.
    pub fn shield_transact(ctx: Context<ShieldTransact>, ext: TransactExt) -> Result<()> {
        require!(ext.ext_amount <= 0, VeylError::BadAmount);
        require!(ext.processor == Pubkey::default() || ext.processor == ctx.accounts.submitter.key(), VeylError::NotProcessor);
        let moves = ext.ext_amount < 0 || ext.fee > 0;
        let asset = if moves { let m = ctx.accounts.mint.as_ref().ok_or(VeylError::WrongMint)?; require_keys_eq!(ext.mint, m.key(), VeylError::WrongMint); asset_of(&m.key()) } else { [0u8; 32] };
        let pubs = { let s = ctx.accounts.shield.load()?; check_transact(&s, &ctx.accounts.posted, &ext, &asset)? };
        let mut ev = Evs::new(); emit_ciphertexts(&mut ev, &[pubs[6], pubs[7]], &ext.enc_out);
        use_nullifier(&ctx.accounts.nullifier0, &ctx.accounts.submitter.to_account_info(), &ctx.accounts.system_program, &pubs[4], &mut ev)?;
        use_nullifier(&ctx.accounts.nullifier1, &ctx.accounts.submitter.to_account_info(), &ctx.accounts.system_program, &pubs[5], &mut ev)?;
        if moves {
            let (mint, vault, tp) = (ctx.accounts.mint.as_ref().unwrap(), ctx.accounts.vault.as_ref().ok_or(VeylError::WrongMint)?, ctx.accounts.token_program.as_ref().ok_or(VeylError::WrongTokenProgram)?);
            require_keys_eq!(vault.key(), anchor_spl::associated_token::get_associated_token_address_with_program_id(&ctx.accounts.shield.key(), &mint.key(), &tp.key()), VeylError::WrongMint);
            let bump = [ctx.accounts.shield.load()?.bump]; let signer: &[&[u8]] = &[SHIELD_SEED, &bump];
            if ext.ext_amount < 0 {
                let to = ctx.accounts.recipient_token.as_ref().ok_or(VeylError::WrongRecipient)?; require_keys_eq!(to.key(), ext.recipient, VeylError::WrongRecipient);
                shield_out(tp, vault, mint, to, &ctx.accounts.shield.to_account_info(), signer, ext.ext_amount.unsigned_abs())?;
            }
            if ext.fee > 0 {
                let to = ctx.accounts.relayer_token.as_ref().ok_or(VeylError::WrongRecipient)?; require_keys_eq!(to.key(), ext.relayer, VeylError::WrongRecipient);
                shield_out(tp, vault, mint, to, &ctx.accounts.shield.to_account_info(), signer, ext.fee)?;
            }
        }
        insert_outputs(&mut ev, &ctx.accounts.shield, &pubs)?;
        emit!(Transacted { nullifiers: [pubs[4], pubs[5]], mint: if moves { ext.mint } else { Pubkey::default() }, ext_amount: ext.ext_amount, fee: ext.fee });
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }

    /// A spend that funds an entry-program action (processor = the entry's signer PDA): |ext_amount| goes to the
    /// processor's token account (or, for a virtual asset such as limit-order shares, nowhere: the entry burns them
    /// itself). Returns |ext_amount|. The entry checks `ext.action` is the action it is executing.
    pub fn transact_cpi(ctx: Context<TransactCpi>, ext: TransactExt, virtual_asset: Option<[u8; 32]>) -> Result<u64> {
        require_keys_eq!(ctx.accounts.processor.key(), entry_signer(), VeylError::NotProcessor);
        require_keys_eq!(ext.processor, ctx.accounts.processor.key(), VeylError::NotProcessor);
        require!(ext.ext_amount <= 0, VeylError::BadAmount);
        let asset = match virtual_asset {
            Some(a) => { require!(ext.fee == 0 && ext.mint == Pubkey::default(), VeylError::BadParams); a }
            None => { let m = ctx.accounts.mint.as_ref().ok_or(VeylError::WrongMint)?; require_keys_eq!(ext.mint, m.key(), VeylError::WrongMint); asset_of(&m.key()) }
        };
        let pubs = { let s = ctx.accounts.shield.load()?; check_transact(&s, &ctx.accounts.posted, &ext, &asset)? };
        let mut ev = Evs::new(); emit_ciphertexts(&mut ev, &[pubs[6], pubs[7]], &ext.enc_out);
        use_nullifier(&ctx.accounts.nullifier0, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program, &pubs[4], &mut ev)?;
        use_nullifier(&ctx.accounts.nullifier1, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program, &pubs[5], &mut ev)?;
        let amount = ext.ext_amount.unsigned_abs();
        if virtual_asset.is_none() && (amount > 0 || ext.fee > 0) {
            let (mint, vault, tp) = (ctx.accounts.mint.as_ref().unwrap(), ctx.accounts.vault.as_ref().ok_or(VeylError::WrongMint)?, ctx.accounts.token_program.as_ref().ok_or(VeylError::WrongTokenProgram)?);
            require_keys_eq!(vault.key(), anchor_spl::associated_token::get_associated_token_address_with_program_id(&ctx.accounts.shield.key(), &mint.key(), &tp.key()), VeylError::WrongMint);
            let bump = [ctx.accounts.shield.load()?.bump]; let signer: &[&[u8]] = &[SHIELD_SEED, &bump];
            if amount > 0 { let to = ctx.accounts.processor_token.as_ref().ok_or(VeylError::WrongRecipient)?; require_keys_eq!(to.key(), ext.recipient, VeylError::WrongRecipient); shield_out(tp, vault, mint, to, &ctx.accounts.shield.to_account_info(), signer, amount)?; }
            if ext.fee > 0 { let to = ctx.accounts.relayer_token.as_ref().ok_or(VeylError::WrongRecipient)?; require_keys_eq!(to.key(), ext.relayer, VeylError::WrongRecipient); shield_out(tp, vault, mint, to, &ctx.accounts.shield.to_account_info(), signer, ext.fee)?; }
        }
        insert_outputs(&mut ev, &ctx.accounts.shield, &pubs)?;
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)?;
        // (no Transacted here: the entry program's action event describes the action, and every leg's copy cost ~174 of
        //  the ~10 KB a transaction may log; the nullifiers are in Nullified, the amounts in the instruction data)
        Ok(amount)
    }

    /// Execute a posted position proof for the entry program (which has already checked its window, bundle and action):
    /// spend the old position note, insert the new one and the fee notes it claimed (a zero commitment = nothing claimed).
    /// `ciphertext` = the new position note's encrypted copy (in the request the proof's extDataHash commits to; the entry
    /// checked that): emitted as PositionCiphertext with the tree's other events.
    pub fn consume_position(ctx: Context<ConsumePosition>, ext_hash: [u8; 32], ciphertext: Vec<u8>) -> Result<()> {
        require_keys_eq!(ctx.accounts.processor.key(), entry_signer(), VeylError::NotProcessor);
        let p = &ctx.accounts.posted; require!(p.kind == KIND_POSITION, VeylError::BadParams);
        let pubs = p.pubs;
        require!(pubs[7] == ext_hash, VeylError::BadContext);
        { let s = ctx.accounts.shield.load()?; require!(s.is_known_root(&pubs[0]), VeylError::UnknownStateRoot); }
        require!(in_field(&pubs[2]) && ciphertext.len() <= MAX_POSITION_CIPHERTEXT, VeylError::BadField);
        let mut ev = Evs::new(); if !ciphertext.is_empty() { ev.quiet(&PositionCiphertext { commitment: pubs[2], data: ciphertext }); }
        use_nullifier(&ctx.accounts.nullifier, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program, &pubs[1], &mut ev)?;
        { let mut s = ctx.accounts.shield.load_mut()?;
          for c in [pubs[2], pubs[5], pubs[6]] { if c != [0u8; 32] { require!(in_field(&c), VeylError::BadField); let (i, _) = s.insert(&c)?; ev.push(&NoteInserted { index: i, commitment: c }); } } }
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }

    /// A note whose amount is public: the entry program pays `amount` of a token from its token account into the vault
    /// (or, for a virtual asset, nothing: the entry holds what backs it), for a one-time owner key and blinding that are
    /// public too. Swap outputs, removal proceeds and order shares come back this way; only the owner's spending key is
    /// secret, so the note can later be spent (and merged out of sight) like any other.
    pub fn deposit_receipt(ctx: Context<DepositReceipt>, virtual_asset: Option<[u8; 32]>, amount: u64, owner: [u8; 32], blinding: [u8; 32]) -> Result<()> {
        require_keys_eq!(ctx.accounts.processor.key(), entry_signer(), VeylError::NotProcessor);
        require!(amount > 0 && in_field(&owner) && blinding < SNARK_SCALAR_FIELD, VeylError::BadAmount);
        let asset = match virtual_asset {
            Some(a) => a,
            None => {
                let (mint, vault, tp) = (ctx.accounts.mint.as_ref().ok_or(VeylError::WrongMint)?, ctx.accounts.vault.as_ref().ok_or(VeylError::WrongMint)?, ctx.accounts.token_program.as_ref().ok_or(VeylError::WrongTokenProgram)?);
                require_keys_eq!(vault.key(), anchor_spl::associated_token::get_associated_token_address_with_program_id(&ctx.accounts.shield.key(), &mint.key(), &tp.key()), VeylError::WrongMint);
                asset_of(&mint.key())
            }
        };
        let commitment = poseidon(&[&asset, &u64_to_field(amount), &owner, &blinding])?;
        let (index, _) = ctx.accounts.shield.load_mut()?.insert(&commitment)?;
        let mut ev = Evs::new();
        ev.push(&NoteInserted { index, commitment });
        ev.push(&ReceiptNote { index, commitment, asset, amount, owner, blinding });
        // the note is logged before the transfer's CPI (log truncation); the transaction fails as a whole if the transfer does
        if virtual_asset.is_none() {
            let (mint, vault, tp, from) = (ctx.accounts.mint.as_ref().unwrap(), ctx.accounts.vault.as_ref().unwrap(), ctx.accounts.token_program.as_ref().unwrap(), ctx.accounts.processor_token.as_ref().ok_or(VeylError::WrongRecipient)?);
            token_interface::transfer_checked(CpiContext::new(tp.to_account_info(), TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: vault.to_account_info(), authority: ctx.accounts.processor.to_account_info() }), amount, mint.decimals)?;
        }
        // (no return value: the index is in the events, and the runtime logs any return data as one more line)
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }

    /// Pay `amount` of a token out of the vault to the entry program (the shielded liquidity fee pot: relayer fees taken
    /// from claims, and fees a removal is owed for the moment it was in the pool). Processor only.
    pub fn shield_pay(ctx: Context<ShieldPay>, amount: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.processor.key(), entry_signer(), VeylError::NotProcessor);
        if amount == 0 { return Ok(()); }
        require_keys_eq!(ctx.accounts.vault.key(), anchor_spl::associated_token::get_associated_token_address_with_program_id(&ctx.accounts.shield.key(), &ctx.accounts.mint.key(), &ctx.accounts.token_program.key()), VeylError::WrongMint);
        let bump = [ctx.accounts.shield.load()?.bump]; let signer: &[&[u8]] = &[SHIELD_SEED, &bump];
        shield_out(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.mint, &ctx.accounts.to, &ctx.accounts.shield.to_account_info(), signer, amount)
    }

    // ============================================================================================ Phase 3: sealed swaps
    /// Execute a posted swap proof for the entry program (which has checked its batch, bundle and request): spend the two
    /// input notes, insert the change note and the swap commitment, pay the relayer's flat fee out of the vault of the token
    /// sold. pubs = [root, nullifier0, nullifier1, change, swapCommitment, batchKey, bundle, extDataHash].
    pub fn consume_swap(ctx: Context<ConsumeSealed>, ext_hash: [u8; 32], fee: u64, enc: Vec<Vec<u8>>) -> Result<()> {
        require_keys_eq!(ctx.accounts.processor.key(), entry_signer(), VeylError::NotProcessor);
        let p = &ctx.accounts.posted; require!(p.kind == KIND_SWAP, VeylError::BadParams);
        let pubs = p.pubs;
        require!(pubs[7] == ext_hash, VeylError::BadContext);
        { let s = ctx.accounts.shield.load()?; require!(s.is_known_root(&pubs[0]), VeylError::UnknownStateRoot); }
        require!(in_field(&pubs[1]) && in_field(&pubs[2]) && in_field(&pubs[3]) && in_field(&pubs[4]), VeylError::BadField);
        require!(enc.len() == 2 && enc.iter().all(|c| c.len() <= MAX_CIPHERTEXT), VeylError::BadParams);
        let mut ev = Evs::new(); emit_ciphertexts(&mut ev, &[pubs[3], pubs[4]], &enc);
        use_nullifier(&ctx.accounts.nullifier0, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program, &pubs[1], &mut ev)?;
        use_nullifier(ctx.accounts.nullifier1.as_ref().ok_or(VeylError::BadParams)?, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program, &pubs[2], &mut ev)?;
        sealed_fee(&ctx, fee)?;
        { let mut s = ctx.accounts.shield.load_mut()?;
          for c in [pubs[3], pubs[4]] { let (i, _) = s.insert(&c)?; ev.push(&NoteInserted { index: i, commitment: c }); } }
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }
    /// Execute a posted claim proof for the entry program (which has checked the batch's settlement or refund in the bundle):
    /// spend the swap commitment, insert the output note, pay the relayer's flat fee out of the vault of the token received.
    /// pubs = [root, nullifier, outCommitment, batchKey, bundle, extDataHash, 0, 0].
    pub fn consume_claim(ctx: Context<ConsumeSealed>, ext_hash: [u8; 32], fee: u64, enc: Vec<Vec<u8>>) -> Result<()> {
        require_keys_eq!(ctx.accounts.processor.key(), entry_signer(), VeylError::NotProcessor);
        let p = &ctx.accounts.posted; require!(p.kind == KIND_CLAIM, VeylError::BadParams);
        let pubs = p.pubs;
        require!(pubs[5] == ext_hash, VeylError::BadContext);
        { let s = ctx.accounts.shield.load()?; require!(s.is_known_root(&pubs[0]), VeylError::UnknownStateRoot); }
        require!(in_field(&pubs[1]) && in_field(&pubs[2]), VeylError::BadField);
        require!(enc.len() == 1 && enc[0].len() <= MAX_CIPHERTEXT, VeylError::BadParams);
        require!(ctx.accounts.nullifier1.is_none(), VeylError::BadParams);
        let mut ev = Evs::new(); emit_ciphertexts(&mut ev, &[pubs[2]], &enc);
        use_nullifier(&ctx.accounts.nullifier0, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program, &pubs[1], &mut ev)?;
        sealed_fee(&ctx, fee)?;
        let (i, _) = ctx.accounts.shield.load_mut()?.insert(&pubs[2])?; ev.push(&NoteInserted { index: i, commitment: pubs[2] });
        ev.flush(&ctx.accounts.event_authority, ctx.bumps.event_authority)
    }
}

/// The relayer's flat fee of a sealed swap or claim, paid out of the shielded pool's vault of `mint`.
fn sealed_fee(ctx: &Context<ConsumeSealed>, fee: u64) -> Result<()> {
    if fee == 0 { return Ok(()); }
    let a = &ctx.accounts;
    let (mint, vault, to, tp) = (a.mint.as_ref().ok_or(VeylError::WrongMint)?, a.vault.as_ref().ok_or(VeylError::WrongMint)?, a.relayer_token.as_ref().ok_or(VeylError::WrongRecipient)?, a.token_program.as_ref().ok_or(VeylError::WrongTokenProgram)?);
    require_keys_eq!(vault.key(), anchor_spl::associated_token::get_associated_token_address_with_program_id(&a.shield.key(), &mint.key(), &tp.key()), VeylError::WrongMint);
    let bump = [a.shield.load()?.bump]; let signer: &[&[u8]] = &[SHIELD_SEED, &bump];
    shield_out(tp, vault, mint, to, &a.shield.to_account_info(), signer, fee)
}

// ------------------------------------------------------------------------------------------------ state

/// One private pool. Zero-copy: 7 KB (the tree's filled subtrees, zero hashes, the 128-root ring and the ASP ring).
#[account(zero_copy)]
#[repr(C)]
pub struct Pool {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub postman: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub token_program: Pubkey,
    pub min_deposit: u64,
    pub deposit_nonce: u64,
    pub next_index: u64,
    pub current_root_index: u64,
    pub asp_index: u64,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub asp_root: [u8; 32],
    pub asp_roots: [[u8; 32]; ASP_HISTORY],
    pub zeros: [[u8; 32]; DEPTH],
    pub filled: [[u8; 32]; DEPTH],
    pub roots: [[u8; 32]; ROOT_HISTORY],
    /// Slot in which roots[current_root_index] was written.
    pub root_slot: u64,
}
/// StateTree._insert: fixed-depth incremental Merkle tree, empty leaves are 0, node = Poseidon(left, right). Shared by the
/// per-mint pools and the Phase 2 shielded tree. One history entry per slot: a later insert in the same slot updates it
/// (clients only ever see end-of-slot roots), so a burst of inserts cannot flush the roots proofs use (REVIEW.md M-4).
pub fn tree_insert(next_index: &mut u64, current_root_index: &mut u64, root_slot: &mut u64, zeros: &[[u8; 32]; DEPTH], filled: &mut [[u8; 32]; DEPTH], roots: &mut [[u8; 32]; ROOT_HISTORY], leaf: &[u8; 32]) -> Result<(u64, [u8; 32])> {
    let index = *next_index;
    require!(index < (1u64 << DEPTH), VeylError::TreeFull);
    let mut node = *leaf; let mut idx = index;
    for i in 0..DEPTH {
        if idx & 1 == 0 { filled[i] = node; node = poseidon2(&node, &zeros[i])?; } else { node = poseidon2(&filled[i], &node)?; }
        idx >>= 1;
    }
    let slot = Clock::get()?.slot;
    if slot != *root_slot { *current_root_index = (*current_root_index + 1) % ROOT_HISTORY as u64; *root_slot = slot; }
    roots[*current_root_index as usize] = node; *next_index = index + 1;
    Ok((index, node))
}

impl Pool {
    pub const SIZE: usize = 8 + 6 * 32 + 5 * 8 + 8 + 32 + 32 * ASP_HISTORY + 32 * DEPTH * 2 + 32 * ROOT_HISTORY + 8;
    pub fn insert(&mut self, leaf: &[u8; 32]) -> Result<(u64, [u8; 32])> {
        tree_insert(&mut self.next_index, &mut self.current_root_index, &mut self.root_slot, &self.zeros, &mut self.filled, &mut self.roots, leaf)
    }
    pub fn current_root(&self) -> [u8; 32] { self.roots[self.current_root_index as usize] }
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool { root.iter().any(|b| *b != 0) && self.roots.iter().any(|r| r == root) }
    pub fn is_known_asp_root(&self, root: &[u8; 32]) -> bool { root.iter().any(|b| *b != 0) && self.asp_roots.iter().any(|r| r == root) }
}

/// EVM `depositorOf[label]` + `depositOf[label]`; closed (rent back to the beneficiary) on ragequit.
#[account]
pub struct DepositRecord { pub pool: Pubkey, pub beneficiary: Pubkey, pub label: [u8; 32], pub commitment: [u8; 32], pub value: u64, pub bump: u8 }
impl DepositRecord { pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1; }

/// EVM `spent[nullifierHash]`, plus the posted-proof parking space. Its existence is the spent flag.
#[account]
pub struct Spend {
    pub pool: Pubkey, pub poster: Pubkey, pub processor: Pubkey, pub status: u8,
    pub nullifier_hash: [u8; 32], pub new_commitment: [u8; 32], pub value: u64, pub asp_root: [u8; 32], pub context: [u8; 32],
    pub expires_at: u64, pub bump: u8,
}
impl Spend { pub const SIZE: usize = 8 + 32 * 3 + 1 + 32 + 32 + 8 + 32 + 32 + 8 + 1; }

/// Phase 2: the shielded pool. One tree for every asset (same depth, zero hashes and per-slot root history as the per-mint
/// trees). Its token vaults are its associated token accounts. Zero-copy, 8.3 KB.
#[account(zero_copy)]
#[repr(C)]
pub struct Shield {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub postman: Pubkey,
    pub next_index: u64,
    pub current_root_index: u64,
    pub root_slot: u64,
    pub pending_deposits: u64,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub zeros: [[u8; 32]; DEPTH],
    pub filled: [[u8; 32]; DEPTH],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}
impl Shield {
    pub const SIZE: usize = 8 + 3 * 32 + 4 * 8 + 8 + 32 * DEPTH * 2 + 32 * ROOT_HISTORY;
    pub fn insert(&mut self, leaf: &[u8; 32]) -> Result<(u64, [u8; 32])> {
        tree_insert(&mut self.next_index, &mut self.current_root_index, &mut self.root_slot, &self.zeros, &mut self.filled, &mut self.roots, leaf)
    }
    pub fn current_root(&self) -> [u8; 32] { self.roots[self.current_root_index as usize] }
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool { root.iter().any(|b| *b != 0) && self.roots.iter().any(|r| r == root) }
}
/// A verified proof waiting to be executed (Phase 2). `kind` 1 = transact, 2 = position.
#[account]
pub struct PostedProof { pub poster: Pubkey, pub kind: u8, pub expires_at: u64, pub pubs: [[u8; 32]; 8], pub bump: u8 }
impl PostedProof { pub const SIZE: usize = 8 + 32 + 1 + 8 + 256 + 1; }
/// A deposit waiting for the approved-set publisher.
#[account]
pub struct PendingDeposit { pub depositor: Pubkey, pub mint: Pubkey, pub amount: u64, pub commitments: [[u8; 32]; 2], pub slot: u64, pub bump: u8 }
impl PendingDeposit { pub const SIZE: usize = 8 + 32 + 32 + 8 + 64 + 8 + 1; }

// ------------------------------------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    /// Only this program's upgrade authority may create (list) a pool: the pool for a mint is a fixed address, so whoever
    /// creates it first would own its approved-set publisher for good (REVIEW.md H-1).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ VeylError::NotAuthority)]
    pub program: Program<'info, crate::program::VeylPool>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ VeylError::NotAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = authority, space = Pool::SIZE, seeds = [b"pool", mint.key().as_ref()], bump)] pub pool: AccountLoader<'info, Pool>,
    /// init_if_needed: anyone can create the pool's associated token account in advance; that must not block the listing
    /// (REVIEW.md M-3). An existing account is checked to be exactly that ATA.
    #[account(init_if_needed, payer = authority, associated_token::mint = mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct OnlyAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, constraint = pool.load()?.authority == authority.key() @ VeylError::NotAuthority)] pub pool: AccountLoader<'info, Pool>,
}
#[derive(Accounts)]
pub struct AcceptAuthority<'info> { pub next: Signer<'info>, #[account(mut)] pub pool: AccountLoader<'info, Pool> }
#[derive(Accounts)]
pub struct OnlyPostman<'info> {
    pub postman: Signer<'info>,
    #[account(mut, constraint = pool.load()?.postman == postman.key() @ VeylError::OnlyPostman)] pub pool: AccountLoader<'info, Pool>,
}
#[derive(Accounts)]
#[instruction(amount: u64, precommitment: [u8; 32], beneficiary: Pubkey)]
pub struct Deposit<'info> {
    /// The token owner (EVM msg.sender). Separate from `rent_payer` so the entry program's signer PDA can deposit
    /// swap proceeds while the relayer pays the deposit record's rent.
    pub payer: Signer<'info>,
    #[account(mut)] pub rent_payer: Signer<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump = pool.load()?.bump)] pub pool: AccountLoader<'info, Pool>,
    #[account(address = pool.load()?.mint @ VeylError::WrongMint)] pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = pool.load()?.vault @ VeylError::WrongMint)] pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)] pub payer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = rent_payer, space = DepositRecord::SIZE, seeds = [b"dep".as_ref(), pool.key().as_ref(), label_of(&pool.key(), pool.load()?.deposit_nonce + 1).as_ref()], bump)]
    pub deposit_record: Account<'info, DepositRecord>,
    #[account(address = pool.load()?.token_program @ VeylError::WrongTokenProgram)] pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(proof: [u8; 256], pubs: [[u8; 32]; 6])]
pub struct PostWithdrawal<'info> {
    #[account(mut)] pub poster: Signer<'info>,
    pub pool: AccountLoader<'info, Pool>,
    #[account(init_if_needed, payer = poster, space = Spend::SIZE, seeds = [b"null".as_ref(), pool.key().as_ref(), pubs[1].as_ref()], bump)] pub spend: Account<'info, Spend>,
    /// CHECK: when this post replaces an unexecuted one, its poster (refunded the rent); otherwise any account (the poster).
    #[account(mut)] pub prev_poster: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub processor: Signer<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump = pool.load()?.bump)] pub pool: AccountLoader<'info, Pool>,
    #[account(address = pool.load()?.mint @ VeylError::WrongMint)] pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = pool.load()?.vault @ VeylError::WrongMint)] pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, has_one = pool @ VeylError::UnknownPool, seeds = [b"null".as_ref(), pool.key().as_ref(), spend.nullifier_hash.as_ref()], bump = spend.bump)] pub spend: Account<'info, Spend>,
    #[account(mut, token::mint = mint, token::token_program = token_program)] pub processor_token: InterfaceAccount<'info, TokenAccount>,
    #[account(address = pool.load()?.token_program @ VeylError::WrongTokenProgram)] pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct CancelPost<'info> {
    pub canceller: Signer<'info>,
    /// CHECK: receives the rent; must be the account that posted
    #[account(mut, address = spend.poster @ VeylError::NotProcessor)] pub poster: UncheckedAccount<'info>,
    #[account(mut, close = poster, seeds = [b"null".as_ref(), spend.pool.as_ref(), spend.nullifier_hash.as_ref()], bump = spend.bump)] pub spend: Account<'info, Spend>,
}
#[derive(Accounts)]
#[instruction(value: u64, label: [u8; 32], nullifier: [u8; 32])]
pub struct Ragequit<'info> {
    #[account(mut)] pub beneficiary: Signer<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump = pool.load()?.bump)] pub pool: AccountLoader<'info, Pool>,
    #[account(address = pool.load()?.mint @ VeylError::WrongMint)] pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = pool.load()?.vault @ VeylError::WrongMint)] pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, close = beneficiary, has_one = pool @ VeylError::UnknownPool, has_one = beneficiary @ VeylError::NotDepositor, seeds = [b"dep".as_ref(), pool.key().as_ref(), label.as_ref()], bump = deposit_record.bump)]
    pub deposit_record: Account<'info, DepositRecord>,
    #[account(init_if_needed, payer = beneficiary, space = Spend::SIZE, seeds = [b"null".as_ref(), pool.key().as_ref(), poseidon1(&nullifier)?.as_ref()], bump)] pub spend: Account<'info, Spend>,
    #[account(mut, token::mint = mint, token::token_program = token_program)] pub beneficiary_token: InterfaceAccount<'info, TokenAccount>,
    #[account(address = pool.load()?.token_program @ VeylError::WrongTokenProgram)] pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}


// ---- Phase 2 accounts
#[derive(Accounts)]
pub struct InitShield<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ VeylError::NotAuthority)]
    pub program: Program<'info, crate::program::VeylPool>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ VeylError::NotAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = Shield::SIZE, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ShieldAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump, constraint = shield.load()?.authority == authority.key() @ VeylError::NotAuthority)] pub shield: AccountLoader<'info, Shield>,
}
#[derive(Accounts)]
pub struct AcceptShieldAuthority<'info> { pub next: Signer<'info>, #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield> }
#[derive(Accounts)]
#[instruction(kind: u8, proof: [u8; 256], pubs: [[u8; 32]; 8])]
pub struct PostProof<'info> {
    #[account(mut)] pub poster: Signer<'info>,
    #[account(init, payer = poster, space = PostedProof::SIZE, seeds = [b"proof".as_ref(), proof_id(kind, &pubs).as_ref()], bump)] pub posted: Account<'info, PostedProof>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CancelProof<'info> {
    pub canceller: Signer<'info>,
    /// CHECK: receives the rent; must be the poster
    #[account(mut, address = posted.poster @ VeylError::NotProcessor)] pub poster: UncheckedAccount<'info>,
    #[account(mut, close = poster)] pub posted: Account<'info, PostedProof>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct ShieldDeposit<'info> {
    #[account(mut)] pub depositor: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    #[account(mut, close = poster)] pub posted: Box<Account<'info, PostedProof>>,
    /// CHECK: gets the posted proof's rent back
    #[account(mut, address = posted.poster @ VeylError::NotProcessor)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA, created here (use_nullifier checks the address)
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier1: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = shield, associated_token::token_program = token_program)] pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)] pub depositor_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = depositor, space = PendingDeposit::SIZE, seeds = [b"pend".as_ref(), posted.pubs[6].as_ref()], bump)] pub pending: Box<Account<'info, PendingDeposit>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct ApproveDeposit<'info> {
    pub postman: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump, constraint = shield.load()?.postman == postman.key() @ VeylError::OnlyPostman)] pub shield: AccountLoader<'info, Shield>,
    /// CHECK: the depositor, gets the pending record's rent back
    #[account(mut, address = pending.depositor @ VeylError::NotDepositor)] pub depositor: UncheckedAccount<'info>,
    #[account(mut, close = depositor)] pub pending: Account<'info, PendingDeposit>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    #[account(mut, address = pending.depositor @ VeylError::NotDepositor)] pub depositor: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    #[account(mut, close = depositor)] pub pending: Account<'info, PendingDeposit>,
    #[account(address = pending.mint @ VeylError::WrongMint)] pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = shield, associated_token::token_program = token_program)] pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)] pub depositor_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct ShieldTransact<'info> {
    #[account(mut)] pub submitter: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    #[account(mut, close = poster)] pub posted: Box<Account<'info, PostedProof>>,
    /// CHECK: gets the posted proof's rent back
    #[account(mut, address = posted.poster @ VeylError::NotProcessor)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier1: UncheckedAccount<'info>,
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut)] pub vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)] pub recipient_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)] pub relayer_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub system_program: Program<'info, System>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct TransactCpi<'info> {
    pub processor: Signer<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    #[account(mut, close = poster)] pub posted: Box<Account<'info, PostedProof>>,
    /// CHECK: gets the posted proof's rent back
    #[account(mut, address = posted.poster @ VeylError::NotProcessor)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier1: UncheckedAccount<'info>,
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut)] pub vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)] pub processor_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)] pub relayer_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub system_program: Program<'info, System>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct ConsumePosition<'info> {
    pub processor: Signer<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    #[account(mut, close = poster)] pub posted: Box<Account<'info, PostedProof>>,
    /// CHECK: gets the posted proof's rent back
    #[account(mut, address = posted.poster @ VeylError::NotProcessor)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA
    #[account(mut)] pub nullifier: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct DepositReceipt<'info> {
    pub processor: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut)] pub vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)] pub processor_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
}
/// Phase 3: a sealed swap (two nullifiers) or claim (one) executed for the entry program. The
/// entry checks which token `mint` must be (the one sold, or the one received) before calling.
#[event_cpi]
#[derive(Accounts)]
pub struct ConsumeSealed<'info> {
    pub processor: Signer<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    #[account(mut, close = poster)] pub posted: Box<Account<'info, PostedProof>>,
    /// CHECK: gets the posted proof's rent back
    #[account(mut, address = posted.poster @ VeylError::NotProcessor)] pub poster: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA (use_nullifier checks the address)
    #[account(mut)] pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: nullifier PDA (a swap's second input; none for a claim)
    #[account(mut)] pub nullifier1: Option<UncheckedAccount<'info>>,
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut)] pub vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)] pub relayer_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ShieldPay<'info> {
    pub processor: Signer<'info>,
    #[account(seeds = [SHIELD_SEED], bump)] pub shield: AccountLoader<'info, Shield>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)] pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint)] pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------------------------------------ events / errors

#[event] pub struct Deposited { pub pool: Pubkey, pub beneficiary: Pubkey, pub payer: Pubkey, pub commitment: [u8; 32], pub label: [u8; 32], pub value: u64, pub precommitment: [u8; 32], pub index: u64 }
#[event] pub struct Posted { pub pool: Pubkey, pub nullifier_hash: [u8; 32], pub processor: Pubkey, pub value: u64, pub expires_at: u64 }
#[event] pub struct Withdrawn { pub pool: Pubkey, pub processor: Pubkey, pub value: u64, pub nullifier_hash: [u8; 32], pub new_commitment: [u8; 32], pub index: u64 }
#[event] pub struct RagequitEvent { pub pool: Pubkey, pub depositor: Pubkey, pub label: [u8; 32], pub value: u64 }
#[event] pub struct AspRootUpdated { pub pool: Pubkey, pub root: [u8; 32], pub ipfs_cid: String }
#[event] pub struct PostmanUpdated { pub pool: Pubkey, pub postman: Pubkey }
#[event] pub struct ShieldPostmanUpdated { pub postman: Pubkey }
#[event] pub struct ProofPosted { pub id: [u8; 32], pub kind: u8, pub expires_at: u64 }
#[event] pub struct NoteInserted { pub index: u64, pub commitment: [u8; 32] }
#[event] pub struct NoteCiphertext { pub commitment: [u8; 32], pub data: Vec<u8> }
/// A shielded position note's payload (until this program had its event CPI, veyl_entry logged it itself; same event name,
/// so the same discriminator and format).
#[event] pub struct PositionCiphertext { pub commitment: [u8; 32], pub data: Vec<u8> }
#[event] pub struct ReceiptNote { pub index: u64, pub commitment: [u8; 32], pub asset: [u8; 32], pub amount: u64, pub owner: [u8; 32], pub blinding: [u8; 32] }
#[event] pub struct Nullified { pub nullifier: [u8; 32] }
#[event] pub struct Transacted { pub nullifiers: [[u8; 32]; 2], pub mint: Pubkey, pub ext_amount: i64, pub fee: u64 }
#[event] pub struct DepositPending { pub pending: Pubkey, pub depositor: Pubkey, pub mint: Pubkey, pub amount: u64, pub commitments: [[u8; 32]; 2], pub nullifiers: [[u8; 32]; 2] }
#[event] pub struct DepositApproved { pub pending: Pubkey, pub indexes: [u64; 2] }
#[event] pub struct DepositCancelled { pub pending: Pubkey, pub depositor: Pubkey, pub amount: u64 }

#[error_code]
pub enum VeylError {
    #[msg("only the postman")] OnlyPostman,
    #[msg("only the authority")] NotAuthority,
    #[msg("bad amount")] BadAmount,
    #[msg("not a field element")] BadField,
    #[msg("bad params")] BadParams,
    #[msg("not the processor")] NotProcessor,
    #[msg("context mismatch")] BadContext,
    #[msg("unknown state root")] UnknownStateRoot,
    #[msg("stale approved-set root")] StaleAspRoot,
    #[msg("already spent")] AlreadySpent,
    #[msg("bad proof")] BadProof,
    #[msg("not the depositor")] NotDepositor,
    #[msg("bad note")] BadNote,
    #[msg("tree full")] TreeFull,
    #[msg("wrong mint")] WrongMint,
    #[msg("wrong token program")] WrongTokenProgram,
    #[msg("unknown pool")] UnknownPool,
    #[msg("posted spend has not expired")] NotExpired,
    #[msg("wrong recipient account")] WrongRecipient,
}
