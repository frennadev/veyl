#!/usr/bin/env node
// A full ceremony rehearsal for EVERY circuit (withdraw, transact, position, swap, claim), end to end, on this machine:
//   npm run ceremony:rehearse -- --ptau <prepared ptau, power >= 15> [--out <dir>]
//
//   init (rehearsal, all circuits) -> coordinator on 127.0.0.1:8853 -> 3 simulated participants, each running the real
//   one-command `contribute` in its own process (it contributes to every circuit in turn) -> refused uploads (wrong turn,
//   unknown token, a key with no new contribution, a key for another circuit) -> beacon (fixed test value, every circuit)
//   -> verify each -> finalize into --out (default ceremony/rehearsal/) -> veyl_pool built with the five rehearsal vkey*.rs
//   in a scratch workspace -> local validator (RPC 8933), full deployment with that veyl_pool -> REAL transact proofs made
//   with the rehearsal zkey: a shielded deposit (post_proof + shield_deposit + approve) and a hidden transfer executed on
//   chain; a dev-key transact proof is refused; the legacy withdraw circuit's rehearsal proof verifies and executes too;
//   a FULL sealed batch (tests/sealed-batch.js) proven with the rehearsal swap and claim keys: 3 + 3 sealed swaps, two
//   committee members' partial decryptions checked on chain, settlement, six claims; a dev-key swap proof is refused.
//
// The repo's keys (zk/keys, programs/veyl_pool/src/vkey*.rs, site/*_final.zkey, target/deploy) are never touched; the
// run checks their hashes before and after. Needs the Solana CLI + cargo-build-sbf (like npm run build) and ~20 minutes.
import fs from "fs"; import path from "path"; import os from "os"; import crypto from "crypto"; import { spawn, execFileSync } from "child_process"; import { createRequire } from "module";
import * as L from "./lib.mjs"; import * as C from "./ceremony.mjs";
const require = createRequire(import.meta.url); const { ROOT } = L;
const a = C.parse(process.argv.slice(2));
const ptau = a.ptau && a.ptau !== true ? path.resolve(a.ptau) : null;
const OUT = path.resolve(a.out && a.out !== true ? a.out : path.join(L.CEREMONY, "rehearsal"));
const WORK = path.resolve(a.work && a.work !== true ? a.work : fs.mkdtempSync(path.join(os.tmpdir(), "veyl-rehearsal-")));
const PORT = Number(a.port || 8853); const BASE = `http://127.0.0.1:${PORT}`;
const t0 = Date.now(); const lap = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";
let pass = 0, fail = 0; const results = [];
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; results.push({ check: n, ok: !!ok, detail: String(extra) }); console.log((ok ? "  ok  " : "  FAIL") + " " + n + (extra !== "" ? "  " + String(extra).slice(0, 160) : "")); };
const GUARDED = [...L.CIRCUIT_NAMES.flatMap((n) => { const F = L.files(n); return [F.zkey, F.vkey, F.vkeyRs, F.site].map((f) => path.relative(ROOT, f)); }), "zk/keys/SETUP.json", "target/deploy/veyl_pool.so", "ceremony/TRANSCRIPT.md"];
const snapshot = () => Object.fromEntries(GUARDED.map((f) => [f, fs.existsSync(path.join(ROOT, f)) ? L.sha256File(path.join(ROOT, f)) : null]));

function run(args, opts = {}) { // a participant: a separate process running the real command
  return new Promise((resolve) => { const p = spawn(process.execPath, [path.join(L.CEREMONY, "ceremony.mjs"), ...args], { cwd: opts.cwd || WORK, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("exit", (code) => resolve({ code, out })); });
}
async function post(token, index, body, circuit = "withdraw") { const r = await fetch(BASE + "/contribute?circuit=" + circuit, { method: "POST", headers: { authorization: "Bearer " + token, "x-veyl-index": String(index) }, body }); return { status: r.status, body: await r.json() }; }

/// veyl_pool with another vkey.rs, built in a scratch copy of the workspace with its own cargo target dir (seeded from the
/// repo's, so dependencies are not recompiled). Nothing in the repo's target/ is written.
function buildPoolWith(srcDir, dir) {
  const ws = path.join(dir, "ws"); fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, "programs"), { recursive: true });
  for (const f of ["Cargo.toml", "Cargo.lock"]) fs.copyFileSync(path.join(ROOT, f), path.join(ws, f));
  fs.cpSync(path.join(ROOT, "programs/veyl_pool"), path.join(ws, "programs/veyl_pool"), { recursive: true });
  for (const f of ["vkey.rs", "vkey_transact.rs", "vkey_position.rs", "vkey_swap.rs", "vkey_claim.rs"]) fs.copyFileSync(path.join(srcDir, f), path.join(ws, "programs/veyl_pool/src", f));
  const target = path.join(dir, "target");
  if (!fs.existsSync(target)) { fs.mkdirSync(target); for (const d of ["release", "sbpf-solana-solana"]) if (fs.existsSync(path.join(ROOT, "target", d))) execFileSync("cp", ["-a", path.join(ROOT, "target", d), target]); }
  const bin = process.env.SOLANA_BIN || "/opt/solana/bin"; const env = { ...process.env, CARGO_TARGET_DIR: target, PATH: `${bin}:${os.homedir()}/.cargo/bin:${process.env.PATH}` };
  const deploy = path.join(dir, "deploy"); fs.mkdirSync(deploy, { recursive: true });
  execFileSync("cargo-build-sbf", ["--manifest-path", path.join(ws, "programs/veyl_pool/Cargo.toml"), "--sbf-out-dir", deploy], { env, stdio: ["ignore", "ignore", "inherit"] });
  return path.join(deploy, "veyl_pool.so");
}

(async () => {
  if (!ptau || !fs.existsSync(ptau)) { console.error("--ptau <prepared ptau file> (any prepared file of power >= 15: a rehearsal does not need the public ones)"); process.exit(2); }
  if (path.resolve(OUT) === path.resolve(ROOT)) { console.error("--out must be a separate directory"); process.exit(2); }
  const before = snapshot(); let srv = null, val = null; const NAMES = L.CIRCUIT_NAMES;
  console.log(`rehearsal: work ${WORK}\n           out  ${OUT}\n           circuits ${NAMES.join(", ")}\n`);
  try {
    // ---- 1. init, every circuit from the same prepared ptau
    await C.init({ ptau, work: WORK, rehearsal: true, title: "Veyl circuits (withdraw, transact, position), phase 2 (rehearsal)", force: true });
    const st0 = L.loadState(WORK);
    check("init: one ceremony, every circuit (five); each initial key encodes its recorded circuit (same constraint coefficients as the dev keys)", st0.rehearsal && NAMES.every((n) => st0.circuits[n] && st0.circuits[n].circuit.coeffsSha256 === L.circuitRecord(n).coeffsSha256),
      NAMES.map((n) => `${n} ${st0.circuits[n].circuit.constraints}`).join(", ") + "  " + lap());
    // ---- 2. three simulated participants (made-up names), registered in order
    const P = ["rehearsal-participant-1", "rehearsal-participant-2", "rehearsal-participant-3"].map((name) => C.addParticipant({ work: WORK, name }));
    srv = C.serve({ work: WORK, port: PORT, log: (m) => console.log("    [coordinator] " + m) });
    const status = await (await fetch(BASE + "/status")).json();
    check("coordinator serves the status: every circuit, next = participant 1, nothing contributed", status.next === P[0].name && status.contributions.length === 0 && status.rehearsal === true && status.circuits.join() === NAMES.join());
    const latest = async (c) => Buffer.from(await (await fetch(BASE + "/latest?circuit=" + c)).arrayBuffer());
    const l0 = await latest("withdraw");
    check("an unknown token is refused (403)", (await post("not-a-token", 0, l0)).status === 403);
    check("a participant out of turn is refused (409)", (await post(P[1].token, 0, l0)).status === 409);
    const noNew = await post(P[0].token, 0, l0);
    check("an upload that adds no contribution is refused after inspection (400)", noNew.status === 400 && /expected 1 contributions/.test(noNew.body.error), noNew.body.error);
    { const other = await C.contributeFile({ input: L.zkeyPath(WORK, 0, "transact"), output: path.join(WORK, "wrong.zkey"), name: P[0].name, text: "x" });
      const wrong = await post(P[0].token, 0, fs.readFileSync(path.join(WORK, "wrong.zkey")), "position");
      check("a contribution to the transact key uploaded as the position key is refused (another circuit)", wrong.status === 400, wrong.body.error); void other; }
    // the three contributions: ONE command per participant, every circuit in turn, each in its own process
    const receipts = [];
    for (const [i, p] of P.entries()) {
      const r = await run(["contribute", "--coordinator", BASE, "--token", p.token, "--text", `simulated keyboard noise ${i} ${Math.random()}`, "--no-prompt", "--receipt", path.join(WORK, `receipt-${i + 1}.json`)]);
      const rc = r.code === 0 && fs.existsSync(path.join(WORK, `receipt-${i + 1}.json`)) ? L.readJson(path.join(WORK, `receipt-${i + 1}.json`)) : null; receipts.push(rc);
      check(`participant ${i + 1} contributes to all five circuits with one command (download, contribute, upload, verified by the coordinator, per circuit)`, rc && rc.name === p.name && NAMES.every((n) => rc.circuits[n] && rc.circuits[n].index === i + 1),
        rc ? NAMES.map((n) => n + " " + rc.circuits[n].contributionHash.slice(0, 12) + "…").join(", ") + "  " + lap() : r.out.slice(-300));
    }
    const late = await post(P[0].token, 3, fs.readFileSync(L.zkeyPath(WORK, 3, "transact")), "transact");
    check("a fourth upload is refused: nobody else is registered", late.status === 409, late.body.error);
    srv.close(); srv = null;
    // ---- 3. beacon (fixed test value) on every circuit, 4. verify each
    const TEST_BEACON = Buffer.from("veyl rehearsal: a fixed test value, not a real beacon").toString("hex");
    const bz = await C.beacon({ work: WORK, value: TEST_BEACON, source: "REHEARSAL fixed test value (not a real beacon)", iterations: 10 });
    check("beacon applied to every circuit (one fixed test value, 2^10 iterations)", NAMES.every((n) => bz[n] && bz[n].index === 4), lap());
    for (const n of NAMES) {
      const v = await C.verify({ circuit: n, work: WORK, quiet: true });
      check(`verify ${n}: the final key derives from its r1cs and the ptau; 3 participant contributions + 1 beacon; each participant's hash is in it`, v.ok && v.contributions.length === 4 && v.contributions.filter((c) => c.kind === "participant").length === 3 && v.contributions[3].kind === "beacon"
        && receipts.every((r, i) => r && v.contributions[i].contributionHash === r.circuits[n].contributionHash), v.problems.join("; ") || lap());
    }
    // ---- 5. finalize into the separate output dir
    const fin = await C.finalize({ work: WORK, out: OUT });
    const setup = L.readJson(path.join(OUT, "zk/keys/SETUP.json")); const vk = (dir, n) => L.readJson(path.join(dir, `zk/keys/${n}_vkey.json`));
    check("finalize: per circuit vkey, vkey*.rs, zkey (zk + site copies); SETUP.json kind 'rehearsal' with all circuits; TRANSCRIPT.md with a section per circuit", fin.files.every((f) => fs.existsSync(f)) && setup.kind === "rehearsal" && NAMES.every((n) => setup.circuits[n])
      && NAMES.every((n) => fs.readFileSync(path.join(OUT, "ceremony/TRANSCRIPT.md"), "utf8").includes("## " + n)) && /REHEARSAL/.test(fs.readFileSync(path.join(OUT, "ceremony/TRANSCRIPT.md"), "utf8")), lap());
    check("the rehearsal keys are new keys for the same circuits: same public inputs, different delta (each circuit)", NAMES.every((n) => vk(OUT, n).nPublic === vk(ROOT, n).nPublic && vk(OUT, n).IC.length === vk(ROOT, n).IC.length && JSON.stringify(vk(OUT, n).vk_delta_2) !== JSON.stringify(vk(ROOT, n).vk_delta_2)));
    let refuse = null; try { await C.finalize({ work: WORK, out: ROOT }); } catch (e) { refuse = e.message; }
    check("finalizing a rehearsal into the repo is refused", refuse && /never replaces/.test(refuse), refuse);

    // ---- 6. the rehearsal keys on chain
    console.log("  building veyl_pool with the rehearsal vkey*.rs (scratch workspace)...", lap());
    const so = buildPoolWith(path.join(OUT, "programs/veyl_pool/src"), path.join(WORK, "build"));
    const { vkeyParts } = require(path.join(ROOT, "scripts/preflight.js")); const bin = fs.readFileSync(so);
    check("the rehearsal veyl_pool.so embeds all five rehearsal verifying keys and none of the dev deltas", NAMES.every((n) => vkeyParts(vk(OUT, n)).every(([, b]) => bin.indexOf(b) >= 0) && bin.indexOf(vkeyParts(vk(ROOT, n)).find(([k]) => k === "delta")[1]) < 0), lap());
    const lib = require(path.join(ROOT, "scripts/lib.js")); const S = require(path.join(ROOT, "sdk/veyl.js")); const Z = require(path.join(ROOT, "sdk/shield.js")); const PR = require(path.join(ROOT, "sdk/prover.js"));
    const { Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), "veyl-rehearsal-val-")); const payer = Keypair.generate(); const payerFile = path.join(vdir, "payer.json"); fs.writeFileSync(payerFile, JSON.stringify([...payer.secretKey]));
    const postman = Keypair.generate(), relayer = Keypair.generate();
    const sv = await lib.startValidator(vdir, payer, lib.RPC_PORT); val = sv.val; const conn = sv.conn;
    for (const k of [postman, relayer]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    await lib.deployPrograms(sv.rpc, payerFile); // the repo's programs, then veyl_pool upgraded to the rehearsal build
    execFileSync(lib.tool("solana"), ["program", "deploy", "-u", sv.rpc, "-k", payerFile, "--program-id", path.join(ROOT, "target/deploy/veyl_pool-keypair.json"), so], { stdio: ["ignore", "ignore", "inherit"] });
    await lib.sleep(1500);
    const { V, dep, T } = await lib.deployAll({ rpc: sv.rpc, payerFile, postman: postman.publicKey, relayer: relayer.publicKey, deploy: false });
    const as = (kp) => { const v = new S.Veyl({ connection: conn, programs: V.programs, payer: kp }); v.lookupTable = V.lookupTable; return v; };
    const USDC = T.USDC.mint; await lib.fund(conn, payer, USDC, payer.publicKey, lib.units(1000, 6));
    const mints = Object.fromEntries(Object.values(T).map((t) => [t.mint.toBase58(), { sym: t.sym, decimals: t.decimals }]));
    const wallet = () => new Z.ShieldWallet(crypto.randomBytes(32), { mints, pools: [] }); const A = wallet(), B = wallet();
    const sync = async (...ws) => { const st = await V.readShield(); st.tree = new Z.Tree(st.leaves); for (const w of ws) w.scan(st); };
    const RK = { wasm: path.join(ROOT, "zk/build/transact.wasm"), zkey: path.join(OUT, "zk/keys/transact_final.zkey") };
    // a deposit proven with the DEV transact key: refused by the rehearsal program
    await sync(A); const d = A.deposit(USDC, lib.units(100, 6));
    const pDev = await PR.proveTransact(d.input); await L.terminateCurves();
    let devRefused = false; try { await V.send([V.postProofIx(payer.publicKey, 1, pDev.proof, pDev.pubs)], [], 1_400_000); } catch (e) { devRefused = /BadProof/.test(String(e.message) + JSON.stringify(e.logs || "")); }
    check("on chain: a transact proof made with the dev key is refused by the rehearsal program (BadProof)", devRefused);
    const t1 = Date.now(); const pR = await PR.proveTransact(d.input, RK); await L.terminateCurves(); const ms = Date.now() - t1;
    check("snarkjs: the rehearsal transact proof verifies with the rehearsal vkey and not with the dev vkey", (await L.snarkjs.groth16.verify(vk(OUT, "transact"), pR.raw.publicSignals, pR.raw.proof)) && !(await L.snarkjs.groth16.verify(vk(ROOT, "transact"), pR.raw.publicSignals, pR.raw.proof)), ms + " ms");
    await L.terminateCurves();
    await V.send([V.postProofIx(payer.publicKey, 1, pR.proof, pR.pubs)], [], 1_400_000);
    const sig = await V.send([await V.shieldDepositIx(payer.publicKey, d.ext, pR.pubs)], [], 600_000); const ev = (await V.events(sig)).find((e) => e.name === "DepositPending");
    await as(postman).send([V.approveDepositIx(postman.publicKey, ev.pending, payer.publicKey)]); await sync(A);
    check("on chain: a REAL rehearsal transact proof verifies in post_proof and the shielded deposit executes (100 USDC note, approved into the tree)", A.balance(USDC) === lib.units(100, 6));
    const t = A.spend({ mint: USDC, send: lib.units(40, 6), to: B.address, hideToken: true }); const pT = await PR.proveTransact(t.input, RK); await L.terminateCurves();
    await as(relayer).send([V.postProofIx(relayer.publicKey, 1, pT.proof, pT.pubs)], [], 1_400_000); await as(relayer).sendV0([await V.shieldTransactIx(relayer.publicKey, t.ext, pT.pubs)], [], 600_000); await sync(A, B);
    check("on chain: a hidden transfer proven with the rehearsal transact key executes (B holds 40, A 60; the chain saw two nullifiers and two commitments)", B.balance(USDC) === lib.units(40, 6) && A.balance(USDC) === lib.units(60, 6));
    // the legacy withdraw circuit with its rehearsal key
    const mint = await lib.createMint(conn, payer, 6); const ata = await lib.fund(conn, payer, mint, payer.publicKey, lib.units(1000, 6)); const pool = V.poolPda(mint);
    await V.send([await V.initPoolIx(payer.publicKey, mint, 1n, payer.publicKey)]);
    const note = S.newNote(); const dsig = await V.send([await V.depositIx(payer.publicKey, mint, lib.units(100, 6), note.precommitment)]);
    const dev2 = (await V.events(dsig)).find((e) => e.name === "Deposited"); Object.assign(note, { value: dev2.value.toString(), label: dev2.label.toString(), index: Number(dev2.index) });
    const labels = [BigInt(note.label)]; await V.send([V.updateAspRootIx(payer.publicKey, pool, S.merklePath(labels, 0, S.ASP_DEPTH).root, "rehearsal")]);
    const { leaves } = await V.readTree(pool); const data = Buffer.from("rehearsal action"); const ctx = S.contextOf(payer.publicKey, data, pool);
    const w = S.withdrawInput({ note, withdrawnValue: lib.units(40, 6), context: ctx, leaves, labels });
    const { proof, publicSignals } = await L.snarkjs.groth16.fullProve(w.input, L.WASM, path.join(OUT, "zk/keys/withdraw_final.zkey")); await L.terminateCurves(); const prR = S.packProof(proof, publicSignals);
    await V.send([V.postWithdrawalIx(payer.publicKey, pool, prR.proof, prR.pubs, payer.publicKey)], [], 1_400_000);
    const b0 = await V.tokenBalance(mint, payer.publicKey); await V.send([await V.withdrawIx(payer.publicKey, pool, prR.pubs[1], ata, data)], [], 400_000);
    check("on chain: the legacy withdraw circuit's rehearsal proof verifies (post_withdrawal) and executes (40 out)", (await V.tokenBalance(mint, payer.publicKey)) - b0 === lib.units(40, 6));
    // Phase 3: a full sealed batch with the rehearsal swap, claim (and transact) keys
    console.log("  a full sealed batch with the rehearsal keys...", lap());
    const keysOf = (n) => ({ wasm: path.join(ROOT, `zk/build/${n}.wasm`), zkey: path.join(OUT, `zk/keys/${n}_final.zkey`) });
    const proveR = (n) => async (input) => { const r = await PR.proveCircuit(n, input, keysOf(n)); await L.terminateCurves(); return r; };
    const { runFullBatch } = require(path.join(ROOT, "tests/sealed-batch.js"));
    const fb = await runFullBatch({ V, conn, payer, postman, relayer, T, dep, units: lib.units, check, log: (m) => console.log("    " + m, lap()),
      prove: { transact: proveR("transact"), swap: proveR("swap"), claim: proveR("claim") }, devSwap: async (input) => { const r = await PR.proveSwap(input); await L.terminateCurves(); return r; } });
    check("snarkjs: the rehearsal swap and claim keys are not the dev keys (different delta)", ["swap", "claim"].every((n) => JSON.stringify(vk(OUT, n).vk_delta_2) !== JSON.stringify(vk(ROOT, n).vk_delta_2)), `batch totals ${fb.totals.join(" / ")}`);
    await new Promise((r) => { val.once("exit", r); val.kill(); setTimeout(r, 8000); }); val = null; fs.rmSync(vdir, { recursive: true, force: true }); void dep;
  } catch (e) { console.error("\nREHEARSAL CRASHED:", e); fail++; }
  finally { if (srv) srv.close(); if (val) val.kill(); }
  const after = snapshot();
  check("the repo's keys, vkey*.rs, site zkeys and target/deploy are untouched; no ceremony/TRANSCRIPT.md was written", JSON.stringify(before) === JSON.stringify(after));
  const result = { rehearsal: true, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), circuits: NAMES, ptau: { file: path.basename(ptau || ""), blake2b: ptau ? L.blake2bFile(ptau) : null }, passed: pass, failed: fail, checks: results,
    transcript: fs.existsSync(path.join(OUT, "ceremony/transcript.json")) ? "ceremony/TRANSCRIPT.md" : null };
  if (fs.existsSync(OUT)) L.writeJson(path.join(OUT, "RESULT.json"), result);
  console.log(`\n${pass} passed, ${fail} failed  (${lap()})  output: ${OUT}`);
  process.exit(fail ? 1 : 0);
})();
