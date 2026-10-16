#!/usr/bin/env node
// npm run keys:mainnet [-- --dir <path outside the repo>] [--no-build] [--check]
//
// Fresh program keypairs for mainnet (the target/deploy keypairs are public dev keys and stay the devnet/local IDs):
//   1. MAINNET_KEYPAIR_DIR (or --dir): must be OUTSIDE this repo. Missing keypairs are generated there (mode 0600, never
//      printed); existing ones are reused, so re-running never changes the IDs.
//   2. The mainnet IDs go into the cfg(feature = "mainnet") lines only: declare_id! of the three programs and veyl_pool's
//      ENTRY_PROGRAM; Anchor.toml [programs.mainnet]; config/mainnet.json "programs". Devnet/local IDs are unchanged.
//   3. npm run build:mainnet (unless --no-build): the three programs with --features mainnet into target/deploy-mainnet/.
//   4. Check: each mainnet .so embeds its own mainnet ID and the mainnet IDs of the programs it calls, and none of the dev IDs.
// --check runs step 4 alone. Then: PROGRAM_KEYPAIR_DIR=<dir> npm run preflight -- --network mainnet.
'use strict';
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const { Keypair, PublicKey } = require('@solana/web3.js');
const ROOT = path.join(__dirname, '..');
const PROGRAMS = ['veyl_pool', 'veyl_bin', 'veyl_entry']; const KEY_OF = { veyl_pool: 'pool', veyl_bin: 'bin', veyl_entry: 'entry' };
const PLACEHOLDER = '11111111111111111111111111111111';
const MAINNET_SO_DIR = path.join(ROOT, 'target/deploy-mainnet');
const devIds = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config/local.json'), 'utf8')).programs;
const libRs = (p) => path.join(ROOT, 'programs', p, 'src/lib.rs');
const MAINNET_DECLARE = /(#\[cfg\(feature = "mainnet"\)\]\s*\ndeclare_id!\(")([1-9A-HJ-NP-Za-km-z]+)("\))/;
const MAINNET_ENTRY = /(#\[cfg\(feature = "mainnet"\)\]\s*\npub const ENTRY_PROGRAM: Pubkey = anchor_lang::solana_program::pubkey!\(")([1-9A-HJ-NP-Za-km-z]+)("\))/;

/// The mainnet IDs currently written in the sources (PLACEHOLDER until keys:mainnet ran).
function sourceIds() { const out = {}; for (const p of PROGRAMS) { const m = fs.readFileSync(libRs(p), 'utf8').match(MAINNET_DECLARE); out[KEY_OF[p]] = m ? m[2] : null; }
  const e = fs.readFileSync(libRs('veyl_pool'), 'utf8').match(MAINNET_ENTRY); out.poolEntryConst = e ? e[2] : null; return out; }
const insideRepo = (d) => { const r = path.relative(ROOT, path.resolve(d)); return !r.startsWith('..') && !path.isAbsolute(r); };

function loadOrCreate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const ids = {}; const created = [];
  for (const p of PROGRAMS) { const f = path.join(dir, p + '-keypair.json'); let kp;
    if (fs.existsSync(f)) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
    else { kp = Keypair.generate(); fs.writeFileSync(f, JSON.stringify([...kp.secretKey]), { mode: 0o600, flag: 'wx' }); created.push(p); }
    ids[KEY_OF[p]] = kp.publicKey.toBase58(); }
  return { ids, created };
}
function writeSources(ids) {
  for (const p of PROGRAMS) { const f = libRs(p); const s = fs.readFileSync(f, 'utf8'); if (!MAINNET_DECLARE.test(s)) throw new Error(f + ': no cfg(feature = "mainnet") declare_id! line'); fs.writeFileSync(f, s.replace(MAINNET_DECLARE, `$1${ids[KEY_OF[p]]}$3`)); }
  const f = libRs('veyl_pool'); const s = fs.readFileSync(f, 'utf8'); if (!MAINNET_ENTRY.test(s)) throw new Error('veyl_pool: no mainnet ENTRY_PROGRAM line'); fs.writeFileSync(f, s.replace(MAINNET_ENTRY, `$1${ids.entry}$3`));
  const at = path.join(ROOT, 'Anchor.toml'); let toml = fs.readFileSync(at, 'utf8').replace(/\n\[programs\.mainnet\][^[]*/, '\n');
  toml = toml.replace(/(\[programs\.localnet\][^[]*)/, `$1[programs.mainnet]\n${PROGRAMS.map((p) => `${p} = "${ids[KEY_OF[p]]}"`).join('\n')}\n`); fs.writeFileSync(at, toml);
  const cf = path.join(ROOT, 'config/mainnet.json'); const cfg = JSON.parse(fs.readFileSync(cf, 'utf8')); cfg.programs = { pool: ids.pool, bin: ids.bin, entry: ids.entry }; fs.writeFileSync(cf, JSON.stringify(cfg, null, 2) + '\n');
}
/// Every mainnet .so: its own ID and the IDs it calls are the mainnet ones; no dev ID anywhere. Returns problems (empty = ok).
function checkBuild(ids, soDir = MAINNET_SO_DIR) {
  const dev = devIds(); const problems = []; const has = (bin, id) => bin.indexOf(new PublicKey(id).toBuffer()) >= 0;
  const calls = { veyl_pool: ['pool', 'entry'], veyl_bin: ['bin'], veyl_entry: ['entry', 'pool', 'bin'] };
  for (const p of PROGRAMS) { const f = path.join(soDir, p + '.so'); if (!fs.existsSync(f)) { problems.push(`${p}.so missing in ${path.relative(ROOT, soDir)} (npm run build:mainnet)`); continue; }
    const bin = fs.readFileSync(f);
    for (const k of calls[p]) { if (!has(bin, ids[k])) problems.push(`${p}.so does not embed the mainnet ${k} ID ${ids[k]}`); }
    for (const k of ['pool', 'bin', 'entry']) if (has(bin, dev[k])) problems.push(`${p}.so embeds the DEV ${k} ID ${dev[k]} (built without --features mainnet?)`); }
  return problems;
}

function main() {
  const args = process.argv.slice(2); const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  const dir = opt('dir') || process.env.MAINNET_KEYPAIR_DIR;
  if (args.includes('--check')) { const ids = sourceIds(); if (Object.values(ids).includes(PLACEHOLDER)) { console.error('the sources still hold the placeholder: run npm run keys:mainnet first'); process.exit(1); }
    const pr = checkBuild(ids);
    if (dir) for (const p of PROGRAMS) { const f = path.join(dir, p + '-keypair.json'); const k = fs.existsSync(f) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8')))).publicKey.toBase58() : 'missing';
      if (k !== ids[KEY_OF[p]]) pr.push(`${p}: keypair in ${dir} is ${k}, the sources say ${ids[KEY_OF[p]]}`); }
    console.log(pr.length ? 'NOT OK:\n  ' + pr.join('\n  ') : `OK: target/deploy-mainnet/*.so carry the mainnet IDs ${ids.pool} / ${ids.bin} / ${ids.entry} and no dev ID`); process.exit(pr.length ? 1 : 0); }
  if (!dir) { console.error('MAINNET_KEYPAIR_DIR=<path outside the repo> (or --dir): where the mainnet program keypairs live. They are never committed.'); process.exit(2); }
  if (insideRepo(dir)) { console.error(`${dir} is inside the repo: program keypairs must live outside it`); process.exit(2); }
  const { ids, created } = loadOrCreate(dir);
  const dev = devIds(); for (const k of Object.keys(ids)) if (ids[k] === dev[k]) { console.error(`the ${k} keypair in ${dir} is the repo's DEV keypair`); process.exit(1); }
  console.log(`mainnet program keypairs in ${dir} (${created.length ? 'created: ' + created.join(', ') : 'all existed; reused'})`);
  for (const p of PROGRAMS) console.log(`  ${p.padEnd(11)} ${ids[KEY_OF[p]]}`);
  writeSources(ids); console.log('wrote the cfg(feature = "mainnet") IDs into programs/*/src/lib.rs, Anchor.toml [programs.mainnet], config/mainnet.json (devnet/local IDs unchanged)');
  if (!args.includes('--no-build')) { console.log('building the mainnet profile (npm run build:mainnet)...'); execFileSync('bash', [path.join(ROOT, 'scripts/build.sh'), 'mainnet'], { stdio: 'inherit', cwd: ROOT }); }
  const pr = checkBuild(ids);
  console.log(pr.length ? '\nBUILD CHECK FAILED:\n  ' + pr.join('\n  ') : '\nbuild check: every target/deploy-mainnet/*.so embeds the mainnet IDs (its own and the ones it calls) and no dev ID');
  console.log(`\nNext: PROGRAM_KEYPAIR_DIR=${dir} npm run preflight -- --network mainnet   (commit the sources: the IDs are public; never the keypair directory)`);
  process.exit(pr.length ? 1 : 0);
}
module.exports = { sourceIds, checkBuild, PLACEHOLDER, MAINNET_SO_DIR, insideRepo };
if (require.main === module) main();
