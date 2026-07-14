import { DATA_STATUS, SCHEMA_VERSION, SYMBOL_MAP, normaliseTicker, symbolMapping } from "./config.js";
import { createStateDataClient, instrumentsFromState, refreshMarketData } from "./data-client.js";
import { importTrading212, mergeImports } from "./importer.js";
import { LiveTracker } from "./live-tracker.js";
import { portfolioSummary } from "./portfolio.js";
import { recommendationForCandidate, recommendationForHolding } from "./recommendations.js";
import { runSelfTests } from "./self-tests.js";
import { clearAll, exportState, loadState, resetHoldings, resetProviderSettings, restoreState, saveState } from "./storage.js";

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const formatGBP = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)) : "Unavailable";
const formatNumber = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "Unavailable";
const formatShares = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(10).replace(/0+$/, "").replace(/\.$/, "") : "Unavailable";
const formatPercent = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%` : "Unavailable";

let { state, warning: loadWarning } = loadState();
let pendingImport = null;
let pendingCsvText = "";
let liveTracker = null;
let toastTimer = null;

function persist() {
  state = saveState(state);
}

function toast(message) {
  const element = byId("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3_800);
}

function ageLabel(timestamp) {
  const parsed = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "Never";
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function nativeMoney(value, currency) {
  if (!Number.isFinite(Number(value))) return "Unavailable";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(Number(value));
  } catch {
    return `${formatNumber(value)} ${currency || ""}`.trim();
  }
}

function route(name) {
  document.querySelectorAll("[data-view]").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.route === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
  byId("app").focus({ preventScroll: true });
}

function statusTone(status) {
  if ([DATA_STATUS.POLLING, DATA_STATUS.WEBSOCKET, DATA_STATUS.MARKET_CLOSED].includes(status)) return "good";
  if ([DATA_STATUS.PARTIAL, DATA_STATUS.RATE_LIMITED, DATA_STATUS.SYMBOL_UNSUPPORTED, DATA_STATUS.CONNECTING].includes(status)) return "warn";
  if ([DATA_STATUS.AUTH_FAILED, DATA_STATUS.PROVIDER_UNAVAILABLE, DATA_STATUS.OFFLINE].includes(status)) return "bad";
  return "";
}

function renderStatus() {
  const status = state.diagnostics.status || DATA_STATUS.NOT_CONFIGURED;
  byId("data-status-label").textContent = status;
  byId("data-status-dot").className = `status-dot ${statusTone(status)}`;
}

function recommendationPriority(recommendation) {
  return ({ Exit: 90, Reduce: 80, Trim: 70, Review: 60, "Watch for entry": 40, Hold: 30, Add: 20 })[recommendation.action] || 0;
}

function emptyPriority() {
  return `<div class="empty-state"><strong>Start with your plan, not a hot tip</strong><p>Import Trading 212 activity or add a business to your watchlist. Northstar will separate the facts from the judgement.</p><button class="primary-button compact" data-route="activity" type="button">Import activity</button></div>`;
}

function renderHome() {
  const summary = portfolioSummary(state.holdings, state.marketData?.fx || {}, state.settings.cashGBP, state.settings);
  const heroValue = byId("portfolio-value");
  const heroChange = byId("portfolio-change");
  byId("total-cost").textContent = formatGBP(summary.totalCostGBP);
  byId("cash-value").textContent = formatGBP(summary.cashGBP);
  byId("quote-coverage").textContent = `${summary.valuedHoldings} of ${summary.holdingCount}`;

  if (!summary.holdingCount) {
    heroValue.textContent = formatGBP(summary.cashGBP);
    heroChange.textContent = summary.cashGBP ? "Cash only, no investments currently held" : "No current positions";
    byId("freshness-label").textContent = "Ready for a fresh start";
  } else if (!summary.complete) {
    heroValue.textContent = `${formatGBP(summary.knownMarketValueGBP)} known`;
    heroChange.textContent = `${summary.missingHoldings} holding${summary.missingHoldings === 1 ? "" : "s"} cannot be valued in GBP`;
    heroChange.className = "hero-change";
    byId("freshness-label").textContent = "Incomplete valuation";
  } else {
    heroValue.textContent = formatGBP(summary.totalPortfolioGBP);
    heroChange.textContent = `${formatGBP(summary.profitLossGBP)}  ${formatPercent(summary.profitLossPercent)} since purchase`;
    heroChange.className = `hero-change ${summary.profitLossGBP >= 0 ? "positive" : "negative"}`;
    const timestamps = summary.holdings.map((item) => item.value.quote?.timestamp).filter(Boolean);
    byId("freshness-label").textContent = timestamps.length ? `Oldest quote ${ageLabel(Math.min(...timestamps))}` : "No quotes";
  }

  const attention = byId("attention-card");
  const warnings = summary.holdings.filter((item) => item.value.warning || item.value.stale);
  attention.classList.toggle("hidden", warnings.length === 0);
  if (warnings.length) {
    byId("attention-title").textContent = `${warnings.length} data issue${warnings.length === 1 ? "" : "s"} need review`;
    byId("attention-copy").textContent = warnings.slice(0, 2).map((item) => `${item.holding.ticker}: ${item.value.warning || "Quote is stale"}`).join(". ");
  }

  const recommendations = summary.holdings.map((item) => ({
    ticker: item.holding.ticker,
    ...recommendationForHolding(item.holding, item.value, item.concentrationPercent, state.settings),
  })).sort((left, right) => recommendationPriority(right) - recommendationPriority(left) || left.ticker.localeCompare(right.ticker));
  byId("priority-action").innerHTML = recommendations.length ? renderPriority(recommendations[0]) : emptyPriority();
  byId("holdings-list").innerHTML = summary.holdings.length
    ? summary.holdings.sort((left, right) => left.holding.ticker.localeCompare(right.holding.ticker)).map(renderHolding).join("")
    : `<div class="empty-state"><strong>You are currently in cash</strong><p>That is a valid position. Import your next Trading 212 CSV when you start investing again.</p><button class="primary-button compact" data-route="discover" type="button">Build a watchlist</button></div>`;
}

function renderPriority(item) {
  const important = item.signals.filter((signal) => signal.available).sort((left, right) => Math.abs(right.value) - Math.abs(left.value)).slice(0, 3);
  return `<div class="priority-header"><div><span class="pill ${escapeHtml(item.tone)}">${escapeHtml(item.action)}</span><div class="action-name">${escapeHtml(item.ticker)}</div></div><span class="pill">${escapeHtml(item.confidence)} confidence</span></div><p class="action-copy">${escapeHtml(item.judgement)}</p><div class="signal-line">${important.map((signal) => `<span class="pill ${signal.value > 0 ? "good" : signal.value < 0 ? "warn" : ""}">${escapeHtml(signal.label)}: ${escapeHtml(signal.fact)}</span>`).join("")}</div>`;
}

function renderHolding(item) {
  const { holding, value, concentrationPercent } = item;
  const recommendation = recommendationForHolding(holding, value, concentrationPercent, state.settings);
  const currentValue = value.currentValueGBP === null ? "Not valued" : formatGBP(value.currentValueGBP);
  const profit = value.profitLossGBP === null ? "P/L unavailable" : `${formatGBP(value.profitLossGBP)} ${formatPercent(value.profitLossPercent)}`;
  const quoteSource = value.quote ? `${value.quote.provider} ${value.quote.providerSymbol}` : "No provider quote";
  const warning = value.warning || (value.stale ? "Quote is stale" : holding.mapping?.warning || "");
  return `<article class="holding-card ${warning ? "alert" : ""}">
    <div class="holding-top">
      <div class="holding-identity"><span class="ticker-tile">${escapeHtml(holding.ticker)}</span><div class="holding-name"><strong>${escapeHtml(holding.name || holding.ticker)}</strong><span>${formatShares(value.shares)} shares · ${value.lots.length} open lot${value.lots.length === 1 ? "" : "s"}</span></div></div>
      <div class="holding-value"><strong>${currentValue}</strong><span class="${value.profitLossGBP === null ? "" : value.profitLossGBP >= 0 ? "positive" : "negative"}">${profit}</span></div>
    </div>
    <div class="holding-stats">
      <div><span>Average cost</span><strong>${nativeMoney(value.averageCostNative, value.purchaseCurrency)}</strong></div>
      <div><span>Total cost</span><strong>${formatGBP(value.totalCostGBP)}</strong></div>
      <div><span>Current price</span><strong>${nativeMoney(value.currentPrice, value.quoteCurrency)}</strong></div>
      <div><span>Position</span><strong>${concentrationPercent === null ? "Unavailable" : `${concentrationPercent.toFixed(1)}%`}</strong></div>
      <div><span>History</span><strong>${escapeHtml(value.historicalStatus)}</strong></div>
      <div><span>Action</span><strong>${escapeHtml(recommendation.action)}</strong></div>
    </div>
    <div class="holding-footer"><span>${escapeHtml(quoteSource)} · ${value.quote ? ageLabel(value.quote.timestamp) : "Never updated"}${warning ? ` · ${escapeHtml(warning)}` : ""}</span><button class="text-button" data-show-reasons="${escapeHtml(holding.ticker)}" type="button">Why?</button></div>
    <div class="inline-message neutral hidden" id="reasons-${escapeHtml(holding.ticker)}"><strong>${escapeHtml(recommendation.judgement)}</strong><br>${recommendation.signals.map((signal) => `${escapeHtml(signal.label)}: ${escapeHtml(signal.fact)}`).join("<br>")}<br><em>${escapeHtml(recommendation.disclaimer)}</em></div>
  </article>`;
}

function renderDiscover() {
  const tickers = [...(state.watchlist || [])].sort((left, right) => {
    const leftScore = recommendationForCandidate(state.watchlistData?.[left] || { ticker: left, mapping: symbolMapping(left, state.customMappings) }).score || 0;
    const rightScore = recommendationForCandidate(state.watchlistData?.[right] || { ticker: right, mapping: symbolMapping(right, state.customMappings) }).score || 0;
    return rightScore - leftScore || left.localeCompare(right);
  });
  byId("watchlist-list").innerHTML = tickers.length ? tickers.map((ticker) => {
    const candidate = state.watchlistData?.[ticker] || { ticker, mapping: symbolMapping(ticker, state.customMappings) };
    const recommendation = recommendationForCandidate(candidate);
    const mapping = candidate.mapping || symbolMapping(ticker, state.customMappings);
    return `<article class="holding-card"><div class="holding-top"><div class="holding-identity"><span class="ticker-tile">${escapeHtml(ticker)}</span><div class="holding-name"><strong>${escapeHtml(mapping?.name || ticker)}</strong><span>${escapeHtml(mapping?.exchange || "Mapping required")} · ${escapeHtml(candidate.quote?.provider || "No quote")}</span></div></div><div class="holding-value"><strong>${nativeMoney(candidate.quote?.price, candidate.quote?.currency || mapping?.tradingCurrency)}</strong><span>${escapeHtml(recommendation.action)}</span></div></div><p class="action-copy">${escapeHtml(recommendation.judgement)}</p><div class="holding-footer"><span>${candidate.history?.bars?.length || 0} history bars · ${recommendation.confidence || "Low"} confidence</span><button class="text-button" data-refresh-watch="${escapeHtml(ticker)}" type="button">Refresh</button></div></article>`;
  }).join("") : `<div class="empty-state"><strong>No watchlist yet</strong><p>Add a mapped ticker above. This is for considered research, not twenty flashing buy buttons.</p></div>`;
}

function renderActivity() {
  byId("cash-input").value = String(state.settings.cashGBP || "");
  const grouped = new Map();
  for (const trade of state.closedTrades || []) {
    const current = grouped.get(trade.ticker) || { ticker: trade.ticker, realisedGBP: 0, trades: 0 };
    current.realisedGBP += Number(trade.realisedGBP) || 0;
    current.trades += 1;
    grouped.set(trade.ticker, current);
  }
  byId("closed-positions").innerHTML = grouped.size ? [...grouped.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)).map((item) => `<div class="activity-row"><div><strong>${escapeHtml(item.ticker)}</strong><span>${item.trades} disposal${item.trades === 1 ? "" : "s"}</span></div><strong class="${item.realisedGBP >= 0 ? "positive" : "negative"}">${formatGBP(item.realisedGBP)}</strong></div>`).join("") : `<p class="empty-copy">No closed trades recorded in the current import.</p>`;
}

function renderDiagnostics() {
  const diagnostic = state.diagnostics;
  byId("api-base-input").value = state.settings.apiBase || "";
  byId("polling-input").value = String(state.settings.pollingIntervalMs);
  const cards = [
    ["Connection", diagnostic.status, diagnostic.websocketState || "WebSocket not started"],
    ["Last request", ageLabel(diagnostic.lastRequestAt), diagnostic.lastHttpStatus ? `HTTP ${diagnostic.lastHttpStatus}` : "No HTTP response"],
    ["Last success", ageLabel(diagnostic.lastSuccessAt), diagnostic.symbolsUpdated?.length ? `${diagnostic.symbolsUpdated.length} symbols updated` : "Nothing updated"],
    ["Polling", `${Math.round((diagnostic.pollingIntervalMs || state.settings.pollingIntervalMs) / 60_000)} minutes`, diagnostic.rateLimit ? `Remaining ${diagnostic.rateLimit.remaining ?? "unknown"}` : "No rate header"],
  ];
  byId("diagnostic-summary").innerHTML = cards.map(([label, value, detail]) => `<div class="diagnostic-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`).join("");

  const tickers = [...new Set([...Object.keys(state.holdings || {}), ...(state.watchlist || [])])].sort();
  byId("mapping-list").innerHTML = tickers.length ? tickers.map((ticker) => {
    const mapping = state.holdings[ticker]?.mapping || symbolMapping(ticker, state.customMappings);
    return `<div class="mapping-row"><div><strong>${escapeHtml(ticker)} · ${escapeHtml(mapping?.name || "Unmapped")}</strong><span>${escapeHtml(mapping?.warning || `${mapping?.exchange || "Unknown exchange"}, ${mapping?.tradingCurrency || "unknown currency"}`)}</span></div><div><strong>${escapeHtml(mapping?.providers?.finnhub || "Finnhub unsupported")}</strong><span>${escapeHtml(mapping?.providers?.massive || "Massive unsupported")}</span></div></div>`;
  }).join("") : `<p class="empty-copy">Mappings appear when holdings or watchlist symbols are added.</p>`;

  byId("request-log").innerHTML = diagnostic.events?.length ? diagnostic.events.slice(0, 30).map((event) => `<div class="request-row"><div><strong>${escapeHtml(event.method)} ${escapeHtml(event.path)}</strong><span>${escapeHtml(event.message)} · ${event.durationMs ?? 0} ms · ${ageLabel(event.finishedAt)}</span></div><strong class="${event.ok ? "positive" : "negative"}">${event.status || "Network"}</strong></div>`).join("") : `<p class="empty-copy">No provider requests have been made.</p>`;
}

function renderSettings() {
  byId("schema-version").textContent = String(SCHEMA_VERSION);
}

function render() {
  renderStatus();
  renderHome();
  renderDiscover();
  renderActivity();
  renderDiagnostics();
  renderSettings();
}

async function refresh({ deep = false, quiet = false } = {}) {
  if (!state.settings.apiBase) {
    state.diagnostics.status = DATA_STATUS.NOT_CONFIGURED;
    persist();
    render();
    if (!quiet) toast("Add the Cloudflare Worker URL in Data first.");
    return;
  }
  byId("refresh-button").disabled = true;
  renderStatus();
  try {
    const client = createStateDataClient(state, { onEvent: () => persist() });
    const result = await refreshMarketData(state, { client, deep });
    persist();
    render();
    if (!quiet) toast(result.failed.length ? `${result.updated.length} updated, ${result.failed.length} issue${result.failed.length === 1 ? "" : "s"}.` : `${result.updated.length} holding${result.updated.length === 1 ? "" : "s"} updated.`);
  } finally {
    byId("refresh-button").disabled = false;
  }
}

async function refreshWatchlist(tickers) {
  if (!state.settings.apiBase) { toast("Configure the Worker URL before refreshing research data."); route("diagnostics"); return; }
  const client = createStateDataClient(state, { onEvent: () => persist() });
  const instruments = instrumentsFromState(state, tickers);
  try {
    const [quotes, history, companies] = await Promise.all([client.quotes(instruments), client.history(instruments), client.company(instruments)]);
    state.watchlistData = state.watchlistData || {};
    for (const ticker of tickers) {
      state.watchlistData[ticker] = {
        ticker,
        mapping: symbolMapping(ticker, state.customMappings),
        quote: quotes.quotes?.[ticker] || state.watchlistData[ticker]?.quote || null,
        history: history.history?.[ticker] || state.watchlistData[ticker]?.history || null,
        company: companies.companies?.[ticker] || state.watchlistData[ticker]?.company || null,
      };
    }
    state.diagnostics.status = Object.keys(quotes.failures || {}).length ? DATA_STATUS.PARTIAL : DATA_STATUS.POLLING;
    persist();
    render();
    toast(`Research data refreshed for ${tickers.join(", ")}.`);
  } catch (error) {
    state.diagnostics.status = DATA_STATUS.PARTIAL;
    persist();
    render();
    toast(`Research refresh failed: ${error.message}`);
  }
}

async function startTracking() {
  liveTracker?.stop();
  if (!state.settings.apiBase || !Object.keys(state.holdings).length) return;
  const client = createStateDataClient(state, { onEvent: () => persist() });
  let health;
  try { health = await client.health(); } catch (error) {
    state.diagnostics.status = error.status === 401 || error.status === 403 ? DATA_STATUS.AUTH_FAILED : DATA_STATUS.PROVIDER_UNAVAILABLE;
    persist();
    render();
    return;
  }
  const websocketUrl = state.settings.apiBase.replace(/^http/i, "ws") + "/v1/stream";
  liveTracker = new LiveTracker({
    websocketUrl,
    websocketEnabled: Boolean(health.features?.websocket),
    poll: () => refresh({ quiet: true }),
    intervalMs: state.settings.pollingIntervalMs,
    onStatus: (status) => {
      state.diagnostics.status = status;
      state.diagnostics.websocketState = status === DATA_STATUS.WEBSOCKET ? "Open" : status === DATA_STATUS.POLLING ? "Unavailable, REST fallback active" : status;
      persist();
      renderStatus();
    },
  });
  liveTracker.start();
}

async function previewCsv(file) {
  pendingCsvText = await file.text();
  try {
    pendingImport = importTrading212(pendingCsvText, { customMappings: state.customMappings });
    const summary = pendingImport.summary;
    byId("import-preview").className = "inline-message good";
    byId("import-preview").textContent = `${summary.holdings} holdings, ${summary.openLots} open lots, ${formatGBP(summary.openCostGBP)} open cost, ${summary.quarantinedRows} quarantined rows.`;
    byId("import-replace").disabled = false;
    byId("import-append").disabled = false;
  } catch (error) {
    pendingImport = null;
    byId("import-preview").className = "inline-message bad";
    byId("import-preview").textContent = error.message;
    byId("import-replace").disabled = true;
    byId("import-append").disabled = true;
  }
}

function applyImport(result) {
  state.holdings = result.holdings;
  state.transactions = result.transactions;
  state.closedTrades = result.closedTrades;
  state.lastImport = { importedAt: result.importedAt, summary: result.summary, quarantine: result.quarantine, ignored: result.ignored };
  persist();
  render();
  startTracking();
}

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function wireEvents() {
  document.body.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.route) { route(button.dataset.route); return; }
    if (button.dataset.showReasons) { byId(`reasons-${button.dataset.showReasons}`)?.classList.toggle("hidden"); return; }
    if (button.dataset.refreshWatch) { await refreshWatchlist([button.dataset.refreshWatch]); return; }
  });

  byId("refresh-button").addEventListener("click", () => refresh({ deep: true }));
  byId("csv-file").addEventListener("change", (event) => event.target.files?.[0] && previewCsv(event.target.files[0]));
  byId("import-replace").addEventListener("click", () => {
    if (!pendingImport) return;
    applyImport(pendingImport);
    toast("Holdings replaced from the selected Trading 212 CSV.");
    route("home");
  });
  byId("import-append").addEventListener("click", () => {
    if (!pendingImport) return;
    const merged = mergeImports(state, pendingImport, { customMappings: state.customMappings });
    applyImport(merged);
    toast("New activity merged by transaction ID and holdings rebuilt.");
    route("home");
  });
  byId("save-cash").addEventListener("click", () => {
    state.settings.cashGBP = Math.max(0, Number(byId("cash-input").value) || 0);
    persist();
    render();
    toast("Cash balance saved.");
  });
  byId("watchlist-add").addEventListener("click", async () => {
    const ticker = normaliseTicker(byId("watchlist-input").value);
    const mapping = symbolMapping(ticker, state.customMappings);
    if (!mapping) { toast("That ticker needs an explicit provider mapping before it can be added."); return; }
    state.watchlist = [...new Set([...(state.watchlist || []), ticker])];
    byId("watchlist-input").value = "";
    persist();
    render();
    await refreshWatchlist([ticker]);
  });
  byId("scan-ideas").addEventListener("click", async () => {
    const universe = ["AAPL", "MSFT", "META", "V", "MA"].filter((ticker) => !state.holdings[ticker]);
    if (!universe.length) { toast("All five starter ideas are already held."); return; }
    state.watchlist = [...new Set([...(state.watchlist || []), ...universe])];
    persist();
    render();
    await refreshWatchlist(universe);
  });
  byId("save-provider-settings").addEventListener("click", async () => {
    state.settings.apiBase = byId("api-base-input").value.trim().replace(/\/$/, "");
    state.settings.pollingIntervalMs = Number(byId("polling-input").value) || 900_000;
    state.diagnostics.pollingIntervalMs = state.settings.pollingIntervalMs;
    persist();
    render();
    if (!state.settings.apiBase) { toast("Enter the Worker URL first."); return; }
    const client = createStateDataClient(state, { onEvent: () => persist() });
    try {
      const health = await client.health();
      const missing = Object.entries(health.providers || {}).filter(([, configured]) => !configured).map(([provider]) => provider);
      state.diagnostics.status = missing.length === 2 ? DATA_STATUS.NOT_CONFIGURED : missing.length ? DATA_STATUS.PARTIAL : DATA_STATUS.CONNECTING;
      persist();
      render();
      toast(missing.length ? `Worker reached. Missing secrets: ${missing.join(", ")}.` : "Worker reached and both providers are configured.");
      await startTracking();
    } catch (error) {
      state.diagnostics.status = error.status === 401 || error.status === 403 ? DATA_STATUS.AUTH_FAILED : DATA_STATUS.PROVIDER_UNAVAILABLE;
      persist();
      render();
      toast(`Worker test failed: ${error.message}`);
    }
  });
  byId("reset-provider-settings").addEventListener("click", () => {
    liveTracker?.stop();
    state = resetProviderSettings(state);
    persist();
    render();
    toast("Provider settings reset. Holdings were not changed.");
  });
  byId("clear-diagnostics").addEventListener("click", () => {
    state.diagnostics.events = [];
    state.diagnostics.lastError = null;
    persist();
    render();
  });
  byId("run-tests").addEventListener("click", async () => {
    byId("test-results").innerHTML = `<p class="empty-copy">Running checks…</p>`;
    const tests = await runSelfTests();
    byId("test-results").innerHTML = tests.map((test) => `<div class="test-row"><span class="test-mark ${test.passed ? "pass" : "fail"}">${test.passed ? "✓" : "×"}</span><div><strong>${escapeHtml(test.name)}</strong><span>${escapeHtml(test.detail)}</span></div></div>`).join("");
  });
  byId("export-json").addEventListener("click", () => download(`northstar-backup-${new Date().toISOString().slice(0, 10)}.json`, exportState(state)));
  byId("restore-json").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state = restoreState(await file.text());
      persist();
      render();
      startTracking();
      toast("Backup restored.");
    } catch (error) { toast(`Restore failed: ${error.message}`); }
  });
  byId("reset-holdings").addEventListener("click", () => {
    if (!window.confirm("Reset holdings, transactions and closed trades? Provider settings will remain.")) return;
    state = resetHoldings(state);
    persist();
    render();
    toast("Holdings reset.");
  });
  byId("reset-app").addEventListener("click", () => {
    if (!window.confirm("Reset all Northstar application data on this device?")) return;
    liveTracker?.stop();
    state = clearAll();
    persist();
    render();
    toast("Application data reset.");
  });
}

wireEvents();
render();
if (loadWarning) toast(loadWarning);
startTracking();
