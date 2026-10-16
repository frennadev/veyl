pragma circom 2.1.6;

// Veyl shielded pool, Phase 2: the transact circuit (2 inputs -> 2 outputs, one asset per proof).
//
// A note in the shielded tree is
//     commitment = Poseidon(asset, amount, ownerPubkey, blinding)          ownerPubkey = Poseidon(spendingKey)
// and is spent by publishing
//     nullifier  = Poseidon(commitment, leafIndex, Poseidon(spendingKey, commitment, leafIndex))
// (Tornado Nova's construction: the leaf index makes two notes with equal commitments spend separately, and only the holder
// of the spending key can compute it).
//
// The proof shows, without revealing which notes are spent, who owns them or any amount:
//   1. each input with a non-zero amount is a leaf of the state tree (root); a zero-amount input is a dummy (no path needed);
//   2. the prover knows the spending key of every input (ownerPubkey = Poseidon(key) inside each input's commitment);
//   3. the nullifiers are computed correctly and differ from each other;
//   4. every input and output amount fits 64 bits (an overflow would wrap the field and mint value);
//   5. sum(inputs) + publicAmount == sum(outputs): publicAmount > 0 is a deposit, < 0 a withdrawal (field-encoded p - x),
//      0 an internal transfer. The program checks publicAmount == extAmount - fee;
//   6. all four notes carry the same asset; when publicAmount != 0 that asset must equal publicAsset (the program maps it
//      to a token vault), and when publicAmount == 0 publicAsset is unconstrained (the program requires 0), so an internal
//      transfer does not reveal its token;
//   7. extDataHash binds the recipient, the relayer, the fee, the encrypted output notes and the action (sha256 of the
//      borsh-encoded external data, masked to 253 bits): changing any of them invalidates the proof.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Root of a fixed-depth binary Poseidon Merkle tree (same construction as withdraw.circom: empty leaves are 0,
// node = Poseidon(left, right); the index bits choose the side).
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

template Transact(levels, nIns, nOuts) {
    // ---- public inputs (snarkjs order = declaration order)
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input publicAsset;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // ---- private inputs
    signal input asset;
    signal input inAmount[nIns];
    signal input inKey[nIns];          // spending key of each input's owner
    signal input inBlinding[nIns];
    signal input inPathIndex[nIns];
    signal input inPathElements[nIns][levels];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

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

        // membership, enforced only for a non-dummy input (amount != 0)
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

    component outCommit[nOuts];
    component outRange[nOuts];
    var sumOuts = 0;
    for (var i = 0; i < nOuts; i++) {
        outCommit[i] = Poseidon(4);
        outCommit[i].inputs[0] <== asset;
        outCommit[i].inputs[1] <== outAmount[i];
        outCommit[i].inputs[2] <== outPubkey[i];
        outCommit[i].inputs[3] <== outBlinding[i];
        outCommit[i].out === outputCommitment[i];
        outRange[i] = Num2Bits(64);
        outRange[i].in <== outAmount[i];
        sumOuts += outAmount[i];
    }

    // no nullifier twice in one proof
    component same[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            same[k] = IsEqual();
            same[k].in[0] <== inputNullifier[i];
            same[k].in[1] <== inputNullifier[j];
            same[k].out === 0;
            k++;
        }
    }

    // value conservation for the one asset
    sumIns + publicAmount === sumOuts;

    // the asset is public exactly when value crosses the shielded pool's boundary
    publicAmount * (asset - publicAsset) === 0;

    // bind the external data (quadratic, so it cannot be optimised away)
    signal extSquare <== extDataHash * extDataHash;
}

// Same tree depth as the withdraw circuit (32: 4.3 billion notes).
component main {public [root, publicAmount, extDataHash, publicAsset, inputNullifier, outputCommitment]} = Transact(32, 2, 2);
