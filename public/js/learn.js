/* Learn tab: what an edge is, risk and costs, how the strategies were tested, and a page for each
   strategy that held up, with replays of real trades drawn bar by bar. Data comes from
   learn-data.js (research/make-learn.js) and the research results. */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const G = (s, used) => (window.Gloss ? Gloss.wrap(s, used) : s);
  const md = (s, used) => G(esc(s), used).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const sgn = (x, d) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d == null ? 1 : d);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // theme colors for the canvas drawings
  const TP = () => Theme.pal;
  const ink = (a) => 'rgba(' + TP().ink + ',' + a + ')';
  const tcol = (c) => ({ '#7cc4ff': TP().a2, '#b197ff': TP().a1, '#e5534b': TP().down, '#f2b84b': TP().warn, '#1fae7e': TP().up }[String(c).toLowerCase()] || c);
  function ca(col, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(col || '');
    if (m) { const n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
    const r = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec((col || '').replace(/\s/g, ''));
    return r ? 'rgba(' + r[1] + ',' + r[2] + ',' + r[3] + ',' + a + ')' : col;
  }

  // ---------------------------------------------------------------- content
  const STATUS = {
    passed: { label: 'Passed the triple check', cls: 'ok', icon: 'check' },
    condition: { label: 'Passed: buy at the close', cls: 'cond', icon: 'clock' },
    weaker: { label: 'Weaker than it looked', cls: 'weak', icon: 'alert' },
  };
  const S = {
    rsi2: {
      name: 'RSI(2) Pullback', tag: 'Mean reversion · daily', status: 'passed',
      line: 'Buy a sharp one-to-three-day drop in a stock index that is in a long-term uptrend, and sell as soon as it bounces.',
      rules: [
        ['Where', 'A stock index on the daily chart: the S&P 500 (SPY, MES, US500) or the Nasdaq-100 (QQQ, MNQ, US100).'],
        ['Trend filter', 'Only when the close is above the 200-day average. Below it, sharp drops can keep falling, so the rule sits out.'],
        ['Signal', 'RSI(2) closes under 10: the last two days fell hard.'],
        ['Get in', 'Buy at the close (a market-on-close order a few minutes before 4 PM ET) or the next open.'],
        ['Get out', 'Sell at the first close above the 5-day average. A safety stop sits 3 ATR below; after 20 days it ends anyway.'],
      ],
      why: [
        'A sharp drop in a whole index is usually not news about the index being worth less. It is mostly people and funds who **have** to sell: margin calls, stop-loss orders firing in a chain, funds cutting risk after a bad day. They sell at almost any price.',
        'Whoever buys from them is paid for taking that risk, and the pay is the bounce. In an uptrend the long-term buyers (pension money, company buybacks, savings plans) are still there, so the drop tends to be refilled within days.',
        'Research on index returns finds the same thing: since about 2000, daily moves in big stock indexes have tended to partly reverse (Baltussen, van Bekkum and Da 2019), as index and ETF trading grew.',
      ],
      struggles: [
        'Crashes that keep falling. A dip can turn into 2008 or March 2020. The 200-day filter keeps it out of most of a bear market, but not the first leg down.',
        'Some years lose: 2000, 2018 and 2022 did. In 2001, 2002 and 2008 it hardly traded, because prices sat below the 200-day average the whole time.',
        'Wins are small and frequent (about 3 in 4 trades win), losses are rarer but bigger. One bad trade can take back several good ones, and it once lost 6 in a row.',
      ],
      real: [
        'Check at about 3:45 PM ET. If RSI(2) will close under 10 and price is above the 200-day average, buy at the close. Our triple check found buying at the close did better than waiting for the next open (on SPY +58.5 bp per trade against +41.9 bp).',
        'About 9 trades a year per index, usually held 1 to 5 days, so you hold overnight. Prop firms that close you out before the weekend cut some trades short.',
        'Size it so the 3 ATR stop loses your normal risk per trade (0.25% to 1% in the app\'s profiles).',
      ],
      quiz: [
        { q: 'RSI(2) reads 6, but price is below its 200-day average. Does the rule buy?', options: ['Yes: RSI(2) is under 10', 'No: the uptrend filter is off', 'Yes, with half the size'], a: 1, why: 'Both conditions must hold. Below the 200-day average a dip can keep falling, so the rule waits.' },
        { q: 'When does the trade end?', options: ['At a 2R target', 'At the first close above the 5-day average', 'After exactly 5 days'], a: 1, why: 'The bounce itself is the target. The first close back above the 5-day average ends it, usually within days.' },
      ],
      chart: { symbol: 'SPY', tf: '1d', label: 'Open SPY daily' },
    },
    ibs: {
      name: 'IBS Reversal', tag: 'Mean reversion · daily', status: 'passed',
      line: 'Buy a stock index day that closed near its low, and sell at the first close above the previous day\'s high.',
      rules: [
        ['Where', 'The Nasdaq-100 on the daily chart (QQQ, MNQ, US100). The S&P 500 version was weaker (mixed).'],
        ['Measure', 'IBS = (close − low) ÷ (high − low): where the day closed inside its own range, from 0% to 100%.'],
        ['Signal', 'IBS under 20%: the day closed near its low.'],
        ['Get in', 'Buy at the close or the next open.'],
        ['Get out', 'Sell at the first close above the previous day\'s high, or after 5 days. Safety stop 3 ATR below.'],
      ],
      why: [
        'Selling often bunches up late in the day: funds finishing their orders, traders closing positions before the night, and orders that must fill at the closing price. That can push the close below where buyers and sellers would otherwise meet.',
        'The next day that pressure is gone, and the price tends to drift back. It is the same short-term index reversal as RSI(2), measured inside a single day. Pagonidis (2013) described it on equity ETFs.',
      ],
      struggles: [
        'The edge per trade is small (about 0.3%), so costs matter: with double costs it fell to about +17 bp per trade on the index futures.',
        'It trades often, about 34 times a year, so a bad stretch has many trades in it.',
        'It did not work on forex, crypto, the DAX or the Russell 2000 in our tests. Stick to the Nasdaq-100.',
      ],
      real: [
        'Look at the day\'s range near the close. If the price is in the bottom fifth of the range, buy at the close. Our triple check found close and next-open entries about the same here (QQQ +30 and +32 bp per trade).',
        'Use cheap instruments: QQQ shares or MNQ micro futures. A wide spread can eat a 0.3% edge.',
      ],
      quiz: [
        { q: 'A day ranged from 100 to 110 and closed at 101. What is its IBS?', options: ['90%', '10%', '1%'], a: 1, why: '(101 − 100) ÷ (110 − 100) = 0.1, or 10%. It closed near its low, so the rule buys.' },
        { q: 'Which market did it work on best in our tests?', options: ['Bitcoin', 'The Nasdaq-100', 'EUR/USD'], a: 1, why: 'It needs the daily reversal of stock indexes. Forex and crypto do not show it.' },
      ],
      chart: { symbol: 'QQQ', tf: '1d', label: 'Open QQQ daily' },
    },
    month_end_rebal: {
      name: 'Month-End Rebalancing', tag: 'Calendar flow · daily', status: 'passed',
      line: 'Big funds keep a fixed mix of stocks and bonds and top it up near month-end. If stocks beat bonds this month, they must sell stocks, so trade ahead of them.',
      rules: [
        ['Where', 'The S&P 500 (SPY, MES, US500) or the Russell 2000 (IWM, US2000), daily. Bonds = TLT.'],
        ['When', 'Five trading days before the end of the month.'],
        ['Signal', 'Compare this month\'s stock return with the bond return. Stocks ahead: sell short. Stocks behind: buy.'],
        ['Get out', 'At the last close of the month, whatever the price. Safety stop 3 ATR away.'],
      ],
      why: [
        'Pension funds, balanced funds and target-date funds hold trillions of dollars in fixed mixes such as 60% stocks and 40% bonds. When stocks rise faster than bonds during a month, the stock share grows past its target, so they sell stocks and buy bonds to get back. When stocks lag, they buy.',
        'These flows are large and predictable, so prices tend to move against the month\'s winner in the last days before the rebalancing, and then bounce back. Harvey, Mazzoleni and Melone (2025, NBER) measured it across 1997 to 2023.',
      ],
      struggles: [
        'It is new: the paper came out in 2025, so there are under two years of trades after it was published, and a well-known idea can get crowded.',
        'It sells short about 6 times in 10, which needs futures, CFDs or a margin account.',
        'On the S&P 500 the last few years were weaker: about +10 to +13 bp per trade since 2023, against +36 over the whole test.',
      ],
      real: [
        'One trade a month per index, held about a week. Put a reminder on the 5th trading day before month-end and compare the month\'s returns of SPY and TLT.',
        'Our triple check re-ran it on SPY and IWM with their real prices: +36 and +55 bp per trade, both still positive with costs doubled.',
      ],
      quiz: [
        { q: 'This month stocks are up 4% and bonds up 1%. What does the rule do?', options: ['Buys stocks', 'Sells stocks short until month-end', 'Waits for a bigger gap'], a: 1, why: 'Stocks grew past their share of the fixed mix, so funds will sell stocks. The rule sells first.' },
        { q: 'When does the trade close?', options: ['At the last close of the month', 'On the 3rd day of next month', 'At a 2R target'], a: 0, why: 'The rebalancing happens before the month turns, so the trade ends at the last close of the month.' },
      ],
      chart: { symbol: 'SPY', tf: '1d', label: 'Open SPY daily' },
    },
    turtle: {
      name: 'Turtle Breakout 20/10', tag: 'Trend following', status: 'passed',
      line: 'Buy when price closes above its 20-day high, then follow the trend with a stop at the 10-day low. Lose small and often, win big and rarely.',
      rules: [
        ['Where', 'Bitcoin, daily, long only (it passed the triple check). USD/JPY hourly held up too, but only with very cheap spreads.'],
        ['Signal', 'A close above the highest high of the previous 20 bars, for the first time.'],
        ['Get in', 'Buy at the next open.'],
        ['First stop', '2 × ATR(20) below the entry: the Turtles\' "2N".'],
        ['Get out', 'The stop trails the lowest low of the last 10 bars and never moves back. No target: let the trend run.'],
      ],
      why: [
        'News spreads slowly and people under-react to it at first, then pile in late. That makes trends last longer than chance would suggest. Moskowitz, Ooi and Pedersen (2012) found trend following worked across 58 futures markets for decades.',
        'Bitcoin has had several huge trends. The rule loses a little on many breakouts, but the few that turn into real trends pay for everything else: 12 of its 74 Bitcoin trades made 5R or more, the best +23.5R.',
      ],
      struggles: [
        'On Bitcoin it won about half its trades (49%) and lost 6 in a row at its worst. On USD/JPY hourly it won 35% and once lost 14 in a row. That is normal for trend following, not a broken rule.',
        'Long sideways years (like 2018 to 2019 for Bitcoin) bleed slowly.',
        'Crypto fees are high (about 0.6% a side at retail exchanges); use a cheaper venue. On USD/JPY hourly, doubling the costs took away most of the edge.',
      ],
      real: [
        'One decision a day on Bitcoin: did today close above the 20-day high? About 6 trades a year.',
        'Hold through the trend, weekends included. Check your prop firm\'s weekend rule before you trade it there.',
      ],
      quiz: [
        { q: 'Where does most of this rule\'s profit come from?', options: ['Many small, steady wins', 'A few big trends', 'A fixed 2R target'], a: 1, why: 'Breakouts often fail or make a little. The few that become real trends pay for the rest.' },
        { q: 'How does the stop move after you get in?', options: ['It stays where it started', 'It follows the 10-day low up and never moves back', 'It moves to break-even after one day'], a: 1, why: 'The trailing stop locks in profit as the trend goes on and ends the trade when it turns.' },
      ],
      chart: { symbol: 'BTC-USD', tf: '1d', label: 'Open Bitcoin daily' },
    },
    turn_of_month: {
      name: 'Turn of the Month', tag: 'Calendar effect · daily', status: 'weaker',
      line: 'Own a stock index from the last trading day of the month to the 3rd trading day of the next.',
      rules: [
        ['Where', 'Stock indexes, daily: the Russell 2000 (IWM, US2000), the DAX (GER40) and the FTSE 100 (UK100) held up best over 1990 to 2026.'],
        ['Get in', 'Buy at the open of the last trading day of the month.'],
        ['Get out', 'Sell at the close of the 3rd trading day of the new month. Safety stop 3 ATR below.'],
      ],
      why: [
        'Money arrives around the turn of the month: salaries, pension and 401(k) contributions, and funds investing new cash. That buying has tended to lift stocks in these few days.',
        'It is one of the oldest known patterns: Ariel (1987) and Lakonishok and Smidt (1988) found it, and McConnell and Xu (2008) saw it in 35 countries from 1926 to 2005.',
      ],
      struggles: [
        '**It has faded.** Our triple check found it much weaker since 2010: about +11 to +19 bp per trade on each market, with t-stats near 1, too little to be sure it is still there. On IWM\'s real prices since 2000 it made +15 bp per trade (t-stat 1.0).',
        'Most of the strong result came from the 1990s. Well-known patterns often shrink once everyone knows them (McLean and Pontiff 2016).',
      ],
      real: [
        'It is simple and cheap to trade, about 12 trades a year, 4 days each. Treat it as a small add-on, not a main edge.',
        'If you trade it, keep the size small and watch how it does in paper trading first.',
      ],
      quiz: [
        { q: 'What does this rule look at to decide?', options: ['RSI and moving averages', 'Only the calendar', 'The news'], a: 1, why: 'It is a calendar rule: the same days every month, whatever the chart looks like.' },
        { q: 'What did our triple check find?', options: ['It got stronger', 'It is much weaker since 2010', 'It was a data error'], a: 1, why: 'Still positive, but since 2010 the gain per trade is small and not statistically solid.' },
      ],
      chart: { symbol: 'IWM', tf: '1d', label: 'Open IWM daily' },
    },
    tlt_month_end: {
      name: 'Treasury Month-End', tag: 'Calendar flow · daily · new in round 19', status: 'passed',
      line: 'Own long-term Treasury bonds (TLT) over the last 5 trading days of the month, when bond index funds buy to keep up with their index.',
      rules: [
        ['Where', 'Long-term US Treasuries: the TLT ETF, daily, long only.'],
        ['Get in', 'Buy when 5 trading days of the month are left (at the next open, or at that day\'s close).'],
        ['Get out', 'Sell at the last close of the month, whatever the price. Safety stop 3 ATR below.'],
      ],
      why: [
        'Bond index funds must hold what their index holds. At each month-end the index adds the Treasuries issued during the month, which are often longer than the ones that drop out, so the index gets "longer" and the funds **buy long bonds** to match it.',
        'That buying is large and on a known date, so long Treasuries have tended to rise in the last days of the month. Hartley and Schwarz (2019) documented it; it is the bond-market cousin of the stock rebalancing flow.',
      ],
      struggles: [
        '**Recent years are weak.** Since 2023 the app\'s version made +13 bp a trade over 45 trades (t-stat 0.6). That is too short to call it dead, but it is not reassuring.',
        'One market and one ETF, and no longer price history to check it on. Fed meetings and jobs reports that land in the window can swamp a 0.3% edge.',
        'The app\'s 3 ATR safety stop costs it something: +38 bp a trade as published (no stop, bought at the close) against +25 bp the way the app trades it.',
      ],
      real: [
        'One trade a month, about a week long. A reminder 5 trading days before month-end is all it takes.',
        'TLT is cheap to trade (about 2 bp each way). Bond futures work too but are large for small accounts.',
      ],
      quiz: [
        { q: 'Who is expected to buy long bonds near month-end?', options: ['The Federal Reserve', 'Bond index funds matching their index\'s month-end changes', 'Stock traders'], a: 1, why: 'The index adds new, longer bonds at month-end, so the funds that track it buy them then.' },
        { q: 'When does the trade end?', options: ['At the last close of the month', 'After a 2R gain', 'On the 3rd trading day of the next month'], a: 0, why: 'The funds buy before the month turns, so the trade closes at the last close of the month.' },
      ],
      chart: { symbol: 'TLT', tf: '1d', label: 'Open TLT daily' },
    },
  };

  const PAGES = [
    { id: 'edge', group: 'Start here', title: 'What an edge is', icon: 'spark' },
    { id: 'risk', group: 'Start here', title: 'Risk, R and position size', icon: 'shield' },
    { id: 'costs', group: 'Start here', title: 'Costs: why most rules fail', icon: 'alert' },
    { id: 'tests', group: 'Start here', title: 'How we tested: the triple check', icon: 'lab' },
    { id: 'rsi2', group: 'Strategies that held up', title: 'RSI(2) Pullback', icon: 'up' },
    { id: 'ibs', group: 'Strategies that held up', title: 'IBS Reversal', icon: 'up' },
    { id: 'month_end_rebal', group: 'Strategies that held up', title: 'Month-End Rebalancing', icon: 'clock' },
    { id: 'turtle', group: 'Strategies that held up', title: 'Turtle Breakout 20/10', icon: 'bolt' },
    { id: 'turn_of_month', group: 'Strategies that held up', title: 'Turn of the Month', icon: 'clock' },
    { id: 'tlt_month_end', group: 'Strategies that held up', title: 'Treasury Month-End', icon: 'clock' },
    { id: 'failed', group: 'What did not hold up', title: 'Rules that failed, and why', icon: 'x' },
  ];

  // ---------------------------------------------------------------- shell
  const L = { el: null, page: null, cleanup: [], onChart: null };

  function open(page, opts) {
    if (!window.LEARN_DATA) return;
    if (window.Lesson && Lesson.isOpen()) Lesson.close(true);
    if (window.Top && Top.isOpen()) Top.close();
    L.onChart = (opts && opts.onChart) || L.onChart;
    if (!L.el) build();
    L.el.hidden = false; L.el.classList.remove('out');
    document.body.classList.add('learn-open');
    if (window.Sound) Sound.play('open');
    let last = null; try { last = localStorage.getItem('pd.learnPage'); } catch (e) { /* ignore */ }
    show(page || last || 'edge');
  }
  function close() {
    if (!L.el || L.el.hidden) return;
    teardown();
    L.el.classList.add('out');
    document.body.classList.remove('learn-open');
    if (window.Gloss) Gloss.hide();
    setTimeout(() => { if (L.el.classList.contains('out')) L.el.hidden = true; }, 240);
    if (window.Sound) Sound.play('close');
  }
  function isOpen() { return !!(L.el && !L.el.hidden && !L.el.classList.contains('out')); }
  function teardown() { L.cleanup.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); L.cleanup = []; }

  function build() {
    const el = document.createElement('div');
    el.className = 'learn'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Learn');
    let nav = ''; let g = '';
    for (const p of PAGES) {
      if (p.group !== g) { g = p.group; nav += '<div class="ln-group">' + esc(g) + '</div>'; }
      const st = S[p.id] ? STATUS[S[p.id].status] : null;
      nav += '<button class="ln-item" data-p="' + p.id + '" data-sound="tab"><span class="ico" data-icon="' + p.icon + '"></span><span>' + esc(p.title) + '</span>' + (st ? '<i class="ln-dot ' + st.cls + '" title="' + esc(st.label) + '"></i>' : '') + '</button>';
    }
    el.innerHTML = '<div class="ln-shell"><aside class="ln-nav"><div class="ln-brand"><span class="ico" data-icon="cap"></span><div><b>Learn</b><span>How the strategies work, and why</span></div></div>' + nav +
      '<div class="ln-foot">Paper trading only. Past results do not promise future ones.</div></aside>' +
      '<main class="ln-main"><button class="icon-btn ln-x" title="Close (Esc)" data-sound="none"><span class="ico" data-icon="x"></span></button><div class="ln-page"></div></main></div>';
    document.body.appendChild(el);
    Icons.hydrate(el);
    el.querySelectorAll('.ln-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.p)));
    el.querySelector('.ln-x').addEventListener('click', close);
    L.el = el;
    addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (window.Confirm && Confirm.isOpen()) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      if (typing || e.key === 'Tab') return;
      const i = PAGES.findIndex((p) => p.id === L.page);
      if (e.key === 'ArrowDown' && e.altKey === false && document.activeElement && document.activeElement.classList.contains('ln-item')) { e.preventDefault(); show(PAGES[Math.min(PAGES.length - 1, i + 1)].id, true); }
      else if (e.key === 'ArrowUp' && document.activeElement && document.activeElement.classList.contains('ln-item')) { e.preventDefault(); show(PAGES[Math.max(0, i - 1)].id, true); }
      else if (e.key === ' ' && L.replay && !(document.activeElement && document.activeElement.tagName === 'BUTTON')) { e.preventDefault(); L.replay.toggle(); }
      e.stopImmediatePropagation(); // the app's shortcuts stay off while Learn is open
    }, true);
  }

  function show(id, focusNav) {
    const p = PAGES.find((x) => x.id === id) || PAGES[0];
    teardown(); L.replay = null;
    L.page = p.id;
    try { localStorage.setItem('pd.learnPage', p.id); } catch (e) { /* ignore */ }
    L.el.querySelectorAll('.ln-item').forEach((b) => b.classList.toggle('on', b.dataset.p === p.id));
    if (focusNav) { const b = L.el.querySelector('.ln-item[data-p="' + p.id + '"]'); if (b) b.focus(); }
    const host = L.el.querySelector('.ln-page');
    host.classList.remove('in'); void host.offsetWidth; host.classList.add('in');
    host.parentElement.scrollTop = 0;
    const used = new Set();
    if (S[p.id]) strategyPage(host, p.id, used);
    else ({ edge: edgePage, risk: riskPage, costs: costsPage, tests: testsPage, failed: failedPage })[p.id](host, used);
    Icons.hydrate(host);
    // next / previous page links
    const i = PAGES.indexOf(p);
    const nx = document.createElement('div'); nx.className = 'ln-next';
    nx.innerHTML = (i > 0 ? '<button class="ghost-btn" data-p="' + PAGES[i - 1].id + '" data-sound="tab">' + Icons.svg('left') + esc(PAGES[i - 1].title) + '</button>' : '<span></span>') +
      (i < PAGES.length - 1 ? '<button class="ln-go" data-p="' + PAGES[i + 1].id + '" data-sound="tab">Next: ' + esc(PAGES[i + 1].title) + Icons.svg('chev') + '</button>' : '');
    host.appendChild(nx);
    nx.querySelectorAll('button[data-p]').forEach((b) => b.addEventListener('click', () => show(b.dataset.p)));
  }

  const head = (kicker, title, sub, badge) => '<header class="lp-head"><div class="lp-kicker">' + esc(kicker) + '</div><h1>' + esc(title) + '</h1>' + (badge || '') + (sub ? '<p class="lp-lead">' + sub + '</p>' : '') + '</header>';
  const card = (title, inner, cls) => '<section class="lp-card' + (cls ? ' ' + cls : '') + '">' + (title ? '<h2>' + esc(title) + '</h2>' : '') + inner + '</section>';

  // ---------------------------------------------------------------- strategy pages
  function strategyPage(host, sid, used) {
    const s = S[sid]; const d = window.LEARN_DATA.strategies[sid];
    const st = STATUS[s.status];
    const badge = '<div class="lp-badges"><span class="lp-tag">' + esc(s.tag) + '</span><span class="lp-status ' + st.cls + '">' + Icons.svg(st.icon) + esc(st.label) + '</span></div>';
    const rules = '<ol class="lp-rules">' + s.rules.map((r, k) => '<li style="--d:' + (k * 70) + 'ms"><span class="lr-n">' + (k + 1) + '</span><div><b>' + esc(r[0]) + '</b><span>' + md(r[1], used) + '</span></div></li>').join('') + '</ol>';
    const paras = (arr) => arr.map((t) => '<p>' + md(t, used) + '</p>').join('');
    host.innerHTML = head('Strategy', s.name, md(s.line, used), badge) +
      '<div class="lp-replay" id="lpReplay"></div>' +
      '<div class="lp-grid">' + card('The rules', rules) + card('Why it works', paras(s.why)) + '</div>' +
      card('What our tests found', resultsHtml(d), 'wide') +
      '<div class="lp-grid">' + card('When it struggles', '<ul class="lp-list warn">' + s.struggles.map((t) => '<li>' + md(t, used) + '</li>').join('') + '</ul>') +
      card('How to trade it for real', '<ul class="lp-list">' + s.real.map((t) => '<li>' + md(t, used) + '</li>').join('') + '</ul>' +
        '<button class="ln-go lp-chart" data-sound="none">' + Icons.svg('stocks') + esc(s.chart.label) + ' in the app</button>') + '</div>' +
      card('Check yourself', '<div class="lp-quiz"></div>');
    host.querySelector('.lp-chart').addEventListener('click', () => { if (window.Sound) Sound.play('select'); close(); if (L.onChart) L.onChart(s.chart.symbol, s.chart.tf); });
    quiz(host.querySelector('.lp-quiz'), s.quiz);
    // the replay player, with a tab per example
    const exs = d.examples || [];
    const rp = host.querySelector('#lpReplay');
    drawCurves(host);
    if (!exs.length) { rp.remove(); return; }
    rp.innerHTML = '<div class="rp-top"><div class="rp-tabs">' + exs.map((e, k) => '<button class="rp-tab' + (k === 0 ? ' on' : '') + '" data-k="' + k + '" data-sound="tab"><i class="' + (e.win ? 'up' : 'down') + '"></i>' + (e.win ? 'A winner' : 'A loser') + ' <b class="num">' + sgn(e.R, 1) + 'R</b></button>').join('') + '</div><span class="rp-sub">Real trade on ' + esc(exs[0].symbol) + ', replayed bar by bar</span></div><div class="rp-stage"></div>';
    const stage = rp.querySelector('.rp-stage');
    const mount = (k) => { if (L.replay) L.replay.destroy(); L.replay = Replay(stage, exs[k], sid); rp.querySelector('.rp-sub').textContent = exs[k].title + ' · replayed bar by bar'; };
    rp.querySelectorAll('.rp-tab').forEach((b) => b.addEventListener('click', () => { rp.querySelectorAll('.rp-tab').forEach((x) => x.classList.toggle('on', x === b)); mount(Number(b.dataset.k)); }));
    mount(0);
    L.cleanup.push(() => { if (L.replay) L.replay.destroy(); L.replay = null; });
  }

  function resultsHtml(d) {
    const rows = d.rows.map((r) => {
      const c = r.check || {}; const st = STATUS[c.status] || null;
      const tcell = (x) => (x ? '<span class="num ' + (x.netBp > 0 ? 'up-t' : 'down-t') + '">' + sgn(x.netBp) + '</span><small class="num">t ' + x.tBp + '</small>' : '–');
      return '<tr><td><b>' + esc(r.market) + '</b><small>' + esc(r.tf.replace('_rth', '')) + ' · ' + r.from + '–' + r.to + '</small></td>' +
        '<td class="num">' + r.trades.toLocaleString('en-US') + '<small>' + r.perYear + ' a year</small></td>' +
        '<td class="num">' + r.winRate.toFixed(0) + '%</td>' +
        '<td><span class="num up-t">' + sgn(r.netBp) + '</span><small class="num">t ' + r.tStat + '</small></td>' +
        '<td class="num">' + r.yearsUp + '%</td>' +
        '<td>' + tcell(c.since2010) + '</td>' +
        '<td>' + (c.etf ? tcell(c.etf.base) + '<small>' + esc(c.etf.symbol) + ' since ' + c.etf.from + '</small>' : '<small>no ETF</small>') + '</td>' +
        '<td>' + tcell(c.cost2x && c.etf ? c.etf.cost2x : c.cost2x) + '</td>' +
        '<td>' + (st ? '<span class="lp-status sm ' + st.cls + '">' + Icons.svg(st.icon) + esc(st.label) + '</span>' : '') + '</td></tr>';
    }).join('');
    const h = d.history;
    return '<div class="lp-res"><div class="lp-curve"><div class="lc-h"><b>Every trade since ' + new Date(h.curve[0][0] * 1000).getUTCFullYear() + ', added up</b><span class="num">' + h.trades.toLocaleString('en-US') + ' trades · ' + h.winPct + '% winners · ' + sgn(h.totalR) + 'R in total</span></div><canvas class="lc-c" height="150"></canvas><div class="lc-note">' + esc(d.rows[0].market) + ', each trade risking the same amount, after costs. Real ups and downs, not a smooth line.</div></div>' +
      '<div class="lp-table-wrap"><table class="lp-table"><thead><tr><th>Market</th><th>Trades</th><th>Wins</th><th>Per trade (bp)</th><th>Years up</th><th>Since 2010</th><th>Real ETF prices</th><th>Costs ×2</th><th>Triple check</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="lp-fine">bp = basis points, hundredths of a percent of the position, after costs. t is the t-stat: about 2 or more is unlikely to be luck. The first columns are the 1990 to 2026 research run; "since 2010", "real ETF prices" and "costs ×2" come from the triple check.</p></div>';
  }

  // cumulative R curve, drawn once the card scrolls into view
  function drawCurves(host) {
    host.querySelectorAll('.lc-c').forEach((cv) => {
      const sid = L.page; const h = window.LEARN_DATA.strategies[sid] && window.LEARN_DATA.strategies[sid].history; if (!h) return;
      const ctx = cv.getContext('2d'); let t0 = 0; let raf = 0;
      const pts = h.curve; const lo = Math.min(0, ...pts.map((p) => p[1])); const hi = Math.max(...pts.map((p) => p[1]));
      const x0 = pts[0][0]; const x1 = pts[pts.length - 1][0];
      const frame = (now) => {
        if (!t0) t0 = now;
        const prog = reduced() ? 1 : Math.min(1, (now - t0) / 1400);
        const W = cv.clientWidth; const H = 150; const dpr = devicePixelRatio || 1;
        if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
        const X = (t) => 36 + (t - x0) / (x1 - x0) * (W - 44); const Y = (v) => 10 + (hi - v) / (hi - lo || 1) * (H - 30);
        ctx.strokeStyle = ink(.07); ctx.lineWidth = 1; ctx.fillStyle = TP().muted; ctx.font = '10px InterVar, Segoe UI, sans-serif';
        for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3; ctx.beginPath(); ctx.moveTo(36, Y(v)); ctx.lineTo(W - 8, Y(v)); ctx.stroke(); ctx.fillText(Math.round(v) + 'R', 2, Y(v) + 3); }
        let y = new Date(x0 * 1000).getUTCFullYear(); const ye = new Date(x1 * 1000).getUTCFullYear(); const stepY = ye - y > 20 ? 5 : ye - y > 8 ? 2 : 1;
        for (y = Math.ceil(y / stepY) * stepY; y <= ye; y += stepY) { const t = Date.UTC(y, 0, 1) / 1000; if (t < x0) continue; ctx.fillText(String(y), X(t) - 12, H - 4); }
        const n = Math.max(2, Math.floor(pts.length * prog));
        const grad = ctx.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, ca(TP().up, .28)); grad.addColorStop(1, ca(TP().up, 0));
        ctx.beginPath(); ctx.moveTo(X(pts[0][0]), Y(0)); for (let k = 0; k < n; k++) ctx.lineTo(X(pts[k][0]), Y(pts[k][1])); ctx.lineTo(X(pts[n - 1][0]), Y(0)); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
        ctx.beginPath(); for (let k = 0; k < n; k++) { const f = k ? 'lineTo' : 'moveTo'; ctx[f](X(pts[k][0]), Y(pts[k][1])); } ctx.strokeStyle = TP().up; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(X(pts[n - 1][0]), Y(pts[n - 1][1]), 3.5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
        if (prog < 1) raf = requestAnimationFrame(frame);
      };
      const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) { io.disconnect(); raf = requestAnimationFrame(frame); } }, { threshold: 0.3 });
      io.observe(cv);
      const onR = () => { t0 = performance.now() - 5000; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); };
      addEventListener('resize', onR);
      L.cleanup.push(() => { io.disconnect(); cancelAnimationFrame(raf); removeEventListener('resize', onR); });
    });
  }

  // ---------------------------------------------------------------- the replay player
  // Plays a real trade bar by bar: candles arrive one at a time, the view pans with them, and at
  // each moment that mattered the player pauses and explains it.
  function Replay(stage, ex, sid) {
    const N = ex.bars.length;
    stage.innerHTML = '<div class="rp-canvas"><canvas></canvas><div class="rp-pnl" hidden></div></div>' +
      '<div class="rp-caption"><div class="rp-cap-ico"></div><div class="rp-cap-t"></div></div>' +
      '<div class="rp-ctrl"><button class="rp-play" data-sound="none" title="Play or pause (Space)"></button><button class="icon-btn sm rp-restart" data-sound="click" title="Restart"><span class="ico">' + Icons.svg('replay') + '</span></button>' +
      '<div class="rp-track"><div class="rp-fill"></div>' + ex.events.map((e, k) => '<button class="rp-ev ' + e.kind + '" data-k="' + k + '" style="left:' + (e.at / (N - 1) * 100).toFixed(2) + '%" title="' + esc(e.text.slice(0, 80)) + '" data-sound="none"></button>').join('') + '</div>' +
      '<div class="seg rp-speed"><button data-v="1" class="on" data-sound="toggle">1×</button><button data-v="2" data-sound="toggle">2×</button><button data-v="4" data-sound="toggle">4×</button></div></div>';
    const cv = stage.querySelector('canvas'); const ctx = cv.getContext('2d');
    const capT = stage.querySelector('.rp-cap-t'); const capI = stage.querySelector('.rp-cap-ico'); const cap = stage.querySelector('.rp-caption');
    const pnl = stage.querySelector('.rp-pnl'); const fill = stage.querySelector('.rp-fill'); const playBtn = stage.querySelector('.rp-play');
    const R = { t: 0, playing: true, speed: 1, hold: 0, ev: -1, raf: 0, last: 0, drawn: 0, dirty: true, yLo: null, yHi: null, dead: false };
    const VIEW = Math.min(N, sid === 'turtle' ? 130 : 46);
    const dec = ex.decimals;
    const isTurtle = sid === 'turtle';
    const COLORS = { get up() { return TP().up; }, get down() { return TP().down; }, get grid() { return ink(0.06); }, get text() { return TP().muted; }, get entry() { return TP().entry; } };
    const ICON = { info: 'info', signal: 'target', entry: 'bolt', win: 'check', loss: 'x' };

    function setCaption(k) {
      const e = ex.events[k];
      cap.className = 'rp-caption ' + e.kind; cap.classList.remove('flash'); void cap.offsetWidth; cap.classList.add('flash');
      capI.innerHTML = Icons.svg(ICON[e.kind] || 'info');
      capT.innerHTML = '<span class="rp-step">' + (k + 1) + '/' + ex.events.length + '</span>' + G(esc(e.text));
      stage.querySelectorAll('.rp-ev').forEach((b, j) => b.classList.toggle('done', j <= k));
      if (window.Sound) Sound.play(e.kind === 'win' ? 'win' : e.kind === 'loss' ? 'loss' : e.kind === 'entry' ? 'placed' : e.kind === 'signal' ? 'notify' : 'tick');
    }
    function setPlay(on) { R.playing = on; playBtn.innerHTML = Icons.svg(on ? 'pause' : 'play'); playBtn.classList.toggle('paused', !on); }

    function tick(now) {
      if (R.dead) return;
      const dt = R.last ? Math.min(0.1, (now - R.last) / 1000) : 0; R.last = now;
      if (R.playing) {
        if (R.hold > 0) R.hold -= dt * 1000;
        else {
          const prev = R.t;
          R.t = Math.min(N - 1, R.t + dt * 5.5 * R.speed);
          // reaching an event: snap to it and hold so it can be read
          const nextEv = ex.events.findIndex((e, k) => k > R.ev && e.at <= R.t + 1e-9);
          if (nextEv >= 0 && ex.events[nextEv].at >= Math.floor(prev)) {
            R.t = ex.events[nextEv].at; R.ev = nextEv; setCaption(nextEv); // stop on the event's bar, never past it
            R.hold = (reduced() ? 600 : 2600 + Math.min(2600, ex.events[nextEv].text.length * 14)) / R.speed;
          }
          if (R.t >= N - 1 && R.hold <= 0) setPlay(false);
        }
      }
      // while paused, redraw a few times a second (the signal ring pulses); otherwise every frame
      if (R.playing || R.dirty || now - R.drawn > 120) { fill.style.width = (R.t / (N - 1) * 100).toFixed(2) + '%'; draw(); R.drawn = now; R.dirty = false; }
      R.raf = requestAnimationFrame(tick);
    }

    function draw() {
      const W = cv.clientWidth; const H = cv.clientHeight; const dpr = devicePixelRatio || 1;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const paneH = ex.pane ? Math.round(H * 0.24) : 0; const axisW = 64; PILL_MAX = W - axisW - 4; const top = 14; const priceH = H - paneH - (paneH ? 26 : 20) - top;
      const k = Math.floor(R.t); const frac = R.t - k;
      // camera: keep the newest bar about 6 bars from the right edge once the chart is full
      const right = Math.max(VIEW - 1, R.t + 6); const left = right - (VIEW - 1);
      const plotW = W - axisW - 8; const bw = plotW / VIEW;
      const X = (i) => 8 + (i - left + 0.5) * bw;
      // price range of what is on screen, eased
      let lo = Infinity; let hi = -Infinity;
      for (let i = Math.max(0, Math.floor(left)); i <= k; i++) { lo = Math.min(lo, ex.bars[i][3]); hi = Math.max(hi, ex.bars[i][2]); }
      for (const ln of ex.lines) for (let i = Math.max(0, Math.floor(left)); i <= k; i++) { const v = ln.v[i]; if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      if (k >= ex.entryAt) { lo = Math.min(lo, ex.stop, ex.entry); hi = Math.max(hi, ex.stop, ex.entry); }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      if (R.yLo == null || reduced()) { R.yLo = lo; R.yHi = hi; } else { R.yLo += (lo - R.yLo) * 0.12; R.yHi += (hi - R.yHi) * 0.12; }
      const Y = (v) => top + (R.yHi - v) / (R.yHi - R.yLo) * priceH;
      ctx.font = '10.5px InterVar, Segoe UI, sans-serif'; ctx.textBaseline = 'middle';
      // grid + price axis
      const span = R.yHi - R.yLo; const stp = niceStep(span / 5);
      ctx.strokeStyle = COLORS.grid; ctx.fillStyle = COLORS.text; ctx.lineWidth = 1;
      for (let v = Math.ceil(R.yLo / stp) * stp; v <= R.yHi; v += stp) { const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(W - axisW, y); ctx.stroke(); ctx.fillText(fmtP(v, stp), W - axisW + 8, y); }
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W - axisW, top + priceH + 4); ctx.clip();
      // month lines and labels
      for (const v of ex.vlines) { if (v.at > k) continue; const x = Math.round(X(v.at) - bw / 2) + 0.5; ctx.strokeStyle = ca(TP().a2, .18); ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - 18); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#7cc4ff'; ctx.fillText(v.label, x + 4, top + 6); }
      // turn-of-the-month window
      for (const z of ex.zones) { if (z.from > k) continue; const x0 = X(z.from) - bw / 2; const x1 = X(Math.min(z.to, R.t)) + bw / 2; ctx.fillStyle = ca(TP().warn, .10); ctx.fillRect(x0, top, x1 - x0, priceH); ctx.fillStyle = TP().warn; ctx.fillText(z.label, x0 + 4, top + 22); }
      // the trade's span
      if (k >= ex.entryAt) {
        const x0 = X(ex.entryAt) - bw / 2; const x1 = X(Math.min(ex.exitAt, R.t)) + bw / 2;
        const win = k >= ex.exitAt ? ex.win : null;
        ctx.fillStyle = win == null ? ca(TP().a1, .07) : win ? ca(TP().up, .09) : ca(TP().down, .09); ctx.fillRect(x0, top, x1 - x0, priceH);
      }
      // indicator lines
      for (const ln of ex.lines) {
        const lc = tcol(ln.color); ctx.strokeStyle = lc; ctx.lineWidth = ln.width || 1.5; ctx.setLineDash(ln.dash ? [5, 4] : []); ctx.beginPath(); let on = false; let prevY = null;
        for (let i = Math.max(0, Math.floor(left) - 1); i <= k; i++) {
          const v = ln.v[i]; if (v == null) { on = false; continue; }
          const x = X(i); const y = Y(v);
          if (!on) { ctx.moveTo(ln.step ? x - bw / 2 : x, y); on = true; } else if (ln.step) { ctx.lineTo(x - bw / 2, prevY); ctx.lineTo(x - bw / 2, y); }
          ctx.lineTo(ln.step ? x + bw / 2 : x, y); prevY = y;
        }
        ctx.stroke(); ctx.setLineDash([]);
        let lastI = k; while (lastI > 0 && ln.v[lastI] == null) lastI--;
        if (ln.v[lastI] != null && lastI >= left) pill(ctx, X(lastI) + bw / 2 + 4, Y(ln.v[lastI]), ln.label, lc, true);
      }
      // candles (the newest grows into place)
      for (let i = Math.max(0, Math.floor(left) - 1); i <= k; i++) {
        const [, o, h, l, c] = ex.bars[i];
        const grow = i === k && R.t < N - 1 ? easeOut(Math.min(1, frac * 1.6 + (R.hold > 0 ? 1 : 0))) : 1;
        const cc = o + (c - o) * grow; const hh = o + (h - o) * grow; const ll = o + (l - o) * grow;
        const up = cc >= o; const x = X(i);
        ctx.strokeStyle = ctx.fillStyle = up ? COLORS.up : COLORS.down;
        ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(hh)); ctx.lineTo(Math.round(x) + 0.5, Y(ll)); ctx.stroke();
        const y0 = Y(Math.max(o, cc)); const y1 = Y(Math.min(o, cc));
        ctx.fillRect(Math.round(x - bw * 0.34), y0, Math.max(1, Math.round(bw * 0.68)), Math.max(1, y1 - y0));
      }
      // signal bar ring
      if (k >= ex.signal) {
        const x = X(ex.signal); const b = ex.bars[ex.signal]; const pulse = k < ex.entryAt + 3 ? 1 + 0.25 * Math.sin(performance.now() / 180) : 1;
        ctx.strokeStyle = TP().warn; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, (Y(b[2]) + Y(b[3])) / 2, bw * 0.9 * pulse, (Y(b[3]) - Y(b[2])) / 2 + 8 * pulse, 0, 0, 7); ctx.stroke();
        ctx.fillStyle = TP().warn; ctx.textAlign = 'center'; ctx.fillText('Signal', x, Y(b[2]) - 14 - 4 * pulse); ctx.textAlign = 'left';
      }
      // entry, stop and exit
      if (k >= ex.entryAt) {
        const x = X(ex.entryAt); const long = ex.dir > 0;
        if (!isTurtle) { const ys = Math.round(Y(ex.stop)) + 0.5; ctx.strokeStyle = COLORS.down; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(x - bw / 2, ys); ctx.lineTo(X(Math.min(ex.exitAt, R.t)) + bw / 2, ys); ctx.stroke(); ctx.setLineDash([]); pill(ctx, x - bw / 2 + 4, ys + (long ? 11 : -11), 'Stop ' + ex.stop.toFixed(dec), COLORS.down); }
        const ye = Y(ex.entry); ctx.strokeStyle = COLORS.entry; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - bw / 2, Math.round(ye) + 0.5); ctx.lineTo(X(Math.min(ex.exitAt, R.t)) + bw / 2, Math.round(ye) + 0.5); ctx.stroke();
        arrow(ctx, x, ye, long, long ? COLORS.up : COLORS.down);
        pill(ctx, x + 8, ye + (long ? 16 : -16), (long ? 'Buy ' : 'Sell ') + ex.entry.toFixed(dec), long ? COLORS.up : COLORS.down);
      }
      if (k >= ex.exitAt) {
        const x = X(ex.exitAt); const y = Y(ex.exit);
        ctx.fillStyle = ex.win ? COLORS.up : COLORS.down; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.strokeStyle = TP().dot; ctx.lineWidth = 2; ctx.stroke();
        const lab = 'Out ' + ex.exit.toFixed(dec) + '  ' + sgn(ex.R, 1) + 'R'; ctx.font = '600 10.5px InterVar, Segoe UI, sans-serif'; const lw = ctx.measureText(lab).width + 12;
        pill(ctx, x + 9 + lw > W - axisW - 4 ? x - 9 - lw : x + 9, y - 14, lab, ex.win ? COLORS.up : COLORS.down);
      }
      ctx.restore();
      // live result while in the trade
      if (k >= ex.entryAt && k < ex.exitAt) {
        const c = ex.bars[k][4]; const r = (c - ex.entry) * ex.dir / Math.abs(ex.entry - ex.stop);
        pnl.hidden = false; pnl.className = 'rp-pnl num ' + (r >= 0 ? 'up' : 'down'); pnl.textContent = 'Open: ' + sgn(r, 2) + 'R';
      } else if (k >= ex.exitAt) { pnl.hidden = false; pnl.className = 'rp-pnl num done ' + (ex.win ? 'up' : 'down'); pnl.textContent = 'Result: ' + sgn(ex.R, 1) + 'R'; } else pnl.hidden = true;
      // date of the newest bar
      ctx.fillStyle = COLORS.text; ctx.textAlign = 'right'; ctx.fillText(dateLabel(ex.bars[k][0], ex.symbol), W - axisW - 6, H - 8); ctx.textAlign = 'left';
      // lower pane
      if (ex.pane) drawPane(8, H - paneH - 16, W - axisW - 8, paneH, X, k, left);
    }

    function drawPane(x0, y0, w, h, X, k, left) {
      const p = ex.pane; const Yp = (v) => y0 + (p.max - v) / (p.max - p.min) * h;
      ctx.fillStyle = ink(.025); ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = COLORS.text; ctx.fillText(p.label, x0 + 6, y0 + 9); const legX = x0 + 6 + ctx.measureText(p.label).width + 14;
      if (p.threshold != null) {
        const yt = Yp(p.threshold);
        if (p.below) { ctx.fillStyle = ca(TP().up, .10); ctx.fillRect(x0, yt, w, y0 + h - yt); }
        ctx.strokeStyle = ink(.28); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x0, Math.round(yt) + 0.5); ctx.lineTo(x0 + w, Math.round(yt) + 0.5); ctx.stroke(); ctx.setLineDash([]);
        let lv = null; for (let i = k; i >= 0; i--) if (p.v[i] != null) { lv = p.v[i]; break; }
        if (lv == null || Math.abs(Yp(lv) - yt) > 12) { ctx.fillStyle = COLORS.text; ctx.fillText(String(p.threshold), x0 + w + 8, yt); }
      }
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
      const bw = (X(1) - X(0));
      const series = (v, color) => { ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath(); let on = false; for (let i = Math.max(0, Math.floor(left) - 1); i <= k; i++) { if (v[i] == null) { on = false; continue; } const f = on ? 'lineTo' : 'moveTo'; ctx[f](X(i), Yp(v[i])); on = true; } ctx.stroke(); };
      if (p.bars) {
        for (let i = Math.max(0, Math.floor(left) - 1); i <= k; i++) { const v = p.v[i]; if (v == null) continue; ctx.fillStyle = v < p.threshold ? ca(TP().up, .85) : ca(TP().a2, .35); const yv = Yp(v); ctx.fillRect(X(i) - bw * 0.32, yv, bw * 0.64, y0 + h - yv); }
      } else {
        series(p.v, TP().a1);
        if (p.two) series(p.two.v, TP().warn);
      }
      if (k >= ex.signal && p.v[ex.signal] != null) { ctx.fillStyle = TP().warn; ctx.beginPath(); ctx.arc(X(ex.signal), Yp(p.v[ex.signal]), 4, 0, 7); ctx.fill(); }
      ctx.restore();
      if (p.two) { ctx.fillStyle = TP().a1; ctx.fillText('— ' + p.vLabel, legX, y0 + 9); const l2 = legX + ctx.measureText('— ' + p.vLabel).width + 14; ctx.fillStyle = TP().warn; ctx.fillText('— ' + p.two.label, l2, y0 + 9); }
      let lastV = null; for (let i = k; i >= 0; i--) if (p.v[i] != null) { lastV = p.v[i]; break; }
      if (lastV != null) { ctx.fillStyle = TP().a1; ctx.fillText((p.two ? sgn(lastV, 1) + '%' : lastV.toFixed(0)), x0 + w + 8, Math.max(y0 + 6, Math.min(y0 + h - 6, Yp(lastV)))); }
    }

    playBtn.addEventListener('click', () => { if (R.t >= N - 1 && !R.playing) restart(); else setPlay(!R.playing); if (window.Sound) Sound.play('click'); });
    function restart() { R.t = 0; R.ev = -1; R.hold = 0; R.yLo = null; stage.querySelectorAll('.rp-ev').forEach((b) => b.classList.remove('done')); cap.className = 'rp-caption'; capI.innerHTML = Icons.svg('play'); capT.textContent = 'Watching the market…'; setPlay(true); }
    stage.querySelector('.rp-restart').addEventListener('click', restart);
    stage.querySelectorAll('.rp-speed button').forEach((b) => b.addEventListener('click', () => { R.speed = Number(b.dataset.v); stage.querySelectorAll('.rp-speed button').forEach((x) => x.classList.toggle('on', x === b)); }));
    stage.querySelectorAll('.rp-ev').forEach((b) => b.addEventListener('click', () => { const j = Number(b.dataset.k); R.t = ex.events[j].at; R.ev = j; setCaption(j); setPlay(true); R.hold = 3200; if (window.Sound) Sound.play('click'); }));
    const track = stage.querySelector('.rp-track');
    track.addEventListener('pointerdown', (e) => { if (e.target.classList.contains('rp-ev')) return; const r = track.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); R.t = f * (N - 1); R.ev = -1; R.dirty = true; for (let j = 0; j < ex.events.length; j++) if (ex.events[j].at <= R.t) { R.ev = j; } if (R.ev >= 0) setCaption(R.ev); R.hold = 0; stage.querySelectorAll('.rp-ev').forEach((b, j) => b.classList.toggle('done', j <= R.ev)); });
    restart();
    // start when visible
    let started = false;
    const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && !started) { started = true; R.raf = requestAnimationFrame(tick); } }, { threshold: 0.2 });
    io.observe(stage);
    return {
      toggle() { setPlay(!R.playing); },
      destroy() { R.dead = true; cancelAnimationFrame(R.raf); io.disconnect(); },
    };
  }
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; }
  function fmtP(v, stp) { const d = stp >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(stp))); return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
  function dateLabel(t, sym) { const d = new Date((t + (sym === 'BTC-USD' ? 0 : -4 * 3600)) * 1000); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  let PILL_MAX = Infinity; // right edge of the plot, set on each draw so labels never run under the price axis
  function pill(ctx, x, y, text, color, left) {
    ctx.font = '600 10.5px InterVar, Segoe UI, sans-serif'; const w = ctx.measureText(text).width + 12; const h = 18;
    const px = Math.max(2, Math.min(x, PILL_MAX - w)); ctx.fillStyle = TP().pillBg; ctx.strokeStyle = color; ctx.lineWidth = 1;
    rrect(ctx, px, y - h / 2, w, h, 6); ctx.fill(); ctx.stroke(); ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, px + 6, y + 0.5);
    ctx.font = '10.5px InterVar, Segoe UI, sans-serif';
  }
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function arrow(ctx, x, y, up, color) { ctx.fillStyle = color; ctx.beginPath(); if (up) { ctx.moveTo(x, y + 4); ctx.lineTo(x - 6, y + 13); ctx.lineTo(x + 6, y + 13); } else { ctx.moveTo(x, y - 4); ctx.lineTo(x - 6, y - 13); ctx.lineTo(x + 6, y - 13); } ctx.closePath(); ctx.fill(); }

  // ---------------------------------------------------------------- quiz
  function quiz(box, qs) {
    const st = { i: 0, ans: [] };
    const render = () => {
      if (st.i >= qs.length) {
        const right = st.ans.filter((a, k) => a === qs[k].a).length;
        box.innerHTML = '<div class="ls-quiz done"><div class="qz-score num">' + right + ' / ' + qs.length + '</div><p>' + (right === qs.length ? 'All right.' : 'Read the rules above once more and try again.') + '</p><button class="ghost-btn qz-again" data-sound="none">Try again</button></div>';
        box.querySelector('.qz-again').addEventListener('click', () => { st.i = 0; st.ans = []; if (window.Sound) Sound.play('click'); render(); });
        return;
      }
      const q = qs[st.i]; const ans = st.ans[st.i];
      box.innerHTML = '<div class="ls-quiz"><div class="qz-n">Question ' + (st.i + 1) + ' of ' + qs.length + '</div><div class="qz-q">' + esc(q.q) + '</div><div class="qz-opts">' +
        q.options.map((o, k) => '<button class="qz-o' + (ans != null ? (k === q.a ? ' right' : k === ans ? ' wrong' : ' dim') : '') + '" data-k="' + k + '" data-sound="none"' + (ans != null ? ' disabled' : '') + '><i>' + 'ABC'[k] + '</i><span>' + esc(o) + '</span></button>').join('') + '</div>' +
        (ans != null ? '<div class="qz-why ' + (ans === q.a ? 'right' : 'wrong') + '"><b>' + (ans === q.a ? 'Right.' : 'Not quite.') + '</b> ' + G(esc(q.why)) + '</div><button class="ls-next qz-next" data-sound="none">' + (st.i === qs.length - 1 ? 'See score' : 'Next question') + '</button>' : '') + '</div>';
      box.querySelectorAll('.qz-o').forEach((b) => b.addEventListener('click', () => { const k = Number(b.dataset.k); st.ans[st.i] = k; if (window.Sound) Sound.play(k === q.a ? 'right' : 'wrong'); render(); }));
      const nx = box.querySelector('.qz-next'); if (nx) nx.addEventListener('click', () => { st.i++; if (window.Sound) Sound.play(st.i >= qs.length ? 'win' : 'tab'); render(); });
    };
    render();
  }

  // ---------------------------------------------------------------- start here: edge
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function edgePage(host, used) {
    const R = window.LEARN_DATA.rsi2R; const mean = R.reduce((a, b) => a + b, 0) / R.length;
    host.innerHTML = head('Start here', 'What an edge is', md('An edge is a small tilt in the odds that is still there after costs. It does not show up in one trade. It shows up over many.', used)) +
      card('', '<div class="edge-ctl"><div class="seg" id="edgeSeg"><button data-v="1" class="on" data-sound="toggle">With the edge</button><button data-v="0" data-sound="toggle">Edge removed</button></div><button class="ghost-btn" id="edgeShuffle" data-sound="click">' + Icons.svg('refresh') + 'Deal new paths</button></div>' +
        '<canvas class="edge-c" height="300"></canvas><div class="edge-stats" id="edgeStats"></div>' +
        '<p class="lp-fine">Each line is one trader taking the next 100 trades, picked at random from the ' + R.length + ' real trades RSI(2) made on the S&P 500 from 1991 to 2026 (after costs, each risking 1R). "Edge removed" takes the average (' + sgn(mean, 2) + 'R per trade) off every trade, so what is left is pure luck.</p>', 'wide') +
      '<div class="lp-grid">' + card('What to notice', '<ul class="lp-list"><li>' + md('Even with a real edge, some paths spend weeks under water. A losing month does not mean the rule broke.', used) + '</li><li>' + md('Without the edge the same paths drift sideways around zero, with the same big swings. Luck can look like skill for a while.', used) + '</li><li>' + md('This is why the app keeps each trade small: you need to survive long enough for the edge to show.', used) + '</li></ul>') +
        card('Expectancy in one line', '<div class="formula">Average trade = (win rate × average win) − (loss rate × average loss)</div><p>' + md('For RSI(2) on the S&P 500: about 74% winners averaging a small gain, 26% losers averaging a bigger loss, for about ' + sgn(mean, 2) + 'R per trade after costs. Small, but positive, over 323 trades.', used) + '</p>') + '</div>';
    const cv = host.querySelector('.edge-c'); const ctx = cv.getContext('2d');
    let seed = 7; let withEdge = true; let t0 = 0; let raf = 0; let paths = [];
    const deal = () => { const r = rng(seed); paths = []; for (let p = 0; p < 36; p++) { const a = [0]; for (let k = 0; k < 100; k++) a.push(a[a.length - 1] + R[Math.floor(r() * R.length)]); paths.push(a); } };
    const stats = () => {
      const fin = paths.map((a) => (withEdge ? a[100] : a[100] - mean * 100));
      let worst = 0; for (const a of paths) { let pk = 0; for (let k = 0; k <= 100; k++) { const v = withEdge ? a[k] : a[k] - mean * k; pk = Math.max(pk, v); worst = Math.min(worst, v - pk); } }
      const up = fin.filter((v) => v > 0).length; const avg = fin.reduce((a, b) => a + b, 0) / fin.length;
      host.querySelector('#edgeStats').innerHTML = '<div><span>Ahead after 100 trades</span><b class="num">' + up + ' of ' + fin.length + '</b></div><div><span>Average result</span><b class="num ' + (avg >= 0 ? 'up-t' : 'down-t') + '">' + sgn(avg, 1) + 'R</b></div><div><span>Worst dip along the way</span><b class="num down-t">' + sgn(worst, 1) + 'R</b></div>';
    };
    const frame = (now) => {
      if (!t0) t0 = now; const prog = reduced() ? 1 : Math.min(1, (now - t0) / 2200);
      const W = cv.clientWidth; const H = 300; const dpr = devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const vals = paths.map((a) => a.map((v, k) => (withEdge ? v : v - mean * k)));
      let lo = 0; let hi = 0; for (const a of vals) for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      lo = Math.min(lo, -8); hi = Math.max(hi, 8);
      const X = (k) => 40 + k / 100 * (W - 52); const Y = (v) => 12 + (hi - v) / (hi - lo) * (H - 36);
      ctx.font = '10.5px InterVar, Segoe UI, sans-serif'; ctx.fillStyle = TP().muted; ctx.strokeStyle = ink(.06);
      for (const v of [lo, lo / 2, 0, hi / 2, hi]) { ctx.beginPath(); ctx.moveTo(40, Y(v)); ctx.lineTo(W - 12, Y(v)); ctx.stroke(); ctx.fillText((Math.round(v) === 0 ? '0' : sgn(v, 0)) + 'R', 4, Y(v) + 3); }
      ctx.strokeStyle = ink(.3); ctx.beginPath(); ctx.moveTo(40, Y(0)); ctx.lineTo(W - 12, Y(0)); ctx.stroke();
      for (const k of [0, 25, 50, 75]) ctx.fillText(String(k), X(k) - 6, H - 6);
      ctx.textAlign = 'right'; ctx.fillText('100 trades', X(100), H - 6); ctx.textAlign = 'left';
      const n = Math.max(1, Math.round(100 * prog));
      for (const a of vals) {
        const end = a[100]; ctx.strokeStyle = end >= 0 ? ca(TP().up, .55) : ca(TP().down, .55); ctx.lineWidth = 1.3; ctx.beginPath();
        for (let k = 0; k <= n; k++) { const f = k ? 'lineTo' : 'moveTo'; ctx[f](X(k), Y(a[k])); } ctx.stroke();
      }
      // the average path
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2; ctx.beginPath(); for (let k = 0; k <= n; k++) { const v = vals.reduce((s, a) => s + a[k], 0) / vals.length; const f = k ? 'lineTo' : 'moveTo'; ctx[f](X(k), Y(v)); } ctx.stroke();
      if (prog < 1) raf = requestAnimationFrame(frame);
    };
    const run = () => { cancelAnimationFrame(raf); t0 = 0; stats(); raf = requestAnimationFrame(frame); };
    deal(); run();
    host.querySelectorAll('#edgeSeg button').forEach((b) => b.addEventListener('click', () => { withEdge = b.dataset.v === '1'; host.querySelectorAll('#edgeSeg button').forEach((x) => x.classList.toggle('on', x === b)); run(); }));
    host.querySelector('#edgeShuffle').addEventListener('click', () => { seed = (seed * 31 + 17) % 100000; deal(); run(); });
    const onR = () => { t0 = performance.now() - 9999; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); };
    addEventListener('resize', onR);
    L.cleanup.push(() => { cancelAnimationFrame(raf); removeEventListener('resize', onR); });
  }

  // ---------------------------------------------------------------- start here: risk
  function riskPage(host, used) {
    host.innerHTML = head('Start here', 'Risk, R and position size', md('Pick how much you are willing to lose if the stop is hit, first. The size of the trade follows from that, not the other way round.', used)) +
      card('Try it', '<div class="calc">' +
        '<label><span>Account</span><input type="range" id="cAcc" min="10000" max="200000" step="5000" value="100000"><b class="num" id="cAccV"></b></label>' +
        '<label><span>Risk per trade</span><input type="range" id="cRisk" min="0.1" max="3" step="0.05" value="0.5"><b class="num" id="cRiskV"></b></label>' +
        '<label><span>Entry price</span><input type="number" id="cEntry" value="500" step="0.01" min="0.01"></label>' +
        '<label><span>Stop price</span><input type="number" id="cStop" value="490" step="0.01" min="0.01"></label>' +
        '</div><div class="calc-out" id="cOut"></div>', 'wide') +
      card('Ten losses in a row', '<p>' + md('Every rule has losing streaks. Here is what ten straight losses do to the account at your risk setting, next to 2% a trade:', used) + '</p><div class="streak" id="cStreak"></div>', 'wide') +
      '<div class="lp-grid">' + card('What 1R means', '<p>' + md('**1R** is the amount you lose when the stop is hit. A trade that makes twice that is +2R. Measuring trades in R lets you compare a $50 stock with Bitcoin: the question is always how many R a rule makes per trade.', used) + '</p>') +
      card('Why the app keeps it small', '<p>' + md('The app\'s profiles risk 0.25% to 1% a trade. Prop firms usually stop you at a 5% daily or 10% total loss, so at 2% a trade a bad week can end the account before any edge shows up.', used) + '</p>') + '</div>';
    const $ = (id) => host.querySelector('#' + id);
    const upd = () => {
      const acc = +$('cAcc').value; const rp = +$('cRisk').value; const e = +$('cEntry').value; const s = +$('cStop').value;
      $('cAccV').textContent = '$' + acc.toLocaleString('en-US'); $('cRiskV').textContent = rp.toFixed(2) + '%';
      const riskUsd = acc * rp / 100; const dist = Math.abs(e - s); const qty = dist > 0 ? Math.floor(riskUsd / dist) : 0;
      $('cOut').innerHTML = '<div><span>You risk</span><b class="num down-t">$' + Math.round(riskUsd).toLocaleString('en-US') + '</b><small>= 1R</small></div><div><span>Stop distance</span><b class="num">$' + dist.toFixed(2) + '</b><small>per share</small></div><div class="big"><span>Size</span><b class="num">' + qty.toLocaleString('en-US') + ' shares</b><small>$' + Math.round(qty * e).toLocaleString('en-US') + ' of stock</small></div><div><span>If the stop is hit</span><b class="num down-t">−$' + Math.round(qty * dist).toLocaleString('en-US') + '</b><small>' + (acc ? (qty * dist / acc * 100).toFixed(2) : 0) + '% of the account</small></div>';
      const row = (p, label) => { const left = Math.pow(1 - p / 100, 10); const lost = (1 - left) * 100; return '<div class="st-row"><span>' + label + '</span><div class="st-bar"><i style="width:' + Math.min(100, lost / 25 * 100).toFixed(1) + '%"></i></div><b class="num down-t">−' + lost.toFixed(1) + '%</b><small>needs +' + ((1 / left - 1) * 100).toFixed(1) + '% to get back</small></div>'; };
      $('cStreak').innerHTML = row(rp, 'Your ' + rp.toFixed(2) + '%') + row(2, '2% a trade') + '<div class="st-scale num"><span>0%</span><span>−25%</span></div>';
    };
    ['cAcc', 'cRisk', 'cEntry', 'cStop'].forEach((id) => $(id).addEventListener('input', upd));
    upd();
  }

  // ---------------------------------------------------------------- start here: costs
  function costsPage(host, used) {
    // gross and cost per trade in bp, from core/research-results.json (1990-2026 runs)
    const rows = [
      { label: 'RSI(2), S&P 500 daily', gross: 43.2, cost: 6.8 },
      { label: 'Month-end, S&P 500 daily', gross: 42.8, cost: 4.2 },
      { label: 'IBS, Nasdaq-100 daily', gross: 36.7, cost: 9.7 },
      { label: 'Turn of the month, Russell 2000', gross: 36.5, cost: 3.0 },
      { label: 'Trend pullback, S&P 500 daily', gross: 12.1, cost: 7.1 },
      { label: 'Turtle, S&P 500 daily', gross: 8.8, cost: 7.2 },
      { label: 'RSI(2), S&P 500 hourly', gross: 1.9, cost: 2.7 },
      { label: 'Intraday momentum, 5 min', gross: 1.2, cost: 2.7 },
      { label: 'Last half hour, 5 min', gross: 0.9, cost: 2.7 },
      { label: 'Gap fade, 5 min', gross: 0.3, cost: 2.8 },
      { label: 'Opening range breakout, 5 min', gross: -0.1, cost: 2.7 },
    ];
    host.innerHTML = head('Start here', 'Costs: why most rules fail', md('Every trade pays the spread, slippage and commission twice: in and out. A rule has to make more than that before it makes anything.', used)) +
      card('Edge before costs against costs, per trade', '<div class="cost-ctl"><span>Your costs</span><input type="range" id="costMul" min="0" max="4" step="0.25" value="1"><b class="num" id="costMulV"></b></div><div class="cost-rows" id="costRows"></div>' +
        '<p class="lp-fine">Basis points per trade, 1990 to 2026, with the costs we tested at (micro futures: about a tick of slippage plus commission each side). Grey: the edge before costs. Coloured: what is left after costs, green if positive. Slide to see what cheaper or dearer trading does.</p>', 'wide') +
      '<div class="lp-grid">' + card('Why short timeframes are hard', '<p>' + md('On 5-minute bars a typical move is a few basis points, about the same as the cost of a round trip. The published intraday rules mostly assumed near-zero costs. Daily rules make 30 to 50 bp a trade, so the same cost is a small slice.', used) + '</p>') +
      card('What you can control', '<ul class="lp-list"><li>' + md('Trade cheap, liquid markets: index ETFs and micro index futures have tiny spreads.', used) + '</li><li>' + md('Use limit or market-on-close orders where the rule allows it.', used) + '</li><li>' + md('Trade less often: fewer, better trades keep more of the edge.', used) + '</li></ul>') + '</div>';
    const maxG = Math.max(...rows.map((r) => r.gross)) * 1.05;
    const upd = () => {
      const m = +host.querySelector('#costMul').value; host.querySelector('#costMulV').textContent = m === 1 ? 'as tested (1×)' : m + '×';
      host.querySelector('#costRows').innerHTML = rows.map((r) => {
        const net = r.gross - r.cost * m; const g = Math.max(0, r.gross) / maxG * 100; const nw = Math.abs(net) / maxG * 100;
        return '<div class="cr"><span class="cr-l">' + esc(r.label) + '</span><div class="cr-bar"><i class="g" style="width:' + g.toFixed(1) + '%"></i><i class="n ' + (net > 0 ? 'up' : 'down') + '" style="width:' + Math.min(100, nw).toFixed(1) + '%"></i></div><b class="num ' + (net > 0 ? 'up-t' : 'down-t') + '">' + sgn(net) + '</b></div>';
      }).join('');
    };
    host.querySelector('#costMul').addEventListener('input', upd); upd();
  }

  // ---------------------------------------------------------------- start here: tests
  function testsPage(host, used) {
    const all = []; for (const sid of Object.keys(window.LEARN_DATA.strategies)) for (const r of window.LEARN_DATA.strategies[sid].rows) if (r.round !== 19) all.push(r);
    const matched = all.reduce((n, r) => n + (r.check && r.check.match ? r.check.match.sameTrades : 0), 0);
    const t = (x) => (x ? '<span class="num ' + (x.netBp > 0 ? 'up-t' : 'down-t') + '">' + sgn(x.netBp) + '</span> <small class="num">t ' + x.tBp + '</small>' : '–');
    const steps = [
      ['1', 'Rules fixed before testing', 'Every rule came from its published source, with no tuning to make the numbers look better.'],
      ['2', 'Realistic fills and costs', 'Get in at the next bar\'s open (or the close, where the rule allows), pay the spread, slippage and commission both ways, and if a bar touches both the stop and the target, count the stop.'],
      ['3', 'Recent years as a test', '2020 to 2026 was treated as a holdout: a rule had to make money both before and after 2020.'],
      ['4', 'A luck check', '151 tests were run, so some would look good by chance. The Deflated Sharpe ratio asks whether the best of that many tries would look this good by luck alone. The best scored 0.66, below the usual 0.95 bar, so every edge here is treated as uncertain.'],
    ];
    host.innerHTML = head('Start here', 'How we tested: the triple check', md('A backtest can lie in quiet ways: a rule that peeks at tomorrow, a bug that only the author\'s code has, or prices that were never really tradeable. So the 10 results that held up were checked three more ways.', used)) +
      card('The first test', '<ol class="lp-rules">' + steps.map((s, k) => '<li style="--d:' + (k * 70) + 'ms"><span class="lr-n">' + s[0] + '</span><div><b>' + esc(s[1]) + '</b><span>' + md(s[2], used) + '</span></div></li>').join('') + '</ol>', 'wide') +
      '<div class="tc-grid">' +
      '<div class="tc"><div class="tc-n">1</div><h3>No peeking at the future</h3><p>' + md('An automated test cuts the price history at hundreds of points and checks that every rule makes exactly the same decision with or without the bars after the cut. All 10 strategies pass, and a planted rule that peeks one day ahead is caught.', used) + '</p></div>' +
      '<div class="tc"><div class="tc-n">2</div><h3>Rebuilt from scratch</h3><p>' + md('A second, separate program was written from the rules alone, without any of the app\'s code, with its own date handling, indicators, fills and costs. It produced the **same trades** as the research run: every one of ' + matched.toLocaleString('en-US') + ' trades matched on entry day, exit day and direction.', used) + '</p></div>' +
      '<div class="tc"><div class="tc-n">3</div><h3>Prices you could really trade</h3><p>' + md('The long index histories have a flaw: on most days before 2008 (and almost every FTSE day since 2002) their "open" price is just the previous close. So each rule was re-run on the real ETFs (SPY, QQQ, IWM) with their real opens, with entry at the close instead of the next open, with costs doubled, and from 2000 and 2010 on.', used) + '</p></div></div>' +
      card('Results', '<div class="lp-table-wrap"><table class="lp-table"><thead><tr><th>Strategy</th><th>Same trades when rebuilt</th><th>Since 2000</th><th>Since 2010</th><th>Real ETF prices</th><th>Buying at the close</th><th>Costs ×2</th><th>Result</th></tr></thead><tbody>' +
        all.map((r) => { const c = r.check || {}; const st = STATUS[c.status]; return '<tr><td><b>' + esc(nameOf(r.id)) + '</b><small>' + esc(r.market) + ' ' + esc(r.tf) + '</small></td><td class="num">' + (c.match ? c.match.sameTrades + ' of ' + c.match.research : '–') + '</td><td>' + t(c.since2000) + '</td><td>' + t(c.since2010) + '</td><td>' + (c.etf ? t(c.etf.base) + '<small>' + c.etf.symbol + '</small>' : '<small>–</small>') + '</td><td>' + t(c.etf ? c.etf.closeEntry : c.closeEntry) + '</td><td>' + t(c.cost2x && c.etf ? c.etf.cost2x : c.cost2x) + '</td><td>' + (st ? '<span class="lp-status sm ' + st.cls + '">' + Icons.svg(st.icon) + esc(st.label) + '</span>' : '') + '</td></tr>'; }).join('') +
        '</tbody></table></div><p class="lp-fine">Numbers are basis points per trade after costs, with the t-stat. "Passed" needs a t-stat of 2 or more from 2000, from 2010, with costs doubled and on the real ETF. "Buy at the close" passes those only when entering with a market-on-close order.</p>', 'wide') +
      '<div class="lp-grid">' + card('What changed', '<ul class="lp-list"><li>' + md('**Five passed**: RSI(2) on the S&P 500, IBS on the Nasdaq-100, month-end rebalancing on the S&P 500 and Russell 2000, and the Turtle breakout on Bitcoin.', used) + '</li><li>' + md('**RSI(2) on the Nasdaq-100 passed only when buying at the close.** Waiting for the next morning gave up about half the edge on QQQ.', used) + '</li><li>' + md('**Turn of the month (Russell 2000, DAX, FTSE) and the hourly USD/JPY Turtle were weaker than they looked.** Still positive, but since 2010 (or with double costs) too small to be sure.', used) + '</li></ul>') +
        card('What it still cannot tell you', '<p>' + md('All of this uses the past. These rules were chosen because they did well on these same years, so the honest planning case is less than the backtest. The only truly new evidence is the future: paper trade them in the app and see.', used) + '</p>') + '</div>' +
      r19Card(used);
  }

  // Round 19: five more published ideas through the same checks, on real ETF prices
  function r19Card(used) {
    const R = window.LEARN_DATA.r19; if (!R) return '';
    const t = (x) => (x && x.netBp != null ? '<span class="num ' + (x.netBp > 0 ? 'up-t' : 'down-t') + '">' + sgn(x.netBp) + '</span> <small class="num">t ' + x.tStat + '</small>' : '–');
    const app = (r) => R.appEngine.find((a) => a.symbol === r.symbol && ((r.id === 'double7' && a.strategy === 'double7') || (r.id === 'monthend' && a.strategy === 'tlt_month_end')));
    const result = (r) => {
      const a = app(r);
      if (r.id === 'monthend') return a && a.passed ? ['ok', 'check', 'Passed: added to the app'] : ['weak', 'alert', 'Weaker'];
      if (r.id === 'double7' && r.passed) return ['weak', 'alert', 'Only with no stop'];
      if (r.passed && r.indexBefore && r.indexBefore.netBp < 0) return ['weak', 'alert', 'Reversed on the older index'];
      if (r.passed && !r.passedNextOpen) return ['cond', 'clock', 'Only at the close'];
      return ['weak', 'x', 'Failed'];
    };
    return card('Round 19: five more published ideas', '<p>' + md('Each idea below is a rule from a published source, tested on the ETFs\' real prices with dividends, the app\'s costs, then with costs doubled, from 2000 and from 2010, on the older index history before the ETF existed, and finally the way the app would trade it (next open, 3 ATR safety stop). Only one made it into the app.', used) + '</p>' +
      '<div class="lp-table-wrap"><table class="lp-table"><thead><tr><th>Idea</th><th>Since 2000</th><th>Since 2010</th><th>Costs ×2</th><th>Next open</th><th>Older index</th><th>As the app trades it</th><th>Result</th></tr></thead><tbody>' +
      R.results.map((r) => { const a = app(r); const res = result(r); return '<tr><td><b>' + esc(r.name) + '</b><small>' + esc(r.symbol) + '</small></td><td>' + t(r.from2000) + '</td><td>' + t(r.from2010) + '</td><td>' + t(r.cost2x) + '</td><td>' + t(r.nextOpen) + '</td><td>' + (r.indexBefore ? t(r.indexBefore) + '<small>' + esc(r.indexBefore.index.replace('GSPC', 'S&P 500').replace('NDX', 'Nasdaq-100').replace('RUT', 'Russell 2000')) + ' ' + r.indexBefore.from + '+</small>' : '–') + '</td><td>' + (a ? t(a.from2000) : '–') + '</td><td><span class="lp-status sm ' + res[0] + '">' + Icons.svg(res[1]) + esc(res[2]) + '</span></td></tr>'; }).join('') +
      '</tbody></table></div>' +
      '<ul class="lp-list"><li>' + md('**Treasury month-end on TLT passed** every check, including the way the app trades it, and is now a strategy in the app (with a weak run since 2023 noted).', used) + '</li>' +
      '<li>' + md('**Double 7s is a lesson about stops.** As published, with no stop, it made +58 to +77 bp a trade on SPY and QQQ (t-stats over 4). With the app\'s safety stop, a quarter of its trades were stopped out just before the bounce and the edge fell to t-stats near 2. Its profits came from holding through deep drops, which is exactly the risk a stop exists to cap, so it is not in the app.', used) + '</li>' +
      '<li>' + md('**Overnight drift, the pre-holiday effect and Turnaround Tuesday did not make it.** The overnight edge is 1 to 3 bp a night, less than doubled costs; pre-holiday days were not reliable; Turnaround Tuesday only worked bought at the close and went the other way on the Russell 2000 before 2000.', used) + '</li></ul>' +
      '<p class="lp-fine">13 tests in this round: a t-stat of about 2.9 would be needed to rule out luck across all of them. TLT month-end as published (4.0) clears that; the app\'s version (2.7) does not quite.</p>', 'wide');
  }
  function nameOf(id) { return { rsi2: 'RSI(2) Pullback', ibs: 'IBS Reversal', month_end_rebal: 'Month-End Rebalancing', turtle: 'Turtle Breakout 20/10', turn_of_month: 'Turn of the Month', tlt_month_end: 'Treasury Month-End' }[id.split('|')[0]] || id; }

  // ---------------------------------------------------------------- failed
  function failedPage(host, used) {
    const F = [
      ['Opening range breakouts and the opening gap fade', '5-minute S&P 500 and Nasdaq-100', 'Before costs they made between −0.5 and +0.3 bp a trade; a micro future round trip costs about 2.7 bp. Popular online, but the published tests mostly assumed free trading.'],
      ['Intraday momentum and the last half hour', '5-minute index futures', 'The pattern is real in the papers (Baltussen et al. 2021), but it was worth only 1 to 2 bp a trade before costs here, less than the costs.'],
      ['Trend pullback (buy the dip to the 20 EMA)', '27 markets and timeframes', 'A widely taught chart setup. None of the 27 tests held up. A few made a little after costs, the best being crude oil 4-hour at +21 bp a trade, but with a t-stat of 1.4 that is within what luck can do.'],
      ['RSI(2) and IBS outside stock indexes', 'Forex, crypto, gold, oil', 'These markets do not show the daily reversal stock indexes do. On Bitcoin the 0.6% fee each way also ate everything.'],
      ['Turtle breakouts on stock indexes and most forex', 'S&P 500, Nasdaq-100, EUR/USD, GBP/USD', 'Trends in stock indexes and currencies have been weaker since 2009 (Kurth et al. 2026). The same rule that worked on Bitcoin made about nothing here.'],
      ['12-month trend', 'Indexes, crypto, forex', 'Profitable on the S&P 500 and Nasdaq-100 (mixed), but only about 3 trades a year, too few to tell skill from luck in 35 years.'],
      ['Overnight drift (round 19)', 'SPY, QQQ, IWM: buy at the close, sell at the next open', 'Stocks really have earned most of their gains overnight, but only 1 to 3 bp a night. Doubled costs (4 bp a round trip) turn it negative.'],
      ['Double 7s (round 19)', 'SPY, QQQ, IWM daily', 'Strong as published, with no stop. With a safety stop the edge roughly halves, because it profits from holding through deep drops. Before 1993 it made almost nothing on the S&P 500.'],
      ['Pre-holiday and Turnaround Tuesday (round 19)', 'SPY, QQQ, IWM daily', 'The pre-holiday gain was not reliable since 2000. Turnaround Tuesday only held up bought at Monday\'s close, and lost money on the Russell 2000 before 2000.'],
    ];
    host.innerHTML = head('Honest results', 'Rules that failed, and why', md('124 of the 151 tests failed. Knowing why is as useful as knowing what worked: it is mostly costs, and markets that do not behave the way the rule needs.', used)) +
      '<div class="fail-list">' + F.map((f, k) => '<div class="fl" style="--d:' + (k * 60) + 'ms"><div class="fl-i">' + Icons.svg('x') + '</div><div><b>' + esc(f[0]) + '</b><small>' + esc(f[1]) + '</small><p>' + md(f[2], used) + '</p></div></div>').join('') + '</div>' +
      card('The pattern', '<p>' + md('What survived trades **daily bars** on **stock indexes** (or follows long trends on Bitcoin), where the edge per trade is 30 to 50 bp or more and costs are a few bp. What failed tried to win a few bp a trade on short bars, or used a stock-index idea on a market that does not behave like one.', used) + '</p>', 'wide');
  }

  window.Learn = { open, close, isOpen, show };
})();
