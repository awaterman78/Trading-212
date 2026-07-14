const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MAX_INSTRUMENTS = 25;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (origin && !cors) return json({ error: { message: "Origin is not allowed" } }, 403);

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "northstar-data-proxy",
          time: new Date().toISOString(),
          providers: { finnhub: Boolean(env.FINNHUB_API_KEY), massive: Boolean(env.MASSIVE_API_KEY) },
          features: { websocket: false, polling: true },
        }, 200, cors);
      }
      if (url.pathname === "/v1/quotes" && request.method === "POST") return withCors(await quotesRoute(request, env), cors);
      if (url.pathname === "/v1/fx" && request.method === "POST") return withCors(await fxRoute(request, env), cors);
      if (url.pathname === "/v1/history" && request.method === "POST") return withCors(await historyRoute(request, env), cors);
      if (url.pathname === "/v1/company" && request.method === "POST") return withCors(await companyRoute(request, env), cors);
      return json({ error: { message: "Route not found" } }, 404, cors);
    } catch (error) {
      return json({ error: normaliseError(error) }, error.status || 500, cors);
    }
  },
};

function allowedOrigins(value = "") {
  return String(value).split(",").map((origin) => origin.trim()).filter(Boolean);
}

function corsHeaders(origin, configured) {
  if (!origin) return {};
  if (!allowedOrigins(configured).includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function withCors(response, cors) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors || {})) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

async function body(request) {
  try { return await request.json(); } catch { throw httpError(400, "Request body must be valid JSON"); }
}

function httpError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function normaliseError(error) {
  return {
    message: String(error?.message || "Unexpected provider error").replace(/token=[^&\s]+/gi, "token=[redacted]").slice(0, 500),
    status: Number(error?.status) || null,
    details: error?.details || null,
  };
}

function cleanSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9.:-]{1,24}$/.test(symbol) ? symbol : null;
}

function validateInstruments(value) {
  if (!Array.isArray(value) || !value.length) throw httpError(400, "At least one instrument is required");
  if (value.length > MAX_INSTRUMENTS) throw httpError(400, `A maximum of ${MAX_INSTRUMENTS} instruments is allowed per request`);
  return value.map((instrument) => {
    const ticker = cleanSymbol(instrument?.ticker);
    if (!ticker) throw httpError(400, "An instrument contains an invalid ticker");
    return {
      ticker,
      finnhub: instrument.finnhub ? cleanSymbol(instrument.finnhub) : null,
      massive: instrument.massive ? cleanSymbol(instrument.massive) : null,
      currency: /^[A-Z]{3}$/.test(instrument.currency) ? instrument.currency : null,
      exchange: String(instrument.exchange || "").slice(0, 12),
    };
  });
}

function rateLimitFrom(response) {
  const get = (name) => response.headers.get(name);
  const limit = get("x-ratelimit-limit") || get("x-rate-limit-limit");
  const remaining = get("x-ratelimit-remaining") || get("x-rate-limit-remaining");
  const reset = get("x-ratelimit-reset") || get("x-rate-limit-reset");
  return limit || remaining || reset ? { limit, remaining, reset } : null;
}

async function providerJson(url, { provider, cacheTtl = 0 } = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cf: cacheTtl ? { cacheEverything: true, cacheTtl } : undefined,
  });
  const rateLimit = rateLimitFrom(response);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text || "Invalid JSON response" }; }
  if (!response.ok || payload?.error) {
    const message = payload?.error?.message || payload?.error || `${provider} returned HTTP ${response.status}`;
    const error = httpError(response.status || 502, String(message), { provider, status: response.status, rateLimit });
    error.rateLimit = rateLimit;
    throw error;
  }
  return { payload, response, rateLimit };
}

function unixTimestamp(value, multiplier = 1) {
  const timestamp = Number(value) * multiplier;
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

async function finnhubQuote(instrument, env) {
  if (!env.FINNHUB_API_KEY || !instrument.finnhub) throw httpError(404, "Finnhub symbol is not configured");
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", instrument.finnhub);
  url.searchParams.set("token", env.FINNHUB_API_KEY);
  const { payload, rateLimit } = await providerJson(url, { provider: "Finnhub" });
  if (!(Number(payload?.c) > 0)) throw httpError(404, `Finnhub returned no current quote for ${instrument.finnhub}`);
  return {
    quote: {
      price: Number(payload.c),
      currency: instrument.currency,
      provider: "Finnhub",
      providerSymbol: instrument.finnhub,
      timestamp: unixTimestamp(payload.t, 1000),
      previousClose: Number(payload.pc) || null,
      change: Number(payload.d) || null,
      changePercent: Number(payload.dp) || null,
      sourceField: "Finnhub quote.c",
    },
    rateLimit,
  };
}

async function massiveQuote(instrument, env) {
  if (!env.MASSIVE_API_KEY || !instrument.massive) throw httpError(404, "Massive symbol is not configured");
  const url = new URL(`https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${instrument.massive}`);
  url.searchParams.set("apiKey", env.MASSIVE_API_KEY);
  const { payload, rateLimit } = await providerJson(url, { provider: "Massive" });
  const item = payload?.ticker;
  const price = Number(item?.lastTrade?.p || item?.min?.c || item?.day?.c || item?.prevDay?.c);
  if (!(price > 0)) throw httpError(404, `Massive returned no current quote for ${instrument.massive}`);
  return {
    quote: {
      price,
      currency: instrument.currency,
      provider: "Massive",
      providerSymbol: instrument.massive,
      timestamp: unixTimestamp(item?.lastTrade?.t, 0.000001),
      previousClose: Number(item?.prevDay?.c) || null,
      sourceField: "Massive snapshot",
    },
    rateLimit,
  };
}

async function marketStatus(env) {
  if (!env.FINNHUB_API_KEY) return { open: null, exchange: "US", source: "Unavailable" };
  try {
    const url = new URL("https://finnhub.io/api/v1/stock/market-status");
    url.searchParams.set("exchange", "US");
    url.searchParams.set("token", env.FINNHUB_API_KEY);
    const { payload } = await providerJson(url, { provider: "Finnhub", cacheTtl: 60 });
    return { open: Boolean(payload?.isOpen), exchange: "US", session: payload?.session || null, source: "Finnhub" };
  } catch {
    return { open: null, exchange: "US", source: "Unavailable" };
  }
}

async function quotesRoute(request, env) {
  const input = await body(request);
  const instruments = validateInstruments(input.instruments);
  if (!env.FINNHUB_API_KEY && !env.MASSIVE_API_KEY) throw httpError(503, "No market data provider keys are configured in Worker secrets");
  const results = await Promise.all(instruments.map(async (instrument) => {
    const errors = [];
    try { return { ticker: instrument.ticker, ...(await finnhubQuote(instrument, env)) }; } catch (error) { errors.push(normaliseError(error)); }
    try { return { ticker: instrument.ticker, ...(await massiveQuote(instrument, env)) }; } catch (error) { errors.push(normaliseError(error)); }
    return { ticker: instrument.ticker, errors };
  }));
  const quotes = {};
  const failures = {};
  let rateLimit = null;
  for (const result of results) {
    if (result.quote) quotes[result.ticker] = result.quote;
    else failures[result.ticker] = result.errors?.map((error) => error.message).join(" | ") || "No provider supports this symbol";
    rateLimit = result.rateLimit || rateLimit;
  }
  if (!Object.keys(quotes).length) {
    const statuses = results.flatMap((result) => result.errors || []).map((error) => error.status).filter(Boolean);
    if (statuses.some((status) => status === 401 || status === 403)) return json({ error: { message: "Provider authentication failed" }, failures, rateLimit }, 401);
    if (statuses.some((status) => status === 429)) return json({ error: { message: "Provider rate limit exceeded" }, failures, rateLimit }, 429);
  }
  return json({ quotes, failures, market: await marketStatus(env), rateLimit, requestedAt: new Date().toISOString() });
}

async function fxRoute(request, env) {
  const input = await body(request);
  const pairs = Array.isArray(input.pairs) ? input.pairs.map(cleanSymbol).filter(Boolean).slice(0, 10) : [];
  if (!pairs.length) throw httpError(400, "At least one valid currency pair is required");
  const rates = {};
  const failures = {};
  for (const pair of pairs) {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3, 6);
    if (pair.length !== 6) { failures[pair] = "Currency pair must contain six letters"; continue; }
    try {
      if (!env.FINNHUB_API_KEY) throw httpError(503, "Finnhub key is not configured");
      const url = new URL("https://finnhub.io/api/v1/forex/rates");
      url.searchParams.set("base", base);
      url.searchParams.set("token", env.FINNHUB_API_KEY);
      const { payload } = await providerJson(url, { provider: "Finnhub", cacheTtl: 300 });
      const rate = Number(payload?.quote?.[quote]);
      if (!(rate > 0)) throw httpError(404, `Finnhub returned no ${pair} rate`);
      rates[pair] = { rate, provider: "Finnhub", timestamp: Date.now(), sourceField: `Finnhub forex quote.${quote}` };
    } catch (error) {
      failures[pair] = normaliseError(error).message;
    }
  }
  return json({ rates, failures, requestedAt: new Date().toISOString() });
}

function dateOnly(date) { return date.toISOString().slice(0, 10); }

async function massiveHistory(instrument, env) {
  if (!env.MASSIVE_API_KEY || !instrument.massive) throw httpError(404, "Massive historical symbol is not configured");
  const to = new Date();
  const from = new Date(Date.now() - 420 * 86_400_000);
  const url = new URL(`https://api.massive.com/v2/aggs/ticker/${instrument.massive}/range/1/day/${dateOnly(from)}/${dateOnly(to)}`);
  url.searchParams.set("adjusted", "true");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", "5000");
  url.searchParams.set("apiKey", env.MASSIVE_API_KEY);
  const { payload } = await providerJson(url, { provider: "Massive", cacheTtl: 21_600 });
  if (!Array.isArray(payload?.results) || !payload.results.length) throw httpError(404, `Massive returned no history for ${instrument.massive}`);
  return {
    provider: "Massive",
    providerSymbol: instrument.massive,
    timestamp: Date.now(),
    bars: payload.results.map((bar) => ({ timestamp: Number(bar.t), open: Number(bar.o), high: Number(bar.h), low: Number(bar.l), close: Number(bar.c), volume: Number(bar.v) })),
  };
}

async function finnhubHistory(instrument, env) {
  if (!env.FINNHUB_API_KEY || !instrument.finnhub) throw httpError(404, "Finnhub historical symbol is not configured");
  const url = new URL("https://finnhub.io/api/v1/stock/candle");
  url.searchParams.set("symbol", instrument.finnhub);
  url.searchParams.set("resolution", "D");
  url.searchParams.set("from", String(Math.floor((Date.now() - 420 * 86_400_000) / 1000)));
  url.searchParams.set("to", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("token", env.FINNHUB_API_KEY);
  const { payload } = await providerJson(url, { provider: "Finnhub", cacheTtl: 21_600 });
  if (payload?.s !== "ok" || !Array.isArray(payload.c) || !payload.c.length) throw httpError(404, `Finnhub returned no history for ${instrument.finnhub}`);
  return {
    provider: "Finnhub",
    providerSymbol: instrument.finnhub,
    timestamp: Date.now(),
    bars: payload.c.map((close, index) => ({ timestamp: Number(payload.t[index]) * 1000, open: Number(payload.o[index]), high: Number(payload.h[index]), low: Number(payload.l[index]), close: Number(close), volume: Number(payload.v[index]) })),
  };
}

async function historyRoute(request, env) {
  const input = await body(request);
  const instruments = validateInstruments(input.instruments);
  const results = await Promise.all(instruments.map(async (instrument) => {
    const errors = [];
    try { return { ticker: instrument.ticker, history: await massiveHistory(instrument, env) }; } catch (error) { errors.push(normaliseError(error).message); }
    try { return { ticker: instrument.ticker, history: await finnhubHistory(instrument, env) }; } catch (error) { errors.push(normaliseError(error).message); }
    return { ticker: instrument.ticker, errors };
  }));
  return json({
    history: Object.fromEntries(results.filter((result) => result.history).map((result) => [result.ticker, result.history])),
    failures: Object.fromEntries(results.filter((result) => !result.history).map((result) => [result.ticker, result.errors.join(" | ")])),
    requestedAt: new Date().toISOString(),
  });
}

async function companyBundle(instrument, env) {
  if (!env.FINNHUB_API_KEY || !instrument.finnhub) throw httpError(404, "Finnhub company symbol is not configured");
  const endpoint = async (path, params = {}) => {
    const url = new URL(`https://finnhub.io/api/v1/${path}`);
    for (const [key, value] of Object.entries({ ...params, token: env.FINNHUB_API_KEY })) url.searchParams.set(key, value);
    return (await providerJson(url, { provider: "Finnhub", cacheTtl: 21_600 })).payload;
  };
  const from = new Date();
  const to = new Date(Date.now() + 120 * 86_400_000);
  const [profile, metrics, recommendations, earnings] = await Promise.allSettled([
    endpoint("stock/profile2", { symbol: instrument.finnhub }),
    endpoint("stock/metric", { symbol: instrument.finnhub, metric: "all" }),
    endpoint("stock/recommendation", { symbol: instrument.finnhub }),
    endpoint("calendar/earnings", { symbol: instrument.finnhub, from: dateOnly(from), to: dateOnly(to) }),
  ]);
  const value = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
  const analyst = value(recommendations, [])[0] || null;
  const calendar = value(earnings, {})?.earningsCalendar || [];
  return {
    provider: "Finnhub",
    providerSymbol: instrument.finnhub,
    timestamp: Date.now(),
    profile: value(profile, null),
    metrics: value(metrics, {})?.metric || {},
    analyst,
    nextEarningsDate: calendar[0]?.date || null,
    partial: [profile, metrics, recommendations, earnings].some((result) => result.status === "rejected"),
  };
}

async function companyRoute(request, env) {
  const input = await body(request);
  const instruments = validateInstruments(input.instruments);
  const results = await Promise.all(instruments.map(async (instrument) => {
    try { return { ticker: instrument.ticker, company: await companyBundle(instrument, env) }; }
    catch (error) { return { ticker: instrument.ticker, error: normaliseError(error).message }; }
  }));
  return json({
    companies: Object.fromEntries(results.filter((result) => result.company).map((result) => [result.ticker, result.company])),
    failures: Object.fromEntries(results.filter((result) => !result.company).map((result) => [result.ticker, result.error])),
    requestedAt: new Date().toISOString(),
  });
}
