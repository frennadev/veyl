# Arbitrage bot

Keeps Veyl's pool prices in line with the market. A limit order fills only when a swap crosses its bin, so if nobody
trades a Veyl pool after the market moves, orders there never fill. This bot does those trades: when a pool's price is
further from the market than a trade costs, it buys or sells in that pool until the price is back within that cost.

## How it decides (`strategy.js`)
- **When:** only when the gap between the pool's price and the market's is wider than the pool's swap fee (base +
  volatility), plus the 0.2% protocol fee, plus a margin (`ARB_MARGIN_BPS`, default 10).
- **How much:** it simulates the swap exactly as the program would (SDK `simulateSwap`) and takes the largest amount that
  still ends in a bin priced better than market after fees. Every unit it trades is profitable, and it stops short of
  pushing past the market price.
- **Skips:**
  - trades whose profit after the transaction cost is under `ARB_MIN_PROFIT_USD` (0.5);
  - delisted and empty pools;
  - pools whose market price is missing or stale (older than `ARB_MAX_PRICE_AGE`, 60 s);
  - a sealed pool while its batch is settling or about to close. A sealed batch settles at the pool's price, and moving
    it then would front-run the people in the batch.
- **Limits:** at most `ARB_MAX_TRADE_USD` (2,000) per swap, `minOut` with `ARB_SLIPPAGE_BPS` (50), and never trades away
  the reserve (`ARB_RESERVE_SOL`, 0.05 wrapped SOL).

## Running it
```
ARB_ONCE=1 node arb/arb.js --network devnet                              # one dry pass: prints what it would do
ARB_KEY=~/keys/veyl/arb.json node arb/arb.js --network devnet            # dry run with the bot's real balances
ARB_LIVE=1 ARB_KEY=~/keys/veyl/arb.json node arb/arb.js --network devnet # sends swaps
```
Use your own RPC (`RPC_URL=…`): the public devnet RPC rate-limits. The bot waits 250 ms between pools and backs off on errors.

## Funding
The bot trades from its own inventory and doesn't hedge on another exchange. It needs:
- native SOL for transaction fees (about 0.000010 SOL per swap; it warns below 0.005 SOL);
- an SPL balance of both tokens in each pool it trades, with SOL as **wrapped** SOL.

Its inventory drifts toward the token the market is moving away from, so watch it and top it up, or rebalance it.

## Scope
- Only the pools in `deploy.<network>.json` are traded. Pools listed on chain since are skipped: their tokens may have no
  market price, and a thin new pool at a price its creator chose is a trap.
- Prices come from `engine/market.js` by mainnet mint (Pyth with `PYTH_API_KEY`, then Jupiter, CoinGecko, Coinbase), so
  only tokens in its `MAINNET_MINTS` are priced: SOL, USDC, USDT, JUP and BONK. That's every token in
  `config/mainnet.json`. On devnet, pools of the other mock tokens are skipped. Pricing them needs their verified mainnet
  mints in `MAINNET_MINTS`.
- **Mainnet is refused** unless `ARB_MAINNET=1`. Set it only with the owner's go-ahead, after the independent audit.
