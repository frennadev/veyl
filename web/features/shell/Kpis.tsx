'use client';
// The header strip: your positions, fees earned and on-chain liquidity (on a real chain), and SOL's market price with its
// source and age. The Sandbox and preview show the SOL price only.
import { useEffect, useState, type ReactNode } from 'react';
import { failed, usePositions } from '@/features/positions/positions';
import { positionUsd } from '@/features/positions/PositionCards';
import { usePoolTotals } from '@/features/pools/usePoolViews';
import { useSession } from '@/features/session/session';
import { useMarketTick } from '@/features/market/market';
import { tiny, usd } from '@/lib/format';
import { Tip } from '@/components/ui/primitives';
import type { Term } from '@/lib/glossary';

const LABEL_REFRESH_MS = 5000;
const Kpi = ({ label, id, term, children }: { label: string; id?: string; term?: Term; children: ReactNode }) => <div className="kpi" id={id}><span>{label}{term && <Tip term={term} align="l" />}</span><b>{children}</b></div>;

export function Kpis() {
  const rt = useSession((s) => s.rt);
  const [, bump] = useState(0);
  useMarketTick();
  useEffect(() => { const t = setInterval(() => bump((n) => n + 1), LABEL_REFRESH_MS); return () => clearInterval(t); }, []); // "· 12 s ago"
  const { d } = usePositions();
  const tvl = usePoolTotals();
  const m = rt?.market, sol = m?.usd('SOL');
  const solKpi = sol ? (
    <Kpi label="SOL" id="kpiSol" term="solPrice">${tiny(sol)}<em className="dim" title="Live market price">{m!.label('SOL')}</em></Kpi>
  ) : null; // no made-up price: without one there is no SOL tile (the mode chip explains why on hover)
  if (rt?.mode !== 'chain') return <div className="kpis" id="kpis" aria-label="Overview">{solKpi}</div>;
  const mine = d.positions.filter((q) => { const i = d.info[q.id]; return !i || failed(i) || i.open; });
  let fees = 0, feesKnown = true;
  for (const q of d.positions) { const i = d.info[q.id]; if (!i || failed(i)) continue; const u = positionUsd(q, i); if (u) fees += u.f; else feesKnown = false; }
  return (
    <div className="kpis" id="kpis" aria-label="Overview">
      <Kpi label="Your positions" term="positions">{mine.length}</Kpi>
      <Kpi label="Fees earned" term="feesEarned">{feesKnown ? usd(fees) ?? '—' : '—'}</Kpi>
      <Kpi label="TVL · on-chain" term="tvlOnchain">{tvl != null ? usd(tvl) : '—'}</Kpi>
      {solKpi}
    </div>
  );
}
