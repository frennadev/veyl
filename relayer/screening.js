// Deposit screening: the approved-set publisher (relayer/postman.js) and GET /state both use it.
'use strict';
const fs = require('fs'); const path = require('path');
const loadDeny = () => { try { return new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'denylist.json'), 'utf8'))); } catch { return new Set(); } };
/// Deposit screening shared by the publisher and /state. Addresses to refuse (stolen funds, sanctioned) go in denylist.json.
function isAllowed(d) { const deny = loadDeny(); return !deny.has(String(d.payer)) && !deny.has(String(d.beneficiary)); }
module.exports = { isAllowed };
