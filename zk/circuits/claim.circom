pragma circom 2.1.6;

// Veyl Phase 3: the claim circuit (a sealed swap's output, or its refund, into a new hidden-amount note).
//
// After a batch settles, its clearing ratio per direction is public: num / den (what the direction's sellers receive in the
// other token, divided by what they put in). A claim spends one swap commitment (swap.circom) and creates one note:
//     out = floor(amount · num / den) - fee           of asset assetOut
// If the batch failed (it did not settle in time, or never reached its minimum size), the program supplies num = den = 1
// and assetOut = the token that was sold: the same circuit then returns the input, minus the relayer's fee.
//
// The proof shows, without revealing which swap commitment it spends or any amount:
//   1. the swap commitment Poseidon(batchKey, direction, amount, Poseidon(key), blinding) is a leaf of the state tree
//      (always enforced: a swap commitment is never a dummy) and the prover holds its key;
//   2. its nullifier (the notes' construction), so it can be claimed once;
//   3. q = floor(amount·num / den), i.e. 0 <= amount·num - q·den < den, and out = q - fee >= 0; every value is
//      range-checked (amount 40 bits; num, den, fee, q, the remainder and out 64 bits), so nothing can wrap the field;
//   4. the output note Poseidon(assetOut, out, outPubkey, outBlinding);
//   5. bundle = Poseidon(direction, assetOut, num, den, fee): the program recomputes it from the batch's settlement (or the
//      refund), so a claim can only use the ratio of its own direction and batch;
//   6. extDataHash binds the relayer's fee account and the encrypted output note.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

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

template Claim(levels, amountBits) {
    // ---- public inputs
    signal input root;
    signal input nullifier;
    signal input outCommitment;
    signal input batchKey;
    signal input bundle;
    signal input extDataHash;

    // ---- private inputs
    signal input key;
    signal input direction;
    signal input amount;
    signal input swapBlinding;
    signal input pathIndex;
    signal input pathElements[levels];
    signal input assetOut;
    signal input num;
    signal input den;
    signal input fee;
    signal input q;
    signal input outPubkey;
    signal input outBlinding;

    // 1. the swap commitment and its membership
    component pub = Poseidon(1);
    pub.inputs[0] <== key;
    direction * (direction - 1) === 0;
    component sc = Poseidon(5);
    sc.inputs[0] <== batchKey;
    sc.inputs[1] <== direction;
    sc.inputs[2] <== amount;
    sc.inputs[3] <== pub.out;
    sc.inputs[4] <== swapBlinding;
    component tree = MerkleRoot(levels);
    tree.leaf <== sc.out;
    tree.index <== pathIndex;
    for (var j = 0; j < levels; j++) tree.siblings[j] <== pathElements[j];
    tree.root === root;

    // 2. nullifier
    component sig = Poseidon(3);
    sig.inputs[0] <== key;
    sig.inputs[1] <== sc.out;
    sig.inputs[2] <== pathIndex;
    component nul = Poseidon(3);
    nul.inputs[0] <== sc.out;
    nul.inputs[1] <== pathIndex;
    nul.inputs[2] <== sig.out;
    nul.out === nullifier;

    // 3. out = floor(amount * num / den) - fee
    component ra = Num2Bits(amountBits); ra.in <== amount;
    component rn = Num2Bits(64); rn.in <== num;
    component rd = Num2Bits(64); rd.in <== den;
    component rf = Num2Bits(64); rf.in <== fee;
    component rq = Num2Bits(64); rq.in <== q;
    signal prod <== amount * num;
    signal qd <== q * den;
    signal rem <== prod - qd;
    component rr = Num2Bits(64); rr.in <== rem;
    component lt = LessThan(64);
    lt.in[0] <== rem;
    lt.in[1] <== den;
    lt.out === 1;
    signal out <== q - fee;
    component ro = Num2Bits(64); ro.in <== out;

    // 4. the output note
    component note = Poseidon(4);
    note.inputs[0] <== assetOut;
    note.inputs[1] <== out;
    note.inputs[2] <== outPubkey;
    note.inputs[3] <== outBlinding;
    note.out === outCommitment;

    // 5. what the program supplies
    component b = Poseidon(5);
    b.inputs[0] <== direction;
    b.inputs[1] <== assetOut;
    b.inputs[2] <== num;
    b.inputs[3] <== den;
    b.inputs[4] <== fee;
    b.out === bundle;

    // 6. external data
    signal extSquare <== extDataHash * extDataHash;
}

component main {public [root, nullifier, outCommitment, batchKey, bundle, extDataHash]} = Claim(32, 40);
