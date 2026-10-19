// Solana wallets the page can connect. Every Wallet Standard wallet that signs Solana transactions (Phantom, Solflare,
// Backpack, Jupiter, OKX, Glow, the Android Mobile Wallet Adapter, ...), found whenever it registers, even after the page
// loaded. Then wallets that only inject a global (older extensions, the e2e mock wallet), unless a Standard wallet already
// has that name. Each comes back as the provider shape the engine signs with:
//   { name, icon, standard, publicKey, connect({silent}), disconnect(), signTransaction(tx), signAllTransactions(txs), onChange(cb) }
// Nothing here is fetched: icons are the data URIs the wallets register with.
import { getWallets } from '@wallet-standard/app';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

const CONNECT = 'standard:connect', DISCONNECT = 'standard:disconnect', EVENTS = 'standard:events', SIGN = 'solana:signTransaction';

/// The Wallet Standard chain id for a deployment's cluster (config `cluster`: local / devnet / mainnet).
export const chainOf = (cluster) => (cluster === 'mainnet' ? 'solana:mainnet' : cluster === 'devnet' ? 'solana:devnet' : 'solana:localnet');
let CHAIN = 'solana:localnet';
export function setChain(cluster) { CHAIN = chainOf(cluster); }

const isSolana = (w) => !!w.features?.[CONNECT] && !!w.features?.[SIGN] && (w.chains || []).some((c) => c.startsWith('solana:'));
/// The account to use: one on this deployment's chain, else any Solana account (wallets rarely list localnet).
const pick = (accounts) => accounts.find((a) => a.chains?.includes(CHAIN)) || accounts.find((a) => (a.chains || []).some((c) => c.startsWith('solana:'))) || accounts[0] || null;
// v0 or legacy by shape, not instanceof: a transaction built with another copy of web3.js is still the right kind
const isV0 = (tx) => tx.version !== undefined;
const ser = (tx) => (isV0(tx) ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
const de = (bytes, like) => (isV0(like) ? VersionedTransaction.deserialize(bytes) : Transaction.from(bytes));

export function fromStandard(w) {
  let account = null;
  const use = (a) => { account = a; p.publicKey = a ? new PublicKey(a.publicKey) : null; return p.publicKey; };
  const p = {
    name: w.name, icon: w.icon || null, standard: true, publicKey: null,
    async connect({ silent = false } = {}) {
      const r = await w.features[CONNECT].connect(silent ? { silent: true } : undefined);
      const a = pick(r?.accounts?.length ? r.accounts : w.accounts);
      if (!a) throw new Error(silent ? 'Not connected.' : w.name + ' did not share a Solana account.');
      return { publicKey: use(a) };
    },
    async disconnect() { use(null); try { await w.features[DISCONNECT]?.disconnect(); } catch { /* already gone */ } },
    async signAllTransactions(txs) {
      if (!account) throw new Error('Connect a wallet first.');
      const chain = account.chains?.includes(CHAIN) ? CHAIN : undefined;
      const out = await w.features[SIGN].signTransaction(...txs.map((tx) => ({ account, chain, transaction: ser(tx) })));
      return out.map((o, i) => de(o.signedTransaction, txs[i]));
    },
    async signTransaction(tx) { return (await p.signAllTransactions([tx]))[0]; },
    /// cb(base58 | null) when the wallet switches account or drops the connection. Returns the unsubscribe.
    onChange(cb) {
      const off = w.features[EVENTS]?.on('change', ({ accounts }) => {
        if (!accounts || !account) return; // not about accounts, or not connected here
        const a = pick(accounts); use(a); cb(a ? p.publicKey.toBase58() : null);
      });
      return off || (() => {});
    },
  };
  return p;
}

const b58 = (k) => (k == null ? null : typeof k.toBase58 === 'function' ? k.toBase58() : String(k));
export function fromInjected(name, raw) {
  return {
    name, icon: raw.icon || null, standard: false,
    get publicKey() { return raw.publicKey; },
    connect: ({ silent = false } = {}) => raw.connect(silent ? { onlyIfTrusted: true } : undefined),
    async disconnect() { try { await raw.disconnect?.(); } catch { /* already gone */ } },
    signTransaction: (tx) => raw.signTransaction(tx),
    signAllTransactions: raw.signAllTransactions ? (txs) => raw.signAllTransactions(txs) : undefined,
    onChange(cb) {
      const changed = (pk) => cb(b58(pk)), gone = () => cb(null);
      raw.on?.('accountChanged', changed); raw.on?.('disconnect', gone);
      return () => { raw.removeListener?.('accountChanged', changed); raw.removeListener?.('disconnect', gone); };
    },
  };
}

const cache = new WeakMap(); // one provider per wallet, so the list keeps its identities between calls
const wrap = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };

/// Every wallet that can connect right now, Standard ones first.
export function walletList() {
  if (typeof window === 'undefined') return [];
  const out = getWallets().get().filter(isSolana).map((w) => wrap(w, () => fromStandard(w)));
  const taken = (n) => out.some((p) => p.name.toLowerCase() === n.toLowerCase());
  const seen = new Set();
  const add = (n, raw) => { if (!raw || seen.has(raw) || taken(n)) return; seen.add(raw); out.push(wrap(raw, () => fromInjected(n, raw))); };
  add('Phantom', window.phantom?.solana); add('Solflare', window.solflare); add('Backpack', window.backpack);
  add(window.solana?.isPhantom ? 'Phantom' : 'Wallet', window.solana);
  return out;
}
/// cb() whenever a wallet registers or leaves. Returns the unsubscribe.
export function onWallets(cb) {
  if (typeof window === 'undefined') return () => {};
  const w = getWallets(); const a = w.on('register', cb), b = w.on('unregister', cb);
  return () => { a(); b(); };
}
/// The wallet called `name` once it has registered (extensions can register a moment after the page loads), or null.
export function waitForWallet(name, ms = 1500) {
  const find = () => walletList().find((p) => p.name === name) || null;
  const now = find(); if (now || typeof window === 'undefined') return Promise.resolve(now);
  return new Promise((done) => {
    const off = onWallets(() => { const p = find(); if (p) { off(); clearTimeout(t); done(p); } });
    const t = setTimeout(() => { off(); done(find()); }, ms);
  });
}
