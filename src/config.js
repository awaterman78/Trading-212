export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = "northstar-investment-tracker";

export const DEFAULT_SETTINGS = Object.freeze({
  apiBase: "",
  pollingIntervalMs: 15 * 60 * 1000,
  cashGBP: 0,
  maxPositionPercent: 20,
  staleQuoteMs: 30 * 60 * 1000,
});

export const DATA_STATUS = Object.freeze({
  NOT_CONFIGURED: "Not configured",
  CONNECTING: "Connecting",
  WEBSOCKET: "Live through WebSocket",
  POLLING: "Live through polling",
  MARKET_CLOSED: "Market closed, latest quote loaded",
  PARTIAL: "Partially working",
  RATE_LIMITED: "Rate limited",
  AUTH_FAILED: "Authentication failed",
  PROVIDER_UNAVAILABLE: "Provider unavailable",
  SYMBOL_UNSUPPORTED: "Symbol not supported",
  OFFLINE: "Offline",
});

const us = (name, currency = "USD") => ({
  name,
  tradingCurrency: currency,
  exchange: "US",
  providers: { finnhub: null, massive: null },
});

export const SYMBOL_MAP = Object.freeze({
  AMZN: { ...us("Amazon.com"), providers: { finnhub: "AMZN", massive: "AMZN" } },
  ASML: { ...us("ASML Holding ADR"), providers: { finnhub: "ASML", massive: "ASML" } },
  AVGO: { ...us("Broadcom"), providers: { finnhub: "AVGO", massive: "AVGO" } },
  COST: { ...us("Costco Wholesale"), providers: { finnhub: "COST", massive: "COST" } },
  CRWD: { ...us("CrowdStrike"), providers: { finnhub: "CRWD", massive: "CRWD" } },
  EQQQ: {
    name: "Invesco EQQQ Nasdaq 100 UCITS ETF Dist",
    tradingCurrency: "USD",
    exchange: "LSE",
    providers: { finnhub: "EQQQ.L", massive: null },
    warning: "Massive stock endpoints cover the US market. EQQQ uses its London USD listing through Finnhub.",
  },
  GOOGL: { ...us("Alphabet Class A"), providers: { finnhub: "GOOGL", massive: "GOOGL" } },
  LLY: { ...us("Eli Lilly"), providers: { finnhub: "LLY", massive: "LLY" } },
  NVDA: { ...us("NVIDIA"), providers: { finnhub: "NVDA", massive: "NVDA" } },
  TSM: { ...us("Taiwan Semiconductor ADR"), providers: { finnhub: "TSM", massive: "TSM" } },
  AAPL: { ...us("Apple"), providers: { finnhub: "AAPL", massive: "AAPL" } },
  MSFT: { ...us("Microsoft"), providers: { finnhub: "MSFT", massive: "MSFT" } },
  META: { ...us("Meta Platforms"), providers: { finnhub: "META", massive: "META" } },
  TSLA: { ...us("Tesla"), providers: { finnhub: "TSLA", massive: "TSLA" } },
  XOM: { ...us("Exxon Mobil"), providers: { finnhub: "XOM", massive: "XOM" } },
  PANW: { ...us("Palo Alto Networks"), providers: { finnhub: "PANW", massive: "PANW" } },
  ORCL: { ...us("Oracle"), providers: { finnhub: "ORCL", massive: "ORCL" } },
  CRM: { ...us("Salesforce"), providers: { finnhub: "CRM", massive: "CRM" } },
  SMCI: { ...us("Super Micro Computer"), providers: { finnhub: "SMCI", massive: "SMCI" } },
  QQQ: { ...us("Invesco QQQ Trust"), providers: { finnhub: "QQQ", massive: "QQQ" } },
  SPY: { ...us("SPDR S&P 500 ETF Trust"), providers: { finnhub: "SPY", massive: "SPY" } },
  AMD: { ...us("Advanced Micro Devices"), providers: { finnhub: "AMD", massive: "AMD" } },
  MA: { ...us("Mastercard"), providers: { finnhub: "MA", massive: "MA" } },
  V: { ...us("Visa"), providers: { finnhub: "V", massive: "V" } },
});

export function normaliseTicker(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function symbolMapping(ticker, customMappings = {}) {
  const key = normaliseTicker(ticker);
  return customMappings[key] || SYMBOL_MAP[key] || null;
}

export function publicSettings(settings = {}) {
  return {
    apiBase: String(settings.apiBase || ""),
    pollingIntervalMs: Number(settings.pollingIntervalMs) || DEFAULT_SETTINGS.pollingIntervalMs,
    cashGBP: Number(settings.cashGBP) || 0,
    maxPositionPercent: Number(settings.maxPositionPercent) || DEFAULT_SETTINGS.maxPositionPercent,
    staleQuoteMs: Number(settings.staleQuoteMs) || DEFAULT_SETTINGS.staleQuoteMs,
  };
}
