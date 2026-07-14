import { normaliseTicker, symbolMapping } from "./config.js";
import { TRADING_212_HEADERS } from "./fixtures.js";

const EPSILON = 1e-10;
const REQUIRED_HEADERS = [
  "Action",
  "Time",
  "ISIN",
  "Ticker",
  "Name",
  "ID",
  "No. of shares",
  "Price / share",
  "Currency (Price / share)",
  "Exchange rate",
  "Total",
  "Currency (Total)",
  "Currency conversion fee",
];

export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  let text = String(value).trim().replace(/^"|"$/g, "").replace(/[£$€%\s]/g, "");
  if (!text || text === "-") return null;
  const bracketNegative = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, "");
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (comma >= 0) {
    const thousands = /^[-+]?\d{1,3}(,\d{3})+$/.test(text);
    text = thousands ? text.replace(/,/g, "") : text.replace(",", ".");
  }
  text = text.replace(/[^0-9+\-.]/g, "");
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return bracketNegative ? -parsed : parsed;
}

export function parseCsv(text) {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  const rawRows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rawRows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((entry) => String(entry).trim())) rawRows.push(row);
  if (!rawRows.length) return { headers: [], rows: [] };

  const headers = rawRows.shift().map((header) => String(header).trim());
  const rows = rawRows
    .filter((values) => values.some((value) => String(value).trim()))
    .map((values, rowIndex) => ({
      __row: rowIndex + 2,
      ...Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? "").trim()])),
    }));
  return { headers, rows };
}

export function validateHeaders(headers) {
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  return { valid: missing.length === 0, missing, recognised: TRADING_212_HEADERS.filter((header) => headers.includes(header)) };
}

function tradeKind(action) {
  const lower = String(action || "").toLowerCase().trim();
  if (/\bbuy\b/.test(lower)) return "buy";
  if (/\bsell\b/.test(lower)) return "sell";
  return null;
}

function isUnrelatedAction(action) {
  return /(deposit|withdraw|card|cash interest|interest on cash|dividend|lending interest|free funds)/i.test(String(action || ""));
}

function calculatedCostGBP(row, shares, price, exchangeRate) {
  const total = parseNumber(row.Total);
  if (Number.isFinite(total)) return Math.abs(total);
  if (shares > 0 && price > 0 && exchangeRate > 0) return (shares * price) / exchangeRate;
  return null;
}

function createHolding(row, ticker, mappings) {
  const mapping = symbolMapping(ticker, mappings);
  return {
    ticker,
    name: String(row.Name || mapping?.name || ticker),
    isin: String(row.ISIN || ""),
    mapping: mapping ? structuredClone(mapping) : null,
    lots: [],
    quote: null,
    history: null,
    company: null,
    pendingExtremeQuote: null,
  };
}

function closeFromLot(lot, quantity) {
  const before = lot.shares;
  const ratio = quantity / before;
  const costGBP = lot.costGBP * ratio;
  const feeGBP = lot.feeGBP * ratio;
  lot.shares = Math.max(0, before - quantity);
  lot.costGBP = Math.max(0, lot.costGBP - costGBP);
  lot.feeGBP = Math.max(0, lot.feeGBP - feeGBP);
  return { costGBP, feeGBP };
}

export function removeLotsExactThenFifo(holding, quantity) {
  let remaining = quantity;
  let basisGBP = 0;
  const allocations = [];
  const lots = holding.lots.sort((left, right) => String(left.acquiredAt).localeCompare(String(right.acquiredAt)));
  const exactCandidates = lots
    .map((lot, index) => ({ lot, index }))
    .filter(({ lot }) => Math.abs(lot.shares - quantity) <= EPSILON);

  if (exactCandidates.length) {
    const { lot } = exactCandidates.at(-1);
    const closed = closeFromLot(lot, quantity);
    basisGBP += closed.costGBP + closed.feeGBP;
    allocations.push({ lotId: lot.id, shares: quantity, basisGBP: closed.costGBP + closed.feeGBP, method: "exact lot match" });
    remaining = 0;
  }

  for (const lot of lots) {
    if (remaining <= EPSILON) break;
    if (lot.shares <= EPSILON) continue;
    const shares = Math.min(lot.shares, remaining);
    const closed = closeFromLot(lot, shares);
    basisGBP += closed.costGBP + closed.feeGBP;
    allocations.push({ lotId: lot.id, shares, basisGBP: closed.costGBP + closed.feeGBP, method: "FIFO" });
    remaining -= shares;
  }

  holding.lots = lots.filter((lot) => lot.shares > EPSILON);
  return { basisGBP, allocations, unmatchedShares: Math.max(0, remaining) };
}

export function importTrading212(text, { customMappings = {} } = {}) {
  const { headers, rows } = parseCsv(text);
  const headerCheck = validateHeaders(headers);
  if (!headerCheck.valid) {
    throw new Error(`Trading 212 CSV is missing required columns: ${headerCheck.missing.join(", ")}`);
  }

  const holdings = {};
  const closedTrades = [];
  const transactions = [];
  const quarantine = [];
  const ignored = [];
  const sortedRows = [...rows].sort((left, right) => String(left.Time || "").localeCompare(String(right.Time || "")));

  for (const row of sortedRows) {
    const action = String(row.Action || "").trim();
    const kind = tradeKind(action);
    const ticker = normaliseTicker(row.Ticker);

    if (!kind) {
      ignored.push({ row: row.__row, action, reason: isUnrelatedAction(action) ? "Non trade activity" : "Unsupported action" });
      continue;
    }

    const shares = parseNumber(row["No. of shares"]);
    const price = parseNumber(row["Price / share"]);
    const exchangeRate = parseNumber(row["Exchange rate"]);
    const feeGBP = Math.abs(parseNumber(row["Currency conversion fee"]) || 0);
    const totalGBP = calculatedCostGBP(row, shares, price, exchangeRate);
    const id = String(row.ID || `row-${row.__row}`);

    if (!ticker || !(shares > 0) || !(price > 0) || !(totalGBP >= 0)) {
      quarantine.push({
        row: row.__row,
        id,
        ticker,
        reason: "Trade is missing a valid ticker, share quantity, price or total",
        source: { action, isin: row.ISIN, shares: row["No. of shares"], price: row["Price / share"], total: row.Total },
      });
      continue;
    }

    const transaction = {
      id,
      row: row.__row,
      action,
      kind,
      time: String(row.Time || ""),
      ticker,
      isin: String(row.ISIN || ""),
      name: String(row.Name || ticker),
      shares,
      priceNative: price,
      priceCurrency: String(row["Currency (Price / share)"] || "").toUpperCase(),
      exchangeRate,
      totalGBP,
      feeGBP,
      resultCurrency: String(row["Currency (Total)"] || "").toUpperCase(),
    };
    transactions.push(transaction);

    if (kind === "buy") {
      const holding = holdings[ticker] || createHolding(row, ticker, customMappings);
      holding.name = holding.name || transaction.name;
      holding.isin = holding.isin || transaction.isin;
      holding.lots.push({
        id,
        acquiredAt: transaction.time,
        shares,
        originalShares: shares,
        priceNative: price,
        priceCurrency: transaction.priceCurrency || "USD",
        exchangeRateAtPurchase: exchangeRate,
        costGBP: totalGBP,
        feeGBP,
      });
      holdings[ticker] = holding;
      continue;
    }

    const holding = holdings[ticker];
    if (!holding) {
      quarantine.push({ row: row.__row, id, ticker, reason: "Sell has no earlier open buy" });
      continue;
    }

    const closed = removeLotsExactThenFifo(holding, shares);
    const proceedsGBP = Math.max(0, totalGBP - feeGBP);
    closedTrades.push({
      ...transaction,
      proceedsGBP,
      basisGBP: closed.basisGBP,
      realisedGBP: proceedsGBP - closed.basisGBP,
      allocations: closed.allocations,
      unmatchedShares: closed.unmatchedShares,
    });
    if (closed.unmatchedShares > EPSILON) {
      quarantine.push({ row: row.__row, id, ticker, reason: `Sell exceeds open quantity by ${closed.unmatchedShares}` });
    }
    if (!holding.lots.length) delete holdings[ticker];
  }

  const closedTickers = [...new Set(closedTrades.map((trade) => trade.ticker).filter((ticker) => !holdings[ticker]))];
  return {
    importedAt: new Date().toISOString(),
    source: "Trading 212 CSV",
    rowCount: rows.length,
    holdings,
    transactions,
    closedTrades,
    closedTickers,
    quarantine,
    ignored,
    summary: {
      holdings: Object.keys(holdings).length,
      openLots: Object.values(holdings).reduce((sum, holding) => sum + holding.lots.length, 0),
      openCostGBP: Object.values(holdings).reduce(
        (sum, holding) => sum + holding.lots.reduce((lotSum, lot) => lotSum + lot.costGBP + lot.feeGBP, 0),
        0,
      ),
      closedPositions: closedTickers.length,
      quarantinedRows: quarantine.length,
      ignoredRows: ignored.length,
    },
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function transactionsToCsv(transactions) {
  const rows = transactions.map((transaction) => {
    const values = {
      Action: transaction.action,
      Time: transaction.time,
      ISIN: transaction.isin,
      Ticker: transaction.ticker,
      Name: transaction.name,
      ID: transaction.id,
      "No. of shares": transaction.shares,
      "Price / share": transaction.priceNative,
      "Currency (Price / share)": transaction.priceCurrency,
      "Exchange rate": transaction.exchangeRate,
      Total: transaction.totalGBP,
      "Currency (Total)": transaction.resultCurrency || "GBP",
      "Currency conversion fee": transaction.feeGBP,
      "Currency (Currency conversion fee)": "GBP",
    };
    return TRADING_212_HEADERS.map((header) => csvCell(values[header] ?? "")).join(",");
  });
  return `${TRADING_212_HEADERS.join(",")}\n${rows.join("\n")}`;
}

export function mergeImports(existing, incoming, options = {}) {
  const existingTransactions = existing?.transactions || [];
  const incomingTransactions = incoming?.transactions || [];
  const byId = new Map();
  for (const transaction of [...existingTransactions, ...incomingTransactions]) byId.set(transaction.id, transaction);
  return importTrading212(transactionsToCsv([...byId.values()]), options);
}
