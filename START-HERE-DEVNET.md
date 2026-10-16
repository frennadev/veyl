# Put Veyl live on Solana devnet (from your Mac)

Devnet is Solana's public test network: real wallets, real transactions, free test SOL worth nothing.

## Once
1. Install **Node 20+** from https://nodejs.org (the LTS button).
2. Unzip this folder somewhere (Documents is fine).

## Every time you want it online
1. Double-click **VEYL-DEVNET.command** (if macOS blocks it: right-click → Open → Open).
2. The first run installs the Solana tools, makes a **devnet-only** key and prints its address.
3. Send that address the devnet SOL the window asks for (free): https://faucet.solana.com — sign in with GitHub and repeat until it says ✓.
   All 83 pools need about **62 devnet SOL**; just the 12 core pools need about **38** (start with `CORE_ONLY=1 ./VEYL-DEVNET.command`).
   Faucet limits change; it can take a few rounds or a day. The window waits and continues on its own.
4. It prices every token from Meteora's live pools, deploys Veyl (83 pools: SOL–USDC and the majors plus every major Meteora pair), adds starting liquidity to each, and prints a **public link**. Share that link.
5. Keep the window open and the Mac on while people test. The link changes each run.

## What testers do
- Open the link → **Get started** → **No wallet needed** (or connect Phantom / Solflare / Backpack set to **devnet**).
- Press **Get test tokens** (SOL, USDC, USDT, JUP, BONK, WIF, JTO, PYTH, RAY); on any other pool, its **Get test X + Y** button → **Move into private balance** → add liquidity, swap, withdraw.

## Notes
- Re-running is safe: the deploy skips what already exists, and seeding skips pools that already have liquidity. If SOL runs out mid-way, top up and run it again.
- The key at `~/.config/veyl-sol/devnet-deployer.json` is for devnet only. Never send real SOL to it.
- Sealed (batch) swaps need the 3-server committee and stay off on this setup; instant private swaps work.
- For an always-on link without your Mac: host the relayer on Render and the site on Vercel (DEPLOY.md).
