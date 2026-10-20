// No chain required: discovered-token rent is charged and created only inside the checked execution transaction.
'use strict';
const assert = require('assert');
const { Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { Relayer } = require('../relayer/relayer.js');
const S = require('../sdk/veyl.js'), Z = require('../sdk/shield.js');
const ok = (name, condition) => { assert.ok(condition, name); console.log('ok -', name); };
(async () => {
  const r = Object.create(Relayer.prototype), mint = Keypair.generate().publicKey;
  r.wallet = Keypair.generate(); r.extraTokens = { [mint.toBase58()]: { mint: mint.toBase58() } };
  r.symOf = { [mint.toBase58()]: { sym: mint.toBase58() } };
  let exists = false, charged = 0, sent = [], standalone = 0, refuse = false;
  r.conn = { getAccountInfo: async () => exists ? {} : null };
  r.V = { _tp: { [mint.toBase58()]: spl.TOKEN_2022_PROGRAM_ID }, signerPda: () => PublicKey.default,
    tokenProgram: async () => spl.TOKEN_2022_PROGRAM_ID,
    ata: (m, owner, tp) => spl.getAssociatedTokenAddressSync(new PublicKey(m), owner, false, tp),
    shieldTransactIx: async () => ({ action: true }),
    send: async () => { standalone++; throw new Error('standalone spending'); },
    sendV0Checked: async (ixs) => { sent.push(ixs); return 'confirmed'; } };
  const ext = { mint, processor: PublicKey.default, relayer: r._feeAta(mint), fee: 100n, extAmount: 0n };
  const req = { kind: 'transact', ext, p: {} };
  r.shieldCost = async () => 10;
  r._coverOrRefuse = (lam) => { charged = lam; if (refuse) throw new Error('fee too low'); };
  r._post = async () => ({ pubs: [0n, 0n, Z.extHash(ext)], poster: r.wallet.publicKey });
  r._cancelProofs = async () => {};
  await r.submitShield(req);
  ok('missing Token-2022 fee ATA is in the execution transaction', sent.length === 1 && sent[0].length === 2 && sent[0][0].programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID) && sent[0][0].keys[5].pubkey.equals(spl.TOKEN_2022_PROGRAM_ID) && sent[0][1].action);
  ok('missing ATA rent is included in fee coverage; no standalone spending', charged === 10 + S.rentOf(S.SIZES.tokenAccount) && standalone === 0);
  exists = true; sent = []; await r.submitShield(req);
  ok('existing fee ATA needs no rent or creation instruction', charged === 10 && sent[0].length === 1);
  exists = false; refuse = true; sent = [];
  await assert.rejects(r.submitShield(req), /fee too low/);
  ok('underpaid requests never create fee accounts', sent.length === 0 && standalone === 0);
  refuse = false; r._withDiscovery = (f) => f();
  await assert.rejects(r.submit({ kind: 'unknown', mint: mint.toBase58() }), /unknown kind/);
  ok('unknown submit kinds cannot trigger account creation', standalone === 0 && sent.length === 0);
  { let release, runs = 0; const gate = new Promise((resolve) => { release = resolve; });
    r._crankSealedOnce = async () => { runs++; await gate; return 1; };
    const first = r.crankSealed(), second = r.crankSealed(); release(); await Promise.all([first, second]);
    ok('slow sealed upkeep is shared across timer ticks', runs === 1);
    await r.crankSealed(); ok('sealed upkeep runs again after the previous pass', runs === 2);
  }

})().catch((e) => { console.error(e); process.exit(1); });
