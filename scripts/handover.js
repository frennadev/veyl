#!/usr/bin/env node
// npm run handover -- --network <local|devnet|mainnet> --to <multisig> [--postman <key>] [--dry-run] [--accept-keypair <file>] [--freeze-lut] [--confirm-mainnet]
//
// Moves every privileged role of a deployment (deploy.<network>.json) from the deployer key to `--to`, e.g. a Squads vault:
//   1. postman of every private pool -> --postman (default --to)      set_postman, while the deployer is still the pool authority
//   2. pool authority of every private pool -> --to                   propose_authority (two-step: --to must accept)
//   3. factory authority (veyl_bin) -> --to                           propose_factory_authority (two-step)
//      protocol fee authority (veyl_bin) -> --to                      propose_fee_authority (two-step)
//      reward funder of every bin pool's reward slots -> --to         set_reward_funder (immediate)
//      committee authority (veyl_entry, Phase 3) -> --to              propose_committee_authority (two-step)
//   4. upgrade authority of the three programs -> --to                solana program set-upgrade-authority (immediate)
//   5. --accept-keypair: --to is a plain key you hold: accept 2 and 3 now. Otherwise the accept instructions are printed
//      for the multisig to execute (e.g. Squads transaction builder: program, accounts, data).
//   6. --freeze-lut: freeze the relayer's lookup table (its authority cannot be transferred; frozen = nobody can change it).
// Roles not held by the deployer are reported and left alone; re-running is safe. --dry-run reads the chain and prints the plan.
// DEPLOYER_KEYPAIR = the current authority (path, never printed). Preflight flags any role still held by the deployer.
'use strict';
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const { Connection, PublicKey, Keypair, AddressLookupTableProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const N = require('./net.js'); const { Veyl } = require('../sdk/veyl.js'); const { readRoles, roleFindings } = require('./roles.js');

function solanaCli() { const d = process.env.SOLANA_BIN || '/opt/solana/bin'; return fs.existsSync(path.join(d, 'solana')) ? path.join(d, 'solana') : 'solana'; }
const ixJson = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), dataBase58: bs58.encode(ix.data) });

/// The plan and (unless dryRun) its execution. Returns { plan, accepts, roles, findings }.
async function handover({ rpc, dep, deployer, deployerFile, to, postman, dryRun = false, acceptKeypair = null, freezeLut = false, log = console.log }) {
  to = new PublicKey(to); postman = new PublicKey(postman || to); const me = deployer.publicKey.toBase58();
  const conn = new Connection(rpc, 'confirmed'); const V = new Veyl({ connection: conn, programs: dep.programs, payer: deployer }); V.lookupTable = dep.lookupTable;
  const roles = await readRoles(V, dep); const plan = []; const accepts = [];
  for (const r of roles.filter((x) => x.kind === 'postman')) {
    const auth = roles.find((x) => x.kind === 'pool' && x.target === r.target);
    if (r.holder === postman.toBase58()) plan.push({ role: r.role, action: 'done' });
    else if (auth.holder !== me) plan.push({ role: r.role, action: `skip: the pool authority is ${auth.holder} (not the deployer)` });
    else plan.push({ role: r.role, action: `set_postman -> ${postman.toBase58()}`, ixs: [V.setPostmanIx(deployer.publicKey, r.target, postman)] });
  }
  require('../sdk/sealed.js');
  for (const r of roles.filter((x) => x.kind === 'pool' || x.kind === 'factory' || x.kind === 'fee' || x.kind === 'committee')) {
    const accept = r.kind === 'pool' ? V.acceptAuthorityIx(to, r.target) : r.kind === 'fee' ? V.acceptFeeAuthorityIx(to) : r.kind === 'committee' ? V.committeeAuthorityIx('accept_committee_authority', to) : V.acceptFactoryAuthorityIx(to);
    if (r.holder === to.toBase58()) plan.push({ role: r.role, action: 'done' });
    else if (r.holder !== me) plan.push({ role: r.role, action: `skip: held by ${r.holder} (not the deployer)` });
    else { const propose = r.kind === 'pool' ? V.proposeAuthorityIx(deployer.publicKey, r.target, to) : r.kind === 'fee' ? V.proposeFeeAuthorityIx(deployer.publicKey, to) : r.kind === 'committee' ? V.committeeAuthorityIx('propose_committee_authority', deployer.publicKey, to) : V.proposeFactoryAuthorityIx(deployer.publicKey, to);
      plan.push({ role: r.role, action: r.pending === to.toBase58() ? 'proposed already; waiting for --to to accept' : `propose -> ${to.toBase58()} (then --to accepts)`, ixs: r.pending === to.toBase58() ? [] : [propose] }); accepts.push({ role: r.role, ix: accept }); }
  }
  for (const r of roles.filter((x) => x.kind === 'reward')) {
    if (r.holder === to.toBase58()) plan.push({ role: r.role, action: 'done' });
    else if (r.holder !== me) plan.push({ role: r.role, action: `skip: held by ${r.holder} (not the deployer)` });
    else plan.push({ role: r.role, action: `set_reward_funder -> ${to.toBase58()}`, ixs: [V.setRewardFunderIx(deployer.publicKey, r.target, r.index, to)] });
  }
  for (const r of roles.filter((x) => x.kind === 'upgrade')) {
    if (r.holder === to.toBase58()) plan.push({ role: r.role, action: 'done' });
    else if (r.holder !== me) plan.push({ role: r.role, action: `skip: ${r.holder}` });
    else plan.push({ role: r.role, action: `set-upgrade-authority -> ${to.toBase58()}`, cli: ['program', 'set-upgrade-authority', r.target, '--new-upgrade-authority', to.toBase58(), '--skip-new-upgrade-authority-signer-check', '-k', deployerFile, '-u', rpc] });
  }
  const lut = roles.find((x) => x.kind === 'lut');
  if (lut) plan.push({ role: lut.role, action: lut.holder === 'frozen' ? 'done (frozen)' : lut.holder !== me ? `skip: ${lut.holder}` : freezeLut ? 'freeze (irreversible: nobody can change the table)' : 'kept by the deployer (add --freeze-lut once the relayer works)', freeze: freezeLut && lut.holder === me });
  for (const p of plan) log(`  ${p.role.padEnd(28)} ${p.action}`);
  if (dryRun) { log('\nDry run: nothing was sent.'); return { plan, accepts, roles }; }

  for (const p of plan) {
    if (p.ixs && p.ixs.length) await V.send(p.ixs, [], 100_000);
    if (p.cli) execFileSync(solanaCli(), p.cli, { stdio: ['ignore', 'ignore', 'inherit'] });
    if (p.freeze) await V.send([AddressLookupTableProgram.freezeLookupTable({ lookupTable: new PublicKey(dep.lookupTable), authority: deployer.publicKey })], [], 50_000);
  }
  if (acceptKeypair) {
    if (!acceptKeypair.publicKey.equals(to)) throw new Error('--accept-keypair is not --to');
    const A = new Veyl({ connection: conn, programs: dep.programs, payer: acceptKeypair });
    for (const a of accepts) await A.send([a.ix], [], 100_000);
  } else if (accepts.length) {
    log(`\n${accepts.length} handover(s) wait for ${to.toBase58()} to accept. Execute these from the multisig (one instruction each; signer = the multisig):`);
    for (const a of accepts) log(`  ${a.role}: ${JSON.stringify(ixJson(a.ix))}`);
  }
  const after = await readRoles(V, dep); const findings = roleFindings(after, { deployer: me, relayer: dep.relayer });
  log('\nRoles now:'); for (const r of after) log(`  ${r.role.padEnd(28)} ${r.holder}${r.pending ? '  (pending: ' + r.pending + ')' : ''}`);
  return { plan, accepts, roles: after, findings };
}

async function main() {
  const a = N.parseArgs(); const rest = a.rest; const opt = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
  const to = opt('to'); if (!to) { console.error('--to <address> (the multisig / vault that takes over every role)'); process.exit(2); }
  const cfg = N.loadConfig(a.network); const rpc = N.rpcOf(cfg); const dep = N.loadDeploy(a.network); if (!dep) { console.error(`no deploy.${a.network}.json: deploy first`); process.exit(1); }
  const key = N.deployerKey(); if (key.error) { console.error(key.error); process.exit(1); }
  if (key.keypair.publicKey.toBase58() === new PublicKey(to).toBase58()) { console.error('--to is the deployer key'); process.exit(1); }
  console.log(`Veyl handover -> ${a.network}${a.dryRun ? '  [dry run]' : ''}\nfrom (deployer) ${key.keypair.publicKey.toBase58()}\nto              ${to}${opt('postman') ? '\npostman         ' + opt('postman') : ''}\n`);
  if (!opt('postman')) console.log('note: the postman moves to --to as well. The relayer\'s approved-set publisher must then sign with that key (POSTMAN_SECRET_KEY); with a multisig, approvals are published by the multisig by hand. Use --postman <dedicated key> to keep publishing automatic.\n');
  if (a.network === 'mainnet' && !a.dryRun) {
    if (!a.confirmMainnet) { console.error('Mainnet needs --confirm-mainnet.'); process.exit(1); }
    if ((await N.ask('Type "handover" to move every role on mainnet: ')) !== 'handover') { console.error('Not confirmed. Nothing was sent.'); process.exit(1); }
  }
  const acc = opt('accept-keypair') ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opt('accept-keypair'), 'utf8')))) : null;
  const r = await handover({ rpc, dep, deployer: key.keypair, deployerFile: key.file, to, postman: opt('postman'), dryRun: a.dryRun, acceptKeypair: acc, freezeLut: rest.includes('--freeze-lut') });
  if (r.findings) { for (const m of r.findings.red) console.log('RED  ' + m); for (const m of r.findings.warn) console.log('WARN ' + m); if (!r.findings.red.length && !r.findings.warn.length) console.log('\nEvery role is off the deployer key.'); }
}
module.exports = { handover };
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
