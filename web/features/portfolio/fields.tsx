'use client';
// What the deposit, send and receive dialogs share: the token picker and the amount field's state.
import { useState } from 'react';
import { Segmented } from '@/components/ui/primitives';
import { cleanAmount } from '@/lib/format';
import { engine } from '@/features/session/session';

export const tokenSyms = (): string[] => Object.keys(engine().tokens);

export function AssetPicker({ id, value, onChange }: { id: string; value: string; onChange: (s: string) => void }) {
  return <Segmented id={id} label="Asset" wrap value={value} onChange={onChange} options={tokenSyms().map((k) => ({ value: k, label: k }))} />;
}

/// A token, an amount typed as text (digits and one dot), and the form's error line.
export function useTokenAmount(initialSym?: string, initialAmount = '') {
  const syms = tokenSyms();
  const [sym, setSym] = useState(initialSym && syms.includes(initialSym) ? initialSym : syms[0]);
  const [text, setText] = useState(initialAmount);
  const [error, setError] = useState('');
  return {
    sym, setSym, text, error, setError,
    value: cleanAmount(text).value,
    onAmount: (t: string) => setText(cleanAmount(t).text),
  };
}
