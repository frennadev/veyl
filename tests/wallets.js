#!/usr/bin/env node
// Wallet discovery and the provider wrapper (engine/wallets.js) against fake Wallet Standard wallets in a fake window:
// a wallet registering after the page loaded, non-Solana wallets left out, the account on this deployment's chain, legacy
// and v0 transactions signed and returned as the same type, silent connect, account switch and disconnect events, and
// injected globals listed once and only when no Standard wallet has that name. No network, no validator.
'use strict';
globalThis.window = new EventTarget();
const { check, finish, loadEngine } = require('./harness.js');
const W = loadEngine('wallets.js');
const { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');

/// A Standard wallet holding `keys`, recording what it was asked.
function fakeWallet(name, keys, chains = ['solana:mainnet', 'solana:devnet']) {
  const listeners = new Set(); const calls = { connect: [], sign: [] };
  const acct = (kp) => ({ address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes(), chains, features: ['solana:signTransaction'] });
  let accounts = keys.map(acct);
  const signOne = (bytes, kp) => {
    try { const v = VersionedTransaction.deserialize(bytes); if (v.version === 0) { v.sign([kp]); return v.serialize(); } } catch { /* legacy */ }
    const t = Transaction.from(bytes); t.partialSign(kp); return t.serialize({ requireAllSignatures: false });
  };
  const w = {
    version: '1.0.0', name, icon: 'data:image/svg+xml,<svg/>', chains, get accounts() { return accounts; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async (input) => { calls.connect.push(input); return { accounts }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { calls.disconnected = true; } },
      'standard:events': { version: '1.0.0', on: (ev, f) => { listeners.add(f); return () => listeners.delete(f); } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => {
        calls.sign.push(inputs.map((i) => ({ chain: i.chain, account: i.account.address })));
        return inputs.map((i) => ({ signedTransaction: signOne(i.transaction, keys.find((k) => k.publicKey.toBase58() === i.account.address)) }));
      } },
    },
  };
  const emit = (props) => listeners.forEach((f) => f(props));
  return { w, calls, emit, setAccounts: (ks) => { accounts = ks.map(acct); emit({ accounts }); } };
}
const register = (...ws) => window.dispatchEvent(Object.assign(new Event('wallet-standard:register-wallet'), { detail: ({ register: r }) => r(...ws) }));

(async () => {
  W.setChain('devnet');
  check('chain ids: local, devnet, mainnet', W.chainOf('local') === 'solana:localnet' && W.chainOf('devnet') === 'solana:devnet' && W.chainOf('mainnet') === 'solana:mainnet');
  check('no wallets yet: an empty list', W.walletList().length === 0);

  // a wallet that registers after the page loaded
  let fired = 0; const off = W.onWallets(() => fired++);
  const waiting = W.waitForWallet('Phantom', 1000);
  const a = Keypair.generate(), b = Keypair.generate(); const ph = fakeWallet('Phantom', [a, b]);
  register(ph.w, fakeWallet('EthOnly', [Keypair.generate()], ['eip155:1']).w);
  check('a late registration notifies the page', fired === 1); off();
  const list = W.walletList();
  check('Solana wallets listed, others left out', list.length === 1 && list[0].name === 'Phantom' && list[0].standard && list[0].icon.startsWith('data:'));
  check('waitForWallet resolves when the wallet registers', (await waiting) === list[0]);
  check('waitForWallet gives null for a wallet that never shows', (await W.waitForWallet('Nope', 50)) === null);
  check('the same provider object on every call', W.walletList()[0] === list[0]);

  // connect: the account on the deployment's chain (b only on devnet)
  const two = fakeWallet('Two', [a, b]); const p2 = W.fromStandard(two.w);
  two.w.features['standard:connect'].connect = async () => ({ accounts: [{ ...two.w.accounts[0], chains: ['solana:mainnet'] }, two.w.accounts[1]] });
  const c2 = await p2.connect();
  check('connect: the account on this chain is chosen', c2.publicKey.equals(b.publicKey) && p2.publicKey.equals(b.publicKey));
  const p = list[0]; await p.connect({ silent: true });
  check('silent connect asks without a prompt', ph.calls.connect[0]?.silent === true && p.publicKey.equals(a.publicKey));

  // signing: legacy and v0 come back as the type that went in, signed by the account, on this chain
  const ix = SystemProgram.transfer({ fromPubkey: a.publicKey, toPubkey: b.publicKey, lamports: 1 }); const bh = Keypair.generate().publicKey.toBase58();
  const legacy = new Transaction({ feePayer: a.publicKey, recentBlockhash: bh }).add(ix);
  const signed = await p.signTransaction(legacy);
  check('legacy transaction signed and returned as a Transaction', signed.version === undefined && signed.verifySignatures());
  const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: a.publicKey, recentBlockhash: bh, instructions: [ix] }).compileToV0Message());
  const [s1, s2] = await p.signAllTransactions([v0, v0]);
  check('v0 transactions signed in one request', s1.version === 0 && s2.version === 0 && ph.calls.sign.at(-1).length === 2 && s1.signatures[0].some((x) => x !== 0));
  check('sign requests name the deployment chain', ph.calls.sign.every((c) => c.every((i) => i.chain === 'solana:devnet' && i.account === a.publicKey.toBase58())));

  // events
  const seen = []; const unwatch = p.onChange((x) => seen.push(x));
  ph.emit({ chains: ['solana:devnet'] });
  check('a change that is not about accounts is ignored', seen.length === 0);
  ph.setAccounts([b]);
  check('switching account reports the new one', seen[0] === b.publicKey.toBase58() && p.publicKey.equals(b.publicKey));
  ph.setAccounts([]);
  check('no accounts left reports a disconnect', seen[1] === null && p.publicKey === null);
  unwatch(); ph.setAccounts([a]);
  check('nothing reported after unsubscribing', seen.length === 2);
  const idle = W.fromStandard(fakeWallet('Idle', [a]).w); const idleSeen = []; idle.onChange((x) => idleSeen.push(x));
  check('a wallet not connected here reports nothing', idleSeen.length === 0);
  await p.disconnect();
  check('disconnect tells the wallet and clears the key', ph.calls.disconnected === true && p.publicKey === null);
  let refused = false; try { await p.signTransaction(legacy); } catch { refused = true; }
  check('signing after disconnect is refused', refused);

  // injected globals
  const raw = { isPhantom: true, publicKey: a.publicKey, connect: async (o) => ({ publicKey: a.publicKey, o }), signTransaction: async (t) => t, on() {}, removeListener() {} };
  window.phantom = { solana: raw }; window.solana = raw;
  const sf = { connect: async () => ({ publicKey: b.publicKey }), signTransaction: async (t) => t }; window.solflare = sf;
  const names = W.walletList().map((x) => x.name + (x.standard ? '' : '*'));
  check('injected Phantom hidden behind the Standard one; Solflare listed once, after', JSON.stringify(names) === '["Phantom","Solflare*"]', JSON.stringify(names));
  delete window.solflare;
  const W2 = loadEngine('wallets.js'); // a fresh page with no Standard wallets: the e2e mock wallet
  window.solana = raw; window.phantom = { solana: raw };
  const inj = W2.walletList();
  check('injected only: one entry for window.solana and window.phantom.solana', inj.length === 1 && inj[0].name === 'Phantom' && !inj[0].standard);
  const r = await inj[0].connect({ silent: true });
  check('injected silent connect uses onlyIfTrusted', r.o?.onlyIfTrusted === true && inj[0].publicKey.equals(a.publicKey));
  check('injected without signAllTransactions leaves it undefined', W2.fromInjected('X', sf).signAllTransactions === undefined);
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
