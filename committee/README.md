# Veyl batch committee

The committee decrypts sealed batches' **totals**. It never sees, and the protocol never decrypts, an individual sealed
swap. It is t-of-n (the deployments here use 2 of 3): any t members can settle a batch, fewer cannot decrypt anything.

| file | what |
|---|---|
| `dkg.js` | dealerless key generation (joint Feldman VSS), its messages, the transcript and its verification |
| `node.js` | one member's node: serves its DKG messages, keeps its share, watches sealed pools, posts partial decryptions with Chaum–Pedersen proofs, settles, closes batches; `GET /health`, `GET /transcript` |
| `lib.js` | what nodes, the relayer and the tests do on chain: post a share and drive its on-chain check, recover totals, settle, crank |
| `Dockerfile` | one node per container (state on a volume) |
| `../scripts/committee-local.js` | n nodes on one machine for development, the tests and the end-to-end run (never for real funds) |

## The cryptography, briefly

- **Curve.** Baby Jubjub (circomlib), base point B8, subgroup order l. The swap circuit encrypts natively on it
  (BN254-G1 would be non-native in a BN254 circuit: about a million constraints instead of about four thousand).
- **Encryption.** Exponent ElGamal: `Enc(m) = (r·B8, m·B8 + r·PK)`. The program adds every swap's ciphertext into its
  batch's aggregate for its direction, so the aggregate encrypts the direction's total.
- **Key.** `PK = sk·B8` where nobody knows `sk`: each node i deals a random polynomial `f_i` of degree t-1, publishes
  `F_ik = a_ik·B8`, sends `f_i(j)` to node j encrypted to its X25519 key. Node j checks `f_i(j)·B8 == Σ_k j^k·F_ik`; its
  share is `sk_j = Σ_i f_i(j)`; `PK = Σ_i F_i0`.
- **Partial decryption.** For a closed batch, member j posts `D_ja = sk_j·C1a`, `D_jb = sk_j·C1b` and a Chaum–Pedersen
  proof (A, B_a, B_b, s) that `log_B8 PK_j = log_C1a D_ja = log_C1b D_jb`. The program checks the three equations
  combined with Fiat–Shamir weights, multiplied by the cofactor 8 (one 9-term multi-scalar multiplication). Baby Jubjub has
  no syscall, so this runs in software: about 5.4M compute units, spread over 5 transactions (`post_share`, then
  `share_step` until the job is done; anyone may crank it).
- **Totals.** With t verified shares S, `M = C2 - Σ_{i∈S} λ_i·D_i = total·B8`; the total (below 2^46: at most 64 swaps
  of at most 2^40 atoms per direction) is found by baby-step giant-step off chain and checked on chain as
  `8·(Δ·C2 - Σ Δλ_i·D_i) == (8·Δ·total)·B8` with Δ = n! (integer weights: no full-size scalar multiplies a share).

## Trust

- **Privacy of individual swaps** holds while fewer than t members collude. Every individual ciphertext is on chain, so a
  colluding quorum of t members could decrypt any individual sealed swap amount (and anyone who later learns t shares
  could decrypt old ones). The protocol only ever decrypts aggregates; nothing stops a corrupt quorum from doing more off
  chain. Key rotation (`set_committee`) limits what a later compromise exposes to batches under that key.
- **Soundness** does not depend on the committee: a wrong partial decryption fails its Chaum–Pedersen check; a wrong
  total fails `settle_verify`; the claim circuit and the program bind every claim to the batch's recorded ratio. A
  colluding quorum cannot settle a batch at a false total.
- **Liveness.** A committee that withholds shares delays a batch until its settlement window ends (`settle_timeout`
  slots after closing); then every swap in it is refunded through the claim circuit. Closing, verifying totals, settling
  and failing a batch are permissionless.
- **Key generation.** Plain joint Feldman VSS lets a rushing dealer bias the distribution of the joint key (Gennaro,
  Jarecki, Krawczyk, Rabin 1999); the key stays unknown to any t-1 members, so ElGamal privacy holds. Any complaint aborts
  the run in this implementation (start a new session without the accused node). Mainnet hardening: Pedersen-VSS-based
  DKG (GJKR) and public complaint resolution.

## Running a member

```bash
node committee/node.js keys                 # with NODE_SECRET_KEY set: prints { node, boxKey } to give the other members
# every member writes the same peer list: { index, t, n, peers: [{ index, url, node, boxKey }] }
COMMITTEE_CONFIG=committee.json NODE_SECRET_KEY=... STATE_DIR=/data DKG_SESSION=veyl-devnet-2026-10 \
  NETWORK=devnet RPC_URL=https://... PORT=8863 node committee/node.js
```
Every node of the session must be up within the key generation's timeout (10 minutes). When it is done each node has
`/data/share.json` (its secret share, mode 0600: back it up offline; losing more than n - t shares stops settlement) and
`/data/transcript.json` (public). The authority registers the joint key from the transcript (`npm run deploy` reads
`committee/transcript.<network>.json`, or `COMMITTEE_TRANSCRIPT`); preflight re-verifies it. From then on the node needs
only its share and a little SOL for transactions (a share costs 5 signatures and the share job's rent, refunded).

Docker: `docker build -f committee/Dockerfile -t veyl-sol-committee .`, then run with the env above and a volume at
`/data`. `docker compose up --build` runs three members in one container for local work.

## Arcium instead of this committee

Arcium's multi-party execution environments (MXEs, Cerberus protocol: private if at least one node is honest) could
replace the committee. What would change:

- **Encryption target.** Users would encrypt each sealed amount to the MXE (Arcium's client encryption) instead of to
  `PK`, and the batch's aggregation would be an MXE computation over the encrypted inputs that outputs only the two
  totals, through Arcium's callback instruction.
- **Binding the amount.** Today the swap circuit proves the ElGamal ciphertext encrypts exactly the committed amount. An
  Arcium ciphertext is not cheap to open inside a BN254 Groth16 circuit, so the binding would move into the MXE: each
  swap also gives the MXE the opening of its swap commitment (amount, blinding, owner key hash), and the computation
  recomputes the Poseidon commitment and checks it before adding the amount. The swap circuit would drop its ElGamal part
  (about 5k constraints) and its bundle would bind the MXE ciphertext's hash instead.
- **On chain.** `post_share`, `share_step`, the share jobs and `settle_verify` would go: settlement would trust the
  Arcium program's callback (its own verification of the MXE's output), and `set_committee` would name the MXE instead of
  a key. Batches, the k-floor, netting, the single net swap, clearing ratios, claims and refunds stay as they are.
- **Trust.** Privacy improves from "fewer than t of n collude" to "at least one MXE node is honest". Liveness becomes
  Arcium's (an aborting node stops the computation; the settlement window and refunds still bound the delay). The system
  then depends on Arcium's network, fees and availability (mainnet alpha since February 2026) and on Arcium's own
  security, audits and upgrade keys.
