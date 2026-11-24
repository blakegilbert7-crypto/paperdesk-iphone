/* Plain-word definitions. Gloss.wrap(html) underlines the first use of each term in a piece of
   text; hovering (or focusing) a term shows its definition in a small card. */
(function () {
  const DEFS = [
    [['RSI(2)'], 'RSI(2)', 'Relative Strength Index over 2 bars: the last 2 bars\' gains against their losses, on a 0 to 100 scale. Under 10 means a sharp, quick drop.'],
    [['RSI(14)'], 'RSI(14)', 'The same 0 to 100 gauge over 14 bars. Above 70 is often called stretched up, below 30 stretched down.'],
    [['IBS', 'Internal bar strength'], 'IBS (internal bar strength)', 'Where a bar closed inside its own range: (close − low) ÷ (high − low). 0% is a close at the low, 100% at the high.'],
    [['ATR(14)', 'ATR(20)', 'ATR'], 'ATR (average true range)', 'The average size of a bar, high to low (including gaps), over the last 14 or 20 bars. It measures how much a market normally moves, so stops can be set in ATRs.'],
    [['EMA'], 'EMA (exponential moving average)', 'An average of recent closes that counts the newest ones most, so it turns faster than a simple average.'],
    [['200-bar average', '200-day average', '200-bar SMA'], '200-bar average', 'The plain average close of the last 200 bars (about 10 months on daily bars). Price above it is the usual definition of a long-term uptrend.'],
    [['5-bar average'], '5-bar average', 'The average close of the last 5 bars. A close back above it means a short dip has bounced.'],
    [['VWAP'], 'VWAP', 'Volume-weighted average price: the average price paid today, counting busy moments more. Many big traders measure their fills against it.'],
    [['1R', 'R per trade'], 'R (risk unit)', 'The amount you lose if the stop is hit. A +2R trade made twice that; −1R is a normal stopped-out loss. It lets you compare trades of different sizes.'],
    [['stop loss', 'catastrophe stop', 'trailing stop'], 'Stop loss', 'An order that closes the trade if price goes against you to a set level. It caps the loss at about 1R. A trailing stop moves along with a winning trade and never moves back.'],
    [['limit order'], 'Limit order', 'An order to buy at or below a price (or sell at or above it). It only fills if price comes to you.'],
    [['stop order'], 'Stop order', 'An order that waits and becomes a market order once price reaches a level. Used to get in on a breakout.'],
    [['backtest'], 'Backtest', 'Running a rule over past prices as if it had been traded, with costs, to see how it would have done. It is a guide, not a promise.'],
    [['after costs'], 'After costs', 'With fees, commissions and the spread (the gap between the buy and sell price) taken off every trade.'],
    [['bp', 'basis point'], 'Basis point (bp)', 'One hundredth of a percent: 10 bp = 0.1%. Small edges are measured in bp per trade.'],
    [['Sharpe'], 'Sharpe ratio', 'Return divided by how bumpy the ride was, per year. Above 0.5 is decent for a single rule; above 1 is rare.'],
    [['t-stat'], 't-stat', 'How sure a test is that the average trade is above zero. Around 2 or more is unlikely to be pure luck; we asked for 2.5.'],
    [['drawdown'], 'Drawdown', 'The fall from the account\'s highest point to a later low. Prop firms close accounts that draw down past their limit.'],
    [['long-history test', 'long-history'], 'Long-history test', 'Our own test of the rule on up to 36 years of prices (1990 to 2026), after costs, with 2020 onward kept apart as a check.'],
    [['mean reversion', 'Mean reversion'], 'Mean reversion', 'Betting that a sharp move partly reverses: buy a sudden drop, sell the bounce.'],
    [['trend following', 'Trend following', 'trend followers'], 'Trend following', 'Joining a move that has started and staying in while it lasts. Many small losses, a few big wins.'],
    [['breakout'], 'Breakout', 'Price closing beyond a recent high or low, leaving its range.'],
    [['sell short', 'sells short', 'sold short', 'selling short'], 'Selling short', 'Selling first and buying back later, to profit if the price falls. The loss grows if it rises instead.'],
    [['edge'], 'Edge', 'A small, repeatable tilt in the odds that is still there after costs. It shows up over many trades, not in one.'],
    [['expectancy'], 'Expectancy', 'The average result per trade, usually in R. Positive expectancy after costs is what makes a rule worth trading.'],
    [['higher-timeframe', 'trend points the other way', 'trend agrees'], 'Higher-timeframe trend', 'The direction on a longer chart (for example daily when you trade hourly). Trading with it tends to help.'],
  ];
  const map = new Map();
  const words = [];
  DEFS.forEach((d, idx) => d[0].forEach((w) => { map.set(w.toLowerCase(), idx); words.push(w); }));
  words.sort((a, b) => b.length - a.length);
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // case-sensitive for short abbreviations, word boundaries where the term starts or ends with a letter
  const re = new RegExp(words.map((w) => (/^\w/.test(w) ? '\\b' : '') + escRe(w) + (/\w$/.test(w) ? '\\b' : '')).join('|'), 'g');

  // Wraps the first use of each term in the text parts of an HTML string (never inside tags).
  function wrap(html, used) {
    const seen = used || new Set();
    return String(html).split(/(<[^>]+>)/).map((part) => {
      if (!part || part[0] === '<') return part;
      return part.replace(re, (m) => {
        const k = map.get(m.toLowerCase());
        if (k == null || seen.has(k)) return m;
        seen.add(k);
        return '<span class="gl" tabindex="0" data-g="' + k + '">' + m + '</span>';
      });
    }).join('');
  }

  let tip = null; let cur = null;
  function show(el) {
    const d = DEFS[Number(el.dataset.g)];
    if (!d) return;
    if (!tip) { tip = document.createElement('div'); tip.className = 'gl-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.innerHTML = '<b>' + d[1] + '</b><span>' + d[2] + '</span>';
    tip.classList.remove('on');
    const r = el.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px';
    const w = tip.offsetWidth; const h = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2; x = Math.max(8, Math.min(innerWidth - w - 8, x));
    let y = r.top - h - 8; if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    requestAnimationFrame(() => tip.classList.add('on'));
    cur = el;
  }
  function hide() { if (tip) tip.classList.remove('on'); cur = null; }
  document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('.gl'); if (el && el !== cur) show(el); else if (!el && cur) hide(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('.gl'); if (el) show(el); });
  document.addEventListener('focusout', (e) => { if (e.target.closest && e.target.closest('.gl')) hide(); });
  document.addEventListener('scroll', hide, true);

  window.Gloss = { wrap, hide, count: DEFS.length };
})();
