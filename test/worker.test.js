import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/src/index.js";

const origin = "https://awaterman78.github.io";
const env = { FINNHUB_API_KEY: "secret-finn-123", MASSIVE_API_KEY: "secret-massive-456", ALLOWED_ORIGIN: origin };

test("Worker health reveals configuration state without revealing secrets", async () => {
  const response = await worker.fetch(new Request("https://worker.example/health", { headers: { Origin: origin } }), env);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.providers, { finnhub: true, massive: true });
  assert.equal(payload.features.websocket, false);
  assert.doesNotMatch(JSON.stringify(payload), /secret-finn-123|secret-massive-456/, "Response should not include key values");
});

test("Worker rejects an unapproved browser origin", async () => {
  const response = await worker.fetch(new Request("https://worker.example/health", { headers: { Origin: "https://attacker.example" } }), env);
  assert.equal(response.status, 403);
});

test("Worker quote route maps Finnhub fields and keeps key server side", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/quote")) {
      assert.equal(parsed.searchParams.get("token"), "secret-finn-123");
      return new Response(JSON.stringify({ c: 300, pc: 295, d: 5, dp: 1.69, t: 1784052000 }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/stock/market-status")) return new Response(JSON.stringify({ isOpen: false, session: "closed" }), { status: 200 });
    throw new Error(`Unexpected provider URL ${url}`);
  };
  try {
    const response = await worker.fetch(new Request("https://worker.example/v1/quotes", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ instruments: [{ ticker: "AMZN", finnhub: "AMZN", massive: "AMZN", currency: "USD", exchange: "US" }] }),
    }), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.quotes.AMZN.price, 300);
    assert.equal(payload.quotes.AMZN.sourceField, "Finnhub quote.c");
    assert.equal(payload.market.open, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker returns an authentication status when every provider rejects the keys", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
  try {
    const response = await worker.fetch(new Request("https://worker.example/v1/quotes", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ instruments: [{ ticker: "AMZN", finnhub: "AMZN", massive: "AMZN", currency: "USD", exchange: "US" }] }),
    }), env);
    assert.equal(response.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
