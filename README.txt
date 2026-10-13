LEVELS DESK - phone app
=======================

A phone app that reads a stock chart screenshot and shows support and resistance
levels, a BUY / WAIT suggestion, a summary and the real 5-year track record.
It runs entirely on the phone: no account, no password, no fees, and screenshots are
never uploaded. Works on Android and iPhone.


APP LINK
--------
https://yashwanthkumar644-cmd.github.io/levels-desk/

Only the app files are online. Screenshots never leave the phone.


ON THE PHONE (your aunt, once)
------------------------------
1. Open the address in Chrome (Android) or Safari (iPhone) while on Wi-Fi.
2. Wait for "Upload a chart photo" to appear. The first visit downloads the
   reader (about 7 MB).
3. Install it:
   - Android Chrome: tap the three dots, then "Add to Home screen" / "Install app".
   - iPhone Safari: tap the Share button, then "Add to Home Screen".
4. A Levels Desk icon appears on the home screen. From now on it opens like an
   app and works without internet.


EVERY DAY
---------
1. Set "Nifty trend today" at the top: Up if Nifty is above its 50-day average, Down if
   below. (Or upload a Nifty chart screenshot and the app sets it for you.)
2. Take a screenshot of a stock chart in your trading app (Kite, Upstox, TradingView...).
   Show about 50 to 100 candles.
3. Open Levels Desk, tap "Upload a chart photo" and pick the screenshot.
4. In 5 to 15 seconds you see BUY or WAIT, the three conditions with ticks or crosses,
   the plan, the levels and a rebuilt chart to compare with yours.


FOR A GOOD READING
------------------
- A candlestick chart with the normal green and red colours (not a line chart).
- The price numbers on the right side of the chart must be in the screenshot.
- About 50 to 100 candles on screen. If the candles look tiny, zoom in first.
- If the stock name isn't picked up, type it in the "Symbol" box on the result.
- Compare the rebuilt chart with your chart; if it doesn't match, take a clearer screenshot.

WHEN THE APP SAYS NO
--------------------
The app checks every reading. If the screenshot isn't a clear candlestick chart,
it says "Couldn't read this chart reliably" and shows no decision, with the reason.
If the candles are very small (crowded chart), it shows the levels but never BUY;
zoom in and upload again. This is on purpose: no answer is better than a wrong one.
The app starts empty; "Try made-up example" only shows invented prices for practice.


HOW THE DECISION WORKS
----------------------
BUY ("pullback buy") only when all three are true:
  1. The stock is in an uptrend (above its 50-day average; 20-day average above 50-day).
  2. It has just dipped sharply (RSI(2) below 10).
  3. Nifty is in an uptrend (above its 50-day average).
Then: buy at the next open, sell on the bounce (usually 2 to 5 days, around the
"Sell around" price), safety stop 3x the daily range below entry, exit after 15 days
if nothing happens. Otherwise the app says WAIT. It never says SELL: no sell rule
held up in testing.


PLEASE NOTE
-----------
This is a learning tool, not investment advice. On 5 years of real NSE data (72 F&O
stocks) the BUY rule won about 2 trades in 3 (68% of 1,012 trades). On 2025-26, data
the settings were never tuned on, it won 66% and averaged +0.13% per trade after
costs, against -0.28% for random trades. Wins are small and frequent; losses are
rarer but bigger (worst -15%). 2026 so far has been weaker. Never trade money you
cannot afford to lose.
