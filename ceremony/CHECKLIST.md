# Key ceremony: coordinator checklist

You run this as the coordinator. Your contributors follow `ceremony/CONTRIBUTE.md`. Everything runs from `~/Projects/veyl`.
The full reference is `ceremony/README.md`; this is the order to do it in.

**Why it matters:** today's proving keys came from one machine. Whoever kept that machine's randomness could forge proofs
and drain every pool. After the ceremony, the keys are safe as long as **one** contributor destroyed their randomness.

**Time:** about 1 hour of your time, spread over a day while contributors take their turns (each takes about 20 minutes).

## 1. Line up contributors (before the day)

- At least **3 people who are not you** and don't work together. Five to ten is better. You may contribute too, but you
  don't count toward the three.
- Each needs a computer with Node 20+, about 4 GB of free memory, and access to the repo. The repo is private: give them
  read access or send them a zip of this commit.
- Agree on the order and a rough time window for each.
- Pick the **beacon**: a Bitcoin block height a few hours after the last contributor's slot. Announce it to everyone before
  anyone contributes. Nobody can know that block's hash in advance, so nobody can steer the result.

## 2. Prepare (on your Mac)

```bash
cd ~/Projects/veyl && git pull && npm ci
mkdir -p ceremony/ptau && for p in 14 15; do curl -L -o ceremony/ptau/powersOfTau28_hez_final_$p.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_$p.ptau; done
b2sum ceremony/ptau/*.ptau              # must match the hashes in ceremony/README.md ("Phase 1")
npm run ceremony -- r1cs                # the five circuits rebuild to exactly the shipped files
npm run ceremony -- init
```

For each contributor, in the agreed order (each command prints a token **once**: save it):

```bash
npm run ceremony -- add-participant --name "<their name or handle>"
```

## 3. Open the coordinator

Keep two terminal windows open for the whole ceremony:

```bash
npm run ceremony -- serve --host 127.0.0.1 --port 8853     # window 1
cloudflared tunnel --url http://127.0.0.1:8853              # window 2: prints https://<random>.trycloudflare.com
```

Your Mac must stay on and awake until the last contribution is in (`caffeinate -dims` in a third window helps).

## 4. Send each contributor, privately

- `ceremony/CONTRIBUTE.md`, with `<COORDINATOR URL>` = the `trycloudflare.com` address and `<COMMIT>` = `git rev-parse HEAD`;
- **their own token**, by a private message (not a group chat);
- their time slot.

Watch progress at `https://<the tunnel address>/status`. Each contributor's upload is checked automatically. If someone
doesn't show up, move them to the end of the queue so the next person can go: `npm run ceremony -- skip --name "<name>"`.

## 5. Close it (after the last contribution, once the beacon block exists)

```bash
npm run ceremony -- beacon --btc-height <the announced height>
npm run ceremony -- verify               # every circuit must say OK
npm run ceremony -- finalize             # writes the new keys, the transcript and the program's verifying keys
```

Stop the server and the tunnel.

## 6. Rebuild with the new keys

The program checks proofs against keys built into it, so it must be rebuilt (same program addresses):

```bash
npm run build:mainnet                    # target/deploy-mainnet/, with the new verifying keys
MAINNET_KEYPAIR_DIR=~/keys/veyl/mainnet npm run keys:mainnet -- --check
npm test                                 # about 20 minutes: every proof flow with the new keys
RPC_URL=<Helius mainnet> DEPLOYER_KEYPAIR=~/keys/veyl/mainnet/deployer.json PROGRAM_KEYPAIR_DIR=~/keys/veyl/mainnet \
  npm run preflight -- --network mainnet  # "trusted setup (ceremony)" must now be green
```

## 7. Publish

- Commit `ceremony/TRANSCRIPT.md`, `ceremony/transcript.json`, `zk/keys/` and the verifying-key files (finalize lists them).
- Publish every intermediate key from `ceremony/work/` (for example as a GitHub release), so anyone can re-check each step.
- Tell each contributor the final transcript is out, so they can check their entry (`CONTRIBUTE.md` shows how).

Then the ceremony is no longer a blocker, and the mainnet deploy can go ahead.

## If something goes wrong

- **An upload is refused:** the contributor runs the command again. Nothing is lost.
- **Your Mac restarted:** start step 3 again. The tunnel address changes, so send the new one to whoever is next.
- **A contributor is unreachable:** `npm run ceremony -- skip --name "<name>"` moves them to the end; if they never come
  back, finish with the others (you still need at least 3 who did contribute).
- **You want a practice run first:** `npm run ceremony:rehearse -- --ptau ceremony/ptau/powersOfTau28_hez_final_15.ptau`
  runs the whole thing on your Mac with fake contributors. Its keys are never used.
