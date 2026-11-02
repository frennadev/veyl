# Veyl tester round: what to try

Thank you for testing Veyl. Veyl is private liquidity on Solana: you add liquidity, swap and send, and nobody can link it
back to your wallet.

**This is a test network.** The app runs on Solana **devnet**. Every token is test money with no value. Never send real
funds to any address you see here.

**What is private, and what is not.** Your private balance, your positions, your fees and who made a private swap or send
are hidden. Deposits into Veyl and withdrawals out of it are public (wallet, token and amount), and everything that
happens at a pool (amounts in and out, prices) is public, just not who did it. The Privacy page in the app shows how
private you are right now.

Link to the app: `<APP LINK>`

## Before you start

- A computer or phone with a recent browser (Chrome, Safari, Firefox, Brave).
- Optional: a wallet (Phantom, Solflare or Backpack) **switched to devnet** in its settings. You can test without one.
- Some steps build a zero-knowledge proof on your device. That can take up to a minute. Please note how long it takes.

## Things to try

Do as many as you like, in any order after step 3. Steps 1 to 4 come first.

### 1. Get started

1. Open the link and press **Get started**.
2. Pick one:
   - **No wallet needed**: Veyl makes a deposit address in your browser. You fund it in step 2.
   - **or connect a wallet**: pick Phantom, Solflare or Backpack. Make sure it is on devnet.

### 2. Get test tokens

1. Press **Get test tokens**. You receive test SOL for fees and test USDC, USDT, JUP, BONK, WIF, JTO, PYTH and RAY.
2. On a pool page for other tokens, use its **Get test X + Y** button.

Limits apply (a few hours between requests).

### 3. Move funds into your private balance

1. No-wallet mode: in **Fund your deposit address**, press **Move into private balance**. With a wallet: go to
   **Portfolio** and press **Deposit**.
2. The app asks you to back up first. Press **Back up now** (see step 10) or **Continue without a backup**.
3. Pick a token and an amount, then press **Deposit**.
4. Your deposit shows as **Pending** for a short while, then appears in your **Private balance**.

### 4. Swap privately

1. Go to **Swap**. Under **Pay from**, choose **Private**.
2. Pick two tokens, enter an amount, press **Swap privately**.

### 5. Add liquidity

1. Go to **Pools** and open a pool.
2. In the **Add** tab, under **Pay from**, choose **Private**.
3. Pick a range: **Tight**, **Balanced** or **Wide**. Try **More options** and **Simulate** too.
4. Enter amounts and press **Add privately**.
5. Your position shows on the pool page and in **Portfolio**.

### 6. Claim fees

1. Wait for some swaps in that pool (or make one yourself).
2. On your position, press **Claim fees**, then **Claim**. Send it to your private balance.
3. Try **Rebalance** and **Withdraw** on the position too.

### 7. Send to a Veyl address

1. Ask another tester for their Veyl address (it starts with `veyl:`), or use a second browser of your own.
2. **Portfolio** → **Withdraw**. Paste the `veyl:` address in **To**, enter an amount, press **Send**.
3. The other person's private balance should go up. Nobody else can see the amount or who sent it.

### 8. Receive with a QR code or payment link

1. **Portfolio** → next to **Your Veyl address**, press **Receive**.
2. Optionally set an amount and token. Press **Copy payment link**, or show the QR code.
3. Open the link (or scan the code) in another browser or on another device. It should open **Pay privately** with the
   details filled in.

### 9. Withdraw to a fresh address

1. Create a brand new address in your wallet (one that has never been used).
2. **Portfolio** → **Withdraw**. Paste the new address, enter an amount, press **Send**.
3. Veyl refuses the wallet you deposited from and any address with history. Please try that too and tell us if the warning
   is clear.

### 10. Back up and restore in another browser

1. Account menu → **Back up (encrypted)** (or **Portfolio** → **Back up**). Choose a passphrase and press **Save backup**.
2. Open the app in a different browser (or a private window).
3. Account menu → **Restore from backup**. Choose the file, enter the passphrase, press **Restore**.
4. Your private balance and positions should come back. Note how long it takes.

### 11. Sealed swap (if offered)

Some pools offer sealed swaps, which also hide the size of your trade.

1. Open a pool, go to the **Swap** tab, and under **Swap mode** choose **Sealed**.
2. Enter an amount and confirm. Your swap joins the pool's current batch (about a minute).
3. Go to **Sealed swaps**. Under **Your sealed swaps**, press **Claim** once the batch has settled, or **Refund** if it did
   not.

A batch needs at least 3 swaps on each side to settle. If there are not enough, it waits and then refunds everyone. Try
this together with other testers at the same time.

### 12. Create a pool

1. Go to **Create pool**. Pick two tokens, a fee tier and an opening price.
2. Press **Create pool and pay the bond**. The bond is **1 test SOL**, refundable after 30 days. It is devnet SOL, so it
   costs nothing real. The faucet gives only a little SOL for fees: get more test SOL from faucet.solana.com first.
3. Creating a pool is public (your wallet appears as the creator). Add liquidity to it afterwards, privately.

## What to report

For each problem or confusing moment, please send:

1. **Device and browser** (for example: iPhone 15, Safari; Windows laptop, Chrome).
2. **Wallet**: no-wallet mode, or which wallet.
3. **What you did**, step by step.
4. **What you expected** to happen.
5. **What happened** instead, with any error message word for word.
6. **A screenshot** or screen recording.
7. **Proof time**: how long "Building a zero-knowledge proof" took, if you saw it.

Also tell us what you liked, and any word or screen you did not understand.

Report here: `<REPORT LINK>`

Please never share your backup file, passphrase or wallet recovery phrase with anyone, including us.
