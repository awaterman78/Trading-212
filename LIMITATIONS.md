# Remaining limitations

These are deliberate, visible limitations. None is presented in the app as working when it is not.

1. Trading 212 activity import is CSV based. There is no direct Trading 212 account connection in this version.
2. Automatic polling runs while the app is open. GitHub Pages cannot run background jobs after the browser closes.
3. WebSocket streaming is disabled. The app truthfully uses REST polling because that is proportionate for long term investing and keeps provider keys private.
4. Provider availability depends on the user's Finnhub and Massive plans. Massive unified stock snapshots are not included on the free Stocks Basic tier. Finnhub stock candles are premium.
5. Massive US stock endpoints do not cover EQQQ's London listing. EQQQ uses Finnhub `EQQQ.L`; history will show unavailable if the Finnhub plan does not provide it.
6. The explicit built in symbol map covers the supplied holdings and common watchlist names. An unknown ticker must receive a verified custom mapping before it can be added.
7. The recommendation rules use available provider data. They do not assess every qualitative risk, management decision, accounting note, tax consequence or change in the investor's personal circumstances.
8. Local browser storage is device specific. A user must export and restore a backup to move the portfolio to another device.
9. There is no user account or cloud database. That avoids unnecessary personal data collection but means there is no automatic cross device sync.
10. The Worker allows requests from the configured browser origin. CORS protects browser use, but it is not user authentication. Provider plan rate limits remain the practical abuse control for this personal deployment.
11. The frontend has not yet been visually verified on the deployed iPhone build because the rebuild has not been published. The post deployment checklist is to run the built in tests, import the Trading 212 export, test the Worker, and inspect the Home and Data screens on the target iPhone.
