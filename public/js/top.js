/* Top trades: scans every market the app covers, ranks the setups by evidence, and keeps
   scanning in the background (with an alert when a new "Worth taking" trade shows up). Also
   watches RSI(2) and IBS into the US close, so a buy-at-the-close signal is not missed. */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const G = (s) => (window.Gloss ? Gloss.wrap(esc(s)) : esc(s));
  const sgn = (x, d) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d == null ? 1 : d);
  const money = (x) => '$' + Math.round(x).toLocaleString('en-US');
  const qtyText = (q) => (q >= 1e6 ? +(q / 1e6).toFixed(2) + 'M' : q >= 1e4 ? +(q / 1e3).toFixed(1) + 'k' : String(+Number(q).toPrecision(6)));
  const unitOf = (r) => (r.market === 'stocks' ? 'sh' : r.market === 'futures' ? 'contracts' : r.market === 'forex' ? 'units' : r.symbol.split('-')[0]);
  const getPref = (k, d) => { try { const v = localStorage.getItem('pd.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem('pd.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const MARKET_NAME = { stocks: 'Stocks', crypto: 'Crypto', forex: 'Forex', futures: 'Futures' };
  const TF_NAME = { '1h': '1H', '4h': '4H', '1d': '1D' };

  const T = {
    el: null, rows: [], skipped: [], scanned: 0, none: 0, errors: 0, at: 0, scanning: false, progress: 0, total: 0,
    filter: getPref('topFilter', 'all'), showAll: false, open: false, timer: null, baseline: null, hooks: {},
    watch: null, watchAt: 0, watchTimer: null, expanded: new Set(),
  };
  const keyOf = (r) => r.symbol + '|' + r.tf + '|' + r.strategy.id + '|' + r.side + '|' + (r.pending ? 'p' : 's');
  const LEVEL = { take: 2, caution: 1, skip: 0 };
  const cmp = (a, b) => (LEVEL[b.verdict.level] - LEVEL[a.verdict.level]) || (b.evidence.tier - a.evidence.tier) || ((a.pending ? 1 : 0) - (b.pending ? 1 : 0)) || (b.score - a.score) || (a.symbol < b.symbol ? -1 : 1);

  // ---------------------------------------------------------------- scanning
  async function scan(opts) {
    const o = opts || {};
    if (T.scanning) return null;
    T.scanning = true; T.progress = 0;
    let list;
    try { list = await Api.call('topList', {}); } catch (e) { T.scanning = false; return null; }
    T.total = list.length; render();
    const rows = []; let none = 0; let errors = 0;
    for (let k = 0; k < list.length; k += 6) {
      const batch = list.slice(k, k + 6);
      let res = [];
      try { res = await Api.call('scanTop', { items: batch }); } catch (e) { errors += batch.length; }
      for (const x of res) { if (x.error) errors++; else if (x.none) none++; else rows.push(...x.rows.filter(Boolean)); }
      T.progress = Math.min(list.length, k + batch.length); T.current = batch[batch.length - 1];
      if (T.open) renderProgress();
    }
    const ranked = rows.filter((r) => r.verdict.level !== 'skip').sort(cmp);
    ranked.forEach((r, i) => { r.rank = i + 1; });
    const prevKeys = T.baseline;
    Object.assign(T, { rows: ranked, skipped: rows.filter((r) => r.verdict.level === 'skip').sort(cmp), scanned: list.length, none, errors, at: Date.now(), scanning: false });
    T.baseline = new Set(ranked.map(keyOf));
    if (prevKeys && !o.quiet) alertNew(ranked.filter((r) => r.verdict.level === 'take' && !prevKeys.has(keyOf(r))));
    badge();
    if (T.open) render();
    return T;
  }

  // a new "Worth taking" trade since the last scan: alert once per trade per day
  function alertNew(fresh) {
    if (!fresh.length) return;
    const day = new Date().toDateString();
    let seen = getPref('topAlerted', {}); if (seen.day !== day) seen = { day, keys: [] };
    const out = fresh.filter((r) => !seen.keys.includes(keyOf(r)));
    if (!out.length) return;
    seen.keys.push(...out.map(keyOf)); setPref('topAlerted', seen);
    const r = out[0];
    const title = 'New top trade: #' + r.rank + ' ' + (r.side === 'buy' ? 'Buy ' : 'Sell ') + r.symbol;
    const body = r.strategy.name + ' on the ' + (TF_NAME[r.tf] || r.tf) + ' chart. ' + r.verdict.title + ', ' + r.evidence.label.toLowerCase() + '.' + (out.length > 1 ? ' Plus ' + (out.length - 1) + ' more in Top trades.' : '');
    if (T.hooks.alert) T.hooks.alert({ title, body, icon: 'spark', onClick: () => openRow(r) });
  }

  function schedule() {
    clearInterval(T.timer); T.timer = null;
    const every = getPref('scanEvery', 15);
    if (every > 0) T.timer = setInterval(() => scan(), every * 60000);
  }

  // ---------------------------------------------------------------- close watch
  function etNow() {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    const g = (t) => (f.find((x) => x.type === t) || {}).value;
    return { wd: g('weekday'), min: Number(g('hour')) * 60 + Number(g('minute')) };
  }
  function inCloseWindow() { const e = etNow(); return !['Sat', 'Sun'].includes(e.wd) && e.min >= 930 && e.min < 960; }
  async function checkClose(force) {
    if (!force && !inCloseWindow()) return;
    let w; try { w = await Api.call('closeWatch', {}); } catch (e) { return; }
    T.watch = w; T.watchAt = Date.now();
    if (T.open) renderWatch();
    if (!getPref('closeAlerts', true)) return;
    const day = new Date().toDateString();
    let seen = getPref('closeAlerted', {}); if (seen.day !== day) seen = { day, keys: [] };
    for (const r of w.rows) {
      if (r.state !== 'fire' || !r.open || r.minsToClose == null || r.minsToClose > 15 || r.minsToClose <= 0) continue;
      const k = r.strategy + '|' + r.symbol; if (seen.keys.includes(k)) continue;
      seen.keys.push(k); setPref('closeAlerted', seen);
      const body = 'Would signal if it closed now (' + r.valueText + ', needs ' + r.need + ').' + (r.fireBelow ? ' It fires on a close below about ' + r.fireBelow.toFixed(r.decimals) + '.' : '') +
        ' To buy at the close, place a market-on-close order now: most brokers need it by about 3:50 PM ET.' + (r.mustClose ? ' On the Nasdaq-100 this rule only held up bought at the close.' : '');
      if (T.hooks.alert) T.hooks.alert({ title: 'Buy at the close: ' + r.label, body, icon: 'clock', onClick: () => T.hooks.onChart && T.hooks.onChart({ symbol: r.symbol, tf: '1d', strategy: { id: r.strategy }, side: 'buy', pending: false }) });
    }
  }
  function scheduleWatch() {
    clearInterval(T.watchTimer);
    T.watchTimer = setInterval(() => checkClose(false), 60000);
  }

  // ---------------------------------------------------------------- overlay
  function open() {
    if (!T.el) build();
    if (window.Learn && Learn.isOpen()) Learn.close();
    if (window.Lesson && Lesson.isOpen()) Lesson.close(true);
    T.open = true; T.el.hidden = false; T.el.classList.remove('out');
    document.body.classList.add('top-open');
    if (window.Sound) Sound.play('open');
    render();
    if (!T.at || Date.now() - T.at > 5 * 60000) scan({ quiet: !T.baseline });
    if (!T.watch || Date.now() - T.watchAt > 60000) checkClose(true);
  }
  function close() {
    if (!T.el || !T.open) return;
    T.open = false; T.el.classList.add('out'); document.body.classList.remove('top-open');
    setTimeout(() => { if (!T.open) T.el.hidden = true; }, 220);
    if (window.Gloss) Gloss.hide();
    if (window.Sound) Sound.play('close');
  }
  function openRow(r) { close(); if (T.hooks.onChart) T.hooks.onChart(r); }

  function build() {
    const el = document.createElement('div');
    el.className = 'tops'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Top trades');
    el.innerHTML = '<div class="tp-wrap"><header class="tp-head"><div><div class="lp-kicker">Top trades</div><h1>The best setups right now, ranked</h1>' +
      '<p class="lp-lead">Every market in the app, scanned on the daily chart (and 1H and 4H for forex and crypto). Ranked by evidence: the app\'s verdict first, then how well the rule held up in 36 years of tests, then the grade. Even #1 can lose: that is what the stop is for.</p></div>' +
      '<div class="tp-actions"><button class="ghost-btn tp-refresh" data-sound="click"><span class="ico" data-icon="refresh"></span><span>Scan again</span></button><button class="icon-btn tp-x" title="Close (Esc)" data-sound="none"><span class="ico" data-icon="x"></span></button></div></header>' +
      '<div class="tp-bar"><div class="tp-filter">' + ['all', 'stocks', 'crypto', 'forex', 'futures'].map((m) => '<button data-v="' + m + '" data-sound="toggle">' + (m === 'all' ? 'All markets' : MARKET_NAME[m]) + '</button>').join('') + '</div><span class="tp-status"></span></div>' +
      '<div class="tp-progress" hidden><i></i><span></span></div>' +
      '<div class="tp-stats"></div><div class="tp-watch"></div><div class="tp-body"></div>' +
      '<section class="tp-how"><h2>How the ranking works</h2><ol>' +
      '<li><b>Verdict first.</b> "Worth taking" ranks above "Take with care". "Better to skip" is left out of the ranking and listed at the bottom.</li>' +
      '<li><b>Then the evidence.</b> Triple-checked rules (rebuilt from scratch, re-tested on real prices with costs doubled) rank above rules that held up but were weaker on the re-check, then mixed results, then rules with only this chart\'s own history.</li>' +
      '<li><b>Then live signals before resting orders.</b> A setup that fired on the last closed bar ranks above a stop or limit order that may never fill.</li>' +
      '<li><b>Then the grade score</b>: the chart\'s own backtest, the bigger trend and how fresh the signal is.</li></ol>' +
      '<div class="tp-set"><label><span>Scan in the background</span><select class="tp-every"><option value="0">Off</option><option value="15">Every 15 minutes</option><option value="30">Every 30 minutes</option><option value="60">Every hour</option></select></label>' +
      '<label class="tp-chk"><input type="checkbox" class="tp-close-chk"> <span>Buy-at-the-close alerts for RSI(2) and IBS (from 3:45 PM ET)</span></label></div>' +
      '<p class="lp-fine">The scanner runs while PaperDesk is open and alerts you once when a new "Worth taking" trade appears. Paper trading only; past results do not promise future ones.</p></section></div>';
    document.body.appendChild(el);
    Icons.hydrate(el);
    el.querySelector('.tp-x').addEventListener('click', close);
    el.querySelector('.tp-refresh').addEventListener('click', () => scan());
    el.querySelectorAll('.tp-filter button').forEach((b) => b.addEventListener('click', () => { T.filter = b.dataset.v; setPref('topFilter', T.filter); T.showAll = false; render(); }));
    const ev = el.querySelector('.tp-every'); ev.value = String(getPref('scanEvery', 15));
    ev.addEventListener('change', () => { setPref('scanEvery', Number(ev.value)); schedule(); render(); if (window.Sound) Sound.play('toggle'); });
    const cc = el.querySelector('.tp-close-chk'); cc.checked = getPref('closeAlerts', true);
    cc.addEventListener('change', () => { setPref('closeAlerts', cc.checked); if (window.Sound) Sound.play('toggle'); });
    addEventListener('keydown', (e) => {
      if (!T.open || (window.Confirm && Confirm.isOpen())) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if (!typing && e.key !== 'Tab') e.stopImmediatePropagation();
    }, true);
    T.el = el;
  }

  function renderProgress() {
    const p = T.el.querySelector('.tp-progress');
    p.hidden = !T.scanning;
    if (!T.scanning) return;
    p.querySelector('i').style.width = (T.total ? T.progress / T.total * 100 : 0).toFixed(1) + '%';
    p.querySelector('span').textContent = 'Scanning ' + (T.current ? T.current.symbol + ' ' + (TF_NAME[T.current.tf] || T.current.tf) : '') + '… ' + T.progress + ' of ' + T.total + ' charts';
    T.el.querySelector('.tp-refresh').disabled = true;
  }

  function render() {
    if (!T.el) return;
    const el = T.el;
    el.querySelectorAll('.tp-filter button').forEach((b) => b.classList.toggle('on', b.dataset.v === T.filter));
    el.querySelector('.tp-refresh').disabled = T.scanning;
    renderProgress();
    const every = getPref('scanEvery', 15);
    el.querySelector('.tp-status').textContent = T.at ? 'Scanned at ' + new Date(T.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + (every ? ' · scanning every ' + every + ' min in the background' : ' · background scan off') : (T.scanning ? '' : 'Not scanned yet');
    const inF = (r) => T.filter === 'all' || r.market === T.filter;
    const rows = T.rows.filter(inF); const skipped = T.skipped.filter(inF);
    const take = rows.filter((r) => r.verdict.level === 'take').length;
    el.querySelector('.tp-stats').innerHTML = !T.at ? '' :
      stat('Charts scanned', T.scanned, '') + stat('Worth taking', take, 'take') + stat('Take with care', rows.length - take, 'caution') + stat('Better to skip', skipped.length, 'skip') + stat('No setup', T.none, '');
    renderWatch();
    const body = el.querySelector('.tp-body');
    if (!T.at) { body.innerHTML = T.scanning ? skeleton() : ''; return; }
    if (!rows.length) {
      body.innerHTML = '<div class="tp-empty"><span class="ico" data-icon="shield"></span><b>Nothing worth ranking ' + (T.filter === 'all' ? 'right now' : 'in ' + MARKET_NAME[T.filter]) + '.</b><p>No setup passed the app\'s checks. Not trading is a valid trade; the scanner keeps looking.</p></div>' + skippedHtml(skipped);
      Icons.hydrate(body); bindRows(body); return;
    }
    const hero = rows[0];
    const rest = rows.slice(1, T.showAll ? rows.length : 12);
    let html = heroHtml(hero);
    let lastLevel = hero.verdict.level;
    html += '<div class="tp-list">';
    if (rest.length && rest[0].verdict.level !== lastLevel) html += groupHead(rest[0].verdict.level, rows);
    rest.forEach((r, k) => {
      if (k > 0 && r.verdict.level !== lastLevel) html += groupHead(r.verdict.level, rows);
      lastLevel = r.verdict.level;
      html += rowHtml(r, k);
    });
    html += '</div>';
    if (rows.length > 12 && !T.showAll) html += '<button class="ghost-btn tp-more" data-sound="click">Show all ' + rows.length + ' ranked setups</button>';
    html += skippedHtml(skipped);
    body.innerHTML = html;
    Icons.hydrate(body);
    bindRows(body);
    const more = body.querySelector('.tp-more'); if (more) more.addEventListener('click', () => { T.showAll = true; render(); });
  }
  const stat = (k, v, cls) => '<div class="tp-stat ' + cls + '"><span>' + k + '</span><b class="num">' + v + '</b></div>';
  const groupHead = (level, rows) => { const n = rows.filter((r) => r.verdict.level === level).length; return '<div class="tp-group ' + level + '">' + (level === 'take' ? 'Worth taking' : 'Take with care') + ' <span class="num">' + n + '</span></div>'; };
  function skeleton() { let h = '<div class="tp-skel">'; for (let k = 0; k < 6; k++) h += '<i style="--d:' + (k * 90) + 'ms"></i>'; return h + '</div>'; }

  function evidenceLine(r) {
    if (r.research && (r.research.verdict === 'holds' || r.research.verdict === 'mixed')) {
      return '<span class="num ' + (r.research.netBp >= 0 ? 'up-t' : 'down-t') + '">' + sgn(r.research.netBp) + ' bp</span> a trade · t ' + r.research.tStat + ' · ' + r.research.trades.toLocaleString('en-US') + ' trades ' + r.research.from + '–' + r.research.to;
    }
    const b = r.backtest;
    return b.trades ? '<span class="num ' + (b.expectancyR >= 0 ? 'up-t' : 'down-t') + '">' + sgn(b.expectancyR || 0, 2) + 'R</span> a trade over ' + b.trades + ' trades on this chart' : 'No past trades on this chart';
  }
  function tradeLine(r) {
    const d = r.decimals;
    return (r.pending ? (r.entryType === 'limit' ? 'Limit order at ' : 'Stop order at ') : 'Enter near ') + '<b class="num">' + Number(r.entry).toFixed(d) + '</b> · stop <span class="num">' + Number(r.stop).toFixed(d) + '</span>' + (r.target != null ? ' · target <span class="num">' + Number(r.target).toFixed(d) + '</span>' : ' · rule exit');
  }
  function costLine(r) {
    const c = r.cost; if (!c) return '';
    if (c.instead) return '<span class="tp-cost hot">Fits on ' + esc(c.instead.symbol) + ': about ' + c.instead.qty + ' shares</span>';
    if (!r.qty) return '';
    const usd = c.usd < 10 ? '$' + c.usd.toFixed(2) : money(c.usd);
    return '<span class="tp-cost" title="Round-trip trading cost: spread, slippage and fees, in and out">Costs ' + usd + ' round trip' + (c.R != null ? ' (' + (c.R < 0.01 ? 'under 0.01R' : c.R.toFixed(2) + 'R') + ')' : '') + (c.cheaper ? ' · cheaper via ' + esc(c.cheaper.symbol) : '') + '</span>';
  }
  const chips = (r) => '<span class="tp-v ' + r.verdict.level + '">' + esc(r.verdict.title) + '</span><span class="tp-e e' + r.evidence.tier + '">' + esc(r.evidence.label) + '</span>';
  const side = (r) => '<span class="side-tag ' + (r.side === 'sell' ? 'short' : 'long') + '">' + (r.side === 'sell' ? 'SELL' : 'BUY') + '</span>';
  const tfChip = (r) => '<span class="tp-tf">' + (TF_NAME[r.tf] || r.tf) + '</span>';

  function heroHtml(r) {
    const good = (r.verdict.good || []).slice(0, 3).map((x) => '<li class="g">' + G(x.text) + '</li>').join('');
    const warn = (r.verdict.warn || []).slice(0, 2).map((x) => '<li class="w">' + G(x.text) + '</li>').join('');
    return '<article class="tp-hero ' + r.verdict.level + '" data-key="' + esc(keyOf(r)) + '"><div class="tp-medal"><span>#1</span></div>' +
      '<div class="tp-hero-main"><div class="tp-hero-top">' + side(r) + '<h2>' + esc(r.symbol) + ' ' + tfChip(r) + '</h2><span class="tp-name">' + esc(r.name) + '</span></div>' +
      '<div class="tp-strat">' + esc(r.strategy.name) + (r.pending ? ' · setup forming' : ' · signal on the last closed bar') + '</div>' +
      '<div class="tp-chips">' + chips(r) + '</div>' +
      '<div class="tp-nums"><div><span>Entry</span><b class="num">' + Number(r.entry).toFixed(r.decimals) + '</b><small>' + (r.pending ? r.entryType + ' order' : 'near the current price') + '</small></div>' +
      '<div><span>Stop</span><b class="num down-t">' + Number(r.stop).toFixed(r.decimals) + '</b><small>risk ' + money(r.riskUsd) + '</small></div>' +
      '<div><span>' + (r.target != null ? 'Target' : 'Exit') + '</span><b class="num' + (r.target != null ? ' up-t' : '') + '">' + (r.target != null ? Number(r.target).toFixed(r.decimals) : 'rule') + '</b><small>' + (r.target != null && r.rr ? r.rr.toFixed(1) + '× the risk' : 'the strategy\'s own exit') + '</small></div>' +
      '<div><span>Size</span><b class="num">' + qtyText(r.qty) + ' <small>' + unitOf(r) + '</small></b><small>' + money(r.notional) + ' exposure</small></div></div>' +
      '<div class="tp-ev">' + evidenceLine(r) + costLine(r) + '</div>' +
      '<ul class="tp-why">' + good + warn + '</ul>' +
      '<div class="tp-hero-act"><button class="ln-go tp-open" data-sound="none">' + Icons.svg('stocks') + 'Open the chart and trade it</button></div></div></article>';
  }
  function rowHtml(r, k) {
    const key = keyOf(r); const open = T.expanded.has(key);
    const items = (r.verdict.good || []).map((x) => '<li class="g">' + G(x.text) + '</li>').concat((r.verdict.warn || []).map((x) => '<li class="w">' + G(x.text) + '</li>')).join('');
    return '<div class="tp-row' + (open ? ' open' : '') + '" data-key="' + esc(key) + '" style="--d:' + Math.min(k, 14) * 40 + 'ms" tabindex="0">' +
      '<div class="tp-rank' + (r.rank <= 3 ? ' r' + r.rank : '') + '"><span class="num">#' + r.rank + '</span></div>' +
      '<div class="tp-sym"><b>' + esc(r.symbol) + '</b>' + tfChip(r) + '<small>' + esc(r.name) + '</small></div>' +
      '<div class="tp-trade">' + side(r) + '<b>' + esc(r.strategy.name) + '</b><small>' + tradeLine(r) + '</small></div>' +
      '<div class="tp-cell-chips">' + chips(r) + '</div>' +
      '<div class="tp-rec"><small>' + evidenceLine(r) + '</small>' + costLine(r) + '</div>' +
      '<div class="tp-risk num"><b>' + money(r.riskUsd) + '</b><small>risk · ' + qtyText(r.qty) + ' ' + unitOf(r) + '</small></div>' +
      '<button class="ghost-btn tp-open" data-sound="none">Open' + Icons.svg('chev') + '</button>' +
      '<ul class="tp-why">' + items + '</ul></div>';
  }
  function skippedHtml(list) {
    if (!list.length) return '';
    return '<details class="tp-skipped"><summary>' + Icons.svg('stop') + ' Better to skip <span class="num">' + list.length + '</span><small>Setups the app found but advises against, with the main reason</small></summary><div class="tp-skip-list">' +
      list.slice(0, 60).map((r) => '<div class="tp-skip" data-key="' + esc(keyOf(r)) + '">' + side(r) + '<b>' + esc(r.symbol) + '</b>' + tfChip(r) + '<span>' + esc(r.strategy.name) + '</span><small>' + G(((r.verdict.bad || [])[0] || (r.verdict.warn || [])[0] || { text: r.verdict.line }).text) + (r.cost && r.cost.instead ? ' ' + costLine(r) : '') + '</small></div>').join('') + '</div></details>';
  }
  function bindRows(body) {
    const find = (key) => T.rows.concat(T.skipped).find((r) => keyOf(r) === key);
    body.querySelectorAll('.tp-open').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); const host = b.closest('[data-key]'); const r = host && find(host.dataset.key);
      if (r) { if (window.Sound) Sound.play('select'); openRow(r); }
    }));
    body.querySelectorAll('.tp-row').forEach((row) => {
      const toggle = () => { const k = row.dataset.key; if (T.expanded.has(k)) T.expanded.delete(k); else T.expanded.add(k); row.classList.toggle('open'); if (window.Sound) Sound.play('tick'); };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const r = find(row.dataset.key); if (r) openRow(r); } else if (e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  }

  function renderWatch() {
    const box = T.el && T.el.querySelector('.tp-watch'); if (!box) return;
    const w = T.watch;
    if (!w) { box.innerHTML = ''; return; }
    const win = inCloseWindow();
    box.innerHTML = '<div class="tw-head">' + Icons.svg('clock') + '<b>Buy-at-the-close watch</b><span>' + (win ? 'Live: the US close is in ' + Math.max(0, w.minsToClose) + ' min' : 'Checks every minute from 3:30 PM ET; alerts from 3:45 PM ET') + '</span></div><div class="tw-rows">' +
      w.rows.map((r) => {
        if (r.state === 'error') return '<div class="tw far"><b>' + esc(r.label) + '</b><small>' + esc(r.text) + '</small></div>';
        const label = { fire: 'Would fire at the close', near: 'Getting close', far: 'Not near a signal' }[r.state];
        return '<div class="tw ' + r.state + '"><div class="tw-top"><b>' + esc(r.label) + '</b><span class="tw-state">' + label + '</span></div><small>' + esc(r.valueText) + ' (needs ' + esc(r.need) + ')' +
          (r.note ? '. ' + esc(r.note.replace(/\.$/, '')) : r.fireBelow ? '. Fires on a close below ' + r.fireBelow.toFixed(r.decimals) + ' (now ' + Number(r.price).toFixed(r.decimals) + ')' : '') + (r.open ? '.' : '. Market closed: values are from the last session.') + '</small></div>';
      }).join('') + '</div>';
  }

  function badge() {
    const b = document.getElementById('topBtn'); if (!b) return;
    const n = T.rows.filter((r) => r.verdict.level === 'take').length;
    let i = b.querySelector('.tb-badge');
    if (!n) { if (i) i.remove(); return; }
    if (!i) { i = document.createElement('i'); i.className = 'tb-badge num'; b.appendChild(i); }
    i.textContent = n; i.title = n + ' worth taking right now';
  }

  function init(hooks) {
    T.hooks = hooks || {};
    schedule(); scheduleWatch();
    // a quiet first scan shortly after start: it sets the baseline, so only later changes alert
    setTimeout(() => { if (!T.at && !T.scanning) scan({ quiet: true }); }, 20000);
    setTimeout(() => checkClose(false), 8000);
  }

  window.Top = { init, open, close, isOpen: () => T.open, scan, checkClose, state: T };
})();
