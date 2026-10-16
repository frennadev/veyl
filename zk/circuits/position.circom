pragma circom 2.1.6;

// Veyl shielded pool, Phase 2: the position circuit (a shielded liquidity position, one proof per action).
//
// A position note lives in the same tree and has the same shape as a token note:
//     commitment = Poseidon(posAsset, digest, ownerPubkey, blinding)
//     posAsset   = hash(bin pool, lo)                 the window of K = 16 bins [lo, lo + 16) (public when touched)
//     digest     = Poseidon(Poseidon16(shares[0..15]), debtX, debtY)
// `shares[b]` are the position's shares of bin lo + b, held on chain by the shielded aggregate (one share account per bin
// array owned by the entry program), so the chain only ever sees the aggregate: nobody can read one holder's size.
// Fees: the entry program keeps, per bin, a fee growth per shielded share H (Q64.64, monotone, raised only by what it has
// actually collected from the bin pool for the aggregate). `debt` is MasterChef's reward debt: what the position owes back
// of sum(shares[b] * H[b]); what it can claim is
//     P = sum(shares[b] * H[b]) - debt        (Q64.64 fee atoms, 0 <= P < 2^128)
//     claim = floor(P / 2^64) - relayerFee,   the remainder r = P mod 2^64 stays owed in the new debt.
//
// One proof spends one position note (or a dummy: a new position) and creates the updated note:
//   1. the input is a leaf of the state tree, owned by the prover's spending key (or a dummy with zero shares and debt);
//   2. its nullifier (same construction as transact.circom);
//   3. new shares = old shares + delta (delta public, signed); every new share count fits 112 bits (no negative balance:
//      a remove cannot burn more than the note holds);
//   4. fees: the claim per token from the public growth H, into a new hidden-amount token note (or 0 when nothing is
//      claimed); the new debt makes the new note owe exactly what it has not claimed, priced at the current H;
//   5. `bundle` = the hash of everything the program supplies (H for the window, the deltas, the two token assets, the
//      relayer's fee per token): the program recomputes it from chain state and the action, so none can be swapped;
//   6. extDataHash binds the relayer, the encrypted position payload and the action.

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

// Hash of 16 values the program can recompute with the sol_poseidon syscall (at most 12 inputs per call):
// Poseidon(Poseidon8(v[0..7]), Poseidon8(v[8..15])).
template Hash16() {
    signal input in[16];
    signal output out;
    component a = Poseidon(8);
    component b = Poseidon(8);
    for (var i = 0; i < 8; i++) { a.inputs[i] <== in[i]; b.inputs[i] <== in[8 + i]; }
    component c = Poseidon(2);
    c.inputs[0] <== a.out;
    c.inputs[1] <== b.out;
    out <== c.out;
}

template Position(levels, K) {
    // ---- public inputs (snarkjs order = declaration order)
    signal input root;
    signal input nullifier;
    signal input outCommitment;
    signal input posAsset;
    signal input bundle;
    signal input claimCommitment[2];
    signal input extDataHash;

    // ---- private inputs
    signal input key;                   // spending key
    signal input inExists;              // 0 = a new position (dummy input)
    signal input inShares[K];
    signal input inDebt[2];
    signal input inBlinding;
    signal input inPathIndex;
    signal input inPathElements[levels];
    signal input growth[2][K];          // H per bin, per token (in the bundle)
    signal input delta[K];              // signed share change per bin (in the bundle)
    signal input assets[2];             // token X / token Y asset ids (in the bundle)
    signal input fee[2];                // relayer fee per token taken from the claim (in the bundle)
    signal input outBlinding;
    signal input claimBlinding[2];

    component pub = Poseidon(1);
    pub.inputs[0] <== key;

    // ---- input note
    inExists * (1 - inExists) === 0;
    component inSharesHash = Poseidon(16);
    for (var b = 0; b < K; b++) {
        inSharesHash.inputs[b] <== inShares[b];
        inShares[b] * (1 - inExists) === 0;   // a dummy input holds nothing ...
    }
    inDebt[0] * (1 - inExists) === 0;         // ... and owes nothing
    inDebt[1] * (1 - inExists) === 0;
    component inDigest = Poseidon(3);
    inDigest.inputs[0] <== inSharesHash.out;
    inDigest.inputs[1] <== inDebt[0];
    inDigest.inputs[2] <== inDebt[1];
    component inCommit = Poseidon(4);
    inCommit.inputs[0] <== posAsset;
    inCommit.inputs[1] <== inDigest.out;
    inCommit.inputs[2] <== pub.out;
    inCommit.inputs[3] <== inBlinding;

    component sig = Poseidon(3);
    sig.inputs[0] <== key;
    sig.inputs[1] <== inCommit.out;
    sig.inputs[2] <== inPathIndex;
    component nul = Poseidon(3);
    nul.inputs[0] <== inCommit.out;
    nul.inputs[1] <== inPathIndex;
    nul.inputs[2] <== sig.out;
    nul.out === nullifier;

    component tree = MerkleRoot(levels);
    tree.leaf <== inCommit.out;
    tree.index <== inPathIndex;
    for (var j = 0; j < levels; j++) tree.siblings[j] <== inPathElements[j];
    (tree.root - root) * inExists === 0;

    // ---- new shares
    signal outShares[K];
    component outRange[K];
    for (var b = 0; b < K; b++) {
        outShares[b] <== inShares[b] + delta[b];
        outRange[b] = Num2Bits(112);
        outRange[b].in <== outShares[b];
    }

    // ---- fees, per token
    signal inProd[2][K];
    signal outProd[2][K];
    signal claim[2];
    signal outDebt[2];
    component qBits[2];
    component rBits[2];
    component claimBits[2];
    component claimZero[2];
    component claimHash[2];
    signal claimRaw[2];
    signal q[2];
    signal r[2];
    for (var a = 0; a < 2; a++) {
        var sIn = 0;
        var sOut = 0;
        for (var b = 0; b < K; b++) {
            inProd[a][b] <== inShares[b] * growth[a][b];
            outProd[a][b] <== outShares[b] * growth[a][b];
            sIn += inProd[a][b];
            sOut += outProd[a][b];
        }
        // P = sIn - debt = q * 2^64 + r with q, r < 2^64
        var P = sIn - inDebt[a];
        q[a] <-- P \ 18446744073709551616;
        r[a] <-- P % 18446744073709551616;
        q[a] * 18446744073709551616 + r[a] === P;
        qBits[a] = Num2Bits(64);
        qBits[a].in <== q[a];
        rBits[a] = Num2Bits(64);
        rBits[a].in <== r[a];
        claim[a] <== q[a] - fee[a];
        claimBits[a] = Num2Bits(64);
        claimBits[a].in <== claim[a];
        outDebt[a] <== sOut - r[a];

        claimHash[a] = Poseidon(4);
        claimHash[a].inputs[0] <== assets[a];
        claimHash[a].inputs[1] <== claim[a];
        claimHash[a].inputs[2] <== pub.out;
        claimHash[a].inputs[3] <== claimBlinding[a];
        claimZero[a] = IsZero();
        claimZero[a].in <== claim[a];
        claimRaw[a] <== claimHash[a].out;
        claimCommitment[a] === claimRaw[a] * (1 - claimZero[a].out);   // no note at all when nothing is claimed
    }

    // ---- output note
    component outSharesHash = Poseidon(16);
    for (var b = 0; b < K; b++) outSharesHash.inputs[b] <== outShares[b];
    component outDigest = Poseidon(3);
    outDigest.inputs[0] <== outSharesHash.out;
    outDigest.inputs[1] <== outDebt[0];
    outDigest.inputs[2] <== outDebt[1];
    component outCommit = Poseidon(4);
    outCommit.inputs[0] <== posAsset;
    outCommit.inputs[1] <== outDigest.out;
    outCommit.inputs[2] <== pub.out;
    outCommit.inputs[3] <== outBlinding;
    outCommit.out === outCommitment;

    // ---- what the program supplies
    component hx = Hash16();
    component hy = Hash16();
    component hd = Hash16();
    for (var b = 0; b < K; b++) { hx.in[b] <== growth[0][b]; hy.in[b] <== growth[1][b]; hd.in[b] <== delta[b]; }
    component bun = Poseidon(7);
    bun.inputs[0] <== hx.out;
    bun.inputs[1] <== hy.out;
    bun.inputs[2] <== hd.out;
    bun.inputs[3] <== assets[0];
    bun.inputs[4] <== assets[1];
    bun.inputs[5] <== fee[0];
    bun.inputs[6] <== fee[1];
    bun.out === bundle;

    signal extSquare <== extDataHash * extDataHash;
}

component main {public [root, nullifier, outCommitment, posAsset, bundle, claimCommitment, extDataHash]} = Position(32, 16);
