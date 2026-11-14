// Dip-and-ride: a selective long-only swing bot for cbBTC/USDC 1-minute bars.
//
// Strategy (all thresholds in basis points, 1 bp = 0.01%):
//   - Entry (one position at a time, long only): buy when the latest close is at least
//     DIP_CJ (100 bp) below the highest close of the last DIP_J (20) bars, and the medium
//     trend has not collapsed: EMA(34) of closes is still above the close 20 bars ago less
//     GATE (40 bp). A sharp one-minute air pocket that leaves the medium trend intact is
//     the pool overshooting; the bot buys it and rides the recovery.
//   - Exit, the whole position, decided on a close (filled at the next open):
//     a 25 bp trailing stop from the highest close since entry, armed only once the
//     position is ACT (15 bp) over its fill; or a hard stop at STOP (45 bp) under the fill;
//     or a time stop after HOLD (60) bars. The trailing stop gives a small winner room to
//     become a large one and cuts the tail as soon as it rolls over.
//   - Sizing: SIZE (50%) of equity per trade (the position cap is 100% of equity; half
//     size keeps the pool impact of a fill near 5 bp and the round trip near 22 bp, so the
//     exits need to catch moves bigger than that, which the entry selects for).
//   - Fallback: if the window is so quiet that no entry has fired by bar FALLBACK_AT (1380),
//     one last relaxed entry (DIP_CJ/2, gate bypassed) at FALLBACK_SIZE (5%) of equity:
//     the race guardrail wants at least one filled order, and this costs at most a few
//     cents of fees. On the dev window it never fires.
//
// The round trip pays 4 bps fee + 2 bps slippage per side plus the pool's price impact, so
// the bot trades rarely and only where the entry condition itself demands a move an order
// of magnitude larger than the fixed costs. Every number here is a close-to-close ratio, so
// the price scale cancels; the arithmetic is plain float64 on + - * / < >, correctly rounded
// on every machine, which keeps the two graded executions byte-identical. No clock, no
// environment, no randomness: the only inputs are the harness's hello and batches.

import { runBars, type Bar, type Batch, type BarsState } from './vendor/makefun-bars.ts';

const DIP_CJ = 100; // entry: close this many bp under the DIP_J-bar high close
const DIP_J = 20; // entry lookback bars for the high close
const GATE = 40; // trend gate: EMA34 may sit at most this many bp under the close 20 bars ago
const EMA_SPAN = 34; // the gate's EMA span
const ACT = 15; // trail arms once the position is this many bp over its fill
const TRAIL = 25; // trailing stop: exit when the close falls this many bp off the running high
const STOP = 45; // hard stop: exit when the close is this many bp under the fill
const HOLD = 60; // time stop: exit after this many bars held
const SIZE = 0.5; // fraction of equity per entry
const FALLBACK_AT = 1380; // batch seq from which a never-traded bot takes the relaxed entry
const FALLBACK_CJ = 50; // the relaxed entry's dip depth (DIP_CJ / 2)
const FALLBACK_SIZE = 0.05; // the relaxed entry's size
const MAX_SLIPPAGE_BPS = 200; // order cap: fills beyond 2% against the decision close are refused

// ---- per-run state (fresh process per execution; nothing carries across) ----
let symbol = '';
let priceScale = 1; // price p (wire) is p / 10^priceScale USDC
let ema = 0; // EMA(EMA_SPAN) of closes, wire units
let emaSeeded = false;
const closes: bigint[] = []; // every close seen, wire units (a gap adds nothing)
let posQty = 0n; // held qty (wire units)
let entryFill = 0; // entry fill price, wire units per unit
let entrySeq = -1; // batch the fill landed on
let runHigh = 0; // highest close since the entry signal, wire units
let tradesMade = 0; // entries sent (fills decided on; rejections retry on the next signal)
let pendingBuySignal = false; // an entry decided last batch; wait for its fill

function onBar(bar: Bar, seq: number): void {
  const c = BigInt(bar.c);
  closes.push(c);
  const k = 2 / (EMA_SPAN + 1);
  ema = emaSeeded ? Number(c) * k + ema * (1 - k) : Number(c);
  emaSeeded = true;
  void seq;
}

/** The highest close of the last j bars including this one (wire units). */
function highOfLast(j: number): bigint {
  let h = 0n;
  for (let t = Math.max(0, closes.length - j); t < closes.length; t++) if (closes[t] > h) h = closes[t];
  return h;
}

await runBars({
  onHello(state: BarsState): void {
    const s = state.hello.symbols[0];
    if (s === undefined) throw new Error('empty universe');
    symbol = s.symbol;
    priceScale = 10 ** s.price_scale;
  },

  onBatch(state: BarsState, batch: Batch): Array<{ side: 'buy'; symbol: string; notional_quote_units: bigint; max_slippage_bps: number } | { side: 'sell'; symbol: string; qty: bigint; max_slippage_bps: number }> | null {
    // 1. fold in the events of the orders decided on the previous batch. A buy fill names the
    //    exact entry price; a rejected buy frees the slot for the next signal.
    for (const f of batch.fills) {
      if (f.symbol !== symbol) continue;
      if (f.side === 'buy' && pendingBuySignal) {
        pendingBuySignal = false;
        if (f.status === 'filled') {
          entryFill = Number(f.price);
          entrySeq = batch.seq;
        }
      } else if (f.side === 'sell' && f.status === 'filled') {
        entryFill = 0;
        entrySeq = -1;
        runHigh = 0;
      }
    }

    // 2. fold in this batch's bar (the universe's one symbol; a gap adds nothing).
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return null;
    onBar(bar, batch.seq);

    const held = state.positions.get(symbol);
    posQty = held === undefined ? 0n : BigInt(held.qty);
    const close = BigInt(bar.c);

    // 3. exits first: decide on this close, fill at the next open.
    if (posQty > 0n && entryFill > 0) {
      runHigh = runHigh > close ? runHigh : close;
      const pnlBps = (Number(close) / entryFill - 1) * 10_000;
      const armed = runHigh > (entryFill * (10_000 + ACT)) / 10_000;
      const trailHit = armed && Number(close) <= (Number(runHigh) * (10_000 - TRAIL)) / 10_000;
      const barsHeld = batch.seq - entrySeq;
      if (trailHit || pnlBps <= -STOP || barsHeld >= HOLD) {
        return [{ side: 'sell', symbol, qty: posQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return null;
    }

    // 4. entries: the dip condition against the rolling high, gated by the medium trend.
    if (state.warmingUp || closes.length < Math.max(EMA_SPAN, DIP_J) + 20) return null;
    const high20 = highOfLast(DIP_J);
    const close20 = closes[closes.length - 1 - 20];
    if (close20 === undefined) return null;
    const falling = tradesMade === 0 && batch.seq >= FALLBACK_AT;
    const need = falling ? FALLBACK_CJ : DIP_CJ;
    const dipOk = Number(close) <= (Number(high20) * (10_000 - need)) / 10_000;
    const gateOk = falling || ema >= (Number(close20) * (10_000 - GATE)) / 10_000;
    if (!dipOk || !gateOk) return null;

    const cash = state.cash;
    let spend = BigInt(Math.floor(Number(state.equity) * (falling ? FALLBACK_SIZE : SIZE)));
    if (spend > cash) spend = cash;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return null;
    tradesMade++;
    pendingBuySignal = true;
    runHigh = close; // the running high starts at the signal close; the fill lands near it
    return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
