// Completion Ride: a paper-trading bot for the pump.fun replay sprint.
//
// Idea in one paragraph: most pump.fun curves die young, but the ones that
// attract sustained buying late in their life — real reserves already deep,
// net flow still positive over the last half minute — tend to keep running
// toward completion. This bot waits for exactly that shape, rides it with a
// modest fixed size, and gets out quickly when the move stalls, reverses,
// or simply takes too long.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------
// Tunables, named after the job each one does.
// ---------------------------------------------------------------------------

const FLOW_WINDOW_SECONDS = 150; // how much trade history we keep per mint
const FLOW_RECENT_SECONDS = 30; // the window the entry/exit flow sums use
const MIN_REAL_RESERVES_LAMPORTS = 55n * LAMPORTS_PER_SOL; // curve must be deep
const MIN_ENTRY_FLOW_SOL = 0.5; // net signed flow over 30s needed to enter
const EXIT_FLOW_SOL = -3; // net signed flow over 30s that forces an exit
const MAX_POSITION_LAMPORTS = LAMPORTS_PER_SOL; // 1 SOL per position
const MIN_POSITION_LAMPORTS = LAMPORTS_PER_SOL / 5n; // skip dust-sized caps
const CASH_BUFFER_LAMPORTS = 2_000_000n; // keep a little cash uncommitted
const MAX_OPEN_POSITIONS = 5;
const BUY_SLIPPAGE_BPS = 1200;
const SELL_SLIPPAGE_BPS = 2500;

const STOP_LOSS_GAIN = -0.12; // cut losers early
const PEAK_ARM_GAIN = 0.3; // trailing exit arms once peak gain reaches this
const PEAK_GIVEBACK = 0.18; // ... and fires after an 18% fall from the peak
const MOON_GAIN = 1.6; // take everything off at +160%
const HALF_TAKE_GAIN = 0.6; // sell half once at +60%
const STALL_SECONDS = 60; // after a minute, a flat curve is a dead curve
const STALL_RESERVE_RATIO = 1.05; // "flat" = reserves within 5% of entry
const MAX_HOLD_SECONDS = 300; // hard time stop

// ---------------------------------------------------------------------------
// Per-mint flow memory: a short list of (event second, signed lamports).
// Buys count positive, sells negative, so the sum is net demand.
// ---------------------------------------------------------------------------

interface FlowPoint {
  ts: number;
  signed: bigint;
}

const flowByMint = new Map<Pubkey, FlowPoint[]>();
const latestTsByMint = new Map<Pubkey, number>();

function recordTrade(mint: Pubkey, ts: number, signed: bigint): void {
  let list = flowByMint.get(mint);
  if (list === undefined) {
    list = [];
    flowByMint.set(mint, list);
  }
  list.push({ ts, signed });
  const prev = latestTsByMint.get(mint);
  if (prev === undefined || ts > prev) latestTsByMint.set(mint, ts);
  const latest = latestTsByMint.get(mint) as number;
  // Drop points that fell out of the trailing window for this mint.
  while (list.length > 0 && list[0].ts < latest - FLOW_WINDOW_SECONDS) {
    list.shift();
  }
}

// Net signed flow, in SOL, over the last FLOW_RECENT_SECONDS before the
// mint's most recent trade. Returns 0 when we have seen nothing.
function flow30(mint: Pubkey): number {
  const list = flowByMint.get(mint);
  const latest = latestTsByMint.get(mint);
  if (list === undefined || latest === undefined) return 0;
  const cutoff = latest - FLOW_RECENT_SECONDS;
  let sum = 0n;
  for (const point of list) {
    if (point.ts >= cutoff) sum += point.signed;
  }
  return Number(sum) / Number(LAMPORTS_PER_SOL);
}

// ---------------------------------------------------------------------------
// Position bookkeeping: what we knew when the position first showed up.
// ---------------------------------------------------------------------------

interface TrackedPosition {
  entryTs: number;
  entryRealQuoteReserves: bigint;
  entryPrice: number;
  peakPrice: number;
  halfSold: boolean;
}

const tracked = new Map<Pubkey, TrackedPosition>();
const everEntered = new Set<Pubkey>();

function curvePrice(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

// ---------------------------------------------------------------------------
// The bot itself.
// ---------------------------------------------------------------------------

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // 1. Learn from this batch's trades before deciding anything.
    const touched = new Set<Pubkey>();
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      const ts = Number(event.timestamp);
      const amount = BigInt(event.quote_amount);
      recordTrade(event.mint, ts, event.is_buy ? amount : -amount);
      touched.add(event.mint);
    }

    const orders: OrderInput[] = [];

    // 2. Register positions the first time they appear in the account.
    for (const [mint, holding] of state.positions) {
      if (tracked.has(mint)) continue;
      const curve = state.curves.get(mint);
      const price = curvePrice(state, mint);
      tracked.set(mint, {
        entryTs: latestTsByMint.get(mint) ?? 0,
        entryRealQuoteReserves: curve ? curve.real_quote_reserves : 0n,
        entryPrice:
          holding.token_amount > 0n
            ? Number(holding.cost_lamports) / Number(holding.token_amount)
            : price,
        peakPrice: price,
        halfSold: false,
      });
    }
    // Forget positions that are gone so stale state never drives an order.
    for (const mint of [...tracked.keys()]) {
      if (!state.positions.has(mint)) tracked.delete(mint);
    }

    // 3. Exits first: protecting capital outranks opening anything new.
    const sellPending = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') sellPending.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      const info = tracked.get(mint);
      const curve = state.curves.get(mint);
      if (info === undefined || curve === undefined) continue;
      if (curve.complete || sellPending.has(mint)) continue;

      const price = curvePrice(state, mint);
      if (price > info.peakPrice) info.peakPrice = price;
      if (info.entryPrice <= 0 || price <= 0) continue;

      const gain = price / info.entryPrice - 1;
      const peakGain = info.peakPrice / info.entryPrice - 1;
      const latest = latestTsByMint.get(mint) ?? info.entryTs;
      const heldSeconds = latest - info.entryTs;
      // Compare in integer percent so the ratio constant stays exact.
      const stallPercent = BigInt(Math.round(STALL_RESERVE_RATIO * 100));
      const reservesFlat =
        curve.real_quote_reserves * 100n <= info.entryRealQuoteReserves * stallPercent;

      const sellAll =
        gain <= STOP_LOSS_GAIN ||
        (peakGain >= PEAK_ARM_GAIN && price <= info.peakPrice * (1 - PEAK_GIVEBACK)) ||
        gain >= MOON_GAIN ||
        flow30(mint) <= EXIT_FLOW_SOL ||
        (heldSeconds >= STALL_SECONDS && reservesFlat) ||
        heldSeconds >= MAX_HOLD_SECONDS;

      if (sellAll) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      } else if (gain >= HALF_TAKE_GAIN && !info.halfSold) {
        const half = holding.token_amount / 2n;
        if (half > 0n) {
          info.halfSold = true;
          orders.push({
            side: 'sell',
            mint,
            token_amount: half,
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          });
        }
      }
    }

    // 4. Entries: only mints that traded in this batch, only once each, ever.
    const openLimit = Math.min(MAX_OPEN_POSITIONS, state.hello.caps.max_open_positions);
    let committed = state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (committed >= openLimit) break;
      if (everEntered.has(mint) || state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVES_LAMPORTS) continue;
      if (flow30(mint) < MIN_ENTRY_FLOW_SOL) continue;

      const cap = state.maxBuyLamports(mint);
      const size = cap < MAX_POSITION_LAMPORTS ? cap : MAX_POSITION_LAMPORTS;
      if (size < MIN_POSITION_LAMPORTS) continue;
      if (state.freeCashLamports() < size + CASH_BUFFER_LAMPORTS) continue;

      everEntered.add(mint);
      committed += 1;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
    }

    // 5. The harness caps orders per batch; exits are already at the front.
    return orders.slice(0, state.hello.caps.max_orders_per_batch);
  },
});
