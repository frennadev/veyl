#!/usr/bin/env python3
"""One-off: rewrites the EVM site copy (copied from veyl3/web/site) for the Solana port. Design system, structure, nav,
headlines and buttons are untouched; only chain-specific words, figures and code excerpts change. Idempotent enough to
re-run after re-copying the EVM pages."""
import re, sys, pathlib
SITE = pathlib.Path(__file__).resolve().parent.parent / 'site'

GLOBAL = [
  ('veyl-engine.js', 'veyl-sol.js'),
  ('CFG.entrypoint', 'CFG.programs'),
  ('CFG&&CFG.entrypoint', 'CFG&&CFG.programs'),
  ('title="Veyl runs on Robinhood Chain testnet with test tokens"', 'title="Veyl runs on Solana devnet with mock tokens"'),
  ('Robinhood Chain testnet', 'Solana devnet'), ('Robinhood testnet', 'Solana devnet'), ('robinhood testnet rpc', 'devnet rpc'),
  ('Built on Robinhood Chain; not affiliated with Robinhood Markets, Inc.', 'Built on Solana; not affiliated with the Solana Foundation or Solana Labs.'),
  ('Robinhood Chain', 'Solana'),
  ('ETH–USDC', 'SOL–USDC'), ('ETH–USDe', 'SOL–USDT'), ('PONS–ETH', 'PONS–SOL'), ('CASHCAT–ETH', 'CASHCAT–SOL'), ('USDe–USDC', 'USDT–USDC'),
  ('eth-usdc', 'sol-usdc'), ('eth-usde', 'sol-usdt'), ('pons-eth', 'pons-sol'), ('cashcat-eth', 'cashcat-sol'), ('usde-usdc', 'usdt-usdc'),
  ('USDC → ETH → CASHCAT', 'USDC → SOL → CASHCAT'), ('USDC → USDe → ETH → CASHCAT', 'USDC → USDT → SOL → CASHCAT'), ('via ETH', 'via SOL'), ('via USDe → ETH', 'via USDT → SOL'),
  ('WETH, USDC, USDe, CASHCAT, PONS', 'SOL, USDC, USDT, CASHCAT, PONS'),
  ('2,662.70 USDC', '150.00 USDC'), ('2,662.10 USDe', '149.90 USDT'), ('0.00033049 ETH', '0.0058667 SOL'), ('0.00005998 ETH', '0.0010647 SOL'),
  ('0.0005 ETH', '0.0005 SOL'), ('1 USDe', '1 USDT'), ('500 USDC → about 0.19 ETH', '500 USDC → about 3.33 SOL'), ('The ETH lands in a new', 'The SOL lands in a new'),
  ('0.05 ETH + 100 USDC', '0.5 SOL + 100 USDC'), ('hold 5 ETH each', 'hold 5 SOL each'), ('20,000 USDC each', '20,000 USDC each'),
  ('USDe', 'USDT'),
  ('0x7c3f…a19e', '7cFq…A19e'), ('0x2a91…e4c7', '2a9Q…E4c7'), ('0x51b2…0c44', '5Lb2…C44q'), ('0xe90d…77b1', 'E9oD…77b1'),
  ('VeylPrivacyPool(USDC).deposit', 'veyl_pool.deposit (USDC)'), ('VeylEntrypoint.relay', 'veyl_entry.relay'), ('VeylEntrypoint.privateSwap', 'veyl_entry.private_swap'),
  ('VeylEntrypoint.privateAdd', 'veyl_entry.private_add'), ('VeylEntrypoint.privateRemove', 'veyl_entry.private_remove'), ('updateAspRoot</span>', 'update_asp_root</span>'),
  ('in calldata or in logs', 'in instruction data or in logs'),
  ('pays the gas', 'pays the network fee'), ('paying gas', 'paying the network fee'), ("drain the relayer's gas", "drain the relayer's SOL"), ('burn relayer gas', 'burn relayer SOL'),
  ('A 0.1% relayer fee covers gas.', 'A 0.05% relayer fee covers the network fee.'), ('Relayer · 0.1%', 'Relayer · 0.05%'), ('≈ 0.000006 ETH', '≈ 0.000005 SOL'),
  ('What do I pay gas in?</summary><p>ETH, like everything on Solana. For private actions the relayer pays the network fee', 'What do I pay fees in?</summary><p>SOL, like everything on Solana. For private actions the relayer pays the fee'),
  ('Fund the relayer address it prints with a little ETH.', 'Fund the relayer address it prints with a little SOL.'),
  ('Gas on Solana is paid in ETH; for private actions the relayer pays it and recovers the cost through its fee.', 'Fees on Solana are paid in SOL; for private actions the relayer pays them and recovers the cost through its fee.'),
  ('About 220k gas.', 'About 120k compute units.'),
  ('keccak(w, chainid, pool)', 'sha256(processor, action bytes, pool)'), ('the chain id and its own address', 'the processor, the action bytes and the pool address'),
  ('from the withdrawal struct, the chain id and its own address', 'from the processor, the action bytes and the pool address'),
  ("<span class=\"mono\">zk/ptau/contribution.log</span> and <span class=\"mono\">zk/keys/contribution.log</span>", "<span class=\"mono\">zk/keys/contribution.log</span>"),
  ('contracts/src/VeylPrivacyPool.sol', 'programs/veyl_pool/src/lib.rs'), ('contracts/src/VeylBinPool.sol', 'programs/veyl_bin/src/lib.rs'), ('contracts/src/lib/Types.sol', 'programs/veyl_entry/src/lib.rs'),
  ('contracts/test/Private.t.sol', 'tests/run.js'), ('contracts/script/Deploy.s.sol', 'scripts/lib.js'), ('Deploy.s.sol', 'scripts/lib.js'), ('VeylBinPool.sol', 'programs/veyl_bin'), ('VeylEntrypoint.sol', 'veyl_entry'),
  ('contracts/src</span>', 'programs/</span>'), ('web/engine.src.js', 'site/sol-entry.js'),
  ('burns 1,000 shares to a dead address', 'locks 1,000 shares in the bin for good'), ('burned on first mint', 'locked on first mint'),
  ('Foundry test run', 'local-validator test run (<span class="mono">npm test</span>)'), ('43 tests', '95 tests'), ('all 43 Foundry tests', 'all 95 tests'),
  ('zk/scripts/prove.js', 'sdk/prover.js'), ('anvil + deploy + relayer + the real app in Chromium', 'local validator + deploy + relayer + the real app in Chromium'),
  ('web/site/', 'site/'), ('port 8787', 'port 8843'), ('sdk/denylist.json', 'relayer/denylist.json'),
  ('They add the chain in their wallet, connect and deposit.', 'They switch their wallet to devnet, connect and deposit.'),
  ('Only plain ERC-20s are listed.', 'Only plain SPL mints are listed.'), ('so fee-on-transfer tokens would break the note value', 'so a Token-2022 mint with a transfer fee would make the note smaller than the amount sent'),
  ('<li><b>Reentrancy guards</b> on every state-changing entry point.</li>', '<li><b>No re-entry.</b> The Solana runtime refuses a program re-entering itself through CPI, and every token movement is a checked SPL transfer.</li>'),
  ('Solidity 0.8.24, built with Foundry.', 'Rust, Anchor 0.31, built with cargo-build-sbf.'),
  ('You need Node 18 or newer and Foundry.', 'You need Node 20 or newer and the Solana CLI.'),
  ('Create a fresh wallet and fund it from a Solana devnet faucet.', 'Create a fresh wallet and fund it from the Solana devnet faucet.'),
  ('Paste the RPC URL and the deployer key.', 'It makes a throwaway devnet key and waits for faucet SOL.'),
  ('Test tokens on Solana devnet.', 'Mock tokens on Solana devnet.'), ('with test tokens', 'with mock tokens'),
  ('The contracts are new and unaudited.', 'The programs are new and unaudited.'), ('<h3>Smart contract</h3>', '<h3>Program code</h3>'),
  ('Nothing goes to mainnet before an independent audit.', 'Nothing goes to mainnet before an independent audit and a multi-party key ceremony.'),
  ('<h2>The contracts</h2>', '<h2>The programs</h2>'), ('<a href="#contracts">The contracts</a>', '<a href="#contracts">The programs</a>'), ('<span>contracts, each with one job</span>', '<span>programs, each with one job</span>'),
  ('real proofs, verified by the contract', 'real proofs, verified by the program'), ('in the contract or a fi', 'in the program or a fi'), ('is a constant in the contract', 'is a constant in the program'),
  ('The contract stores', 'The program stores'), ('the contract keeps', 'the program keeps'), ('The contract computes', 'The program computes'), ('The contract reads them', 'The program reads them'),
  ('There is no protocol fee in the contracts.', 'There is no protocol fee in the programs.'), ('Not in the contracts', 'Not in the programs'), ('the 1% cap is in the contract', 'the 1% cap is in the program'),
  ('both have hard caps in the contracts.', 'both have hard caps in the programs.'), ('<span>fee cap, in the contract</span>', '<span>fee cap, in the program</span>'),
  ("computed from the contract's fee formula", "computed from the program's fee formula"), ('read from each pool contract just now', 'read from each pool account just now'),
  ('A tag the contract gives each deposit', 'A tag the program gives each deposit'), ('Called the postman in the contracts.', 'Called the postman in the programs.'),
  ('deploys the contracts to Solana devnet', 'deploys the programs to Solana devnet'), ('External audit</b> of contracts and circuit', 'External audit</b> of programs and circuit'),
  ('in the contracts themselves', 'in the programs themselves'), ('The relayer pays the gas and calls the entrypoint.', 'The relayer pays the fee and calls the entry program.'),
  ('<b>7</b><span>programs, each with one job</span>', '<b>3</b><span>programs, each with one job</span>'),
  ('an unspent deposit back to the address that made it', 'an unspent deposit back to the wallet that made it'),
  ("to the depositor's own address", "to the depositor's own wallet"),
  ('Gas and tests', 'Compute units and tests'), ('<th class="num">Gas</th>', '<th class="num">Compute units</th>'),
]

GAS_TABLE_OLD = re.compile(r'<tr><td>deposit</td><td class="num">~1\.5M</td></tr>.*?<tr><td>proof check alone</td><td class="num">~0\.22M</td></tr>', re.S)
GAS_TABLE_NEW = '''<tr><td>deposit</td><td class="num">~60k</td></tr>
          <tr><td>post_withdrawal (proof check)</td><td class="num">~120k</td></tr>
          <tr><td>withdraw (tree insert + payout)</td><td class="num">~50k</td></tr>
          <tr><td>private_swap, one hop</td><td class="num">~250k</td></tr>
          <tr><td>private_add, two legs</td><td class="num">~250k</td></tr>
          <tr><td>public swap</td><td class="num">~80k</td></tr>'''

DEPOSIT_FIG_OLD = re.compile(r'<pre><code>label = uint256\(keccak256\(.*?_insert\(commitment\);</code></pre>', re.S)
DEPOSIT_FIG_NEW = '''<pre><code>p.deposit_nonce += 1;
<span class="k">let</span> label = label_of(&amp;pool_key, p.deposit_nonce);   <span class="c">// sha256(pool, nonce) as a field element</span>
<span class="k">let</span> commitment = poseidon3(&amp;u64_to_field(value), &amp;label, &amp;precommitment)?;
<span class="k">let</span> (index, _root) = p.insert(&amp;commitment)?;
d.beneficiary = beneficiary; d.label = label;
d.commitment = commitment;              <span class="c">// the DepositRecord PDA, kept for ragequit</span></code></pre>'''

WITHDRAW_FIG_OLD = re.compile(r'<pre><code><span class="k">function</span> <span class="f">context</span>.*?emit</span> Withdrawn\(msg\.sender, value, p\.pub\[1\], p\.pub\[0\], index\);\n}</code></pre>', re.S)
WITHDRAW_FIG_NEW = '''<pre><code><span class="c">// step 1: post_withdrawal(proof, pubs, processor, ttl) — verify and park under the nullifier PDA</span>
<span class="hl">require!(p.is_known_root(&amp;pubs[3]),      VeylError::UnknownStateRoot);</span>
<span class="hl">require!(p.is_known_asp_root(&amp;pubs[4]),  VeylError::StaleAspRoot);</span>
<span class="hl">require!(verifier::verify(&amp;proof, &amp;pubs), VeylError::BadProof);</span>
<span class="c">// the PDA ["null", pool, pubs[1]] is created here: a second post is AlreadySpent</span>

<span class="c">// step 2: withdraw(data), called by the processor (the entry program's signer PDA)</span>
<span class="hl">require!(s.status == SPEND_POSTED,                 VeylError::AlreadySpent);</span>
<span class="hl">require_keys_eq!(s.processor, processor.key(),     VeylError::NotProcessor);</span>
<span class="hl">require!(context_of(&amp;processor.key(), &amp;data, &amp;pool_key) == s.context, VeylError::BadContext);</span>
<span class="k">let</span> (index, _) = p.insert(&amp;s.new_commitment)?;
s.status = SPEND_SPENT;
transfer_checked(vault → processor_token, s.value)?;
<span class="k">emit!</span>(Withdrawn { processor, value, nullifier_hash, new_commitment, index });</code></pre>'''

FEE_FIG_OLD = re.compile(r'<pre><code>uint256 <span class="k">public constant</span> PIPS.*?<span class="k">if</span> \(fee &gt; MAX_FEE\) fee = MAX_FEE;\n}</code></pre>', re.S)
FEE_FIG_NEW = '''<pre><code><span class="k">pub const</span> PIPS: u128          = 1_000_000; <span class="c">// 100%</span>
<span class="k">pub const</span> MAX_FEE: u128       = 100_000;   <span class="c">// 10%</span>
<span class="k">pub const</span> FILTER_PERIOD: i64  = 30;        <span class="c">// seconds</span>
<span class="k">pub const</span> DECAY_PERIOD: i64   = 600;       <span class="c">// seconds</span>
<span class="k">pub const</span> REDUCTION_BPS: u128 = 5_000;     <span class="c">// keep half</span>
<span class="k">pub const</span> MAX_VOL_ACC: u128   = 350_000;
<span class="k">pub const</span> MAX_STEPS: usize    = 256;       <span class="c">// bins per swap</span>
<span class="k">pub const</span> MIN_LIQUIDITY: u128 = 1_000;     <span class="c">// locked on first mint</span>

<span class="k">pub fn</span> <span class="f">acc</span>(&amp;self, r: u128, iref: i32, id: i32) -&gt; u128 {
    <span class="k">let</span> dist = (iref <span class="k">as</span> i64 - id <span class="k">as</span> i64).unsigned_abs() <span class="k">as</span> u128;
    (r + dist * 10_000).min(MAX_VOL_ACC)
}

<span class="k">pub fn</span> <span class="f">fee</span>(&amp;self, va: u128) -&gt; u128 {
    <span class="k">let</span> v = va * self.bin_step <span class="k">as</span> u128;
<span class="hl">    (self.base_fee <span class="k">as</span> u128 + (v * v * self.variable_fee_control <span class="k">as</span> u128) / 1_000_000_000_000).min(MAX_FEE)</span>
}</code></pre>'''

TYPES_FIG_OLD = re.compile(r'<pre><code><span class="c">/// One hop through a Veyl bin pool\.</span>.*?Hop\[\] hops; }</code></pre>', re.S)
TYPES_FIG_NEW = '''<pre><code><span class="c">/// One hop through a Veyl bin pool (n_arrays = bin-array accounts that follow it).</span>
<span class="k">pub struct</span> Hop   { pool: Pubkey, x_for_y: bool, n_arrays: u8 }

<span class="c">/// A route: an input amount sent down a sequence of hops.</span>
<span class="k">pub struct</span> Route { amount_in: u64, hops: Vec&lt;Hop&gt; }</code></pre>'''

CHECKS_OLD = re.compile(r'<li><b>166</b>.*?<li><b>173</b><span>Only then: record the nullifier.*?</span></li>', re.S)
CHECKS_NEW = '''<li><b>post</b><span><strong>UnknownStateRoot.</strong> The state root must be one the tree has had. A history of 128 recent roots means a deposit landing while you prove does not break your proof.</span></li>
        <li><b>post</b><span><strong>StaleAspRoot.</strong> The approved-set root must be one of the last 16 published. <code>reset_asp_roots</code> wipes that history in an emergency, and <code>withdraw</code> checks it again at execution.</span></li>
        <li><b>post</b><span><strong>BadProof.</strong> The Groth16 verifier (groth16-solana over the alt_bn128 syscalls, with the key exported from the unchanged proving key) checks the proof against all six public signals. About 120k compute units.</span></li>
        <li><b>post</b><span><strong>AlreadySpent.</strong> The nullifier PDA <span class="mono">["null", pool, nullifierHash]</span> is created by the post. It can exist only once, and ragequit creates the same PDA, so a note cannot leave both ways.</span></li>
        <li><b>withdraw</b><span><strong>NotProcessor.</strong> Only the processor named at post time may execute. In practice that is <code>veyl_entry</code>'s signer PDA, which then relays, swaps or adds liquidity as the action bytes say.</span></li>
        <li><b>withdraw</b><span><strong>BadContext.</strong> <span class="mono">sha256(processor, action bytes, pool)</span> must equal the proof's sixth public signal. The recipient, fee, route, deadline and action type are all inside those bytes, so none of them can be altered after proving.</span></li>
        <li><b>then</b><span>Insert the change commitment, pay <code>withdrawnValue</code> to the processor's token account, mark the spend executed and emit. The event names the processor, never a user. A posted spend that is never executed can be cancelled by its poster, or by anyone after it expires; the note stays unspent.</span></li>'''

OPEN_OLD = re.compile(r'<div><span class="sev high">High</span><p><b>The browser engine does not save the change note.*?<div><span class="sev med">Medium</span><p>Zero-value withdrawals.*?not yet wired into the app\.</p></div>', re.S)
OPEN_NEW = '''<div><span class="sev med">Fixed here</span><p><b>Change notes are saved before anything is sent.</b> The EVM engine saved the change note only after the relayer answered; this engine writes it to the device first and never deletes an unresolved note.</p></div>
      <div><span class="sev med">Fixed here</span><p><b>No pool registry an owner could re-point.</b> Private pools are derived addresses (<span class="mono">["pool", mint]</span>), so there is no <code>registerPool</code> and no owner key in the entry program. The approved-set publisher is still one key; it needs a multisig before mainnet.</p></div>
      <div><span class="sev med">Medium</span><p>Zero-value withdrawals are refused at post time (fixed here). Still open: <code>private_remove</code> fails when one side is below the minimum deposit and the proceeds go back into the private balance; <code>private_add</code> has no slippage protection, and the composition fee can be pushed to 10%; screening is bypassed by one hop, and the publisher can freeze private exits. A relayer that posts a proof and never executes it can hold that note for up to an hour (<code>cancel_post</code> frees it).</p></div>'''

RUN_BLOCK_OLD = re.compile(r'<pre><code><span class="c"># deploy to testnet with test tokens</span>.*?cd contracts &amp;&amp; forge test</code></pre>', re.S)
RUN_BLOCK_NEW = '''<pre><code><span class="c"># local validator, programs, pools, relayer + publisher, and the app</span>
./GO-LIVE.command

<span class="c"># the same on Solana devnet, with mock mints (a throwaway deployer key is made for you)</span>
NET=devnet ./GO-LIVE.command

<span class="c"># all 95 tests against a local validator, including real Groth16 proofs verified on-chain</span>
npm test</code></pre>'''

DOCS_TESTS_OLD = re.compile(r'<pre><code>cd contracts &amp;&amp; forge test.*?the real app in Chromium</span></code></pre>', re.S)
DOCS_TESTS_NEW = '''<pre><code>npm test          <span class="c"># 95 tests on a local validator, real proofs verified on-chain</span>
npm run e2e       <span class="c"># local validator + deploy + relayer + the real app in Chromium</span></code></pre>'''

PROGRAMS_LIST_OLD = re.compile(r'<div class="def"><h3>VeylBinPool</h3>.*?<div class="def"><h3>Poseidon hashers</h3>.*?</p></div>', re.S)
PROGRAMS_LIST_NEW = '''<div class="def"><h3>veyl_bin</h3><p><span class="tag off">Trading</span> The bin pools and their factory. One pool account per pair, bins in 128-wide arrays, shares per owner, swaps, fees and the volatility accumulator.</p></div>
        <div class="def"><h3>veyl_pool</h3><p><span class="tag off">Privacy</span> The private balance for one mint. Deposits, the Poseidon note tree (syscall), the on-chain Groth16 check, nullifier PDAs, the approved set and the public exit.</p></div>
        <div class="def"><h3>veyl_entry</h3><p><span class="tag off">Privacy</span> What relayers call, and the public router. Relay, private swap, private add and private remove (ed25519-signed), each bound to a proof or a signature.</p></div>
        <div class="def"><h3>withdraw.circom</h3><p><span class="tag off">Proofs</span> The circuit, proving key and verifying key, unchanged from the EVM build. The verifying key's curve points are compiled into <span class="mono">veyl_pool</span>.</p></div>'''

PER_FILE = {
  'index.html': [
    ('P0=2662.70, BASE=0.0005;                 /* SOL–USDC start price and base fee from scripts/lib.js */', 'P0=150, BASE=0.0005;                     /* SOL–USDC start price and base fee from scripts/lib.js */'),
    ("var a='ETH', b='USDC'", "var a='SOL', b='USDC'"), ("a==='ETH'", "a==='SOL'"),
    ('Live quotes need the testnet app.', 'Live quotes need the devnet app.'), ('Testnet swap preview', 'Devnet swap preview'), ("'Live testnet'", "'Live devnet'"), ("'Testnet unreachable'", "'Devnet unreachable'"),
    ('The testnet pool has no liquidity', 'The devnet pool has no liquidity'), ('The configured testnet RPC did not answer', 'The configured Solana RPC did not answer'), ("CFG.chainName||'the testnet'", "CFG.chainName||'Solana devnet'"),
    ('<h2>Run it on testnet</h2>', '<h2>Run it on devnet</h2>'),
    ('The app is static; the relayer and publisher are two small Node processes.', 'The app is static; the relayer and the approved-set publisher are one small Node process.'),
    ('after the deposit in step 1, the trader\'s address appears in 0 later transactions', 'after the deposit in step 1, the trader\'s wallet appears in 0 later transactions'),
  ],
  'liquidity.html': [
    ("'Testnet partly unreachable':'Read from '+(CFG.chainName||'the testnet')", "'Devnet partly unreachable':'Read from '+(CFG.chainName||'Solana devnet')"),
    ('Liquidity · testnet', 'Liquidity · devnet'), ('<th>On testnet</th>', '<th>On devnet</th>'), ("btn.textContent='No testnet config on this host'", "btn.textContent='No devnet config on this host'"),
    ('The RPC in veyl.config.js may be down', 'The Solana RPC in veyl.config.js may be down'),
  ],
  'protocol.html': [
    ('<p>This is the whole private exit of <span class="mono">VeylPrivacyPool</span>. Each line is an independent reason to revert, and each has a test that triggers it.</p>',
     '<p>This is the whole private exit of <span class="mono">veyl_pool</span>, in two instructions: <code>post_withdrawal</code> verifies the proof and parks it under its nullifier, <code>withdraw</code> executes it. Each check is an independent reason to fail, and each has a test that triggers it.</p>'),
    ('<figcaption><b>programs/veyl_pool/src/lib.rs</b><span>lines 159 to 178</span></figcaption>', '<figcaption><b>programs/veyl_pool/src/lib.rs</b><span>post_withdrawal and withdraw, condensed</span></figcaption>'),
    ('<figcaption><b>programs/veyl_pool/src/lib.rs</b><span>depositFor</span></figcaption>', '<figcaption><b>programs/veyl_pool/src/lib.rs</b><span>deposit</span></figcaption>'),
    ('<figcaption><b>programs/veyl_entry/src/lib.rs</b></figcaption>', '<figcaption><b>programs/veyl_entry/src/lib.rs</b><span>route types</span></figcaption>'),
    ("The pool measures the deposit by balance difference", "The pool measures the deposit by vault balance difference"),
  ],
  'docs.html': [
    ('where gas is paid in ETH', 'where fees are paid in SOL'), ('<p>Seven pieces in three layers.', '<p>Three programs and one circuit.'),
    ('Testnet only. Not audited. The proving key is single-machine.', 'Devnet only. Not audited. The proving key is single-machine.'),
    ('<h3>Testnet, from one machine</h3>', '<h3>Devnet, from one machine</h3>'),
    ('<details><summary>Is it live?</summary><p>On Solana devnet with mock tokens.', '<details><summary>Is it live?</summary><p>On Solana devnet with mock tokens, and on a local validator.'),
    ('the relayer and publisher run on a server, or stay on your machine behind a tunnel to port 8843; re-run GO-LIVE with the public URL as the relayer URL and it regenerates the config.', 'the relayer (which also publishes the approved set) runs on a server, or stays on your machine behind a tunnel to port 8843; re-run GO-LIVE with RELAYER_URL set to the public URL and it regenerates the config.'),
    ('The relayer and publisher run on a server', 'The relayer (which also publishes the approved set) runs on a server'),
  ],
  'app.html': [
    ('Test tokens on Solana devnet.', 'Mock tokens on Solana devnet.'),
    ('data-f="eth" aria-pressed="false">ETH pairs</button>', 'data-f="sol" aria-pressed="false">SOL pairs</button>'),
    ("if(S.pf==='eth') l=l.filter(p=>p.x==='ETH'||p.y==='ETH'); if(S.pf==='stable') l=l.filter(p=>p.x!=='ETH'&&p.y!=='ETH');", "if(S.pf==='sol') l=l.filter(p=>p.x==='SOL'||p.y==='SOL'); if(S.pf==='stable') l=l.filter(p=>p.x!=='SOL'&&p.y!=='SOL');"),
    ("['ETH','USDC','USDe']", "['SOL','USDC','USDT']"), ("['ETH','USDC','USDT']", "['SOL','USDC','USDT']"),
    ('placeholder="0x…"', 'placeholder="Solana address"'),
    ("if(!/^0x[0-9a-fA-F]{40}$/.test(to)) return $('wErr').textContent='Enter a full address: 0x followed by 40 letters and numbers.';", "if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) return $('wErr').textContent='Enter a full Solana address: 32 to 44 base58 characters.';"),
    ("const ETH_USD=(CFG&&CFG.prices&&CFG.prices.ETH)||2662.70;", "const SOL_USD=(CFG&&CFG.prices&&CFG.prices.SOL)||150;"),
    ("ETH:{name:'Ether',c:'#8E98A6',g:'eth',usd:()=>ETH_USD},", "SOL:{name:'Solana',c:'#8E98A6',g:'sol',usd:()=>SOL_USD},"),
    ("USDe:{name:'Ethena USDe',c:'#5E6B7C',g:'dollar',usd:()=>1},", "USDT:{name:'Tether USD',c:'#5E6B7C',g:'dollar',usd:()=>1},"),
    ("USDT:{name:'Ethena USDT',c:'#5E6B7C',g:'dollar',usd:()=>1},", "USDT:{name:'Tether USD',c:'#5E6B7C',g:'dollar',usd:()=>1},"),
    ("  if(k==='eth'){ P([[64,22],[92,66],[64,82],[36,66]]); g.fill(); P([[64,88],[92,72],[64,108],[36,72]]); g.fill(); cut(()=>{ g.lineWidth=3; g.beginPath(); g.moveTo(36,66); g.lineTo(64,54); g.lineTo(92,66); g.stroke(); }); }",
     "  if(k==='sol'){ [[30,40,98,40,86,54,18,54],[18,60,86,60,98,74,30,74],[30,80,98,80,86,94,18,94]].forEach(q=>{ P([[q[0],q[1]],[q[2],q[3]],[q[4],q[5]],[q[6],q[7]]]); g.fill(); }); }"),
    ("{id:'sol-usdc',x:'ETH',y:'USDC',bs:10,base:0.05,p0:2662.70,tvl:0,vol:0,priv:0},", "{id:'sol-usdc',x:'SOL',y:'USDC',bs:10,base:0.05,p0:150,tvl:0,vol:0,priv:0},"),
    ("{id:'sol-usdt',x:'ETH',y:'USDT',bs:10,base:0.05,p0:2662.10,tvl:0,vol:0,priv:0},", "{id:'sol-usdt',x:'SOL',y:'USDT',bs:10,base:0.05,p0:149.9,tvl:0,vol:0,priv:0},"),
    ("{id:'pons-sol',x:'PONS',y:'ETH',bs:25,base:0.25,p0:0.88/2662.70,tvl:0,vol:0,priv:0},", "{id:'pons-sol',x:'PONS',y:'SOL',bs:25,base:0.25,p0:0.88/150,tvl:0,vol:0,priv:0},"),
    ("{id:'cashcat-sol',x:'CASHCAT',y:'ETH',bs:50,base:0.50,p0:0.1597/2662.70,tvl:0,vol:0,priv:0},", "{id:'cashcat-sol',x:'CASHCAT',y:'SOL',bs:50,base:0.50,p0:0.1597/150,tvl:0,vol:0,priv:0},"),
    ("await E.read.getBlockNumber();", "await E.ping();"),
    ("let a=LIVE?Object.keys(E.tokens)[0]:'ETH';", "let a=LIVE?Object.keys(E.tokens)[0]:'SOL';"),
    ("sub:'Solana',ms:900}", "sub:'Solana devnet',ms:900}"),
    ("to deploy to Solana devnet and open the configured app.", "to start a local validator or deploy to Solana devnet, then open the configured app."),
    ("<b>Demonstration only</b>This page has no testnet configuration, so there is no chain to talk to.", "<b>Demonstration only</b>This page has no devnet configuration, so there is no chain to talk to."),
    ("The RPC in <span class=\"mono\">veyl.config.js</span> did not respond.", "The Solana RPC in <span class=\"mono\">veyl.config.js</span> did not respond."),
    ("'Testnet not answering'", "'Devnet not answering'"), ("'No testnet on this host'", "'No devnet on this host'"), ("'Reading the testnet…'", "'Reading the chain…'"),
    ("This host has no testnet configuration", "This host has no devnet configuration"), ("'No testnet config'", "'No devnet config'"),
    ("if(LIVE&&CFG.chainName){ $('netLbl').lastChild.textContent=CFG.chainName;", "if(LIVE&&CFG.chainName){ $('netLbl').lastChild.textContent=CFG.chainName;"),
    ("<i></i>Testnet</b><span class=\"long\">", "<i></i>Testnet</b><span class=\"long\">"),
    ("Deposit screened',sub:'Checked against known hacks and sanctions lists'", "Deposit screened',sub:'Checked against known hacks and sanctions lists'"),
    ("const CFG=window.VEYL_CONFIG||null; const LIVE=!!(CFG&&CFG.programs&&window.Veyl);", "const CFG=window.VEYL_CONFIG||null; const LIVE=!!(CFG&&CFG.programs&&window.Veyl&&window.Veyl.Engine);"),
  ],
}

def port(name):
  p = SITE / name; s = p.read_text()
  for a, b in GLOBAL: s = s.replace(a, b)
  for a, b in PER_FILE.get(name, []): s = s.replace(a, b)
  if name == 'protocol.html':
    s = GAS_TABLE_OLD.sub(GAS_TABLE_NEW, s); s = DEPOSIT_FIG_OLD.sub(DEPOSIT_FIG_NEW, s); s = WITHDRAW_FIG_OLD.sub(WITHDRAW_FIG_NEW, s)
    s = FEE_FIG_OLD.sub(FEE_FIG_NEW, s); s = TYPES_FIG_OLD.sub(TYPES_FIG_NEW, s); s = CHECKS_OLD.sub(CHECKS_NEW, s)
  if name == 'index.html': s = OPEN_OLD.sub(OPEN_NEW, s); s = RUN_BLOCK_OLD.sub(RUN_BLOCK_NEW, s)
  if name == 'docs.html': s = DOCS_TESTS_OLD.sub(DOCS_TESTS_NEW, s); s = PROGRAMS_LIST_OLD.sub(PROGRAMS_LIST_NEW, s)
  p.write_text(s)
  left = [m.group(0) for m in re.finditer(r'.{30}(Robinhood|forge|Foundry|Solidity|anvil|0x[0-9a-f]{3}|ETH\b|USDe|\.sol\b|calldata|msg\.sender|EIP-712|ECDSA|gas\b).{20}', s) if '<path' not in m.group(0) and 'svg' not in m.group(0)]
  print(name, 'remaining:', len(left)); [print('   ', l) for l in left[:25]]

for n in ['index.html', 'liquidity.html', 'protocol.html', 'docs.html', 'app.html']: port(n)
