# Contributing to the Veyl trusted setup

Thank you for helping. This page is everything you need. It takes one command.

## What Veyl is

Veyl is private concentrated liquidity on Solana: bin-based liquidity pools where positions, swaps and fees cannot be
linked back to a wallet. Every private action is a Groth16 proof, checked on chain.

## Why your contribution matters

Groth16 keys come from a setup whose secret randomness (the "toxic waste") could forge proofs: for example, mint shielded
notes that were never deposited. In this ceremony each contributor adds fresh randomness on top of the previous key and
then throws it away. **The final keys are safe if at least one contributor was honest and destroyed their randomness.**
You do not have to trust anyone else. You only have to trust yourself.

The ceremony covers Veyl's five circuits (`withdraw`, `transact`, `position`, `swap`, `claim`). Your one command contributes
to all five, in that order. Phase 1 is the public Perpetual Powers of Tau (Hermez/Polygon files); nothing about phase 1
happens here. Veyl has not yet had an independent audit; this ceremony is one of the steps before mainnet.

## Before your turn

You need:

- **Node.js 20 or newer**, and `git`.
- **About 2 GB of free disk** (the dependencies take about 650 MB; each key is 7 to 16 MB) and **4 GB of RAM**.
- **About 3 to 5 minutes of computing.** Allow 20 minutes in total: after each circuit you wait while the coordinator
  verifies your upload.
- A network connection to the coordinator.
- Ideally a **fresh machine or VM** that you shut down or delete afterwards.

From the coordinator you receive, privately:

- the repository link and the exact **commit** to use: `<REPO URL>`, `<COMMIT>`;
- the **coordinator URL**: `<COORDINATOR URL>`;
- your **token** (one per contributor; it only lets you upload in your own turn);
- your **time slot**. The order is published in advance. If you miss your slot you are moved to the end of the queue.

## Your contribution (one command)

```bash
git clone <REPO URL> veyl && cd veyl && git checkout <COMMIT>
npm ci
npm run ceremony -- contribute --coordinator <COORDINATOR URL> --token <YOUR TOKEN>
```

What happens:

1. It asks you to type some random text (optional, press Enter to skip). This is mixed in on top of 64 bytes of operating
   system randomness and snarkjs's own randomness. Type it at the prompt. Do not pass it with `--text` on the command
   line: that ends up in your shell history.
2. For each circuit in turn it downloads the latest key from the coordinator and checks its sha256.
3. It adds your contribution, uploads it, and waits. The coordinator accepts it only if it keeps every earlier
   contribution, adds exactly one new one under your name, is for that circuit, and passes a full `snarkjs zkey verify`.
4. It prints your **contribution hash** for that circuit.

At the end it saves a receipt with your five hashes: `veyl-contribution-<your-name>.json`. The receipt holds only public
values.

You do not upload anything by hand. The command fetches the previous key and sends yours back over HTTP to the coordinator.

**Offline (air-gapped) option.** If you prefer, ask the coordinator for the five key files instead. Then run, once per
circuit, on the offline machine:

```bash
npm run ceremony -- contribute --in <circuit>_000N.zkey --out <circuit>_mine.zkey --name "<your registered name>"
```

Each run prints your contribution hash. Return the five output files to the coordinator by whatever channel you agreed.

## After your turn

1. **Post your five contribution hashes publicly** (for example a signed post or a gist under your name), right away. This
   lets anyone match them against the transcript.
2. **Check it is in.** Right away, `<COORDINATOR URL>/status` lists your hash under your name for each circuit.
3. **After the ceremony closes**, the coordinator publishes `ceremony/TRANSCRIPT.md` with one section per circuit. Find
   your hash in each section.
4. **Check independently.** The `verify` command recomputes every contribution hash from the final key itself. Download
   the two public phase-1 files (hashes are in `ceremony/README.md`), then:

```bash
git checkout <RELEASE COMMIT> && npm ci
npm run ceremony -- verify --circuit withdraw --zkey zk/keys/withdraw_final.zkey --ptau powersOfTau28_hez_final_14.ptau
npm run ceremony -- verify --circuit transact --zkey zk/keys/transact_final.zkey --ptau powersOfTau28_hez_final_15.ptau
npm run ceremony -- verify --circuit position --zkey zk/keys/position_final.zkey --ptau powersOfTau28_hez_final_15.ptau
npm run ceremony -- verify --circuit swap     --zkey zk/keys/swap_final.zkey     --ptau powersOfTau28_hez_final_15.ptau
npm run ceremony -- verify --circuit claim    --zkey zk/keys/claim_final.zkey    --ptau powersOfTau28_hez_final_14.ptau
```

Each must print `OK` and list your name and hash, followed by the final beacon.

## Destroying your randomness

Your secret exists only in the memory of the `contribute` process. Nothing secret is written to disk: the temporary key
files are deleted after each upload, and the receipt holds only hashes. To be sure it is gone:

1. Let the command finish, then close the terminal.
2. If you typed random text, do not write it down or keep it anywhere.
3. Shut down the machine. If it was a VM or cloud instance, delete it.

## Please do not

- Do not use a different commit than the one the coordinator gave you, or change the code.
- Do not share your token, and do not post it publicly.
- Do not keep, copy or reuse your randomness or typed text.
- Do not run the command twice at the same time, or outside your slot (an upload out of turn is refused).
- Do not contribute under someone else's name.

Questions before or during your slot: `<COORDINATOR CONTACT>`.
