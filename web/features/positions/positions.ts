'use client';
// This account's positions and limit orders with their live figures: one account-specific query shared by every screen
// (portfolio, pool page, header figures, privacy checks), never persisted. The pools they sit in are read too (one
// batched read), so a card can show its range as prices.
import { engine, useSession } from '@/features/session/session';
import { useChainQuery } from '@/features/session/query';
import type { OrderInfo, OrderRecord, PoolState, PositionInfo, PositionRecord, VeylEngine } from '@/lib/veyl/types';

export type Read<T> = T | { err: string };
export const failed = <T,>(r: Read<T> | undefined): r is { err: string } => !!r && typeof r === 'object' && 'err' in r;

export interface PositionsData {
  positions: PositionRecord[]; orders: OrderRecord[];
  info: Record<string, Read<PositionInfo>>; orderInfo: Record<string, Read<OrderInfo | null>>;
  pools: Record<string, PoolState>;   // by pool address
}
const EMPTY: PositionsData = { positions: [], orders: [], info: {}, orderInfo: {}, pools: {} };

const msg = (e: unknown) => String((e as Error)?.message || e);
async function loadPositions(E: VeylEngine): Promise<PositionsData> {
  const positions = E.myPositions(), orders = E.myOrders().slice().reverse();
  const info: PositionsData['info'] = {}, orderInfo: PositionsData['orderInfo'] = {}, pools: PositionsData['pools'] = {};
  await Promise.all([
    ...positions.map(async (q) => { try { info[q.id] = await E.positionInfo(q); } catch (e) { info[q.id] = { err: msg(e) }; } }),
    ...orders.filter((o) => !o.closed).map(async (o) => { try { orderInfo[o.id] = await E.orderInfo(o); } catch (e) { orderInfo[o.id] = { err: msg(e) }; } }),
    (async () => { // the pools they sit in, in one batched read where the engine has it
      const addrs = [...new Set([...positions, ...orders].map((x) => x.pool))]; if (!addrs.length) return;
      if (E.poolStates) { const got = await E.poolStates(addrs, 1).catch(() => []); addrs.forEach((a, i) => { const g = got[i]; if (g && !(g instanceof Error)) pools[a] = g; }); return; }
      await Promise.all(addrs.map(async (a) => { try { pools[a] = await E.poolState(a, 1); } catch { /* shown as bin numbers */ } }));
    })(),
  ]);
  return { positions, orders, info, orderInfo, pools };
}

const REFRESH_MS = 15_000;
export function usePositions(): { d: PositionsData; loading: boolean } {
  const live = useSession((s) => !!s.rt?.engine && s.rpc !== 'down');
  const r = useChainQuery(['positions'], live ? () => loadPositions(engine()) : null, { initial: EMPTY, intervalMs: REFRESH_MS, account: true });
  return { d: r.data, loading: r.loading };
}

/// A position worth showing: still open, or with fees or rewards left to claim (or not read yet, or unreadable).
export function worthShowing(info: Read<PositionInfo> | undefined): boolean {
  if (!info || failed(info)) return true;
  return info.open || info.fees.x > 0n || info.fees.y > 0n || info.rewards.some((r) => r > 0n);
}
/// Positions visible to this account: shielded and one-time-key positions on this device, public ones it signed.
export const visiblePositions = (d: PositionsData, pool?: string) =>
  d.positions.filter((q) => (!pool || q.pool === pool) && worthShowing(d.info[q.id]));
export const openOrders = (d: PositionsData, pool?: string) => d.orders.filter((o) => !o.closed && (!pool || o.pool === pool));
