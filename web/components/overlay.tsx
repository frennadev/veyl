'use client';
// The app's one dialog and its toasts. openModal(<Dialog/>) from anywhere; the dialog renders inside the app's providers, so
// it can use hooks. Same markup and ids as the legacy page (#modal, #dlgX, #dlgBody, #toasts) so app.css and the e2e suites
// apply unchanged. While an action runs (session.busy) the dialog can't be closed.
import { useEffect, useRef, type ReactNode } from 'react';
import { createStore, useStore } from '@/lib/store';
import { session, useSession } from '@/features/session/session';
import { Icon, type IconName } from '@/components/ui/primitives';

// ---------------------------------------------------------------- dialog
const modal = createStore<{ node: ReactNode | null; key: number }>({ node: null, key: 0 });
let lastFocus: HTMLElement | null = null;

export function openModal(node: ReactNode) {
  if (!modal.get().node) lastFocus = document.activeElement as HTMLElement | null;
  modal.set((s) => ({ node, key: s.key + 1 }));
}
export function closeModal() {
  if (session.get().busy || !modal.get().node) return;
  modal.set({ node: null }); lastFocus?.focus?.();
}
export const isModalOpen = () => !!modal.get().node;

export function Modal() {
  const { node, key } = useStore(modal, (s) => s);
  const busy = useSession((s) => s.busy);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!node || !body.current) return;
    const first = [...body.current.querySelectorAll<HTMLElement>('input,button,select,textarea,a[href]')].find((el) => !el.matches(':disabled') && el.getClientRects().length > 0);
    if (first && matchMedia('(min-width:900px)').matches) first.focus(); else { const x = document.getElementById('dlgX'); if (x && !x.hidden) x.focus(); else body.current.focus(); }
  }, [key, node]);
  useEffect(() => {
    if (!node) return;
    const overlay = document.getElementById('modal');
    if (!overlay) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const siblings = [...document.body.querySelectorAll<HTMLElement>('main, .side, .hdr, .bnav, .statebar')].filter((el) => !el.contains(overlay));
    const previous = siblings.map((el) => el.inert);
    siblings.forEach((el) => { el.inert = true; });
    const focusables = () => [...overlay.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
      .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0);
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const all = focusables(), first = all[0], last = all[all.length - 1];
      if (!first) { e.preventDefault(); body.current?.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      document.body.style.overflow = previousOverflow;
      siblings.forEach((el, i) => { el.inert = previous[i]; });
      if (!modal.get().node) lastFocus?.focus?.();
    };
  }, [!!node]);
  return (
    <div className="ov" id="modal" hidden={!node} onPointerDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
        <div className="grab" aria-hidden="true"></div>
        <button className="x" id="dlgX" type="button" aria-label="Close" hidden={busy} onClick={closeModal}><Icon name="x" size="sm" /></button>
        <div id="dlgBody" ref={body} key={key} tabIndex={-1}>{node}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts
interface Toast { id: number; msg: string; icon: IconName }
const toasts = createStore<{ list: Toast[] }>({ list: [] });
let toastId = 0;
const TOAST_MAX = 2;

export function toast(msg: string, icon: IconName = 'check', ms = 3800) {
  const t = { id: ++toastId, msg, icon };
  toasts.set((s) => ({ list: [...s.list, t].slice(-TOAST_MAX) }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((x) => x.id !== t.id) })), ms);
}

export function Toasts() {
  const { list } = useStore(toasts, (s) => s);
  return <div id="toasts" aria-live="polite">{list.map((t) => <div key={t.id} className="toast"><Icon name={t.icon} /><span>{t.msg}</span></div>)}</div>;
}

export function copyText(text: string, msg = 'Copied') {
  const fail = () => toast('Copy is blocked here. Select the text to copy it.', 'alert');
  try { navigator.clipboard.writeText(text).then(() => toast(msg), fail); } catch { fail(); }
}
