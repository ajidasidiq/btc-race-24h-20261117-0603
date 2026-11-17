// Amba BTC Bot — a slow dip-buying swing bot for the cbBTC/USDC 1-minute race.
//
// Idea, tuned on the published dev window: on this pool BTC spends most of a
// day chopping inside a ~2% range, and a full-size round trip costs roughly
// 35 bps (4 bps fee + 2 bps slippage + ~12 bps of pool impact each way), so
// fast signals on 1-minute bars are all noise after costs — every quick
// EMA-cross / RSI / breakout variant I backtested lost money on the dev
// window. What wins is patience: buy only a real dip, sell only a real
// rally, and sit in cash the rest of the time.
//
// Rules (all comparisons in exact integer price units, no floats):
//   - Reference price = the close of the first tradable bar of the window.
//   - BUY (all cash) when the latest close is at least 60 bps below the
//     reference. No momentum confirmation: on the dev data requiring the
//     price to already be turning up halved the profit (it waits out the
//     cheapest fills). A dip that deep is rare, so the bot trades a few
//     times per day at most.
//   - SELL (whole position) when the latest close is 150 bps above the
//     entry fill price (take profit) or 100 bps below it (hard stop).
//   - Never open a new position in the last 60 bars: a buy that late has no
//     time to reach its target before the forced flatten at the close.
//   - One position at a time, long only, full size. max_slippage_bps 100:
//     1-minute closes almost never move that far, so fills are not rejected
//     on ordinary bars.
//
// Dev-window backtest (exact fill model: fee 4 bps, slippage 2 bps,
// constant-product impact against each bar's open depth): +29.78 USDC on
// 4 trades (2 round trips), max drawdown 0.66%. Buy-and-hold on the same
// window made +1.07 USDC, and every fast-signal variant lost $35-$167.
//
// Deterministic: no clock, no environment, no randomness — the orders are a
// pure function of the bars seen so far, so two runs agree byte for byte.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";

// 60 bps below the reference close = a buy; 150 bps above entry = take
// profit; 100 bps below entry = stop loss. All in basis points.
const DIP_BPS = 60n;
const TAKE_PROFIT_BPS = 150n;
const STOP_LOSS_BPS = 100n;
const BPS = 10_000n;

// Do not open a new position once the bar counter is this far in: both the
// dev window and the race window are 1,440 one-minute bars.
const LAST_BUY_SEQ = 1380;

// Slippage budget per order, in bps from the latest close. A 1-minute bar
// essentially never moves 100 bps, so this only guards against freak bars.
const MAX_SLIPPAGE_BPS = 100;

// Minimum cash worth deploying: the harness refuses buys under 1 USDC.
const MIN_BUY_QUOTE_UNITS = 1_000_000n;

interface BotMemory {
  // Close of the first tradable bar; null until the first bar arrives.
  referenceClose: bigint | null;
  // Fill price of the open position (price-scale units); null when flat.
  entryPrice: bigint | null;
}

const memory: BotMemory = { referenceClose: null, entryPrice: null };

function decide(state: BarsState, batch: Batch): OrderInput[] {
  // Learn from the fills the harness reports for the previous batch first:
  // a filled buy sets the entry price, a filled sell clears it.
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== "filled") continue;
    if (fill.side === "buy") memory.entryPrice = BigInt(fill.price);
    if (fill.side === "sell") memory.entryPrice = null;
  }

  if (state.warmingUp) return [];
  const close = state.close(SYMBOL);
  if (close === null) return [];

  // Anchor the reference on the first tradable bar of the window.
  if (memory.referenceClose === null) memory.referenceClose = close;

  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : held.qty;

  if (qty > 0n) {
    // Holding: exit on take profit or hard stop, measured from the entry
    // fill price (fees included in the fill price already). If the fill
    // record was ever missed, fall back to the position's recorded cost:
    // price = cost_quote_units * 10^(qty_scale + price_scale) /
    // (qty * 10^quote_scale) = cost * 10^7 / qty in price-scale units.
    let entry = memory.entryPrice;
    if (entry === null) {
      const cost = held.cost;
      if (cost > 0n) entry = (cost * 10_000_000n) / qty;
    }
    if (entry !== null) {
      const profitTake = close * BPS >= entry * (BPS + TAKE_PROFIT_BPS);
      const stoppedOut = close * BPS <= entry * (BPS - STOP_LOSS_BPS);
      if (profitTake || stoppedOut) {
        return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  }

  // Flat: buy the dip, full size, unless the window is nearly over.
  const dipped = close * BPS <= memory.referenceClose * (BPS - DIP_BPS);
  if (dipped && state.seq < LAST_BUY_SEQ && state.cash >= MIN_BUY_QUOTE_UNITS) {
    const spend = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    if (spend >= MIN_BUY_QUOTE_UNITS) {
      return [{ side: "buy", symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
  }
  return [];
}

await runBars({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
