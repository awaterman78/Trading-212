import { DATA_STATUS } from "./config.js";
import { DataClient, statusForError } from "./data-client.js";
import { EXPECTED_BASELINE, FULL_TEST_CSV } from "./fixtures.js";
import { importTrading212 } from "./importer.js";
import { LiveTracker } from "./live-tracker.js";
import { validateQuote, valueHolding } from "./portfolio.js";
import { loadState } from "./storage.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function response(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

export async function runSelfTests() {
  const tests = [];
  const test = async (name, work) => {
    try {
      await work();
      tests.push({ name, passed: true, detail: "Passed" });
    } catch (error) {
      tests.push({ name, passed: false, detail: error.message });
    }
  };

  const imported = importTrading212(FULL_TEST_CSV);
  await test("Trading 212 import identifies 10 holdings", () => assert(imported.summary.holdings === EXPECTED_BASELINE.holdings, `Found ${imported.summary.holdings}`));
  await test("Trading 212 import preserves 13 open lots", () => assert(imported.summary.openLots === EXPECTED_BASELINE.openLots, `Found ${imported.summary.openLots}`));
  await test("Open cost is approximately £69.63", () => assert(Math.abs(imported.summary.openCostGBP - EXPECTED_BASELINE.openCostGBP) < 0.011, `Found £${imported.summary.openCostGBP.toFixed(2)}`));
  await test("CRWD partial sale leaves the intended earlier lot", () => {
    assert(Math.abs(imported.holdings.CRWD.lots[0].shares - EXPECTED_BASELINE.shares.CRWD) < 1e-10, `Found ${imported.holdings.CRWD.lots[0].shares}`);
    assert(imported.closedTrades.find((trade) => trade.id === "CRWD-EXACT-SELL")?.allocations[0]?.method === "exact lot match", "Exact lot matching was not used");
  });
  await test("ASML, EQQQ and TSM retain multiple lots", () => assert(["ASML", "EQQQ", "TSM"].every((ticker) => imported.holdings[ticker].lots.length === 2), "A multi lot holding was collapsed"));
  await test("Deposits and card transactions are ignored", () => assert(imported.ignored.length >= 2 && !imported.holdings[""], "Unrelated activity affected holdings"));
  await test("Closed positions are removed", () => assert(["XOM", "TSLA", "PANW", "ORCL", "CRM", "IWMO", "SMCI"].every((ticker) => !imported.holdings[ticker]), "A closed position remains open"));
  await test("ISIN digits are never parsed as prices", () => {
    assert(imported.holdings.AMZN.lots[0].priceNative === 265.85, "AMZN price did not come from Price / share");
    assert(imported.holdings.LLY.lots[0].priceNative === 1082, "LLY price did not come from Price / share");
  });
  await test("Missing quote does not create profit or loss", () => {
    const value = valueHolding(imported.holdings.AMZN, {});
    assert(value.currentValueGBP === null && value.profitLossGBP === null, "Missing data was converted to zero profit or loss");
  });
  await test("GBP conversion unavailable remains unavailable", () => {
    const holding = structuredClone(imported.holdings.AMZN);
    holding.quote = { price: 300, currency: "USD", timestamp: Date.now(), provider: "Test" };
    const value = valueHolding(holding, {});
    assert(value.currentValueNative > 0 && value.currentValueGBP === null, "A GBP value was invented without FX data");
  });
  await test("Extreme quote requires a second response", () => {
    const previous = { price: 100, timestamp: Date.now() - 1_000, sourceField: "provider response" };
    const first = validateQuote({ price: 1000, timestamp: Date.now(), sourceField: "provider response" }, previous);
    const second = validateQuote({ price: 1005, timestamp: Date.now(), sourceField: "provider response" }, previous, first.pending);
    assert(!first.accepted && second.accepted, "Extreme quote confirmation failed");
  });
  await test("ISIN sourced quote is rejected", () => assert(!validateQuote({ price: 123, timestamp: Date.now(), sourceField: "ISIN" }).accepted, "ISIN quote was accepted"));
  await test("Invalid API key is classified", async () => {
    const client = new DataClient({ apiBase: "https://worker.example", fetchImpl: async () => response(401, { error: "Invalid API key" }) });
    try { await client.health(); throw new Error("Request unexpectedly succeeded"); } catch (error) { assert(statusForError(error) === DATA_STATUS.AUTH_FAILED, "Wrong status classification"); }
  });
  await test("Rate limiting is classified", async () => {
    const client = new DataClient({ apiBase: "https://worker.example", fetchImpl: async () => response(429, { error: "Rate limit" }) });
    try { await client.health(); throw new Error("Request unexpectedly succeeded"); } catch (error) { assert(statusForError(error) === DATA_STATUS.RATE_LIMITED, "Wrong rate limit classification"); }
  });
  await test("Provider timeout is classified", async () => {
    const client = new DataClient({
      apiBase: "https://worker.example",
      timeoutMs: 5,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    });
    try { await client.health(); throw new Error("Request unexpectedly succeeded"); } catch (error) { assert(error.category === "timeout", "Timeout was not preserved"); }
  });
  await test("WebSocket failure falls back to REST polling", async () => {
    let polled = 0;
    class FailedSocket {
      constructor() { queueMicrotask(() => this.onerror?.()); }
      close() {}
    }
    const tracker = new LiveTracker({
      websocketUrl: "wss://worker.example/v1/stream",
      websocketEnabled: true,
      WebSocketFactory: FailedSocket,
      poll: async () => { polled += 1; },
      intervalMs: 60_000,
    });
    tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    tracker.stop();
    assert(polled === 1, `Polling ran ${polled} times`);
  });
  await test("Corrupted local storage is quarantined", () => {
    const storage = memoryStorage({ "northstar-investment-tracker": "{not-json" });
    const loaded = loadState(storage);
    assert(loaded.warning?.includes("quarantined") && Object.keys(loaded.state.holdings).length === 0, "Corruption recovery failed");
  });
  await test("Mobile layout avoids document overflow", () => {
    if (typeof document === "undefined") return;
    assert(document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `Page is ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px too wide`);
  });
  return tests;
}
