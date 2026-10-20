// relayer/tokens.js: Jupiter token metadata and the logo proxy. No network: Jupiter, DNS and the image download are stand-ins.
// Run: node tests/tokens.js
const assert = require("assert");
const { EventEmitter } = require("events");
const T = require("../relayer/tokens.js");
const ok = (name, c) => { assert.ok(c, name); console.log("ok -", name); };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };

const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_C = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/// A stand-in for https.get: answers `status` with `body` in chunks; records the pinned lookup it was given.
function fakeGet({ status = 200, body = PNG, chunk = 64 * 1024 } = {}, seen = {}) {
  return (u, opts, cb) => {
    seen.url = String(u); seen.lookup = opts.lookup; const req = new EventEmitter(); let dead = false; req.destroy = (e) => { dead = true; if (e) req.emit("error", e); };
    setImmediate(() => { const res = new EventEmitter(); res.statusCode = status; res.resume = () => {}; cb(res);
      for (let i = 0; i < body.length && !dead; i += chunk) res.emit("data", body.subarray(i, i + chunk)); if (!dead) res.emit("end"); });
    return req;
  };
}
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

(async () => {
  // ---- address and type rules
  ok("private IPv4 refused (10/8, 127/8, 169.254/16 metadata, 172.16/12, 192.168/16, CGNAT, 0/8)",
    ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0"].every(T.isPrivate));
  ok("private IPv6 refused (::1, fc00::/7, fd00::, fe80::/10, ::ffff:127.0.0.1)", ["::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::"].every(T.isPrivate));
  ok("IPv6 forms of private v4 refused (mapped hex, NAT64, 6to4, IPv4-compatible), 198.18/15, 192.0.0/24, unparsable",
    ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2002:a00:1::", "::7f00:1", "198.18.0.1", "198.19.255.1", "192.0.0.1", "2001:db8::1", "garbage", ""].every(T.isPrivate));
  ok("public addresses allowed", !T.isPrivate("93.184.216.34") && !T.isPrivate("2606:4700::6810:84e5") && !T.isPrivate("172.32.0.1"));
  ok("image types by magic bytes; SVG and junk are not images", T.imageType(PNG) === "image/png" && T.imageType(Buffer.from([0xff, 0xd8, 0xff, 0])) === "image/jpeg"
    && T.imageType(Buffer.from("GIF89a....")) === "image/gif" && T.imageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")) === "image/webp" && T.imageType(SVG) === null && T.imageType(Buffer.from("hello")) === null);
  ok("mints: base58 32-byte keys only", T.isMint(MINT_A) && !T.isMint("not-a-mint") && !T.isMint("1".repeat(50)) && !T.isMint(""));

  // ---- the image download
  const seen = {};
  let img = await T.fetchImage("https://logos.example/a.png", { lookup: publicDns, get: fakeGet({}, seen) });
  ok("a public PNG downloads, typed by its bytes", img.type === "image/png" && img.bytes.length === PNG.length);
  ok("the connection is pinned to the checked address (no second DNS lookup)", await new Promise((r) => seen.lookup("logos.example", {}, (e, addr) => r(addr === "93.184.216.34"))));
  ok("SVG refused", await rejects(T.fetchImage("https://logos.example/a.svg", { lookup: publicDns, get: fakeGet({ body: SVG }) }), /not a PNG, JPEG, WebP or GIF/));
  ok("over 256 KB aborted", await rejects(T.fetchImage("https://logos.example/big.png", { lookup: publicDns, get: fakeGet({ body: Buffer.concat([PNG, Buffer.alloc(300 * 1024)]) }) }), /over 256 KB/));
  ok("a host resolving to a private address refused", await rejects(T.fetchImage("https://evil.example/x.png", { lookup: async () => [{ address: "169.254.169.254", family: 4 }], get: fakeGet() }), /private address/));
  ok("any private address among several refused", await rejects(T.fetchImage("https://evil.example/x.png", { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }], get: fakeGet() }), /private address/));
  ok("a literal private IP refused", await rejects(T.fetchImage("https://127.0.0.1/x.png", { lookup: publicDns, get: fakeGet() }), /private address/));
  ok("http (not https) refused", await rejects(T.fetchImage("http://logos.example/a.png", { lookup: publicDns, get: fakeGet() }), /not https/));
  // a host that sends a byte now and then (never idle long enough for the socket timeout) still hits the overall deadline
  const drip = (u, opts, cb) => { const req = new EventEmitter(); let t; req.destroy = (e) => { clearInterval(t); if (e) req.emit("error", e); };
    setImmediate(() => { const res = new EventEmitter(); res.statusCode = 200; cb(res); res.emit("data", PNG.subarray(0, 8)); t = setInterval(() => res.emit("data", Buffer.alloc(1)), 200); }); return req; };
  const t0 = Date.now(); const stalled = await rejects(T.fetchImage("https://logos.example/slow.png", { lookup: publicDns, get: drip }), /timed out/);
  ok("a dripping host is cut off at the overall 5 s deadline", stalled && Date.now() - t0 < 7000);
  ok("redirects not followed", await rejects(T.fetchImage("https://logos.example/r.png", { lookup: publicDns, get: fakeGet({ status: 302 }) }), /answered 302/));

  // ---- metadata: batching, the negative cache, symbol lookup only off mainnet
  let calls = []; const rows = { [MINT_A]: { id: MINT_A, symbol: "SOL", name: "Wrapped SOL", decimals: 9, icon: "https://logos.example/sol.png", isVerified: true, tags: ["verified"] },
    [MINT_B]: { id: MINT_B, symbol: "USDC", name: "USD Coin", decimals: 6, icon: "https://logos.example/usdc.png", tags: ["verified"] } };
  const jupiter = async (q) => { calls.push(q); return q.includes(",") || rows[q] ? q.split(",").map((m) => rows[m]).filter(Boolean) : Object.values(rows).filter((r) => r.symbol.toLowerCase() === q.toLowerCase()); };
  let images = []; const image = async (url) => { images.push(url); return { type: "image/png", bytes: PNG }; };
  const tok = T.makeTokens({ network: "devnet", jupiter, image });
  let out = await tok.getTokens([MINT_A, MINT_B, MINT_C]);
  ok("one Jupiter call for a batch of mints", calls.length === 1 && calls[0] === [MINT_A, MINT_B, MINT_C].join(","));
  ok("entries normalized; Jupiter's verified flag; icon points at the relayer", out[MINT_A].symbol === "SOL" && out[MINT_A].verified === true && out[MINT_A].icon === "/tokens/icon/" + MINT_A && out[MINT_B].verified === true);
  ok("unknown mint is null", out[MINT_C] === null);
  calls = []; await tok.getTokens([MINT_A, MINT_C]); ok("known and unknown (negative cache) both served from memory", calls.length === 0);
  out = await tok.getTokens(["sym:USDC"]); ok("devnet: sym:<SYMBOL> finds the verified token", out["sym:USDC"] && out["sym:USDC"].mint === MINT_B);
  ok("ids parsing: mints and sym: on devnet", tok.parseIds(`${MINT_A}, sym:SOL ,${MINT_A}`).length === 2);
  assert.throws(() => tok.parseIds("not-a-mint"), /not a token mint/); assert.throws(() => tok.parseIds(Array(101).fill(0).map((_, i) => "sym:T" + i).join(",")), /1 to 100/); ok("bad ids and more than 100 refused", true);
  const main = T.makeTokens({ network: "mainnet", jupiter, image });
  assert.throws(() => main.parseIds("sym:USDC"), /by mint on mainnet/); ok("mainnet: symbol lookups refused (mint only)", true);

  // ---- icons: only Jupiter's URL for that mint, cached, failures cached briefly
  let ic = await tok.getIcon(MINT_A); ok("icon fetched from the URL Jupiter gave for that mint", ic.type === "image/png" && images[0] === "https://logos.example/sol.png");
  await tok.getIcon(MINT_A); ok("icon cached", images.length === 1);
  ok("no icon for a mint Jupiter doesn't know", await rejects(tok.getIcon(MINT_C), /no icon/));
  ok("a non-mint refused before any fetch", await rejects(tok.getIcon("../etc/passwd"), /not a token mint/) && images.length === 1);
  let n = 0; const flaky = T.makeTokens({ network: "devnet", jupiter, image: async () => { n++; throw new Error("not a PNG, JPEG, WebP or GIF"); } });
  await flaky.getIcon(MINT_B).catch(() => {}); await flaky.getIcon(MINT_B).catch(() => {}); ok("a failed icon is cached briefly (no hammering)", n === 1);
  const capped = T.makeTokens({ network: "devnet", jupiter, image }); ok("icon cache is byte-capped", capped._caches.icons.bytes === 0);

  // ---- bounded work per request and in total (junk ids can't queue unbounded Jupiter calls)
  calls = []; const many = Array.from({ length: 30 }, (_, i) => "sym:J" + i);
  const capSym = T.makeTokens({ network: "devnet", jupiter, image }); out = await capSym.getTokens(many);
  ok("at most 10 uncached symbol searches per request; the rest answer null", calls.length === 10 && Object.keys(out).length === 30 && many.every((k) => out[k] === null));
  calls = []; await capSym.getTokens(many.slice(20)); ok("symbols skipped by the cap are not cached as unknown (a later request searches them)", calls.length === 10);
  let release; const gate = new Promise((r) => { release = r; }); let started = 0;
  const slow = T.makeTokens({ network: "devnet", gapMs: 0, queueMax: 3, jupiter: undefined, image });
  // the real spaced queue around a stand-in fetch that blocks until released
  const realFetch = global.fetch; global.fetch = async () => { started++; await gate; return { ok: true, json: async () => [] }; };
  const pend = Array.from({ length: 6 }, (_, i) => slow.getTokens(["sym:Q" + i]));
  await new Promise((r) => setTimeout(r, 50)); release(); const res = await Promise.all(pend); global.fetch = realFetch;
  ok("the Jupiter queue is capped: calls past it fail at once (no unbounded growth)", started <= 4 && res.every((o) => Object.values(o)[0] === null));

  // ---- IPFS: a refusing gateway falls back to a second one, same content id only
  ok("ipfs URL maps to the fallback gateway (CID only); other URLs don't", T.ipfsAlt("https://ipfs.io/ipfs/bafybeicu2pdtwxggsn7b56shegvlvorwwpmn3btegouqzu7rqn6a32s4rq") === "https://gateway.pinata.cloud/ipfs/bafybeicu2pdtwxggsn7b56shegvlvorwwpmn3btegouqzu7rqn6a32s4rq"
    && T.ipfsAlt("https://logos.example/a.png") === null && T.ipfsAlt("https://ipfs.io/ipfs/bafy../../etc") === null && T.ipfsAlt("https://gateway.pinata.cloud/ipfs/bafybeicu2pdtwxggsn7b56shegvlvorwwpmn3btegouqzu7rqn6a32s4rq") === null);
  const ipfsRows = { [MINT_C]: { id: MINT_C, symbol: "MEME", name: "Meme", decimals: 6, icon: "https://ipfs.io/ipfs/bafybeicu2pdtwxggsn7b56shegvlvorwwpmn3btegouqzu7rqn6a32s4rq" } };
  const tried = []; const gw = T.makeTokens({ network: "devnet", jupiter: async (q) => q.split(",").map((m) => ipfsRows[m]).filter(Boolean),
    image: async (url) => { tried.push(url); if (url.includes("ipfs.io")) throw new Error("icon host answered 429"); return { type: "image/png", bytes: PNG }; } });
  ic = await gw.getIcon(MINT_C); ok("a 429 from the IPFS gateway is retried on the fallback gateway", ic.type === "image/png" && tried.length === 2 && tried[1].startsWith("https://gateway.pinata.cloud/ipfs/"));

  // ---- warming the caches with a deployment's tokens (same keys the app asks for)
  const dep = { SOL: { mint: MINT_A }, USDC: { mint: "CFSvusU2qpt3qdZGr9zwBKMLfk4nW4CTxZ1NExEZe3Pt" }, "BAD SYM": { mint: "x" } };
  const w = T.makeTokens({ network: "devnet", jupiter, image: async (url) => { images.push(url); return { type: "image/png", bytes: PNG }; } });
  ok("devnet keys: native SOL by mint, mock mints by symbol, junk dropped", JSON.stringify(w.keysFor(dep)) === JSON.stringify([MINT_A, "sym:USDC"].sort()));
  ok("mainnet keys: by mint only", JSON.stringify(main.keysFor({ USDC: { mint: MINT_B } })) === JSON.stringify([MINT_B]));
  images = []; calls = []; await w.warm(dep);
  calls = []; const warmed = await w.getTokens([MINT_A, "sym:USDC"]);
  ok("after warm(): metadata served from memory", calls.length === 0 && warmed[MINT_A] && warmed["sym:USDC"]);
  ok("after warm(): every logo already downloaded", images.length === 2 && w._caches.icons.size === 2);
  console.log("all ok");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
