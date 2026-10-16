//! Groth16 verification with the alt_bn128 syscalls (groth16-solana, Light Protocol). The verifying key in `vkey.rs` is
//! generated from the unchanged snarkjs `withdraw_vkey.json`; the proof layout is the one the EVM verifier took.
use crate::vkey::{NR_PUBLIC_INPUTS, VERIFYING_KEY};
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

/// BN254 base field modulus q (big-endian): the y coordinate of a G1 point lives in this field.
const BASE_FIELD: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x97, 0x81, 0x6a, 0x91,
    0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// q - y (big-endian, 32 bytes). y must be < q, which the pairing syscall checks for us anyway.
fn neg_fq(y: &[u8; 32]) -> [u8; 32] {
    if y.iter().all(|b| *b == 0) { return *y; }
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = BASE_FIELD[i] as i16 - y[i] as i16 - borrow;
        if d < 0 { out[i] = (d + 256) as u8; borrow = 1; } else { out[i] = d as u8; borrow = 0; }
    }
    out
}

/// `proof` = A (64) | B (128) | C (64) as the EVM verifier takes them; `pubs` = the 6 public signals, big-endian.
/// groth16-solana checks e(-A, B) · e(alpha, beta) · e(inputs, gamma) · e(C, delta) == 1, so A's y is negated here
/// rather than asking every client to do it.
pub fn verify(proof: &[u8; 256], pubs: &[[u8; 32]; NR_PUBLIC_INPUTS]) -> bool { verify_with(proof, pubs, &VERIFYING_KEY) }

/// The same check for any circuit: Phase 2's transact and position circuits (8 public signals each, keys in
/// `vkey_transact.rs` / `vkey_position.rs`, generated the same way from their snarkjs verification keys).
pub fn verify_with<const N: usize>(proof: &[u8; 256], pubs: &[[u8; 32]; N], vk: &Groth16Verifyingkey) -> bool {
    if vk.nr_pubinputs != N { return false; }
    let mut a = [0u8; 64];
    a[..32].copy_from_slice(&proof[..32]);
    let y: [u8; 32] = proof[32..64].try_into().unwrap();
    a[32..].copy_from_slice(&neg_fq(&y));
    let b: [u8; 128] = proof[64..192].try_into().unwrap();
    let c: [u8; 64] = proof[192..256].try_into().unwrap();
    match Groth16Verifier::new(&a, &b, &c, pubs, vk) {
        Ok(mut v) => v.verify().is_ok(),
        Err(_) => false,
    }
}
