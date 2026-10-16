// Veyl proving worker: Groth16 proofs (snarkjs) off the main thread, so the page stays responsive while a proof is made.
// Input: { id, input, wasm, zkey, circuit?, size? }: the circuit's witness input and URLs served by this site: the circuit
// (wasm) and its proving key, either one URL or a list of parts joined in order (large keys are split into parts). The
// downloaded circuit and key are kept in memory for the next proof. Output: { id, progress } while it works, then
// { id, proof, publicSignals, ms } or { id, error }. Nothing leaves the device.
/* global snarkjs */
self.importScripts('snarkjs.min.js');
const cache = new Map();
async function grab(urls, id, size, base = 0) {
  let loaded = 0; const total = size || 0; const bufs = [];
  for (const u of urls) {
    const r = await fetch(u); if (!r.ok) throw new Error('Could not load ' + u.split('/').pop() + ' (' + r.status + ')');
    if (!r.body || !r.body.getReader) { const b = new Uint8Array(await r.arrayBuffer()); loaded += b.length; bufs.push(b); self.postMessage({ id, progress: { stage: 'fetch', loaded: base + loaded, total } }); continue; }
    const rd = r.body.getReader(); let last = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; bufs.push(value); loaded += value.length; if (loaded - last > 400_000) { last = loaded; self.postMessage({ id, progress: { stage: 'fetch', loaded: base + loaded, total } }); } }
  }
  const out = new Uint8Array(loaded); let o = 0; for (const b of bufs) { out.set(b, o); o += b.length; } return out;
}
self.onmessage = async (e) => {
  const { id, input, wasm, zkey, circuit, size } = e.data; const t = Date.now();
  try {
    const key = circuit || (Array.isArray(zkey) ? zkey[0] : zkey); let c = cache.get(key);
    if (!c) { self.postMessage({ id, progress: { stage: 'fetch', loaded: 0, total: size || 0 } }); const w = await grab([wasm], id, size); const z = await grab(Array.isArray(zkey) ? zkey : [zkey], id, size, w.length); c = { wasm: w, zkey: z }; cache.set(key, c); while (cache.size > 2) cache.delete(cache.keys().next().value); }
    self.postMessage({ id, progress: { stage: 'prove', cached: true } });
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, c.wasm, c.zkey); self.postMessage({ id, proof, publicSignals, ms: Date.now() - t });
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};
