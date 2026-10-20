'use client';
// A pool's listing status where it isn't simply verified: Unverified (new, under its creator's bond lock) or Delisted
// (withdrawals only). Renders nothing for verified pools and on engines that don't report a status.
import { Icon, Tip } from '@/components/ui/primitives';
import type { PoolStatus } from '@/lib/veyl/types';

export function PoolBadge({ status, tip = true }: { status?: PoolStatus; tip?: boolean }) {
  if (status === 'unverified') return <span className="pill warn">Unverified{tip && <Tip term="unverified" align="r" />}</span>;
  if (status === 'delisted') return <span className="pill flat"><Icon name="alert" />Delisted{tip && <Tip term="delisted" align="r" />}</span>;
  return null;
}
