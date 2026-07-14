import assert from "node:assert/strict";
import test from "node:test";
import { DATA_STATUS, symbolMapping } from "../src/config.js";
import { DataClient, refreshMarketData, statusForError } from "../src/data-client.js";
import { BASELINE_CSV } from "../src/fixtures.js";
import { importTrading212 } from "../src/importer.js";
import { createDefaultState } from "../src/storage.js";

const makeResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("invalid API key is reported as authentication failed", async () => {
  const client = new DataClient({ apiBase: "https://worker.example", fetchImpl: async () => makeResponse(401, { error: "Invalid key" }) });
  await assert.rejects(client.health(), (error) => statusForError(error) === DATA_STATUS.AUTH_FAILED);
});

test("rate limit response is reported", async () => {
  const client = new DataClient({ apiBase: "https://worker.example", fetchImpl: async () => makeResponse(429, { error: "Slow down" }) });
  await assert.rejects(client.health(), (error) => statusForError(error) === DATA_STATUS.RATE_LIMITED);
});

test("provider timeout aborts and reports timeout category", async () => {
  const client = new DataClient({
    apiBase: "https://worker.example",
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
  });
  await assert.rejects(client.health(), (error) => error.category === "timeout");
});

test("market closed loads latest quote without looking broken", async () => {
  const state = createDefaultState();
  state.settings.apiBase = "https://worker.example";
  state.holdings = { AMZN: importTrading212(BASELINE_CSV).holdings.AMZN };
  const client = {
    quotes: async () => ({ quotes: { AMZN: { price: 300, currency: "USD", timestamp: Date.now(), provider: "Finnhub", providerSymbol: "AMZN", sourceField: "Finnhub quote.c" } }, failures: {}, market: { open: false } }),
    fx: async () => ({ rates: { USDGBP: { rate: 0.75, timestamp: Date.now(), provider: "Finnhub" } } }),
  };
  const result = await refreshMarketData(state, { client });
  assert.equal(result.status, DATA_STATUS.MARKET_CLOSED);
  assert.equal(state.holdings.AMZN.quote.price, 300);
});

test("incorrect provider symbol failure preserves the last known good quote", async () => {
  const state = createDefaultState();
  state.settings.apiBase = "https://worker.example";
  const holding = importTrading212(BASELINE_CSV).holdings.AMZN;
  holding.quote = { price: 290, currency: "USD", timestamp: Date.now() - 60_000, provider: "Finnhub" };
  state.holdings = { AMZN: holding };
  const client = { quotes: async () => ({ quotes: {}, failures: { AMZN: "Symbol not supported" }, market: { open: true } }), fx: async () => ({ rates: {} }) };
  const result = await refreshMarketData(state, { client });
  assert.equal(result.status, DATA_STATUS.SYMBOL_UNSUPPORTED);
  assert.equal(state.holdings.AMZN.quote.price, 290);
});

test("EQQQ has explicit and non substituting provider mapping", () => {
  const mapping = symbolMapping("EQQQ");
  assert.equal(mapping.providers.finnhub, "EQQQ.L");
  assert.equal(mapping.providers.massive, null);
  assert.notEqual(mapping.providers.finnhub, "QQQ");
});
