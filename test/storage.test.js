import assert from "node:assert/strict";
import test from "node:test";
import { STORAGE_KEY } from "../src/config.js";
import { createDefaultState, exportState, loadState, restoreState, saveState } from "../src/storage.js";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
}

test("corrupted localStorage is quarantined and reset safely", () => {
  const fake = storage({ [STORAGE_KEY]: "{broken" });
  const loaded = loadState(fake);
  assert.match(loaded.warning, /quarantined/);
  assert.deepEqual(loaded.state.holdings, {});
  assert.ok([...fake.values.keys()].some((key) => key.startsWith(`${STORAGE_KEY}:corrupt:`)));
});

test("legacy God Mode data cannot overwrite the fresh state", () => {
  const fake = storage({ "long-money-engine-clean-v400": JSON.stringify({ holdings: { BAD: { currentPrice: 99999999 } }, settings: { finnhubKey: "secret" } }) });
  const loaded = loadState(fake);
  assert.deepEqual(loaded.state.holdings, {});
  assert.equal(loaded.state.settings.finnhubKey, undefined);
  assert.equal(loaded.state.migration.legacyHoldingsAvailable, true);
});

test("backup excludes provider keys even if an old key is injected", () => {
  const state = createDefaultState();
  state.settings.finnhubKey = "do-not-export";
  state.settings.massiveKey = "do-not-export-either";
  const exported = exportState(state);
  assert.doesNotMatch(exported, /do-not-export/);
  assert.doesNotMatch(exported, /finnhubKey|massiveKey/);
  assert.equal(restoreState(exported).schemaVersion, state.schemaVersion);
});

test("last known FX data survives local persistence", () => {
  const fake = storage();
  const state = createDefaultState();
  state.marketData.fx.USDGBP = { rate: 0.75, provider: "Finnhub", timestamp: Date.now() };
  saveState(state, fake);
  assert.equal(loadState(fake).state.marketData.fx.USDGBP.rate, 0.75);
});
