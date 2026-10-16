// Shared by the ceremony commands, the coordinator server, the rehearsal and preflight: paths, hashes, the public Powers
// of Tau records, reading a zkey's MPC section (every contribution, its hash, the beacon), and verification.
// One ceremony covers every circuit (withdraw; Phase 2 transact, position; Phase 3 swap, claim: ceremony/circuits.json). Nothing here changes a
// circuit: zk/circuits/<name>.circom and zk/build/<name>.wasm are only read and hashed.
import fs from "fs"; import path from "path"; import crypto from "crypto"; import os from "os";
import { createRequire } from "module"; import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);

export const CEREMONY = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(CEREMONY, "..");
export const SNARK_ROOT = path.join(path.dirname(require.resolve("snarkjs", { paths: [ROOT] })), "..");
export const snarkjs = require(SNARK_ROOT);
/// Every circuit the ceremony makes keys for, in ceremony order.
export const CIRCUIT_NAMES = ["withdraw", "transact", "position", "swap", "claim"];
/// Where each circuit's files live (the repo's; `out` = another root for finalize).
export function files(name, out = ROOT) {
  if (!CIRCUIT_NAMES.includes(name)) throw new Error("unknown circuit " + name);
  return { name, circuit: path.join(ROOT, `zk/circuits/${name}.circom`), wasm: path.join(ROOT, `zk/build/${name}.wasm`), r1cs: path.join(ROOT, `zk/build/${name}.r1cs`),
    zkey: path.join(out, `zk/keys/${name}_final.zkey`), vkey: path.join(out, `zk/keys/${name}_vkey.json`), vkeyRs: path.join(out, "programs/veyl_pool/src/" + (name === "withdraw" ? "vkey.rs" : `vkey_${name}.rs`)),
    site: path.join(out, `site/${name}_final.zkey`), siteWasm: path.join(out, `site/${name}.wasm`) };
}
export const CIRCUIT = files("withdraw").circuit;
export const WASM = files("withdraw").wasm;
export const R1CS = files("withdraw").r1cs;
export const DEV_ZKEY = files("withdraw").zkey;
export const DEFAULT_WORK = path.join(CEREMONY, "work");
export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
export const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o, null, 2) + "\n"); fs.renameSync(f + ".tmp", f); };
/// The circuit records (committed): what "the same circuit" means, byte for byte, per circuit.
export const circuitRecord = (name = "withdraw") => { const r = readJson(path.join(CEREMONY, "circuits.json")).circuits[name]; if (!r) throw new Error("no record for circuit " + name); return r; };
/// The public phase-1 files (committed): per power, name, blake2b, download URLs. `ptauRecord(name)` = the file a circuit
/// starts from (the smallest published one large enough for it).
export const ptauRecords = () => readJson(path.join(CEREMONY, "ptau.json")).files;
export const ptauRecord = (name = "withdraw") => { const need = circuitRecord(name).power; const recs = ptauRecords(); const p = Object.keys(recs).map(Number).filter((x) => x >= need).sort((a, b) => a - b)[0]; return { ...recs[p], power: p, minPower: need }; };

export const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
/// blake2b-512 of a file, streamed (the hash the Perpetual Powers of Tau files are published with; `b2sum <file>`).
export function blake2bFile(f) {
  const h = crypto.createHash("blake2b512"); const fd = fs.openSync(f, "r"); const buf = Buffer.alloc(1 << 22);
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); } } finally { fs.closeSync(fd); }
  return h.digest("hex");
}
export const hex = (u8) => Buffer.from(u8).toString("hex");
/// snarkjs prints a 64-byte hash as 4 lines of 4 words; participants compare against what their terminal showed.
export function formatHash(h) { const x = typeof h === "string" ? h : hex(h); const w = x.match(/.{8}/g); return [0, 4, 8, 12].map((i) => w.slice(i, i + 4).join(" ")).join("\n"); }

/// A logger for snarkjs that keeps its lines (and prints them unless quiet).
export function logger({ quiet = false, prefix = "" } = {}) {
  const lines = []; const at = (lvl) => (...a) => { const m = a.join(" "); lines.push(m); if (!quiet && lvl !== "debug") console.log(prefix + m); };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

async function internals() {
  const bfu = await import(pathToUrl(require.resolve("@iden3/binfileutils", { paths: [SNARK_ROOT] })));
  const zu = await import(pathToUrl(path.join(SNARK_ROOT, "src/zkey_utils.js")));
  const { blake2b } = await import(pathToUrl(require.resolve("@noble/hashes/blake2b", { paths: [SNARK_ROOT] })));
  const curves = await import(pathToUrl(path.join(SNARK_ROOT, "src/curves.js")));
  return { bfu, zu, blake2b, curves };
}
const pathToUrl = (p) => "file://" + p;

/// Every phase-2 contribution recorded in a zkey (the source of truth: it is what verify checks), with snarkjs'
/// contribution hash for each. type 0 = a participant, type 1 = a random beacon.
export async function zkeyInfo(zkeyFile) {
  const { bfu, zu, blake2b, curves } = await internals();
  const { fd, sections } = await bfu.readBinFile(zkeyFile, "zkey", 2);
  try {
    const header = await zu.readHeader(fd, sections, false);
    const curve = await curves.getCurveFromQ(header.q);
    const mpc = await zu.readMPCParams(fd, curve, sections);
    const coeffs = Buffer.from(await bfu.readSection(fd, sections, 4));
    const contributions = mpc.contributions.map((c, i) => {
      const h = blake2b.create({ dkLen: 64 }); zu.hashPubKey(h, curve, c);
      return { index: i + 1, type: c.type, kind: c.type === 1 ? "beacon" : "participant", name: c.name || "", contributionHash: hex(h.digest()),
        ...(c.type === 1 ? { beaconHash: hex(c.beaconHash), numIterationsExp: c.numIterationsExp } : {}) };
    });
    return { nVars: header.nVars, nPublic: header.nPublic, domainSize: header.domainSize, power: header.power, csHash: hex(mpc.csHash), coeffsSha256: crypto.createHash("sha256").update(coeffs).digest("hex"), contributions };
  } finally { await fd.close(); }
}
/// Header of a ptau: power and whether phase 2 was prepared (the Lagrange sections a zkey is made from).
export async function ptauInfo(ptauFile) {
  const { bfu } = await internals(); const { fd, sections } = await bfu.readBinFile(ptauFile, "ptau", 1);
  try { await bfu.startReadUniqueSection(fd, sections, 1); const n8 = await fd.readULE32(); await fd.read(n8); const power = await fd.readULE32(); await bfu.endReadSection(fd, true);
    return { power, prepared: [12, 13, 14, 15].every((s) => sections[s] && sections[s][0] && sections[s][0].size > 0) }; }
  finally { await fd.close(); }
}

/// Full check of a zkey: it was derived from this r1cs and this ptau, and every contribution follows the previous one
/// (snarkjs zkey verify). Returns { ok, info, log }.
export async function verifyZkey({ r1cs = R1CS, ptau, zkey, quiet = true }) {
  r1cs = r1cs || R1CS;
  const log = logger({ quiet }); let ok = false;
  try { ok = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, zkey, log); } catch (e) { log.error("verify crashed: " + e.message); ok = false; }
  await terminateCurves();
  const info = await zkeyInfo(zkey); await terminateCurves();
  return { ok: ok === true, info, log: log.lines };
}
export async function terminateCurves() { if (globalThis.curve_bn128) { try { await globalThis.curve_bn128.terminate(); } catch {} globalThis.curve_bn128 = null; } }

/// The ptau for a circuit: --ptau, CEREMONY_PTAU_<power>, CEREMONY_PTAU, or a published file of sufficient power in the
/// work dir / ceremony/ptau/ (the circuit's own power first).
export function findPtau(explicit, work = DEFAULT_WORK, name = "withdraw") {
  const need = circuitRecord(name).power; const recs = ptauRecords(); const pub = Object.keys(recs).map(Number).filter((p) => p >= need).sort((a, b) => a - b).map((p) => recs[p].file);
  const cands = [explicit, process.env["CEREMONY_PTAU_" + need], process.env.CEREMONY_PTAU, ...pub.flatMap((f) => [path.join(work, f), path.join(CEREMONY, "ptau", f)])].filter(Boolean);
  return cands.find((f) => fs.existsSync(f)) || null;
}
/// Check a ptau for a circuit: prepared, large enough, and (except in a rehearsal) one of the published files by blake2b.
export async function checkPtau(file, { rehearsal = false, name = "withdraw" } = {}) {
  const rec = circuitRecord(name); const b2 = blake2bFile(file); const info = await ptauInfo(file); const recs = ptauRecords();
  const match = Object.entries(recs).find(([, r]) => r.blake2b === b2);
  const problems = [];
  if (!info.prepared) problems.push("not prepared for phase 2 (snarkjs powersoftau prepare phase2)");
  if (info.power < rec.power) problems.push(`power ${info.power} < ${rec.power} (the ${name} circuit has ${rec.constraints} constraints)`);
  if (!rehearsal && !match) problems.push(`blake2b ${b2.slice(0, 16)}… is not a published Perpetual Powers of Tau file (ceremony/ptau.json lists ${Object.values(recs).map((r) => r.file).join(", ")})`);
  return { blake2b: b2, power: info.power, public: !!match, file: match ? match[1].file : path.basename(file), problems };
}

/// Compile a circuit to r1cs with the pinned compiler (circom2 npm = circom 2.2.3, --O2) and prove it is the same
/// compile as the shipped witness generator: the wasm it emits must be byte-identical to zk/build/<name>.wasm.
export async function compileR1cs({ name = "withdraw", out, quiet = false } = {}) {
  const F = files(name); out = out || F.r1cs; const rec = circuitRecord(name); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veyl-circom-"));
  try {
    if (sha256File(F.circuit) !== rec.circuitSha256) throw new Error(`zk/circuits/${name}.circom differs from ceremony/circuits.json: the ceremony is for the shipped circuit only`);
    fs.mkdirSync(path.join(tmp, "circuits")); fs.copyFileSync(F.circuit, path.join(tmp, `circuits/${name}.circom`));
    // circom2 runs in WASI and does not follow symlinks: copy circomlib next to the circuit (its includes are ../node_modules/...)
    const lib = path.dirname(require.resolve("circomlib/package.json", { paths: [ROOT] }));
    if (readJson(path.join(lib, "package.json")).version !== rec.circomlib) throw new Error(`circomlib ${rec.circomlib} expected`);
    fs.cpSync(lib, path.join(tmp, "node_modules/circomlib"), { recursive: true });
    const cli = require.resolve("circom2/cli.js", { paths: [ROOT] });
    const { execFileSync } = await import("child_process");
    const ver = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }); if (!ver.includes(rec.circom)) throw new Error("circom " + rec.circom + " expected, got " + ver.trim());
    fs.mkdirSync(path.join(tmp, "build"));
    execFileSync(process.execPath, [cli, `circuits/${name}.circom`, "--r1cs", "--wasm", "--O2", "-o", "build"], { cwd: tmp, stdio: quiet ? "ignore" : "inherit" });
    const wasm = sha256File(path.join(tmp, `build/${name}_js/${name}.wasm`)), r1cs = sha256File(path.join(tmp, `build/${name}.r1cs`));
    if (wasm !== rec.wasmSha256 || wasm !== sha256File(F.wasm)) throw new Error(`the compiled wasm differs from zk/build/${name}.wasm: not the same compile`);
    if (r1cs !== rec.r1csSha256) throw new Error("compiled r1cs " + r1cs + " differs from ceremony/circuits.json " + rec.r1csSha256);
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(tmp, `build/${name}.r1cs`), out);
    return { r1cs: out, r1csSha256: r1cs, wasmSha256: wasm };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
/// A circuit's r1cs, checked against the record (compiled once if missing).
export async function ensureR1cs(name = "withdraw") {
  const rec = circuitRecord(name); const F = files(name);
  if (!fs.existsSync(F.r1cs)) await compileR1cs({ name, quiet: true });
  if (sha256File(F.r1cs) !== rec.r1csSha256) throw new Error(`zk/build/${name}.r1cs differs from ceremony/circuits.json (run: npm run ceremony -- r1cs)`);
  return F.r1cs;
}

// ---- the ceremony's state (work dir): participants (shared) and, per circuit, its keys, beacon and finalization
export const statePath = (work) => path.join(work, "state.json");
export const zkeyPath = (work, i, name = "withdraw") => path.join(work, `${name}_${String(i).padStart(4, "0")}.zkey`);
export const loadState = (work) => { const f = statePath(work); if (!fs.existsSync(f)) throw new Error("no ceremony in " + work + " (run init first)"); const st = readJson(f); if (st.version !== 2) throw new Error("ceremony state version " + st.version + ": start over with init (multi-circuit, version 2)"); return st; };
export const saveState = (work, st) => writeJson(statePath(work), st);
export const latestIndex = (cs) => cs.zkeys[cs.zkeys.length - 1].index;
