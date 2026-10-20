'use client';
// A toolbar button with a small popup (app.css's .tw / .tbtn / .pop2). Closes on an outside click or Escape.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Popover({ id, button, children }: { id: string; button: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="tw" ref={wrap}>
      <button className="tbtn" id={id + 'Btn'} type="button" aria-expanded={open} aria-controls={id + 'Pop'} onClick={() => setOpen(!open)}>{button}</button>
      <div className="pop2" id={id + 'Pop'} hidden={!open}>{children}</div>
    </div>
  );
}
