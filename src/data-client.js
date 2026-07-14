import { DATA_STATUS, symbolMapping } from "./config.js";
import { validateQuote } from "./portfolio.js";

export class DataError extends Error {
  constructor(message, { status = null, category = "provider", providerResponse = null, rateLimit = null } = {}) {
    super(message);
    this.name = "DataError";
    this.status = status;
    this.category = category;
    this.providerResponse = providerResponse;
    this.rateLimit = rateLimit;
  }
}

export function statusForError(error) {
  if (error?.category === "offline") return DATA_STATUS.OFFLINE;
  if (error?.category === "timeout") return DATA_STATUS.PROVIDER_UNAVAILABLE;
  if (error?.status === 401 || error?.status === 403) return DATA_STATUS.AUTH_FAILED;
  if (error?.status === 429) return DATA_STATUS.RATE_LIMITED;
  if (error?.status >= 500) return DATA_STATUS.PROVIDER_UNAVAILABLE;
  return DATA_STATUS.PARTIAL;
}

function makeEvent({ method, path, status, ok, message, startedAt, finishedAt, symbols = [], providerResponse = null }) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    method,
    path,
    status,
    ok,
    message,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    symbols,
    providerResponse,
  };
}

export class DataClient {
  constructor({ apiBase, fetchImpl = globalThis.fetch, timeoutMs = 15_000, onEvent = () => {} } = {}) {
    this.apiBase = String(apiBase || "").replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
  }

  configured() {
    return /^https?:\/\//i.test(this.apiBase);
  }

  async request(path, { method = "GET", body = null, symbols = [] } = {}) {
    if (!this.configured()) throw new DataError("Cloudflare Worker URL is not configured", { category: "configuration" });
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let payload;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: controller.signal,
      });
      const text = await response.text();
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text || "Invalid JSON response" }; }
      const finishedAt = Date.now();
      const message = payload?.error?.message || payload?.error || (response.ok ? "Request completed" : `HTTP ${response.status}`);
      this.onEvent(makeEvent({ method, path, status: response.status, ok: response.ok, message, startedAt, finishedAt, symbols, providerResponse: response.ok ? null : payload }));
      if (!response.ok) {
        throw new DataError(String(message), {
          status: response.status,
          category: response.status === 429 ? "rate" : "provider",
          providerResponse: payload,
          rateLimit: payload?.rateLimit || null,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof DataError) throw error;
      const category = error?.name === "AbortError" ? "timeout" : globalThis.navigator?.onLine === false ? "offline" : "network";
      const wrapped = new DataError(category === "timeout" ? `Request timed out after ${this.timeoutMs}ms` : String(error?.message || error), { category });
      this.onEvent(makeEvent({ method, path, status: null, ok: false, message: wrapped.message, startedAt, finishedAt: Date.now(), symbols }));
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
  }

  health() {
    return this.request("/health");
  }

  quotes(instruments) {
    return this.request("/v1/quotes", {
      method: "POST",
      body: { instruments },
      symbols: instruments.map((instrument) => instrument.ticker),
    });
  }

  fx(pairs) {
    return this.request("/v1/fx", { method: "POST", body: { pairs }, symbols: pairs });
  }

  history(instruments) {
    return this.request("/v1/history", {
      method: "POST",
      body: { instruments },
      symbols: instruments.map((instrument) => instrument.ticker),
    });
  }

  company(instruments) {
    return this.request("/v1/company", {
      method: "POST",
      body: { instruments },
      symbols: instruments.map((instrument) => instrument.ticker),
    });
  }
}

export function instrumentsFromState(state, tickers = Object.keys(state.holdings || {})) {
  return tickers.map((ticker) => {
    const holding = state.holdings?.[ticker];
    const mapping = holding?.mapping || symbolMapping(ticker, state.customMappings);
    return {
      ticker,
      finnhub: mapping?.providers?.finnhub || null,
      massive: mapping?.providers?.massive || null,
      currency: mapping?.tradingCurrency || null,
      exchange: mapping?.exchange || null,
    };
  });
}

function diagnosticsEvent(state, event) {
  state.diagnostics.events = [event, ...(state.diagnostics.events || [])].slice(0, 200);
  state.diagnostics.lastRequestAt = new Date(event.startedAt).toISOString();
  state.diagnostics.lastHttpStatus = event.status;
  if (event.ok) state.diagnostics.lastSuccessAt = new Date(event.finishedAt).toISOString();
  else state.diagnostics.lastError = { message: event.message, response: event.providerResponse, time: new Date(event.finishedAt).toISOString() };
}

export function createStateDataClient(state, options = {}) {
  return new DataClient({
    apiBase: state.settings.apiBase,
    ...options,
    onEvent: (event) => {
      diagnosticsEvent(state, event);
      options.onEvent?.(event);
    },
  });
}

function applyQuote(state, ticker, quote) {
  const holding = state.holdings[ticker];
  if (!holding) return { updated: false, reason: "Holding is no longer present" };
  const validation = validateQuote(quote, holding.quote, holding.pendingExtremeQuote);
  holding.pendingExtremeQuote = validation.pending;
  if (validation.accepted) {
    holding.quote = validation.quote;
    return { updated: true, reason: null };
  }
  return { updated: false, reason: validation.reason };
}

export async function refreshMarketData(state, { client = createStateDataClient(state), deep = false } = {}) {
  const instruments = instrumentsFromState(state);
  const tickers = instruments.map((instrument) => instrument.ticker);
  state.diagnostics.status = DATA_STATUS.CONNECTING;
  state.diagnostics.symbolsRequested = tickers;
  state.diagnostics.symbolsUpdated = [];
  state.diagnostics.symbolsFailed = [];
  state.diagnostics.pollingIntervalMs = state.settings.pollingIntervalMs;

  if (!instruments.length) return { state, status: DATA_STATUS.NOT_CONFIGURED, updated: [], failed: [] };
  try {
    const quotePayload = await client.quotes(instruments);
    const updated = [];
    const failed = [];
    for (const ticker of tickers) {
      const quote = quotePayload?.quotes?.[ticker];
      if (!quote) {
        failed.push({ ticker, reason: quotePayload?.failures?.[ticker] || "No quote returned" });
        continue;
      }
      const result = applyQuote(state, ticker, quote);
      if (result.updated) updated.push(ticker);
      else failed.push({ ticker, reason: result.reason });
    }

    const currencies = [...new Set(instruments.map((instrument) => instrument.currency).filter((currency) => currency && currency !== "GBP"))];
    if (currencies.length) {
      try {
        const fxPayload = await client.fx(currencies.map((currency) => `${currency}GBP`));
        state.marketData = state.marketData || {};
        state.marketData.fx = { ...(state.marketData.fx || {}), ...(fxPayload?.rates || {}) };
      } catch (error) {
        for (const currency of currencies) failed.push({ ticker: `${currency}GBP`, reason: error.message });
      }
    }

    if (deep) {
      const [historyResult, companyResult] = await Promise.allSettled([client.history(instruments), client.company(instruments)]);
      if (historyResult.status === "fulfilled") {
        for (const [ticker, history] of Object.entries(historyResult.value?.history || {})) if (state.holdings[ticker]) state.holdings[ticker].history = history;
      } else {
        failed.push({ ticker: "Historical data", reason: historyResult.reason.message });
      }
      if (companyResult.status === "fulfilled") {
        for (const [ticker, company] of Object.entries(companyResult.value?.companies || {})) if (state.holdings[ticker]) state.holdings[ticker].company = company;
      } else {
        failed.push({ ticker: "Company data", reason: companyResult.reason.message });
      }
    }

    state.diagnostics.symbolsUpdated = updated;
    state.diagnostics.symbolsFailed = failed;
    state.diagnostics.rateLimit = quotePayload?.rateLimit || null;
    const marketOpen = quotePayload?.market?.open;
    const onlyUnsupported = !updated.length && failed.length && failed.every((item) => /(symbol|not supported|no provider)/i.test(item.reason));
    state.diagnostics.status = onlyUnsupported
      ? DATA_STATUS.SYMBOL_UNSUPPORTED
      : failed.length
        ? DATA_STATUS.PARTIAL
      : marketOpen === false
        ? DATA_STATUS.MARKET_CLOSED
        : DATA_STATUS.POLLING;
    return { state, status: state.diagnostics.status, updated, failed };
  } catch (error) {
    state.diagnostics.status = statusForError(error);
    state.diagnostics.symbolsFailed = tickers.map((ticker) => ({ ticker, reason: error.message }));
    state.diagnostics.rateLimit = error.rateLimit || null;
    return { state, status: state.diagnostics.status, updated: [], failed: state.diagnostics.symbolsFailed, error };
  }
}

export { applyQuote };
