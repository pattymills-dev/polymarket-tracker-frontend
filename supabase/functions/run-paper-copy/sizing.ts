// ─── Quarter-Kelly sizing ────────────────────────────────────────────────────
// Uses the trader's entry price as a proxy for "true probability" and applies
// a small edge premium derived from their historical ROI.  Quarter Kelly (0.25)
// is used so variance stays manageable while still scaling with conviction.
export type KellyStakeInputs = {
  sourcePrice: number;            // Trader's entry price → proxy for true prob
  roiEdge: number;                // Trader's 30d realized ROI (e.g. 0.23 = 23%)
  kellyFraction: number;          // 0.25 = Quarter Kelly
  minUsd: number;                 // Floor stake (never bet less than this)
  maxUsd: number;                 // Ceiling stake (never bet more than this)
  equityUsd: number;              // Current portfolio equity
  maxTotalExposurePct?: number | null;
  maxTraderExposurePct?: number | null;
  marketExposureCapPct?: number | null;
  currentOpenExposureTotal: number;
  currentOpenExposureForTrader: number;
  currentOpenExposureForMarket?: number | null;
};

export function computeKellyUsdSize(inputs: KellyStakeInputs): SizingResult {
  const { sourcePrice, roiEdge, kellyFraction, minUsd, maxUsd, equityUsd } = inputs;

  // Fall back to min stake for degenerate prices
  if (!Number.isFinite(sourcePrice) || sourcePrice <= 0.01 || sourcePrice >= 0.99) {
    return { usdSize: roundUsd(Math.max(minUsd, 0)), reason: "kelly_price_out_of_range" };
  }

  // Edge premium: a trader with 20% ROI adds ~3% to their true probability.
  // Capped at 8% to prevent over-sizing on very high-ROI traders.
  const edgePremium = Math.max(0, Math.min(roiEdge * 0.15, 0.08));
  const pTrue = Math.min(0.97, sourcePrice + edgePremium);
  const qTrue = 1 - pTrue;

  // Payout ratio: net profit per dollar staked if correct
  const b = (1 - sourcePrice) / sourcePrice;

  // Full Kelly fraction, floored at 0 (never bet on negative-edge trades)
  const fullKelly = Math.max(0, (pTrue * b - qTrue) / b);

  // Payout ratio guard: scale down Kelly when potential win < 25% of stake.
  // Without this, high-ROI traders betting at 0.85+ get outsized stakes even
  // though a loss wipes out many small wins (e.g. stake $91 to win $11).
  const minPayoutRatio = 0.25; // require potential win >= 25% of stake
  const payoutScale = b < minPayoutRatio ? b / minPayoutRatio : 1;

  const kellyF = fullKelly * kellyFraction * payoutScale;

  // Propose stake as % of equity, clamped to [min, max]
  const proposed = Math.min(maxUsd, Math.max(minUsd, equityUsd * kellyF));

  // Apply exposure caps (same logic as fixed stake)
  const equity = Number.isFinite(equityUsd) ? equityUsd : 0;
  const openTotal = Math.max(0, inputs.currentOpenExposureTotal ?? 0);
  const openTrader = Math.max(0, inputs.currentOpenExposureForTrader ?? 0);
  const openMarket = Math.max(0, inputs.currentOpenExposureForMarket ?? 0);

  if (equity > 0) {
    const traderCapPct = inputs.maxTraderExposurePct ?? null;
    if (traderCapPct != null && Number.isFinite(traderCapPct) && traderCapPct > 0) {
      const remaining = traderCapPct * equity - openTrader;
      if (proposed > remaining) return { usdSize: 0, reason: "trader_exposure_cap" };
    }
    const marketCapPct = inputs.marketExposureCapPct ?? null;
    if (marketCapPct != null && Number.isFinite(marketCapPct) && marketCapPct > 0) {
      const remaining = marketCapPct * equity - openMarket;
      if (proposed > remaining) return { usdSize: 0, reason: "market_exposure_cap" };
    }
    const totalCapPct = inputs.maxTotalExposurePct ?? null;
    if (totalCapPct != null && Number.isFinite(totalCapPct) && totalCapPct > 0) {
      const remaining = totalCapPct * equity - openTotal;
      if (proposed > remaining) return { usdSize: 0, reason: "total_exposure_cap" };
    }
  }

  return { usdSize: roundUsd(proposed) };
}
// ─────────────────────────────────────────────────────────────────────────────

export type TraderSizingSettings = {
  copyFactor: number;
  minUsd: number;
  maxUsd?: number | null;
  maxTraderExposurePct?: number | null;
};

export type PortfolioSizingSettings = {
  equityUsd: number;
  maxTradeRiskPct?: number | null;
  maxTotalExposurePct?: number | null;
  marketExposureCapPct?: number | null;
};

export type SizingInputs = {
  portfolio: PortfolioSizingSettings;
  trader: TraderSizingSettings;
  sourceTradeUsd: number;
  currentOpenExposureTotal: number;
  currentOpenExposureForTrader: number;
  currentOpenExposureForMarket?: number | null;
};

export type SizingResult = {
  usdSize: number;
  reason?: string;
};

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export type FixedStakeInputs = {
  fixedUsd: number;
  equityUsd: number;
  maxTradeRiskPct?: number | null;
  maxTotalExposurePct?: number | null;
  marketExposureCapPct?: number | null;
  maxTraderExposurePct?: number | null;
  currentOpenExposureTotal: number;
  currentOpenExposureForTrader: number;
  currentOpenExposureForMarket?: number | null;
};

export function computeFixedStakeUsdSize(inputs: FixedStakeInputs): SizingResult {
  const fixedUsd = inputs.fixedUsd;
  if (!Number.isFinite(fixedUsd) || fixedUsd <= 0) {
    return { usdSize: 0, reason: "invalid_fixed_stake" };
  }

  const equity = Number.isFinite(inputs.equityUsd) ? inputs.equityUsd : 0;
  const openTotal = Math.max(0, inputs.currentOpenExposureTotal ?? 0);
  const openTrader = Math.max(0, inputs.currentOpenExposureForTrader ?? 0);
  const openMarket = Math.max(0, inputs.currentOpenExposureForMarket ?? 0);

  if (equity > 0) {
    const perTradePct = inputs.maxTradeRiskPct ?? 0;
    if (Number.isFinite(perTradePct) && perTradePct > 0) {
      const cap = perTradePct * equity;
      if (fixedUsd > cap) {
        return { usdSize: 0, reason: "per_trade_cap" };
      }
    }

    const traderCapPct = inputs.maxTraderExposurePct ?? null;
    if (traderCapPct != null && Number.isFinite(traderCapPct) && traderCapPct > 0) {
      const cap = traderCapPct * equity;
      const remaining = cap - openTrader;
      if (fixedUsd > remaining) {
        return { usdSize: 0, reason: "trader_exposure_cap" };
      }
    }

    const marketCapPct = inputs.marketExposureCapPct ?? null;
    if (marketCapPct != null && Number.isFinite(marketCapPct) && marketCapPct > 0) {
      const cap = marketCapPct * equity;
      const remaining = cap - openMarket;
      if (fixedUsd > remaining) {
        return { usdSize: 0, reason: "market_exposure_cap" };
      }
    }

    const totalCapPct = inputs.maxTotalExposurePct ?? null;
    if (totalCapPct != null && Number.isFinite(totalCapPct) && totalCapPct > 0) {
      const cap = totalCapPct * equity;
      const remaining = cap - openTotal;
      if (fixedUsd > remaining) {
        return { usdSize: 0, reason: "total_exposure_cap" };
      }
    }
  }

  return { usdSize: roundUsd(fixedUsd) };
}

export function computePaperUsdSize(inputs: SizingInputs): SizingResult {
  const sourceTradeUsd = inputs.sourceTradeUsd;
  if (!Number.isFinite(sourceTradeUsd) || sourceTradeUsd <= 0) {
    return { usdSize: 0, reason: "invalid_source_trade" };
  }

  const copyFactor = inputs.trader.copyFactor;
  if (!Number.isFinite(copyFactor) || copyFactor <= 0) {
    return { usdSize: 0, reason: "invalid_copy_factor" };
  }

  let proposed = copyFactor * sourceTradeUsd;
  let limitingReason: string | undefined;

  const minUsd = Math.max(0, inputs.trader.minUsd ?? 0);
  if (minUsd > 0) {
    proposed = Math.max(proposed, minUsd);
  }

  const maxUsd = inputs.trader.maxUsd;
  if (maxUsd != null && Number.isFinite(maxUsd)) {
    if (maxUsd < proposed) {
      limitingReason = "max_usd_cap";
    }
    proposed = Math.min(proposed, maxUsd);
  }

  const equity = Number.isFinite(inputs.portfolio.equityUsd)
    ? inputs.portfolio.equityUsd
    : 0;
  const openTotal = Math.max(0, inputs.currentOpenExposureTotal ?? 0);
  const openTrader = Math.max(0, inputs.currentOpenExposureForTrader ?? 0);
  const openMarket = Math.max(0, inputs.currentOpenExposureForMarket ?? 0);

  if (equity > 0) {
    const perTradePct = inputs.portfolio.maxTradeRiskPct ?? 0;
    if (Number.isFinite(perTradePct) && perTradePct > 0) {
      const cap = perTradePct * equity;
      if (cap < proposed) {
        limitingReason = "per_trade_cap";
      }
      proposed = Math.min(proposed, cap);
    }

    const traderCapPct = inputs.trader.maxTraderExposurePct ?? null;
    if (traderCapPct != null && Number.isFinite(traderCapPct) && traderCapPct > 0) {
      const cap = traderCapPct * equity;
      const remaining = cap - openTrader;
      if (remaining < proposed) {
        limitingReason = "trader_exposure_cap";
      }
      proposed = Math.min(proposed, remaining);
    }

    const marketCapPct = inputs.portfolio.marketExposureCapPct ?? null;
    if (marketCapPct != null && Number.isFinite(marketCapPct) && marketCapPct > 0) {
      const cap = marketCapPct * equity;
      const remaining = cap - openMarket;
      if (remaining < proposed) {
        limitingReason = "market_exposure_cap";
      }
      proposed = Math.min(proposed, remaining);
    }

    const totalCapPct = inputs.portfolio.maxTotalExposurePct ?? null;
    if (totalCapPct != null && Number.isFinite(totalCapPct) && totalCapPct > 0) {
      const cap = totalCapPct * equity;
      const remaining = cap - openTotal;
      if (remaining < proposed) {
        limitingReason = "total_exposure_cap";
      }
      proposed = Math.min(proposed, remaining);
    }
  }

  if (!Number.isFinite(proposed) || proposed <= 0) {
    return { usdSize: 0, reason: limitingReason ?? "non_positive_size" };
  }

  if (proposed < minUsd) {
    return { usdSize: 0, reason: limitingReason ?? "below_min_usd" };
  }

  return { usdSize: roundUsd(proposed) };
}
