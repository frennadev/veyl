#!/usr/bin/env node
// The browser engine's safety rails and note delivery, against a stubbed chain and relayer (no network, no validator):
// the backup step before the first deposit (required, acknowledged, done, never in the Sandbox), linkability hints for a
// withdrawal, the outbox (planned notes recorded before submitting, adopted when no ciphertext arrives, dropped once found
// or failed, carried by the encrypted backup to a new device) and the incremental tree cache with its root check.
'use strict';
globalThis.window = new EventTarget();
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
let relay = null; globalThis.fetch = async (url) => { if (relay && String(url).endsWith('/submit')) { const r = relay; return { json: async () => r }; } throw new Error('offline'); };
const { Keypair, PublicKey } = require('@solana/web3.js');
const { check, finish, loadEngine } = require('./harness.js');
const Z = require('../sdk/shield.js');
const E = loadEngine('sol-entry.js');

const mk = () => Keypair.generate().publicKey.toBase58();
const USDC = mk(); const programs = { entry: mk(), pool: mk(), bin: mk(), factory: mk() };
const cfgOf = (o = {}) => ({ chainName: 'Test', cluster: 'devnet', rpc: 'http://127.0.0.1:9', relayer: 'http://127.0.0.1:9', programs, tokens: { USDC: { mint: USDC, decimals: 6 } }, binPools: [], ...o });
const refusedWith = async (p, re) => { try { await p; return false; } catch (e) { return re.test(String(e.code || '') + ' ' + e.message); } };

/// A fake chain behind engine.V: leaves, ciphertexts, nullifiers; every root it ever had is a known root.
function stubChain(e) { const ch = { leaves: [], cts: new Map(), nullified: new Set(), roots: new Set(), calls: [], corruptInc: false };
  ch.root = () => { const r = String(new Z.Tree(ch.leaves).root()); ch.roots.add(r); return r; }; ch.root();
  e.V.shield = async () => { const cur = ch.root(); return { isKnownRoot: (x) => ch.roots.has(String(x)), nextIndex: BigInt(ch.leaves.length), currentRoot: BigInt(cur) }; };
  e.V.readShield = async ({ prev = null } = {}) => { ch.calls.push(prev ? 'inc' : 'full'); const leaves = ch.corruptInc && prev ? [...ch.leaves, 12345n] : [...ch.leaves];
    return { leaves, ciphertexts: new Map(ch.cts), receipts: new Map(), pending: [], nullified: new Set(ch.nullified), deposits: {}, newest: 's' + ch.leaves.length + ':' + ch.nullified.size + ':' + ch.cts.size }; };
  return ch; }
const pubsWith = (nf0, nf1) => ['0', '0', '0', '0', String(nf0), String(nf1), '0', '0'];

(async () => {
  // ---------------------------------------------------------------------------------------------- backup before the first deposit
  const e = new E.Engine(cfgOf()); let s = e.backupState();
  check('backup: a fresh account on a real network needs the backup step, and deposits refuse until it is done', s.required && !s.done && s.stepNeeded && s.enforced && s.backedUpAt === null && s.ackAt === null);
  check('backup: deposit() and shieldDeposit() refuse with BACKUP_REQUIRED before touching the network', (await refusedWith(e.deposit('USDC', '5'), /BACKUP_REQUIRED/)) && (await refusedWith(e.shieldDeposit('USDC', '5'), /BACKUP_REQUIRED/)));
  e.requireBackup = false; check('backup: engine.requireBackup = false lifts the refusal (the step is still shown)', !e.backupState().enforced && e.backupState().stepNeeded && (await refusedWith(e.deposit('USDC', '5'), /Connect a wallet/))); delete e.requireBackup;
  check('backup: config requireBackup: false lifts it too', !new E.Engine(cfgOf({ programs: { ...programs, entry: mk() }, requireBackup: false })).backupState().enforced);
  const at = e.ackNoBackup(); s = e.backupState();
  check('backup: "I understand" is stored with the time and ends the step; deposits go ahead', typeof at === 'number' && s.done && !s.stepNeeded && !s.enforced && s.ackAt === at && s.backedUpAt === null);
  { const seed = e.store.data.shield.seed; e.store.data.shield.seed = Buffer.alloc(32, 7).toString('base64'); const other = e.backupState(); e.store.data.shield.seed = seed;
    check('backup: the acknowledgement belongs to the seed it was given for (another account asks again)', other.stepNeeded && other.enforced && e.backupState().done); }
  const bt = e.markBackedUp(); check('backup: markBackedUp() records the download', e.backupState().backedUpAt === bt && e.backupState().done);
  { const d = new E.Engine(cfgOf({ programs: { ...programs, entry: mk() } })); d.sandbox = true; const x = d.backupState();
    check('backup: the Sandbox never asks and never refuses', !x.required && !x.stepNeeded && !x.enforced); }

  // ---------------------------------------------------------------------------------------------- linkability hints
  { const to = mk(); e.shieldState = { leaves: new Array(10).fill(0n), deposits: { [USDC]: 3 } };
    e.store.data.depLog = [{ sym: 'USDC', amount: '25000000', at: Date.now() - 10 * 60_000, tx: 't1' }];
    let r = e.linkRisks('USDC', '25', to); const ids = r.warnings.map((w) => w.id);
    check('link: same amount as a deposit 10 min ago, to a Solana address: amount, timing and small-crowd warnings, plus the VPN/Tor tip', ids.includes('amount') && ids.includes('timing') && ids.includes('crowd') && r.tip.id === 'network' && /VPN or Tor/.test(r.tip.text) && r.crowd.token === 3 && r.crowd.total === 10 && r.crowd.min === 50, ids.join(','));
    check('link: an amount within 1% counts as the same; the text says "almost"', /almost the same amount/.test((e.linkRisks('USDC', '25.1', to).warnings.find((w) => w.id === 'amount') || {}).text || ''));
    e.store.data.depLog = [{ sym: 'USDC', amount: '25000000', at: Date.now() - 2 * 3_600_000, tx: 't1' }]; e.shieldState.deposits[USDC] = 80;
    r = e.linkRisks('USDC', '40', to); check('link: a different amount, 2 h later, in a crowd of 80: no warnings, the tip stays', r.warnings.length === 0 && r.tip && r.crowd.token === 80);
    e.store.data.depLog = []; e.store.data.shield.pending = [{ commitment: '1', sym: 'USDC', amount: '7000000', tx: 't2', at: Date.now() - 5 * 60_000 }];
    r = e.linkRisks('USDC', '7', to); check('link: a deposit still waiting for admission counts too', r.warnings.some((w) => w.id === 'amount') && r.warnings.some((w) => w.id === 'timing'));
    r = e.linkRisks('USDC', '7', e.veylAddress()); check('link: a send to a Veyl address (amount and parties hidden): no warnings, just the tip', r.warnings.length === 0 && r.tip.id === 'network');
    e.shieldState = { leaves: new Array(12).fill(0n) }; r = e.linkRisks('USDC', '1', to); check('link: without per-token numbers the crowd falls back to the whole tree', r.crowd.token === null && r.crowd.total === 12 && r.warnings.some((w) => w.id === 'crowd' && /12 private deposits/.test(w.text)));
    e.store.data.shield.pending = []; delete e.shieldState; }

  // ---------------------------------------------------------------------------------------------- outbox and incremental sync
  const ch = stubChain(e); await e.shieldSync(); const zw = e.zw; const mint = new PublicKey(USDC);
  check('sync: the first sync reads the tree in full (no cache; the relayer is offline) and caches it in this browser', ch.calls.join() === 'full' && [...mem.keys()].some((k) => k.startsWith('veyl:shieldcache:' + programs.entry)));
  const d1 = zw.deposit(mint, 5_000_000n); const c1 = String(d1.commitments[0]);
  relay = null; check('outbox: a request the relayer refuses still leaves its planned note, marked failed', (await refusedWith(e.submit({ kind: 'transact', ext: d1.ext, p: { pubs: pubsWith(11, 12) } }), /offline/)) && e.outboxState().some((o) => o.commitment === c1 && o.failed));
  relay = { txHash: 'tx1', txs: ['tx1'] }; await e.submit({ kind: 'transact', ext: d1.ext, p: { pubs: pubsWith(11, 12) } }); let ob = e.outboxState();
  check('outbox: before submitting, the note the request creates for this account is stored (empty notes are not); it carries the tx once sent', ob.length === 1 && ob[0].commitment === c1 && ob[0].tx === 'tx1' && !ob[0].failed && e.store.data.shield.outbox[0].nf.includes('11'));
  ch.leaves.push(BigInt(d1.commitments[0]), BigInt(d1.commitments[1])); await e.shieldSync();
  check('outbox: the commitment is a leaf but no ciphertext came (a cut log): the note is adopted, spendable, the entry kept', e.shieldBalance('USDC') === 5_000_000n && e.outboxState()[0].adopted && !!zw.notes.find((n) => String(n.commitment) === c1).outbox);
  check('sync: the next sync reads incrementally from the cache', ch.calls.slice(-1)[0] === 'inc');
  ch.cts.set(c1, { data: d1.ext.encOut[0] }); await e.shieldSync();
  check('outbox: once a ciphertext delivers it, the entry is dropped and the note stays', e.outboxState().length === 0 && e.shieldBalance('USDC') === 5_000_000n);
  // adopted, then spent: nothing left to remember
  const d2 = zw.deposit(mint, 3_000_000n); relay = { txHash: 'tx2', txs: ['tx2'] }; await e.submit({ kind: 'transact', ext: d2.ext, p: { pubs: pubsWith(21, 22) } });
  ch.leaves.push(BigInt(d2.commitments[0]), BigInt(d2.commitments[1])); await e.shieldSync(); const n2 = zw.notes.find((n) => String(n.commitment) === String(d2.commitments[0]));
  check('outbox: a second adopted note adds to the balance', e.shieldBalance('USDC') === 8_000_000n && e.outboxState().length === 1);
  // a new device restores the backup made now: it carries the outbox and finds the adopted note (no ciphertext anywhere)
  const text = await e.exportEncrypted('correct horse'); const e2 = new E.Engine(cfgOf({ programs: { ...programs, entry: mk() } })); const ch2 = stubChain(e2); ch2.leaves = [...ch.leaves]; ch2.cts = new Map(ch.cts);
  await e2.importEncrypted(text, 'correct horse');
  check('backup: the encrypted backup carries the outbox; restored on a new device, the note only the outbox knows is found', JSON.parse(e.store.export()).shield.outbox.length === 1 && (e2.store.data.shield.outbox || []).length === 1 && e2.shieldBalance('USDC') === 8_000_000n && !!e2.backupState().backedUpAt);
  ch.nullified.add(String(n2.nullifier)); await e.shieldSync();
  check('outbox: an adopted note that is spent no longer needs its entry', e.outboxState().length === 0 && e.shieldBalance('USDC') === 5_000_000n);
  // failed for good: its inputs were spent by another action; refused long ago; refused just now (kept for a while)
  const d3 = zw.deposit(mint, 1_000_000n), d4 = zw.deposit(mint, 1_000_000n), d5 = zw.deposit(mint, 1_000_000n); relay = null;
  for (const [d, nf] of [[d3, 31], [d4, 41], [d5, 51]]) await e.submit({ kind: 'transact', ext: d.ext, p: { pubs: pubsWith(nf, nf + 1) } }).catch(() => {});
  e.store.data.shield.outbox.find((o) => o.c === String(d4.commitments[0])).at -= 31 * 60_000; ch.nullified.add('31'); await e.shieldSync(); ob = e.outboxState().map((o) => o.commitment);
  check('outbox: dropped when its inputs were spent by another action, or refused over 30 min ago; kept when refused just now', !ob.includes(String(d3.commitments[0])) && !ob.includes(String(d4.commitments[0])) && ob.includes(String(d5.commitments[0])), ob.length + ' left');
  // the cache disagrees with the chain: back to a full read
  ch.corruptInc = true; ch.calls.length = 0; await e.shieldSync(); ch.corruptInc = false;
  check('sync: a cached state whose root the chain does not know is thrown away and the tree read in full', ch.calls.join() === 'inc,full' && e.shieldBalance('USDC') === 5_000_000n);
  e.shieldCacheClear(); ch.calls.length = 0; await e.shieldSync(); check('sync: shieldCacheClear() forces a full read', ch.calls.join() === 'full');

  // ---------------------------------------------------------------------------------------------- the relayer's log-cut guard
  { const S = require('../sdk/veyl.js'); const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const ins = (i) => 'Program data: ' + Buffer.concat([S.disc('NoteInserted', 'event'), u64(i), Buffer.alloc(32, i + 1)]).toString('base64');
    const other = 'Program data: ' + Buffer.alloc(40, 9).toString('base64'); const cut = 'Log truncated';
    check('log guard: logs that were not cut always pass', Z.logCut(['Program x invoke [1]', ins(4)], 99) === null);
    check('log guard: cut after every leaf (tree size 6 = last index 5 + 1) and something after it: passes (a cut payload or UI event is recoverable)', Z.logCut([ins(4), ins(5), other, cut], 6n) === null);
    check('log guard: cut before the last leaves (tree size 8, last logged index 5): refused', /from index 6/.test(Z.logCut([ins(4), ins(5), other, cut], 8n) || ''));
    check('log guard: cut right after a NoteInserted (its ReceiptNote would be lost): refused', /last new note/.test(Z.logCut([ins(4), ins(5), cut], 6n) || ''));
    check('log guard: cut before any leaf of an action that adds some: refused', !!Z.logCut([other, cut], 3n));
    // veyl_pool's event CPI: one self-CPI per instruction, data = EVENT_IX_TAG + events in Anchor's encoding, back to back
    const insData = (i) => Buffer.concat([S.disc('NoteInserted', 'event'), u64(i), Buffer.alloc(32, i + 1)]); const nul = Buffer.concat([S.disc('Nullified', 'event'), Buffer.alloc(32, 7)]);
    const evs = S.parseEventData(Buffer.concat([insData(4), nul, insData(5)]));
    check('event CPI: several events back to back decode in order (NoteInserted, Nullified, NoteInserted), and garbage after them stops the decoder', evs.map((x) => x.name).join() === 'NoteInserted,Nullified,NoteInserted' && evs[2].index === 5n && S.parseEventData(Buffer.concat([insData(4), Buffer.alloc(12, 1)])).length === 1);
    const pool = Keypair.generate().publicKey; const V = new S.Veyl({ connection: { }, programs: { pool, bin: pool, entry: pool } }); const b58 = require('bs58');
    const inner = [{ index: 0, instructions: [{ programId: pool.toBase58(), accounts: [], data: b58.encode(Buffer.concat([S.EVENT_IX_TAG, insData(4), insData(5)])) }, { programId: Keypair.generate().publicKey.toBase58(), accounts: [], data: b58.encode(Buffer.concat([S.EVENT_IX_TAG, insData(9)])) }] }];
    const cpi = V.cpiEvents(inner);
    check('event CPI: cpiEvents takes only veyl_pool\'s own self-CPIs (another program\'s look-alike is ignored)', cpi.length === 2 && cpi[1].index === 5n);
    check('log guard: with the event CPI holding every leaf, a cut log passes; with a leaf missing from it, refused', Z.logCut([other, cut], 6n, cpi) === null && /from index 6/.test(Z.logCut([other, cut], 7n, cpi) || ''));
    const le = S.logEvents(['Program ' + pool.toBase58() + ' invoke [1]', 'Program X1 invoke [2]', ins(1), 'Program X1 success', ins(2), 'Program ' + pool.toBase58() + ' success', ins(3)]);
    check('log events: each carries the program whose frame logged it (invoke / success lines), null outside any frame', le.map((x) => x.program).join() === 'X1,' + pool.toBase58() + ','); }
  finish(null, { cu: false });
})().catch((e) => { console.error(e); process.exit(1); });
