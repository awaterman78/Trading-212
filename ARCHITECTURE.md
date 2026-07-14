# Architecture decision record

## Decision

Keep the frontend static on GitHub Pages and move all provider authentication and upstream requests into a Cloudflare Worker.

## Why the browser only design was rejected

A public JavaScript application cannot protect a private API key. Browser local storage is readable by scripts running on the same origin and by anyone with access to browser developer tools. A key embedded in `index.html`, a JavaScript module or a GitHub Actions Pages build is still public.

Direct browser requests also make reliability dependent on provider CORS policy, browser networking, plan entitlements and exposed WebSocket authentication. Those failures were previously collapsed into an unhelpful `No quote` state.

## Components

### Frontend

The frontend is plain, dependency free JavaScript using ES modules.

Responsibilities:

1. Trading 212 CSV parsing and validation.
2. Lot accounting and closed trade calculations.
3. Local schema migration, reset and backup.
4. Quote validation and last known good storage.
5. GBP portfolio valuation.
6. Recommendation rules and explanations.
7. Mobile interface and diagnostics.

### Cloudflare Worker

Responsibilities:

1. Read Finnhub and Massive keys from encrypted secrets.
2. Restrict browser access to the configured GitHub Pages origin.
3. Validate requested symbols and cap batch size.
4. Call provider endpoints and preserve useful errors.
5. Return normalised quotes, history, foreign exchange and company data.
6. Never return or log a provider key in application responses.

### Provider roles

Finnhub:

1. Current quotes.
2. USD to GBP foreign exchange rate.
3. Company profiles and metrics.
4. Analyst recommendations.
5. Earnings calendar.
6. Historical fallback where the account plan permits it.

Massive:

1. Adjusted daily OHLC history for US listed instruments.
2. US stock snapshot fallback where the account plan permits it.

## Live tracking decision

Version 1 declares WebSocket streaming unavailable and runs REST polling. This is intentional.

The app is for long term investing, so a reliable quote every 5 to 60 minutes is more useful than a fragile tick stream. A WebSocket through the browser would expose a key. A proper secure WebSocket relay is possible, but it adds connection state, cost and failure modes without materially improving long term decisions.

The frontend `LiveTracker` already supports WebSocket connection, timeout and REST fallback. The Worker health response currently advertises `websocket: false`, so the interface truthfully enters `Live through polling`.

## Data integrity

Quotes are accepted only when:

1. Price is finite and positive.
2. Price is inside the configured plausible range.
3. Timestamp is valid.
4. Source is a provider response, not an ISIN, transaction ID or imported field.
5. An extreme movement has either not occurred or has been confirmed by a second close response.

When validation fails, the last known good quote remains in place and the failure appears in diagnostics.

## Trading 212 accounting

CSV values are addressed by column header. A sell first looks for an open lot with exactly the same quantity, using the latest matching lot. If no exact lot exists, the disposal uses FIFO. This rule gives the required CRWD result while keeping a deterministic FIFO fallback for normal disposals.

Total GBP cost includes the Trading 212 `Total` amount plus its allocated currency conversion fee.

## Recommendation model

Recommendations are deterministic and explainable. They do not call a generative AI model and do not claim certainty.

The engine uses data availability, trend, drawdown, volatility, P/E, return on equity, revenue growth, analyst balance, earnings proximity and portfolio concentration. Missing information reduces confidence and can force Review rather than pretending the evidence is complete.
