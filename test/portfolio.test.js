import assert from "node:assert/strict";
import test from "node:test";
import { BASELINE_CSV } from "../src/fixtures.js";
import { importTrading212 } from "../src/importer.js";
import { portfolioSummary, validateQuote, valueHolding } from "../src/portfolio.js";

const holding = importTrading212(BASELINE_CSV).holdings.AMZN;

test("missing quote does not display zero profit or loss", () => {
  const value = valueHolding(holding, {});
  assert.equal(value.currentValueGBP, null);
  assert.equal(value.profitLossGBP, null);
  assert.equal(value.profitLossPercent, null);
});

test("USD valuation uses shares multiplied by price multiplied by current FX", () => {
  const priced = structuredClone(holding);
  priced.quote = { price: 300, currency: "USD", provider: "Finnhub", providerSymbol: "AMZN", timestamp: Date.now(), sourceField: "Finnhub quote.c" };
  const value = valueHolding(priced, { USDGBP: { rate: 0.75, provider: "Finnhub" } });
  assert.ok(Math.abs(value.currentValueGBP - 0.02523943 * 300 * 0.75) < 1e-10);
});

test("missing GBP conversion preserves native value and leaves GBP unavailable", () => {
  const priced = structuredClone(holding);
  priced.quote = { price: 300, currency: "USD", timestamp: Date.now() };
  const value = valueHolding(priced, {});
  assert.ok(value.currentValueNative > 0);
  assert.equal(value.currentValueGBP, null);
});

test("portfolio total is incomplete when one holding cannot be valued", () => {
  const imported = importTrading212(BASELINE_CSV);
  imported.holdings.AMZN.quote = { price: 300, currency: "USD", timestamp: Date.now() };
  const summary = portfolioSummary(imported.holdings, { USDGBP: { rate: 0.75 } }, 10);
  assert.equal(summary.complete, false);
  assert.equal(summary.totalPortfolioGBP, null);
  assert.equal(summary.profitLossGBP, null);
});

test("invalid and ISIN sourced quote data is rejected", () => {
  assert.equal(validateQuote({ price: 0, timestamp: Date.now() }).accepted, false);
  assert.equal(validateQuote({ price: Number.NaN, timestamp: Date.now() }).accepted, false);
  assert.equal(validateQuote({ price: 100, timestamp: "bad" }).accepted, false);
  assert.equal(validateQuote({ price: 100, timestamp: Date.now(), sourceField: "ISIN" }).accepted, false);
});

test("extreme price movement needs confirmation and preserves last good quote", () => {
  const previous = { price: 100, timestamp: Date.now() - 1000 };
  const first = validateQuote({ price: 1000, timestamp: Date.now(), sourceField: "provider response" }, previous);
  assert.equal(first.accepted, false);
  assert.equal(first.quote, previous);
  const second = validateQuote({ price: 1004, timestamp: Date.now(), sourceField: "provider response" }, previous, first.pending);
  assert.equal(second.accepted, true);
});
