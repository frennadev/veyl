// Shared by deploy.js, the tests, the e2e run and the demo: start a local validator, deploy the three programs, create the
// private pools, the bin pools, the entry and its vaults, and an address lookup table for the relayer.
'use strict';
const { spawn, execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { Veyl, Q, be32, DEFAULT_FEE_TIERS } = require('../sdk/veyl.js'); require('../sdk/shield.js'); // adds the Phase 2 instructions to Veyl
const ROOT = path.join(__dirname, '..'); const BIN = process.env.SOLANA_BIN || '/opt/solana/bin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readKey = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f))));
const programKey = (n) => readKey(path.join(ROOT, 'target/deploy/' + n + '-keypair.json'));
const tool = (n) => (fs.existsSync(path.join(BIN, n)) ? path.join(BIN, n) : n);
const PROGRAMS = ['veyl_pool', 'veyl_bin', 'veyl_entry'];
const programIds = () => ({ pool: programKey('veyl_pool').publicKey, bin: programKey('veyl_bin').publicKey, entry: programKey('veyl_entry').publicKey });

/// Token set and pools (same shape as the EVM deploy script; SOL stands in for ETH). Every mint is a config value:
/// local runs create mocks, devnet creates mocks too, mainnet takes the real mints from config/mainnet.json.
const TOKENS = [
  { sym: 'SOL', decimals: 9, minDeposit: 0.0005, price: 150 },
  { sym: 'USDC', decimals: 6, minDeposit: 1, price: 1 },
  { sym: 'USDT', decimals: 6, minDeposit: 1, price: 1 },
  { sym: 'JUP', decimals: 6, minDeposit: 1, price: 0.45 },
  { sym: 'BONK', decimals: 5, minDeposit: 50_000, price: 0.0000125 },
  // more devnet pairs; these prices are only fallbacks: the devnet launcher writes the day's market prices into config/devnet.json
  { sym: 'WIF', decimals: 6, minDeposit: 1, price: 1.5 },
  { sym: 'JTO', decimals: 9, minDeposit: 0.5, price: 2.5 },
  { sym: 'PYTH', decimals: 6, minDeposit: 5, price: 0.15 },
  { sym: 'RAY', decimals: 6, minDeposit: 0.5, price: 2.5 },
];
/// Every bin pool sits at one of the factory's fee tiers (bin step -> base fee in pips + variable fee control): the owner's
/// list, which config/<network>.json "feeTiers" repeats and the deploy lists in this order. A curated pool's baseFee/vfc
/// must equal its bin step's tier (deployAll refuses otherwise).
const FEE_TIERS = DEFAULT_FEE_TIERS;
const BIN_POOLS = [
  { id: 'sol-usdc', x: 'SOL', y: 'USDC', binStep: 10, baseFee: 500, vfc: 10_000, price: 150 },
  { id: 'sol-usdt', x: 'SOL', y: 'USDT', binStep: 10, baseFee: 500, vfc: 10_000, price: 149.9 },
  { id: 'jup-sol', x: 'JUP', y: 'SOL', binStep: 20, baseFee: 2_500, vfc: 10_000, price: 0.45 / 150 },
  { id: 'bonk-sol', x: 'BONK', y: 'SOL', binStep: 50, baseFee: 5_000, vfc: 1_600, price: 0.0000125 / 150 },
  { id: 'usdt-usdc', x: 'USDT', y: 'USDC', binStep: 1, baseFee: 100, vfc: 10_000, price: 0.9998 },
  { id: 'jup-usdc', x: 'JUP', y: 'USDC', binStep: 20, baseFee: 2_500, vfc: 10_000, price: 0.45 },
  { id: 'bonk-usdc', x: 'BONK', y: 'USDC', binStep: 50, baseFee: 5_000, vfc: 1_600, price: 0.0000125 },
  { id: 'wif-sol', x: 'WIF', y: 'SOL', binStep: 50, baseFee: 5_000, vfc: 1_600, price: 1.5 / 150 },
  { id: 'wif-usdc', x: 'WIF', y: 'USDC', binStep: 50, baseFee: 5_000, vfc: 1_600, price: 1.5 },
  { id: 'jto-sol', x: 'JTO', y: 'SOL', binStep: 20, baseFee: 2_500, vfc: 10_000, price: 2.5 / 150 },
  { id: 'pyth-usdc', x: 'PYTH', y: 'USDC', binStep: 20, baseFee: 2_500, vfc: 10_000, price: 0.15 },
  { id: 'ray-sol', x: 'RAY', y: 'SOL', binStep: 20, baseFee: 2_500, vfc: 10_000, price: 2.5 / 150 },
];
/// The built-in set (before the catalog is merged in): what CORE_ONLY=1 ./VEYL-DEVNET.command deploys and the faucet's basket.
const BUILTIN_TOKENS = TOKENS.map((t) => t.sym), BUILTIN_POOLS = BIN_POOLS.map((b) => b.id);
// Every major Meteora pair (config/catalog.json), mirrored on devnet; priced at launch by scripts/price-catalog.js.
try { const C = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/catalog.json'), 'utf8'));
  for (const t of C.tokens || []) if (!TOKENS.some((x) => x.sym === t.sym)) TOKENS.push({ sym: t.sym, decimals: t.decimals, minDeposit: t.minDeposit, price: t.price });
  for (const b of C.binPools || []) if (!BIN_POOLS.some((x) => x.id === b.id)) BIN_POOLS.push({ id: b.id, x: b.x, y: b.y, binStep: b.binStep, baseFee: b.baseFee, vfc: b.vfc, price: b.price });
} catch { /* no catalog: the built-in pools only */ }
const units = (n, decimals) => BigInt(Math.round(Number(n) * 10 ** decimals));
/// 128.128 price of tokenY-raw per tokenX-raw from a human price (Y per X) and the two decimals.
const priceQ = (human, decX, decY) => { const scaled = Number(human) * 10 ** (decY - decX); const [i, f = ''] = scaled.toExponential(15).split('e'); const m = BigInt(Math.round(Number(i) * 1e15)); const e = Number(f) - 15; return e >= 0 ? m * 10n ** BigInt(e) * Q : (m * Q) / 10n ** BigInt(-e); };

// RPC 8933 (websocket 8934). The brief assigned 8913, but a test validator always takes rpc+1 for pubsub, and 8914 is a sibling
// project's RPC port, so the two could not run side by side.
const RPC_PORT = Number(process.env.RPC_PORT || 8933);
async function startValidator(dir, payer, port = RPC_PORT) {
  const args = ['-r', '-q', '-l', path.join(dir, 'ledger'), '--mint', payer.publicKey.toBase58(), '--rpc-port', String(port), '--faucet-port', String(port + 1000), '--limit-ledger-size', '20000000'];
  // the default keeps 10,000 shreds: long runs (the Phase 3 suite) lost the shielded tree's early history, which clients rebuild from transactions
  if (port !== 8899) args.push('--gossip-port', String(port + 3000), '--dynamic-port-range', `${port + 3001}-${port + 3030}`); // +3000: sibling projects on 8911..8914 use +2000 ranges that overlap
  if (process.env.VALIDATOR_BIND_ADDRESS) args.push('--bind-address', process.env.VALIDATOR_BIND_ADDRESS); // 0.0.0.0 inside docker-compose
  const val = spawn(tool('solana-test-validator'), args, { stdio: 'ignore' }); let died = false; val.on('exit', (c) => { died = true; val.exitCode_ = c; });
  const rpc = 'http://127.0.0.1:' + port; const conn = new Connection(rpc, 'confirmed');
  for (let i = 0; i < 240; i++) { if (died) throw new Error('solana-test-validator exited with ' + val.exitCode_ + ' (see ' + path.join(dir, 'ledger/validator.log') + ')'); try { await conn.getVersion(); if ((await conn.getBalance(payer.publicKey)) > 0) break; } catch {} await sleep(500); }
  await sleep(1000); return { val, rpc, conn };
}
/// A mock SPL mint with the payer as mint authority. Tests and devnet only; mainnet uses the real mints.
async function createMint(conn, payer, decimals = 6, tokenProgram = spl.TOKEN_PROGRAM_ID, keypair = undefined) { return spl.createMint(conn, payer, payer.publicKey, null, decimals, keypair, { commitment: 'confirmed' }, tokenProgram); }
/// Puts `amount` of `mint` in `owner`'s token account: minted for a mock mint (the payer is its authority); for native SOL
/// (a devnet deployment on real SOL), the payer's SOL is wrapped into it instead.
async function fund(conn, payer, mint, owner, amount, tokenProgram = spl.TOKEN_PROGRAM_ID) {
  const ata = await spl.getOrCreateAssociatedTokenAccount(conn, payer, mint, owner, false, 'confirmed', { commitment: 'confirmed' }, tokenProgram);
  if (amount > 0n && new PublicKey(mint).equals(spl.NATIVE_MINT)) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata.address, lamports: amount }), spl.createSyncNativeInstruction(ata.address));
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  } else if (amount > 0n) await spl.mintTo(conn, payer, mint, ata.address, payer, amount, [], { commitment: 'confirmed' }, tokenProgram);
  return ata.address;
}
async function deployPrograms(rpc, payerFile) {
  for (const p of PROGRAMS) execFileSync(tool('solana'), ['program', 'deploy', '-u', rpc, '-k', payerFile, '--program-id', path.join(ROOT, 'target/deploy/' + p + '-keypair.json'), path.join(ROOT, 'target/deploy/' + p + '.so')], { stdio: ['ignore', 'ignore', 'inherit'] });
  await sleep(1500);
}
/// Deploy (or upgrade) the programs, then create everything that is missing: private pools, the factory + bin pools,
/// the entry + vaults, a lookup table. `mints` = {SYM: address} to reuse existing mints (else mocks are created).
/// Idempotent: everything that already exists on chain is skipped (and reported through `log`). `existing` = an earlier
/// deploy.<network>.json, whose mints and lookup table are reused when they still exist. `programs` overrides the IDs read
/// from target/deploy (deploy.js passes the keypairs it actually deployed).
/// The core set the local validator and the tests deploy by default (config/local.json); devnet adds the rest via config/devnet.json.
const CORE_TOKENS = TOKENS.filter((t) => ['SOL', 'USDC', 'USDT', 'JUP', 'BONK'].includes(t.sym));
const CORE_POOLS = BIN_POOLS.filter((b) => ['sol-usdc', 'sol-usdt', 'jup-sol', 'bonk-sol', 'usdt-usdc'].includes(b.id));
async function deployAll({ rpc, payerFile, mints = {}, postman, relayer, network = 'local', deploy = true, tokens = CORE_TOKENS, binPools = CORE_POOLS, existing = null, programs = null, feeTiers = FEE_TIERS, bond = null, treasury = null, publicRpc = null, log = () => {} }) {
  const payer = readKey(payerFile); const conn = new Connection(rpc, 'confirmed');
  if (deploy) await deployPrograms(rpc, payerFile);
  const V = new Veyl({ connection: conn, programs: programs || programIds(), payer });
  const did = (what, created) => log((created ? 'created ' : 'skipped ') + what + (created ? '' : ' (already there)'));
  postman = new PublicKey(postman || payer.publicKey); relayer = new PublicKey(relayer || payer.publicKey);
  const T = {};
  const prior = (sym) => existing && existing.tokens && existing.tokens[sym] && existing.tokens[sym].mint;
  // veyl_bin wants every pair in canonical order (mint_x < mint_y): new mock mints get keypairs sorted so that, as far as
  // the pool list allows (a topological order of x before y), each pool's x mint sorts before its y mint
  const order = []; { const seen = new Set(); const visit = (sym, stack = new Set()) => { if (seen.has(sym) || stack.has(sym)) return; stack.add(sym); for (const b of binPools) if (b.y === sym) visit(b.x, stack); seen.add(sym); order.push(sym); };
    for (const t of tokens) visit(t.sym); }
  const kps = tokens.map(() => Keypair.generate()).sort((a, b) => Buffer.compare(a.publicKey.toBuffer(), b.publicKey.toBuffer())); const kpOf = (sym) => kps[order.indexOf(sym)];
  for (const t of tokens) {
    let mint;
    if (mints[t.sym]) mint = new PublicKey(mints[t.sym]);
    else if (prior(t.sym) && (await conn.getAccountInfo(new PublicKey(prior(t.sym))))) { mint = new PublicKey(prior(t.sym)); did('mock mint ' + t.sym, false); }
    else { mint = await createMint(conn, payer, t.decimals, spl.TOKEN_PROGRAM_ID, kpOf(t.sym)); did('mock mint ' + t.sym + ' ' + mint.toBase58(), true); }
    T[t.sym] = { ...t, mint, pool: V.poolPda(mint) };
  }
  // private pools (one per mint)
  for (const t of Object.values(T)) { const have = !!(await V.pool(t.pool)); if (!have) await V.send([await V.initPoolIx(payer.publicKey, t.mint, units(t.minDeposit, t.decimals), postman)]); did('private pool ' + t.sym, !have); }
  // factory + bin pools
  { const have = !!(await V.factory()); if (!have) await V.send([V.initFactoryIx(payer.publicKey)]); did('factory', !have); }
  // fee tiers: the configured list, in order (a tier cannot be edited once listed: a different one at the same bin step is
  // refused); every curated pool must sit at its bin step's tier (the factory authority lists those pools bond-free)
  for (const t of feeTiers) { const i = await V.tierIndex(t.binStep); if (i >= 0) { const f = (await V.factory()).tiers[i]; if (f.baseFee !== Number(t.baseFee) || f.vfc !== BigInt(t.vfc)) throw new Error('fee tier at bin step ' + t.binStep + ' is already ' + f.baseFee + '/' + f.vfc + ' on chain, config says ' + t.baseFee + '/' + t.vfc); continue; }
    await V.send([V.addFeeTierIx(payer.publicKey, t.binStep, t.baseFee, t.vfc)]); did('fee tier ' + t.binStep + '/' + t.baseFee, true); }
  for (const b of binPools) { const t = feeTiers.find((x) => x.binStep === b.binStep); if (!t || Number(t.baseFee) !== b.baseFee || BigInt(t.vfc) !== BigInt(b.vfc)) throw new Error('pool ' + b.id + ' (bin step ' + b.binStep + ', ' + b.baseFee + '/' + b.vfc + ') is not at a listed fee tier' + (t ? ' (' + t.baseFee + '/' + t.vfc + ')' : '')); }
  // listing bond (for pools anyone creates) and the treasury that receives forfeited bonds: config values, else the defaults
  { const f = await V.factory();
    if (bond && (f.bondLamports !== BigInt(bond.lamports) || f.bondLock !== BigInt(bond.lockSeconds))) { await V.send([V.setBondIx(payer.publicKey, BigInt(bond.lamports), BigInt(bond.lockSeconds))]); log('bond -> ' + Number(bond.lamports) / LAMPORTS_PER_SOL + ' SOL, lock ' + Number(bond.lockSeconds) / 86_400 + ' days'); }
    if (treasury && !f.treasury.equals(new PublicKey(treasury))) { await V.send([V.setTreasuryIx(payer.publicKey, new PublicKey(treasury))]); log('treasury -> ' + new PublicKey(treasury).toBase58()); } }
  const BP = [];
  for (let b of binPools) { let x = T[b.x], y = T[b.y]; let price = b.price;
    if (Buffer.compare(x.mint.toBuffer(), y.mint.toBuffer()) > 0) { [x, y] = [y, x]; price = 1 / price; b = { ...b, x: x.sym, y: y.sym, price }; }
    const pool = V.binPoolPda(x.mint, y.mint, b.binStep);
    const have = !!(await V.binPool(pool)); if (!have) await V.send([await V.createPoolIx(payer.publicKey, x.mint, y.mint, await V.tierIndex(b.binStep), priceQ(price, x.decimals, y.decimals), 0)]); did('bin pool ' + b.id, !have);
    BP.push({ ...b, address: pool, mintX: x.mint, mintY: y.mint }); }
  // entry + one vault per mint
  { const have = !!(await V.entry()); if (!have) await V.send([V.initEntryIx(payer.publicKey)]); did('entry', !have); }
  for (const t of Object.values(T)) { const have = !!(await conn.getAccountInfo(await V.entryVault(t.mint))); if (!have) await V.send([await V.initVaultIx(payer.publicKey, t.mint)]); did('entry vault ' + t.sym, !have); }
  // the relayer's fee token accounts (idempotent)
  for (const t of Object.values(T)) await fund(conn, payer, t.mint, relayer, 0n);
  // Phase 2: the shielded pool (one tree for every token; its postman admits deposits) and its vault for every mint
  { const have = !!(await V.shield()); if (!have) await V.send([V.initShieldIx(payer.publicKey, postman)]); did('shielded pool', !have); }
  for (const t of Object.values(T)) { const vault = V.shieldVault(t.mint, await V.tokenProgram(t.mint)); const have = !!(await conn.getAccountInfo(vault));
    if (!have) await V.send([spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vault, V.shieldPda(), t.mint, await V.tokenProgram(t.mint))]); did('shielded vault ' + t.sym, !have); }
  // lookup table with every static address the relayer's transactions touch
  const statics = [V.programs.pool, V.programs.bin, V.programs.entry, V.entryPda(), V.signerPda(), spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID, PublicKey.default, relayer];
  for (const t of Object.values(T)) { const p = await V.pool(t.pool); statics.push(t.mint, t.pool, p.vault, await V.entryVault(t.mint), V.ata(t.mint, relayer)); }
  for (const b of BP) { const p = await V.binPool(b.address); statics.push(b.address, p.vaultX, p.vaultY); for (const c of [-1, 0]) statics.push(V.binArrayPda(b.address, c), V.lpAccPda(b.address, c), V.sharesPda(b.address, V.shieldOwner(), V.signerPda(), c)); }
  statics.push(V.shieldPda(), V.shieldOwner(), V.poolEventAuthority(), spl.TOKEN_2022_PROGRAM_ID, require('@solana/web3.js').SystemProgram.programId); for (const t of Object.values(T)) statics.push(V.shieldVault(t.mint, await V.tokenProgram(t.mint)));
  // a table holds 256 addresses: the first takes the core accounts, more tables follow as the pools need them
  const priorLuts = existing ? [existing.lookupTable, ...(existing.lookupTables || [])].filter(Boolean) : [];
  const tables = await V.fillLookupTables(payer, statics, priorLuts); const table = tables[0]; V.lookupTable = table; V.lookupExtra = tables.slice(1);
  did('lookup tables ' + tables.length + ' (' + statics.length + ' addresses)', tables.length > priorLuts.length);
  const slot = await conn.getSlot('confirmed');
  const dep = { network, rpc: publicRpc || rpc, deployer: payer.publicKey.toBase58(), slot, programs: { pool: V.programs.pool.toBase58(), bin: V.programs.bin.toBase58(), entry: V.programs.entry.toBase58() }, postman: postman.toBase58(), relayer: relayer.toBase58(), lookupTable: table.toBase58(), lookupTables: tables.slice(1).map((t) => t.toBase58()),
    shield: V.shieldPda().toBase58(), shieldOwner: V.shieldOwner().toBase58(),
    tokens: Object.fromEntries(Object.values(T).map((t) => [t.sym, { mint: t.mint.toBase58(), decimals: t.decimals, pool: t.pool.toBase58(), minDeposit: t.minDeposit, price: t.price }])),
    binPools: BP.map((b) => ({ id: b.id, x: b.x, y: b.y, binStep: b.binStep, baseFee: b.baseFee, address: b.address.toBase58() })),
    feeTiers: await (async () => { const f = await V.factory(); return f.tiers.map((t) => { const c = feeTiers.find((x) => x.binStep === t.binStep) || {}; return { index: t.index, binStep: t.binStep, baseFee: t.baseFee, vfc: Number(t.vfc), enabled: t.enabled, label: c.label, category: c.category || (c.label ? c.label.split(' ')[0].toLowerCase() : undefined) }; }); })(),
    bond: await (async () => { const f = await V.factory(); return { lamports: f.bondLamports.toString(), lockSeconds: Number(f.bondLock), treasury: f.treasury.toBase58() }; })(), deployedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(ROOT, `deploy.${network}.json`), JSON.stringify(dep, null, 2));
  return { V, dep, conn, payer, T, BP };
}
module.exports = { ROOT, BIN, RPC_PORT, PROGRAMS, TOKENS, FEE_TIERS, BIN_POOLS, BUILTIN_TOKENS, BUILTIN_POOLS, CORE_TOKENS, CORE_POOLS, sleep, units, priceQ, readKey, programKey, programIds, startValidator, deployAll, deployPrograms, createMint, fund, tool, LAMPORTS_PER_SOL };
