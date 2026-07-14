import { DEFAULT_SETTINGS } from "./config.js";

export function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function quoteAge(timestamp, now = Date.now()) {
  const parsed = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;
}

export function validateQuote(candidate, previous = null, pending = null, options = {}) {
  const minimum = options.minimum ?? 0.001;
  const maximum = options.maximum ?? 100_000;
  const extremeRatio = options.extremeRatio ?? 0.5;
  const confirmationTolerance = options.confirmationTolerance ?? 0.03;
  const price = finitePositive(candidate?.price);
  const timestamp = typeof candidate?.timestamp === "number" ? candidate.timestamp : Date.parse(candidate?.timestamp);
  const sourceField = String(candidate?.sourceField || "provider response");

  if (!price) return { accepted: false, reason: "Price must be finite and positive", quote: previous, pending: null };
  if (price < minimum || price > maximum) return { accepted: false, reason: `Price is outside the configured ${minimum} to ${maximum} range`, quote: previous, pending: null };
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { accepted: false, reason: "Quote timestamp is invalid", quote: previous, pending: null };
  if (/(isin|transaction|trade id)/i.test(sourceField)) return { accepted: false, reason: `Quote cannot be sourced from ${sourceField}`, quote: previous, pending: null };

  const previousPrice = finitePositive(previous?.price);
  if (previousPrice && Math.abs(price / previousPrice - 1) > extremeRatio) {
    const pendingPrice = finitePositive(pending?.price);
    const agrees = pendingPrice && Math.abs(price / pendingPrice - 1) <= confirmationTolerance;
    if (!agrees) {
      return {
        accepted: false,
        reason: "Extreme price movement is awaiting a second provider response",
        quote: previous,
        pending: { ...candidate, price, timestamp },
      };
    }
  }

  return { accepted: true, reason: null, quote: { ...candidate, price, timestamp }, pending: null };
}

export function lotSummary(holding) {
  const lots = Array.isArray(holding?.lots) ? holding.lots.filter((lot) => finitePositive(lot.shares)) : [];
  const shares = lots.reduce((sum, lot) => sum + Number(lot.shares), 0);
  const totalCostGBP = lots.reduce((sum, lot) => sum + (Number(lot.costGBP) || 0) + (Number(lot.feeGBP) || 0), 0);
  const nativeCost = lots.reduce((sum, lot) => sum + Number(lot.shares) * (Number(lot.priceNative) || 0), 0);
  return {
    lots,
    shares,
    totalCostGBP,
    averageCostNative: shares > 0 ? nativeCost / shares : null,
    purchaseCurrency: lots[0]?.priceCurrency || holding?.mapping?.tradingCurrency || null,
  };
}

export function resolveFxRate(currency, fxRates = {}) {
  if (currency === "GBP") return { rate: 1, source: "Base currency", timestamp: Date.now() };
  const pair = `${currency}GBP`;
  const fx = fxRates[pair];
  const rate = finitePositive(fx?.rate);
  return rate ? { ...fx, rate } : null;
}

export function valueHolding(holding, fxRates = {}, now = Date.now(), settings = DEFAULT_SETTINGS) {
  const lots = lotSummary(holding);
  const quote = holding?.quote || null;
  const currentPrice = finitePositive(quote?.price);
  const quoteCurrency = String(quote?.currency || holding?.mapping?.tradingCurrency || "").toUpperCase();
  const fx = currentPrice ? resolveFxRate(quoteCurrency, fxRates) : null;
  const hasQuote = Boolean(currentPrice);
  const hasFx = Boolean(fx);
  const currentValueNative = hasQuote ? lots.shares * currentPrice : null;
  const currentValueGBP = hasQuote && hasFx ? currentValueNative * fx.rate : null;
  const profitLossGBP = currentValueGBP === null ? null : currentValueGBP - lots.totalCostGBP;
  const profitLossPercent = profitLossGBP === null || lots.totalCostGBP <= 0 ? null : (profitLossGBP / lots.totalCostGBP) * 100;
  const ageMs = quoteAge(quote?.timestamp, now);
  return {
    ...lots,
    currentPrice,
    quoteCurrency,
    currentValueNative,
    currentValueGBP,
    profitLossGBP,
    profitLossPercent,
    quote,
    fx,
    hasQuote,
    hasFx,
    stale: hasQuote && ageMs > (settings.staleQuoteMs || DEFAULT_SETTINGS.staleQuoteMs),
    ageMs,
    historicalStatus: Array.isArray(holding?.history?.bars) && holding.history.bars.length >= 20 ? "Available" : "Unavailable",
    warning: !holding?.mapping
      ? "Provider symbol mapping is missing"
      : !hasQuote
        ? "Current quote is unavailable"
        : !hasFx
          ? `${quoteCurrency} to GBP conversion is unavailable`
          : null,
  };
}

export function portfolioSummary(holdings = {}, fxRates = {}, cashGBP = 0, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const valued = Object.values(holdings).map((holding) => ({ holding, value: valueHolding(holding, fxRates, now, settings) }));
  const totalCostGBP = valued.reduce((sum, item) => sum + item.value.totalCostGBP, 0);
  const knownMarketValueGBP = valued.reduce((sum, item) => sum + (item.value.currentValueGBP ?? 0), 0);
  const valuedHoldings = valued.filter((item) => item.value.currentValueGBP !== null).length;
  const missingHoldings = valued.length - valuedHoldings;
  const complete = valued.length > 0 && missingHoldings === 0;
  const marketValueGBP = complete ? knownMarketValueGBP : null;
  const profitLossGBP = complete ? marketValueGBP - totalCostGBP : null;
  const profitLossPercent = profitLossGBP === null || totalCostGBP <= 0 ? null : (profitLossGBP / totalCostGBP) * 100;
  const totalPortfolioGBP = marketValueGBP === null ? null : marketValueGBP + (Number(cashGBP) || 0);

  const withConcentration = valued.map((item) => ({
    ...item,
    concentrationPercent: complete && marketValueGBP > 0 ? (item.value.currentValueGBP / marketValueGBP) * 100 : null,
  }));

  return {
    holdings: withConcentration,
    holdingCount: valued.length,
    totalCostGBP,
    knownMarketValueGBP,
    marketValueGBP,
    totalPortfolioGBP,
    cashGBP: Number(cashGBP) || 0,
    profitLossGBP,
    profitLossPercent,
    valuedHoldings,
    missingHoldings,
    complete,
  };
}

export function historySignals(history, currentPrice = null) {
  const bars = Array.isArray(history?.bars) ? history.bars.filter((bar) => finitePositive(bar.close)) : [];
  if (bars.length < 20) return { available: false, trend: null, drawdownPercent: null, volatilityPercent: null, return6mPercent: null };
  const closes = bars.map((bar) => Number(bar.close));
  const current = finitePositive(currentPrice) || closes.at(-1);
  const average = (count) => {
    const sample = closes.slice(-Math.min(count, closes.length));
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  };
  const ma50 = average(50);
  const ma200 = closes.length >= 120 ? average(200) : null;
  const high = Math.max(...closes.slice(-Math.min(252, closes.length)));
  const sixMonthBase = closes[Math.max(0, closes.length - 126)];
  const returns = closes.slice(1).map((price, index) => Math.log(price / closes[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const volatilityPercent = Math.sqrt(variance) * Math.sqrt(252) * 100;
  const trend = current > ma50 && (!ma200 || current > ma200) ? "Positive" : current < ma50 && (!ma200 || current < ma200) ? "Negative" : "Mixed";
  return {
    available: true,
    trend,
    ma50,
    ma200,
    drawdownPercent: high > 0 ? (current / high - 1) * 100 : null,
    volatilityPercent,
    return6mPercent: sixMonthBase > 0 ? (current / sixMonthBase - 1) * 100 : null,
  };
}
