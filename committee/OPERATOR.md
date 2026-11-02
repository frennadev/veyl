# Running a Veyl batch committee node

This page is for an independent operator who runs one of the three nodes of Veyl's sealed-batch committee on mainnet.

Veyl is private concentrated liquidity on Solana. Its sealed swaps hide the size of each trade: every sealed swap is
encrypted to the committee's joint key, and the program adds the ciphertexts into one encrypted total per direction for
each batch (about a minute). The committee decrypts only those totals so the batch can settle.

Veyl has not yet had an independent audit. The cryptography is described in `committee/README.md`.

## What your node sees, and what it does not

- **It sees** each batch's two totals (one per direction), after it and one other node post their partial decryptions.
  These totals are public on chain anyway once the batch settles.
- **It does not see** any individual sealed swap's amount, who made it, or anyone's balance. The protocol never asks a
  node to decrypt an individual swap.
- **It cannot steal or misprice.** A wrong partial decryption fails its on-chain proof check (Chaum-Pedersen), and a wrong
  total fails the settlement check.

## Trust model: 2 of 3

- Any **2** of the 3 nodes can settle a batch. **One** node alone learns nothing.
- **Two operators who collude could decrypt every individual sealed swap**, past and future, under the current key: each
  swap's ciphertext is public and encrypted to the same joint key. This is why operators must be independent of each other
  and of the Veyl team, and must never share, copy or pool their key shares.
- If your share is stolen, you are one step closer to that. Treat it like a private key holding user funds.
- If nodes stop, nothing is lost: a batch that cannot settle within its window refunds everyone in it.

## What you need

- A small, always-on Linux server or Docker host, on infrastructure you control. 1 vCPU and 2 GB RAM is enough (recovering
  a large batch total builds a lookup table in memory). Persistent disk for the key share.
- A public HTTP(S) address for the node **during key generation** (the other nodes fetch your messages from it). HTTPS
  through a reverse proxy is recommended.
- A **dedicated mainnet RPC endpoint** (Helius, Triton or similar). The public endpoint rate-limits.
- **0.1 to 0.5 SOL** on your node key for transaction fees. Each partial decryption is 5 transactions plus a temporary
  account whose rent is refunded.
- Node.js 20+ (to run `node committee/node.js keys`), the Solana CLI (`solana-keygen`), and Docker if you use the image.
- The repository at the commit the coordinator names: `<REPO URL>`, `<COMMIT>`.

## Steps

### 1. Make your node key

The node key is a Solana keypair. It signs key-generation messages and pays for your node's transactions. Your node's
encryption key for key generation (the "box key") is derived from it, so it is the only secret you keep before step 3.

```bash
git clone <REPO URL> veyl && cd veyl && git checkout <COMMIT> && npm ci
solana-keygen new -o ~/veyl-committee/node.json
NODE_KEY=~/veyl-committee/node.json node committee/node.js keys
# prints {"node":"<public key>","boxKey":"<base64>"}
```

### 2. Send the coordinator your public keys

Send **only** the two values printed above (`node` and `boxKey`) and the URL your node will be reachable at. Never send
`node.json`.

The coordinator sends every member the same peer list and a session name:

```json
{ "t": 2, "n": 3, "peers": [ { "index": 1, "url": "https://...", "node": "<pubkey>", "boxKey": "<base64>" }, ... ] }
```

Add your own `"index"` at the top level and save it as `committee.json`. Check that your entry has your `node`, your
`boxKey` and your URL; the node refuses to start key generation otherwise.

Fund your node key with 0.1 to 0.5 SOL.

### 3. Join the key generation (at the agreed time)

All three nodes must start within **10 minutes** of each other. Each node publishes signed messages, fetches the others',
and ends with its own secret share of the joint key. Nobody ever holds the whole key.

```bash
docker build -f committee/Dockerfile -t veyl-sol-committee .
docker run -d --name veyl-committee --restart unless-stopped -p 8863:8863 -v veyl-committee:/data \
  -e COMMITTEE_JSON="$(cat committee.json)" \
  -e NODE_SECRET_KEY="$(cat ~/veyl-committee/node.json)" \
  -e DKG_SESSION=<SESSION NAME> \
  -e NETWORK=mainnet -e RPC_URL=<YOUR RPC URL> \
  veyl-sol-committee
curl -s http://localhost:8863/health
```

Without Docker: the same variables, then `node committee/node.js` with `STATE_DIR` on a persistent disk.

When `/health` shows `"dkg":"done"`, the node has written two files to its state directory:

- `share.json`: **your secret key share** (file mode 0600);
- `transcript.json`: public; every node serves the same one at `GET /transcript`.

Compare the `pk` field of your `/health` with the other operators': all three must be equal. If key generation fails
(`"dkg":"failed: ..."`), any complaint aborts the session: agree a new session name with the coordinator and start again.

### 4. Registration

The coordinator commits the public transcript as `committee/transcript.mainnet.json` and registers the joint key on chain
during the deploy. The deploy writes `deploy.mainnet.json` (public). Your node needs it to find the program and the pools:
either rebuild the image from the release commit that contains it, or put the file on your volume and set
`DEPLOY_FILE=/data/deploy.mainnet.json`, then restart. The share stays on the volume across restarts.

Check that the committed transcript is the one your node served (`GET /transcript`).

### 5. Run continuously

Once `/health` shows `"registered":true`, the node:

- closes batches whose epoch is over;
- posts and proves its partial decryption for every closed batch;
- recovers the totals and settles once two shares are verified.

It needs no further input. Keep it running and funded. After key generation it only talks to the RPC, so you may close
the public port and keep `/health` private.

## Environment variables

| variable | required | what |
|---|---|---|
| `COMMITTEE_JSON` | yes (or `COMMITTEE_CONFIG`) | the peer list with your `index` at the top level. `COMMITTEE_CONFIG` = path to the same JSON as a file |
| `NODE_SECRET_KEY` | yes (or `NODE_KEY`) | your node key: JSON byte array (the `solana-keygen` file content) or base58. `NODE_KEY` = path to the keypair file instead |
| `DKG_SESSION` | for key generation | the session name, the same on all three nodes. Ignored once a share exists |
| `NETWORK` | yes | `mainnet`. Picks `deploy.mainnet.json` (and, with `SHARE_JSON`, `committee/transcript.mainnet.json`) |
| `RPC_URL` | yes | your dedicated RPC. Defaults to the deployment's RPC if unset |
| `STATE_DIR` | yes | where `share.json` and `transcript.json` live. `/data` in the image; mount a persistent volume there |
| `PORT` | no | HTTP port, default `8863` |
| `DEPLOY_FILE` / `DEPLOY_JSON` | after the deploy | path to, or inline content of, `deploy.mainnet.json`, if it is not in the image |
| `SHARE_JSON` | no | your existing `share.json` content, for hosts without a persistent disk. Written to `STATE_DIR` on first start, after checking it matches your index and committee |
| `TRANSCRIPT_JSON` | no | with `SHARE_JSON`: the transcript content. Defaults to `committee/transcript.<NETWORK>.json` |
| `WATCH_MS` | no | how often it checks the chain, default `3000` |
| `SETTLE`, `CLOSE` | no | `0` turns off settling or closing batches (both default on) |

## Monitoring

`GET /health` returns:

| field | healthy value |
|---|---|
| `ok` | `true` |
| `registered` | `true`: the on-chain committee is this key, with your member key and node key at your index |
| `dkg` | `done` (`idle`, `round1`, `round2` during key generation; `failed: ...` if it failed) |
| `lastShare` | the last batch you posted a share for: pool, batch number, transactions, time |
| `lastSettle` | the last batch your node settled (another node or the relayer may settle first, so this can lag) |
| `lastError` | `null`, or the last error message. One-off RPC errors are normal; a repeating one is not |
| `balanceSol` | above about 0.05. Top up before it runs out |

Also returned: `index`, `t`, `n`, `node`, `boxKey`, `pk` (the joint key) and `version`. The Docker image runs this check
every 30 seconds. Alert on `ok` not true, `registered` false, a falling `balanceSol`, or `lastShare` not moving while
sealed swaps are happening.

## If your node goes down

- Two nodes are enough to settle, so one node down does not stop sealed swaps. Tell the other operators and the
  coordinator, and bring it back.
- If two nodes are down, batches wait; past their settlement window, everyone in them is refunded. No funds are lost.
- On restart the node reads `share.json` from its state directory and carries on. It does not run key generation again.

## Key backup and handling

- **Back up `share.json` and `node.json` offline, encrypted**, right after key generation. If more than one share is lost
  for good, the committee can never settle under that key again (batches refund until a new key is generated).
- **Never run two copies of your node** with the same share.
- **Moving hosts:** stop the old node, copy `share.json` over an encrypted channel, start the new node, check `/health`,
  then securely delete the old copy. Never paste the share into chat, email, tickets or a shared password manager.
- Never give your share or node key to anyone, including the Veyl team or another operator.
- If you suspect your share leaked, tell the coordinator at once: the committee authority can rotate to a new key.

## Leaving

1. Tell the coordinator in advance. A replacement runs a new key generation with the remaining members, and the committee
   authority registers the new key on chain (`set_committee`).
2. Keep your node running until the coordinator confirms the new committee is registered. After that your node stops
   acting on its own (it serves only the committee registered on chain); batches still open under the old key are refunded.
3. Then stop the node and securely delete `share.json` and its backups. Old sealed swaps stay encrypted on chain, so a
   share kept around remains a risk to them.
4. Move any SOL left on the node key out.

Contact: `<COORDINATOR CONTACT>`.
