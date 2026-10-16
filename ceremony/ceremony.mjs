#!/usr/bin/env node
// Veyl trusted-setup ceremony (Groth16 phase 2) for every circuit, in one flow:  npm run ceremony -- <command> [options]
// Circuits (ceremony/circuits.json): withdraw (legacy pool, 2^14), transact and position (Phase 2 shielded pool, 2^15),
// swap (2^15) and claim (2^14) (Phase 3 sealed batch swaps).
// A contributor contributes to all of them with ONE command; the coordinator takes each upload in turn and verifies it.
//
//   r1cs [--circuit <name>]      compile each circuit with the pinned compiler; proves it is the shipped build
//   init [--ptau <file>] [--ptau-14 <f> --ptau-15 <f>] [--circuits a,b]   start a ceremony from the public Powers of Tau files
//   add-participant --name <n>   register the next contributor; prints their one-time upload token (give it to them privately)
//   skip --name <n>              move a participant who did not show up to the end of the queue
//   serve [--port 8853]          the coordinator: hands out the latest keys, takes contributions in order, verifies each one
//   contribute --coordinator <url> --token <t> [--text "..."]    ONE command for a participant: every circuit in turn
//   contribute --in <zkey> --out <zkey> --name <n>                the same, offline (air-gapped), one key at a time
//   accept --circuit <c> --file <zkey> --name <n>                 coordinator: take an offline contribution
//   beacon (--btc-height <h> | --drand-round <r> | --hash <hex> --source "<what>") [--iterations 10]   applied to every circuit
//   verify [--circuit <c>] [--zkey <file>] [--ptau <file>]         full check against the r1cs and the ptau; lists every hash
//   finalize [--out <dir>]                                         vkeys, vkey*.rs, site copies, SETUP.json, TRANSCRIPT.md
//   status
// Common: --work <dir> (default ceremony/work), --rehearsal (init only: a practice run; it can never become the repo's keys).
//
// No circuit is ever changed: every key made here is for zk/circuits/<name>.circom exactly as shipped (ceremony/circuits.json).
import fs from "fs"; import path from "path"; import os from "os"; import crypto from "crypto"; import http from "http";
import { execFileSync } from "child_process"; import { fileURLToPath } from "url";
import * as L from "./lib.mjs";
const { ROOT, CEREMONY, snarkjs } = L;

// ------------------------------------------------------------------------------------------------ args
export function parse(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) { const x = argv[i]; if (x.startsWith("--")) { const k = x.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) a[k] = true; else { a[k] = v; i++; } } else a._.push(x); }
  return a;
}
const die = (m) => { const e = new Error(m); e.userFacing = true; throw e; };
const workOf = (a) => path.resolve(a.work || L.DEFAULT_WORK);
const cs = (st, name) => { const c = st.circuits[name]; if (!c) die("this ceremony has no " + name + " circuit (it has " + Object.keys(st.circuits).join(", ") + ")"); return c; };
const names = (st) => L.CIRCUIT_NAMES.filter((n) => st.circuits[n]);

// ------------------------------------------------------------------------------------------------ init
/// ptau: one prepared file used for every circuit it is large enough for, or { 14: file, 15: file } per power.
export async function init({ ptau, work, rehearsal = false, title = "Veyl circuits (withdraw, transact, position, swap, claim), phase 2", force = false, circuits = L.CIRCUIT_NAMES }) {
  if (fs.existsSync(L.statePath(work)) && !force) die("a ceremony already exists in " + work + " (--force to start over)");
  fs.mkdirSync(work, { recursive: true });
  const st = { version: 2, title, rehearsal: !!rehearsal, createdAt: new Date().toISOString(), participants: [], circuits: {} };
  for (const name of circuits) {
    const rec = L.circuitRecord(name);
    const file = typeof ptau === "object" && ptau ? ptau[rec.power] || ptau[String(rec.power)] || Object.entries(ptau).filter(([p]) => Number(p) >= rec.power).map(([, f]) => f)[0] : ptau || L.findPtau(null, work, name);
    if (!file || !fs.existsSync(file)) die(`--ptau <file> for the ${name} circuit (2^${rec.power}): ${L.ptauRecord(name).file} (ceremony/README.md says where to get it)`);
    const r1cs = await L.ensureR1cs(name);
    console.log(`[${name}] checking the ptau (blake2b-512)...`);
    const pt = await L.checkPtau(file, { rehearsal, name }); if (pt.problems.length) die(`[${name}] ptau refused: ` + pt.problems.join("; "));
    if (!pt.public) console.log(`[${name}] REHEARSAL: this ptau is not a published file; its hash is recorded and the result can never be used as the real keys.`);
    const ptauCopy = path.join(work, path.basename(file)); if (path.resolve(file) !== path.resolve(ptauCopy) && !fs.existsSync(ptauCopy)) fs.copyFileSync(file, ptauCopy);
    console.log(`[${name}] creating the initial key (no contributions yet)...`);
    const z0 = L.zkeyPath(work, 0, name); const log = L.logger({ quiet: true });
    await snarkjs.zKey.newZKey(r1cs, ptauCopy, z0, log); await L.terminateCurves();
    const info = await L.zkeyInfo(z0); await L.terminateCurves();
    if (info.coeffsSha256 !== rec.coeffsSha256 || info.nVars !== rec.wires || info.nPublic !== rec.publicSignals) die(`[${name}] the initial key does not encode the recorded circuit (coefficients ${info.coeffsSha256})`);
    st.circuits[name] = { circuit: { circuitSha256: rec.circuitSha256, r1csSha256: rec.r1csSha256, wasmSha256: rec.wasmSha256, coeffsSha256: info.coeffsSha256, csHash: info.csHash, constraints: rec.constraints },
      ptau: { file: path.basename(file), blake2b: pt.blake2b, power: pt.power, public: pt.public, source: pt.public ? L.ptauRecords()[pt.power] && L.ptauRecords()[pt.power].download[0] || "published file" : "local rehearsal file" },
      zkeys: [{ index: 0, file: path.basename(z0), sha256: L.sha256File(z0), name: "initial key (no contribution)", at: new Date().toISOString() }], beacon: null, finalized: null };
    console.log(`[${name}] circuit hash ${info.csHash.slice(0, 32)}…  constraints ${rec.constraints}  ptau ${path.basename(file)} (${pt.public ? "public" : "REHEARSAL"})`);
  }
  L.saveState(work, st); console.log("initialised " + work); return st;
}

export function addParticipant({ work, name }) {
  if (!name || name === true) die("--name <public name> (shown in the transcript)");
  if (name.length > 64 || !/^[\x20-\x7e]+$/.test(name)) die("names are 1-64 printable ASCII characters (snarkjs stores at most 64)");
  const st = L.loadState(work); if (st.participants.some((p) => p.name === name)) die("already registered: " + name);
  if (!st.rehearsal && /rehearsal/i.test(name)) die("names containing 'rehearsal' are reserved for practice runs");
  const token = crypto.randomBytes(24).toString("base64url");
  st.participants.push({ name, tokenSha256: crypto.createHash("sha256").update(token).digest("hex"), order: st.participants.length + 1, addedAt: new Date().toISOString() });
  L.saveState(work, st); return { name, order: st.participants.length, token };
}
/// Move a registered participant who has not contributed to the end of the queue (they did not show up in their window).
export function skip({ work, name }) {
  const st = L.loadState(work); const i = st.participants.findIndex((p) => p.name === name);
  if (i < 0) die("not registered: " + name); if (names(st).some((n) => contributed(cs(st, n)).some((z) => z.name === name))) die(name + " has contributed already");
  const [p] = st.participants.splice(i, 1); st.participants.push(p); st.participants.forEach((x, k) => (x.order = k + 1)); L.saveState(work, st);
  return st.participants.map((x) => x.name);
}
const contributed = (c) => c.zkeys.filter((z) => z.index > 0 && z.kind === "participant");
/// Whose turn it is on one circuit (every participant contributes to every circuit, in the registered order).
const nextParticipant = (st, name) => { const c = cs(st, name); return c.beacon ? null : st.participants[contributed(c).length] || null; };

// ------------------------------------------------------------------------------------------------ accept (coordinator side)
/// Take a new key that claims to add one contribution to a circuit's latest one: it must keep every earlier contribution,
/// add exactly one participant contribution under the participant's name, and pass the full verification (r1cs + ptau).
export async function accept({ work, file, name, circuit = "withdraw" }) {
  const st = L.loadState(work); const c = cs(st, circuit); const want = nextParticipant(st, circuit);
  if (!want) die(c.beacon ? "the beacon is applied: the ceremony is closed" : "no registered participant is waiting (add-participant)");
  if (name !== want.name) die(`it is ${want.name}'s turn on ${circuit}, not ${name}'s`);
  const prev = L.zkeyPath(work, L.latestIndex(c), circuit);
  const [a, b] = [await L.zkeyInfo(prev), await L.zkeyInfo(file)]; await L.terminateCurves();
  if (b.contributions.length !== a.contributions.length + 1) die(`expected ${a.contributions.length + 1} contributions, the file has ${b.contributions.length} (build on the latest key)`);
  for (let i = 0; i < a.contributions.length; i++) if (a.contributions[i].contributionHash !== b.contributions[i].contributionHash) die("an earlier contribution was changed or dropped (#" + (i + 1) + ")");
  const k = b.contributions[b.contributions.length - 1];
  if (k.type !== 0) die("the new contribution is not a participant contribution");
  if (k.name !== name) die(`the contribution is named "${k.name}", expected "${name}"`);
  if (b.coeffsSha256 !== c.circuit.coeffsSha256) die("the key is for another circuit than " + circuit);
  const v = await L.verifyZkey({ r1cs: L.files(circuit).r1cs, ptau: path.join(work, c.ptau.file), zkey: file }); if (!v.ok) die("verification failed: " + v.log.filter((l) => /INVALID|not|fail/i.test(l)).slice(0, 3).join(" | "));
  const index = L.latestIndex(c) + 1; const dest = L.zkeyPath(work, index, circuit); fs.copyFileSync(file, dest);
  const z = { index, kind: "participant", circuit, file: path.basename(dest), name, contributionHash: k.contributionHash, sha256: L.sha256File(dest), at: new Date().toISOString() };
  const st2 = L.loadState(work); st2.circuits[circuit].zkeys.push(z); L.saveState(work, st2);
  return z;
}

// ------------------------------------------------------------------------------------------------ serve (the coordinator)
export function serve({ work, port = 8853, host = "127.0.0.1", log = console.log }) {
  let busy = false;
  const send = (res, code, body, headers = {}) => { res.writeHead(code, { "cache-control": "no-store", ...headers }); res.end(body); };
  const json = (res, code, o) => send(res, code, JSON.stringify(o, null, 1), { "content-type": "application/json" });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"); const circuit = url.searchParams.get("circuit") || "withdraw";
    try {
      const st = L.loadState(work);
      if (req.method === "GET" && url.pathname === "/status") {
        const per = Object.fromEntries(names(st).map((n) => { const c = st.circuits[n]; const nx = nextParticipant(st, n); return [n, { circuit: c.circuit, ptau: c.ptau, latest: L.latestIndex(c), next: nx ? nx.name : null,
          contributions: c.zkeys.filter((z) => z.index > 0).map(({ index, kind, name, contributionHash, sha256, at }) => ({ index, kind, name, contributionHash, sha256, at })), beacon: c.beacon }]; }));
        const first = names(st)[0]; const nx = names(st).map((n) => nextParticipant(st, n)).find(Boolean);
        return json(res, 200, { title: st.title, rehearsal: st.rehearsal, circuits: names(st), next: nx ? nx.name : null, waiting: st.participants.filter((p) => names(st).some((n) => !contributed(st.circuits[n]).some((z) => z.name === p.name))).map((p) => p.name),
          latest: L.latestIndex(st.circuits[first]), contributions: st.circuits[first].zkeys.filter((z) => z.index > 0).map(({ index, kind, name, contributionHash }) => ({ index, kind, name, contributionHash })), per });
      }
      if (req.method === "GET" && (url.pathname === "/latest" || /^\/zkey\/\d+$/.test(url.pathname))) {
        const c = cs(st, circuit); const i = url.pathname === "/latest" ? L.latestIndex(c) : Number(url.pathname.split("/")[2]); const z = c.zkeys.find((x) => x.index === i);
        if (!z) return json(res, 404, { error: "no such key" });
        return send(res, 200, fs.readFileSync(path.join(work, z.file)), { "content-type": "application/octet-stream", "x-veyl-index": String(i), "x-veyl-sha256": z.sha256, "x-veyl-circuit": circuit });
      }
      if (req.method === "POST" && url.pathname === "/contribute") {
        if (!st.circuits[circuit]) return json(res, 404, { error: "no such circuit" });
        const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""); const th = crypto.createHash("sha256").update(token).digest("hex");
        const who = st.participants.find((p) => p.tokenSha256 === th); if (!token || !who) return json(res, 403, { error: "unknown token" });
        const nx = nextParticipant(st, circuit); if (!nx || nx.name !== who.name) return json(res, 409, { error: nx ? `it is ${nx.name}'s turn on ${circuit}` : "the ceremony is not taking contributions" });
        if (Number(req.headers["x-veyl-index"]) !== L.latestIndex(st.circuits[circuit])) return json(res, 409, { error: "the key you built on is not the latest one: run the command again" });
        if (busy) return json(res, 409, { error: "another upload is being verified: try again in a minute" });
        busy = true;
        const tmp = path.join(work, `.upload-${process.pid}-${Date.now()}.zkey`);
        try {
          const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 96 << 20) return json(res, 413, { error: "too large" }); chunks.push(c); }
          fs.writeFileSync(tmp, Buffer.concat(chunks)); log(`upload from ${who.name} for ${circuit}: ${n} bytes, verifying...`);
          const z = await accept({ work, file: tmp, name: who.name, circuit }); log(`accepted ${circuit} #${z.index} ${who.name} ${z.contributionHash.slice(0, 16)}…`);
          return json(res, 200, z);
        } catch (e) { log(`refused upload from ${who.name} for ${circuit}: ${e.message}`); return json(res, 400, { error: e.message }); }
        finally { busy = false; try { fs.unlinkSync(tmp); } catch {} }
      }
      return json(res, 404, { error: "not found" });
    } catch (e) { return json(res, 500, { error: e.message }); }
  });
  srv.listen(port, host); return srv;
}

// ------------------------------------------------------------------------------------------------ contribute (a participant)
async function askLine(q) {
  if (!process.stdin.isTTY) return "";
  const rl = (await import("readline")).createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (x) => { rl.close(); r(x); }));
}
/// One contribution to one key: OS randomness (64 bytes) + optional text, mixed by snarkjs with its own randomness. The
/// secret exists only in this process's memory; nothing secret is written to disk.
export async function contributeFile({ input, output, name, text = "" }) {
  const entropy = crypto.randomBytes(64).toString("hex") + ":" + text + ":" + Date.now() + ":" + process.hrtime.bigint();
  const log = L.logger({ quiet: true });
  const h = await snarkjs.zKey.contribute(input, output, name, entropy, log); await L.terminateCurves();
  return L.hex(h);
}
export async function contribute(a) {
  const text = a.text && a.text !== true ? String(a.text) : (a["no-prompt"] ? "" : await askLine("Optional: type some random text (adds entropy; press Enter to skip): "));
  if (a.in) { // offline, one key
    if (!a.out || !a.name) die("--in <zkey> --out <zkey> --name <your registered name>");
    const h = await contributeFile({ input: a.in, output: a.out, name: a.name, text });
    console.log(`\nYour contribution hash (write it down; it will appear in the transcript):\n${L.formatHash(h)}\n\nSend ${a.out} to the coordinator.`); return { contributionHash: h };
  }
  const base = a.coordinator; if (!base || base === true) die("--coordinator <url> --token <token> (from the coordinator)");
  if (!a.token || a.token === true) die("--token <token>");
  const status = await (await fetch(base + "/status")).json();
  const name = a.name && a.name !== true ? a.name : status.next; if (!name) die("the coordinator is not taking contributions");
  console.log(`ceremony: ${status.title}${status.rehearsal ? " (REHEARSAL)" : ""}\ncontributing as: ${name} to ${status.circuits.join(", ")}`);
  const receipt = { ceremony: status.title, rehearsal: status.rehearsal, coordinator: base, name, circuits: {} };
  for (const circuit of status.circuits) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyl-contrib-")); const inF = path.join(dir, "in.zkey"), outF = path.join(dir, "out.zkey");
    try {
      const r = await fetch(base + "/latest?circuit=" + circuit); if (!r.ok) die(`download of ${circuit} failed: ` + r.status);
      const buf = Buffer.from(await r.arrayBuffer()); const idx = Number(r.headers.get("x-veyl-index"));
      if (crypto.createHash("sha256").update(buf).digest("hex") !== r.headers.get("x-veyl-sha256")) die("the download is corrupt (sha256 mismatch)");
      fs.writeFileSync(inF, buf); console.log(`[${circuit}] downloaded key #${idx} (${(buf.length / 1e6).toFixed(1)} MB), contributing (about a minute)...`);
      const h = await contributeFile({ input: inF, output: outF, name, text: text + ":" + circuit });
      console.log(`[${circuit}] uploading; the coordinator verifies the whole chain before accepting it (a minute or two)...`);
      const up = await fetch(base + "/contribute?circuit=" + circuit, { method: "POST", headers: { authorization: "Bearer " + a.token, "x-veyl-index": String(idx), "content-type": "application/octet-stream" }, body: fs.readFileSync(outF) });
      const res = await up.json(); if (!up.ok) die(`the coordinator refused ${circuit}: ` + res.error);
      if (res.contributionHash !== h) die("the coordinator recorded a different hash: " + res.contributionHash);
      receipt.circuits[circuit] = { index: res.index, contributionHash: h, zkeySha256: res.sha256, at: res.at };
      console.log(`[${circuit}] accepted as contribution #${res.index}:\n${L.formatHash(h)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const rf = path.resolve(a.receipt && a.receipt !== true ? a.receipt : `veyl-contribution-${name.replace(/[^a-z0-9]+/gi, "-")}.json`); fs.writeFileSync(rf, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`\nDone: one contribution per circuit. Your hashes must appear in the final transcript. Receipt: ${rf}`);
  return receipt;
}

// ------------------------------------------------------------------------------------------------ beacon
/// The final random beacon: a value nobody could know while contributions were open (announced in advance), hashed 2^iterations times.
export async function beaconValue(a) {
  if (a.hash && a.hash !== true) { if (!/^[0-9a-fA-F]{2,510}$/.test(a.hash) || a.hash.length % 2) die("--hash must be hex"); if (!a.source || a.source === true) die("--source \"<where this value comes from>\""); return { value: a.hash.toLowerCase(), source: a.source }; }
  if (a["btc-height"]) { const h = Number(a["btc-height"]); const r = await fetch(`https://mempool.space/api/block-height/${h}`); if (!r.ok) die(`could not fetch Bitcoin block ${h} (${r.status}); read its hash from two explorers and pass --hash <hash> --source "Bitcoin block ${h}"`);
    const v = (await r.text()).trim(); if (!/^[0-9a-f]{64}$/.test(v)) die("unexpected answer for block " + h); return { value: v, source: `Bitcoin block ${h} hash (mempool.space; check it on a second explorer)` }; }
  if (a["drand-round"]) { const n = Number(a["drand-round"]); const r = await fetch(`https://api.drand.sh/public/${n}`); if (!r.ok) die(`could not fetch drand round ${n}; pass --hash <randomness> --source "drand mainnet round ${n}"`);
    const j = await r.json(); return { value: j.randomness, source: `drand (League of Entropy mainnet, default chain) round ${n}` }; }
  die("--btc-height <h>, --drand-round <r> or --hash <hex> --source <text>");
}
/// The same beacon value closes every circuit's key.
export async function beacon({ work, value, source, iterations = 10, force = false }) {
  const st = L.loadState(work); const out = {};
  for (const name of names(st)) {
    const c = cs(st, name); if (c.beacon) die(`[${name}] the beacon is already applied`);
    const n = contributed(c).length; if (n < 1) die(`[${name}] no contributions yet`);
    if (!st.rehearsal && n < 3 && !force) die(`[${name}] only ${n} contribution(s); the ceremony needs at least 3 independent contributors before the beacon (--force to override)`);
  }
  for (const name of names(st)) {
    const c = cs(L.loadState(work), name); const prev = L.zkeyPath(work, L.latestIndex(c), name); const index = L.latestIndex(c) + 1; const dest = L.zkeyPath(work, index, name);
    const log = L.logger({ quiet: true }); const bname = ("Final beacon: " + source).slice(0, 64);
    const h = await snarkjs.zKey.beacon(prev, dest, bname, value, Number(iterations), log); await L.terminateCurves();
    if (!h) die(`[${name}] beacon failed: ` + log.lines.join(" | "));
    const v = await L.verifyZkey({ r1cs: L.files(name).r1cs, ptau: path.join(work, c.ptau.file), zkey: dest }); if (!v.ok) die(`[${name}] the beaconed key does not verify`);
    const st2 = L.loadState(work); const z = { index, kind: "beacon", circuit: name, file: path.basename(dest), name: bname, contributionHash: L.hex(h), sha256: L.sha256File(dest), at: new Date().toISOString() };
    st2.circuits[name].zkeys.push(z); st2.circuits[name].beacon = { source, value, iterations: Number(iterations), index, contributionHash: z.contributionHash }; L.saveState(work, st2);
    out[name] = z;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ verify
/// Verify one circuit's key against its r1cs and the ptau and list every contribution; cross-check a state / transcript.
export async function verify({ circuit = "withdraw", zkey, ptau, work, transcript = null, quiet = false }) {
  const problems = []; let st = null; let c = null;
  if (work && fs.existsSync(L.statePath(work))) { st = L.loadState(work); c = st.circuits[circuit] || null; }
  const tc = transcript && transcript.circuits ? transcript.circuits[circuit] : null;
  zkey = zkey || (c ? L.zkeyPath(work, L.latestIndex(c), circuit) : L.files(circuit).zkey);
  ptau = ptau || (c ? path.join(work, c.ptau.file) : L.findPtau(null, L.DEFAULT_WORK, circuit));
  if (!ptau || !fs.existsSync(ptau)) return { ok: false, problems: [`the ptau is not here: download ${L.ptauRecord(circuit).file} (ceremony/ptau.json) and pass --ptau or set CEREMONY_PTAU_${L.circuitRecord(circuit).power}`], contributions: [] };
  const rehearsal = st ? st.rehearsal : transcript ? transcript.rehearsal : false;
  const pt = await L.checkPtau(ptau, { rehearsal, name: circuit }); problems.push(...pt.problems);
  if (c && pt.blake2b !== c.ptau.blake2b) problems.push("the ptau is not the one this ceremony started from");
  if (tc && pt.blake2b !== tc.ptau.blake2b) problems.push("the ptau is not the one the transcript names");
  const r1cs = await L.ensureR1cs(circuit);
  if (!quiet) console.log(`[${circuit}] verifying ${rel(path.resolve(zkey))} against the r1cs and ${path.basename(ptau)} (a minute or two)...`);
  const v = await L.verifyZkey({ r1cs, ptau, zkey }); if (!v.ok) problems.push("snarkjs zkey verify failed: " + v.log.filter((l) => /INVALID|does not|not identical|match/i.test(l)).slice(0, 2).join(" | "));
  if (v.info.coeffsSha256 !== L.circuitRecord(circuit).coeffsSha256) problems.push(`the key is for different constraints than ceremony/circuits.json (${circuit})`);
  const listed = c ? c.zkeys.filter((z) => z.index > 0) : tc ? tc.contributions : null;
  if (listed) {
    if (listed.length !== v.info.contributions.length) problems.push(`the record lists ${listed.length} contribution(s), the key has ${v.info.contributions.length}`);
    v.info.contributions.forEach((k, i) => { const r = listed[i]; if (r && (r.contributionHash !== k.contributionHash || r.name !== k.name)) problems.push(`contribution #${i + 1} differs from the record`); });
  }
  if (!quiet) {
    console.log(`\n[${circuit}] circuit hash ${v.info.csHash.slice(0, 32)}…  (${v.info.contributions.length} contributions)`);
    for (const k of v.info.contributions) console.log(`#${k.index} ${k.kind.padEnd(11)} ${k.name}\n${L.formatHash(k.contributionHash).replace(/^/gm, "    ")}${k.kind === "beacon" ? `\n    beacon value ${k.beaconHash}  iterations 2^${k.numIterationsExp}` : ""}`);
    console.log(problems.length ? "\nNOT OK:\n  " + problems.join("\n  ") : "\nOK: the key derives from the r1cs and the ptau, and every contribution above is in it.");
  }
  return { ok: !problems.length, problems, contributions: v.info.contributions, csHash: v.info.csHash, ptauBlake2b: pt.blake2b, log: v.log };
}

// ------------------------------------------------------------------------------------------------ finalize
const rel = (f) => { const r = path.relative(ROOT, f); return r && !r.startsWith("..") ? r : f; };
export async function finalize({ work, out = ROOT }) {
  const st = L.loadState(work); out = path.resolve(out);
  if (st.rehearsal && out === path.resolve(ROOT)) die("a rehearsal never replaces the repo's keys: pass --out <separate dir>");
  for (const name of names(st)) { const c = cs(st, name); if (!c.beacon) die(`[${name}] apply the beacon first`); if (!st.rehearsal && contributed(c).length < 3) die(`[${name}] at least 3 contributions are needed`); }
  const P = (...x) => path.join(out, ...x); for (const d of ["zk/keys", "programs/veyl_pool/src", "site", "ceremony"]) fs.mkdirSync(P(d), { recursive: true });
  const t = { version: 2, title: st.title, rehearsal: st.rehearsal, finalizedAt: new Date().toISOString(), snarkjs: L.readJson(path.join(L.SNARK_ROOT, "package.json")).version, circuits: {} };
  const logs = []; const setup = { _comment: "Provenance of the Groth16 keys, written by `npm run ceremony -- finalize`. Preflight compares these hashes with zk/, the program's baked-in verifying keys and the site's copies, and (mainnet) re-verifies the whole ceremony.",
    kind: st.rehearsal ? "rehearsal" : "ceremony", transcript: "ceremony/TRANSCRIPT.md", circuits: {} };
  for (const name of names(st)) {
    const c = cs(st, name); const F = L.files(name, out); const final = L.zkeyPath(work, L.latestIndex(c), name);
    const v = await verify({ circuit: name, zkey: final, ptau: path.join(work, c.ptau.file), work, quiet: true }); if (!v.ok) die(`[${name}] the final key does not verify: ` + v.problems.join("; "));
    fs.copyFileSync(final, F.zkey); fs.copyFileSync(final, F.site);
    if (out !== path.resolve(ROOT)) fs.copyFileSync(L.files(name).wasm, F.siteWasm); // unchanged: the circuit is the same
    const vk = await snarkjs.zKey.exportVerificationKey(final); await L.terminateCurves();
    fs.writeFileSync(F.vkey, JSON.stringify(vk, null, 1));
    execFileSync(process.execPath, [path.join(ROOT, "scripts/vkey-to-rust.js"), F.vkey, F.vkeyRs], { stdio: "ignore" });
    logs.push(`# ${name}\n` + v.log.join("\n"));
    const hashes = { zkeySha256: L.sha256File(final), vkeySha256: L.sha256File(F.vkey), vkeyRsSha256: L.sha256File(F.vkeyRs), wasmSha256: L.sha256File(L.files(name).wasm) };
    const rec = L.circuitRecord(name);
    t.circuits[name] = { circuit: { ...rec, csHash: v.csHash }, ptau: { ...c.ptau, download: (L.ptauRecords()[c.ptau.power] || {}).download || [] },
      contributions: v.contributions.map((k) => { const z = c.zkeys.find((x) => x.index === k.index) || {}; return { index: k.index, kind: k.kind, name: k.name, contributionHash: k.contributionHash, zkeySha256: z.sha256, at: z.at, ...(k.kind === "beacon" ? { beaconValue: k.beaconHash, iterationsExp: k.numIterationsExp, source: c.beacon.source } : {}) }; }),
      final: hashes, verify: { ok: true, at: new Date().toISOString() } };
    setup.circuits[name] = { circuit: rec.circuit, zkeySha256: hashes.zkeySha256, vkeySha256: hashes.vkeySha256, wasmSha256: hashes.wasmSha256 };
  }
  fs.writeFileSync(P("zk/keys/contribution.log"), logs.join("\n\n") + "\n");
  // the withdraw circuit's hashes also stay at the top level (what preflight and the Phase 1 tooling read)
  Object.assign(setup, { description: `Phase 1: published Perpetual Powers of Tau files (${[...new Set(names(st).map((n) => st.circuits[n].ptau.file))].join(", ")})${st.rehearsal ? " (REHEARSAL: local files)" : ""}. Phase 2: ${contributed(cs(st, names(st)[0])).length} contributions per circuit + a random beacon (${cs(st, names(st)[0]).beacon.source}). See ceremony/TRANSCRIPT.md.`,
    circuit: "zk/circuits/withdraw.circom", ...(setup.circuits.withdraw ? { zkeySha256: setup.circuits.withdraw.zkeySha256, vkeySha256: setup.circuits.withdraw.vkeySha256, wasmSha256: setup.circuits.withdraw.wasmSha256 } : {}), contributionLogSha256: L.sha256File(P("zk/keys/contribution.log")) });
  L.writeJson(P("ceremony/transcript.json"), t);
  fs.writeFileSync(P("ceremony/TRANSCRIPT.md"), transcriptMd(t));
  L.writeJson(P("zk/keys/SETUP.json"), setup);
  const st2 = L.loadState(work); for (const n of names(st2)) st2.circuits[n].finalized = { at: t.finalizedAt, out }; L.saveState(work, st2);
  const filesOut = names(st).flatMap((n) => { const F = L.files(n, out); return [F.zkey, F.vkey, F.vkeyRs, F.site]; });
  return { out, transcript: t, files: [...filesOut, P("zk/keys/SETUP.json"), P("zk/keys/contribution.log"), P("ceremony/TRANSCRIPT.md"), P("ceremony/transcript.json")] };
}

export function transcriptMd(t) {
  const code = (x) => "`" + x + "`";
  const sec = (name, c) => { const parts = c.contributions.filter((k) => k.kind === "participant"); const b = c.contributions.find((k) => k.kind === "beacon");
    return `## ${name}

| | |
|---|---|
| circuit | ${code(c.circuit.circuit)} sha256 ${code(c.circuit.circuitSha256)} |
| compiler | circom ${c.circuit.circom} (${c.circuit.circomNpm}), circomlib ${c.circuit.circomlib}, ${code(c.circuit.flags)} |
| r1cs sha256 | ${code(c.circuit.r1csSha256)} |
| wasm sha256 (witness generator, unchanged) | ${code(c.circuit.wasmSha256)} |
| constraints / wires / public signals | ${c.circuit.constraints} / ${c.circuit.wires} / ${c.circuit.publicSignals} |
| circuit hash (snarkjs) | ${code(c.circuit.csHash)} |
| phase 1 | ${code(c.ptau.file)}, 2^${c.ptau.power}, blake2b-512 ${code(c.ptau.blake2b)}${c.ptau.public ? " (a published Perpetual Powers of Tau file)" : " (a local rehearsal file, not the public ceremony)"} |

Phase 2 contributions (${parts.length} + beacon):

| # | contributor | contribution hash (blake2b-512) | key after it (sha256) | time |
|---|---|---|---|---|
${c.contributions.map((k) => `| ${k.index} | ${k.kind === "beacon" ? "**beacon**" : k.name} | ${code(k.contributionHash)} | ${code(k.zkeySha256 || "")} | ${k.at || ""} |`).join("\n")}

${b ? `Beacon: ${b.source}. Value ${code(b.beaconValue)}, hashed 2^${b.iterationsExp} times.` : ""}

| result | sha256 |
|---|---|
| zk/keys/${name}_final.zkey | ${code(c.final.zkeySha256)} |
| zk/keys/${name}_vkey.json | ${code(c.final.vkeySha256)} |
| programs/veyl_pool/src/${name === "withdraw" ? "vkey.rs" : "vkey_" + name + ".rs"} | ${code(c.final.vkeyRsSha256)} |
`; };
  return `# ${t.rehearsal ? "REHEARSAL transcript (practice run, NOT the production keys)" : "Trusted-setup transcript"}: Veyl circuits

${t.rehearsal ? "> This is a rehearsal with simulated participants and a fixed test beacon. Its keys must never be used for real funds and preflight never accepts it.\n\n" : ""}Groth16 phase-2 ceremony for ${Object.keys(t.circuits).map(code).join(", ")}, finalized ${t.finalizedAt} with snarkjs ${t.snarkjs}. Every contributor contributed to every circuit; the same random beacon closes each. The circuits are unchanged: only their proving and verifying keys are new.

${Object.entries(t.circuits).map(([n, c]) => sec(n, c)).join("\n")}
## Verify it yourself
\`\`\`bash
npm ci
b2sum <each phase-1 file above>                        # must print the hashes above
npm run ceremony -- r1cs                               # recompiles every circuit; each wasm must equal the shipped one
${Object.entries(t.circuits).map(([n, c]) => `npm run ceremony -- verify --circuit ${n} --zkey zk/keys/${n}_final.zkey --ptau ${c.ptau.file}`).join("\n")}
\`\`\`
${code("verify")} recomputes each key from its r1cs and the ptau, checks every contribution and the beacon, and lists every contribution hash: each contributor finds theirs above. ${code("npm run preflight -- --network mainnet")} then checks that the verifying keys baked into ${code("veyl_pool.so")} are these.
`;
}

// ------------------------------------------------------------------------------------------------ CLI
export async function main(argv = process.argv.slice(2)) {
  const a = parse(argv); const cmd = a._[0]; const work = workOf(a);
  const only = a.circuit && a.circuit !== true ? [a.circuit] : a.circuits && a.circuits !== true ? String(a.circuits).split(",") : L.CIRCUIT_NAMES;
  switch (cmd) {
    case "r1cs": { for (const name of only) { const r = await L.compileR1cs({ name, quiet: !!a.quiet }); console.log(`\nzk/build/${name}.r1cs sha256 ${r.r1csSha256}\nwasm identical to zk/build/${name}.wasm (${r.wasmSha256.slice(0, 16)}…): same circuit, same compile`); } break; }
    case "init": { const per = {}; for (const p of [14, 15, 16]) if (a["ptau-" + p] && a["ptau-" + p] !== true) per[p] = a["ptau-" + p];
      await init({ ptau: Object.keys(per).length ? per : a.ptau === true ? null : a.ptau || null, work, rehearsal: !!a.rehearsal, title: a.title, force: !!a.force, circuits: only }); break; }
    case "add-participant": { const p = addParticipant({ work, name: a.name }); console.log(`#${p.order} ${p.name}\ntoken (give it to them privately; it is shown once): ${p.token}`); break; }
    case "skip": { const q = skip({ work, name: a.name }); console.log("queue now: " + q.join(" -> ")); break; }
    case "serve": { const port = Number(a.port || 8853); serve({ work, port, host: a.host || "127.0.0.1" }); console.log(`coordinator on http://${a.host || "127.0.0.1"}:${port}  (GET /status, GET /latest?circuit=, POST /contribute?circuit=)`); return new Promise(() => {}); }
    case "contribute": await contribute(a); break;
    case "accept": { if (!a.file || !a.name || !a.circuit) die("--circuit <name> --file <zkey> --name <participant>"); const z = await accept({ work, file: a.file, name: a.name, circuit: a.circuit }); console.log(`accepted ${z.circuit} #${z.index} ${z.name}\n${L.formatHash(z.contributionHash)}`); break; }
    case "beacon": { const bv = await beaconValue(a); console.log(`beacon value ${bv.value}\nsource ${bv.source}`); const zs = await beacon({ work, ...bv, iterations: a.iterations || 10, force: !!a.force }); for (const [n, z] of Object.entries(zs)) console.log(`[${n}] beacon applied as #${z.index}\n${L.formatHash(z.contributionHash)}`); break; }
    case "verify": { const tf = path.join(CEREMONY, "transcript.json"); const useWork = !a.zkey && fs.existsSync(L.statePath(work)); let ok = true;
      for (const name of only) { const r = await verify({ circuit: name, zkey: a.zkey, ptau: a.ptau === true ? null : a.ptau, work: useWork ? work : null, transcript: !useWork && fs.existsSync(tf) ? L.readJson(tf) : null });
        ok = ok && r.ok; if (a.json) console.log(JSON.stringify({ circuit: name, ok: r.ok, problems: r.problems, contributions: r.contributions }, null, 1)); }
      process.exitCode = ok ? 0 : 1; break; }
    case "finalize": { const r = await finalize({ work, out: a.out && a.out !== true ? a.out : ROOT }); console.log(`finalized into ${r.out}:\n  ${r.files.map(rel).join("\n  ")}`);
      if (r.out === path.resolve(ROOT)) console.log("\nNext: npm run build (veyl_pool with the new vkey*.rs), npm test, npm run preflight -- --network mainnet, commit ceremony/TRANSCRIPT.md and publish it."); break; }
    case "status": { const st = L.loadState(work); console.log(JSON.stringify({ title: st.title, rehearsal: st.rehearsal, participants: st.participants.map((p) => p.name),
      circuits: Object.fromEntries(names(st).map((n) => [n, { ptau: st.circuits[n].ptau.file, contributions: st.circuits[n].zkeys.filter((z) => z.index > 0).map((z) => `#${z.index} ${z.name} ${z.contributionHash.slice(0, 16)}…`), beacon: !!st.circuits[n].beacon }])) }, null, 1)); break; }
    default: console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); if (cmd) process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => { if (process.exitCode === undefined) process.exit(0); else process.exit(process.exitCode); }, (e) => { console.error(e.userFacing ? "error: " + e.message : e); process.exit(1); });
}
