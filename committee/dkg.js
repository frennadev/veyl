// Veyl batch committee: dealerless distributed key generation (joint Feldman VSS, "JF-DKG") between n nodes over HTTP.
// No machine ever holds the committee's secret key: each node deals a random polynomial of degree t-1, sends every other
// node its share (encrypted to that node's X25519 key) and publishes Feldman commitments to the coefficients, signed with
// its node key. Each node checks the shares it received against the commitments; the joint key is the sum of the
// qualified dealers' constant terms, each node's secret share the sum of the shares it received.
//
//   round 1   GET /dkg/<session>/round1  { index, commitments[t], shares{ j: box }, boxKey, sig }   (served by each node)
//   round 2   GET /dkg/<session>/round2  { index, complaints[], view, sig }  view = sha256 of every dealer's commitments
//   result    QUAL = dealers nobody complained about (any complaint aborts in this implementation: see DEPLOY.md, the
//             mainnet requirement is complaint resolution, where an accused dealer publishes the disputed share);
//             every node must report the same view. Output: the member's secret share (kept on disk, mode 0600) and the
//             public transcript (commitments, the encrypted shares, signatures, the joint key, every member's public key
//             share); its sha256 is
//             what set_committee stores on chain.
//
// Known limitation of plain JF-DKG (Gennaro et al. 1999): a rushing dealer can bias the joint key's distribution. The
// resulting key is still uniformly unknown to fewer than t members, so ElGamal privacy holds; the Pedersen-commitment
// variant (GJKR) removes the bias and is listed as a mainnet hardening item.
'use strict';
const crypto = require('crypto'); const nacl = require('tweetnacl'); const bs58 = require('bs58');
const J = require('../sdk/bjj.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const hexP = (p) => J.enc(p).toString('hex'); const unhexP = (h) => J.dec(Buffer.from(h, 'hex'));
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());

/// What a node publishes in round 1 (and keeps: its polynomial's shares for itself).
function round1({ session, index, t, n, boxSecret, peers, nodeKey }) {
  const d = J.deal(t, n); const boxKey = nacl.box.keyPair.fromSecretKey(Uint8Array.from(boxSecret));
  const shares = {}; for (const p of peers) { if (p.index === index) continue; const nonce = sha(Buffer.from(`${session}:${index}->${p.index}`)).subarray(0, 24);
    shares[p.index] = Buffer.from(nacl.box(Uint8Array.from(J.be32(d.shares[p.index - 1])), Uint8Array.from(nonce), Uint8Array.from(Buffer.from(p.boxKey, 'base64')), boxKey.secretKey)).toString('base64'); }
  const body = { session, index, t, n, commitments: d.commitments.map(hexP), shares, boxKey: Buffer.from(boxKey.publicKey).toString('base64') };
  return { msg: { ...body, sig: sign(nodeKey, body) }, own: d.shares[index - 1] };
}
function sign(nodeKey, body) { return Buffer.from(nacl.sign.detached(sha(Buffer.from(canon(body))), nodeKey.secretKey)).toString('base64'); }
function verifySig(body, node) { const { sig, ...rest } = body; return nacl.sign.detached.verify(sha(Buffer.from(canon(rest))), Buffer.from(sig, 'base64'), bs58.decode(node)); }
/// Round 2: check every dealer's message (signature, share against its commitments). Returns complaints and the share sum.
function round2({ session, index, t, n, boxSecret, peers, r1s, own, nodeKey }) {
  const complaints = []; const got = { [index]: own };
  for (const p of peers) { if (p.index === index) continue; const m = r1s[p.index];
    const ok = m && m.session === session && m.index === p.index && m.t === t && m.n === n && verifySig(m, p.node) && m.commitments.length === t && m.boxKey === p.boxKey;
    if (!ok) { complaints.push(p.index); continue; }
    const nonce = sha(Buffer.from(`${session}:${p.index}->${index}`)).subarray(0, 24);
    const plain = nacl.box.open(Uint8Array.from(Buffer.from(m.shares[index] || '', 'base64')), Uint8Array.from(nonce), Uint8Array.from(Buffer.from(p.boxKey, 'base64')), Uint8Array.from(boxSecret));
    const s = plain ? J.fromBe(Buffer.from(plain)) : null;
    if (s === null || !m.commitments.map(unhexP).every(J.isOnCurve) || !J.verifyShare(m.commitments.map(unhexP), index, s)) { complaints.push(p.index); continue; }
    got[p.index] = s; }
  const view = viewOf(r1s, n).toString('hex'); const body = { session, index, complaints, view };
  return { msg: { ...body, sig: sign(nodeKey, body) }, got };
}
const viewOf = (r1s, n) => sha(Buffer.from(JSON.stringify(Array.from({ length: n }, (_, i) => (r1s[i + 1] ? r1s[i + 1].commitments : null)))));
/// Combine: the member's secret share, the joint key, every member's public share, the transcript.
function finish({ session, index, t, n, peers, r1s, r2s, got }) {
  for (const p of peers) { const m = r2s[p.index]; if (!m || !verifySig(m, p.node)) throw new Error('round 2 message of node ' + p.index + ' missing or not signed by it'); }
  const complaints = Object.values(r2s).flatMap((m) => m.complaints); if (complaints.length) throw new Error('complaints against dealer(s) ' + [...new Set(complaints)].join(', ') + ': DKG aborted (start a new session without them)');
  const views = new Set(Object.values(r2s).map((m) => m.view)); if (views.size !== 1) throw new Error('nodes saw different commitments: DKG aborted');
  const qual = peers.map((p) => p.index).sort((a, b) => a - b);
  const F = J.combineCommitments(qual.map((i) => r1s[i].commitments.map(unhexP)));
  const sk = qual.reduce((s, i) => J.md(s + got[i], J.l), 0n);
  const members = Array.from({ length: n }, (_, k) => J.sharePublic(F, k + 1));
  if (!J.eq(J.mulB(sk), members[index - 1])) throw new Error('own share does not match the joint commitments');
  const transcript = { protocol: 'veyl-committee-dkg/jf-dkg-v1', curve: 'babyjubjub (circomlib), base B8', session, t, n, qual,
    dealers: qual.map((i) => ({ index: i, node: peers.find((p) => p.index === i).node, boxKey: r1s[i].boxKey, commitments: r1s[i].commitments, shares: r1s[i].shares, sig: r1s[i].sig })),
    round2: qual.map((i) => ({ index: i, view: r2s[i].view, complaints: r2s[i].complaints, sig: r2s[i].sig })), pk: hexP(F[0]), members: members.map(hexP), nodes: peers.map((p) => p.node) };
  return { sk, PK: F[0], members, transcript, transcriptHash: transcriptHash(transcript) };
}
const transcriptHash = (tr) => sha(Buffer.from(JSON.stringify(tr)));
/// Anyone can re-check a published transcript: signatures, every dealer's commitments, the joint key and member keys.
function verifyTranscript(tr) {
  const errs = []; const by = Object.fromEntries(tr.dealers.map((d) => [d.index, d]));
  for (const d of tr.dealers) { const body = { session: tr.session, index: d.index, t: tr.t, n: tr.n, commitments: d.commitments, shares: d.shares, boxKey: d.boxKey };
    if (!verifySig({ ...body, sig: d.sig }, d.node)) errs.push('round 1 signature of ' + d.index);
    if (d.commitments.length !== tr.t || !d.commitments.map(unhexP).every(J.isOnCurve)) errs.push('dealer ' + d.index + ' commitments'); }
  for (const r of tr.round2) { const body = { session: tr.session, index: r.index, complaints: r.complaints, view: r.view }; if (!verifySig({ ...body, sig: r.sig }, by[r.index].node)) errs.push('round 2 signature of ' + r.index); if (r.complaints.length) errs.push('complaints by ' + r.index); }
  if (new Set(tr.round2.map((r) => r.view)).size !== 1) errs.push('views differ');
  const F = J.combineCommitments(tr.dealers.map((d) => d.commitments.map(unhexP)));
  if (hexP(F[0]) !== tr.pk) errs.push('joint key'); for (let k = 1; k <= tr.n; k++) if (hexP(J.sharePublic(F, k)) !== tr.members[k - 1]) errs.push('member ' + k + ' key');
  return { ok: errs.length === 0, errs };
}
/// Registration data for set_committee from a transcript.
const registration = (tr, kind = 1) => ({ t: tr.t, n: tr.n, kind, pk: unhexP(tr.pk), members: tr.members.map(unhexP), nodes: tr.nodes, transcript: transcriptHash(tr) });

module.exports = { round1, round2, finish, verifyTranscript, transcriptHash, registration, verifySig, sign, hexP, unhexP };
