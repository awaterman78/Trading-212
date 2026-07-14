# Northstar test report

Test date: 14 July 2026

Command:

```bash
npm test
```

## Result

All automated tests passed.

| Area | Checks |
| --- | ---: |
| Trading 212 import and lots | 7 |
| Valuation and quote validation | 6 |
| Provider states and mapping | 6 |
| Live fallback | 1 |
| Storage, migration and backup | 4 |
| Cloudflare Worker | 4 |
| Mobile structure | 1 |
| Total | 29 |

## Required scenarios covered

| Scenario | Result |
| --- | --- |
| Supplied Trading 212 CSV fixture | Pass |
| Correct 10 holdings | Pass |
| Correct 13 open lots | Pass |
| Approximately £69.63 open cost | Pass |
| CRWD partial sell handling | Pass |
| ASML, EQQQ and TSM multiple lots | Pass |
| Deposits ignored | Pass |
| Card transactions ignored | Pass |
| Closed positions removed | Pass |
| ISIN digits never parsed as prices | Pass |
| Missing quotes | Pass |
| Invalid API keys | Pass |
| Rate limiting | Pass |
| Provider timeout | Pass |
| WebSocket failure with REST fallback | Pass |
| Market closed behaviour | Pass |
| Incorrect provider symbol | Pass |
| GBP conversion unavailable | Pass |
| Corrupted local storage | Pass |
| Mobile first structure and no forced table | Pass |

## Additional checks

1. EQQQ maps to Finnhub `EQQQ.L`, never to QQQ.
2. Extreme price movements require a second confirming response.
3. Last known good data survives an incorrect symbol response.
4. Provider keys are absent from JSON backups.
5. Legacy God Mode data cannot overwrite the new application.
6. Worker CORS rejects an unapproved origin.
7. Worker health exposes configuration state without exposing secret values.
8. Worker normalises Finnhub quote fields and preserves market closed state.

## Runtime verification

The static server returned the new `index.html`, `src/app.js` and `styles.css` successfully with the correct content types. The public cloud browser could not access the container's localhost address, so visual interaction against the local server was not claimed as completed. The mobile document structure is covered by an automated source check and the application includes a browser based Test centre for final device verification after deployment.
