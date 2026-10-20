// The browser engine (engine/sol-entry.js, bundled into site/veyl-sol.js as window.Veyl), seen through narrow ports. The UI
// depends on these interfaces only; lib/veyl/runtime.ts is the one place that touches the globals. Each port covers one job,
// so a component asks for what it uses (a pool table needs PoolReadPort, not the whole engine). Only what v2 calls is typed.

export type Sym = string;
export type Base58 = string;

// ---------------------------------------------------------------- config (window.VEYL_CONFIG, or the sandbox's own)
export interface TokenInfo { mint: Base58; decimals: number; pool: Base58 }
/// A pool's fee tier (permissionless pools, part 2): fixed for the pool's life. feePips: 1e-4 % units (500 = 0.05%).
export interface FeeTier { id: number; label?: string; category?: 'stable' | 'major' | 'volatile'; feePips: number; binStep: number }
/// verified: listed by Veyl (or past its bond lock); unverified: new, still under its bond lock; delisted: withdrawals only.
export type PoolStatus = 'verified' | 'unverified' | 'delisted';
export interface PoolConfig {
  id: string; x: Sym; y: Sym; bs: number; base: number; address?: Base58 | null; sealed?: boolean;
  // permissionless pools (part 2); absent for config-listed pools on today's engine
  mintX?: Base58; mintY?: Base58; tier?: FeeTier; status?: PoolStatus; createdAt?: number; creator?: Base58; crowd?: number;
}
export interface RuntimeConfig {
  chainName?: string; rpc: string; explorer?: string | null; explorerSuffix?: string; relayer?: string; sandbox?: boolean;
  programs?: Record<string, Base58>; tokens: Record<Sym, TokenInfo>; binPools: PoolConfig[];
}

// ---------------------------------------------------------------- reads
export interface Pair<T> { x: T; y: T }
export interface Bin { x: bigint; y: bigint; shares: bigint; askX: bigint; bidY: bigint }
export interface PoolReward { index: number; sym: Sym | null; mint: Base58; live: boolean }
/// poolState(addr, span): the bins active ± span, the vaults net of protocol fees, the dynamic fee now.
export interface PoolState {
  address: Base58; x: Sym; y: Sym; binStep: number; baseFee: number; fee: number; active: number;
  reserves: Pair<bigint>; totalFees: Pair<bigint>; seeded?: boolean;
  bins: Record<number, Bin>; protocolShare?: number; rewards: PoolReward[];
  tier?: FeeTier; status?: PoolStatus;   // part 2
}
/// A pool's figures over an interval: the sandbox's poolStats, or poolStatsChain on a real chain (dollar fields can be null).
export interface PoolStats {
  price: number; change: number | null; fee: number; volumeUsd: number | null; feesUsd: number | null; tvlUsd: number | null;
  swaps: number; aprPct: number | null; feeTvlPct: number | null; depth: number | null; score: number | null; ageSec: number | null;
  lpFeesUsd: number | null; spark: number[]; sparkT: number[];
}
export interface ShieldNote { index: number; amount: string | bigint; mint: Base58 }
export interface PendingDeposit { pending: string; mint: Base58; amount: string | bigint }
export interface LegacyNote { sym: Sym; value: string; index: number; precommitment?: string; commitment?: string }
export interface ActivityEntry { t: string; s: string; amt?: string; ts: number }
export interface StoreData {
  activity?: ActivityEntry[]; backedUpAt?: number; notes: unknown[]; positions: unknown[]; orders: unknown[];
  shield?: { orders?: unknown[] }; sandbox?: { funded?: number; seen?: number }; useLocal?: boolean; depositKey?: number[];
}
export interface EngineStore { data: StoreData; ok: boolean; save(): void }
export interface MarketPort { at?: number; error?: unknown; source?: string; tries?: unknown[]; usd(sym: Sym): number | null | undefined; label(sym: Sym): string; on(f: () => void): void; refresh(): Promise<unknown>; why?(): string }
// ---------------------------------------------------------------- external markets (other Solana DEXes, never Veyl's pools)
export interface MarketRow {
  address: Base58; pair: string; dex: string; url: string; explorer: string; at?: number; source?: string; sources?: string[];
  base: { symbol?: string; address?: Base58 }; quote: { symbol?: string; address?: Base58 };
  priceUsd: number | null; priceNative: number | null; liquidityUsd: number | null; feesUsd24h: number | null; aprPct: number | null; ageSec: number | null; txns24h?: number;
  volume: Record<string, number | null | undefined>; change: Record<string, number | null | undefined>; binStep: number | null; feePct: number | null; tickSpacing: number | null;
}
export interface Candle { t: number; o?: number; h?: number; l?: number; c: number }
export interface MarketError { message?: string; retryIn?: number }
export interface MarketsPort {
  state: Record<string, { ok: boolean | null; error?: string | null }>;
  list(o: { limit: number }): Promise<{ rows: MarketRow[]; errors: Record<string, MarketError>; at: number }>;
  search(q: string): Promise<{ rows: MarketRow[]; errors: Record<string, MarketError>; at: number }>;
  detail(address: Base58, timeframe: string, agg: number): Promise<{ candles?: Candle[]; candlesError?: string }>;
}
export interface MarketSources { [id: string]: { name: string; base: string } }

// ---------------------------------------------------------------- ports
export interface UnitsPort {
  tokens: Record<Sym, TokenInfo>;
  fmt(sym: Sym, v: bigint | string): number;
  unit(sym: Sym, v: number | string): bigint;
}
/// A wallet the engine can sign with (engine/wallets.js): a Wallet Standard wallet, or one that only injects a global.
/// `icon` is the data URI the wallet registered with (null for injected ones).
export interface WalletProvider {
  name: string; icon: string | null; standard: boolean; isLocal?: boolean; publicKey?: unknown;
  connect(o?: { silent?: boolean }): Promise<unknown>;
}
/// The wallets in this browser, live: Wallet Standard wallets can register after the page loaded.
export interface WalletDirectory { list(): WalletProvider[]; on(cb: () => void): () => void }
export interface WalletPort {
  account: Base58 | null; isLocal?: boolean; wallet: WalletProvider | null;
  connect(w?: WalletProvider, o?: { silent?: boolean }): Promise<Base58>;
  connectLocal(): Promise<Base58>;
  /// Native SOL (lamports) at the connected address: what pays network fees.
  solBalance(): Promise<bigint>;
  /// The last wallet used here, reconnected without a prompt; null when that isn't possible.
  reconnect(): Promise<Base58 | null>;
  disconnect(): Promise<void>;
  /// cb(account | null) when the wallet switches account or drops the connection. Returns the unsubscribe.
  onAccount(cb: (account: Base58 | null) => void): () => void;
  localSweep(to: Base58): Promise<{ tx: string | null; moved: Sym[] }>;
}
export interface BalancesPort {
  refreshNotes(): Promise<void>;
  privateBalance(sym: Sym): bigint;
  publicBalance(sym: Sym): Promise<bigint>;
}
export interface ShieldPort {
  veylAddress(): string;
  shieldState?: { leaves?: unknown[] } | null;
  shieldNotes(): ShieldNote[];
  shieldPendingNow?: PendingDeposit[];
  shieldError?: string | null;
  legacyNotes(): LegacyNote[];
}
export interface PoolReadPort {
  poolState(addr: Base58, span?: number): Promise<PoolState>;
  /// Every pool's OHLC candles at `res` seconds from the relayer's trade index (bin ids; price them with humanPrice), or
  /// null without one. Optional (newer engines).
  poolCandles?(res: number): Promise<{ at: number; res: number; pools: Record<Base58, [number, number, number, number, number, string, string, number][]> } | null>;
  /// Many pools at once (a few batched requests), in order; an Error where a pool can't be read. Optional (newer engines).
  poolStates?(addrs: Base58[], span?: number): Promise<(PoolState | Error)[]>;
  humanPrice(st: PoolState, id: number): number;
  binForPrice(st: PoolState, human: number): number;
}
/// The shape a range's liquidity takes (engine spelling: 'bidAsk').
export type EngineShape = 'spot' | 'curve' | 'bidAsk';
/// How a position or order is held: in the shielded pool, by a one-time key on this device, or by the wallet in public.
export type HoldingKind = 'shielded' | 'private' | 'public';
export interface PositionRecord { id: string; kind: HoldingKind; pool: Base58; x: Sym; y: Sym; ids: number[]; lo: number; hi: number; shape: EngineShape | 'bidask'; createdAt?: number; tx?: string }
export interface PositionInfo {
  value: Pair<bigint>; fees: Pair<bigint>; rewards: bigint[]; shares: bigint[]; active: number; inRange: boolean; open: boolean; shielded?: boolean;
}
export interface OrderRecord { id: string; kind: HoldingKind; pool: Base58; x: Sym; y: Sym; sym: Sym; amount: string; binId: number; isAsk: boolean; closed?: boolean }
export interface OrderInfo { shares: bigint; unfilledX: bigint; filledY: bigint; unfilledY: bigint; filledX: bigint; filled: boolean }
type Paid = { tx?: string; x: bigint; y: bigint };
export interface PositionsPort {
  myPositions(): PositionRecord[];
  positionInfo(pos: PositionRecord): Promise<PositionInfo>;
  orderInfo(o: OrderRecord): Promise<OrderInfo | null>;
  claimFees(pos: PositionRecord, o: { to: string | null }): Promise<Paid>;
  claimReward(pos: PositionRecord, index: number): Promise<{ tx?: string; amount: bigint; sym: Sym }>;
  removeLiquidity(pos: PositionRecord, pct: number, o: { to: string | null }): Promise<Paid>;
  rebalance(pos: PositionRecord, o: { lo: number; hi: number; shape: EngineShape }): Promise<{ tx?: string }>;
  rebalanceLimit(pos: PositionRecord): Promise<number>;
  withdrawOrder(o: OrderRecord, opt: { to: string | null }): Promise<Paid & { filled?: boolean }>;
}
// ---------------------------------------------------------------- sealed batch swaps
export interface Batch { seq: string; state: string; count: [number, number]; rollovers: number; endSlot: string; totals: string[]; num: string[]; den: string[] }
export interface SealedState {
  enabled: boolean; paused?: boolean; demo?: boolean; slot?: number; slotMs?: number; epochSlots?: string; minIn?: string[]; kMin?: number; maxRollovers?: number;
  batch?: Batch | null; last?: Batch | null; committee?: { t: number; n: number } | null; err?: string;
}
export type SealedSwapState = 'waiting' | 'sealed' | 'claim' | 'refund' | 'claimed' | 'refunded' | 'failed' | 'unknown';
export interface SealedSwap { id: string; pool: Base58; pair: string; x: Sym; y: Sym; seq: string; sym: Sym; other: Sym; amount: bigint; state: SealedSwapState; expect: bigint | null; at: number }
export interface SealedPort {
  sealedState(pool: PoolConfig): Promise<SealedState>;
  sealedSwap(pool: PoolConfig, o: { xIn: boolean; amount: number }): Promise<{ tx?: string; seq: string }>;
  mySealedSwaps(): Promise<SealedSwap[]>;
  sealedClaim(s: SealedSwap): Promise<{ tx?: string; sym: Sym; value: bigint }>;
  proveMs?: Record<string, number[]>;
}
export interface LiquidityPort {
  addLiquidity(pool: PoolConfig, o: { priv: boolean; amountX: number; amountY: number; lo: number; hi: number; shape: EngineShape }): Promise<PositionRecord>;
  zap(pool: PoolConfig, o: { priv: boolean; xIn: boolean; amount: number; lo: number; hi: number; shape: EngineShape }): Promise<PositionRecord>;
  planZapPreview(pool: PoolConfig, o: { xIn: boolean; amount: number; lo: number; hi: number; shape: EngineShape }): Promise<{ swapIn: number; swapOut: number }>;
  placeOrder(pool: PoolConfig, o: { priv: boolean; isAsk: boolean; binId: number; amount: number }): Promise<{ tx?: string }>;
  myOrders(): OrderRecord[];
}
export interface SwapPort {
  quoteRoute(symIn: Sym, symOut: Sym, amountIn: bigint): Promise<Quote | null>;
  swap(symIn: Sym, symOut: Sym, amountIn: number): Promise<{ tx?: string; out: bigint; route: string[] }>;
  swapPublic(symIn: Sym, symOut: Sym, amountIn: number): Promise<{ tx?: string; out: bigint; route: string[] }>;
}
/// The SDK's own distribution maths (window.Veyl.SDK): what the program will put in each bin for a shape.
export interface SdkPort { shapeWeights(ids: number[], active: number, shape: EngineShape): { weightsX: number[]; weightsY: number[] } }
export interface ActionsPort {
  deposit(sym: Sym, amount: number): Promise<{ tx?: string }>;
  withdraw(sym: Sym, amount: number, to: string): Promise<{ tx?: string }>;
  cancelDeposit(d: PendingDeposit): Promise<string>;
  migrate(n: LegacyNote): Promise<{ tx?: string }>;
}
export interface BackupPort {
  store: EngineStore;
  exportEncrypted(pass: string): Promise<string>;
  importEncrypted(text: string, pass: string): Promise<number>;
}
export interface ProgressPort { onLog: (m: string) => void }
/// Safety rails (engine/sol-entry.js): a backup (or an explicit "I understand") before the first real deposit, and hints
/// before private money leaves for a Solana address. The engine enforces the first; the UI shows both.
export interface LinkRisk { id: 'amount' | 'timing' | 'crowd'; text: string }
export interface SafetyPort {
  backupStepNeeded(): boolean;
  ackNoBackup(): number;
  markBackedUp(): number;
  linkRisks(sym: Sym, amount: number | string, to: string): { warnings: LinkRisk[]; tip: { id: string; text: string } };
}
/// A route quote. lpFee / protocolFee (atoms of the input token) and per-hop fees arrive with part 2.
export interface Quote { out: bigint; path: { name: string; out?: Sym; feePips?: number; volatilityPips?: number }[]; lpFee?: bigint; protocolFee?: bigint }

// ---------------------------------------------------------------- permissionless pools (part 2; optional until the engine ships it)
export interface TokenMeta { mint: Base58; symbol: string; name: string; decimals: number; program: 'spl' | 'token2022'; listed: boolean }
export interface TokenCheck { ok: boolean; info: TokenMeta | null; reasons: { code: string; text: string }[] }
export interface BondInfo { amount: bigint; creator: Base58; lockedUntil: number; releasable: boolean; createdAt?: number; mine?: boolean }
export interface PoolsPort {
  listPools?(o?: { includeDelisted?: boolean; fresh?: boolean }): Promise<PoolConfig[]>;
  /// How many pools exist: a cheap signal to re-read the list when someone creates one.
  poolCount?(): Promise<number>;
  tokenInfo?(mint: Base58): Promise<TokenMeta>;
  listTiers?(): Promise<FeeTier[]>;
  checkToken?(mint: Base58): Promise<TokenCheck>;
  poolFor?(mintA: Base58, mintB: Base58, tierId: number): Promise<Base58 | null>;
  createPool?(o: { mintA: Base58; mintB: Base58; tierId: number; price: number }): Promise<{ tx?: string; address: Base58 }>;
  bond?(pool: Base58): Promise<BondInfo | null>;
  /// What creating a pool costs before it exists: the bond and its lock (asked of the engine; not in the agreed spec yet).
  bondTerms?(): Promise<{ amount: bigint; lockDays: number }>;
  releaseBond?(pool: Base58): Promise<{ tx?: string }>;
}
/// A note the engine planned for this account and is waiting to see on chain (the note-delivery outbox).
export interface OutboxEntry { commitment: string; kind: string | null; at: number; tx: string | null; failed: boolean; adopted: boolean }

export interface NetworkPort { ping(): Promise<unknown>; relayerInfo(): Promise<{ address?: string; faucet?: boolean }>; market: MarketPort }

/// Everything both engines (on-chain and sandbox) provide.
export interface VeylEngine extends UnitsPort, WalletPort, BalancesPort, ShieldPort, PoolReadPort, LiquidityPort, SwapPort, PositionsPort, SealedPort, ActionsPort, BackupPort, SafetyPort, PoolsPort, ProgressPort, NetworkPort {
  outboxState?(): OutboxEntry[];
  cfg: RuntimeConfig;
}
/// On a real chain: dollar figures through the market and the pools' own prices, stats from each pool's Swapped events.
export interface ChainSwap { sig: string; t: number; xForY: boolean; x: Sym; y: Sym; amountIn: bigint }
export interface ChainEngine extends VeylEngine {
  recentChain(n: number): ChainSwap[];
  usdMap(states: (PoolState | null)[]): Record<Sym, number>;
  poolStatsChain(addr: Base58, secs: number, st: PoolState, usd: Record<Sym, number>): Promise<PoolStats>;
}
export type SandboxEvent =
  | { type: 'proving'; proving: { circuit: string; stage?: 'fetch' | 'prove'; loaded?: number; total?: number; expect?: number } | null }
  | { type: 'verified'; ok: boolean; verifyMs: number; circuit: string }
  | { type: 'swap' | 'tx' | 'sealed' | 'market' };
export interface SandboxReceipt { proofs?: { circuit: string; ms: number; verifyMs: number }[]; seen?: { pub: [string, string][]; hidden: [string, string][] } }
/// The in-browser chain: its own lifecycle, events, demo funds and receipts.
export interface SandboxEngine extends VeylEngine {
  init(): Promise<void>; start(): void; save(): void; reset(): void;
  on(f: (e: SandboxEvent) => void): () => void;
  faucet(): Promise<unknown>;
  poolStats(addr: Base58, secs: number): PoolStats;
  usdOf(sym: Sym): number | null;
  friendAddress(): string; friendBalance(sym: Sym): bigint; freshAddress(): string;
  receipt(tx: string): SandboxReceipt | null;
  marketInfo(): { live: boolean; asOf: string };
}

export type Mode = 'sandbox' | 'chain' | 'preview';
/// The engine for the current mode. Preview has none: the UI shows the listed pools and can't transact.
/// `deployed`: this site has a deployment config (so On-chain mode can be chosen), whichever mode runs now.
/// protocolFeeBps: the fixed protocol fee on swaps (Engine.PROTOCOL_FEE_BPS, part 2), null on an engine without it.
export type Runtime = { chainName: string; deployed: boolean; sdk: SdkPort | null; protocolFeeBps: number | null; markets: { api: MarketsPort; sources: MarketSources } | null; market: MarketPort | null } & (
  | { mode: 'sandbox'; engine: SandboxEngine; cfg: RuntimeConfig; wallets: null }
  | { mode: 'chain'; engine: ChainEngine; cfg: RuntimeConfig; wallets: WalletDirectory | null }
  | { mode: 'preview'; engine: null; cfg: null; wallets: WalletDirectory | null });
