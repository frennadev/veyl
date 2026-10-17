#!/usr/bin/env node
// Builds dist/ (or OUT): the static site. PREVIEW=1 builds the shareable preview: no config, so the app runs in its
// labelled demonstration mode (no RPC, no relayer, no wallet) until a devnet deployment exists, and says so in one quiet status line.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.resolve(root, process.env.OUT || 'dist'); fs.mkdirSync(out, { recursive: true });
const skip = (f) => f.startsWith('_') || f.endsWith('entry.js') || f === 'shield-engine.js' || f === 'sealed-engine.js' || /\.(zkey|wasm)$/.test(f) || (process.env.PREVIEW && f === 'veyl.config.js');
for (const f of fs.readdirSync(path.join(root, 'site')).filter((f) => !skip(f))) {
  if (!f.endsWith('.html')) { fs.copyFileSync(path.join(root, 'site', f), path.join(out, f)); continue; }
  let s = fs.readFileSync(path.join(root, 'site', f), 'utf8');
  if (process.env.PREVIEW) {
    s = s.replace('<script src="veyl.config.js"></script>', '<script>window.VEYL_CONFIG=null;/* preview: no devnet configuration, the app runs its labelled demonstration */</script>');
    // no notice on the pages: the nav and hero already carry the testnet tag, and the app says quietly that devnet is pending
  }
  fs.writeFileSync(path.join(out, f), s);
}
// circuits and proving keys come from zk/ (site/ has no copies); the preview leaves them out. Logos: brand/ as build-site does.
if (!process.env.PREVIEW) for (const n of ['withdraw', 'transact', 'position', 'swap', 'claim']) { fs.copyFileSync(path.join(root, `zk/keys/${n}_final.zkey`), path.join(out, `${n}_final.zkey`)); fs.copyFileSync(path.join(root, `zk/build/${n}.wasm`), path.join(out, `${n}.wasm`)); }
require('./build-site.js').copyBrand(path.join(out, 'brand'));
console.log('dist built:', out, process.env.PREVIEW ? '(demonstration preview)' : '');
