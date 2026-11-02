// Deposit caps (sdk/caps.js, relayer/caps.js, relayer/postman.js, engine shieldDeposit). Run: node tests/caps.js [--no-chain]
// A. No chain: the cap rules, where the caps come from (config / CAPS_JSON / CAPS=off), GET /info, the engine's up-front
//    refusal (same words), the bundle carries it.
// B. Its own local validator on RPC 9123 (not the shared 8933): the real publisher admits a deposit within the caps, holds
//    one over the per-deposit cap and one over the total (both stay pending), the depositor takes one back in full
//    (cancel_deposit), and a held deposit is admitted once there is room.
'use strict';
process.env.RPC_PORT = process.env.CAPS_RPC_PORT || '9123'; process.env.SEALED_CRANK = '0';
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); const C = require('../sdk/caps.js');
const { capsFromEnv } = require('../relayer/caps.js');
const { Relayer, serve } = require('../relayer/relayer.js');
const { check, refused, finish, loadEngine, freshValidator, funded } = require('./harness.js');
void assert;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL = 'So11111111111111111111111111111111111111112', ODD = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const toks = { [USDC]: { sym: 'USDC', mint: USDC, decimals: 6, usd: 1 }, [SOL]: { sym: 'SOL', mint: SOL, decimals: 9, usd: 100 }, [ODD]: { sym: ODD, mint: ODD, decimals: 6, usd: 0 } };
const u = (n, d = 6) => BigInt(Math.round(n * 10 ** d));

async function noChain() {
  console.log('  -- A. no chain');
  const caps = C.normCaps({ _comment: 'x', perDeposit: { USDC: 10000, SOL: 50, '*': 1000, BAD: -1 }, totalShielded: { USDC: 25000 } });
  check('normCaps keeps positive numbers only (comments, negatives dropped); nothing capped = null', caps.perDeposit.USDC === 10000 && !('BAD' in caps.perDeposit) && !('_comment' in caps.perDeposit) && C.normCaps({ perDeposit: { _c: 1 } }) === null && C.normCaps(null) === null);
  check('capOf: named token in atoms; "*" in USD at the token\'s price; unpriced under "*"', C.capOf(caps, 'perDeposit', toks[USDC]).atoms === u(10000) && C.capOf(caps, 'perDeposit', { sym: 'JUP', mint: 'j', decimals: 6, usd: 0.5 }).atoms === u(2000) && C.capOf(caps, 'perDeposit', toks[ODD]).unpriced && C.capOf(caps, 'totalShielded', toks[SOL]) === null);
  const P = (amount, mint = USDC, i = 0) => ({ pending: 'p' + i, mint, amount: String(amount), depositor: 'd' });
  const plan = C.admitPlan([P(u(10000), USDC, 1), P(u(10000.000001), USDC, 2), P(u(9000), USDC, 3), P(u(7000), USDC, 4), P(u(5000), USDC, 5), P(u(1), ODD, 6), P(u(50, 9), SOL, 7)], caps, (m) => toks[m], { [USDC]: u(1000) });
  check('admitPlan: exactly at the per-deposit cap is admitted, one atom over is held (perDeposit)', plan[0].ok && !plan[1].ok && plan[1].why === 'perDeposit');
  check('admitPlan: the total counts what is already shielded and what this pass admits, oldest first (1,000 + 10,000 + 9,000; then 7,000 is over 25,000, 5,000 still fits)', plan[2].ok && !plan[3].ok && plan[3].why === 'totalShielded' && plan[4].ok);
  check('admitPlan: an unpriced token under "*" is held; SOL at its cap admitted; no caps admits everything', !plan[5].ok && plan[5].why === 'unpriced' && plan[6].ok && C.admitPlan([P(u(1e9))], null, () => null).every((x) => x.ok));
  // where the caps come from
  const cfgCaps = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/mainnet.json'), 'utf8')).caps;
  check('capsFromEnv: mainnet reads config/mainnet.json "caps"; devnet / local have none (unchanged)', JSON.stringify(capsFromEnv({}, 'mainnet')) === JSON.stringify(C.normCaps(cfgCaps)) && capsFromEnv({}, 'devnet') === null && capsFromEnv({}, 'local') === null);
  check('capsFromEnv: CAPS_JSON replaces the config\'s caps; CAPS=off turns them off', capsFromEnv({ CAPS_JSON: '{"perDeposit":{"USDC":5}}' }, 'mainnet').perDeposit.USDC === 5 && !capsFromEnv({ CAPS_JSON: '{"perDeposit":{"USDC":5}}' }, 'mainnet').totalShielded && capsFromEnv({ CAPS: 'off' }, 'mainnet') === null);
  // GET /info (a relayer on a deployment that is never read: no chain call is made for /info)
  const local = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/local.json'), 'utf8'));
  const dep = { network: 'mainnet', programs: local.programs, binPools: [], lookupTables: [], tokens: { USDC: { mint: USDC, pool: Keypair.generate().publicKey.toBase58(), decimals: 6, price: 1 }, SOL: { mint: SOL, pool: Keypair.generate().publicKey.toBase58(), decimals: 9, price: 100 } } };
  const r = new Relayer({ connection: new Connection('http://127.0.0.1:9'), wallet: Keypair.generate(), deploy: dep, caps: { perDeposit: { USDC: 10000, '*': 1000 }, totalShielded: { USDC: 250000 } } });
  const srv = serve(r, 0); await new Promise((ok) => srv.once('listening', ok));
  const info = await (await fetch('http://127.0.0.1:' + srv.address().port + '/info')).json(); srv.close(); for (const j of ['crank', 'bal', 'asp', 'admit']) clearInterval(srv[j]);
  check('GET /info serves caps per mint: amount, atoms, decimals; "*" priced per token; total with room (null until measured)', info.caps && info.caps.perDeposit[USDC].amount === 10000 && info.caps.perDeposit[USDC].atoms === String(u(10000)) && info.caps.perDeposit[SOL].amount === 10 && info.caps.perDeposit[SOL].usd === 1000 && info.caps.totalShielded[USDC].room === null && info.caps.perDepositUsd === 1000, JSON.stringify(info.caps).slice(0, 200));
  const r0 = new Relayer({ connection: new Connection('http://127.0.0.1:9'), wallet: Keypair.generate(), deploy: { ...dep, network: 'devnet' } });
  check('no caps (devnet config): /info says caps null', r0.info().caps === null && r0.caps === null);
  r.capRoom[USDC] = { room: u(1500), at: Date.now() };
  // the engine's up-front refusal, with the words the app shows
  const tokU = { sym: 'USDC', mint: USDC, decimals: 6 };
  check('capMessage: over the per-deposit cap -> "Deposits are capped at 10,000 USDC while Veyl is new."', C.capMessage(r.capsInfo(), tokU, u(10001)) === 'Deposits are capped at 10,000 USDC while Veyl is new.' && C.capMessage(r.capsInfo(), tokU, u(1500)) === null && C.capMessage({ perDeposit: r.capsInfo().perDeposit }, tokU, u(10000)) === null);
  check('capMessage: over the room left under the total says how much more can go in', /at most 250,000 USDC in total while it is new: up to 1,500 USDC more/.test(C.capMessage(r.capsInfo(), tokU, u(2000))));
  r.capRoom[USDC] = { room: 0n, at: Date.now() };
  check('capMessage: total reached -> try again later; no caps -> null', /that is reached\. Try again later\./.test(C.capMessage(r.capsInfo(), tokU, u(1))) && C.capMessage(null, tokU, u(1e9)) === null);
  const { installShield } = loadEngine('shield-engine.js'); class E {} installShield(E, Error);
  const eng = (caps, onSync) => Object.assign(Object.create(E.prototype), { pk: Keypair.generate().publicKey, tok: () => ({ mint: USDC, decimals: 6 }), unit: (s, v) => u(v), relayerInfo: async () => JSON.parse(S.j({ caps })), zw: {}, shieldSync: async () => { onSync(); throw new Error('past the cap check'); }, store: { data: {}, save() {} } });
  let synced = false; const e1 = eng(r.capsInfo(), () => (synced = true)); r.capRoom[USDC] = { room: u(250000), at: Date.now() }; const e2 = eng(r.capsInfo(), () => {});
  check('engine shieldDeposit: over the cap it throws the cap message before anything else runs (no sync, no proof, no wallet)', await refused(e1.shieldDeposit('USDC', 20000), /^Deposits are capped at 10,000 USDC while Veyl is new\.("")?$/) && !synced);
  check('engine shieldDeposit: within the caps it goes on (reaches the sync)', await refused(e2.shieldDeposit('USDC', 500), /past the cap check/));
  const e3 = Object.assign(eng(null, () => {}), { relayerInfo: async () => { throw new Error('relayer down'); } });
  check('engine shieldDeposit: a relayer that cannot be reached does not block the deposit (the publisher still enforces)', await refused(e3.shieldDeposit('USDC', 1e9), /past the cap check/));
  const dc = await e1.depositCap('USDC'); check('engine depositCap(sym): { max, total, room } in whole tokens for the app\'s hint', dc.max === 10000 && dc.total === 250000 && dc.room === 0 && dc.message === null, JSON.stringify(dc));
  const bundle = fs.readFileSync(path.join(__dirname, '../site/veyl-sol.js'), 'utf8');
  check('site/veyl-sol.js (npm run bundle) carries the cap check', bundle.includes('while Veyl is new') && bundle.includes('depositCap'));
}

async function onChain() {
  console.log('  -- B. own validator on RPC ' + process.env.RPC_PORT);
  const Z = require('../sdk/shield.js'); const { proveTransact } = require('../sdk/prover.js'); const { deployAll, fund, units } = require('../scripts/lib.js');
  const { rpc, conn, payer, payerFile, done } = await freshValidator('veyl-caps-');
  try {
    const [postman, relayer, alice, bob, carol] = await funded(conn, 5, 20);
    const { V, dep, T } = await deployAll({ rpc, payerFile, postman: postman.publicKey, relayer: relayer.publicKey, deploy: true });
    const M = T.USDC.mint; const MK = M.toBase58();
    for (const k of [alice, bob, carol]) await fund(conn, payer, M, k.publicKey, units(10_000, 6));
    const as = (kp) => { const v = new S.Veyl({ connection: conn, programs: V.programs, payer: kp }); v.lookupTable = V.lookupTable; return v; };
    const mints = Object.fromEntries(Object.values(T).map((t) => [t.mint.toBase58(), { sym: t.sym, decimals: t.decimals }]));
    const svc = new Relayer({ connection: conn, wallet: relayer, deploy: dep, postman, caps: { perDeposit: { USDC: 500 }, totalShielded: { USDC: 800 } } });
    const amt = async (a) => BigInt((await conn.getTokenAccountBalance(a)).value.amount);
    /// one real shielded deposit (transact proof made here, posted and verified on chain): its pending record
    const deposit = async (kp, n) => { const w = new Z.ShieldWallet(crypto.randomBytes(32), { mints, pools: [] }); const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); w.scan(st);
      const d = w.deposit(M, units(n, 6)); const pr = await proveTransact(d.input); await as(kp).send([V.postProofIx(kp.publicKey, 1, pr.proof, pr.pubs)], [], 1_400_000);
      const sig = await as(kp).send([await V.shieldDepositIx(kp.publicKey, d.ext, pr.pubs)], [], 600_000); return (await V.events(sig)).find((e) => e.name === 'DepositPending').pending; };
    const pA = await deposit(alice, 400); let n = await svc.approveDeposits();
    check('within the caps (400 of 500 per deposit, 800 total): the publisher admits it', n === 1 && !(await V.pending(pA)));
    const pB = await deposit(bob, 600); n = await svc.approveDeposits();
    check('over the per-deposit cap (600 > 500): not admitted, it stays pending', n === 0 && !!(await V.pending(pB)) && (await V.pending(pB)).amount === units(600, 6));
    const pC = await deposit(carol, 450); n = await svc.approveDeposits(); n += await svc.approveDeposits();
    check('over the total (400 shielded + 450 > 800): not admitted on two passes, stays pending', n === 0 && !!(await V.pending(pC)));
    const room = svc.info().caps.totalShielded[MK].room;
    check('/info: room under the total measured by the publisher (800 - 400 = 400 USDC)', room === String(units(400, 6)), room);
    check('the engine refuses bob\'s 600 up front with the same caps', C.capMessage(JSON.parse(S.j(svc.info())).caps, { sym: 'USDC', mint: MK, decimals: 6 }, units(600, 6)) === 'Deposits are capped at 500 USDC while Veyl is new.');
    check('only the depositor can take a held deposit back', await refused(as(carol).send([await V.cancelDepositIx(carol.publicKey, pB, M)]), /NotDepositor|ConstraintAddress|2012/));
    const b0 = await amt(V.ata(M, bob.publicKey)); await as(bob).send([await V.cancelDepositIx(bob.publicKey, pB, M)]);
    check('take-back: bob cancels his held deposit and gets all 600 USDC back; the record is closed', (await amt(V.ata(M, bob.publicKey))) === b0 + units(600, 6) && !(await V.pending(pB)));
    n = await svc.approveDeposits(); check('after the take-back the publisher still holds carol\'s (the total has not moved)', n === 0 && !!(await V.pending(pC)));
    const svc2 = new Relayer({ connection: conn, wallet: relayer, deploy: dep, postman, caps: { perDeposit: { USDC: 500 }, totalShielded: { USDC: 900 } } });
    n = await svc2.approveDeposits(); check('room opens (total raised to 900): the held deposit is admitted on the next pass', n === 1 && !(await V.pending(pC)));
    const svc3 = new Relayer({ connection: conn, wallet: relayer, deploy: dep, postman, caps: null }); const pD = await deposit(alice, 5000);
    n = await svc3.approveDeposits(); check('no caps: any size is admitted (devnet / local behaviour unchanged)', n === 1 && !(await V.pending(pD)));
  } catch (e) { check('on-chain caps run', false, e.stack); }
  return done;
}

(async () => {
  await noChain(); let done = null;
  if (!process.argv.includes('--no-chain')) done = await onChain();
  finish(done, { cu: false });
})().catch((e) => { console.error(e); process.exit(1); });
