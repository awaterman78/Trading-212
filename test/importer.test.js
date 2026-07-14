import assert from "node:assert/strict";
import test from "node:test";
import { EXPECTED_BASELINE, FULL_TEST_CSV } from "../src/fixtures.js";
import { importTrading212, parseCsv } from "../src/importer.js";

const result = importTrading212(FULL_TEST_CSV);

test("supplied Trading 212 fixture produces the expected baseline", () => {
  assert.equal(result.summary.holdings, 10);
  assert.equal(result.summary.openLots, 13);
  assert.ok(Math.abs(result.summary.openCostGBP - 69.63) < 0.011);
  for (const [ticker, shares] of Object.entries(EXPECTED_BASELINE.shares)) {
    assert.ok(Math.abs(result.holdings[ticker].lots.reduce((sum, lot) => sum + lot.shares, 0) - shares) < 1e-10, ticker);
  }
});

test("CRWD exact lot disposal preserves the earlier 0.01030673 share lot", () => {
  assert.equal(result.holdings.CRWD.lots.length, 1);
  assert.ok(Math.abs(result.holdings.CRWD.lots[0].shares - 0.01030673) < 1e-10);
  const sale = result.closedTrades.find((trade) => trade.id === "CRWD-EXACT-SELL");
  assert.equal(sale.allocations[0].method, "exact lot match");
  assert.equal(sale.allocations[0].lotId, "CRWD-EXACT-BUY");
});

test("multiple lots are retained for ASML, EQQQ and TSM", () => {
  for (const ticker of ["ASML", "EQQQ", "TSM"]) assert.equal(result.holdings[ticker].lots.length, 2);
});

test("deposits and card transactions never become holdings", () => {
  assert.ok(result.ignored.some((row) => /deposit/i.test(row.action)));
  assert.ok(result.ignored.some((row) => /card/i.test(row.action)));
  assert.equal(result.holdings[""], undefined);
});

test("closed positions are removed", () => {
  for (const ticker of ["XOM", "TSLA", "PANW", "ORCL", "CRM", "IWMO", "SMCI"]) assert.equal(result.holdings[ticker], undefined, ticker);
  assert.deepEqual(result.closedTickers.sort(), ["CRM", "IWMO", "ORCL", "PANW", "SMCI", "TSLA", "XOM"]);
});

test("prices come from the named Price / share column, never ISIN digits", () => {
  assert.equal(result.holdings.AMZN.lots[0].priceNative, 265.85);
  assert.equal(result.holdings.LLY.lots[0].priceNative, 1082);
  assert.notEqual(result.holdings.AMZN.lots[0].priceNative, 231351067);
  assert.notEqual(result.holdings.LLY.lots[0].priceNative, 5324571083);
});

test("quoted CSV cells are parsed by header", () => {
  const { rows } = parseCsv('Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Currency conversion fee,Currency (Currency conversion fee),Merchant name,Merchant category\nMarket buy,2026-01-01,US0000000001,ABC,"A company, plc",,1,1,12.50,USD,1.25,,,10,GBP,0.01,GBP,,');
  assert.equal(rows[0].Name, "A company, plc");
  assert.equal(rows[0]["Price / share"], "12.50");
});
