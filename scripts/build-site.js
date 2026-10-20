#!/usr/bin/env node
// npm run build:site -- --network <local|devnet|mainnet>   ->  dist/site/
// The static site with the runtime config baked from deploy.<network>.json. Without that file the app shows its existing
// "no devnet configuration" state (window.VEYL_CONFIG = null). No preview banners.
// Pages: the Next.js project in web/ (App Router, static export) is built first (`next build`, cached by a hash of its inputs)
// and its index.html / docs.html / app.html plus _next/ are copied in. Every inline script (Next's bootstrap and flight data) is moved into a
// content-hashed file, so the CSP keeps script-src 'self' with no 'unsafe-inline' and no per-build hashes (the static policies
// in netlify.toml and vercel.json stay valid). The plain files of site/ (styles, the engine bundle, workers, snarkjs) are
// copied as before; the circuit and proving key get content-hashed names (cached a year); dist/site/_headers and
// dist/site/vercel.json carry the CSP narrowed to this deployment's RPC and relayer.
// Env: RELAYER_URL (else config relayerUrl), SITE_RPC_URL (else the deploy's RPC), CHAIN_NAME, EXPLORER.
'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const { spawnSync } = require('child_process');
const N = require('./net.js'); const H = require('./site-headers.js'); const { makeConfig } = require('./make-config.js');
const { publicRpcFor } = require('../sdk/rpc.js');
const R = N.ROOT;

/// noDeploy: build the no-deployment preview (VEYL_CONFIG = null) even when deploy.<network>.json exists (the sandbox and smoke tests).
function build(network, { out = path.join(R, 'dist/site'), env = process.env, log = console.log, noDeploy = false } = {}) {
  const cfg = N.loadConfig(network); const dep = noDeploy ? null : N.loadDeploy(network);
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const skip = (f) => f.startsWith('_') || f.startsWith('.') || f === 'veyl.config.js' || fs.statSync(path.join(R, 'site', f)).isDirectory(); // the engine's sources live in engine/
  const h8 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
  // content-hashed zero-knowledge files (byte-identical copies of zk/; preflight checks the hashes)
  const zk = {}; const ZK_PLAIN = new Set();
  for (const name of ['withdraw', 'transact', 'position', 'swap', 'claim']) {
    const zkeySrc = path.join(R, `zk/keys/${name}_final.zkey`), wasmSrc = path.join(R, `zk/build/${name}.wasm`);
    const z = { zkey: `${name}_final.${h8(fs.readFileSync(zkeySrc))}.zkey`, wasm: `${name}.${h8(fs.readFileSync(wasmSrc))}.wasm` };
    fs.copyFileSync(zkeySrc, path.join(out, z.zkey)); fs.copyFileSync(wasmSrc, path.join(out, z.wasm)); ZK_PLAIN.add(`${name}_final.zkey`); ZK_PLAIN.add(`${name}.wasm`);
    if (name === 'withdraw') Object.assign(zk, z); else zk[name] = z; // config.zk.{wasm,zkey} = withdraw; config.zk.transact / .position / .swap / .claim
  }
  // the pages' own scripts and styles get content-hashed names too, so a page never runs against an older copy
  const HASHED = {}; for (const f of ['app.css', 'home.js']) { const b = fs.readFileSync(path.join(R, 'site', f)); HASHED[f] = f.replace(/\.(\w+)$/, `.${h8(b)}.$1`); fs.writeFileSync(path.join(out, HASHED[f]), b); }
  // the pages: Next's static export
  const web = nextExport(HASHED, log);
  for (const page of PAGES) fs.writeFileSync(path.join(out, page + '.html'), externalizeScripts(fs.readFileSync(path.join(web, page + '.html'), 'utf8'), page, out, h8));
  copyDir(path.join(web, '_next'), path.join(out, '_next'));
  for (const f of fs.readdirSync(path.join(R, 'site')).filter((f) => !skip(f))) {
    if (ZK_PLAIN.has(f) || HASHED[f]) continue; // replaced by the hashed copies
    if (!f.endsWith('.html')) fs.copyFileSync(path.join(R, 'site', f), path.join(out, f));
  }
  // the brand files, referenced as brand/<file> by every page (the logo is never inlined, so a new logo needs only these files)
  copyBrand(path.join(out, 'brand'));
  // optional API keys for live data (DEPLOY.md): from the build env, into site/veyl.keys.js (empty when none)
  { const K = { birdeye: env.BIRDEYE_API_KEY, helius: env.HELIUS_API_KEY, jupiter: env.JUPITER_API_KEY, pyth: env.PYTH_API_KEY }; const keys = Object.fromEntries(Object.entries(K).filter(([, v]) => v));
    if (!fs.existsSync(path.join(out, 'veyl.keys.js'))) fs.writeFileSync(path.join(out, 'veyl.keys.js'), 'window.VEYL_KEYS=' + JSON.stringify(keys) + '; /* optional keys for live data: see DEPLOY.md */\n'); }
  // the Sandbox: circuits, proving keys split into parts (each under 8 MB), verifying keys; sandbox.config.js names them
  const sandbox = sandboxZk(out, h8);
  // runtime config
  let connect = [], ws = [], img = [];
  if (dep) {
    const relayer = env.RELAYER_URL || (env.RELAYER_HOST ? 'https://' + env.RELAYER_HOST : null) || (N.isVerify(cfg.relayerUrl) ? null : cfg.relayerUrl); // RELAYER_HOST: Render's fromService host
    if (!relayer) throw new Error('RELAYER_URL is not set and config/' + network + '.json has no relayerUrl');
    const rpc = env.SITE_RPC_URL || dep.rpc;
    let js = makeConfig(dep, { RELAYER_URL: relayer, RPC_URL: rpc, CHAIN_NAME: env.CHAIN_NAME || cfg.chainName, EXPLORER: env.EXPLORER || cfg.explorer });
    const c = JSON.parse(js.slice('window.VEYL_CONFIG='.length).replace(/;\s*$/, '')); c.zk = zk; if (cfg.explorerSuffix !== undefined) c.explorerSuffix = cfg.explorerSuffix;
    fs.writeFileSync(path.join(out, 'veyl.config.js'), 'window.VEYL_CONFIG=' + JSON.stringify(c, null, 1) + ';\n');
    const pub = publicRpcFor(dep.network); // the app falls back to it when the RPC fails (sdk/rpc.js): HTTP only, no websocket
    connect = [rpc, relayer, ...(pub ? [pub] : [])]; ws = [rpc]; img = [relayer]; // the relayer serves token logos (relayer/tokens.js)
    log(`config baked from deploy.${network}.json: rpc ${rpc}, relayer ${relayer}`);
  } else {
    fs.writeFileSync(path.join(out, 'veyl.config.js'), 'window.VEYL_CONFIG=null; /* no deploy.' + network + '.json yet: the app shows its "no configuration" state */\n');
    log(`no deploy.${network}.json: built without a configuration (the app shows its not-deployed state)`);
  }
  const policy = H.csp(connect, { ws, img });
  fs.writeFileSync(path.join(out, '_headers'), H.netlifyHeadersFile(policy));
  fs.writeFileSync(path.join(out, 'vercel.json'), JSON.stringify({ cleanUrls: true, trailingSlash: false, headers: H.vercelHeaders(policy) }, null, 2) + '\n');
  log('dist/site built: ' + fs.readdirSync(out).length + ' files, CSP connect-src ' + (policy.match(/connect-src ([^;]+)/) || [])[1]);
  return { out, zk, policy, sandbox };
}
const PAGES = ['index', 'docs', 'app']; // web/app routes /, /docs, /app -> index.html, docs.html, app.html
const WEB = path.join(R, 'web');
/// Moves every inline script into <page>.<hash>.js next to the page (attributes such as id are kept), and refuses markup the
/// CSP would block. Data blocks (type="application/json" etc.) are not executed and stay inline.
function externalizeScripts(html, page, out, h8) {
  const isData = (attrs) => /\btype=["']?(?!(text|application)\/javascript|module)[\w\/+.-]+/i.test(attrs);
  html = html.replace(/<script((?:(?!\bsrc=)[^>])*)>([\s\S]*?)<\/script>/g, (m, attrs, body) => {
    if (isData(attrs) || !body.trim()) return m;
    const name = `${page}.${h8(Buffer.from(body))}.js`; fs.writeFileSync(path.join(out, name), body);
    return `<script${attrs} src="${name}"></script>`;
  });
  for (const m of html.matchAll(/<script((?:(?!\bsrc=)[^>])*)>([\s\S]*?)<\/script>/g)) if (!isData(m[1]) && m[2].trim()) throw new Error(page + ': an inline script is left; the CSP would block it');
  if (/<[a-z][^>]*\son[a-z]+\s*=\s*["']/i.test(html)) throw new Error(page + ': inline event handler attribute; the CSP would block it');
  return html;
}
/// `next build` in web/ (static export to web/out), skipped when nothing it depends on changed since the last export.
/// assets: the content-hashed names of app.css / home.js, which the pages reference (web/lib/assets.ts).
function nextExport(assets, log = () => {}) {
  const outDir = path.join(WEB, 'out'), stampFile = path.join(outDir, '.veyl-build');
  const hash = crypto.createHash('sha256');
  const walk = (d) => { for (const f of fs.readdirSync(d).sort()) { if (['node_modules', '.next', 'out'].includes(f) || f === 'next-env.d.ts') continue; const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p); else hash.update(path.relative(WEB, p) + '\0').update(fs.readFileSync(p)); } };
  walk(WEB); hash.update(fs.readFileSync(path.join(R, 'config/catalog.json'))); // bundled into /app (the preview pool list)
  hash.update(JSON.stringify(assets)).update(require(path.join(R, 'node_modules/next/package.json')).version);
  const stamp = hash.digest('hex');
  if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp && PAGES.every((p) => fs.existsSync(path.join(outDir, p + '.html')))) return outDir;
  log('next build (web/)');
  const r = spawnSync(process.execPath, [path.join(R, 'node_modules/next/dist/bin/next'), 'build'], { cwd: WEB, encoding: 'utf8', maxBuffer: 64 << 20,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', VEYL_ASSETS: JSON.stringify(assets), NODE_ENV: 'production' } });
  if (r.status !== 0) throw new Error('next build failed in web/:\n' + (r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : ''));
  for (const p of PAGES) if (!fs.existsSync(path.join(outDir, p + '.html'))) throw new Error('next build did not export ' + p + '.html');
  fs.writeFileSync(stampFile, stamp); return outDir;
}
function copyDir(src, dest) { fs.cpSync(src, dest, { recursive: true }); }
/// Sandbox zero-knowledge files under zk/: content-hashed, proving keys in parts the prover worker joins.
const PART = 7_500_000;
function sandboxZk(out, h8) { const dir = path.join(out, 'zk'); fs.mkdirSync(dir, { recursive: true }); const zk = {}; const vkeys = {};
  for (const name of ['transact', 'position', 'swap', 'claim']) {
    const zkey = fs.readFileSync(path.join(R, `zk/keys/${name}_final.zkey`)), wasm = fs.readFileSync(path.join(R, `zk/build/${name}.wasm`)); const h = h8(zkey);
    const w = `zk/${name}.${h8(wasm)}.wasm`; fs.writeFileSync(path.join(out, w), wasm); const parts = [];
    for (let o = 0, i = 0; o < zkey.length; o += PART, i++) { const f = `zk/${name}.${h}.${i}.bin`; fs.writeFileSync(path.join(out, f), zkey.subarray(o, o + PART)); parts.push(f); }
    zk[name] = { wasm: w, zkey: parts, size: zkey.length + wasm.length }; vkeys[name] = JSON.parse(fs.readFileSync(path.join(R, `zk/keys/${name}_vkey.json`), 'utf8')); }
  const vk = JSON.stringify(vkeys); const vf = `zk/vkeys.${h8(Buffer.from(vk))}.json`; fs.writeFileSync(path.join(out, vf), vk);
  const cfg = { zk, vkeys: vf, proverWorker: 'prove-worker.js', committeeWorker: 'committee-worker.js' };
  fs.writeFileSync(path.join(out, 'sandbox.config.js'), 'window.VEYL_SANDBOX=' + JSON.stringify(cfg) + ';\n'); return cfg; }
const BRAND_FILES = ['veyl-mark.svg', 'veyl-mark-small.svg', 'veyl-lockup.svg', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'og.png'];
function copyBrand(dest) { fs.mkdirSync(dest, { recursive: true }); for (const f of BRAND_FILES) { const src = path.join(R, 'brand', f); if (!fs.existsSync(src)) throw new Error('brand/' + f + ' is missing'); fs.copyFileSync(src, path.join(dest, f)); } }
module.exports = { build, copyBrand, BRAND_FILES, sandboxZk, nextExport, externalizeScripts, PAGES };
if (require.main === module) { const a = N.parseArgs(); try { build(a.network); } catch (e) { console.error(e.message); process.exit(1); } }
