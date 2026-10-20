'use client';
// Runs one real engine action in the dialog: a step list for its kind, moved on by the engine's own progress messages
// (nothing is timed or simulated), then the done screen or the error. On success it logs the activity entry and reloads
// every screen's data. A new action is an ActionSpec; this file doesn't change for it.
import type { ReactNode } from 'react';
import { createStore, useStore, type Store } from '@/lib/store';
import { session, setBusy, invalidate, logActivity } from '@/features/session/session';
import { openModal, closeModal } from '@/components/overlay';
import { Icon, Hint } from '@/components/ui/primitives';
import type { ActivityEntry, Runtime, SandboxEngine, VeylEngine } from '@/lib/veyl/types';

export type ActionKind = 'proof' | 'sign' | 'wallet';
export interface ActionOutcome { title: string; body: ReactNode; tx?: string | null; activity?: Omit<ActivityEntry, 'ts'> }
export interface ActionSpec<R> {
  title: string; kind: ActionKind;
  exec: (E: VeylEngine) => Promise<R>;
  done: (result: R) => ActionOutcome;
}

// ---------------------------------------------------------------- the steps each kind shows
interface Step { label: string; sub: string }
function stepsFor(rt: Runtime, kind: ActionKind): Step[] {
  const sbx = rt.mode === 'sandbox', confirmed = sbx ? 'Applied' : 'Confirmed on ' + rt.chainName;
  const never = 'Your wallet never touches this transaction.';
  const table: Record<ActionKind, Step[]> = {
    proof: [
      { label: 'Building a zero-knowledge proof', sub: 'On this device. It shows the funds are yours without showing which notes. This can take a minute.' },
      { label: sbx ? 'Verified, then the relayer submits it' : 'Relayer submits it', sub: sbx ? 'Checked with snarkjs against the circuit\'s verifying key before anything is applied.' : never },
      { label: confirmed, sub: '' }],
    sign: [
      { label: 'Signing with the position key', sub: 'The one-time key that owns the position signs on this device.' },
      { label: 'Relayer submits it', sub: never },
      { label: confirmed, sub: '' }],
    wallet: [
      { label: sbx ? 'Your wallet signs' : 'Confirm in your wallet', sub: 'Your wallet shows what it is signing.' },
      { label: sbx ? 'Applying it' : 'Sending', sub: '' },
      { label: confirmed, sub: '' }],
  };
  return table[kind];
}

// ---------------------------------------------------------------- the task (runs outside React, the dialog only shows it)
/// A next step for errors that have one, shown under the message (which is always shown as it came). A list: a new case is
/// an entry.
const ERROR_HINTS: { test: RegExp; hint: string }[] = [
  // the relayer won't take its fee in a token it can't price (a pool listed since the deploy), or has taken its daily share of it
  { test: /pay the fee in a listed token|has taken all the fees in .+ it accepts today/i,
    hint: "Add some of the pair's listed token too (for example SOL or USDC): the relayer then takes its fee from that side." },
];
const hintFor = (m: string | null) => (m ? ERROR_HINTS.find((h) => h.test.test(m))?.hint ?? null : null);

interface TaskState { step: number; subs: string[]; status: 'running' | 'done' | 'failed'; error: string | null; outcome: ActionOutcome | null; bar: number | null }
interface Task { title: string; kind: ActionKind; steps: Step[]; state: Store<TaskState> }

export function runAction<R>(spec: ActionSpec<R>): void {
  const rt = session.get().rt; if (!rt?.engine || session.get().busy) return;
  const E = rt.engine, steps = stepsFor(rt, spec.kind);
  const state = createStore<TaskState>({ step: 0, subs: steps.map((s) => s.sub), status: 'running', error: null, outcome: null, bar: null });
  const advance = (k: number) => state.set((s) => ({ step: Math.max(s.step, Math.min(k, steps.length - 1)) }));
  const setSub = (m: string) => state.set((s) => { const subs = [...s.subs]; subs[s.step] = m; return { subs }; });

  E.onLog = (m) => {
    if (/Relayer submits/.test(m) || /^Sending/.test(m)) advance(1);
    if (rt.mode === 'sandbox' && spec.kind === 'wallet' && /Applying|wallet signs/.test(m)) advance(1);
    if (!/Relayer submits/.test(m)) setSub(m);
  };
  const stopWatch = rt.mode === 'sandbox' ? watchProving(rt.engine, setSub, (bar) => state.set({ bar })) : null;
  const finish = () => { stopWatch?.(); E.onLog = () => {}; setBusy(false); };

  setBusy(true);
  openModal(<ActionDialog task={{ title: spec.title, kind: spec.kind, steps, state }} />);
  void (async () => {
    let result: R;
    try { result = await spec.exec(E); }
    catch (e) {
      const err = e as { shortMessage?: string; message?: string } | null;
      const m = String(err?.shortMessage || err?.message || e);
      state.set({ status: 'failed', error: m.length > 300 ? m.slice(0, 300) + '…' : m });
      invalidate(); // a multi-transaction action may have completed some steps
      return;
    } finally { finish(); }
    // Execution succeeded. A receipt or local-storage failure must never look like a failed transaction.
    let outcome: ActionOutcome;
    try { outcome = spec.done(result); }
    catch { outcome = { title: 'Action completed', body: 'The action completed, but its receipt could not be displayed. Check your balances and activity before trying again.' }; }
    state.set({ status: 'done', outcome, step: steps.length });
    try { if (outcome.activity) logActivity(outcome.activity); }
    catch { /* the confirmed result remains visible even if local storage is unavailable */ }
    invalidate();
  })();
}

/// Sandbox: what the prover is doing inside the running step (downloading the key, then proving against the usual time).
function watchProving(E: SandboxEngine, setSub: (m: string) => void, setBar: (pct: number | null) => void): () => void {
  let cur: { circuit: string; stage?: string; loaded?: number; total?: number; expect?: number; t0: number } | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  const show = () => {
    if (!cur) return;
    if (cur.stage === 'fetch') {
      const t = cur.total || 0, l = cur.loaded || 0;
      setSub(`Downloading the ${cur.circuit} proving key: ${(l / 1e6).toFixed(1)}${t ? ' of ' + (t / 1e6).toFixed(0) : ''} MB. Once per visit.`);
      setBar(t ? Math.min(100, (l / t) * 100) : null);
    } else {
      const s = (Date.now() - cur.t0) / 1000, ex = (cur.expect || 6000) / 1000;
      setSub(`Proving the ${cur.circuit} circuit on this device: ${s.toFixed(0)} s (usually about ${Math.max(1, Math.round(ex))} s here).`);
      setBar(null);
    }
  };
  const off = E.on((ev) => {
    if (ev.type === 'proving') {
      if (ev.proving) { cur = { t0: Date.now(), ...cur, ...ev.proving }; tick ??= setInterval(show, 500); show(); }
      else { cur = null; if (tick) clearInterval(tick); tick = null; }
    }
    if (ev.type === 'verified') setSub(ev.ok ? `Proof verified in ${ev.verifyMs} ms (snarkjs, ${ev.circuit} verifying key).` : 'The proof did not verify.');
  });
  return () => { off(); if (tick) clearInterval(tick); };
}

// ---------------------------------------------------------------- the dialog
function ActionDialog({ task }: { task: Task }) {
  const s = useStore(task.state, (x) => x);
  if (s.status === 'done' && s.outcome) return <DoneBlock {...s.outcome} />;
  const cls = (i: number) => (i < s.step ? 'ok' : i > s.step ? undefined : s.status === 'failed' ? 'no' : 'on');
  return (
    <>
      <h3 id="dlgTitle">{task.title}</h3>
      <ol className="steps" id="stepList" aria-live="polite">
        {task.steps.map((st, i) => (
          <li key={i} id={'st' + i} className={cls(i)}>
            <span className="sc"></span>
            <div>
              <b>{st.label}</b><small id={'sub' + i}>{s.subs[i]}</small>
              {task.kind === 'proof' && i === 0 && <div className={'ind' + (s.bar != null ? ' det' : '')}><i style={s.bar != null ? { width: s.bar.toFixed(0) + '%' } : undefined}></i></div>}
            </div>
          </li>
        ))}
      </ol>
      {s.status === 'failed' && <>
        <p className="err" id="actErr" role="alert">{s.error}</p>
        {hintFor(s.error) && <Hint icon="bolt">{hintFor(s.error)}</Hint>}
        <Hint icon="alert">Some steps may already have reached the chain. Check your balances and activity before trying again. Notes created for this action stay on this device.</Hint>
        <button className="btn ghost" type="button" id="errClose" onClick={closeModal}>Close</button>
      </>}
    </>
  );
}

/// The success screen, for actions and for the dialogs that finish without a transaction (backup, restore).
export function DoneBlock({ title, body, tx }: ActionOutcome) {
  return (
    <>
      <div className="done">
        <span className="okc"><Icon name="check" /></span><b id="dlgTitle">{title}</b><p>{body}</p>
        <TxLink tx={tx} /><Receipt tx={tx} />
      </div>
      <button className="btn" type="button" id="doneBtn" onClick={closeModal}>Done</button>
    </>
  );
}
export const showDone = (o: ActionOutcome) => openModal(<DoneBlock {...o} />);

function TxLink({ tx }: { tx?: string | null }) {
  const cfg = session.get().rt?.cfg;
  if (!tx || tx.startsWith('sandbox #')) return null;
  return (
    <code>tx {tx.slice(0, 10)}…{tx.slice(-6)}
      {cfg?.explorer && <>{' · '}<a href={`${cfg.explorer}/tx/${tx}${cfg.explorerSuffix || ''}`} target="_blank" rel="noopener">view</a></>}
    </code>
  );
}

/// Sandbox: the proofs this action made and verified, and what the chain would see.
function Receipt({ tx }: { tx?: string | null }) {
  const rt = session.get().rt;
  if (rt?.mode !== 'sandbox' || !tx) return null;
  const r = rt.engine.receipt(tx); if (!r) return null;
  const rows = (l: [string, string][]) => l.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>);
  return (
    <>
      {(r.proofs || []).map((p, i) => (
        <div key={i} className="vrf"><Icon name="check" /><span><b>Proof verified</b> · {p.circuit} circuit · made in {(p.ms / 1000).toFixed(1)} s on this device · verified in {p.verifyMs} ms against its verifying key</span></div>
      ))}
      {r.seen && (
        <details className="cw" open>
          <summary>What the chain would see</summary>
          <div className="cwg">
            <div className="pb"><b>Public</b><dl>{rows(r.seen.pub)}</dl></div>
            <div className="hd"><b>Hidden</b><dl>{r.seen.hidden.length ? rows(r.seen.hidden) : <div><dd>Nothing</dd></div>}</dl></div>
          </div>
        </details>
      )}
    </>
  );
}
