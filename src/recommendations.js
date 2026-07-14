import { historySignals } from "./portfolio.js";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysUntil(date, now = Date.now()) {
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? Math.ceil((timestamp - now) / 86_400_000) : null;
}

export function buildSignals(holding, valuation, concentrationPercent, now = Date.now()) {
  const history = historySignals(holding.history, valuation.currentPrice);
  const metric = holding.company?.metrics || {};
  const analyst = holding.company?.analyst || null;
  const earningsDate = holding.company?.nextEarningsDate || null;
  const earningsDays = daysUntil(earningsDate, now);
  const pe = number(metric.peTTM ?? metric.peNormalizedAnnual);
  const roe = number(metric.roeTTM ?? metric.roeRfy);
  const revenueGrowth = number(metric.revenueGrowthTTMYoy ?? metric.revenueGrowth3Y);
  const analystPositive = analyst ? Number(analyst.buy || 0) + Number(analyst.strongBuy || 0) : null;
  const analystNegative = analyst ? Number(analyst.sell || 0) + Number(analyst.strongSell || 0) : null;

  return [
    {
      key: "data",
      label: "Data quality",
      fact: !valuation.hasQuote ? "Current quote is missing" : valuation.stale ? "Current quote is stale" : "Current quote is fresh",
      value: !valuation.hasQuote || valuation.stale ? -2 : 1,
      available: true,
    },
    {
      key: "trend",
      label: "Trend",
      fact: history.available ? `${history.trend}, six month return ${formatPercent(history.return6mPercent)}` : "Historical data is unavailable",
      value: !history.available ? 0 : history.trend === "Positive" ? 2 : history.trend === "Negative" ? -2 : 0,
      available: history.available,
    },
    {
      key: "drawdown",
      label: "Drawdown",
      fact: history.available ? `${formatPercent(history.drawdownPercent)} from the period high` : "Drawdown cannot be calculated",
      value: !history.available ? 0 : history.drawdownPercent < -25 ? -2 : history.drawdownPercent < -12 ? -1 : 1,
      available: history.available,
    },
    {
      key: "volatility",
      label: "Volatility",
      fact: history.available ? `${formatPercent(history.volatilityPercent)} annualised` : "Volatility cannot be calculated",
      value: !history.available ? 0 : history.volatilityPercent > 55 ? -1 : 0,
      available: history.available,
    },
    {
      key: "valuation",
      label: "Valuation",
      fact: pe === null ? "P/E data is unavailable" : `P/E ${pe.toFixed(1)}`,
      value: pe === null ? 0 : pe > 60 ? -2 : pe > 40 ? -1 : pe > 0 && pe < 30 ? 1 : 0,
      available: pe !== null,
    },
    {
      key: "quality",
      label: "Fundamental quality",
      fact: roe === null && revenueGrowth === null ? "Quality metrics are unavailable" : `ROE ${formatPercent(roe)}, revenue growth ${formatPercent(revenueGrowth)}`,
      value: (roe !== null && roe > 15 ? 1 : roe !== null && roe < 0 ? -1 : 0) + (revenueGrowth !== null && revenueGrowth > 8 ? 1 : revenueGrowth !== null && revenueGrowth < 0 ? -1 : 0),
      available: roe !== null || revenueGrowth !== null,
    },
    {
      key: "analyst",
      label: "Analyst consensus",
      fact: analystPositive === null ? "Analyst data is unavailable" : `${analystPositive} positive and ${analystNegative} negative ratings`,
      value: analystPositive === null ? 0 : analystPositive > analystNegative * 2 ? 1 : analystNegative > analystPositive ? -1 : 0,
      available: analystPositive !== null,
    },
    {
      key: "earnings",
      label: "Earnings proximity",
      fact: earningsDays === null ? "Next earnings date is unavailable" : earningsDays < 0 ? "Latest recorded earnings date has passed" : `Earnings expected in ${earningsDays} days`,
      value: earningsDays !== null && earningsDays >= 0 && earningsDays <= 7 ? -1 : 0,
      available: earningsDays !== null,
    },
    {
      key: "concentration",
      label: "Position size",
      fact: concentrationPercent === null ? "Concentration needs complete portfolio values" : `${concentrationPercent.toFixed(1)}% of invested value`,
      value: concentrationPercent === null ? 0 : concentrationPercent > 30 ? -3 : concentrationPercent > 20 ? -2 : concentrationPercent < 10 ? 1 : 0,
      available: concentrationPercent !== null,
    },
  ];
}

export function recommendationForHolding(holding, holdingValuation, concentrationPercent, settings = {}, now = Date.now()) {
  const signals = buildSignals(holding, holdingValuation, concentrationPercent, now);
  const available = signals.filter((signal) => signal.available).length;
  const score = signals.reduce((sum, signal) => sum + signal.value, 0);
  const maxPositionPercent = Number(settings.maxPositionPercent) || 20;
  const trend = signals.find((signal) => signal.key === "trend");
  const quality = signals.find((signal) => signal.key === "quality");
  const valuationSignal = signals.find((signal) => signal.key === "valuation");
  let action = "Hold";
  let judgement = "The available signals do not justify a portfolio change.";
  let tone = "good";

  if (!holding.mapping || !holdingValuation.hasQuote || available < 3) {
    action = "Review";
    judgement = "The evidence is incomplete. Fix the data before making an investment decision.";
    tone = "warn";
  } else if (concentrationPercent !== null && concentrationPercent > Math.max(30, maxPositionPercent + 10)) {
    action = "Reduce";
    judgement = "This holding dominates the portfolio. Reducing it would materially improve diversification.";
    tone = "bad";
  } else if (concentrationPercent !== null && concentrationPercent > maxPositionPercent) {
    action = "Trim";
    judgement = "The business may still be attractive, but the position is above the chosen concentration limit.";
    tone = "warn";
  } else if (score <= -5 && trend.value < 0 && quality.value < 0) {
    action = "Exit";
    judgement = "Weak price behaviour and weak business signals make the original investment case doubtful.";
    tone = "bad";
  } else if (score <= -2) {
    action = "Review";
    judgement = "Several signals have weakened. Recheck the investment case before adding more capital.";
    tone = "warn";
  } else if (score >= 5 && trend.value > 0 && quality.value > 0 && valuationSignal.value >= -1 && (concentrationPercent ?? 0) < maxPositionPercent * 0.75) {
    action = "Add";
    judgement = "Quality and trend are supportive, valuation is not at the highest risk level, and position size allows room.";
    tone = "good";
  }

  return {
    action,
    tone,
    score,
    confidence: available >= 7 ? "High" : available >= 4 ? "Medium" : "Low",
    judgement,
    signals,
    disclaimer: "This is a rules based judgement, not a promise of profit or regulated financial advice.",
  };
}

export function recommendationForCandidate(candidate, now = Date.now()) {
  const valuation = {
    currentPrice: candidate.quote?.price || null,
    hasQuote: Boolean(candidate.quote?.price),
    stale: false,
  };
  const signals = buildSignals(candidate, valuation, 0, now);
  const available = signals.filter((signal) => signal.available).length;
  const score = signals.reduce((sum, signal) => sum + signal.value, 0);
  if (available < 4) return { action: "Review", tone: "warn", score, confidence: "Low", judgement: "More data is needed before considering an entry.", signals };
  if (score >= 5) return { action: "Add", tone: "good", score, confidence: available >= 7 ? "High" : "Medium", judgement: "The current long term signals support considering an initial position.", signals };
  return { action: "Watch for entry", tone: score < 0 ? "warn" : "good", score, confidence: available >= 7 ? "High" : "Medium", judgement: "Keep it on the watchlist until valuation, trend or quality improves.", signals };
}

function formatPercent(value) {
  const parsed = number(value);
  return parsed === null ? "unavailable" : `${parsed >= 0 ? "+" : ""}${parsed.toFixed(1)}%`;
}
