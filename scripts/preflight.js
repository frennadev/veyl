#!/usr/bin/env node
// npm run preflight -- --network <local|devnet|mainnet>
// Prints a green/red table: tools, build vs program IDs, the Groth16 verifying key baked into veyl_pool vs
// zk/keys/withdraw_vkey.json (hash compare), zkey/wasm hashes (zk/, dist/site/), the trusted setup (mainnet: the
// multi-party ceremony is re-verified, ceremony/check.mjs), RPC + cluster, deployer balance vs the estimated cost, mints, env,
// who holds each role of a live deployment, and open blocking findings. Exit code 1 when anything is red.
// Never prints secret key material. An unreachable RPC is reported as red, not a crash.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const N = require('./net.js');
const R = N.ROOT;
const PROGRAMS = ['veyl_pool', 'veyl_bin', 'veyl_entry']; const KEY_OF = { veyl_pool: 'pool', veyl_bin: 'bin', veyl_entry: 'entry' };
/// SHA-256 of zkeys known to come from a single-machine (dev) setup. A ceremony key will not be in this list.
// the single-machine dev keys shipped in the repo (withdraw, transact, position, swap, claim): never accepted as a ceremony's
const KNOWN_DEV_ZKEYS = ['b1ce9fa6440fd92d540badb7f0053b08f6a6a0a1bb5b6afaac9b112a14d44447', '7f9e3d222a400b3bb63e986e36d33f68723414e8fa606752c2a57f9182d20064', '005d3190f5a7ddbafb14d52488d0304988ae22407666dce6b032a7cc1b4b3c2d',
  '5905898bbc9889d03c75384159de066cae304f2bd637f0ea3a80e968bb00c8b2', '24ee888ae9154f87a48341d21e16729db1db3da89326be1784892f3121e4c2c7'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/// The verifying key's curve points in the byte layout groth16-solana takes (same encoding as scripts/vkey-to-rust.js).
function vkeyParts(vk) {
  const be32 = (s) => Buffer.from(BigInt(s).toString(16).padStart(64, '0'), 'hex');
  const g1 = (p) => Buffer.concat([be32(p[0]), be32(p[1])]);
  const g2 = (p) => Buffer.concat([be32(p[0][1]), be32(p[0][0]), be32(p[1][1]), be32(p[1][0])]);
  return [['alpha', g1(vk.vk_alpha_1)], ['beta', g2(vk.vk_beta_2)], ['gamma', g2(vk.vk_gamma_2)], ['delta', g2(vk.vk_delta_2)], ...vk.IC.map((p, i) => ['IC' + i, g1(p)])];
}
/// The bytes of programs/veyl_pool/src/vkey.rs, in declaration order.
function vkeyRsBytes(src) { const body = src.slice(src.indexOf('Groth16Verifyingkey {')); return Buffer.from([...body.matchAll(/\[([\d,\s]+)\]/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean).map(Number))); }

function tool(cmd, args) { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim().split('\n')[0]; } catch { return null; } }
const solDir = () => process.env.SOLANA_BIN || (fs.existsSync('/opt/solana/bin/solana') ? '/opt/solana/bin' : path.join(os.homedir(), '.local/share/solana/install/active_release/bin'));
const which = (n) => (fs.existsSync(path.join(solDir(), n)) ? path.join(solDir(), n) : n);

async function preflight({ network, quiet = false }) {
  const rows = []; const add = (check, status, detail) => rows.push({ check, status, detail });
  const cfg = N.loadConfig(network); const mainnet = network === 'mainnet'; const rpc = N.rpcOf(cfg);

  // ---- tools
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node >= 20', nodeMajor >= 20 ? 'ok' : 'red', 'v' + process.versions.node);
  const sol = tool(which('solana'), ['--version']); add('solana CLI', sol ? 'ok' : 'red', sol || 'not found (https://solana.com/docs/intro/installation); needed to deploy programs');
  const sbf = tool(which('cargo-build-sbf'), ['--version']); add('cargo-build-sbf (only to rebuild)', sbf ? 'ok' : 'warn', sbf || 'not found; the prebuilt target/deploy/*.so are used');
  const anchor = tool('anchor', ['--version']); add('anchor CLI (optional)', 'info', anchor || 'not installed (not needed: programs build with cargo-build-sbf)');

  // ---- config + env
  const unv = N.unverified(cfg);
  add(`config/${network}.json`, unv.length ? 'red' : 'ok', unv.length ? 'unverified values: ' + unv.join(', ') : 'complete');
  const key = N.deployerKey();
  if (key.error) add('DEPLOYER_KEYPAIR', 'red', key.error);
  else add('DEPLOYER_KEYPAIR', key.inRepo ? (mainnet ? 'red' : 'warn') : 'ok', key.keypair.publicKey.toBase58() + (key.inRepo ? '  (file is inside the repo: move it out)' : ''));
  const relayerUrl = process.env.RELAYER_URL || (N.isVerify(cfg.relayerUrl) ? null : cfg.relayerUrl);
  add('RELAYER_URL (site)', relayerUrl ? 'ok' : (network === 'local' ? 'warn' : 'red'), relayerUrl || 'set RELAYER_URL or relayerUrl in the config');
  if (mainnet) {
    const pm = process.env.POSTMAN_PUBKEY || (N.isVerify(cfg.postman) ? null : cfg.postman); const rl = process.env.RELAYER_PUBKEY || (N.isVerify(cfg.relayer) ? null : cfg.relayer);
    const dpk = key.keypair && key.keypair.publicKey.toBase58();
    add('postman / relayer keys', pm && rl && pm !== dpk && rl !== dpk && pm !== rl ? 'ok' : 'red', pm && rl ? (pm === dpk || rl === dpk ? 'must not be the deployer key' : pm === rl ? 'postman and relayer must be separate keys' : 'set') : 'POSTMAN_PUBKEY / RELAYER_PUBKEY (or config) missing');
  }

  // ---- programs: keypairs, declare_id!, config, the built .so (mainnet: the fresh-ID build profile in target/deploy-mainnet)
  const programDir = N.programKeypairDir(network); const soDir = N.soDirOf(network);
  const devIds = Object.values(N.loadConfig('local').programs);
  const recorded = fs.existsSync(path.join(R, 'config/program-hashes.json')) ? JSON.parse(fs.readFileSync(path.join(R, 'config/program-hashes.json'), 'utf8')) : {};
  const { Keypair, PublicKey } = require('@solana/web3.js'); const KM = require('./keys-mainnet.js');
  const mainnetIds = mainnet ? KM.sourceIds() : null;
  const ids = {};
  if (!programDir) add('program keypairs', 'red', 'PROGRAM_KEYPAIR_DIR (or MAINNET_KEYPAIR_DIR) is not set: npm run keys:mainnet makes fresh ones outside the repo');
  else if (mainnet && KM.insideRepo(programDir)) add('program keypairs', 'red', programDir + ' is inside the repo: mainnet program keypairs live outside it');
  for (const p of (programDir ? PROGRAMS : [])) {
    const so = path.join(soDir, p + '.so'); const kpf = path.join(programDir, p + '-keypair.json');
    if (!fs.existsSync(so)) { add(`${p}.so`, 'red', `missing in ${path.relative(R, soDir)}: npm run ${mainnet ? 'build:mainnet' : 'build'}`); continue; }
    let id = null; try { id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpf, 'utf8')))).publicKey; } catch { add(`${p} program keypair`, 'red', 'missing/invalid: ' + kpf); continue; }
    ids[KEY_OF[p]] = id;
    const declared = mainnet ? mainnetIds[KEY_OF[p]] : (fs.readFileSync(path.join(R, 'programs', p, 'src/lib.rs'), 'utf8').match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/) || [])[1];
    const cfgId = cfg.programs && cfg.programs[KEY_OF[p]]; const bin = fs.readFileSync(so);
    const problems = [];
    if (mainnet && declared === KM.PLACEHOLDER) problems.push('the mainnet declare_id! is still the placeholder: npm run keys:mainnet');
    else if (declared !== id.toBase58()) problems.push((mainnet ? 'mainnet ' : '') + 'declare_id! ' + declared + ' != keypair ' + id.toBase58());
    if (cfgId && !N.isVerify(cfgId) && cfgId !== id.toBase58()) problems.push('config says ' + cfgId);
    if (bin.indexOf(id.toBuffer()) < 0) problems.push('the .so does not embed this program ID (rebuild)');
    if (mainnet && devIds.includes(id.toBase58())) problems.push('this is the repo\'s public dev keypair: generate a fresh one for mainnet');
    if (mainnet && devIds.some((d) => bin.indexOf(new PublicKey(d).toBuffer()) >= 0)) problems.push('the .so embeds a dev program ID (build with npm run build:mainnet)');
    // the devnet-only one-off migration (veyl_bin --features devnet-migrate) must never reach mainnet
    if (mainnet && p === 'veyl_bin' && /Instruction: Migrate(Factory|Pool)/.test(bin.toString('latin1'))) problems.push('the .so contains the devnet-migrate instructions (build with npm run build:mainnet)');
    add(`${p} ID / build`, problems.length ? 'red' : 'ok', problems.length ? problems.join('; ') : id.toBase58() + (mainnet ? ' (fresh mainnet ID)' : ''));
    const srcNewest = Math.max(...fs.readdirSync(path.join(R, 'programs', p, 'src')).map((f) => fs.statSync(path.join(R, 'programs', p, 'src', f)).mtimeMs));
    const h = sha(bin);
    if (fs.statSync(so).mtimeMs + 1000 < srcNewest) add(`${p}.so freshness`, mainnet ? 'red' : 'warn', `older than its sources: npm run ${mainnet ? 'build:mainnet' : 'build'}`);
    else if (!mainnet) add(`${p}.so sha256`, !recorded[p] || recorded[p] === h ? 'ok' : 'warn', h.slice(0, 16) + '…' + (recorded[p] && recorded[p] !== h ? ' (differs from config/program-hashes.json: different toolchain or sources)' : recorded[p] ? ' (matches the recorded clean build)' : ''));
    else add(`${p}.so sha256`, 'info', h.slice(0, 16) + '… (mainnet profile)');
  }
  if (mainnet && mainnetIds && ids.entry && mainnetIds.poolEntryConst !== ids.entry.toBase58()) add('veyl_pool ENTRY_PROGRAM (mainnet)', 'red', `${mainnetIds.poolEntryConst} != entry keypair ${ids.entry.toBase58()}: npm run keys:mainnet`);

  // ---- zero-knowledge artifacts, for every circuit: withdraw (legacy pool), transact and position (shielded pool), swap and
  //      claim (sealed batches)
  const setup = JSON.parse(fs.readFileSync(path.join(R, 'zk/keys/SETUP.json'), 'utf8'));
  const poolSo = path.join(soDir, 'veyl_pool.so'); const poolBin = fs.existsSync(poolSo) ? fs.readFileSync(poolSo) : null;
  if (!poolBin) add('verifying keys baked into veyl_pool.so', mainnet ? 'red' : 'warn', path.relative(R, poolSo) + ' missing: npm run ' + (mainnet ? 'build:mainnet' : 'build'));
  let zkHash = null;
  for (const name of ['withdraw', 'transact', 'position', 'swap', 'claim']) {
    const vkFile = path.join(R, `zk/keys/${name}_vkey.json`); const zkeyFile = path.join(R, `zk/keys/${name}_final.zkey`); const wasmFile = path.join(R, `zk/build/${name}.wasm`);
    const rsFile = path.join(R, 'programs/veyl_pool/src/' + (name === 'withdraw' ? 'vkey.rs' : `vkey_${name}.rs`));
    const rec = (setup.circuits && setup.circuits[name]) || (name === 'withdraw' ? setup : null);
    if (![vkFile, zkeyFile, wasmFile, rsFile].every((f) => fs.existsSync(f))) { add(`${name}: zk files`, 'red', 'missing: ' + [vkFile, zkeyFile, wasmFile, rsFile].filter((f) => !fs.existsSync(f)).map((f) => path.relative(R, f)).join(', ')); continue; }
    const vk = JSON.parse(fs.readFileSync(vkFile, 'utf8')); const parts = vkeyParts(vk); const canon = Buffer.concat(parts.map((x) => x[1]));
    const vkHash = N.sha256File(vkFile), zH = N.sha256File(zkeyFile), wasmHash = N.sha256File(wasmFile); if (name === 'withdraw') zkHash = zH;
    const same = rec && vkHash === rec.vkeySha256 && zH === rec.zkeySha256 && wasmHash === rec.wasmSha256;
    add(`${name}: zk files vs SETUP.json hashes`, same ? 'ok' : 'red', `vkey ${vkHash.slice(0, 12)}… zkey ${zH.slice(0, 12)}… wasm ${wasmHash.slice(0, 12)}…` + (same ? '' : rec ? '  MISMATCH with zk/keys/SETUP.json' : '  not recorded in zk/keys/SETUP.json'));
    // vkey*.rs must be exactly what vkey-to-rust.js makes from <name>_vkey.json, and its bytes must hash to the same value
    const tmp = path.join(os.tmpdir(), 'veyl-vkey-' + process.pid + '-' + name + '.rs');
    try { execFileSync(process.execPath, [path.join(R, 'scripts/vkey-to-rust.js'), vkFile, tmp], { stdio: 'ignore' }); } catch {}
    const rsCommitted = fs.readFileSync(rsFile);
    const regenerated = fs.existsSync(tmp) ? fs.readFileSync(tmp) : Buffer.alloc(0); try { fs.unlinkSync(tmp); } catch {}
    const rsBytes = vkeyRsBytes(rsCommitted.toString());
    add(`${name}: ${path.basename(rsFile)} == vkey-to-rust(${name}_vkey.json)`, Buffer.compare(rsCommitted, regenerated) === 0 && sha(rsBytes) === sha(canon) ? 'ok' : 'red', 'sha256(vkey bytes) ' + sha(rsBytes).slice(0, 16) + '… vs json ' + sha(canon).slice(0, 16) + '…');
    if (poolBin) {
      const missing = parts.filter(([, b]) => poolBin.indexOf(b) < 0).map(([n]) => n);
      const found = Buffer.concat(parts.map(([, b]) => (poolBin.indexOf(b) >= 0 ? poolBin.subarray(poolBin.indexOf(b), poolBin.indexOf(b) + b.length) : Buffer.alloc(0))));
      add(`${name}: verifying key baked into veyl_pool.so`, missing.length === 0 && sha(found) === sha(canon) ? 'ok' : 'red', missing.length ? 'not found in the binary: ' + missing.join(', ') + ' (rebuild: npm run build)' : 'sha256 ' + sha(found).slice(0, 16) + `… == ${name}_vkey.json (` + parts.length + ' points)');
    }
    // the zkey must embed the same verifying key
    try {
      const snarkjs = require('snarkjs'); const ev = await snarkjs.zKey.exportVerificationKey(zkeyFile);
      if (globalThis.curve_bn128) { await globalThis.curve_bn128.terminate().catch(() => {}); globalThis.curve_bn128 = null; }
      const pick = (k) => JSON.stringify([k.protocol, k.curve, k.nPublic, k.vk_alpha_1, k.vk_beta_2, k.vk_gamma_2, k.vk_delta_2, k.IC]);
      add(`${name}: zkey embeds ${name}_vkey.json`, pick(ev) === pick(vk) ? 'ok' : 'red', pick(ev) === pick(vk) ? 'snarkjs export matches' : 'the proving key and the verifying key disagree');
    } catch (e) { add(`${name}: zkey embeds ${name}_vkey.json`, 'red', 'could not read the zkey: ' + e.message); }
    // the built site, when there is one: dist/site/ holds content-hashed copies (site/ has none; demo.js serves zk/ directly)
    for (const dir of ['dist/site']) {
      if (!fs.existsSync(path.join(R, dir))) continue;
      const files = fs.readdirSync(path.join(R, dir)); const hashed = (ext) => files.find((f) => new RegExp(`^${name}(_final)?\\.[0-9a-f]+\\.${ext}$`).test(f) && (ext === 'wasm' ? !f.includes('_final') : f.includes('_final')));
      const z = path.join(R, dir, hashed('zkey') || 'missing');
      const w = path.join(R, dir, hashed('wasm') || 'missing');
      const okZ = fs.existsSync(z) && N.sha256File(z) === zH, okW = fs.existsSync(w) && N.sha256File(w) === wasmHash;
      add(`${name}: ${dir}/ zkey + wasm hashes`, okZ && okW ? 'ok' : 'red', okZ && okW ? 'identical to zk/' : (!okZ ? `${name}_final.zkey differs/missing ` : '') + (!okW ? `${name}.wasm differs/missing` : ''));
    }
    if (KNOWN_DEV_ZKEYS.includes(zH) && setup.kind === 'ceremony') add(`${name}: trusted setup`, 'red', 'SETUP.json says "ceremony" but the zkey is a known single-machine key');
  }
  // trusted setup: a recorded, verified multi-party ceremony whose vkey is the one baked into veyl_pool (ceremony/check.mjs)
  void zkHash;
  try { const { setupRows } = await import('../ceremony/check.mjs'); for (const r of await setupRows({ mainnet, poolSo, vkeyParts })) add(r.check, r.status, r.detail); }
  catch (e) { add('trusted setup (ceremony)', mainnet ? 'red' : 'warn', 'could not check: ' + e.message); }

  // ---- the batch committee (Phase 3): mainnet needs a real dealerless DKG among independent members, with its public
  //      transcript (committee/transcript.<network>.json) verifying and matching the committee registered on chain
  { const C = committeeRows({ network, mainnet }); for (const r of C) add(r.check, r.status, r.detail); }

  // ---- chain
  const ver = await N.rpcCall(rpc, 'getVersion');
  add('RPC reachable', ver.ok ? 'ok' : 'red', ver.ok ? rpc + '  solana-core ' + ver.result['solana-core'] : (N.isVerify(rpc) ? 'config rpc still says VERIFY' : rpc + '  ' + ver.error));
  if (ver.ok && cfg.genesisHash) { const g = await N.rpcCall(rpc, 'getGenesisHash'); add('cluster (genesis hash)', g.ok && g.result === cfg.genesisHash ? 'ok' : 'red', g.ok ? (g.result === cfg.genesisHash ? network : 'this RPC is another cluster: ' + g.result) : g.error); }
  if (ver.ok) {
    // cost estimate + balance
    try {
      const { plan, selectTokens } = require('./deploy.js'); const { tokens, binPools } = selectTokens(cfg);
      const p = await plan({ cfg, network, rpc, deployerPk: key.keypair && key.keypair.publicKey, programDir, tokens, binPools, existing: N.loadDeploy(network) });
      const need = p.lamports; const bal = p.balance;
      add('deployer balance >= estimated cost', bal === null ? 'red' : bal >= need ? 'ok' : 'red', `${bal === null ? '?' : (bal / 1e9).toFixed(4)} SOL vs ${(need / 1e9).toFixed(4)} SOL needed (npm run deploy -- --network ${network} --dry-run for the breakdown)`);
      const deployed = p.steps.filter((s) => s.status.startsWith('skip')).length; if (deployed) add('programs already on chain', 'info', deployed + ' of 3 identical (would be skipped)');
    } catch (e) { add('deployer balance >= estimated cost', 'red', 'estimate failed: ' + e.message); }
    // required mints
    const mints = Object.entries(cfg.mints || {}).filter(([, v]) => v && !N.isVerify(v));
    for (const [sym, m] of mints) {
      const a = await N.rpcCall(rpc, 'getAccountInfo', [m, { encoding: 'base64' }]);
      const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PR9wnRYhZK1o8V';
      const want = (require('./lib.js').TOKENS.find((t) => t.sym === sym) || {}).decimals;
      if (!a.ok || !a.result || !a.result.value) { add('mint ' + sym, 'red', m + ' not found on ' + network); continue; }
      const d = Buffer.from(a.result.value.data[0], 'base64'); const owner = a.result.value.owner;
      add('mint ' + sym, (owner === TOKEN || owner === T22) && d[44] === want ? 'ok' : 'red', `${m} owner ${owner === TOKEN ? 'SPL Token' : owner === T22 ? 'Token-2022' : owner} decimals ${d[44]}${d[44] !== want ? ' (expected ' + want + ')' : ''}`);
    }
  } else {
    add('deployer balance >= estimated cost', 'red', 'cannot check: RPC unreachable (npm run deploy -- --network ' + network + ' --dry-run estimates offline)');
    if (Object.values(cfg.mints || {}).some((v) => v && !N.isVerify(v))) add('required mints exist', 'red', 'cannot check: RPC unreachable');
  }

  // the registered committee must be the transcript's (when deployed)
  if (ver.ok && N.loadDeploy(network)) { try { const tr = readTranscript(network); const { Connection } = require('@solana/web3.js'); const { Veyl } = require('../sdk/veyl.js'); require('../sdk/sealed.js');
      const c = await new Veyl({ connection: new Connection(rpc, 'confirmed'), programs: N.loadDeploy(network).programs }).committee();
      if (!c) add('batch committee on chain', mainnet ? 'red' : 'info', 'not registered (deploy registers it from the transcript)');
      else { const D = require('../committee/dkg.js'); const same = tr && Buffer.from(c.transcript).equals(D.transcriptHash(tr));
        add('batch committee on chain', same && c.kind === 1 ? 'ok' : mainnet ? 'red' : 'info', `epoch ${c.epoch}, ${c.t} of ${c.n}, kind ${c.kind === 1 ? 'DKG' : 'dev'}` + (tr ? (same ? ', == the transcript' : ', NOT the transcript in committee/') : ', no transcript file')); } }
    catch (e) { add('batch committee on chain', mainnet ? 'red' : 'info', 'could not read: ' + e.message); } }

  // ---- roles of a live deployment (after `npm run deploy`): nothing may still sit on the deployer key on mainnet
  const depFile = N.loadDeploy(network); let rolesChecked = false;
  if (depFile && ver.ok) {
    try {
      const { Connection } = require('@solana/web3.js'); const { Veyl } = require('../sdk/veyl.js'); const { readRoles, roleFindings } = require('./roles.js');
      const roles = await readRoles(new Veyl({ connection: new Connection(rpc, 'confirmed'), programs: depFile.programs }), depFile);
      const f = roleFindings(roles, { deployer: depFile.deployer, relayer: depFile.relayer }); rolesChecked = true;
      add('roles (upgrade, pool, postman, factory, protocol fee, reward funders)', f.red.length ? (mainnet ? 'red' : 'info') : f.warn.length ? 'warn' : 'ok', f.red.length || f.warn.length ? [...f.red, ...f.warn].slice(0, 6).join('; ') + (f.red.length && mainnet ? '. npm run handover -- --network ' + network + ' --to <multisig>' : '') : 'every role is off the deployer key');
    } catch (e) { add('roles (upgrade, pool, postman, factory, protocol fee, reward funders)', mainnet ? 'red' : 'info', 'could not read: ' + e.message); }
  } else if (mainnet) add('roles (upgrade, pool, postman, factory, protocol fee, reward funders)', 'warn', 'after deploy: npm run handover -- --network mainnet --to <multisig>; preflight then checks nothing is left on the deployer key');

  // ---- open blocking findings (items marked "auto" are decided by the checks above, not by their status field)
  const B = JSON.parse(fs.readFileSync(path.join(R, 'config/blockers.json'), 'utf8')).items.filter((b) => !b.auto && b.status !== 'resolved');
  for (const b of B) add(`open: ${b.severity} ${b.id}`, mainnet ? (b.when === 'after-deploy' ? 'warn' : 'red') : 'info', b.title.length > 110 ? b.title.slice(0, 107) + '…' : b.title);
  if (!B.length) add('open blocking findings', 'ok', 'none');
  void rolesChecked;

  const red = rows.filter((r) => r.status === 'red').map((r) => r.check); const warn = rows.filter((r) => r.status === 'warn').length;
  if (!quiet) { console.log(`\nPreflight: Veyl (Solana) -> ${network}`); N.table(rows); console.log(`\n${red.length ? 'RED' : 'GREEN'}: ${red.length} red, ${warn} warning(s)`); }
  return { rows, red, warn };
}
/// committee/transcript.<network>.json: the public DKG transcript of the network's batch committee.
function readTranscript(network) { const f = process.env.COMMITTEE_TRANSCRIPT || path.join(R, `committee/transcript.${network}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
function committeeRows({ network, mainnet }) {
  const rows = []; const tr = readTranscript(network); const D = require('../committee/dkg.js');
  if (!tr) { rows.push({ check: 'batch committee: DKG transcript', status: mainnet ? 'red' : 'info', detail: `committee/transcript.${network}.json missing: sealed swaps need the committee's key generation (DEPLOY.md, "Batch committee")` }); return rows; }
  const v = D.verifyTranscript(tr); const distinct = new Set(tr.nodes).size === tr.n;
  const problems = [...v.errs]; if (tr.t < 2 || tr.n < 3) problems.push(`threshold ${tr.t} of ${tr.n} (mainnet needs at least 2 of 3)`); if (!distinct) problems.push('repeated node keys');
  if (/^local-/.test(String(tr.session))) problems.push('a local (one machine) key generation: every member ran on the same host');
  rows.push({ check: 'batch committee: DKG transcript', status: problems.length ? (mainnet ? 'red' : 'warn') : 'ok', detail: problems.length ? problems.join('; ') : `${tr.t} of ${tr.n}, session ${tr.session}, sha256 ${D.transcriptHash(tr).toString('hex').slice(0, 16)}…, every signature and key re-verified` });
  return rows;
}
module.exports = { preflight, vkeyParts, KNOWN_DEV_ZKEYS, committeeRows };
if (require.main === module) {
  const a = N.parseArgs();
  preflight({ network: a.network }).then((r) => process.exit(r.red.length ? 1 : 0), (e) => { console.error('preflight crashed:', e); process.exit(2); });
}
