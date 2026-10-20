'use client';
// The small building blocks every v2 screen uses, with app.css's classes: icons, token marks, the dash for a missing figure,
// segmented buttons, form fields, hints. One definition each (app.js rebuilt these as strings in every dialog).
import { useState, type ReactNode } from 'react';
import { tokenLogo } from '@/lib/tokens';
import { iconUrl, useRemoteToken } from '@/features/tokens/tokenData';
import { tl } from '@/features/pools/label';
import { GLOSSARY, type Term } from '@/lib/glossary';
export type IconName = 'shield' | 'lock' | 'key' | 'eye' | 'eyeoff' | 'back' | 'right' | 'x' | 'search' | 'check' | 'alert' | 'down' | 'qr' | 'up'
  | 'wallet' | 'bars' | 'clock' | 'swap' | 'globe' | 'menu' | 'book' | 'seal' | 'filter' | 'cols' | 'ext' | 'bolt';

export function Icon({ name, size }: { name: IconName; size?: 'sm' }) {
  return <svg className={size ? 'ic ' + size : 'ic'}><use href={'#i-' + name} /></svg>;
}

/// A token's logo: Jupiter's (fetched through our relayer, preloaded for every visitor alike) when there is one, else the
/// bundled or drawn mark. `sym` is the token's key (a listed symbol or a mint); the drawn fallback uses its label.
export function TokenLogo({ sym, className = 'tok', size }: { sym: string; className?: string; size?: number }) {
  const remote = useRemoteToken(sym);
  const [failed, setFailed] = useState(false);
  // no logo: a listed token's own mark; any other token (keyed by its mint) a drawn mark from its symbol, never a brand's
  const listed = !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sym);
  const src = (!failed && iconUrl(remote)) || (listed ? tokenLogo(tl(sym)) : tokenLogo(remote?.symbol || tl(sym), { brand: false }));
  return <img className={className} src={src} alt="" style={size ? { width: size, height: size } : undefined} onError={() => setFailed(true)} />;
}
export function PairLogo({ x, y }: { x: string; y: string }) {
  return <span className="pairlogo"><TokenLogo sym={x} className="" /><TokenLogo sym={y} className="" /></span>;
}

/// A figure, or the dash for one that isn't known.
export const Dash = () => <span className="dim">—</span>;
export const OrDash = ({ v }: { v: ReactNode | null | undefined }) => (v == null || v === '' ? <Dash /> : <>{v}</>);
export const Skeleton = ({ width, style }: { width: number | string; style?: React.CSSProperties }) => <span className="skel" style={{ width, ...style }} />;

export interface SegOption<T extends string> { value: T; label: ReactNode; id?: string }
/// A row of toggle buttons (aria-pressed), app.css's .seg.
/// `dataKey` names the data attribute each button carries its value in (data-a, data-side, data-o, …), as the markup did.
export function Segmented<T extends string>({ id, options, value, onChange, label, className = 'seg full', wrap, dataKey = 'a' }:
  { id?: string; options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string; wrap?: boolean; dataKey?: string }) {
  return (
    <div className={className} id={id} role="group" aria-label={label} style={wrap ? { flexWrap: 'wrap' } : undefined}>
      {options.map((o) => (
        <button key={o.value} type="button" id={o.id} {...{ ['data-' + dataKey]: o.value }} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ id, label, hint, hintId, children }: { id: string; label: ReactNode; hint?: ReactNode; hintId?: string; children: ReactNode }) {
  return <div className="fld"><label htmlFor={id}>{label}</label>{children}{(hint !== undefined || hintId) && <small id={hintId}>{hint}</small>}</div>;
}

export function Hint({ icon, children, id, tone }: { icon: IconName; children: ReactNode; id?: string; tone?: 'warn' }) {
  return <p className={tone ? 'hint ' + tone : 'hint'} id={id}><Icon name={icon} /><span>{children}</span></p>;
}

/// The red line under a form; renders even when empty so the layout doesn't jump (as the legacy dialogs did).
export const ErrorLine = ({ id, children }: { id: string; children?: ReactNode }) => <p className="err" id={id}>{children}</p>;

export function Banner({ icon, title, tone, children }: { icon: IconName; title: ReactNode; tone?: 'bad' | 'warn'; children?: ReactNode }) {
  return <div className={'banner' + (tone ? ' ' + tone : '')}><Icon name={icon} /><div><b>{title}</b>{children}</div></div>;
}

/// An "i" badge that explains a term in plain words (lib/glossary.ts) on hover, tap or keyboard focus. `align`: where the
/// bubble opens from (centred by default; 'l' / 'r' for badges near a left / right edge).
export function Tip({ term, align }: { term: Term; align?: 'l' | 'r' }) {
  const text = GLOSSARY[term];
  return <span className={'tip inl' + (align ? ' a' + align : '')} tabIndex={0} role="note" aria-label={text} data-tip={text}
    onClick={(e) => { e.stopPropagation(); e.preventDefault(); }} />;
}
