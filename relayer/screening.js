// Deposit screening: the approved-set publisher (relayer/postman.js) and GET /state both use it.
'use strict';
const fs = require('fs'); const path = require('path');
const FILE = path.join(__dirname, 'denylist.json');
let deny = new Set(); let checkedAt = 0; let mtime = -1;
/// The denylist, re-read when the file changes (checked at most every 10 s, not once per deposit). A file that is missing
/// means an empty list; a file that cannot be parsed keeps the last good list and says so, rather than silently screening nothing.
function denylist() {
  if (Date.now() - checkedAt < 10_000) return deny; checkedAt = Date.now();
  let m; try { m = fs.statSync(FILE).mtimeMs; } catch { deny = new Set(); mtime = -1; return deny; }
  if (m === mtime) return deny;
  try { const list = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(list)) throw new Error('not an array'); deny = new Set(list.map(String)); mtime = m; }
  catch (e) { console.error('denylist.json unreadable, keeping the previous list (' + deny.size + ' entries):', e.message); }
  return deny;
}
/// Deposit screening shared by the publisher and /state. Addresses to refuse (stolen funds, sanctioned) go in denylist.json.
function isAllowed(d) { const s = denylist(); return !s.has(String(d.payer)) && !s.has(String(d.beneficiary)); }
module.exports = { isAllowed };
