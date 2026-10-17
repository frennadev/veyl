// Phase 1: the per-token note pools. GET /state, and POST /submit for relay | swap | add | the signed kinds | order | zap.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
"use strict";
const { PublicKey } = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const S = require("../sdk/veyl.js");
const { contextOf, encodeAction } = S;
const { SHIELD_KINDS, deepBig } = require("./costs.js");
const { isAllowed } = require("./screening.js");
module.exports = (Base) =>
  class Notes extends Base {
    poolFor(pool) {
      const p = this.pools.find((x) => x.pool.equals(new PublicKey(pool)));
      if (!p) throw new Error("unknown pool");
      return p;
    }
    /// Leaves + approved labels, read from the chain (cached 5 s).
    async state(pool) {
      const k = new PublicKey(pool).toBase58();
      const c = this.cache.get(k);
      if (c && Date.now() - c.at < 5000) return c;
      this.poolFor(pool);
      const { leaves, deposits } = await this.V.readTree(pool);
      const labels = deposits.filter(isAllowed).map((d) => d.label);
      const st = {
        at: Date.now(),
        leaves,
        labels,
        deposits: deposits.map((d) => ({
          label: d.label,
          index: d.index,
          value: d.value,
          precommitment: d.precommitment,
          beneficiary: d.beneficiary.toBase58(),
        })),
      };
      this.cache.set(k, st);
      return st;
    }
    _checkCommon(d) {
      if (
        new PublicKey(d.feeRecipient).toBase58() !==
        this.wallet.publicKey.toBase58()
      )
        throw new Error("fee must go to this relayer");
      if (
        Number(d.feeBps) < this.minFeeBps ||
        Number(d.feeBps) > this.maxFeeBps
      )
        throw new Error("fee out of range");
      const now = Math.floor(Date.now() / 1000);
      if (Number(d.deadline) < now) throw new Error("expired");
      if (Number(d.deadline) > now + 3600) throw new Error("deadline too far");
    }
    _checkProof(p) {
      const proof = Buffer.from(p.proof, "base64");
      if (proof.length !== 256) throw new Error("bad proof");
      const pubs = p.pubs.map(BigInt);
      if (pubs.length !== 6) throw new Error("bad public signals");
      return { proof, pubs };
    }
    /// Every request: check it (fields, fee floor), dry-run it (a request that would fail costs the relayer nothing), then send.
    async submit(req) {
      req = deepBig(req);
      const me = this.wallet.publicKey;
      const V = this.V;
      const txs = [];
      const EP = V.signerPda();
      /// The post_withdrawal instruction for a proof: it must commit to exactly this request. A spend posted earlier for the
      /// same note and never executed is replaced (its poster refunded), so nobody can park a copy of a proof to block it.
      const postIx = async (poolMint, p, kind, d) => {
        const { proof, pubs } = this._checkProof(p);
        const pool = V.poolPda(poolMint);
        const ctx = contextOf(EP, encodeAction(kind, d), pool);
        if (pubs[5] !== ctx)
          throw new Error("proof context does not match the request");
        const st = await V.prevPosterOf(pool, pubs[1]);
        if (st.spent) throw new Error("this note is already spent");
        return {
          ix: V.postWithdrawalIx(
            me,
            pool,
            proof,
            pubs,
            EP,
            S.DEFAULT_TTL_SLOTS,
            st.prevPoster || me,
          ),
          nh: pubs[1],
        };
      };
      const post = async (poolMint, p, kind, d) => {
        const { ix, nh } = await postIx(poolMint, p, kind, d);
        txs.push(await V.send([ix], [], 1_400_000));
        return nh;
      };
      switch (req.kind) {
        case "relay": {
          const d = req.d;
          this._checkCommon(d);
          const mint = new PublicKey(req.mint);
          this.poolFor(V.poolPda(mint));
          await this.checkFee("relay", req);
          const { ix, nh } = await postIx(mint, req.p, "relay", d);
          const exec = [
            spl.createAssociatedTokenAccountIdempotentInstruction(
              me,
              V.ata(mint, d.recipient),
              new PublicKey(d.recipient),
              mint,
            ),
            await V.relayIx(me, mint, nh, d),
          ];
          // post + execute in ONE transaction: there is no moment where the posted proof sits on chain unexecuted
          let atomic = null;
          try {
            atomic = await V.sendV0([ix, ...exec], [], 1_400_000);
          } catch (e) {
            if (
              !/too large|overrun|RangeError|exceeds/i.test(
                String(e.message || e),
              )
            )
              throw e;
          }
          if (atomic) txs.push(atomic);
          else {
            txs.push(await V.send([ix], [], 1_400_000));
            txs.push(await this._exec(exec, nh, mint));
          }
          break;
        }
        case "swap": {
          const d = req.d;
          this._checkCommon(d);
          const mint = new PublicKey(req.mint);
          this.poolFor(V.poolPda(mint));
          this.poolFor(V.poolPda(d.tokenOut));
          await this.checkFee("swap", req);
          const nh = await post(mint, req.p, "swap", d);
          const ixs = [];
          if (d.recipient)
            ixs.push(
              spl.createAssociatedTokenAccountIdempotentInstruction(
                me,
                V.ata(d.tokenOut, d.recipient),
                new PublicKey(d.recipient),
                new PublicKey(d.tokenOut),
              ),
            );
          ixs.push(await V.privateSwapIx(me, mint, nh, d));
          txs.push(await this._exec(ixs, nh, mint));
          break;
        }
        case "add": {
          const d = req.d;
          this._checkCommon(d);
          if (!req.legs || req.legs.length < 1 || req.legs.length > 2)
            throw new Error("bad legs");
          if (
            !Array.isArray(d.minShares) ||
            d.minShares.length !== d.ids.length
          )
            throw new Error("minShares must give a minimum for every bin");
          for (const l of req.legs)
            this.poolFor(V.poolPda(new PublicKey(l.mint)));
          await this.checkFee("add", req);
          const legs = [];
          for (const l of req.legs) {
            const mint = new PublicKey(l.mint);
            legs.push({ mint, nullifierHash: await post(mint, l.p, "add", d) });
          }
          const pre = await V.ensureBinAccountsIxs(
            me,
            d.binPool,
            d.ids,
            d.owner,
            EP,
          );
          if (pre.length) txs.push(await V.send(pre, [], 200_000));
          try {
            txs.push(
              await V.sendV0(
                [await V.privateAddIx(me, legs, d)],
                [],
                1_400_000,
              ),
            );
          } catch (e) {
            for (const l of legs) await this._cancel(l.mint, l.nullifierHash);
            throw e;
          }
          break;
        }
        case "remove":
        case "claim":
        case "reward":
        case "orderWithdraw":
        case "rebalance": {
          const kind = req.kind;
          const d = req.d;
          this._checkCommon(d);
          const sig = Buffer.from(req.sig, "base64");
          if (sig.length !== 64) throw new Error("bad signature");
          if (
            kind === "rebalance" &&
            (!Array.isArray(d.minShares) || d.minShares.length !== d.ids.length)
          )
            throw new Error("minShares must give a minimum for every bin");
          await this.checkFee(kind, req);
          if (kind === "rebalance") {
            const pre = await V.ensureBinAccountsIxs(
              me,
              d.binPool,
              d.ids,
              d.owner,
              EP,
            );
            if (pre.length) txs.push(await V.send(pre, [], 200_000));
          }
          // the ed25519 instruction must come right before the action: token-account creation goes first (REVIEW.md L-1)
          const ixs = [];
          const bp = await V.binPool(d.binPool);
          if (d.recipient) {
            const outs =
              kind === "reward"
                ? [
                    [
                      bp.rewards[Number(d.index)].mint,
                      bp.rewards[Number(d.index)].tokenProgram,
                    ],
                  ]
                : [
                    [bp.mintX, bp.tokenProgramX],
                    [bp.mintY, bp.tokenProgramY],
                  ];
            for (const [m, tp] of outs)
              ixs.push(
                spl.createAssociatedTokenAccountIdempotentInstruction(
                  me,
                  V.ata(m, d.recipient, tp),
                  new PublicKey(d.recipient),
                  m,
                  tp,
                ),
              );
          }
          if (kind === "reward") {
            const r = bp.rewards[Number(d.index)];
            const fa = V.ata(r.mint, me, r.tokenProgram),
              ea = V.ata(r.mint, EP, r.tokenProgram);
            ixs.push(
              spl.createAssociatedTokenAccountIdempotentInstruction(
                me,
                fa,
                me,
                r.mint,
                r.tokenProgram,
              ),
              spl.createAssociatedTokenAccountIdempotentInstruction(
                me,
                ea,
                EP,
                r.mint,
                r.tokenProgram,
              ),
            );
          }
          const build = {
            remove: () => V.privateRemoveIx(me, d),
            claim: () => V.privateClaimFeesIx(me, d),
            reward: () => V.privateClaimRewardIx(me, d),
            orderWithdraw: () => V.privateWithdrawOrderIx(me, d),
            rebalance: () => V.privateRebalanceIx(me, d),
          }[kind];
          ixs.push(V.signedSigIx(kind, d.owner, sig, d), await build());
          txs.push(await V.sendV0(ixs, [], 1_400_000));
          break;
        }
        case "order":
        case "zap": {
          const kind = req.kind;
          const d = req.d;
          this._checkCommon(d);
          if (!req.legs || req.legs.length !== 1) throw new Error("one leg");
          const bp = await V.binPool(d.binPool);
          const want =
            kind === "order"
              ? d.isAsk
                ? bp.mintX
                : bp.mintY
              : d.xIn
                ? bp.mintX
                : bp.mintY;
          if (!new PublicKey(req.legs[0].mint).equals(want))
            throw new Error(
              "the leg must be " +
                (kind === "order" ? "the order token" : "the token zapped in"),
            );
          if (
            kind === "zap" &&
            (!Array.isArray(d.minShares) || d.minShares.length !== d.ids.length)
          )
            throw new Error("minShares must give a minimum for every bin");
          if (
            kind === "zap" &&
            BigInt(d.swapAmount) > 0n &&
            BigInt(d.minSwapOut) === 0n
          )
            throw new Error("a zap that swaps needs minSwapOut");
          this.poolFor(V.poolPda(want));
          await this.checkFee(kind, req);
          const nh = await post(want, req.legs[0].p, kind, d);
          const pre = await V.ensureBinAccountsIxs(
            me,
            d.binPool,
            kind === "order" ? [d.id] : d.ids,
            d.owner,
            EP,
          );
          if (pre.length) txs.push(await V.send(pre, [], 200_000));
          const leg = { mint: want, nullifierHash: nh };
          txs.push(
            await this._exec(
              [
                kind === "order"
                  ? await V.privatePlaceOrderIx(me, leg, d)
                  : await V.privateZapIx(me, leg, d),
              ],
              nh,
              want,
            ),
          );
          break;
        }
        default:
          if (SHIELD_KINDS.has(req.kind)) return this.submitShield(req);
          throw new Error("unknown kind");
      }
      this.cache.clear(); // the pool changed; the next /state must be fresh
      return { txs, txHash: txs[txs.length - 1] };
    }
    async _exec(ixs, nh, mint) {
      try {
        return await this.V.sendV0(ixs, [], 1_400_000);
      } catch (e) {
        await this._cancel(mint, nh);
        throw e;
      }
    }
    /// A spend that was posted but whose execution failed: free the nullifier again so the user's note is not stuck.
    async _cancel(mint, nh) {
      try {
        await this.V.send(
          [
            await this.V.cancelPostIx(
              this.wallet.publicKey,
              this.V.poolPda(mint),
              nh,
            ),
          ],
          [],
          100_000,
        );
      } catch {
        /* best effort */
      }
    }
  };
