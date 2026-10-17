// POST /drip: test tokens on devnet and local only.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
'use strict';
const { PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
module.exports = (Base) => class Faucet extends Base {
  /// Test tokens for testers on devnet / local: a little SOL for network fees first (nothing works without it), then a fixed
  /// amount of every mock token to `to`. Only with FAUCET_KEY (the deployer: the mock mints' authority) and never on mainnet. Rate-limited by the caller.
  async drip(to, want) { if (!this.faucet || this.dep.network === 'mainnet') throw new Error('No test tokens on this network.');
    const owner = new PublicKey(to); const out = []; // about $1,000 of every token (5 SOL), rounded to two figures
    const amt = (sym, t) => (sym === 'SOL' ? 5 : Number((1000 / (Number(t.price) || 1)).toPrecision(2)));
    // the core basket by default; a pool page asks for its own pair (at most 4 extra tokens per request)
    const CORE = ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'WIF', 'JTO', 'PYTH', 'RAY']; const extra = (Array.isArray(want) ? want : []).filter((s) => this.dep.tokens[s] && !CORE.includes(s)).slice(0, 4); // CORE = scripts/lib.js BUILTIN_TOKENS (the relayer image ships without scripts/)
    const pick = Array.isArray(want) && want.length ? [...new Set(['SOL', 'USDC', ...want.filter((s) => this.dep.tokens[s]).slice(0, 4)])] : [...CORE, ...extra];
    if ((await this.conn.getBalance(owner)) < 20_000_000) { const { SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
      await sendAndConfirmTransaction(this.conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: this.faucet.publicKey, toPubkey: owner, lamports: 50_000_000 })), [this.faucet], { commitment: 'confirmed' }); out.push('0.05 SOL for fees'); }
    for (const [sym, t] of Object.entries(this.dep.tokens).filter(([s]) => pick.includes(s))) { const n = amt(sym, t); if (!(n > 0)) continue; const mint = new PublicKey(t.mint); const tp = (await this.conn.getAccountInfo(mint)).owner;
      const ata = await spl.getOrCreateAssociatedTokenAccount(this.conn, this.faucet, mint, owner, true, 'confirmed', { commitment: 'confirmed' }, tp);
      await spl.mintTo(this.conn, this.faucet, mint, ata.address, this.faucet, BigInt(Math.round(n * 10 ** t.decimals)), [], { commitment: 'confirmed' }, tp); out.push(n.toLocaleString('en-US') + ' ' + sym); }
    return { sent: out }; }
};
