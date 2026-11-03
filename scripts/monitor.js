#!/usr/bin/env node
// Balance and liveness alerts for the wallets Veyl's services spend from: the relayer (fees and rent of private actions),
// the postman (admissions) and each sealed-batch committee node (shares, settlements). Found from the chain and the
// relayer's /health, plus any extra address in WATCH. A wallet under its floor, or the relayer not answering, is alerted
// once when it happens and once when it recovers (watch mode), or on every run while it lasts (--once, for a cron job).
//
//   HELIUS_API_KEY=<key> RELAYER_URL=<relayer> ALERT_WEBHOOK_URL=<discord|slack webhook> node scripts/monitor.js --network mainnet
//   options: --once (one check, exit 1 if anything is wrong), --quiet (no table)
//   env: RPC_URL (else https://<network>.helius-rpc.com from HELIUS_API_KEY, else the config's public RPC); RELAYER_URL (else
//        the config's relayerUrl); WATCH="label=address[:minSol],..." extra wallets (e.g. deployer, fee authority);
//        MIN_RELAYER_SOL (default 0.5), MIN_POSTMAN_SOL (0.05), MIN_COMMITTEE_SOL (0.1); INTERVAL_MS (300000);
//        alerts: ALERT_WEBHOOK_URL (Discord or Slack incoming webhook) and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
// The RPC URL (it holds an API key) is never printed or sent in an alert.
'use strict';
const { PublicKey, Connection } = require('@solana/web3.js');
const N = require('./net.js');
const S = require('../sdk/veyl.js'); require('../sdk/shield.js'); require('../sdk/sealed.js'); const { Veyl } = S;

const args = N.parseArgs(); const once = args.rest.includes('--once'); const quiet = args.rest.includes('--quiet');
const env = process.env; const cfg = N.loadConfig(args.network); const dep = N.loadDeploy(args.network);
const real = (v) => (v && !N.isVerify(v) ? v : null);
const rpc = env.RPC_URL || (env.HELIUS_API_KEY ? `https://${args.network === 'mainnet' ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : real(cfg.rpc));
const relayerUrl = (env.RELAYER_URL || real(cfg.relayerUrl) || '').replace(/\/$/, '');
const floor = { relayer: Number(env.MIN_RELAYER_SOL || 0.2), postman: Number(env.MIN_POSTMAN_SOL || 0.05), committee: Number(env.MIN_COMMITTEE_SOL || 0.1) };
const hide = (s) => String(s).split(rpc || '\u0000').join('<rpc>').replace(/api-key=[^&\s"]+/g, 'api-key=…');

async function alert(text) { const msg = `Veyl ${args.network}: ${text}`; const sent = [];
  if (env.ALERT_WEBHOOK_URL) { const slack = /hooks\.slack\.com/.test(env.ALERT_WEBHOOK_URL);
    try { const r = await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slack ? { text: msg } : { content: msg }) }); sent.push('webhook ' + r.status); } catch (e) { sent.push('webhook failed: ' + e.message); } }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try { const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }) }); sent.push('telegram ' + r.status); } catch (e) { sent.push('telegram failed: ' + e.message); } }
  console.log(`[alert] ${msg}${sent.length ? '  (' + sent.join(', ') + ')' : '  (no ALERT_WEBHOOK_URL / TELEGRAM_* set: printed only)'}`); }

/// The wallets to watch: [{ label, address, min }], from the chain (postman, committee nodes), the relayer's /health
/// (its address) and WATCH. Also the relayer's liveness.
async function targets(V) { const out = []; let relayerUp = null, relayerNote = '';
  if (relayerUrl) { try { const h = await (await fetch(relayerUrl + '/health', { signal: AbortSignal.timeout(10_000) })).json(); relayerUp = !!h.ok; if (h.relayer) out.push({ label: 'relayer', address: h.relayer, min: floor.relayer }); } catch (e) { relayerUp = false; relayerNote = e.message; } }
  try { const s = await V.shield(); if (s) out.push({ label: 'postman', address: s.postman.toBase58(), min: floor.postman }); } catch {}
  try { const c = await V.committee(); if (c) c.nodes.forEach((n, i) => out.push({ label: `committee node ${i + 1}`, address: n.toBase58(), min: floor.committee })); } catch {}
  for (const w of (env.WATCH || '').split(',').map((x) => x.trim()).filter(Boolean)) { const m = w.match(/^([^=]+)=([1-9A-HJ-NP-Za-km-z]{32,44})(?::([\d.]+))?$/); if (!m) { console.error('WATCH entry ignored (label=address[:minSol]): ' + w); continue; } out.push({ label: m[1], address: m[2], min: m[3] ? Number(m[3]) : floor.relayer }); }
  const seen = new Set(); return { list: out.filter((t) => !seen.has(t.address) && seen.add(t.address)), relayerUp, relayerNote }; }

async function check(V, state) { const { list, relayerUp, relayerNote } = await targets(V); const problems = [];
  const bal = await V.conn.getMultipleAccountsInfo(list.map((t) => new PublicKey(t.address)), 'confirmed');
  const rows = list.map((t, i) => { const sol = (bal[i] ? bal[i].lamports : 0) / 1e9; const low = sol < t.min; if (low) problems.push({ key: 'low:' + t.address, text: `${t.label} ${t.address} has ${sol.toFixed(4)} SOL, under its ${t.min} SOL floor. Top it up.` }); return { ...t, sol, low }; });
  if (relayerUrl && relayerUp === false) problems.push({ key: 'relayer-down', text: `the relayer at ${relayerUrl} is not answering /health (${hide(relayerNote) || 'not ok'}). Private actions are stopped.` });
  if (!quiet) { console.log(`${new Date().toISOString()} ${args.network}${relayerUrl ? `, relayer ${relayerUp ? 'up' : 'DOWN'}` : ', no RELAYER_URL'}`); for (const r of rows) console.log(`  ${r.low ? 'LOW ' : 'ok  '} ${r.label.padEnd(18)} ${r.sol.toFixed(4).padStart(10)} SOL  (floor ${r.min})  ${r.address}`); }
  const now = new Set(problems.map((p) => p.key));
  for (const p of problems) if (once || !state.has(p.key)) await alert(p.text);
  if (!once) for (const k of state) if (!now.has(k)) await alert(`recovered: ${k.startsWith('low:') ? 'wallet ' + k.slice(4) + ' is back above its floor' : 'the relayer answers again'}.`);
  return { problems, state: now }; }

(async () => {
  if (!rpc) { console.error('Set RPC_URL or HELIUS_API_KEY.'); process.exit(2); }
  const conn = new Connection(rpc, 'confirmed'); let g; try { g = await conn.getGenesisHash(); } catch (e) { console.error('RPC unreachable: ' + hide(e.message)); process.exit(2); }
  if (cfg.genesisHash && g !== cfg.genesisHash) { console.error(`This RPC is not ${args.network}: refusing.`); process.exit(2); }
  const programs = Object.fromEntries(Object.entries((dep && dep.programs) || cfg.programs || {}).filter(([, v]) => real(v)).map(([k, v]) => [k, new PublicKey(v)]));
  const V = new Veyl({ connection: conn, programs });
  if (once) { const r = await check(V, new Set()).catch((e) => { console.error(hide(e.message)); return { problems: [{}] }; }); process.exit(r.problems.length ? 1 : 0); }
  let state = new Set(); const every = Number(env.INTERVAL_MS || 300_000);
  console.log(`watching every ${every / 1000}s; alerts to ${[env.ALERT_WEBHOOK_URL && 'webhook', env.TELEGRAM_BOT_TOKEN && 'telegram'].filter(Boolean).join(' + ') || 'stdout only'}`);
  for (;;) { try { state = (await check(V, state)).state; } catch (e) { console.error('check failed: ' + hide(e.message)); } await new Promise((r) => setTimeout(r, every)); }
})();
