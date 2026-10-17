# Trusted-setup ceremony (Groth16 phase 2), every circuit: coordinator guide

Veyl's proofs are Groth16 proofs over five circuits:

| circuit | used for | constraints | public signals | phase-1 file (smallest that fits) |
|---|---|---|---|---|
| `withdraw` | Phase 1 (legacy) pools: withdrawals, private actions, migration into the shielded pool | 14,237 | 6 | `powersOfTau28_hez_final_14.ptau` (2^14, 18 MB) |
| `transact` | the shielded pool: deposits, hidden transfers, withdrawals, every leg paid from shielded notes | 18,475 | 8 | `powersOfTau28_hez_final_15.ptau` (2^15, 36 MB) |
| `position` | shielded liquidity: add, remove, claim, rebalance, zap on a position note | 17,219 | 8 | `powersOfTau28_hez_final_15.ptau` (2^15, 36 MB) |
| `swap` | sealed batch swaps: notes into a swap commitment, the amount ElGamal-encrypted to the committee key | 23,426 | 8 | `powersOfTau28_hez_final_15.ptau` (2^15, 36 MB) |
| `claim` | a sealed swap's output at the batch's clearing ratio, or its refund | 9,942 | 6 | `powersOfTau28_hez_final_14.ptau` (2^14, 18 MB) |

Each circuit's keys come from a setup whose secret randomness ("toxic waste") would let whoever knows it forge proofs: for
`transact`, mint notes that were never deposited. The keys in `zk/keys/` today come from one machine, so one person could
have kept that secret. That is the Critical item blocking mainnet, **for every circuit**.

A multi-party ceremony fixes it: each contributor adds their own randomness on top of the previous key and throws it away.
A final key is safe if **at least one** contributor to it was honest. This folder runs one ceremony for all five circuits:
the same contributors, in the same order, each running **one command** that contributes to every circuit in turn, and one
random beacon that closes all of them. The circuits never change: `ceremony/circuits.json` pins each one (sha256 of the
source, r1cs, wasm and constraint coefficients); `npm run ceremony -- r1cs` recompiles them and checks every wasm is
byte-identical to the shipped one.

```
ceremony/
  ceremony.mjs     the commands (npm run ceremony -- <command>)
  lib.mjs          hashes, the zkey contribution reader, verification, per-circuit files
  check.mjs        what preflight --network mainnet requires (below)
  rehearse.mjs     a full practice run on one machine, every circuit (npm run ceremony:rehearse)
  circuits.json    the five circuits, byte for byte, and the phase-1 power each needs
  ptau.json        the public phase-1 files (2^14, 2^15, 2^16) and their published blake2b hashes
  work/            the coordinator's state (version 2) and every intermediate key, per circuit (not committed)
  rehearsal/       output of the last rehearsal: REHEARSAL transcript and RESULT.json (keys not committed; never used)
  TRANSCRIPT.md    written by `finalize` after the real ceremony, one section per circuit (does not exist yet)
```

## Phase 1: the public Powers of Tau

Not run here. The ceremony reuses the Perpetual Powers of Tau (54 contributions and a beacon), prepared for phase 2 by the
Hermez/Polygon team. Each circuit starts from the smallest file it fits (a domain of 2^power >= constraints + public inputs):

| file | blake2b-512 (published in the snarkjs README, "Prepare phase 2") |
|---|---|
| `powersOfTau28_hez_final_14.ptau` | `eeefbcf7c3803b523c94112023c7ff89558f9b8e0cf5d6cdcba3ade60f168af4a181c9c21774b94fbae6c90411995f7d854d02ebd93fb66043dbb06f17a831c1` |
| `powersOfTau28_hez_final_15.ptau` | `982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e` |

```bash
mkdir -p ceremony/ptau && for p in 14 15; do curl -L -o ceremony/ptau/powersOfTau28_hez_final_$p.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_$p.ptau; done
b2sum ceremony/ptau/*.ptau      # must print the hashes above; init refuses any other file
```

`init` finds them in `ceremony/ptau/` (or `--ptau-14 <file> --ptau-15 <file>`). One 2^15 file also works for all five
(`--ptau <file>`); the 2^16 file is listed for a future, larger circuit.

## Recruiting contributors (at least 3, independent)

Only one honest contributor is needed, so the goal is that nobody can believe *all* of them colluded.

- **At least 3; aim for 5 to 10.** One contribution to all five circuits takes a participant 3 to 5 minutes.
- **Independent of each other and of the team.** Different organisations, ideally different countries; at least two with no
  financial stake in Veyl.
- **Publicly identifiable**, and the list published before the ceremony starts.
- **Different machines and setups.**
- **Each one posts their contribution hashes** (one per circuit; the command saves them in a receipt) right after.
- Optional: one contributor uses the offline mode on an air-gapped machine (`contribute --in/--out`, once per circuit).

## Ordering and timeline

1. **Announce** the participant list and the order.
2. **Commit to the beacon** before the first contribution: a Bitcoin block height `H` to be mined after the planned close
   (or a drand round). Nobody can know its value while contributions are open.
3. **Contributions**, one participant at a time; each contributes to all five circuits (withdraw, transact, position, swap, claim) in that order. Someone
   who does not show up is moved to the end (`skip`).
4. **Beacon** once block `H` exists (the same value closes every circuit). **Verify. Finalize.** Publish the transcript and
   every intermediate key.

## Running it (coordinator)

```bash
npm ci
npm run ceremony -- r1cs                                       # recompile all five: each wasm must equal zk/build/<name>.wasm
npm run ceremony -- init                                       # every circuit, from ceremony/ptau/
npm run ceremony -- add-participant --name "Contributor One"   # repeat in the published order; each prints a token once
npm run ceremony -- serve --host 0.0.0.0 --port 8853           # behind HTTPS (a reverse proxy) or an SSH tunnel
```

Send each contributor their token privately. A token only lets its holder upload in their turn. For each circuit the
server accepts an upload only if it keeps every earlier contribution, adds exactly one contribution under that contributor's
name, is for that circuit's constraints, and passes the full `snarkjs zkey verify` against its r1cs and ptau. `GET /status`
shows the progress per circuit; `GET /latest?circuit=<name>` serves the current key; `POST /contribute?circuit=<name>` takes
one.

Offline: send them `ceremony/work/<circuit>_000N.zkey` for each circuit, then
`npm run ceremony -- accept --circuit <circuit> --file <their zkey> --name "<their name>"` for each file they return.

Then:

```bash
npm run ceremony -- beacon --btc-height <H>                    # applied to every circuit; or --drand-round <R>; or --hash <hex> --source "..."
npm run ceremony -- verify                                     # per circuit: every contribution hash, the beacon, OK / NOT OK
npm run ceremony -- finalize                                   # writes the files below into the repo
npm run build && npm test && npm run preflight -- --network mainnet
```

`finalize` writes, per circuit, `zk/keys/<name>_final.zkey`, `zk/keys/<name>_vkey.json`, the program's verifying key
(`programs/veyl_pool/src/vkey.rs` for withdraw, `vkey_<name>.rs` for the others), a `site/<name>_final.zkey` copy (gitignored: the site build reads `zk/keys`); and once
`zk/keys/SETUP.json` (kind `ceremony`, every circuit's hashes), `zk/keys/contribution.log`, `ceremony/TRANSCRIPT.md` (a
section per circuit) and `ceremony/transcript.json`. The wasm files do not change. Commit, publish every intermediate key
from `ceremony/work/`, rebuild and redeploy `veyl_pool`.

## The participant's one command

```bash
git clone <repo> && cd veyl && npm ci
npm run ceremony -- contribute --coordinator https://<coordinator>:8853 --token <your token>
```

For each circuit in turn it downloads the latest key (checking its sha256), adds a contribution made from 64 bytes of
operating-system randomness plus optional typed text (snarkjs mixes in its own randomness too), uploads it, waits for the
coordinator's verification and prints your **contribution hash**. It saves a receipt with all five,
`veyl-contribution-<name>.json`. Secrets exist only in that process's memory. Good practice: a fresh machine or VM, shut
down afterwards. Then post your five hashes publicly.

## How each contributor checks that their contributions are in

1. Right away: `GET /status` lists your hash under your name, per circuit.
2. After `finalize`: each hash is in the table of its circuit's section in `ceremony/TRANSCRIPT.md`.
3. Independently: run `verify` on the published final keys; it recomputes every contribution hash **from the key itself**.

## How anyone verifies the final result

```bash
git checkout <release commit> && npm ci
b2sum powersOfTau28_hez_final_14.ptau powersOfTau28_hez_final_15.ptau   # = the published phase-1 hashes
npm run ceremony -- r1cs                                                # every circuit compiles to the shipped wasm
npm run ceremony -- verify --circuit withdraw --zkey zk/keys/withdraw_final.zkey --ptau powersOfTau28_hez_final_14.ptau
npm run ceremony -- verify --circuit transact --zkey zk/keys/transact_final.zkey --ptau powersOfTau28_hez_final_15.ptau
npm run ceremony -- verify --circuit position --zkey zk/keys/position_final.zkey --ptau powersOfTau28_hez_final_15.ptau
npm run ceremony -- verify --circuit swap --zkey zk/keys/swap_final.zkey --ptau powersOfTau28_hez_final_15.ptau
npm run ceremony -- verify --circuit claim --zkey zk/keys/claim_final.zkey --ptau powersOfTau28_hez_final_14.ptau
```

Check that each `verify` prints OK; the contribution hashes match what each contributor posted, at least 3 independent ones
per circuit; each key ends with the beacon of the announced block; `npm run vkey` reproduces the committed `vkey*.rs`, and
the deployed program carries all five (`solana program dump`, then `npm run preflight -- --network mainnet`).

## What preflight requires on mainnet

Green for the trusted setup only when, **for every circuit**:

1. `ceremony/TRANSCRIPT.md` and `ceremony/transcript.json` exist, cover all five circuits (version 2) and are not a
   rehearsal (step `finalize`);
2. the shipped key holds at least 3 participant contributions with non-rehearsal names (step `contribute`) and ends with a
   beacon (step `beacon`), the same ones the transcript lists;
3. `verify` passes against its r1cs and the **public** ptau (`CEREMONY_PTAU_14=<file>`, `CEREMONY_PTAU_15=<file>`, or
   `ceremony/ptau/`) (step `verify`);
4. its `<name>_vkey.json` is the final key's verifying key and is baked into `veyl_pool.so` (step `build`).

Separately, preflight stays red on mainnet until a real batch-committee key-generation transcript exists
(`committee/transcript.mainnet.json`: at least 2 of 3, not a local session, re-verified) and the on-chain committee matches
it; see `committee/README.md`.

A known single-machine dev key (any of the five) under `kind: "ceremony"` is red as well. Today all five are dev keys, so
mainnet preflight is red, naming each circuit.

## Rehearsal

```bash
npm run ceremony:rehearse -- --ptau <any prepared ptau of power >= 15>
```

Runs the whole thing on one machine for all five circuits: init, a coordinator, three simulated contributors each running
the real one-command `contribute` in its own process (contributing to every circuit), refused uploads (unknown token, wrong
turn, a key without a new contribution, a key for another circuit), a fixed test beacon on every circuit, `verify` per
circuit, `finalize` into `ceremony/rehearsal/`; then it builds `veyl_pool` with the five rehearsal verifying keys in a
scratch workspace, deploys the whole protocol on a local validator with it, and checks that **real transact proofs made
with the rehearsal key** verify on chain and execute (a shielded deposit, admitted, then a hidden transfer), that a dev-key
transact proof is refused, that the withdraw circuit's rehearsal proof verifies and executes too, and then runs **one full sealed batch with the rehearsal swap and claim keys** (`tests/sealed-batch.js`: six sealed swaps, three per direction, two of three committee shares checked on chain, the net swap, six claims) after checking a dev-key swap proof is refused. The repo's keys are
checked untouched before and after; `finalize` refuses to write a rehearsal into the repo and preflight never accepts it.

Last rehearsal: `ceremony/rehearsal/RESULT.json` and `ceremony/rehearsal/ceremony/TRANSCRIPT.md`. It used a local 2^16
phase-1 file (one local contribution, prepared) because the sandbox it ran in could not download the public files; the
public files are required for the real ceremony.
