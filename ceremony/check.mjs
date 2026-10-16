// Preflight's view of the trusted setup, for EVERY circuit (withdraw, transact, position, swap, claim). Green (mainnet) only when ALL hold:
//   1. ceremony/TRANSCRIPT.md + ceremony/transcript.json exist, are version 2 (all circuits) and not a rehearsal   (step: finalize)
//   2. each shipped zk/keys/<circuit>_final.zkey carries >= 3 participant contributions whose names are not rehearsal names
//      (step: contribute) and ends with a random beacon (step: beacon), exactly as the transcript lists them
//   3. `verify` passes per circuit: the key derives from its r1cs and the PUBLIC ptau, every contribution checks out (step: verify)
//   4. each <circuit>_vkey.json is the ceremony's verifying key, and all five are baked into veyl_pool.so (step: build)
// Otherwise red, naming the circuit and the step that is missing. Off mainnet the same facts are reported as warnings / info.
import fs from "fs"; import path from "path";
import * as L from "./lib.mjs";

const TRANSCRIPT_MD = path.join(L.CEREMONY, "TRANSCRIPT.md"), TRANSCRIPT_JSON = path.join(L.CEREMONY, "transcript.json");
const MIN_CONTRIBUTIONS = 3;

/// Which step a ceremony in progress (ceremony/work) has reached, for the message when there is no transcript yet.
function progress() {
  try { const st = L.loadState(L.DEFAULT_WORK);
    if (st.rehearsal) return "the ceremony in ceremony/work is a rehearsal; run init with the public ptau files";
    const out = []; for (const n of L.CIRCUIT_NAMES) { const c = st.circuits[n]; if (!c) { out.push(`${n}: not in the ceremony (init)`); continue; }
      const k = c.zkeys.filter((z) => z.kind === "participant").length;
      out.push(k < MIN_CONTRIBUTIONS ? `${n}: step 'contribute' ${k}/${MIN_CONTRIBUTIONS}` : !c.beacon ? `${n}: step 'beacon'` : `${n}: step 'finalize'`); }
    return out.join(", ") + " (ceremony/work)"; }
  catch (e) { return /version/.test(e.message) ? "ceremony/work holds a single-circuit (version 1) ceremony: start over with init" : "step 'init': no ceremony started (ceremony/README.md)"; }
}

/// rows: [{ check, status, detail }]. `poolSo`: the veyl_pool.so that will be deployed. `vkeyParts`: preflight's encoder.
export async function setupRows({ mainnet, poolSo, vkeyParts, verifyNow = mainnet }) {
  const rows = []; const bad = mainnet ? "red" : "warn"; const add = (check, status, detail) => rows.push({ check, status, detail });
  const setup = L.readJson(path.join(L.ROOT, "zk/keys/SETUP.json"));
  if (!fs.existsSync(TRANSCRIPT_MD) || !fs.existsSync(TRANSCRIPT_JSON)) {
    add("trusted setup (ceremony)", bad, `DEV setup for ${L.CIRCUIT_NAMES.join(", ")} (SETUP.json kind "${setup.kind}", single machine). Missing ceremony/TRANSCRIPT.md: ${progress()}.` + (mainnet ? " Mainnet needs the multi-party ceremony for every circuit." : " Fine for testnets."));
    return rows;
  }
  const t = L.readJson(TRANSCRIPT_JSON); const problems = [];
  if (t.rehearsal) problems.push("step 'init': ceremony/transcript.json is a REHEARSAL transcript");
  if (t.version !== 2 || !t.circuits) problems.push("step 'finalize': ceremony/transcript.json covers only the withdraw circuit (version 1): run the ceremony for every circuit");
  if (setup.kind !== "ceremony") problems.push(`step 'finalize': zk/keys/SETUP.json kind is "${setup.kind}"`);
  const bin = poolSo && fs.existsSync(poolSo) ? fs.readFileSync(poolSo) : null;
  if (!bin) problems.push("step 'build': " + (poolSo ? path.relative(L.ROOT, poolSo) : "veyl_pool.so") + " is missing");
  const tc = (t.circuits || {});
  for (const name of L.CIRCUIT_NAMES) {
    const F = L.files(name); const c = tc[name]; const P = (m) => problems.push(`[${name}] ${m}`);
    if (!c) { P("not in the transcript"); continue; }
    let info = null; try { info = await L.zkeyInfo(F.zkey); await L.terminateCurves(); } catch (e) { P(`cannot read ${path.relative(L.ROOT, F.zkey)}: ` + e.message); }
    if (info) {
      const real = info.contributions.filter((k) => k.kind === "participant" && !/rehearsal/i.test(k.name));
      if (real.length < MIN_CONTRIBUTIONS) P(`step 'contribute': ${real.length} non-rehearsal contribution(s) in the key, at least ${MIN_CONTRIBUTIONS} needed`);
      const last = info.contributions[info.contributions.length - 1];
      if (!last || last.kind !== "beacon") P("step 'beacon': the key does not end with a random beacon");
      const listed = c.contributions || [];
      if (listed.length !== info.contributions.length || info.contributions.some((k, i) => !listed[i] || listed[i].contributionHash !== k.contributionHash)) P("step 'finalize': the transcript does not list the contributions in the shipped key");
      if (info.coeffsSha256 !== L.circuitRecord(name).coeffsSha256) P("the shipped key is for different constraints than ceremony/circuits.json");
    }
    if (L.sha256File(F.zkey) !== (c.final || {}).zkeySha256) P(`step 'finalize': ${path.relative(L.ROOT, F.zkey)} is not the transcript's final key`);
    if (!fs.existsSync(F.vkey) || L.sha256File(F.vkey) !== (c.final || {}).vkeySha256) { P(`step 'finalize': ${path.relative(L.ROOT, F.vkey)} is not the transcript's verifying key`); continue; }
    const vk = L.readJson(F.vkey); const exported = await L.snarkjs.zKey.exportVerificationKey(F.zkey); await L.terminateCurves();
    const pick = (k) => JSON.stringify([k.vk_alpha_1, k.vk_beta_2, k.vk_gamma_2, k.vk_delta_2, k.IC]);
    if (pick(vk) !== pick(exported)) P(`step 'finalize': ${name}_vkey.json is not the verifying key of the final zkey`);
    if (bin) { const missing = vkeyParts(vk).filter(([, b]) => bin.indexOf(b) < 0).map(([n]) => n);
      if (missing.length) P(`step 'build': ${path.relative(L.ROOT, poolSo)} does not embed the ceremony vkey (${missing.join(", ")}): npm run vkey && rebuild`); }
  }
  if (!problems.length || !mainnet) {
    if (verifyNow && t.circuits) {
      const { verify } = await import("./ceremony.mjs");
      for (const name of L.CIRCUIT_NAMES) { if (!tc[name]) continue;
        const ptau = L.findPtau(null, L.DEFAULT_WORK, name);
        if (!ptau) { problems.push(`[${name}] step 'verify': ${L.ptauRecord(name).file} is not here (CEREMONY_PTAU_${L.circuitRecord(name).power}=<file> or put it in ceremony/ptau/): every key is re-verified before mainnet`); continue; }
        const r = await verify({ circuit: name, zkey: L.files(name).zkey, ptau, transcript: { ...t, rehearsal: false }, quiet: true });
        if (!r.ok) problems.push(`[${name}] step 'verify': ` + r.problems.join("; "));
        else add(`ceremony verify: ${name} (r1cs + public ptau + every contribution)`, "ok", `${r.contributions.length} contributions, ptau ${path.basename(ptau)} blake2b ${r.ptauBlake2b.slice(0, 12)}…`); }
    } else add("ceremony verify", "info", "not re-run here (preflight --network mainnet runs it for every circuit; npm run ceremony -- verify)");
  }
  if (problems.length) add("trusted setup (ceremony)", bad, problems.join("; "));
  else add("trusted setup (ceremony)", "ok", `${L.CIRCUIT_NAMES.map((n) => `${n}: ${tc[n].contributions.filter((k) => k.kind === "participant").length} contributions + beacon`).join("; ")}; transcript ceremony/TRANSCRIPT.md; vkeys baked into ${path.relative(L.ROOT, poolSo)}`);
  return rows;
}
