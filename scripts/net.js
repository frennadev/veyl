// Shared by deploy.js, preflight.js and build-site.js: argument parsing, network config, keys and RPC helpers.
// Keys are only ever read from paths given by env; their secret bytes are never printed.
'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const NETWORKS = ['local', 'devnet', 'mainnet'];

function parseArgs(argv = process.argv.slice(2)) {
  const a = { network: null, dryRun: false, confirmMainnet: false, upgrade: false, json: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--network' || x === '-n') a.network = argv[++i];
    else if (x.startsWith('--network=')) a.network = x.split('=')[1];
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--confirm-mainnet') a.confirmMainnet = true;
    else if (x === '--upgrade') a.upgrade = true;
    else if (x === '--json') a.json = true;
    else a.rest.push(x);
  }
  if (a.network === 'mainnet-beta') a.network = 'mainnet';
  if (!NETWORKS.includes(a.network)) { console.error(`--network must be one of ${NETWORKS.join(', ')}`); process.exit(2); }
  return a;
}

const isVerify = (v) => typeof v === 'string' && /^VERIFY/.test(v);
/// Every "VERIFY: ..." value left in a config, as dotted paths.
function unverified(o, pre = '') {
  const out = [];
  for (const [k, v] of Object.entries(o || {})) {
    if (k.startsWith('_')) continue;
    if (isVerify(v)) out.push(pre + k);
    else if (v && typeof v === 'object') out.push(...unverified(v, pre + k + '.'));
  }
  return out;
}
function loadConfig(network) {
  const f = path.join(ROOT, 'config', network + '.json');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c._file = f;
  return c;
}
const rpcOf = (cfg) => process.env.RPC_URL || cfg.rpc;
const deployFileOf = (network) => path.join(ROOT, `deploy.${network}.json`);
function loadDeploy(network) { const f = deployFileOf(network); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }

/// The deployer keypair from DEPLOYER_KEYPAIR (a path). Returns { file, keypair } or { error }.
function deployerKey(env = process.env) {
  const f = env.DEPLOYER_KEYPAIR;
  if (!f) return { error: 'DEPLOYER_KEYPAIR is not set (path to a Solana keypair JSON, outside this repo)' };
  const file = path.resolve(f.replace(/^~(?=\/)/, require('os').homedir()));
  if (!fs.existsSync(file)) return { error: 'DEPLOYER_KEYPAIR points to a missing file' };
  try {
    const { Keypair } = require('@solana/web3.js');
    const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
    const inRepo = file.startsWith(ROOT + path.sep) && !file.startsWith(path.join(ROOT, 'node_modules'));
    return { file, keypair, inRepo };
  } catch { return { error: 'DEPLOYER_KEYPAIR is not a valid keypair file' }; }
}

/// JSON-RPC call with a timeout; never throws, returns { ok, result | error }.
async function rpcCall(url, method, params = [], timeoutMs = 8000) {
  if (!url || isVerify(url)) return { ok: false, error: 'no RPC URL (config value still says VERIFY)' };
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
    const j = await r.json(); if (j.error) return { ok: false, error: j.error.message || JSON.stringify(j.error) };
    return { ok: true, result: j.result };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'timed out after ' + timeoutMs / 1000 + 's' : (e.cause && e.cause.code) || e.message }; }
  finally { clearTimeout(t); }
}

/// Where the program binaries for a network are: the mainnet build profile (fresh IDs, `npm run build:mainnet`) or the dev one.
const soDirOf = (network) => path.join(ROOT, network === 'mainnet' ? 'target/deploy-mainnet' : 'target/deploy');
/// Program keypairs: PROGRAM_KEYPAIR_DIR (or MAINNET_KEYPAIR_DIR on mainnet), else the repo's public dev keypairs (not on mainnet).
function programKeypairDir(network, env = process.env) {
  const d = env.PROGRAM_KEYPAIR_DIR || (network === 'mainnet' ? env.MAINNET_KEYPAIR_DIR : null);
  if (d) return path.resolve(d.replace(/^~(?=\/)/, require('os').homedir()));
  return network === 'mainnet' ? null : path.join(ROOT, 'target/deploy');
}
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
/// Rent-exempt minimum, the formula the runtime uses: (128 + bytes) * 3480 lamports/byte-year * 2 years.
const rentFormula = (bytes) => (128 + bytes) * 3480 * 2;

/// A coloured status table. rows: [{ check, status: 'ok'|'warn'|'red'|'info', detail }]
function table(rows) {
  const tty = process.stdout.isTTY; const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const tag = { ok: c('32', ' OK  '), warn: c('33', 'WARN '), red: c('31', ' RED '), info: c('36', 'INFO ') };
  const w = Math.min(46, Math.max(...rows.map((r) => r.check.length)));
  for (const r of rows) console.log(`${tag[r.status]} ${r.check.padEnd(w)}  ${r.detail || ''}`);
}

/// Ask the person to type something on the terminal (never from a pipe).
function ask(question) {
  return new Promise((resolve) => {
    let input; try { input = fs.createReadStream('/dev/tty'); } catch { return resolve(null); }
    const rl = require('readline').createInterface({ input, output: process.stdout });
    rl.on('error', () => resolve(null));
    rl.question(question, (ans) => { rl.close(); input.destroy(); resolve(ans.trim()); });
  });
}

module.exports = { soDirOf, programKeypairDir, ROOT, NETWORKS, parseArgs, isVerify, unverified, loadConfig, rpcOf, deployFileOf, loadDeploy, deployerKey, rpcCall, sha256File, rentFormula, table, ask };
