# dip-and-ride — a cbBTC/USDC 1-minute-bar trading bot

A long-only, single-asset swing bot for the make.fun bars-replay harness
(`agent-fun/bars-replay/v1`). It starts with 1,000 USDC of paper money, reads one
1-minute cbBTC bar per batch from stdin, and answers with buy/sell orders.

## The strategy

Every parameter is in basis points (1 bp = 0.01%). The bot holds **at most one
position** and is flat most of the time; it trades rarely because a full round
trip costs 4 bps fee + 2 bps slippage per side plus the pool's price impact
(roughly 12 bps fixed plus ~2 x size/depth), so only moves many times that size
can pay.

**Entry** (buy, 50% of equity): the latest close is at least **100 bp** below the
highest close of the last **20 bars** (a real air pocket in the pool price), and
the medium trend has **not** collapsed: `EMA(34)` of closes is still above the
close **20 bars ago** less **40 bp**. The first condition buys the overshoot; the
second keeps the bot out of genuine crashes — on a falling window the gate blocks
most dip entries and the bot sits in cash, which is what keeps a long-only bot
alive through a downtrend.

**Exit** (the whole position, decided on a close, filled at the next open): a
**25 bp trailing stop** from the highest close since entry, armed only once the
position is **15 bp** over its actual fill price; or a hard stop at **-45 bp**
under the fill; or a **time stop** after **60 bars**. The trailing stop lets a
small winner grow and cuts as soon as the recovery rolls over.

**Fallback**: if no entry has fired by bar **1380** of the 1440-bar window, one
relaxed entry (50 bp dip, gate bypassed) at **5%** of equity. The race guardrail
needs at least one filled order; on quiet windows this costs cents of fees and
guarantees the bot keeps meeting the bar. On the dev window it never fires.

**Slippage cap**: orders carry `max_slippage_bps: 200` — a fill further than 2%
from the decision close is refused by the replay and the decision re-fires on a
later bar.

## Why these numbers

They were chosen on the published frozen dev window (1,440 one-minute bars
ending at the competition opening) under three constraints, then checked for
robustness:

1. Profitable on the **first half and second half** of the window separately
   (+2.53 / +1.96 USDC in the offline simulator, size 0.5), not just in total;
2. Profitable on the **time-reversed** window (a rising market), so the strategy
   is not a short-fitted bet on one falling day;
3. Insensitive to one-step parameter perturbations (the profitable neighborhood
   is a plateau, not a spike: dip depth 80-110 bp, gate 30-50 bp, hold 45-90
   bars, size 0.4-0.6 of equity all stay positive).

An in-sample oracle upper bound (dynamic program with the same costs) says this
window admits about +6.7% for a perfect causal-lookahead forecaster at full size
and +16% at 10% size, so the dev gate is genuinely hard: the four house
baselines all lose money on it (-49 to -109 USDC). This bot clears it with
margin while keeping max drawdown near half a percent.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only; runs via
  `node /bot/main.ts` through Node's type stripping).
- `vendor/makefun-bars.ts` — the kit's SDK shim, byte-identical to
  `sdk/makefun-bars.ts` in the competition kit.
- `LICENSE` — MIT.
- `REPORT.md` — every local grade run and the final dev score.

## Determinism

No clock, no environment, no randomness. The strategy is float64 arithmetic
(`+ - * / < >`) over closes the harness sent, and every order is a BigInt amount
derived from the account the harness reports. Two executions over the same data
produce byte-identical action logs (verified by the kit's `grade-local`).
