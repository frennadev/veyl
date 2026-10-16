pragma circom 2.1.6;

// Veyl shielded pool: withdraw circuit.
//
// A note (commitment) in the pool is
//     commitment = Poseidon(value, label, Poseidon(nullifier, secret))
// where `label` is fixed by the contract at deposit time and follows the money through every change note.
//
// The proof shows, without revealing which note is spent:
//   1. the spender knows the secrets of a note that is in the pool's state tree (stateRoot);
//   2. that note's label is in the approved set published by the association-set provider (aspRoot),
//      so funds flagged as stolen or sanctioned can't use the private exit;
//   3. withdrawnValue <= note value, and the remainder is re-deposited as a fresh change note;
//   4. the note's nullifier hash, so the same note can't be spent twice.
// `context` binds the proof to one exact withdrawal (recipient, relayer, fee, call data, chain, pool),
// so a relayer or front-runner can't redirect the funds.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Root of a fixed-depth binary Poseidon Merkle tree, given a leaf, its index and its sibling path.
template MerkleRoot(depth) {
    signal input leaf;
    signal input index;
    signal input siblings[depth];
    signal output root;

    component bits = Num2Bits(depth);
    bits.in <== index;

    component mux[depth];
    component hash[depth];
    signal node[depth + 1];
    node[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== node[i];
        mux[i].c[0][1] <== siblings[i];
        mux[i].c[1][0] <== siblings[i];
        mux[i].c[1][1] <== node[i];
        mux[i].s <== bits.out[i];

        hash[i] = Poseidon(2);
        hash[i].inputs[0] <== mux[i].out[0];
        hash[i].inputs[1] <== mux[i].out[1];
        node[i + 1] <== hash[i].out;
    }
    root <== node[depth];
}

template Withdraw(stateDepth, aspDepth) {
    // ---- public inputs ----
    signal input withdrawnValue;
    signal input stateRoot;
    signal input aspRoot;
    signal input context;

    // ---- private inputs ----
    signal input label;
    signal input existingValue;
    signal input existingNullifier;
    signal input existingSecret;
    signal input newNullifier;
    signal input newSecret;
    signal input stateIndex;
    signal input stateSiblings[stateDepth];
    signal input aspIndex;
    signal input aspSiblings[aspDepth];

    // ---- public outputs ----
    signal output newCommitmentHash;
    signal output existingNullifierHash;

    // 1. Rebuild the spent note and prove it is in the pool.
    component existingPre = Poseidon(2);
    existingPre.inputs[0] <== existingNullifier;
    existingPre.inputs[1] <== existingSecret;

    component existingCommitment = Poseidon(3);
    existingCommitment.inputs[0] <== existingValue;
    existingCommitment.inputs[1] <== label;
    existingCommitment.inputs[2] <== existingPre.out;

    component stateTree = MerkleRoot(stateDepth);
    stateTree.leaf <== existingCommitment.out;
    stateTree.index <== stateIndex;
    for (var i = 0; i < stateDepth; i++) stateTree.siblings[i] <== stateSiblings[i];
    stateTree.root === stateRoot;

    // 2. The deposit this note came from is in the approved set.
    component aspTree = MerkleRoot(aspDepth);
    aspTree.leaf <== label;
    aspTree.index <== aspIndex;
    for (var i = 0; i < aspDepth; i++) aspTree.siblings[i] <== aspSiblings[i];
    aspTree.root === aspRoot;

    // 3. Amounts: all values fit in 128 bits and the remainder can't go negative
    //    (a negative remainder would wrap to a huge field element and fail the 128-bit check).
    component withdrawnBits = Num2Bits(128);
    withdrawnBits.in <== withdrawnValue;
    component existingBits = Num2Bits(128);
    existingBits.in <== existingValue;
    signal remaining <== existingValue - withdrawnValue;
    component remainingBits = Num2Bits(128);
    remainingBits.in <== remaining;

    // 4. Nullifier of the spent note; the change note must use a new nullifier.
    component nullifierHash = Poseidon(1);
    nullifierHash.inputs[0] <== existingNullifier;
    existingNullifierHash <== nullifierHash.out;

    component sameNullifier = IsEqual();
    sameNullifier.in[0] <== existingNullifier;
    sameNullifier.in[1] <== newNullifier;
    sameNullifier.out === 0;

    // 5. Change note carrying the remainder, same label.
    component newPre = Poseidon(2);
    newPre.inputs[0] <== newNullifier;
    newPre.inputs[1] <== newSecret;

    component newCommitment = Poseidon(3);
    newCommitment.inputs[0] <== remaining;
    newCommitment.inputs[1] <== label;
    newCommitment.inputs[2] <== newPre.out;
    newCommitmentHash <== newCommitment.out;

    // Bind the context so it can't be swapped (quadratic constraint keeps it in the proof).
    signal contextSquared <== context * context;
}

// State tree: depth 32 (4.3 billion notes) so it can't realistically fill up.
// Approved-set tree: depth 20 (1 million approved deposits per published set).
component main {public [withdrawnValue, stateRoot, aspRoot, context]} = Withdraw(32, 20);
