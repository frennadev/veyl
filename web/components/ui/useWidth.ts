'use client';
// The rendered width of an element, kept current with a ResizeObserver (charts draw in pixels, as the legacy app did).
import { useEffect, useRef, useState } from 'react';

export function useWidth<T extends Element>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback)); ro.observe(el); setW(el.clientWidth || fallback);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w] as const;
}
