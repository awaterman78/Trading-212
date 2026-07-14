import { DEFAULT_SETTINGS, SCHEMA_VERSION, STORAGE_KEY, publicSettings } from "./config.js";

const LEGACY_KEYS = [
  "long-money-engine-clean-v400",
  "t212gm36_us_keys",
  "t212gm93_keys",
  "t212gm93_settings",
  "longMoneyEngineKeys",
  "lme.view",
];

export function createDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    holdings: {},
    transactions: [],
    closedTrades: [],
    watchlist: [],
    watchlistData: {},
    customMappings: {},
    marketData: { fx: {} },
    settings: { ...DEFAULT_SETTINGS },
    diagnostics: {
      status: "Not configured",
      lastRequestAt: null,
      lastSuccessAt: null,
      lastHttpStatus: null,
      lastError: null,
      symbolsRequested: [],
      symbolsUpdated: [],
      symbolsFailed: [],
      rateLimit: null,
      websocketState: "Not started",
      pollingIntervalMs: DEFAULT_SETTINGS.pollingIntervalMs,
      events: [],
    },
    lastImport: null,
    migration: { legacyDetected: [], legacyHoldingsAvailable: false },
  };
}

function safeObject(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function migrateState(input) {
  const clean = createDefaultState();
  const source = safeObject(input, {});
  clean.createdAt = typeof source.createdAt === "string" ? source.createdAt : clean.createdAt;
  clean.holdings = safeObject(source.holdings, {});
  clean.transactions = Array.isArray(source.transactions) ? source.transactions : [];
  clean.closedTrades = Array.isArray(source.closedTrades) ? source.closedTrades : [];
  clean.watchlist = Array.isArray(source.watchlist) ? source.watchlist : [];
  clean.watchlistData = safeObject(source.watchlistData, {});
  clean.customMappings = safeObject(source.customMappings, {});
  clean.marketData = safeObject(source.marketData, { fx: {} });
  clean.marketData.fx = safeObject(clean.marketData.fx, {});
  clean.settings = { ...DEFAULT_SETTINGS, ...publicSettings(source.settings) };
  clean.diagnostics = {
    ...clean.diagnostics,
    ...safeObject(source.diagnostics, {}),
    events: Array.isArray(source.diagnostics?.events) ? source.diagnostics.events.slice(0, 200) : [],
  };
  clean.lastImport = safeObject(source.lastImport, null);
  clean.migration = { ...clean.migration, ...safeObject(source.migration, {}) };
  clean.schemaVersion = SCHEMA_VERSION;
  clean.updatedAt = new Date().toISOString();
  return clean;
}

function detectLegacy(storage) {
  const detected = [];
  let legacyHoldingsAvailable = false;
  for (const key of LEGACY_KEYS) {
    const value = storage.getItem(key);
    if (!value) continue;
    detected.push(key);
    if (key === "long-money-engine-clean-v400") {
      try {
        const parsed = JSON.parse(value);
        legacyHoldingsAvailable = Boolean(parsed?.holdings && Object.keys(parsed.holdings).length);
      } catch {
        legacyHoldingsAvailable = false;
      }
    }
  }
  return { legacyDetected: detected, legacyHoldingsAvailable };
}

export function loadState(storage = globalThis.localStorage) {
  if (!storage) return { state: createDefaultState(), warning: "Storage is unavailable" };
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) {
    const state = createDefaultState();
    state.migration = detectLegacy(storage);
    return { state, warning: state.migration.legacyDetected.length ? "Legacy data was detected but not allowed to overwrite the fresh tracker" : null };
  }
  try {
    return { state: migrateState(JSON.parse(raw)), warning: null };
  } catch (error) {
    const quarantineKey = `${STORAGE_KEY}:corrupt:${Date.now()}`;
    try { storage.setItem(quarantineKey, raw); } catch { /* Storage may be full. */ }
    return { state: createDefaultState(), warning: `Corrupted application data was quarantined as ${quarantineKey}` };
  }
}

export function saveState(state, storage = globalThis.localStorage) {
  const clean = migrateState(state);
  clean.updatedAt = new Date().toISOString();
  storage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function resetHoldings(state) {
  return {
    ...migrateState(state),
    holdings: {},
    transactions: [],
    closedTrades: [],
    lastImport: null,
  };
}

export function resetProviderSettings(state) {
  const clean = migrateState(state);
  clean.settings.apiBase = "";
  clean.settings.pollingIntervalMs = DEFAULT_SETTINGS.pollingIntervalMs;
  clean.diagnostics = createDefaultState().diagnostics;
  return clean;
}

export function exportState(state) {
  const clean = migrateState(state);
  const exported = {
    format: "northstar-investment-tracker-backup",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: clean,
  };
  delete exported.data.migration;
  return JSON.stringify(exported, null, 2);
}

export function restoreState(text) {
  const parsed = JSON.parse(String(text || ""));
  if (parsed?.format !== "northstar-investment-tracker-backup" || !parsed?.data) {
    throw new Error("This is not a Northstar backup file");
  }
  return migrateState(parsed.data);
}

export function clearAll(storage = globalThis.localStorage) {
  storage.removeItem(STORAGE_KEY);
  return createDefaultState();
}

export { LEGACY_KEYS };
