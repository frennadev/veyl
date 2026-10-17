// Veyl Sandbox: the committee's last step, off the main thread. Given M = m·B (the batch total, after two members'
// verified partial decryptions are combined), find m by baby-step giant-step (sdk/bjj.js). Bundled to committee-worker.js.
const J = require('../sdk/bjj.js');
self.onmessage = (e) => { const { id, M } = e.data; let m = null; try { m = J.bsgsAuto(M.map(BigInt), 36); } catch { m = null; } self.postMessage({ id, m: m === null ? null : String(m) }); };
