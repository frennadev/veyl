// Shared by the e2e runners: pass/fail counting, the run clock, the Chromium path on CI images, the closing summary.
// Each runner keeps its own page-error watcher (what counts as noise differs per suite).
'use strict';
const fs = require('fs'); const path = require('path');
const counts = { pass: 0, fail: 0 };
const check = (n, ok, extra = '') => { ok ? counts.pass++ : counts.fail++; console.log((ok ? '  ok  ' : '  FAIL') + ' ' + n + (extra ? '  ' + String(extra).replace(/\s+/g, ' ').slice(0, 220) : '')); };
const t0 = Date.now(); const lap = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
/// the preinstalled Playwright Chromium on CI images (/opt/pw-browsers); undefined = Playwright's own
const chromePath = () => { const d = '/opt/pw-browsers'; if (!fs.existsSync(d)) return undefined; const c = fs.readdirSync(d).find((x) => /^chromium-\d+$/.test(x)); if (!c) return undefined; for (const p of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (fs.existsSync(path.join(d, c, p))) return path.join(d, c, p); return undefined; };
const finish = (note = '') => { console.log(`\n${counts.pass} passed, ${counts.fail} failed (${lap()})${note}`); process.exit(counts.fail ? 1 : 0); };
module.exports = { counts, check, lap, chromePath, finish };
