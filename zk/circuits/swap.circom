pragma circom 2.1.6;

// Veyl Phase 3: the swap circuit (a sealed batch swap: spend shielded notes into a swap commitment whose amount is
// encrypted to the batch committee).
//
// A sealed swap sells `amount` of one token of a bin pool in the pool's current batch. It spends up to two notes of that
// token (the transact circuit's notes: Poseidon(asset, amount, ownerPubkey, blinding)), returns the change as a new hidden
// note, pays the relayer's flat `fee`, and creates
//     swapCommitment = Poseidon(batchKey, direction, amount, swapPubkey, blinding)          (5 inputs: never a note)
// which goes into the same tree. It also encrypts `amount` to the committee's threshold key PK with exponent ElGamal on
// Baby Jubjub (circomlib's curve, native to this circuit's field):
//     C1 = r·B8,   C2 = amount·B8 + r·PK
// The program adds C1 and C2 into the batch's aggregate for this direction; the committee only ever decrypts aggregates.
//
// The proof shows, without revealing which notes are spent, who owns them, the amount or the change:
//   1. each non-dummy input is a leaf of the state tree, owned by the prover's spending key; nullifiers as in transact;
//   2. every amount fits 64 bits; the swap amount fits AMOUNT_BITS (40) and is at least `minIn` (> 0, set per pool);
//   3. sum(inputs) == change + amount + fee (one asset);
//   4. the swap commitment and the change note are formed as above;
//   5. (C1, C2) encrypts exactly `amount` under PK with an r of at most 250 bits. r·PK uses complete twisted Edwards
//      additions (BabyAdd) in a plain double-and-add, so no exceptional case exists for any PK in the curve;
//   6. bundle = Poseidon(direction, asset, fee, minIn, C1, C2, PK): the program recomputes it from the pool, the
//      direction it is told, the committee's key and the ciphertext it aggregates, so none of them can be swapped;
//   7. extDataHash binds the relayer's fee account and the encrypted payloads (change note, swap commitment opening).

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/babyjub.circom";
include "../node_modules/circomlib/circuits/escalarmulfix.circom";

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

// k·P for any point P of the curve, k given as n bits (little-endian), most significant bit first: acc = 2·acc (+ P).
// Only complete additions (BabyAdd), so the result is k·P for every input.
template MulAnyComplete(n) {
    signal input e[n];
    signal input p[2];
    signal output out[2];
    component dbl[n];
    component add[n];
    signal ax[n + 1];
    signal ay[n + 1];
    ax[0] <== 0;
    ay[0] <== 1;
    for (var i = 0; i < n; i++) {
        dbl[i] = BabyAdd();
        dbl[i].x1 <== ax[i]; dbl[i].y1 <== ay[i]; dbl[i].x2 <== ax[i]; dbl[i].y2 <== ay[i];
        add[i] = BabyAdd();
        add[i].x1 <== dbl[i].xout; add[i].y1 <== dbl[i].yout; add[i].x2 <== p[0]; add[i].y2 <== p[1];
        ax[i + 1] <== dbl[i].xout + e[n - 1 - i] * (add[i].xout - dbl[i].xout);
        ay[i + 1] <== dbl[i].yout + e[n - 1 - i] * (add[i].yout - dbl[i].yout);
    }
    out[0] <== ax[n];
    out[1] <== ay[n];
}

template Swap(levels, nIns, amountBits, rBits) {
    // ---- public inputs (snarkjs order = declaration order)
    signal input root;
    signal input inputNullifier[nIns];
    signal input changeCommitment;
    signal input swapCommitment;
    signal input batchKey;
    signal input bundle;
    signal input extDataHash;

    // ---- private inputs
    signal input asset;
    signal input inAmount[nIns];
    signal input inKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndex[nIns];
    signal input inPathElements[nIns][levels];
    signal input changeAmount;
    signal input changePubkey;
    signal input changeBlinding;
    signal input amount;
    signal input direction;
    signal input swapPubkey;
    signal input swapBlinding;
    signal input fee;
    signal input minIn;
    signal input r;
    signal input pk[2];

    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // 1. inputs (as transact.circom)
    component inPub[nIns];
    component inCommit[nIns];
    component inSig[nIns];
    component inNull[nIns];
    component inTree[nIns];
    component inRange[nIns];
    component inIsZero[nIns];
    var sumIns = 0;
    for (var i = 0; i < nIns; i++) {
        inPub[i] = Poseidon(1);
        inPub[i].inputs[0] <== inKey[i];
        inCommit[i] = Poseidon(4);
        inCommit[i].inputs[0] <== asset;
        inCommit[i].inputs[1] <== inAmount[i];
        inCommit[i].inputs[2] <== inPub[i].out;
        inCommit[i].inputs[3] <== inBlinding[i];
        inSig[i] = Poseidon(3);
        inSig[i].inputs[0] <== inKey[i];
        inSig[i].inputs[1] <== inCommit[i].out;
        inSig[i].inputs[2] <== inPathIndex[i];
        inNull[i] = Poseidon(3);
        inNull[i].inputs[0] <== inCommit[i].out;
        inNull[i].inputs[1] <== inPathIndex[i];
        inNull[i].inputs[2] <== inSig[i].out;
        inNull[i].out === inputNullifier[i];
        inTree[i] = MerkleRoot(levels);
        inTree[i].leaf <== inCommit[i].out;
        inTree[i].index <== inPathIndex[i];
        for (var j = 0; j < levels; j++) inTree[i].siblings[j] <== inPathElements[i][j];
        inIsZero[i] = IsZero();
        inIsZero[i].in <== inAmount[i];
        (inTree[i].root - root) * (1 - inIsZero[i].out) === 0;
        inRange[i] = Num2Bits(64);
        inRange[i].in <== inAmount[i];
        sumIns += inAmount[i];
    }
    component same = IsEqual();
    same.in[0] <== inputNullifier[0];
    same.in[1] <== inputNullifier[1];
    same.out === 0;

    // 2. ranges
    component changeRange = Num2Bits(64);
    changeRange.in <== changeAmount;
    component feeRange = Num2Bits(64);
    feeRange.in <== fee;
    component amountBitsC = Num2Bits(amountBits);
    amountBitsC.in <== amount;
    component minRange = Num2Bits(amountBits);
    minRange.in <== minIn;
    component aboveMin = Num2Bits(amountBits);
    aboveMin.in <== amount - minIn;
    component minPos = IsZero();
    minPos.in <== minIn;
    minPos.out === 0;
    direction * (direction - 1) === 0;

    // 3. conservation
    sumIns === changeAmount + amount + fee;

    // 4. the change note and the swap commitment
    component change = Poseidon(4);
    change.inputs[0] <== asset;
    change.inputs[1] <== changeAmount;
    change.inputs[2] <== changePubkey;
    change.inputs[3] <== changeBlinding;
    change.out === changeCommitment;
    component sc = Poseidon(5);
    sc.inputs[0] <== batchKey;
    sc.inputs[1] <== direction;
    sc.inputs[2] <== amount;
    sc.inputs[3] <== swapPubkey;
    sc.inputs[4] <== swapBlinding;
    sc.out === swapCommitment;

    // 5. ElGamal: C1 = r·B8, C2 = amount·B8 + r·PK
    component rb = Num2Bits(rBits);
    rb.in <== r;
    component c1 = EscalarMulFix(rBits, BASE8);
    for (var i = 0; i < rBits; i++) c1.e[i] <== rb.out[i];
    component mb = EscalarMulFix(amountBits, BASE8);
    for (var i = 0; i < amountBits; i++) mb.e[i] <== amountBitsC.out[i];
    component rpk = MulAnyComplete(rBits);
    for (var i = 0; i < rBits; i++) rpk.e[i] <== rb.out[i];
    rpk.p[0] <== pk[0];
    rpk.p[1] <== pk[1];
    component c2 = BabyAdd();
    c2.x1 <== mb.out[0]; c2.y1 <== mb.out[1]; c2.x2 <== rpk.out[0]; c2.y2 <== rpk.out[1];

    // 6. what the program supplies and aggregates
    component b = Poseidon(10);
    b.inputs[0] <== direction;
    b.inputs[1] <== asset;
    b.inputs[2] <== fee;
    b.inputs[3] <== minIn;
    b.inputs[4] <== c1.out[0];
    b.inputs[5] <== c1.out[1];
    b.inputs[6] <== c2.xout;
    b.inputs[7] <== c2.yout;
    b.inputs[8] <== pk[0];
    b.inputs[9] <== pk[1];
    b.out === bundle;

    // 7. bind the external data
    signal extSquare <== extDataHash * extDataHash;
}

component main {public [root, inputNullifier, changeCommitment, swapCommitment, batchKey, bundle, extDataHash]} = Swap(32, 2, 40, 250);
