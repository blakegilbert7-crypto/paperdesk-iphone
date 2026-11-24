/* PaperDesk UI controller. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MARKET_ICON = { stocks: 'stocks', crypto: 'crypto', forex: 'forex', futures: 'futures' };
  const STRAT_COLOR = { noise_momentum: '#3987e5', orb: '#d95926', last_half_hour: '#199e70', turtle: '#c98500', rsi2: '#d55181', trend_pullback: '#0ca30c', ibs: '#9b7bf0', month_end_rebal: '#2bb3c0', turn_of_month: '#a3b4cc', donchian55: '#e8833a', tlt_month_end: '#e7c84a' };
  const TF_LABEL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
  const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

  const pref = (k, d) => { try { const v = localStorage.getItem('pd.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem('pd.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  // small charts follow the theme too
  function miniLayout() { const p = Theme.pal; return { background: { type: 'solid', color: p.bg }, textColor: p.text, fontFamily: Theme.css('--font') || 'InterVar, sans-serif', fontSize: 10 }; }
  function alpha(col, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(col || '');
    if (m) { const n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
    const r = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec((col || '').replace(/\s/g, ''));
    return r ? 'rgba(' + r[1] + ',' + r[2] + ',' + r[3] + ',' + a + ')' : col;
  }

  const st = {
    catalog: null, inst: {}, market: pref('market', 'stocks'), symbol: pref('symbol', 'SPY'), tf: pref('tf', '5m'),
    profile: 'medium', account: null, quotes: {}, idea: null, ideaFor: null, preview: pref('preview', true),
    side: 'buy', type: 'market', sizeBy: 'risk', dock: 'positions', status: null, lastPrice: null,
    loadToken: 0, ideaBusy: false, sigOn: true, sigStrat: pref('sigStrat', 'auto'), lab: null, labOff: new Set(), notify: pref('notify', true), lastIdeaAt: 0,
  };

  // ---------- formatting ----------
  function money(v, d) {
    if (v == null || !isFinite(v)) return '-';
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  }
  function smoney(v, d) { return v == null || !isFinite(v) ? '-' : (v >= 0 ? '+' : '-') + money(Math.abs(v), d); }
  function pct(v, d) { return v == null || !isFinite(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%'; }
  function px(sym, v) {
    if (v == null || !isFinite(v)) return '-';
    const i = st.inst[sym];
    const dec = i ? i.decimals : 2;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function qtyFmt(sym, q) {
    const i = st.inst[sym];
    if (!i) return String(q);
    return Number(q).toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  function dur(sec) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60);
    if (h >= 48) return Math.round(h / 24) + 'd';
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function timeStr(t) {
    const d = new Date(t * 1000);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const cls = (v) => (v > 0 ? 'up-t' : v < 0 ? 'down-t' : '');

  // ---------- boot ----------
  async function boot() {
    Icons.hydrate();
    try {
      st.catalog = await Api.call('catalog');
    } catch (e) {
      $('chartError').hidden = false;
      $('chartError').textContent = 'Could not start the trading engine: ' + e.message;
      return;
    }
    st.catalog.instruments.forEach((i) => { st.inst[i.symbol] = i; });
    if (!st.inst[st.symbol]) st.symbol = 'SPY';
    st.market = st.inst[st.symbol].market;

    buildMarketTabs();
    buildTfSeg();
    buildRisk();
    bindTicket();
    bindDock();
    bindModals();
    bindKeys();
    PriceChart.init($('chart'), $('chartOverlay'), $('ohlcLegend'));
    const indPref = pref('ind', { ema20: true, ema50: true, vwap: false, volume: true, signals: true });
    if (indPref.signals === undefined) indPref.signals = true;
    st.sigOn = !!indPref.signals;
    PriceChart.setIndicators(indPref);
    document.querySelectorAll('#indToggles .chip').forEach((c) => {
      c.classList.toggle('on', !!indPref[c.dataset.ind]);
      c.addEventListener('click', () => {
        c.classList.toggle('on');
        const s = {}; document.querySelectorAll('#indToggles .chip').forEach((x) => { s[x.dataset.ind] = x.classList.contains('on'); });
        PriceChart.setIndicators(s); setPref('ind', s);
        if (c.dataset.ind === 'signals') {
          st.sigOn = s.signals;
          if (st.sigOn && st.idea && !st.idea.signals) refreshIdea(true);
          drawTrades();
        }
      });
    });
    updateSoundBtn();

    await refreshAccount();
    st.profile = st.account ? st.account.profile : 'medium';
    Fx.seg($('riskSeg'), st.profile);
    renderWatchlist();
    selectSymbol(st.symbol, st.tf, true);

    Api.onEvent(onEngineEvent);
    setInterval(refreshAccount, 1500);
    setInterval(refreshQuotes, 6000);
    refreshQuotes();
    setInterval(() => { if (Date.now() - st.lastIdeaAt > 60000) refreshIdea(); }, 10000);
    liveLoop();

    document.querySelectorAll('.panel').forEach((p, i) => { p.classList.add('enter'); p.style.animationDelay = (i * 60) + 'ms'; });
    if (!pref('welcomed', false)) openWelcome();
    if (window.Top) Top.init({ onChart: showTopTrade, alert: topAlert });
    Theme.onChange(() => {
      const opt = { layout: miniLayout(), grid: { vertLines: { visible: false }, horzLines: { color: Theme.ink(0.04) } } };
      if (perfChart) { perfChart.applyOptions(opt); perfSeries.applyOptions({ lineColor: Theme.pal.line, topColor: alpha(Theme.pal.line, 0.35), bottomColor: alpha(Theme.pal.line, 0.02) }); }
      if (labChart) labChart.applyOptions(opt);
      if (st.idea) renderIdea();
    });
    addEventListener('resize', () => { Fx.seg($('riskSeg'), st.profile); Fx.seg($('tfSeg'), st.tf); Fx.seg($('dockTabs'), st.dock); segTicket(); });
  }

  // ---------- title bar: risk profile ----------
  function buildRisk() {
    $('riskSeg').querySelectorAll('button').forEach((b) => {
      const p = st.catalog.profiles[b.dataset.v];
      b.title = p.name + ': ' + p.tagline + ' (' + p.riskPct + '% risk per trade, daily loss limit ' + p.dailyLossPct + '%)';
      b.dataset.sound = 'toggle';
      b.addEventListener('click', () => setProfile(b.dataset.v));
    });
  }
  async function setProfile(id) {
    if (id === st.profile) return;
    st.profile = id;
    Fx.seg($('riskSeg'), id);
    try { await Api.call('setProfile', { profile: id }); } catch (e) { /* ignore */ }
    const p = st.catalog.profiles[id];
    Fx.toast({ title: p.name + ' risk profile', body: p.riskPct + '% risk per trade, max ' + p.maxPositions + ' open trades, daily loss limit ' + p.dailyLossPct + '%.', icon: 'shield' });
    $('tRisk').value = p.riskPct;
    refreshIdea(true);
    updatePreview();
    if (st.dock === 'lab') loadLab();
  }

  // ---------- watchlist ----------
  function buildMarketTabs() {
    const box = $('marketTabs');
    box.innerHTML = st.catalog.markets.map((m) => '<button data-m="' + m.id + '" data-sound="tab">' + Icons.ico(MARKET_ICON[m.id]) + '<span>' + esc(m.name.replace(' & ETFs', '')) + '</span></button>').join('');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      st.market = b.dataset.m; setPref('market', st.market); renderWatchlist(); refreshQuotes();
    }));
  }
  function renderWatchlist() {
    document.querySelectorAll('#marketTabs button').forEach((b) => b.classList.toggle('active', b.dataset.m === st.market));
    const m = st.catalog.markets.find((x) => x.id === st.market);
    $('marketBlurb').textContent = m ? m.blurb : '';
    const list = st.catalog.instruments.filter((i) => i.market === st.market);
    $('watchList').innerHTML = list.map((i, k) => {
      const q = st.quotes[i.symbol];
      return '<div class="w-row' + (i.symbol === st.symbol ? ' active' : '') + '" data-sym="' + i.symbol + '" style="animation-delay:' + (k * 30) + 'ms">' +
        '<div><div class="w-sym">' + esc(i.symbol) + '<span class="w-dot ' + (q ? q.status : '') + '"></span></div><div class="w-name">' + esc(i.name) + '</div></div>' +
        '<div class="sp">' + (q && q.spark ? Fx.sparkline(q.spark, q.changePct >= 0) : '<div class="skeleton" style="width:54px;height:14px"></div>') + '</div>' +
        '<div class="w-px"><div class="p num">' + (q && q.price != null ? px(i.symbol, q.price) : '<span class="skeleton" style="display:inline-block;width:52px;height:12px"></span>') + '</div><div class="c num ' + (q ? cls(q.changePct) : '') + '">' + (q && q.changePct != null ? pct(q.changePct) : '') + '</div></div>' +
        '</div>';
    }).join('');
    $('watchList').querySelectorAll('.w-row').forEach((r) => {
      r.addEventListener('click', () => selectSymbol(r.dataset.sym, st.tf));
      r.addEventListener('mouseenter', () => Sound.play('hover'));
    });
  }
  async function refreshQuotes() {
    const syms = st.catalog.instruments.filter((i) => i.market === st.market).map((i) => i.symbol);
    if (!syms.includes(st.symbol)) syms.push(st.symbol);
    let qs;
    try { qs = await Api.call('quotes', { symbols: syms }); } catch (e) { return; }
    let missing = false;
    const prevs = {};
    for (const q of qs) {
      if (q.error) continue;
      prevs[q.symbol] = st.quotes[q.symbol];
      if (!prevs[q.symbol]) missing = true;
      st.quotes[q.symbol] = q;
    }
    if (missing) { renderWatchlist(); updateHeaderChange(); return; }
    for (const q of qs) {
      if (q.error) continue;
      const prev = prevs[q.symbol];
      const row = document.querySelector('.w-row[data-sym="' + CSS.escape(q.symbol) + '"]');
      if (!row || !prev) continue;
      const p = row.querySelector('.p');
      p.textContent = px(q.symbol, q.price);
      if (prev.price !== q.price) Fx.flash(p, q.price > prev.price ? 1 : -1);
      const c = row.querySelector('.c');
      c.textContent = pct(q.changePct); c.className = 'c num ' + cls(q.changePct);
      row.querySelector('.sp').innerHTML = Fx.sparkline(q.spark, q.changePct >= 0);
      row.querySelector('.w-dot').className = 'w-dot ' + q.status;
    }
    updateHeaderChange();
  }

  // ---------- symbol + timeframe ----------
  function buildTfSeg() {
    const seg = $('tfSeg');
    seg.innerHTML = '<span class="seg-ind"></span>' + st.catalog.timeframes.map((t) => '<button data-v="' + t + '" data-sound="toggle" title="' + t + ' candles (key ' + (st.catalog.timeframes.indexOf(t) + 1) + ')">' + TF_LABEL[t] + '</button>').join('');
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => selectSymbol(st.symbol, b.dataset.v)));
  }

  async function selectSymbol(sym, tf, first) {
    const changed = sym !== st.symbol || tf !== st.tf || first;
    if (!changed) return;
    if (!first) { try { window.dispatchEvent(new CustomEvent('pd:symbol', { detail: { symbol: sym, tf } })); } catch (e) { /* ignore */ } }
    if (window.Lesson && Lesson.isOpen()) Lesson.close(true);
    if (st.prefer && (st.prefer.symbol !== sym || st.prefer.tf !== tf)) st.prefer = null;
    st.symbol = sym; st.tf = tf; setPref('symbol', sym); setPref('tf', tf);
    const inst = st.inst[sym];
    if (inst.market !== st.market) { st.market = inst.market; setPref('market', st.market); renderWatchlist(); refreshQuotes(); }
    document.querySelectorAll('.w-row').forEach((r) => r.classList.toggle('active', r.dataset.sym === sym));
    Fx.seg($('tfSeg'), tf);
    $('symTitle').textContent = sym;
    $('symName').textContent = inst.name;
    $('qtyUnit').textContent = inst.unit;
    $('chartError').hidden = true;
    $('chartLoading').classList.remove('hide');
    st.idea = null; st.ideaFor = null; st.ticketDirty = false; renderIdeaLoading();
    PriceChart.focusTrade(null);
    const token = ++st.loadToken;
    try {
      const res = await Api.call('candles', { symbol: sym, tf, limit: 1500 });
      if (token !== st.loadToken) return;
      PriceChart.setData(res, { decimals: inst.decimals, tfSec: TF_SEC[tf] });
      applyStatus(res.status);
      setBigPrice(res.bars.length ? res.bars[res.bars.length - 1].close : null, true);
      $('chartLoading').classList.add('hide');
      drawTrades();
      fillTicketDefaults(true);
    } catch (e) {
      if (token !== st.loadToken) return;
      $('chartLoading').classList.add('hide');
      $('chartError').hidden = false;
      $('chartError').innerHTML = '<b>Could not load ' + esc(sym) + ' ' + esc(tf) + '</b><br>' + esc(e.message) + '<br><small>Check your internet connection. Retrying automatically…</small>';
      setTimeout(() => { if (token === st.loadToken) selectSymbol(sym, tf, true); }, 8000);
      return;
    }
    refreshIdea(true);
    if (st.dock === 'lab') loadLab();
  }

  function applyStatus(s) {
    st.status = s;
    const pill = $('statusPill');
    pill.className = 'status-pill ' + (s ? s.state : '');
    let txt = 'LIVE';
    if (s && s.state === 'delayed') txt = 'DELAYED ' + Math.round(s.delayedSec / 60) + ' MIN';
    if (s && s.state === 'closed') txt = 'CLOSED' + (s.opensInSec ? ' · OPENS IN ' + dur(s.opensInSec).toUpperCase() : '');
    pill.querySelector('span').textContent = txt;
  }

  function setBigPrice(p, instant) {
    if (p == null) return;
    const el = $('bigPrice');
    const prev = st.lastPrice;
    st.lastPrice = p;
    el.textContent = px(st.symbol, p);
    if (!instant && prev != null && prev !== p) {
      el.style.color = p > prev ? Theme.pal.upText : Theme.pal.downText;
      Fx.flash(el, p > prev ? 1 : -1);
      clearTimeout(setBigPrice.t);
      setBigPrice.t = setTimeout(() => { el.style.color = ''; }, 500);
    }
    updateHeaderChange();
  }
  function updateHeaderChange() {
    const q = st.quotes[st.symbol];
    const b = $('bigChg');
    if (!q || q.changePct == null) { b.textContent = ''; b.className = 'chg-badge num'; return; }
    b.textContent = pct(q.changePct) + ' today';
    b.className = 'chg-badge num ' + (q.changePct >= 0 ? 'up' : 'down');
  }

  // live candle polling
  async function liveLoop() {
    const sym = st.symbol; const tf = st.tf;
    let delay = 4000;
    try {
      if (st.inst[sym]) {
        const res = await Api.call('candles', { symbol: sym, tf, limit: 3 });
        if (sym === st.symbol && tf === st.tf) {
          const ev = PriceChart.update(res);
          applyStatus(res.status);
          if (res.bars.length) setBigPrice(res.bars[res.bars.length - 1].close);
          if (ev === 'newbar' && Date.now() - st.lastIdeaAt > 20000) refreshIdea();
          if (!$('ticketPreview').dataset.busy) updatePreviewSoon(1500);
        }
        const inst = st.inst[sym];
        delay = res.status && res.status.state === 'closed' ? 20000 : inst.provider === 'coinbase' ? 2000 : 3500;
      }
    } catch (e) { delay = 6000; }
    setTimeout(liveLoop, delay);
  }

  // ---------- trade idea ----------
  function renderIdeaLoading() {
    $('ideaBody').innerHTML = '<div style="display:grid;gap:10px;padding-top:4px"><div style="display:flex;gap:12px;align-items:center"><div class="skeleton" style="width:54px;height:54px;border-radius:50%"></div><div style="flex:1;display:grid;gap:6px"><div class="skeleton" style="height:14px;width:80%"></div><div class="skeleton" style="height:10px;width:50%"></div></div></div><div class="skeleton" style="height:52px"></div><div class="skeleton" style="height:60px"></div><div class="exec-sub">Backtesting every strategy on ' + esc(st.symbol) + ' ' + esc(st.tf) + '…</div></div>';
  }

  // Cost checker on the idea card: round-trip cost, and the same exposure through another wrapper.
  function rFmt(r) { return r < 0.01 ? 'under 0.01R' : r.toFixed(2) + 'R'; }
  function costBlock(i, res) {
    const c = i.cost; if (!c) return '';
    const rows = [];
    if (i.qty) rows.push('<li><b>' + esc(res.symbol) + ' (this chart)</b><span class="num">' + money(c.usd) + ' · ' + c.bp.toFixed(1) + ' bp</span></li>');
    (c.alts || []).forEach((a) => rows.push('<li' + (a.fits ? '' : ' class="dim"') + '><b>' + esc(a.symbol) + ' <small>' + esc(a.name) + '</small></b><span class="num">' + (a.fits ? money(a.usd) + ' · ' + a.bp.toFixed(1) + ' bp · ' + a.qty + ' ' + esc(a.unit) : a.bp.toFixed(1) + ' bp') + '</span>' + (a.note ? '<small>' + esc(a.note) + '</small>' : '') + '</li>'));
    if (c.cfd) rows.push('<li><b>Index CFD <small>at a prop firm</small></b><span class="num">about ' + money(c.cfd.usd) + ' · ' + c.cfd.bp.toFixed(0) + ' bp</span><small>' + c.cfd.spreadBp + ' bp spread' + (c.cfd.short ? ', and financing is about zero for shorts at today\'s rates' : ' plus about ' + c.cfd.financeBp.toFixed(0) + ' bp of overnight financing for ' + c.cfd.nights + ' nights') + ' (research section 1.8).</small></li>');
    const head = i.qty
      ? 'Costs <b class="num">' + money(c.usd) + '</b> round trip <span class="muted-t">· ' + c.bp.toFixed(1) + ' bp · ' + (c.R != null ? rFmt(c.R) : '') + '</span>'
      : 'Can\'t size it here' + (c.instead ? ': trade ' + esc(c.instead.symbol) + ' instead' : '');
    const flag = c.cheaper ? '<span class="cost-flag">Cheaper via ' + esc(c.cheaper.symbol) + '</span>' : (c.R != null && c.R > 0.15 ? '<span class="cost-flag warn">Costly</span>' : '');
    return '<details class="cost-box' + (c.instead || c.cheaper ? ' hot' : '') + '"' + (c.instead ? ' open' : '') + '><summary>' + Icons.ico('target') + '<span>' + head + '</span>' + flag + '</summary>' +
      '<p>Spread and slippage plus fees, in and out, with the same cost model the paper fills use.</p><ul class="cost-alts">' + rows.join('') + '</ul>' +
      (c.tip ? '<p class="cost-tip">' + esc(c.tip) + '</p>' : '') +
      (c.instead ? '<button class="ghost-btn cost-instead" data-sym="' + esc(c.instead.symbol) + '" data-sound="none">Open the same trade on ' + esc(c.instead.symbol) + '</button>' : '') + '</details>';
  }

  async function refreshIdea(force) {
    if (st.ideaBusy && !force) return;
    st.ideaBusy = true;
    st.lastIdeaAt = Date.now();
    $('ideaRefreshBtn').classList.add('spin');
    const sym = st.symbol; const tf = st.tf; const profile = st.profile;
    try {
      const prefer = st.prefer && st.prefer.symbol === sym && st.prefer.tf === tf ? st.prefer : null;
      const res = await Api.call('suggest', { symbol: sym, tf, profile, prefer, signals: st.sigOn });
      if (sym !== st.symbol || tf !== st.tf) return;
      const prevKey = st.idea && st.idea.idea ? st.idea.idea.headline + st.idea.idea.entry : null;
      const firstForChart = st.ideaFor !== sym + tf;
      st.idea = res; st.ideaFor = sym + tf;
      renderIdea(prevKey);
      if (firstForChart && !st.ticketDirty) fillTicketDefaults(true);
      drawTrades();
    } catch (e) {
      if (sym === st.symbol) $('ideaBody').innerHTML = '<div class="idea-empty">' + Icons.ico('alert') + ' Could not scan ' + esc(sym) + ': ' + esc(e.message) + '</div>';
    } finally {
      st.ideaBusy = false;
      $('ideaRefreshBtn').classList.remove('spin');
    }
  }

  function gradeRing(score, grade) {
    const r = 23; const c = 2 * Math.PI * r;
    const col = grade === 'A' ? 'var(--up)' : grade === 'B' ? 'var(--a2)' : grade === 'C' ? 'var(--warn)' : 'var(--down)';
    return '<div class="grade" title="Setup score ' + score + '/100"><svg viewBox="0 0 54 54"><circle class="track" cx="27" cy="27" r="' + r + '"/><circle class="bar" cx="27" cy="27" r="' + r + '" style="stroke:' + col + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + c.toFixed(1) + '" data-off="' + (c * (1 - score / 100)).toFixed(1) + '"/></svg><b style="color:' + col + '">' + grade + '</b><small>' + score + '/100</small></div>';
  }

  function renderIdea(prevKey) {
    const res = st.idea;
    const body = $('ideaBody');
    const i = res && res.idea;
    if (!i) {
      body.innerHTML = '<div class="idea-empty">' + Icons.ico('clock') + ' ' + esc(res ? res.message : 'No idea yet.') + '</div>' + checkedList(res);
      Icons.hydrate(body);
      return;
    }
    const sideTxt = i.side === 'buy' ? 'BUY' : 'SELL';
    const typeTxt = i.entryType === 'market' ? 'at market' : i.entryType === 'limit' ? 'limit order' : 'stop order (on breakout)';
    const v = i.verdict || { level: 'caution', title: 'Take with care', line: '', bad: [], warn: [], good: [] };
    const skipKey = ideaKey(res);
    if (st.skipped === skipKey) { renderSkipped(res, v); return; }
    const isSkip = v.level === 'skip';
    const free = !!(st.account && st.account.beast); // the secret code: no "are you sure" step
    const li = (icon, txt, c) => '<li' + (c ? ' class="' + c + '"' : '') + '>' + Icons.ico(icon) + '<span>' + txt + '</span></li>';
    const extra = i.reasons.slice(1).map((r) => li('info', esc(r))).join('') + (i.warnings || []).map((r) => li('alert', esc(r), 'warn')).join('') +
      li('book', '<b>Evidence:</b> ' + esc(i.strategy.evidence) + ' <i style="color:var(--muted)">' + esc(i.strategy.caveat) + '</i>') +
      li('lab', '<b>Rules:</b> ' + i.strategy.rules.map(esc).join(' '));
    const risk = i.riskUsd || 0;
    const rew = i.rewardUsd;
    const total = rew ? risk + rew : risk;
    const rrBar = rew
      ? '<div class="rr-bar"><div class="risk" style="width:' + (risk / total * 100).toFixed(1) + '%"></div><div class="rew" style="flex:1"></div></div><div class="rr-cap num"><span class="down-t">Risk ' + money(risk, 0) + '</span><span>1 : ' + (i.rr || 0).toFixed(1) + '</span><span class="up-t">Reward ' + money(rew, 0) + '</span></div>'
      : '<div class="rr-bar"><div class="risk" style="width:30%"></div><div class="rew" style="flex:1;opacity:.45"></div></div><div class="rr-cap num"><span class="down-t">Risk ' + money(risk, 0) + '</span><span>Open-ended</span><span class="up-t">Trailing exit</span></div>';
    const execLabel = (i.pending ? 'Place ' + (i.entryType === 'limit' ? 'limit' : 'stop') + ' order: ' : 'Execute: ') + sideTxt + ' ' + qtyFmt(res.symbol, i.qty) + ' ' + res.symbol;
    const hasLesson = !!(i.lesson && i.lesson.steps && i.lesson.steps.length);
    const teach = hasLesson ? '<button class="teach-btn" id="teachBtn" data-sound="none" title="A step-by-step lesson on the chart: why this trade, where to get in and out, and how big (key W)"><span class="ico" data-icon="book"></span><span class="tb-t">' + (isSkip ? 'Walk me through why to skip it' : 'Walk me through this trade') + '</span><small>' + i.lesson.steps.length + ' steps</small></button>' : '';
    const actions = isSkip
      ? '<div class="skip-actions"><button class="skip-btn" id="skipBtn" data-sound="none"><span class="ico" data-icon="check"></span><span>Skip this trade</span><small>recommended</small></button>' +
        '<button class="anyway-btn" id="execBtn" data-sound="none"' + (i.qty ? '' : ' disabled') + ' title="Asks you to confirm first">Place anyway…</button></div>'
      : '<button class="primary-btn ' + (i.side === 'buy' ? 'buy' : 'sell') + '" id="execBtn" data-sound="none"' + (i.qty ? '' : ' disabled') + '><span>' + esc(execLabel) + '</span></button>';
    body.innerHTML =
      verdictBanner(v) +
      '<div class="idea-top' + (isSkip ? ' dim' : '') + '">' + gradeRing(i.score, i.grade) +
      '<div class="idea-head"><h3>' + esc(i.headline) + '</h3><div class="sub"><span class="side-tag ' + (i.side === 'buy' ? 'long' : 'short') + '">' + sideTxt + '</span><span>' + esc(typeTxt) + '</span><span>·</span><span>' + esc(i.strategy.style) + '</span>' + (i.research ? vpill(i.research.verdict, 'Research: ', i.research.text) : '') + '</div></div></div>' +
      '<div class="idea-levels num"><div class="lvl"><div class="k">Entry</div><div class="v">' + px(res.symbol, i.entry) + '</div></div><div class="lvl stop"><div class="k">Stop</div><div class="v">' + px(res.symbol, i.stop) + '</div></div><div class="lvl tgt"><div class="k">Target</div><div class="v">' + (i.target != null ? px(res.symbol, i.target) : 'Trailing') + '</div></div></div>' +
      rrBar +
      '<div class="size-line num"><span>Size</span><b>' + (i.qty ? qtyFmt(res.symbol, i.qty) + ' ' + esc(st.inst[res.symbol].unit) + ' · ' + money(i.notional, 0) : esc(i.sizingNote || 'Too small to size')) + '</b></div>' +
      costBlock(i, res) +
      teach + actions +
      '<div class="exec-sub">' + (isSkip && !free ? 'Skipping is the app\'s pick here · placing it anyway asks you to confirm' : 'Paper trade against the live price · ' + (!free && st.status && st.status.state === 'closed' && i.entryType === 'market' ? 'market is closed, so this can\'t fill until it opens' : 'stops and targets are watched for you') + ' · E') + '</div>' +
      whyPanel(i, v, hasLesson) +
      '<details class="more"><summary>Exit plan, evidence and rules</summary><div class="lab-note" style="margin:0 0 8px">' + Icons.ico('target') + ' ' + esc(i.exitPlan) + '</div><ul class="reasons">' + extra + '</ul>' +
      (res.alternatives && res.alternatives.length ? '<div class="alt-list">' + res.alternatives.map((a) => '<span class="alt">' + esc(a.strategy) + ' · ' + (a.side === 'buy' ? 'buy' : 'sell') + ' · ' + a.grade + '</span>').join('') + '</div>' : '') +
      '</details>';
    Icons.hydrate(body);
    requestAnimationFrame(() => {
      const bar = body.querySelector('.grade .bar');
      if (bar) bar.style.strokeDashoffset = bar.dataset.off;
    });
    $('execBtn').addEventListener('click', executeIdea);
    const ib = body.querySelector('.cost-instead');
    if (ib) ib.addEventListener('click', () => { Sound.play('select'); showTopTrade({ symbol: ib.dataset.sym, tf: res.tf || st.tf, strategy: { id: i.strategy.id }, side: i.side, pending: !!i.pending }); });
    if ($('teachBtn')) $('teachBtn').addEventListener('click', () => startLesson());
    if ($('skipBtn')) $('skipBtn').addEventListener('click', () => skipIdea(res));
    const wp = body.querySelector('.why-panel');
    if (wp) wp.addEventListener('toggle', () => { setPref('whyOpen', wp.open); Sound.play('toggle'); });
    body.querySelectorAll('.wc.go').forEach((el) => {
      const go = () => startLesson(Number(el.dataset.step));
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    requestAnimationFrame(() => { const vb = body.querySelector('.verdict'); if (vb) vb.classList.add('in'); });
    const key = i.headline + i.entry;
    if (prevKey && prevKey !== key && !i.pending) { Sound.play('notify'); }
  }

  function ideaKey(res) { const i = res && res.idea; return i ? res.symbol + '|' + res.tf + '|' + i.headline + '|' + i.entry : ''; }

  function verdictBanner(v) {
    const icon = v.level === 'skip' ? 'stop' : v.level === 'caution' ? 'alert' : 'check';
    const tally = (v.bad.length ? '<span class="t-bad" title="Checks against it">' + Icons.svg('x') + v.bad.length + '</span>' : '') +
      (v.warn.length ? '<span class="t-warn" title="Things to watch">' + Icons.svg('alert') + v.warn.length + '</span>' : '') +
      (v.good.length ? '<span class="t-good" title="Checks in favour">' + Icons.svg('check') + v.good.length + '</span>' : '');
    return '<div class="verdict v-' + v.level + '" role="status"><div class="v-ico"><i></i>' + Icons.svg(icon) + '</div>' +
      '<div class="v-main"><div class="v-title">' + esc(v.title) + '</div><div class="v-line">' + esc(v.line) + '</div></div>' +
      '<div class="v-tally num">' + tally + '</div></div>';
  }

  // "Why this trade": the rule's conditions with today's values, then the evidence for and against.
  // Each line opens the walkthrough at the step that shows it on the chart.
  function whyPanel(i, v, hasLesson) {
    const so = (i.lesson && i.lesson.stepOf) || {};
    const stepOfK = { research: so.record, backtest: so.record, trend: so.record, cost: so.record, grade: so.record, size: so.size, late: so.entry != null ? so.entry : so.record };
    const used = new Set();
    const g = (t) => (window.Gloss ? Gloss.wrap(esc(t), used) : esc(t));
    const row = (state, label, value, step) => {
      const go = hasLesson && step != null;
      const icon = { ok: 'check', no: 'x', warn: 'alert', wait: 'clock' }[state];
      return '<li class="wc ' + state + (go ? ' go" data-step="' + step + '" tabindex="0" role="button" title="Show this on the chart' : '') + '">' +
        '<span class="wc-i">' + Icons.svg(icon) + '</span><span class="wc-l">' + g(label) +
        (value ? '<b class="wc-v num">' + esc(value) + '</b>' : '') + '</span>' + (go ? '<span class="wc-go">' + Icons.svg('chev') + '</span>' : '') + '</li>';
    };
    const rules = ((i.lesson && i.lesson.checks) || []).map((c) => row(c.ok === true ? 'ok' : c.ok === false ? 'no' : 'wait', c.label, c.value, c.step)).join('');
    const ev = v.bad.map((x) => row('no', x.text, '', stepOfK[x.k])).join('') + v.warn.map((x) => row('warn', x.text, '', stepOfK[x.k])).join('') + v.good.map((x) => row('ok', x.text, '', stepOfK[x.k])).join('');
    const tally = (v.bad.length ? '<span class="t-bad">' + Icons.svg('x') + v.bad.length + '</span>' : '') + (v.warn.length ? '<span class="t-warn">' + Icons.svg('alert') + v.warn.length + '</span>' : '') + (v.good.length ? '<span class="t-good">' + Icons.svg('check') + v.good.length + '</span>' : '');
    // Folded by default so the levels and the main button stay on screen; it remembers if you open it.
    return '<details class="why-panel"' + (pref('whyOpen', false) ? ' open' : '') + '><summary class="why-h"><b>Why ' + (v.level === 'skip' ? 'it is a skip' : 'this trade') + '</b><span class="why-tally num">' + tally + '</span><span class="why-chev">' + Icons.svg('chev') + '</span></summary>' +
      (hasLesson ? '<div class="why-hint">Tap a line to see it on the chart</div>' : '') +
      '<p class="why-lead">' + g(i.reasons[0] || '') + '</p>' +
      (rules ? '<div class="why-sub">The rule</div><ul class="wcl">' + rules + '</ul>' : '') +
      '<div class="why-sub">The evidence</div><ul class="wcl">' + ev + '</ul></details>';
  }

  function skipCount(add) {
    let n = 0;
    try { n = Number(localStorage.getItem('pd.skips')) || 0; if (add) localStorage.setItem('pd.skips', String(n + add)); } catch (e) { /* storage unavailable */ }
    return n + (add || 0);
  }

  function skipIdea(res) {
    st.skipped = ideaKey(res);
    const n = skipCount(1);
    Sound.play('skip');
    Fx.toast({ title: 'Trade skipped', body: 'Sitting out a weak setup keeps your risk for a better one. Setups skipped so far: ' + n + '.', ttl: 5000, icon: 'shield' });
    renderIdea();
  }

  function renderSkipped(res, v) {
    const body = $('ideaBody'); const i = res.idea;
    body.innerHTML = '<div class="skipped-card"><div class="sk-ico">' + Icons.svg('check') + '</div><b>You skipped this one</b>' +
      '<span class="num">' + esc(i.headline) + ' · ' + esc(v.title) + '</span>' +
      '<p>Not trading is a decision too. Skipped setups so far: <b class="num">' + skipCount(0) + '</b>. The app will show the next idea here as soon as there is one.</p>' +
      '<button class="ghost-btn" id="unskipBtn" data-sound="click">Show it again</button></div>';
    Icons.hydrate(body);
    $('unskipBtn').addEventListener('click', () => { st.skipped = null; renderIdea(); });
  }

  function checkedList(res) {
    if (!res || !res.strategiesChecked) return '';
    return '<ul class="reasons">' + res.strategiesChecked.map((s) => '<li>' + Icons.ico('lab') + '<span><b>' + esc(s.name) + '</b>: ' + s.stats.trades + ' past signals, ' + s.stats.winRate.toFixed(0) + '% wins, ' + (s.stats.expectancyR >= 0 ? '+' : '') + s.stats.expectancyR.toFixed(2) + 'R avg</span></li>').join('') + '</ul>';
  }

  async function executeIdea() {
    const res = st.idea; const i = res && res.idea;
    if (!i || !i.qty) return;
    const v = i.verdict;
    const free = !!(st.account && st.account.beast);
    if (v && v.level === 'skip' && !free) {
      const bt0 = i.backtest || {};
      const ans = await Confirm.ask({
        title: 'Place a trade the app says to skip?', kicker: 'Better to skip', side: i.side,
        trade: qtyFmt(res.symbol, i.qty) + ' ' + res.symbol + ' · ' + i.strategy.name + ' · risk ' + money(i.riskUsd || 0, 0),
        stats: [{ k: 'Grade', v: i.grade, tone: i.meetsProfile ? '' : 'down' }, { k: 'Past trades here', v: bt0.trades ? (bt0.expectancyR >= 0 ? '+' : '') + bt0.expectancyR.toFixed(2) + 'R avg' : 'none', tone: bt0.expectancyR > 0 ? 'up' : 'down' }, { k: 'Long-history test', v: i.research ? i.research.label : 'None', tone: i.research ? (i.research.verdict === 'holds' ? 'up' : i.research.verdict === 'fails' ? 'down' : '') : '' }],
        reasons: v.bad.map((x) => ({ tone: 'bad', text: x.text })).concat(v.warn.map((x) => ({ tone: 'warn', text: x.text }))),
        note: 'It is paper money, so practising it is fine. Just know the odds are not on your side here.',
        lesson: !!(i.lesson && i.lesson.steps && i.lesson.steps.length),
      });
      if (ans === 'lesson') { startLesson(i.lesson.stepOf ? i.lesson.stepOf.record : 0); return; }
      if (ans !== 'place') return;
    }
    const btn = $('execBtn');
    btn.classList.add('busy'); btn.disabled = true;
    try {
      const out = await Api.call('placeOrder', {
        symbol: res.symbol, side: i.side, type: i.entryType, price: i.entryType === 'market' ? undefined : i.entry,
        qty: i.qty, stop: i.stop, target: i.target, source: 'suggested', strategy: i.strategy.id, tf: res.tf,
        grade: i.grade, eod: i.eod, managed: i.managed, verdict: v ? v.level : null,
      });
      Sound.play(out.position ? 'execute' : 'placed');
      const r = btn.getBoundingClientRect();
      Fx.confetti(r.left + r.width / 2, r.top, out.position ? 70 : 30);
      showDock(out.position ? 'positions' : 'orders');
      await refreshAccount();
      setTimeout(() => refreshIdea(true), 1500);
    } catch (e) {
      Sound.play('error');
      Fx.toast({ kind: 'error', title: 'Order not placed', body: e.message, ttl: 7000 });
    } finally {
      if (btn.isConnected) { btn.classList.remove('busy'); btn.disabled = false; }
    }
  }

  // ---------- teaching walkthrough ----------
  function startLesson(step) {
    const res = st.idea; const i = res && res.idea;
    if (!i || !i.lesson || res.symbol !== st.symbol || res.tf !== st.tf) return;
    st.lessonOn = true;
    drawTrades();
    Lesson.open(i.lesson, { step: step || 0, onEnd: () => { st.lessonOn = false; drawTrades(); } });
  }

  // ---------- chart trade drawing ----------
  function drawTrades() {
    const a = st.account;
    const pos = a ? a.positions.filter((p) => p.symbol === st.symbol) : [];
    const ord = a ? a.orders.filter((o) => o.symbol === st.symbol) : [];
    const preview = st.preview && !st.lessonOn && st.idea && st.idea.idea && st.idea.symbol === st.symbol ? st.idea.idea : null;
    PriceChart.setTrades(pos, ord, preview);
    const hist = a ? a.history.filter((h) => h.symbol === st.symbol) : [];
    PriceChart.setMarkers(hist.concat(pos), st.lessonOn ? [] : signalTrades());
    renderSigBar();
    $('ideaPreviewBtn').classList.toggle('on', !!st.preview);
  }

  // ---------- chart signals: BUY / SELL markers from a strategy's past trades ----------
  const VERDICT_RANK = { holds: 3, mixed: 2, fails: 0 };
  function sigList() {
    const r = st.idea;
    return st.sigOn && r && r.symbol === st.symbol && r.tf === st.tf && r.signals && r.signals.length ? r.signals : null;
  }
  // The strategy behind today's idea, else the one our research and its record rate best here.
  function sigAuto(list) {
    const ideaId = st.idea && st.idea.idea && st.idea.idea.strategy ? st.idea.idea.strategy.id : null;
    const fromIdea = ideaId && list.find((x) => x.id === ideaId);
    if (fromIdea) return fromIdea;
    const score = (x) => (x.verdict ? VERDICT_RANK[x.verdict] : 1) * 10 + (x.stats.trades >= 5 ? Math.max(-5, Math.min(5, x.stats.expectancyR * 10)) : -6);
    return list.slice().sort((a, b) => score(b) - score(a))[0];
  }
  function sigPick(list) {
    return (st.sigStrat !== 'auto' && list.find((x) => x.id === st.sigStrat)) || sigAuto(list);
  }
  function signalTrades() {
    const list = sigList();
    if (!list) return [];
    const x = sigPick(list);
    return x.trades.concat(x.open ? [Object.assign({ open: true }, x.open)] : []);
  }
  let sigBarKey = '';
  function renderSigBar() {
    const bar = $('sigBar');
    const list = st.lessonOn ? null : sigList();
    if (!list) { bar.hidden = true; sigBarKey = ''; return; }
    const auto = sigAuto(list); const x = sigPick(list);
    const key = st.symbol + st.tf + st.idea.generatedAt + st.sigStrat + x.id;
    if (key === sigBarKey && !bar.hidden) return;
    sigBarKey = key;
    const t = x.stats;
    const stat = t.trades ? t.trades + ' past trades · ' + t.winRate.toFixed(0) + '% won · ' + (t.expectancyR >= 0 ? '+' : '') + t.expectancyR.toFixed(2) + 'R avg' : 'No past trades on this chart';
    const now = x.open ? ' · in a ' + (x.open.dir > 0 ? 'buy' : 'short') + ' now' : '';
    const vt = { holds: 'Research: held up', mixed: 'Research: mixed', fails: 'Research: failed' };
    const opts = '<option value="auto"' + (st.sigStrat === 'auto' ? ' selected' : '') + '>Best match: ' + esc(auto.name) + '</option>' +
      list.map((y) => '<option value="' + esc(y.id) + '"' + (st.sigStrat === y.id ? ' selected' : '') + '>' + esc(y.name) + '</option>').join('');
    bar.innerHTML = '<span class="sig-ar" aria-hidden="true"><b class="b">▲</b><b class="s">▼</b></span>' +
      '<label class="sig-pick" title="Which strategy\'s buy and sell points to show"><span>' + esc(x.name) + '</span><i>▼</i><select aria-label="Strategy for chart signals">' + opts + '</select></label>' +
      '<span class="sig-st num">' + stat + now + '</span>' + (x.verdict ? '<span class="sig-v ' + x.verdict + '">' + vt[x.verdict] + '</span>' : '');
    bar.title = 'BUY and SELL arrows mark where ' + x.name + ' bought and sold on these candles, after fees and slippage. SHORT and COVER are its sell-first trades. They show how it behaved in the past, not what happens next.';
    bar.hidden = false;
    bar.querySelector('select').addEventListener('change', (e) => {
      st.sigStrat = e.target.value; setPref('sigStrat', st.sigStrat);
      if (window.Sound) try { Sound.play('toggle'); } catch (err) { /* ignore */ }
      drawTrades();
    });
  }

  // ---------- account ----------
  let accountSig = '';
  async function refreshAccount() {
    let a;
    try { a = await Api.call('account'); } catch (e) { return; }
    st.account = a;
    renderChallenge(a.challenge);
    Fx.tweenNumber($('equityVal'), a.equity, (v) => money(v));
    const d = $('dayPnlVal');
    d.textContent = smoney(a.dayPnl) + ' today';
    d.className = 'chg num ' + cls(a.dayPnl);
    const pc = $('posCount'); const oc = $('ordCount');
    if (pc.textContent !== String(a.positions.length)) { pc.textContent = a.positions.length; pc.classList.toggle('hot', a.positions.length > 0); }
    if (oc.textContent !== String(a.orders.length)) { oc.textContent = a.orders.length; oc.classList.toggle('hot', a.orders.length > 0); }
    const sig = a.positions.map((p) => p.id + ':' + p.stop + ':' + p.target).join(',') + '|' + a.orders.map((o) => o.id).join(',') + '|' + a.history.length + ':' + (a.history[0] ? a.history[0].id : '') + '|' + (a.mistakes ? a.mistakes.early.trades + ':' + a.mistakes.early.tracking : '');
    const structural = sig !== accountSig;
    accountSig = sig;
    renderPositions(structural);
    if (structural) {
      renderOrders(); renderHistory();
      if (st.dock === 'performance') renderPerformance();
    }
    drawTrades();
    if (a.locked && !refreshAccount.lockedShown) {
      refreshAccount.lockedShown = true;
      Fx.toast({ kind: 'error', title: 'Trading paused', body: a.locked, ttl: 9000, icon: 'shield' });
    }
    if (!a.locked) refreshAccount.lockedShown = false;
  }

  function progressCell(p) {
    if (p.stop == null || p.target == null) {
      return p.stop != null ? '<span class="lab-note" style="margin:0">Trailing · stop ' + px(p.symbol, p.stop) + '</span>' : '<span class="lab-note" style="margin:0">No stop</span>';
    }
    const span = p.target - p.stop;
    const ent = Math.max(0, Math.min(100, (p.entry - p.stop) / span * 100));
    const pos = Math.max(0, Math.min(100, ((p.markPx != null ? p.markPx : p.lastPrice || p.entry) - p.stop) / span * 100));
    return '<div class="progress" style="--entry:' + ent.toFixed(1) + '%;--pos:' + pos.toFixed(1) + '%" title="Where price is between your stop (left) and target (right)"><em></em><i></i></div>';
  }

  function renderPositions(structural) {
    const a = st.account; const pane = $('positionsPane');
    if (!a.positions.length) {
      pane.innerHTML = '<div class="empty">' + Icons.ico('bolt') + '<b>No open trades</b><span>Hit Execute on a trade idea, or place your own trade on the right.</span></div>';
      Icons.hydrate(pane); return;
    }
    if (structural || !pane.querySelector('table')) {
      pane.innerHTML = '<table class="grid num"><thead><tr><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Last</th><th class="r">Stop</th><th class="r">Target</th><th>Stop → Target</th><th class="r">P&amp;L</th><th>Source</th><th></th></tr></thead><tbody>' +
        a.positions.map((p) => '<tr data-id="' + p.id + '"><td><b>' + esc(p.symbol) + '</b><span class="sell-sig"></span></td><td><span class="side-tag ' + p.side + '">' + p.side.toUpperCase() + '</span></td><td class="r">' + qtyFmt(p.symbol, p.qty) + '</td><td class="r">' + px(p.symbol, p.entry) + '</td><td class="r last"></td><td class="r stop">' + px(p.symbol, p.stop) + '</td><td class="r tgt">' + (p.target != null ? px(p.symbol, p.target) : '-') + '</td><td class="prog"></td><td class="r pnl"></td><td>' + (p.source === 'suggested' ? '<span class="src-tag" title="' + esc(p.strategy) + '">' + esc(stratName(p.strategy)) + (p.grade ? ' · ' + p.grade : '') + '</span>' : '<span class="src-tag manual">Manual</span>') + '</td><td class="r"><button class="row-btn edit" data-act="edit">Edit</button> <button class="row-btn" data-act="close" data-sound="none">Close</button></td></tr>').join('') + '</tbody></table>';
      pane.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
        const id = Number(b.closest('tr').dataset.id);
        if (b.dataset.act === 'close') closePosition(id, b); else editPosition(id, b.closest('tr'));
      }));
    }
    for (const p of a.positions) {
      const tr = pane.querySelector('tr[data-id="' + p.id + '"]');
      if (!tr) continue;
      const last = tr.querySelector('.last');
      const newLast = px(p.symbol, p.lastPrice);
      if (last.textContent && last.textContent !== newLast) Fx.flash(last, (p.lastPrice > Number(last.dataset.v)) ? 1 : -1);
      last.textContent = newLast; last.dataset.v = p.lastPrice;
      tr.querySelector('.prog').innerHTML = progressCell(p);
      const sg = tr.querySelector('.sell-sig');
      if (sg) {
        const due = p.sellDue; const signs = p.sellSigns || [];
        sg.className = 'sell-sig' + (due ? ' due' : signs.length ? ' shaky' : '');
        sg.textContent = due ? 'Sell signal' : signs.length ? 'Shaky' : '';
        sg.title = due ? due.text : signs.length ? signs.map((x) => x.name + ': ' + x.text).join('\n') + '\n\nA heads-up, not a rule: in testing, selling on these signs did not beat holding to the plan.' : '';
      }
      tr.querySelector('.pnl').innerHTML = '<span class="' + cls(p.upnl) + '">' + smoney(p.upnl) + '</span>' + (p.upnlR != null ? ' <small style="color:var(--muted)">' + (p.upnlR >= 0 ? '+' : '') + p.upnlR.toFixed(2) + 'R</small>' : '');
    }
  }
  function stratName(id) {
    const s = st.catalog.strategies.find((x) => x.id === id);
    return s ? s.name : 'Idea';
  }
  // the P&L the positions panel is showing for a trade right now
  function shownPnl(id) { const p = st.account && st.account.positions.find((x) => x.id === Number(id)); return p ? p.upnl : undefined; }
  async function closePosition(id, btn) {
    btn.disabled = true;
    try { await Api.call('closePosition', { id, shown: shownPnl(id) }); await refreshAccount(); } catch (e) { Sound.play('error'); Fx.toast({ kind: 'error', title: 'Could not close', body: e.message }); btn.disabled = false; }
  }
  function editPosition(id, tr) {
    const p = st.account.positions.find((x) => x.id === id);
    if (!p) return;
    tr.querySelector('.stop').innerHTML = '<span class="input-wrap edit-inline"><input type="number" step="any" value="' + (p.stop != null ? p.stop : '') + '" data-f="stop"></span>';
    tr.querySelector('.tgt').innerHTML = '<span class="input-wrap edit-inline"><input type="number" step="any" value="' + (p.target != null ? p.target : '') + '" data-f="target"></span>';
    const btn = tr.querySelector('[data-act="edit"]');
    btn.textContent = 'Save';
    btn.dataset.act = 'save';
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener('click', async () => {
      const stop = tr.querySelector('[data-f="stop"]').value;
      const target = tr.querySelector('[data-f="target"]').value;
      try {
        await Api.call('modifyPosition', { id, stop: stop === '' ? null : Number(stop), target: target === '' ? null : Number(target) });
        Sound.play('placed'); Fx.toast({ title: 'Updated ' + p.symbol, body: 'Stop ' + (stop || 'none') + ' · Target ' + (target || 'none') });
        accountSig = ''; refreshAccount();
      } catch (e) { Sound.play('error'); Fx.toast({ kind: 'error', title: 'Not updated', body: e.message }); }
    });
  }

  function renderOrders() {
    const a = st.account; const pane = $('ordersPane');
    if (!a.orders.length) { pane.innerHTML = '<div class="empty">' + Icons.ico('clock') + '<b>No working orders</b><span>Limit and stop orders wait here until price reaches them.</span></div>'; Icons.hydrate(pane); return; }
    pane.innerHTML = '<table class="grid num"><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Stop</th><th class="r">Target</th><th>Placed</th><th>Source</th><th></th></tr></thead><tbody>' +
      a.orders.map((o) => '<tr data-id="' + o.id + '"><td><b>' + esc(o.symbol) + '</b></td><td><span class="side-tag ' + (o.side === 'buy' ? 'long' : 'short') + '">' + o.side.toUpperCase() + '</span></td><td>' + o.type + '</td><td class="r">' + qtyFmt(o.symbol, o.qty) + '</td><td class="r">' + px(o.symbol, o.price) + '</td><td class="r">' + px(o.symbol, o.stop) + '</td><td class="r">' + (o.target != null ? px(o.symbol, o.target) : '-') + '</td><td>' + timeStr(o.createdAt) + '</td><td>' + (o.source === 'suggested' ? '<span class="src-tag">' + esc(stratName(o.strategy)) + '</span>' : '<span class="src-tag manual">Manual</span>') + '</td><td class="r"><button class="row-btn">Cancel</button></td></tr>').join('') + '</tbody></table>';
    pane.querySelectorAll('.row-btn').forEach((b) => b.addEventListener('click', async () => {
      try { await Api.call('cancelOrder', { id: Number(b.closest('tr').dataset.id) }); refreshAccount(); } catch (e) { Fx.toast({ kind: 'error', title: 'Could not cancel', body: e.message }); }
    }));
  }

  function renderHistory() {
    const a = st.account; const pane = $('historyPane');
    if (!a.history.length) { pane.innerHTML = '<div class="empty">' + Icons.ico('book') + '<b>No closed trades yet</b><span>Every closed paper trade lands here with its result in dollars and R.</span></div>'; Icons.hydrate(pane); return; }
    pane.innerHTML = '<table class="grid num"><thead><tr><th>Closed</th><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Exit</th><th>Exit reason</th><th class="r">P&amp;L</th><th class="r">R</th><th>Source</th><th class="r">Held</th></tr></thead><tbody>' +
      a.history.map((h) => '<tr><td>' + timeStr(h.closedAt) + '</td><td><b>' + esc(h.symbol) + '</b></td><td><span class="side-tag ' + h.side + '">' + h.side.toUpperCase() + '</span></td><td class="r">' + qtyFmt(h.symbol, h.qty) + '</td><td class="r">' + px(h.symbol, h.entry) + '</td><td class="r">' + px(h.symbol, h.exit) + '</td><td>' + esc(h.reason) + '</td><td class="r ' + cls(h.pnl) + '">' + smoney(h.pnl) + '</td><td class="r ' + cls(h.R) + '">' + (h.R != null ? (h.R >= 0 ? '+' : '') + h.R.toFixed(2) : '-') + '</td><td>' + (h.source === 'suggested' ? '<span class="src-tag">' + esc(stratName(h.strategy)) + '</span>' : '<span class="src-tag manual">Manual</span>') + '</td><td class="r">' + dur(h.closedAt - h.openedAt) + '</td></tr>').join('') + '</tbody></table>';
  }

  // ---------- performance ----------
  let perfChart = null; let perfSeries = null;
  function renderPerformance() {
    const a = st.account; const pane = $('performancePane');
    const s = a.stats;
    const tile = (k, v, sub, c) => '<div class="stat"><div class="k">' + k + '</div><div class="v num ' + (c || '') + '">' + v + '</div>' + (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>';
    const cmp = (label, x) => '<div class="stat"><div class="k">' + label + '</div><div class="v num ' + cls(x.netPnl) + '" style="font-size:14px">' + smoney(x.netPnl, 0) + '</div><div class="s">' + x.trades + ' trades · ' + x.winRate.toFixed(0) + '% wins' + (x.avgR != null ? ' · ' + (x.avgR >= 0 ? '+' : '') + x.avgR.toFixed(2) + 'R' : '') + '</div></div>';
    if (!pane.querySelector('.perf')) {
      pane.innerHTML = '<div class="perf"><div><div class="stat-grid" id="perfTiles"></div><div class="vs" id="perfVs"></div></div><div class="mini-chart" id="perfChart"><div class="cap">Account equity</div></div></div><section class="mist" id="perfMistakes"></section>';
      perfChart = LightweightCharts.createChart($('perfChart'), {
        autoSize: true, layout: miniLayout(),
        grid: { vertLines: { visible: false }, horzLines: { color: Theme.ink(0.04) } },
        rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
      });
      perfSeries = perfChart.addAreaSeries({ lineColor: Theme.pal.line, topColor: alpha(Theme.pal.line, 0.35), bottomColor: alpha(Theme.pal.line, 0.02), lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 } });
    }
    $('perfTiles').innerHTML = tile('Equity', money(a.equity, 0), 'started with ' + money(a.startingCash, 0)) + tile('Total P&L', smoney(a.totalPnl, 0), pct(a.totalPnlPct), cls(a.totalPnl)) +
      tile('Win rate', s.all.trades ? s.all.winRate.toFixed(0) + '%' : '-', s.all.trades + ' closed trades') + tile('Profit factor', s.all.profitFactor != null && s.all.trades ? s.all.profitFactor.toFixed(2) : '-', 'gross wins ÷ gross losses') +
      tile('Avg trade', s.all.avgR != null ? (s.all.avgR >= 0 ? '+' : '') + s.all.avgR.toFixed(2) + 'R' : '-', 'R = multiples of risk', cls(s.all.avgR)) + tile('Best / worst', smoney(s.all.best, 0) + ' / ' + smoney(s.all.worst, 0));
    $('perfVs').innerHTML = cmp('Following ideas', s.suggested) + cmp('Your own trades', s.manual);
    const mh = mistakesHtml(a.mistakes);
    if ($('perfMistakes').dataset.h !== mh) { $('perfMistakes').dataset.h = mh; $('perfMistakes').innerHTML = mh; Icons.hydrate($('perfMistakes')); }
    const seen = new Set();
    const data = a.equityCurve.filter((p) => { const t = PriceChart.toLocal(p.time); if (seen.has(t)) return false; seen.add(t); return true; }).map((p) => ({ time: PriceChart.toLocal(p.time), value: p.value })).sort((x, y) => x.time - y.time);
    perfSeries.setData(data);
    perfChart.timeScale().fitContent();
  }

  // "Your mistakes, in dollars": what going off the plan cost (or made), next to following it.
  function mistakesHtml(m) {
    if (!m) return '';
    const any = m.followed.trades + m.skip.trades + m.broke.trades + m.against.trades + m.loosened.trades + m.early.trades + m.early.tracking;
    const head = '<div class="mist-head"><b>Your mistakes, in dollars</b><span>After costs, from your closed trades. Each card counts a trade once per habit, so cards can overlap.</span></div>';
    if (!any) return head + '<div class="mist-empty">' + Icons.ico('shield') + ' Nothing yet. As you trade, this shows what skipping the app\'s advice, moving stops and closing early cost you or made you, next to trades that followed the plan.</div>';
    const card = (cls, icon, title, x, line, big) => '<div class="mc ' + cls + (x.trades ? '' : ' zero') + '"><div class="mc-top">' + Icons.ico(icon) + '<span>' + title + '</span></div><b class="num ' + (x.trades ? cls2(big) : '') + '">' + (x.trades ? smoney(big, 0) : '–') + '</b><small>' + (x.trades ? line : 'None so far') + '</small></div>';
    const cls2 = (v) => (v > 0 ? 'up-t' : v < 0 ? 'down-t' : '');
    const n = (x) => x.trades + ' trade' + (x.trades === 1 ? '' : 's');
    const wr = (x) => (x.trades ? Math.round(x.wins / x.trades * 100) + '% wins' : '');
    const avg = (x) => (x.avgR != null ? ' · ' + (x.avgR >= 0 ? '+' : '') + x.avgR.toFixed(2) + 'R avg' : '');
    return head + '<div class="mist-grid">' +
      card('good', 'check', 'Followed the plan', m.followed, n(m.followed) + ' · ' + wr(m.followed) + avg(m.followed), m.followed.pnl) +
      card('bad', 'stop', 'Took "Better to skip" ideas', m.skip, n(m.skip) + ' · ' + wr(m.skip) + avg(m.skip), m.skip.pnl) +
      card('bad', 'alert', 'Own trades that broke a rule', m.broke, n(m.broke) + ' with no stop, too much risk, or a skip setup' + avg(m.broke), m.broke.pnl) +
      card('warn', 'eye', 'Own trades against the app', m.against, n(m.against) + ' against its read or with no setup' + avg(m.against), m.against.pnl) +
      card('bad', 'target', 'Moved a stop further away', m.loosened, n(m.loosened) + ' · lost ' + money(m.loosened.extraLoss, 0) + ' more than the original stops risked', -m.loosened.extraLoss) +
      card('warn', 'clock', 'Closed early by hand', m.early, n(m.early) + ': you got ' + smoney(m.early.pnl, 0) + ', the plan made ' + smoney(m.early.planPnl, 0) + (m.early.tracking ? ' · ' + m.early.tracking + ' still being followed' : ''), m.early.diff) +
      '</div>' + (m.early.tracking && !m.early.trades ? '<div class="mist-note">' + m.early.tracking + ' trade' + (m.early.tracking === 1 ? '' : 's') + ' you closed early ' + (m.early.tracking === 1 ? 'is' : 'are') + ' still being followed to where the plan would have exited.</div>' : '');
  }

  // ---------- strategy lab ----------
  let labChart = null; let labSeries = {};
  async function loadLab() {
    const pane = $('labPane');
    pane.innerHTML = '<div class="empty"><div class="spinner"></div><span>Backtesting every strategy on ' + esc(st.symbol) + ' ' + esc(st.tf) + '…</span></div>';
    labChart = null; labSeries = {};
    let r;
    try { r = await Api.call('strategyLab', { symbol: st.symbol, tf: st.tf, profile: st.profile }); } catch (e) { pane.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
    st.lab = r;
    const rows = r.strategies.map((s) => {
      const x = s.stats;
      return '<tr data-id="' + s.id + '" class="' + (st.labOff.has(s.id) ? 'off' : '') + '" title="' + esc(s.summary) + '"><td class="name"><i class="legend-dot" style="background:' + STRAT_COLOR[s.id] + '"></i>' + esc(s.name) + '</td><td>' + (s.research ? vpill(s.research.verdict, '', s.research.text) : '<span style="color:var(--muted)">-</span>') + '</td><td class="r">' + x.trades + '</td><td class="r">' + (x.trades ? x.winRate.toFixed(0) + '%' : '-') + '</td><td class="r ' + cls(x.expectancyR) + '">' + (x.trades ? (x.expectancyR >= 0 ? '+' : '') + x.expectancyR.toFixed(2) + 'R' : '-') + '</td><td class="r">' + (x.trades ? Math.min(x.profitFactor, 99).toFixed(2) : '-') + '</td><td class="r ' + cls(x.totalReturnPct) + '">' + pct(x.totalReturnPct, 1) + '</td><td class="r">' + x.maxDrawdownPct.toFixed(1) + '%</td><td class="r">' + (x.buyHoldPct != null ? pct(x.buyHoldPct, 1) : '-') + '</td><td class="r">' + x.exposurePct.toFixed(0) + '%</td></tr>';
    }).join('');
    const from = new Date(r.from * 1000).toLocaleDateString(); const to = new Date(r.to * 1000).toLocaleDateString();
    pane.innerHTML = '<div class="lab"><div><table class="grid num"><thead><tr><th>Strategy</th><th title="Our long-history research verdict for this strategy on this market and timeframe">Research</th><th class="r">Trades</th><th class="r">Win</th><th class="r">Avg</th><th class="r">PF</th><th class="r">Return</th><th class="r">Max DD</th><th class="r">Buy &amp; hold</th><th class="r">In mkt</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="lab-note">' + r.bars.toLocaleString() + ' ' + esc(r.tf) + ' bars, ' + from + ' to ' + to + '. Every signal taken at your ' + esc(st.catalog.profiles[st.profile].name) + ' risk, next-bar entries, after fees and slippage. Click a row for its trades; click a color dot to hide its curve.</div><div class="lab-note" id="labEvidence"></div></div>' +
      '<div class="mini-chart" id="labChart"><div class="cap">Account growth per strategy (%)</div></div></div>';
    const selectLab = (id) => {
      const s = r.strategies.find((x) => x.id === id);
      if (!s) return;
      st.labSel = id;
      pane.querySelectorAll('tbody tr').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
      const trades = s.trades.slice(-12).reverse();
      $('labEvidence').innerHTML = '<b>' + esc(s.name) + ':</b> ' + esc(s.evidence) + ' <i>' + esc(s.caveat) + '</i>' +
        (trades.length ? '<div class="trade-strip">' + trades.map((t, k) => '<button class="tchip ' + (t.R >= 0 ? 'w' : 'l') + '" data-k="' + k + '" title="' + esc(t.reason) + ', held ' + t.bars + ' bars">' + (t.dir > 0 ? '▲' : '▼') + ' ' + (t.R >= 0 ? '+' : '') + t.R.toFixed(2) + 'R · ' + esc(timeStr(t.entryTime)) + '</button>').join('') + '</div><div class="lab-note" style="margin:4px 0 0">Click a past trade to see it play out on the chart.</div>' : '<div class="lab-note">No trades in this window.</div>');
      $('labEvidence').querySelectorAll('.tchip').forEach((b) => b.addEventListener('click', () => {
        const t = trades[Number(b.dataset.k)];
        PriceChart.focusTrade(t);
        Sound.play(t.R >= 0 ? 'win' : 'loss');
      }));
    };
    pane.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => selectLab(tr.dataset.id));
      tr.querySelector('.legend-dot').addEventListener('click', (e) => {
        e.stopPropagation();
        const id = tr.dataset.id;
        if (st.labOff.has(id)) st.labOff.delete(id); else st.labOff.add(id);
        tr.classList.toggle('off');
        if (labSeries[id]) labSeries[id].applyOptions({ visible: !st.labOff.has(id) });
        Sound.play('toggle');
      });
    });
    const best = r.strategies.slice().sort((a, b) => b.stats.expectancyR * Math.min(1, b.stats.trades / 10) - a.stats.expectancyR * Math.min(1, a.stats.trades / 10))[0];
    selectLab(r.strategies.some((x) => x.id === st.labSel) ? st.labSel : best && best.id);
    labChart = LightweightCharts.createChart($('labChart'), {
      autoSize: true, layout: miniLayout(),
      grid: { vertLines: { visible: false }, horzLines: { color: Theme.ink(0.04) } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: r.tfSec < 86400 },
    });
    for (const s of r.strategies) {
      const ser = labChart.addLineSeries({ color: STRAT_COLOR[s.id], lineWidth: 2, priceLineVisible: false, lastValueVisible: true, visible: !st.labOff.has(s.id), priceFormat: { type: 'percent', precision: 1, minMove: 0.1 } });
      const seen = new Set();
      const pts = [{ time: PriceChart.toLocal(r.from), value: 0 }].concat(s.curve.map((p) => ({ time: PriceChart.toLocal(p.time), value: (p.value - 1) * 100 })))
        .filter((p) => { if (seen.has(p.time)) return false; seen.add(p.time); return true; }).sort((a, b) => a.time - b.time);
      ser.setData(pts);
      labSeries[s.id] = ser;
    }
    labChart.timeScale().fitContent();
  }

  // ---------- dock ----------
  function bindDock() {
    $('dockTabs').querySelectorAll('button[data-tab]').forEach((b) => {
      b.dataset.sound = 'tab';
      b.addEventListener('click', () => showDock(b.dataset.tab));
    });
    $('closeAllBtn').addEventListener('click', async () => {
      if (!st.account || !st.account.positions.length) { Fx.toast({ title: 'Nothing to close', body: 'You have no open trades.' }); return; }
      try { const shownById = {}; (st.account ? st.account.positions : []).forEach((p) => { shownById[p.id] = p.upnl; }); const r = await Api.call('closeAll', { shownById }); Fx.toast({ title: 'Closed ' + r.closed + ' trade' + (r.closed === 1 ? '' : 's'), body: 'All positions flattened at market.' }); refreshAccount(); } catch (e) { Fx.toast({ kind: 'error', title: 'Close all failed', body: e.message }); }
    });
    requestAnimationFrame(() => Fx.seg($('dockTabs'), st.dock));
  }
  function showDock(tab) {
    st.dock = tab;
    Fx.seg($('dockTabs'), tab);
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
    if (tab === 'performance') renderPerformance();
    if (tab === 'lab') loadLab();
  }

  // ---------- order ticket ----------
  function segTicket() {
    Fx.seg($('typeSeg'), st.type);
    Fx.seg($('sizeSeg'), st.sizeBy);
    $('sideToggle').dataset.side = st.side;
    $('sideToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.side === st.side));
  }
  function bindTicket() {
    $('sideToggle').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { st.side = b.dataset.side; segTicket(); fillTicketDefaults(true); }));
    $('typeSeg').querySelectorAll('button').forEach((b) => { b.dataset.sound = 'toggle'; b.addEventListener('click', () => { st.type = b.dataset.v; segTicket(); $('priceRow').hidden = st.type === 'market'; fillTicketDefaults(false); updatePreview(); }); });
    $('sizeSeg').querySelectorAll('button').forEach((b) => { b.dataset.sound = 'toggle'; b.addEventListener('click', () => { st.sizeBy = b.dataset.v; segTicket(); $('riskRow').hidden = st.sizeBy !== 'risk'; $('qtyRow').hidden = st.sizeBy !== 'qty'; updatePreview(); }); });
    ['tPrice', 'tRisk', 'tQty', 'tStop', 'tTarget'].forEach((id) => $(id).addEventListener('input', () => { st.ticketDirty = true; updatePreviewSoon(250); }));
    $('autoLevelsBtn').addEventListener('click', () => fillTicketDefaults(true));
    $('placeBtn').addEventListener('click', placeManual);
    $('tRisk').value = 0.5;
    requestAnimationFrame(segTicket);
  }
  function atrNow() {
    if (st.idea && st.idea.symbol === st.symbol && st.idea.tf === st.tf && st.idea.atr) return st.idea.atr;
    return null;
  }
  function fillTicketDefaults(levels) {
    const inst = st.inst[st.symbol];
    const prof = st.catalog.profiles[st.profile] || st.catalog.profiles.medium;
    if (!$('tRisk').value || levels) $('tRisk').value = prof.riskPct;
    const last = st.lastPrice;
    if (last == null) return;
    const dir = st.side === 'buy' ? 1 : -1;
    const atr = atrNow() || last * 0.004;
    let entry = last;
    if (st.type === 'limit') entry = last - dir * atr * 0.5;
    if (st.type === 'stop') entry = last + dir * atr * 0.5;
    if (st.type !== 'market') $('tPrice').value = entry.toFixed(inst.decimals);
    if (levels) {
      $('tStop').value = (entry - dir * atr * prof.stopAtr).toFixed(inst.decimals);
      $('tTarget').value = (entry + dir * atr * prof.stopAtr * prof.rr).toFixed(inst.decimals);
    }
    updatePreview();
  }
  function ticketParams() {
    return {
      symbol: st.symbol, side: st.side, type: st.type,
      price: st.type === 'market' ? undefined : $('tPrice').value,
      qty: st.sizeBy === 'qty' ? $('tQty').value : undefined,
      riskPct: st.sizeBy === 'risk' ? Number($('tRisk').value) : undefined,
      stop: $('tStop').value === '' ? null : $('tStop').value,
      target: $('tTarget').value === '' ? null : $('tTarget').value,
    };
  }
  function updatePreviewSoon(ms) {
    clearTimeout(updatePreviewSoon.t);
    updatePreviewSoon.t = setTimeout(updatePreview, ms || 250);
  }
  async function updatePreview() {
    const box = $('ticketPreview');
    const btn = $('placeBtn');
    const sideTxt = st.side === 'buy' ? 'Buy' : 'Sell';
    btn.className = 'primary-btn ' + st.side;
    let pv;
    box.dataset.busy = '1';
    try { pv = await Api.call('preview', ticketParams()); } catch (e) {
      box.innerHTML = '<div class="prob">' + esc(e.message) + '</div>';
      btn.querySelector('span').textContent = sideTxt + ' ' + st.symbol;
      delete box.dataset.busy; return;
    }
    delete box.dataset.busy;
    st.lastPv = pv;
    const inst = st.inst[st.symbol];
    box.innerHTML =
      '<span class="k">Quantity</span><span class="v num">' + (pv.qty ? qtyFmt(st.symbol, pv.qty) + ' ' + esc(inst.unit) : '-') + '</span>' +
      '<span class="k">Exposure</span><span class="v num">' + money(pv.notional, 0) + '</span>' +
      '<span class="k">Risk to stop</span><span class="v num down-t">' + (pv.riskUsd != null ? money(pv.riskUsd, 0) + ' (' + pv.riskPctOfEquity.toFixed(2) + '%)' : 'No stop') + '</span>' +
      '<span class="k">Reward to target</span><span class="v num up-t">' + (pv.rewardUsd != null ? money(pv.rewardUsd, 0) + (pv.rr ? ' (' + pv.rr.toFixed(1) + 'R)' : '') : '-') + '</span>' +
      '<span class="k" title="Spread, slippage and fees, in and out">Est. costs</span><span class="v num">' + money(pv.estCost != null ? pv.estCost : pv.estFees) + (pv.riskUsd && pv.estCost ? ' <small class="muted-t">(' + rFmt(pv.estCost / pv.riskUsd) + ')</small>' : '') + '</span><span></span><span></span>' +
      pv.problems.map((p) => '<div class="prob">' + esc(p) + '</div>').join('');
    btn.disabled = !!pv.problems.length || !pv.qty;
    btn.querySelector('span').textContent = sideTxt + ' ' + (pv.qty ? qtyFmt(st.symbol, pv.qty) + ' ' : '') + st.symbol + (st.type === 'market' ? ' at market' : ' ' + st.type);
  }
  // What makes a manual trade one the app would not take: no stop, too much risk, a poor
  // reward:risk, going against the app's read of this chart, or trading where it sees no setup.
  function manualConcerns(pv) {
    const out = [];
    const prof = st.catalog.profiles[st.profile] || st.catalog.profiles.medium;
    const dir = st.side === 'buy' ? 1 : -1;
    if (pv && pv.riskUsd == null) out.push({ tone: 'bad', text: 'There is no stop loss, so the loss has no limit. Every strategy in the app uses one.' });
    else if (pv && pv.riskPctOfEquity > prof.riskPct * 1.2) out.push({ tone: 'bad', text: 'It risks ' + pv.riskPctOfEquity.toFixed(2) + '% of the account. Your ' + prof.name + ' profile risks ' + prof.riskPct + '% per trade.' });
    if (pv && pv.rr != null && pv.rr < 1) out.push({ tone: 'warn', text: 'The target is closer than the stop (' + pv.rr.toFixed(1) + 'R). You would need to win well over half the time just to break even.' });
    const res = st.idea && st.idea.symbol === st.symbol && st.idea.tf === st.tf ? st.idea : null;
    const i = res && res.idea;
    if (i) {
      const same = (i.side === 'buy' ? 1 : -1) === dir;
      if (same && i.verdict && i.verdict.level === 'skip') out.push({ tone: 'bad', text: 'The app rates this setup "' + i.verdict.title + '": ' + (i.verdict.bad[0] ? i.verdict.bad[0].text : '') });
      else if (!same && i.verdict && i.verdict.level !== 'skip') out.push({ tone: 'warn', text: 'It goes against the app\'s current idea here (' + i.headline + ', ' + i.verdict.title.toLowerCase() + ').' });
    } else if (res && !i) {
      out.push({ tone: 'warn', text: 'No tested strategy has a setup on ' + st.symbol + ' ' + st.tf + ' right now.' });
    }
    if (res && res.htf && res.htf.tf && res.htf.dir === -dir) out.push({ tone: 'warn', text: 'The ' + res.htf.tf + ' trend points the other way.' });
    return out;
  }

  async function placeManual() {
    const btn = $('placeBtn');
    const concerns = st.account && st.account.beast ? [] : manualConcerns(st.lastPv);
    if (concerns.length) {
      const pv = st.lastPv || {};
      const ans = await Confirm.ask({
        title: concerns.some((c) => c.tone === 'bad') ? 'This trade breaks the app\'s rules' : 'The app would not take this trade',
        kicker: 'Your own trade', side: st.side,
        trade: (pv.qty ? qtyFmt(st.symbol, pv.qty) + ' ' : '') + st.symbol + (st.type === 'market' ? ' at market' : ' ' + st.type) + ' · risk ' + (pv.riskUsd != null ? money(pv.riskUsd, 0) : 'no limit'),
        stats: [{ k: 'Risk', v: pv.riskUsd != null ? pv.riskPctOfEquity.toFixed(2) + '%' : 'No stop', tone: 'down' }, { k: 'Reward : risk', v: pv.rr ? '1 : ' + pv.rr.toFixed(1) : '-' }, { k: 'Exposure', v: money(pv.notional || 0, 0) }],
        reasons: concerns,
        tone: concerns.some((c) => c.tone === 'bad') ? 'bad' : 'warn',
        note: 'Your own ideas are welcome: this is paper money and practice. The app just wants you to choose it on purpose.',
      });
      if (ans !== 'place') return;
    }
    btn.classList.add('busy'); btn.disabled = true;
    try {
      const out = await Api.call('placeOrder', Object.assign(ticketParams(), { source: 'manual', tf: st.tf, concerns: concerns.map((c) => ({ tone: c.tone, text: c.text })) }));
      Sound.play(out.position ? 'execute' : 'placed');
      const r = btn.getBoundingClientRect();
      Fx.confetti(r.left + r.width / 2, r.top, 40);
      showDock(out.position ? 'positions' : 'orders');
      refreshAccount();
    } catch (e) {
      Sound.play('error');
      Fx.toast({ kind: 'error', title: 'Order not placed', body: e.message, ttl: 7000 });
    } finally {
      btn.classList.remove('busy'); btn.disabled = false; updatePreview();
    }
  }

  // ---------- engine events ----------
  function onEngineEvent(ev) {
    if (ev.quiet) { refreshAccount(); return; }
    if (ev.type === 'sell-alert') { sellAlert(ev); accountSig = ''; refreshAccount(); return; }
    if (ev.type === 'guard') {
      Fx.toast({ kind: 'loss', title: 'Daily stop hit', body: ev.message, ttl: 12000, icon: 'shield' });
      Sound.play('loss');
      if (st.notify && (document.hidden || !document.hasFocus())) { try { new Notification('Daily stop hit', { body: ev.message }); } catch (e) { /* not allowed */ } }
      accountSig = '';
      refreshAccount();
      return;
    }
    if (ev.type === 'challenge') {
      const kind = ev.sound === 'win' ? 'win' : ev.sound === 'loss' ? 'loss' : '';
      Fx.toast({ kind, title: 'Prop challenge', body: ev.message, ttl: 9000, icon: 'trophy' });
      Sound.play(ev.sound || 'notify');
      if (ev.confetti) Fx.confetti(innerWidth / 2, innerHeight / 3, 240);
      if (st.notify && (document.hidden || !document.hasFocus())) { try { new Notification('Prop challenge', { body: ev.message }); } catch (e) { /* not allowed */ } }
      accountSig = ''; chKey = '';
      refreshAccount();
      return;
    }
    if (ev.type === 'sync') {
      Fx.toast({ title: 'Synced', body: ev.message, ttl: 6000, icon: 'sync' });
      Sound.play('notify');
      accountSig = ''; chKey = ''; refreshAccount(); loadSync();
      return;
    }
    let kind = ''; let title = 'PaperDesk';
    if (ev.type === 'opened') { title = 'Order filled'; kind = ''; }
    if (ev.type === 'order-placed') { title = 'Order working'; }
    if (ev.type === 'closed') { kind = ev.win ? 'win' : 'loss'; title = ev.win ? 'Winner!' : 'Trade closed'; }
    if (ev.type === 'error') kind = 'error';
    Fx.toast({ kind, title, body: ev.message, ttl: ev.type === 'closed' ? 7000 : 4500 });
    if (ev.type === 'closed') {
      if (ev.trade && ev.trade.id != null) dropSellToasts(ev.trade.id);
      Sound.play(ev.win ? 'win' : 'loss');
      if (ev.win) Fx.confetti(innerWidth - 200, 80, 160);
    } else if (ev.type === 'opened' && ev.position && ev.position.source !== 'suggested' && ev.position.source !== 'manual') {
      Sound.play('execute');
    } else if (ev.type === 'opened' && /order filled/.test(ev.message)) {
      Sound.play('notify');
    }
    if (st.notify && (document.hidden || !document.hasFocus()) && (ev.type === 'closed' || /order filled/.test(ev.message || ''))) {
      try { new Notification(title, { body: ev.message, silent: false }); } catch (e) { /* not allowed */ }
    }
    accountSig = '';
    refreshAccount();
  }

  // ---------- "Time to sell?" alerts ----------
  // Raised by the engine (core/paper.js sellCheck) once per reason per trade. The Sell button
  // closes the trade at market, like the Close button in the Positions panel.
  function sellAlert(ev) {
    const long = ev.dir > 0;
    const pnl = ev.upnl != null ? smoney(ev.upnl) + (ev.upnlR != null ? ' (' + (ev.upnlR >= 0 ? '+' : '') + ev.upnlR.toFixed(1) + 'R)' : '') : '';
    Fx.toast({
      kind: 'sell' + (ev.tested ? ' tested' : ''), icon: ev.tested ? 'alert' : 'down', title: ev.title, tag: 'pos-' + ev.id,
      body: ev.message + (pnl ? ' Open P&L ' + pnl + '.' : ''),
      extra: ev.tested ? 'This exit is part of the strategy the research tested.' : 'A heads-up, not a rule: in the app\'s tests, selling on signs like this did not beat sticking to the plan.',
      ttl: 90000,
      actions: [
        { label: long ? 'Sell now' : 'Buy back now', cls: 'sell', sound: 'none', keep: true, onClick: (b) => sellFromAlert(ev, b) },
        { label: 'Show me', onClick: () => { const p = st.account && st.account.positions.find((x) => x.id === ev.id); if (st.inst[ev.symbol]) selectSymbol(ev.symbol, (p && (p.tf || (p.managed && p.managed.tf))) || st.tf); showDock('positions'); } },
        { label: 'Keep it' },
      ],
    });
    Sound.play('notify');
    if (st.notify && (document.hidden || !document.hasFocus())) {
      try { const n = new Notification(ev.title, { body: ev.message + (pnl ? ' Open P&L ' + pnl + '.' : '') + ' Open PaperDesk to sell or keep it.', silent: false }); n.onclick = () => { try { window.focus(); } catch (e) { /* ignore */ } showDock('positions'); }; } catch (e) { /* not allowed */ }
    }
  }
  // once a trade is closed, its sell alerts have nothing left to sell
  function dropSellToasts(id) {
    document.querySelectorAll('.toast[data-tag="pos-' + id + '"]').forEach((t) => { t.classList.add('out'); setTimeout(() => t.remove(), 300); });
  }
  async function sellFromAlert(ev, btn) {
    btn.disabled = true;
    try {
      await Api.call('closePosition', { id: ev.id, shown: shownPnl(ev.id) });
      dropSellToasts(ev.id);
      refreshAccount();
    } catch (e) {
      Sound.play('error'); btn.disabled = false;
      Fx.toast({ kind: 'error', title: 'Could not sell', body: e.message });
    }
  }
  const SELL_MODES = [
    { id: 'off', name: 'Off', tip: 'No sell alerts. Stops and targets still close trades on their own.' },
    { id: 'tested', name: 'Strategy exits', tip: 'An alert with a Sell button when a trade\'s own strategy says sell: its exit rule, trailing stop or time limit. These are the exits the research tested. Trades the app manages sell on their own.' },
    { id: 'all', name: '+ Shaky signs', tip: 'Also alerts when a winning trade looks shaky: it gave back half its profit, lost its 20-bar average, printed a sharp reversal bar, broke the last 3 bars, got much more volatile, got stretched or overbought, or stalled. In the app\'s tests on 36,000 trades, selling on these signs did not beat holding to the plan, so treat them as a heads-up.' },
  ];
  function renderSellSeg() {
    const cur = (st.account && st.account.sellAlerts) || 'all';
    const m = SELL_MODES.find((x) => x.id === cur) || SELL_MODES[2];
    $('sellSeg').innerHTML = SELL_MODES.map((x) => '<button class="lay-btn' + (x.id === cur ? ' on' : '') + '" data-id="' + x.id + '" data-sound="click">' + esc(x.name) + '</button>').join('');
    $('sellTip').textContent = m.tip;
    $('sellSeg').querySelectorAll('.lay-btn').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await Api.call('setSellAlerts', { mode: b.dataset.id });
        if (st.account) st.account.sellAlerts = r.sellAlerts;
        renderSellSeg();
      } catch (e) { Fx.toast({ kind: 'error', title: 'Not changed', body: e.message }); }
    }));
  }

  // ---------- modals ----------
  function openModal(id) { $(id).hidden = false; Sound.play('open'); Icons.hydrate($(id)); }
  function closeModal(id) { $(id).hidden = true; Sound.play('close'); }
  function bindModals() {
    document.querySelectorAll('.modal-back').forEach((m) => {
      m.addEventListener('mousedown', (e) => { if (e.target === m && m.id !== 'welcomeModal') closeModal(m.id); });
      m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(m.id)));
    });
    $('searchBtn').addEventListener('click', openSearch);
    $('learnBtn').addEventListener('click', () => openLearn());
    $('topBtn').addEventListener('click', () => openTop());
    $('researchBtn').addEventListener('click', openResearch);
    $('propBtn').addEventListener('click', openProp);
    $('searchInput').addEventListener('input', renderSearch);
    $('searchInput').addEventListener('keydown', (e) => {
      const items = Array.from(document.querySelectorAll('.sr'));
      let i = items.findIndex((x) => x.classList.contains('sel'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
        items.forEach((x, k) => x.classList.toggle('sel', k === i));
        if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
        Sound.play('tick');
      } else if (e.key === 'Enter' && items[i]) {
        items[i].click();
      }
    });
    $('settingsBtn').addEventListener('click', openSettings);
    $('themeBtn').addEventListener('click', openSettings);
    $('soundBtn').addEventListener('click', () => { Sound.setEnabled(!Sound.enabled); updateSoundBtn(); if (Sound.enabled) Sound.play('toggle'); });
    $('volSlider').addEventListener('input', (e) => { Sound.setVolume(e.target.value / 100); Sound.setEnabled(e.target.value > 0); updateSoundBtn(); });
    $('volSlider').addEventListener('change', () => Sound.play('click'));
    $('guardToggle').addEventListener('change', async (e) => {
      try { await Api.call('setGuard', { on: e.target.checked }); } catch (err) { Fx.toast({ kind: 'error', title: 'Could not change the guard rails', body: err.message }); }
      Sound.play('toggle'); accountSig = ''; await refreshAccount(); renderGuard(); updatePreviewSoon(0);
    });
    $('notifToggle').addEventListener('change', (e) => {
      st.notify = e.target.checked; setPref('notify', st.notify);
      if (st.notify && window.Notification && Notification.permission === 'default') Notification.requestPermission();
    });
    $('resetBtn').addEventListener('click', async () => {
      const cash = Number($('resetCash').value) || 100000;
      try { await Api.call('resetAccount', { cash }); accountSig = ''; await refreshAccount(); closeModal('settingsModal'); Sound.play('execute'); } catch (e) { Fx.toast({ kind: 'error', title: 'Reset failed', body: e.message }); }
    });
    let lastFocusSync = 0;
    const syncOnReturn = () => {
      if (document.hidden || !syncSt || !syncSt.linked || Date.now() - lastFocusSync < 10000) return;
      lastFocusSync = Date.now();
      Api.call('syncNow').then((x) => { syncSt = x; }).catch(() => {});
    };
    addEventListener('focus', syncOnReturn);
    document.addEventListener('visibilitychange', syncOnReturn);
    loadSync();
    setInterval(() => { if (!$('settingsModal').hidden) loadSync(); }, 4000);
    $('ideaRefreshBtn').addEventListener('click', () => refreshIdea(true));
    $('ideaPreviewBtn').addEventListener('click', () => { st.preview = !st.preview; setPref('preview', st.preview); drawTrades(); });
  }
  function updateSoundBtn() {
    const b = $('soundBtn');
    b.querySelector('.ico').dataset.icon = Sound.enabled ? 'sound' : 'mute';
    b.classList.toggle('muted', !Sound.enabled);
    Icons.hydrate(b);
  }
  function openSearch() {
    openModal('searchModal');
    $('searchInput').value = '';
    renderSearch();
    setTimeout(() => $('searchInput').focus(), 30);
  }
  function renderSearch() {
    const q = $('searchInput').value.trim().toLowerCase();
    const alias = { gold: 'MGC', silver: 'SIL', oil: 'MCL', crude: 'MCL', bitcoin: 'BTC-USD', ether: 'ETH-USD', euro: 'EURUSD', yen: 'USDJPY', pound: 'GBPUSD', 'sp500': 'SPY', 's&p': 'SPY', nasdaq: 'QQQ' };
    const list = st.catalog.instruments.filter((i) => !q || i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.market.includes(q) || (alias[q] && alias[q] === i.symbol) || (q === 'gold' && i.symbol === 'GLD'));
    const mk = (m) => (st.catalog.markets.find((x) => x.id === m) || {}).name;
    $('searchResults').innerHTML = list.map((i, k) => '<div class="sr' + (k === 0 ? ' sel' : '') + '" data-sym="' + i.symbol + '"><b>' + esc(i.symbol) + '</b><span>' + esc(i.name) + '</span><em>' + esc(mk(i.market)) + '</em></div>').join('') || '<div class="empty" style="height:120px">No match</div>';
    $('searchResults').querySelectorAll('.sr').forEach((r) => r.addEventListener('click', () => { closeModal('searchModal'); selectSymbol(r.dataset.sym, st.tf); }));
  }
  function profileTableHtml() {
    const P = st.catalog.profiles; const ids = ['low', 'medium', 'high'];
    const row = (label, f) => '<tr><td>' + label + '</td>' + ids.map((id) => '<td class="num">' + f(P[id]) + '</td>').join('') + '</tr>';
    return '<table><thead><tr><th>Risk profile</th><th>Low</th><th>Medium</th><th>High</th></tr></thead><tbody>' +
      row('Risk per trade', (p) => p.riskPct + '%') + row('Default stop', (p) => p.stopAtr + '× ATR') + row('Default target', (p) => p.rr + 'R') +
      row('Max open trades', (p) => p.maxPositions) + row('Risk per market group', (p) => p.clusterRiskPct + '%') + row('Daily loss limit', (p) => p.dailyLossPct + '%') +
      row('Drawdown breaker', (p) => p.drawdownPct + '%') + row('Exposure: stocks / crypto', (p) => p.leverage.stocks + '× / ' + p.leverage.crypto + '×') +
      row('Exposure: forex / futures', (p) => p.leverage.forex + '× / ' + p.leverage.futures + '×') + row('Ideas shown as OK', (p) => (p.minScore >= 62 ? 'A-B' : p.minScore >= 48 ? 'A-C' : 'A-D')) + '</tbody></table>';
  }
  function renderGuard() {
    const g = st.account && st.account.guard;
    const box = $('guardNow'); const tg = $('guardToggle');
    if (!g || !box) return;
    tg.checked = g.setting; tg.disabled = !g.available;
    box.innerHTML = !g.available ? 'Paused during a prop challenge, which has its own rules.'
      : !g.on ? 'Off. Nothing stops a bad day from getting worse.'
      : g.stopped ? '<b class="down-t">Daily stop hit today.</b> Trading resumes tomorrow.'
      : 'Today: down ' + money(g.dayLossUsd, 0) + ' of a ' + money(g.dailyStopUsd, 0) + ' daily stop · ' + g.indexOpen + ' of ' + g.maxIndexTrades + ' index trades open · max risk ' + money(g.riskCapUsd, 0) + ' a trade';
  }
  // ---------- themes ----------
  const LAYOUT_SVG = {
    classic: '<rect x="1" y="1" width="6" height="16" rx="1.5"/><rect x="8.5" y="1" width="10" height="10" rx="1.5"/><rect x="8.5" y="12" width="10" height="5" rx="1.5"/><rect x="20" y="1" width="5" height="16" rx="1.5"/>',
    mirror: '<rect x="1" y="1" width="5" height="16" rx="1.5"/><rect x="7.5" y="1" width="10" height="10" rx="1.5"/><rect x="7.5" y="12" width="10" height="5" rx="1.5"/><rect x="19" y="1" width="6" height="16" rx="1.5"/>',
    wide: '<rect x="1" y="1" width="3" height="16" rx="1"/><rect x="5.5" y="1" width="14" height="11" rx="1.5"/><rect x="5.5" y="13" width="14" height="4" rx="1.5"/><rect x="21" y="1" width="4" height="16" rx="1.5"/>',
    strip: '<rect x="1" y="1" width="24" height="4" rx="1.5"/><rect x="1" y="6.5" width="17" height="7" rx="1.5"/><rect x="1" y="14.5" width="17" height="2.5" rx="1"/><rect x="19.5" y="6.5" width="5.5" height="10.5" rx="1.5"/>',
  };
  function renderThemePicker() {
    $('themeGrid').innerHTML = Theme.THEMES.map((t) => {
      const m = t.mini;
      return '<button class="th-card' + (t.id === Theme.id ? ' on' : '') + '" data-id="' + t.id + '" data-sound="select"><div class="th-mini" style="background:' + m[0] + ';grid-template-columns:22% 1fr 26%;grid-template-rows:9px 1fr 26%">' +
        '<i style="grid-column:1/4;background:' + m[1] + '"></i><i style="grid-row:2/4;background:' + m[1] + '"></i>' +
        '<i style="background:' + m[1] + ';position:relative;overflow:hidden"><svg viewBox="0 0 60 30" preserveAspectRatio="none" style="position:absolute;inset:3px;width:calc(100% - 6px);height:calc(100% - 6px)"><polyline fill="none" stroke-width="2" stroke="' + m[3] + '" points="0,24 10,18 18,21 28,10 36,14 46,6 60,9"/></svg></i>' +
        '<i style="grid-row:2/4;background:' + m[1] + ';display:grid;align-content:end;padding:3px"><span style="display:block;height:7px;border-radius:3px;background:' + m[2] + '"></span></i>' +
        '<i style="background:' + m[1] + ';display:flex;gap:2px;align-items:end;padding:3px"><span style="flex:1;height:60%;background:' + m[3] + ';border-radius:1px"></span><span style="flex:1;height:35%;background:' + m[4] + ';border-radius:1px"></span><span style="flex:1;height:80%;background:' + m[3] + ';border-radius:1px"></span></i>' +
        '</div><b>' + esc(t.name) + '</b><small>' + esc(t.tag) + '</small></button>';
    }).join('');
    $('layoutSeg').innerHTML = Theme.LAYOUTS.map((l) => '<button class="lay-btn' + (l.id === Theme.layout ? ' on' : '') + '" data-id="' + l.id + '" title="' + esc(l.tip) + '" data-sound="toggle"><svg viewBox="0 0 26 18" fill="currentColor" opacity=".8">' + LAYOUT_SVG[l.id] + '</svg>' + esc(l.name) + '</button>').join('');
    $('themeGrid').querySelectorAll('.th-card').forEach((b) => b.addEventListener('click', () => {
      Theme.apply(b.dataset.id, { animate: true, withLayout: true });
      renderThemePicker();
      Fx.toast({ title: Theme.theme.name + ' theme', body: Theme.theme.tag + ' Layout: ' + Theme.LAYOUTS.find((l) => l.id === Theme.layout).name + '.', icon: 'palette', ttl: 3500 });
    }));
    $('layoutSeg').querySelectorAll('.lay-btn').forEach((b) => b.addEventListener('click', () => { Theme.setLayout(b.dataset.id); renderThemePicker(); }));
  }

  function openSettings() {
    renderThemePicker();
    $('volSlider').value = Math.round(Sound.volume * 100) * (Sound.enabled ? 1 : 0);
    $('notifToggle').checked = st.notify;
    renderGuard();
    renderSellSeg();
    $('profileTable').innerHTML = profileTableHtml();
    renderSync(true); loadSync();
    openModal('settingsModal');
  }

  // ---------- sync codes: Get my code / Enter a code (Settings) ----------
  // The engine (core/sync.js) does the uploading and downloading; this is just the panel. The same
  // box takes the secret code, which answers with a plain "Code on" / "Code off" and nothing else.
  let syncSt = null; let joinArmed = false; let codeShown = false; let codeNote = null;
  async function loadSync() {
    try { syncSt = await Api.call('syncStatus'); } catch (e) { syncSt = { available: false }; }
    if (!$('settingsModal').hidden) renderSync();
  }
  function agoTxt(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 10 ? 'just now' : s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : new Date(ms).toLocaleString();
  }
  function renderSync(force) {
    const box = $('syncBox');
    const s = syncSt || { available: true, linked: false };
    if (!force && document.activeElement && document.activeElement.id === 'codeInput') return; // don't redraw under someone typing
    let mine;
    if (!s.available) mine = '<p class="sync-fine">Sync is not available in this version.</p>';
    else if (!s.linked) {
      mine = '<div class="sync-get"><div><b>Get my code</b><span>Saves this paper account online and gives you a code. Type the code on your phone or PC to pick up your trades and history there.</span></div><button class="primary-btn" id="codeGet" data-sound="none"><span>Get my code</span></button></div>';
    } else {
      const code = codeShown ? esc(s.code) : esc(s.code.slice(0, 4)) + '-••••';
      mine = '<div class="sync-linked"><div class="sync-code-wrap"><span class="sync-lbl">Your code</span><b class="sync-code num' + (codeShown ? '' : ' masked') + '">' + code + '</b>' +
        '<button class="icon-btn sm" id="codeShow" title="' + (codeShown ? 'Hide' : 'Show') + ' the code" data-sound="toggle"><span class="ico" data-icon="eye"></span></button>' +
        '<button class="icon-btn sm" id="codeCopy" title="Copy the code" data-sound="none"><span class="ico" data-icon="copy"></span></button></div>' +
        '<div class="sync-state ' + (s.error ? 'bad' : 'ok') + '"><i></i><span>' + (s.error ? esc(s.error) : s.pending ? 'Uploading your latest changes…' : 'In sync with your other devices' + (s.lastSync ? ' · ' + agoTxt(s.lastSync) : '')) + '</span></div>' +
        '<div class="sync-acts"><button class="ghost-btn" id="syncNowBtn" data-sound="click"><span class="ico" data-icon="sync"></span>Sync now</button><button class="link-btn" id="syncOff" data-sound="click">Stop syncing on this device</button></div></div>';
    }
    box.innerHTML = mine +
      '<div class="sync-enter"><label for="codeInput"><b>Enter a code</b><span>Got a code from your other device? Type it here to load your trades on this one.</span></label>' +
      '<div class="sync-row"><input id="codeInput" placeholder="K7QD-M2XP" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" maxlength="24" aria-label="Code"><button class="ghost-btn" id="codeGo" data-sound="none">Load</button></div>' + (codeNote && Date.now() < codeNote.until ? '<p class="sync-warn ok" id="codeWarn">' + esc(codeNote.text) + '</p>' : '<p class="sync-warn" id="codeWarn" hidden></p>') + '</div>' +
      '<p class="sync-fine">Anyone with your code can see and change this paper account, so keep it to yourself and don\'t post it. Only paper-trading data is saved: cash, trades, history and settings. No names, emails or passwords.</p>';
    Icons.hydrate(box);
    joinArmed = false;
    const get = $('codeGet');
    if (get) get.addEventListener('click', async () => {
      get.disabled = true; get.querySelector('span').textContent = 'Saving…'; Sound.play('execute');
      try {
        syncSt = await Api.call('syncCreate'); codeShown = true; renderSync();
        Fx.toast({ kind: 'win', title: 'Your code: ' + syncSt.code, body: 'Type it under Settings > Enter a code on your other device. This account now stays in step on both.', ttl: 9000, icon: 'sync' });
      } catch (e) { get.disabled = false; get.querySelector('span').textContent = 'Get my code'; Sound.play('error'); Fx.toast({ kind: 'error', title: 'Could not make a code', body: e.message }); }
    });
    if ($('codeShow')) $('codeShow').addEventListener('click', () => { codeShown = !codeShown; renderSync(); });
    if ($('codeCopy')) $('codeCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(s.code); Sound.play('select'); Fx.toast({ title: 'Code copied', body: s.code, ttl: 2500, icon: 'copy' }); } catch (e) { codeShown = true; renderSync(); }
    });
    if ($('syncNowBtn')) $('syncNowBtn').addEventListener('click', async () => {
      $('syncNowBtn').classList.add('spin');
      try { syncSt = await Api.call('syncNow'); } catch (e) { /* shown in status */ }
      renderSync();
    });
    if ($('syncOff')) $('syncOff').addEventListener('click', async () => {
      syncSt = await Api.call('syncUnlink'); codeShown = false; renderSync();
      Fx.toast({ title: 'Sync stopped on this device', body: 'Your trades stay here. The code still works on your other devices.', icon: 'sync' });
    });
    const input = $('codeInput');
    input.addEventListener('input', () => { if (joinArmed) { joinArmed = false; $('codeGo').classList.remove('armed'); $('codeGo').textContent = 'Load'; $('codeWarn').hidden = true; } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); enterCode(); } });
    $('codeGo').addEventListener('click', enterCode);
  }
  async function enterCode() {
    const input = $('codeInput'); const go = $('codeGo'); const warn = $('codeWarn');
    const raw = input.value.trim();
    if (!raw) { input.focus(); return; }
    const a = st.account;
    const isSyncCode = raw.replace(/[^0-9a-z]/gi, '').length === 8;
    const hasData = a && (a.history.length || a.positions.length || a.orders.length);
    if (isSyncCode && hasData && !joinArmed) {
      joinArmed = true;
      warn.hidden = false; warn.className = 'sync-warn';
      warn.textContent = 'This swaps the paper account on this device (' + a.history.length + ' closed trades, ' + a.positions.length + ' open) for the one saved under that code. Press Replace to go ahead.';
      go.textContent = 'Replace'; go.classList.add('armed'); Sound.play('warn');
      return;
    }
    go.disabled = true; go.textContent = 'Loading…';
    try {
      const r = await Api.call('enterCode', { code: raw });
      input.value = '';
      if (r.kind === 'sync') { syncSt = r.status; codeShown = false; selectSymbol(st.symbol, st.tf, true); }
      codeNote = r.kind === 'beast' ? { text: r.beast ? 'Code on.' : 'Code off.', until: Date.now() + 8000 } : null;
      if (r.kind === 'beast') Sound.play('toggle');
      accountSig = ''; await refreshAccount();
      renderSync(true);
      if (r.kind === 'beast' && st.idea) renderIdea();
    } catch (e) {
      Sound.play('error');
      go.disabled = false; go.textContent = 'Load'; go.classList.remove('armed'); joinArmed = false;
      warn.hidden = false; warn.className = 'sync-warn err'; warn.textContent = e.message;
    }
  }
  function openWelcome() {
    const P = st.catalog.profiles;
    let pick = st.profile || 'medium';
    $('welcomeProfiles').innerHTML = ['low', 'medium', 'high'].map((id) => {
      const p = P[id];
      return '<div class="wp' + (id === pick ? ' sel' : '') + '" data-id="' + id + '"><b>' + p.name + ' risk</b><p>' + esc(p.tagline) + '</p><ul><li><b>' + p.riskPct + '%</b> risk per trade</li><li><b>' + p.maxPositions + '</b> trades at once</li><li><b>' + p.dailyLossPct + '%</b> daily loss limit</li><li><b>' + p.leverage.stocks + '×</b> max stock exposure</li></ul></div>';
    }).join('');
    $('welcomeProfiles').querySelectorAll('.wp').forEach((el) => el.addEventListener('click', () => {
      pick = el.dataset.id;
      $('welcomeProfiles').querySelectorAll('.wp').forEach((x) => x.classList.toggle('sel', x === el));
    }));
    $('welcomeGo').onclick = async () => {
      setPref('welcomed', true);
      $('welcomeModal').hidden = true;
      await setProfile(pick);
      Fx.confetti(innerWidth / 2, innerHeight / 3, 140);
    };
    openModal('welcomeModal');
  }

  // ---------- research results & prop challenge ----------
  const VERDICT = { holds: 'Held up', mixed: 'Mixed', fails: 'Failed' };
  const VORDER = { holds: 0, mixed: 1, fails: 2 };
  const vpill = (v, extra, title) => '<span class="vpill ' + v + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + (extra || '') + VERDICT[v] + '</span>';
  const RS_EXTRA = {
    gap_fade: 'Fades an opening gap of 0.1% to 1% back toward the prior close, flat by the close. Research only.',
    orb30: 'Trades the first close outside the 9:30 to 10:00 AM ET range, stop at the other side, flat by the close. Research only.',
    tsmom: 'Long while the past 12 months are up, short while they are down (Moskowitz, Ooi and Pedersen 2012). Holds for months. Research only.',
    rod_momentum: 'The move from the prior close to 30 minutes before the close predicts the last 30 minutes (Baltussen, Da, Lammers and Martens 2021). Research only.',
  };
  const MKT_ORDER = ['ES', 'NQ', 'RUT', 'DAX', 'FTSE', 'N225', 'STOXX', 'GC', 'CL', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTC', 'ETH'];
  const MKT_SHORT = { ES: 'S&P 500', NQ: 'Nasdaq-100', RUT: 'Russell 2000', DAX: 'DAX', FTSE: 'FTSE 100', N225: 'Nikkei 225', STOXX: 'Euro Stoxx 50', GC: 'Gold', CL: 'Crude oil', EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD', USDJPY: 'USD/JPY', BTC: 'Bitcoin', ETH: 'Ether' };
  const APP_SYMS = { ES: 'SPY or MES', NQ: 'QQQ or MNQ', RUT: 'IWM', GC: 'GLD or MGC', CL: 'MCL', EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD', USDJPY: 'USD/JPY', BTC: 'BTC', ETH: 'ETH' };
  // indexes tested for research only: what CFD prop firms usually call them
  const CFD_NAME = { DAX: 'GER40', FTSE: 'UK100', N225: 'JP225', STOXX: 'EU50' };
  const RTF = { '5m_rth': '5m, US hours', '5m_pit': '5m, pit hours', '1h': '1H', '4h': '4H', '1d': '1D' };
  const RISK_COLS = [['0.0025', '0.25%', 'Low'], ['0.005', '0.5%', 'Medium'], ['0.01', '1%', 'High'], ['0.02', '2%', '2x High']];
  const FINDINGS = [
    ['check', '<b>Daily stock-index dips are the most reliable edge we found.</b> RSI(2) on the S&amp;P 500 made money in 70% of years since 1991 (t-stat 4.1), stayed positive after 2020 and survived doubled costs. It also made money with all 48 nearby settings we tried and in every 5-year stretch. RSI(2) and IBS on the Nasdaq-100 held up too.'],
    ['alert', '<b>All 14 intraday futures tests lost money after costs.</b> A few had a tiny edge before costs (Nasdaq intraday momentum, +2.3 bp a trade), but commission plus one tick of slippage costs 1.5 to 3 bp a trade, so nothing was left.'],
    ['up', '<b>Trend following pays slowly.</b> Turtle on Bitcoin daily and USD/JPY hourly held up; gold, Ether and crude were mixed; S&amp;P, Nasdaq, EUR and GBP trends failed, in line with studies that found trends faded after 2009.'],
    ['clock', '<b>Month-end rebalancing held up on the S&amp;P 500</b> (t-stat 2.9): sell stocks into month-end after they beat bonds, buy after they lag. It did not work on the Nasdaq-100.'],
    ['shield', '<b>Nothing clears the strict luck test.</b> After counting all 151 tries, the best Deflated Sharpe is 0.66 (0.95 is the bar). Treat every edge here as small and uncertain, and keep risk per trade small.'],
    ['trophy', '<b>Prop challenges mostly reward luck.</b> Intraday-only futures firms passed our strategies about as often as a coin flip. At overnight-friendly firms, the held-up mix at 0.3% risk, with a personal daily stop at 70% of the firm\'s limit and at most 3 stock-index trades open (no more than 2 US), passed 51% of 2-step attempts within a year (17% with the edge removed). Into the funded stage, a $590 attempt returned +$6,301 on average as backtested, +$2,666 if the edge halves. See Prop challenge.'],
    ['lab', '<b>Tested abroad, the dip-buying rules faded.</b> RSI(2) and IBS made small, insignificant profits on the Russell 2000, DAX, FTSE 100, Nikkei and Euro Stoxx 50, so part of their US result may be luck. Turn of the month held up on the Russell 2000, DAX and FTSE 100, and month-end rebalancing on the Russell 2000.'],
    ['bolt', '<b>Overnight financing matters at CFD firms.</b> At the T-bill rate plus 2.5% a year, it takes 3 to 6 bp from each daily index trade (about a tenth of the edge) and far more from slow trend trades. Every strategy that held up stayed positive after it, and the prop numbers here include it.'],
  ];
  let RS = null; let PRESETS = null;
  const rsf = { verdict: 'all', market: 'all', sort: 'verdict', dir: 1, sel: null };
  async function loadResearch() {
    if (!RS) RS = await Api.call('research');
    if (!PRESETS) PRESETS = await Api.call('propPresets');
  }
  function openLearn(page) {
    if (!window.Learn) return;
    document.querySelectorAll('.modal-back:not([hidden])').forEach((m) => { if (m.id !== 'welcomeModal') closeModal(m.id); });
    Learn.open(page, { onChart: (sym, tf) => { if (st.inst[sym]) selectSymbol(sym, tf); } });
  }

  // ---------- Top trades ----------
  // Opening a ranked trade shows that exact idea on its chart (not just the chart's own #1),
  // until the user moves to another chart.
  function showTopTrade(r) {
    if (!st.inst[r.symbol]) return;
    st.prefer = { symbol: r.symbol, tf: r.tf, strategy: r.strategy.id, side: r.side, pending: !!r.pending };
    if (r.symbol === st.symbol && r.tf === st.tf) { st.ticketDirty = false; refreshIdea(true).then(() => fillTicketDefaults(true)); }
    else selectSymbol(r.symbol, r.tf);
  }
  function topAlert(a) {
    Fx.toast({ title: a.title, body: a.body, icon: a.icon || 'spark', ttl: 12000, onClick: a.onClick });
    Sound.play('notify');
    if (st.notify && (document.hidden || !document.hasFocus())) {
      try { const n = new Notification(a.title, { body: a.body, silent: false }); n.onclick = () => { try { window.focus(); } catch (e) { /* ignore */ } if (a.onClick) a.onClick(); }; } catch (e) { /* not allowed */ }
    }
  }
  function openTop() {
    if (!window.Top) return;
    document.querySelectorAll('.modal-back:not([hidden])').forEach((m) => { if (m.id !== 'welcomeModal') closeModal(m.id); });
    Top.open();
  }

  async function openResearch() {
    openModal('researchModal');
    const body = $('researchBody');
    if (!RS) body.innerHTML = '<div class="empty" style="height:220px"><div class="spinner"></div></div>';
    try { await loadResearch(); } catch (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
    renderResearch();
  }
  function renderResearch() {
    const S = RS.strategies;
    const count = (v) => S.filter((s) => s.verdict === v).length;
    const tiles = [[S.length, 'tests of a strategy on one market and timeframe', ''], [count('holds'), 'held up: passed every check', 'up-t'], [count('mixed'), 'mixed: positive but not proven', ''], [count('fails'), 'failed after costs or since 2020', 'down-t'], [S.filter((s) => s.dsr >= 0.95).length, 'clear the strict luck test (Deflated Sharpe 0.95)', '']];
    const chip = (k, v, label) => '<button class="chip' + (rsf[k] === v ? ' on' : '') + '" data-k="' + k + '" data-v="' + v + '" data-sound="toggle">' + label + '</button>';
    $('researchBody').innerHTML =
      '<div class="rs-tiles">' + tiles.map((t) => '<div class="rs-tile"><b class="num ' + t[2] + '">' + t[0] + '</b><span>' + t[1] + '</span></div>').join('') + '</div>' +
      '<div class="rs-find">' + FINDINGS.map((f) => '<p>' + Icons.ico(f[0]) + '<span>' + f[1] + '</span></p>').join('') + '</div>' +
      '<div class="rs-filters">' + chip('verdict', 'all', 'All') + chip('verdict', 'holds', 'Held up') + chip('verdict', 'mixed', 'Mixed') + chip('verdict', 'fails', 'Failed') + '<span class="sep"></span>' +
      chip('market', 'all', 'All markets') + MKT_ORDER.map((m) => chip('market', m, MKT_SHORT[m])).join('') + '</div>' +
      '<div class="rs-grid"><div class="rs-tablewrap" id="rsTable"></div><div class="rs-detail" id="rsDetail"></div></div>' +
      '<p class="fine" style="margin:12px 2px 0">How we tested: 5-minute, hourly and daily prices from 1990 (stock indexes), 2001 (gold), 2012 (futures intraday and forex) and 2014 (crypto) to November 2026. Rules were fixed before testing. Every trade pays commission plus slippage (one tick a side on micro futures, 0.3 to 0.6 bp on forex, 0.6% plus 2 bp on crypto). ' +
      '"Held up" needs a trade t-stat of at least 2.5, profits both before and after 2020 (2020 to 2026 was held back as an out-of-sample check), profit in at least 60% of years, 50 or more trades, and profit with costs doubled. "Mixed" is positive since 2020 with a t-stat of 1.5 or more. The Deflated Sharpe (Bailey and L&oacute;pez de Prado) asks whether the best of ' + RS.trials + ' tries would look this good by chance. Past results do not predict future results. Full notes are in RESEARCH.md.</p>';
    Icons.hydrate($('researchBody'));
    $('researchBody').querySelectorAll('.rs-filters .chip').forEach((b) => b.addEventListener('click', () => { rsf[b.dataset.k] = b.dataset.v; renderResearch(); }));
    renderRsTable();
  }
  function renderRsTable() {
    let rows = RS.strategies.filter((s) => (rsf.verdict === 'all' || s.verdict === rsf.verdict) && (rsf.market === 'all' || s.market === rsf.market));
    const key = rsf.sort;
    rows = rows.slice().sort((a, b) => {
      if (key === 'verdict') return (VORDER[a.verdict] - VORDER[b.verdict]) || (b.sharpe - a.sharpe);
      if (key === 'name') return rsf.dir * a.name.localeCompare(b.name);
      return rsf.dir * (b[key] - a[key]);
    });
    const cols = [['name', 'Strategy'], ['market', 'Market and bars'], ['tradesPerYear', 'Trades/yr', 'r'], ['netBp', 'Net/trade', 'r'], ['sharpe', 'Sharpe', 'r'], ['tStat', 't-stat', 'r'], ['pctYearsPositive', 'Yrs up', 'r'], ['oosExp', 'Since 2020', 'r'], ['verdict', 'Verdict']];
    const sortable = new Set(['name', 'tradesPerYear', 'netBp', 'sharpe', 'tStat', 'pctYearsPositive', 'verdict']);
    if (!rows.some((s) => s.id === rsf.sel)) rsf.sel = rows[0] && rows[0].id;
    $('rsTable').innerHTML = '<table class="grid num"><thead><tr>' + cols.map((c) => '<th class="' + (c[2] || '') + (rsf.sort === c[0] ? ' sorted' : '') + '" data-k="' + c[0] + '"' + (sortable.has(c[0]) ? ' title="Sort"' : '') + '>' + c[1] + (rsf.sort === c[0] && c[0] !== 'verdict' ? (rsf.dir > 0 ? ' ▾' : ' ▴') : '') + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map((s) => '<tr data-id="' + esc(s.id) + '"' + (s.id === rsf.sel ? ' class="sel"' : '') + '><td><b>' + esc(s.name) + '</b></td><td>' + esc(MKT_SHORT[s.market]) + ' <span style="color:var(--muted)">' + esc(RTF[s.tf] || s.tf) + '</span></td><td class="r">' + s.tradesPerYear.toFixed(s.tradesPerYear < 10 ? 1 : 0) + '</td><td class="r ' + cls(s.netBp) + '">' + (s.netBp >= 0 ? '+' : '') + s.netBp.toFixed(1) + ' bp</td><td class="r ' + cls(s.sharpe) + '">' + s.sharpe.toFixed(2) + '</td><td class="r">' + s.tStat.toFixed(1) + '</td><td class="r">' + s.pctYearsPositive + '%</td><td class="r ' + cls(s.oosExp) + '">' + (s.oosExp > 0 ? '▲ up' : '▼ down') + '</td><td>' + vpill(s.verdict) + '</td></tr>').join('') +
      '</tbody></table>' + (rows.length ? '' : '<div class="empty" style="height:120px">No tests match these filters.</div>');
    $('rsTable').querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.k; if (!sortable.has(k)) return;
      if (rsf.sort === k) rsf.dir = -rsf.dir; else { rsf.sort = k; rsf.dir = 1; }
      Sound.play('tick'); renderRsTable();
    }));
    $('rsTable').querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => { rsf.sel = tr.dataset.id; $('rsTable').querySelectorAll('tbody tr').forEach((x) => x.classList.toggle('sel', x === tr)); Sound.play('tick'); renderRsDetail(); });
    });
    renderRsDetail();
  }
  function yearBars(byYear, holdout) {
    const ys = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    if (!ys.length) return '';
    const W = 330; const H = 104; const top = 6; const bottom = 16;
    const max = Math.max(1e-9, ...ys.map((y) => Math.abs(byYear[y])));
    const zero = top + (H - top - bottom) / 2; const half = (H - top - bottom) / 2;
    const step = W / ys.length; const bw = Math.max(2, Math.min(14, step - 2));
    let out = '<svg class="ybars" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Result by year">';
    const hi = ys.indexOf(holdout);
    if (hi > 0) out += '<rect x="' + (hi * step).toFixed(1) + '" y="0" width="' + (W - hi * step).toFixed(1) + '" height="' + (H - bottom + 2) + '" fill="' + alpha(Theme.pal.a2, 0.07) + '" rx="4"/><text x="' + (hi * step + 4).toFixed(1) + '" y="9">since ' + holdout + '</text>';
    out += '<line x1="0" x2="' + W + '" y1="' + zero + '" y2="' + zero + '" stroke="' + Theme.ink(0.18) + '" stroke-width="1"/>';
    ys.forEach((y, k) => {
      const v = byYear[y]; const h = Math.max(1, Math.abs(v) / max * half);
      const x = k * step + (step - bw) / 2;
      out += '<rect x="' + x.toFixed(1) + '" y="' + (v >= 0 ? zero - h : zero).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + (v >= 0 ? Theme.pal.up : Theme.pal.down) + '"><title>' + y + ': ' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</title></rect>';
    });
    const labs = [ys[0], ys[ys.length - 1]];
    labs.forEach((y, k) => { out += '<text x="' + (k ? W : 0) + '" y="' + H + '" text-anchor="' + (k ? 'end' : 'start') + '">' + y + '</text>'; });
    return out + '</svg>';
  }
  function renderRsDetail() {
    const s = RS.strategies.find((x) => x.id === rsf.sel);
    const box = $('rsDetail');
    if (!s) { box.innerHTML = '<div class="empty" style="height:200px">Pick a row.</div>'; return; }
    const cat = st.catalog.strategies.find((x) => x.id === s.strategy);
    const appTf = s.tf === '5m_rth' ? '5m' : s.tf === '5m_pit' ? null : s.tf.toUpperCase();
    const inApp = cat && appTf && APP_SYMS[s.market];
    const kv = (k, v, c) => '<div><span>' + k + '</span><b class="num ' + (c || '') + '">' + v + '</b></div>';
    box.innerHTML = '<h4><span>' + esc(s.name) + '</span>' + vpill(s.verdict) + '</h4>' +
      '<div class="sub">' + esc(s.marketLabel) + ' · ' + esc(RTF[s.tf] || s.tf) + ' · ' + s.from + ' to ' + s.to + ' · ' + s.trades.toLocaleString('en-US') + ' trades</div>' +
      yearBars(s.byYear, Number(String(RS.holdoutFrom).slice(0, 4))) +
      '<div class="ycap">Result by year at the research\'s position sizing. Hover a bar for the number.</div>' +
      '<div class="rs-kv">' +
      kv('Win rate', s.winRate.toFixed(0) + '%') + kv('Before costs', (s.grossBp >= 0 ? '+' : '') + s.grossBp.toFixed(1) + ' bp', cls(s.grossBp)) + kv('After costs', (s.netBp >= 0 ? '+' : '') + s.netBp.toFixed(1) + ' bp', cls(s.netBp)) +
      kv('Sharpe (yearly)', s.sharpe.toFixed(2), cls(s.sharpe)) + kv('t-stat', s.tStat.toFixed(2)) + kv('Deflated Sharpe', s.dsr.toFixed(2)) +
      kv('Before 2020', s.isExp > 0 ? '▲ profitable' : '▼ losing', cls(s.isExp)) + kv('Since 2020', s.oosExp > 0 ? '▲ profitable' : '▼ losing', cls(s.oosExp)) + kv('Years up', s.pctYearsPositive + '%') +
      '</div>' +
      (s.robust ? '<div class="rs-robust"><b>Stress tests</b><ul>' +
        '<li>' + s.robust.positive + ' of ' + s.robust.variants + ' nearby settings made money (' + s.robust.strong + ' with a t-stat of 2+ and profit since 2020). Sharpe ranged ' + s.robust.worstSharpe.toFixed(2) + ' to ' + s.robust.bestSharpe.toFixed(2) + '.</li>' +
        '<li>' + (s.robust.negWindows ? s.robust.negWindows + ' of ' + s.robust.windows + ' rolling 5-year stretches lost money' : 'Made money in all ' + s.robust.windows + ' rolling 5-year stretches') + (s.robust.worstWindow ? '; the worst was ' + s.robust.worstWindow.from + '–' + s.robust.worstWindow.to + ' (Sharpe ' + s.robust.worstWindow.sharpe.toFixed(2) + ')' : '') + '.</li>' +
        '<li>Net per trade with costs doubled: ' + (s.robust.net2x >= 0 ? '+' : '') + s.robust.net2x.toFixed(1) + ' bp; tripled: ' + (s.robust.net3x >= 0 ? '+' : '') + s.robust.net3x.toFixed(1) + ' bp.</li></ul></div>' : '') +
      (s.financing ? '<p class="rs-fin">' + Icons.ico('bolt') + '<span>At a CFD prop firm: held ' + s.financing.nights.toFixed(1) + ' nights on average, so overnight financing costs about ' + s.financing.finBp.toFixed(1) + ' bp a trade' + (s.market === 'BTC' || s.market === 'ETH' ? ' at 10% a year' : '') + ', leaving ' + (s.financing.netAfterBp >= 0 ? '+' : '') + s.financing.netAfterBp.toFixed(1) + ' bp' + (s.financing.crypto20AfterBp != null ? ' (' + (s.financing.crypto20AfterBp >= 0 ? '+' : '') + s.financing.crypto20AfterBp.toFixed(1) + ' bp at 20%)' : '') + '.</span></p>' : '') +
      '<p class="desc">' + esc(cat ? cat.summary : RS_EXTRA[s.strategy] || '') + '</p>' +
      '<div class="rs-inapp">' + Icons.ico(inApp ? 'check' : 'info') + '<span>' + (inApp
        ? 'In PaperDesk on ' + esc(APP_SYMS[s.market]) + ', ' + appTf + ' chart. ' + (s.verdict === 'fails' ? 'Its trade ideas are marked down and carry a warning.' : s.verdict === 'holds' ? 'Its trade ideas get a higher grade.' : 'Its trade ideas get a small boost.')
        : CFD_NAME[s.market] ? 'Research only: PaperDesk has no live ' + esc(MKT_SHORT[s.market]) + ' chart. CFD prop firms usually list it as ' + CFD_NAME[s.market] + '. This test checks whether a rule found on US indexes also works abroad.'
        : 'Not in PaperDesk' + (s.verdict === 'fails' ? ': it failed.' : '.')) + '</span></div>';
    Icons.hydrate(box);
  }

  async function openProp() {
    openModal('propModal');
    const body = $('propBody');
    if (!RS) body.innerHTML = '<div class="empty" style="height:220px"><div class="spinner"></div></div>';
    try { await loadResearch(); } catch (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
    renderProp();
  }
  let propSel = 'ftmo_2step_100k';
  const PB_NAMES = { rsi2: 'RSI(2)', ibs: 'IBS', month_end_rebal: 'month-end', turn_of_month: 'turn of the month', turtle: 'Turtle', donchian55: 'Turtle 55/20' };
  const PB_MKT = { ES: 'S&amp;P', NQ: 'Nasdaq', RUT: 'Russell 2000', DAX: 'DAX', FTSE: 'FTSE', BTC: 'Bitcoin daily', USDJPY: 'USD/JPY hourly', GC: 'gold' };
  // "RSI(2) on S&P and Nasdaq, IBS on Nasdaq, ..." from the playbook's strategy ids
  function playbookList() {
    const by = new Map();
    for (const id of RS.playbook.ids) { const [sid, m] = id.split('|'); if (!by.has(sid)) by.set(sid, []); by.get(sid).push(PB_MKT[m] || m); }
    const join = (a) => (a.length < 2 ? a[0] : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
    return [...by].map(([sid, ms]) => (PB_NAMES[sid] || sid) + ' on ' + join(ms)).join(', ');
  }
  // the personal daily stop as a share of the firm's daily limit (round 17: 70%)
  function stopShare() { return (RS && RS.playbook && RS.playbook.selfStopShare) || 0.7; }
  function stopShareText() { const s = stopShare(); return s === 0.5 ? 'half' : Math.round(s * 100) + '%'; }
  // what the personal stop did (2-step, 0.3% risk): round 17 compared it with no stop on the current mix
  function stopClaim() {
    const sl = RS && RS.playbook && RS.playbook.stopLevel && RS.playbook.stopLevel.firms.ftmo_2step_100k;
    const k = String(stopShare());
    if (sl && sl[k] && sl.none) return ': on the FTMO-style 2-step at 0.3% risk it cut failures from ' + Math.round(sl.none.playbook.fail * 100) + '% to ' + Math.round(sl[k].playbook.fail * 100) + '% and lifted passes from ' + Math.round(sl.none.playbook.pass * 100) + '% to ' + Math.round(sl[k].playbook.pass * 100) + '%';
    const a = RS && RS.playbook && RS.playbook.ablation && RS.playbook.ablation.ftmo_2step_100k && RS.playbook.ablation.ftmo_2step_100k['0.003'];
    return a ? ': on the FTMO-style 2-step at 0.3% risk it cut failures from ' + Math.round(a.plain.fail * 100) + '% to ' + Math.round(a.stopOnly.fail * 100) + '% and lifted passes from ' + Math.round(a.plain.pass * 100) + '% to ' + Math.round(a.stopOnly.pass * 100) + '%' : '';
  }
  function leverText() {
    const a = RS.playbook.ablation && RS.playbook.ablation.ftmo_2step_100k && RS.playbook.ablation.ftmo_2step_100k['0.003'];
    if (!a) return '';
    const pc = (v) => Math.round(v * 100) + '%';
    return 'On the 2-step at 0.3% risk, the personal stop alone moved passes from ' + pc(a.plain.pass) + ' to ' + pc(a.stopOnly.pass) + ' and failures from ' + pc(a.plain.fail) + ' to ' + pc(a.stopOnly.fail) + '; the old limit of 2 stock-index trades alone gave ' + pc(a.capOnly.pass) + ' and ' + pc(a.capOnly.fail) + '; both together ' + pc(a.both.pass) + ' and ' + pc(a.both.fail) + (RS.playbook.capRule && RS.playbook.capRule.id !== 'cap2' ? ' (measured with the earlier stop at half the firm\'s limit, before round 9 widened the position limit)' : '') + '.';
  }
  // the playbook's limit on open stock-index trades (round 9 widened it from 2 to 3, at most 2 US)
  function capRule() { return (RS && RS.playbook && RS.playbook.capRule) || { id: 'cap2', maxIndex: 2, maxUs: 2, text: 'at most 2 stock-index trades at once' }; }
  function capText() { return capRule().text; }
  let propSelfStop = pref('selfStop', true);
  function renderPlaybook() {
    const box = $('ppPlay');
    const pb = RS.playbook && RS.playbook.presets[propSel];
    const preset = PRESETS.find((p) => p.id === propSel);
    if (!pb) {
      box.innerHTML = '<div class="pp-verdict bad">' + Icons.ico('alert') + '<div><b>Our verdict for this firm: no tested strategy beat luck.</b> It only allows intraday trading, and every intraday strategy we tested lost money after futures costs. Its pass rates below sit at or under the coin flip and edge-removed baselines. If you buy this challenge, you are mostly paying for a lottery ticket.</div></div>';
      Icons.hydrate(box); return;
    }
    const pc = (v) => (v == null ? '-' : Math.round(v * 100) + '%');
    const mo = (d) => (d == null ? '-' : (d / 30.4).toFixed(0) + ' mo');
    const rs = Object.keys(pb.playbook);
    // highlight the risk level that paid the most per attempt at half edge, through the funded year
    // (without funded data: the one that beat the edge-removed baseline by the widest margin)
    const fd = RS.playbook.funded && RS.playbook.funded[preset.id];
    const edge = (r) => (fd && fd[r] && fd[r].halfEdgeEv != null ? fd[r].halfEdgeEv : (pb.playbook[r].pass - pb.playbook[r].noEdge) * 1e4);
    const best = rs.reduce((a, r) => (edge(r) > edge(a) ? r : a), rs[0]);
    box.innerHTML = '<div class="pp-verdict good">' + Icons.ico('trophy') + '<div><b>Best approach we found for this firm:</b> trade the ' + RS.playbook.ids.length + ' strategies that held up (' + playbookList() + '), ' + capText() + ', a personal daily stop at ' + stopShareText() + ' of the firm\'s ' + money(preset.dailyLoss.amount, 0) + ' limit, and ' + (Number(best) * 100).toFixed(1).replace(/\.0$/, '') + '% risk per trade. ' +
      'Simulated day by day with every open position counted together and overnight gaps included, it passed <b>' + pc(pb.playbook[best].pass) + '</b> of attempts within a year from 1990 to 2026 (' + pc(pb.playbook[best].recent) + ' since 2020) and failed ' + pc(pb.playbook[best].fail) + ', against ' + pc(pb.playbook[best].noEdge) + ' passing with the edge removed.' + (RS.playbook.financing ? ' Overnight financing on CFDs is charged.' : '') + ' It is slow: the median pass took ' + mo(pb.playbook[best].medCalendarDays) + '. Lower risk fails less but takes longer; higher risk fails more.</div></div>' +
      '<table class="grid num pp-mini"><thead><tr><th>Risk per trade</th><th class="r">Pass, plain</th><th class="r">Pass, playbook</th><th class="r">Since 2020</th><th class="r">Failed</th><th class="r">Still going after a year</th><th class="r">Luck only</th><th class="r">Median time to pass</th></tr></thead><tbody>' +
      rs.map((r) => { const x = pb.playbook[r]; const y = pb.plain[r]; return '<tr' + (r === best ? ' class="sel"' : '') + '><td>' + (Number(r) * 100).toFixed(1).replace(/\.0$/, '') + '%</td><td class="r">' + pc(y.pass) + '</td><td class="r"><b>' + pc(x.pass) + '</b></td><td class="r">' + pc(x.recent) + '</td><td class="r down-t">' + pc(x.fail) + '</td><td class="r">' + pc(x.timeout) + '</td><td class="r">' + pc(x.noEdge) + '</td><td class="r">' + mo(x.medCalendarDays) + '</td></tr>'; }).join('') +
      '</tbody></table><p class="fine" style="margin:6px 2px 0">"Plain" is the same ' + RS.playbook.ids.length + ' strategies with no position cap and no personal stop. ' + leverText() + ' This firm has no time limit, so "still going" attempts had not passed or failed after a year. The app\'s trade ideas size by stop distance; these tests size RSI(2), IBS and month-end by volatility, as their papers do, so a typical day\'s move costs about twice the risk figure.</p>' +
      capHtml(preset) + fundedHtml(preset, best) + planHtml(preset) + testedHtml(preset);
    Icons.hydrate(box);
  }
  function presetRules(p) {
    const m = (v) => '$' + v.toLocaleString('en-US');
    const r = [];
    r.push(p.phases.length > 1 ? 'Targets +' + p.phases.map((x) => m(x.target)).join(', then +') + ' (two phases)' : 'Target +' + m(p.phases[0].target) + ' on ' + m(p.startBalance));
    const ml = p.maxLoss;
    r.push('Max loss ' + m(ml.amount) + (ml.type === 'static' ? ' below the start (fixed)' : ml.type === 'trailing_eod' ? ', trailing your best end-of-day balance' + (ml.lockAt ? ', stops trailing at ' + m(ml.lockAt) : '') : ', trailing your best open profit' + (ml.lockAt ? ', stops at ' + m(ml.lockAt) : '')));
    if (p.dailyLoss) r.push('Daily loss ' + m(p.dailyLoss.amount) + (p.dailyLoss.onBreach === 'fail' ? ': fails the challenge' : ': pauses the rest of the day'));
    else r.push('No daily loss limit');
    const md = p.phases[0].minDays;
    r.push((md ? 'At least ' + md + ' trading day' + (md > 1 ? 's' : '') : 'No minimum days') + (p.maxCalendarDays ? ', within ' + p.maxCalendarDays + ' calendar days' : ', no time limit'));
    if (p.consistency) r.push('Best day under ' + Math.round(p.consistency.maxDayShare * 100) + '% of profit' + (p.consistency.mode === 'raise_target' ? ' (a bigger day raises the target)' : ' to pass'));
    r.push(p.intradayOnly ? 'Intraday only: flat by ' + p.flatBy : 'Overnight and weekend holds allowed' + (p.fundedWeekend ? ' in the challenge' : ''));
    if (p.fundedWeekend) r.push(p.fundedWeekend);
    return r;
  }
  function propRowName(p) {
    if (p.kind === 'baseline') return '<span class="rowname"><b>Coin flip</b><small>one random 1R trade a day: no edge</small></span>';
    if (p.id === 'mix_holds_up') return '<span class="rowname"><b>Mix of the ' + RS.playbook.ids.length + ' that held up</b>' + vpill('holds') + '</span>';
    if (p.id === 'mix_index_daily') return '<span class="rowname"><b>Mix of index daily strategies</b><small>RSI(2), IBS, month-end</small></span>';
    const [, mk, tf] = p.id.split('|');
    return '<span class="rowname"><b>' + esc(p.name) + '</b><small>' + esc(MKT_SHORT[mk] + ' ' + (RTF[tf] || tf)) + '</small>' + (p.verdict ? vpill(p.verdict) : '') + '</span>';
  }
  function renderProp() {
    const presetsHtml = PRESETS.map((p) => '<div class="pp-card' + (p.id === propSel ? ' sel' : '') + '" data-id="' + p.id + '"><div class="pp-top"><span>' + (p.group === 'futures' ? 'Futures · intraday' : 'Forex/CFD · overnight OK') + '</span><span class="num">$' + (p.startBalance / 1000) + 'K</span></div>' +
      '<h4>' + esc(p.label) + '</h4><ul>' + presetRules(p).map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
      '<div class="pp-foot"><span class="pp-fee" title="' + esc(p.source) + '">' + esc(p.fee.text) + '</span><button class="pp-start" data-id="' + p.id + '" data-sound="none">Practise it</button></div></div>').join('');
    $('propBody').innerHTML =
      '<p class="pp-intro">Prop firms sell evaluations: hit a profit target without breaking their loss rules and you get a funded account. By the firms\' own numbers <b>about 14 to 20% of attempts pass</b> and only about 7% of accounts ever get a payout (FPFX Tech, 300,000 accounts). Below are the rules of six popular challenge types, then how often each tested strategy <b>would have passed</b> if you started a fresh attempt every 5th trading day. ' +
      '<b>Practise it</b> starts a paper version with the same rules; your normal paper account is parked and comes back when you leave.</p>' +
      '<label class="pp-opt"><input type="checkbox" id="ppSelfStop"' + (propSelfStop ? ' checked' : '') + '><span></span><div><b>Add my own daily stop at ' + stopShareText() + ' of the firm\'s daily limit</b><small>Recommended. In our day-by-day tests this was the biggest single improvement' + stopClaim() + '. When hit, it closes your trades and pauses you until the next session.</small></div></label>' +
      '<div class="pp-today" id="ppToday"></div>' +
      '<div class="pp-cards">' + presetsHtml + '</div><div class="pp-play" id="ppPlay"></div><div class="pp-rates" id="ppRates"></div>';
    $('propBody').querySelectorAll('.pp-card').forEach((c) => c.addEventListener('click', (e) => {
      if (e.target.closest('.pp-start')) return;
      propSel = c.dataset.id; Sound.play('toggle');
      $('propBody').querySelectorAll('.pp-card').forEach((x) => x.classList.toggle('sel', x === c));
      renderPropRates();
    }));
    $('propBody').querySelectorAll('.pp-start').forEach((b) => b.addEventListener('click', () => startChallenge(b.dataset.id, b)));
    $('ppSelfStop').addEventListener('change', (e) => { propSelfStop = e.target.checked; setPref('selfStop', propSelfStop); Sound.play('toggle'); });
    renderPropRates();
    renderToday();
  }
  // What the research playbook says today, from live prices (paper trading only)
  let todayCache = null;
  async function renderToday(force) {
    const box = $('ppToday'); if (!box) return;
    const fresh = todayCache && Date.now() - todayCache.at < 5 * 60 * 1000;
    if (!fresh || force) {
      box.innerHTML = '<div class="pt-head">' + Icons.ico('target') + '<b>Playbook today</b><span>Checking live prices…</span></div>';
      Icons.hydrate(box);
      try { todayCache = { at: Date.now(), data: await Api.call('playbookToday', {}) }; } catch (e) { box.innerHTML = '<div class="pt-head">' + Icons.ico('alert') + '<b>Playbook today</b><span>' + esc(e.message) + '</span></div>'; Icons.hydrate(box); return; }
      if (!$('ppToday')) return;
    }
    const day = (t) => new Date(t * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const px = (r, v) => (v == null ? '-' : Number(v).toFixed(r.decimals == null ? 2 : r.decimals));
    const rows = todayCache.data.rows;
    const order = { signal: 0, in: 1, none: 2, error: 3 };
    const sorted = rows.slice().sort((a, b) => order[a.state] - order[b.state]);
    const pill = (r) => (r.state === 'signal' ? '<span class="pt-pill sig">' + (r.dir > 0 ? 'Buy signal' : 'Sell signal') + '</span>'
      : r.state === 'in' ? '<span class="pt-pill in">' + (r.exitNow ? 'Exit now' : r.dir > 0 ? 'In a long' : 'In a short') + '</span>'
        : r.state === 'error' ? '<span class="pt-pill err">No data</span>' : '<span class="pt-pill wait">Waiting</span>');
    const detail = (r) => {
      if (r.state === 'signal') return (r.dir > 0 ? 'Buy' : 'Sell short') + ' at the next open. ' + esc(r.why || '');
      if (r.state === 'in') return (r.exitNow ? 'Its exit rule fired at the last close, so the trade ends at the next open. ' : '') + 'Entered ' + day(r.since) + ' at ' + px(r, r.entry) + ', stop ' + px(r, r.stop) + '. ' + esc(r.exitText || '');
      if (r.state === 'error') return esc(r.text || 'Could not load prices.');
      if (r.next) return 'Next entry: the open on ' + day(r.next) + ' (counting weekdays; a market holiday moves it).';
      return esc(r.near || 'No signal at the last close.');
    };
    const live = rows.filter((r) => r.state === 'signal' || r.state === 'in').length;
    // the cap counts stock-index trades: US ones from SPY, QQQ and IWM, plus the DAX and FTSE when turn of the month is on
    const cr = capRule();
    const act = (r) => r.state === 'signal' || (r.state === 'in' && !r.exitNow);
    const usLive = rows.filter((r) => ['SPY', 'QQQ', 'IWM'].includes(r.symbol) && act(r)).length;
    const euLive = rows.some((r) => r.strategy === 'turn_of_month' && act(r)) ? 2 : 0;
    const idxLive = Math.min(usLive, cr.maxUs) + euLive;
    const capWarn = (usLive > cr.maxUs ? ' <b>' + usLive + ' US stock-index rules are active, so take only the first ' + cr.maxUs + '.</b>' : '') +
      (idxLive > cr.maxIndex ? ' <b>With the DAX and FTSE turn-of-the-month trades that makes ' + idxLive + ' stock-index trades. Keep any already open, give new room to the US trades first, and skip the rest.</b>' : '');
    box.innerHTML = '<div class="pt-head">' + Icons.ico('target') + '<b>Playbook today</b><span>' + (live ? live + ' of ' + rows.length + ' rules active' : 'No rule active') + ' · prices as of ' + new Date(todayCache.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '</span><button class="pt-refresh" id="ptRefresh" title="Check again">' + Icons.ico('refresh') + '</button></div>' +
      '<p class="pt-sub">The ' + rows.length + ' playbook rules PaperDesk can follow live (turn of the month also stands for the DAX and FTSE). Practise them on paper: about 0.3% risk a trade, at most ' + cr.maxIndex + ' stock-index trades open' + (cr.maxIndex > cr.maxUs ? ' with no more than ' + cr.maxUs + ' in US indexes (the DAX and FTSE count toward the ' + cr.maxIndex + '; on a busy day the US trades get the room first)' : '') + ', and stop for the day at half the daily limit.' + capWarn + '</p>' +
      '<div class="pt-rows">' + sorted.map((r) => '<div class="pt-row ' + r.state + '"><div class="pt-name"><b>' + esc(r.name || r.strategy) + '</b><small>' + esc(r.market) + ' · ' + esc(r.symbol.replace('-USD', '')) + ' ' + (r.tf === '1d' ? '1D' : r.tf.toUpperCase()) + ' · ' + esc(r.cfd) + ' at a CFD firm</small></div>' + pill(r) + '<div class="pt-detail">' + detail(r) + '</div>' +
        (r.state !== 'error' ? '<button class="pt-open" data-sym="' + esc(r.symbol) + '" data-tf="' + esc(r.tf) + '">Open chart</button>' : '<span></span>') + '</div>').join('') + '</div>';
    Icons.hydrate(box);
    $('ptRefresh').addEventListener('click', () => { Sound.play('toggle'); renderToday(true); });
    box.querySelectorAll('.pt-open').forEach((b) => b.addEventListener('click', () => { closeModal('propModal'); selectSymbol(b.dataset.sym, b.dataset.tf); }));
  }
  // Round 9: the old limit of 2 stock-index trades crowded out the European trades
  const CAP_LABEL = { cap2: 'At most 2 (old playbook)', cap2market: 'At most 2, one per index', cap2region: 'At most 1 US and 1 European', cap3: 'At most 3', cap3region: 'At most 3, no more than 2 US (new playbook)', cap2noTomRut: 'At most 2, without turn of the month on the Russell 2000' };
  // Round 10: neighbouring limits, and which trade gets the slot on a busy day
  function orderNote(preset) {
    const c = RS.playbook.capCheck && RS.playbook.capCheck.firms[preset.id];
    if (!c) return '';
    const usd = (v) => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
    const pc = (v) => Math.round(v * 100) + '%';
    const o = c.order.old; const n = c.order.new;
    const d = n.random.halfLate - o.random.halfLate;
    const late = d > 100 ? 'and from 2008 on too (' + usd(n.random.halfLate) + ' against ' + usd(o.random.halfLate) + ')'
      : d < -100 ? 'but from 2008 on the old limit did better (' + usd(o.random.halfLate) + ' against ' + usd(n.random.halfLate) + ')'
        : 'but from 2008 on the two were about even (' + usd(n.random.halfLate) + ' and ' + usd(o.random.halfLate) + ')';
    const me = c.neighbors.n3us2;
    const nb = Object.entries(c.neighbors).filter(([k]) => k !== 'n3us2' && k !== 'none').map(([, x]) => x);
    const top = nb.reduce((a, x) => (x.halfEdgeEv > a.halfEdgeEv ? x : a), nb[0]);
    const lim = (x) => 'at most ' + x.n + (x.u < x.n ? ' with no more than ' + x.u + ' US' : '');
    const nbTxt = top.halfEdgeEv >= me.halfEdgeEv ? lim(top) + ' did a little better here (' + usd(top.halfEdgeEv) + ' against ' + usd(me.halfEdgeEv) + ' at half edge), so the exact limit is not critical'
      : me.halfEdgeEv > top.halfEdgeEv * 1.3 ? 'the new limit stood well above every other limit we tried here (next best ' + usd(top.halfEdgeEv) + ', ' + lim(top) + ', against ' + usd(me.halfEdgeEv) + '), which looks more like luck than a smooth effect, so expect less'
        : 'the nearest other limits did nearly as well here (next best ' + usd(top.halfEdgeEv) + ', ' + lim(top) + ', against ' + usd(me.halfEdgeEv) + '), so the choice is not a knife edge';
    return '<p class="pf-note">' + Icons.ico('shield') + '<span><b>Round 10 check: part of that jump came from the simulator\'s order.</b> On a busy day the simulator always gave the slot to US trades first, which hurt the old limit. With the order on busy days shuffled at random ' + n.random.n + ' times, the new limit still came out ahead on average: it passed ' + pc(n.random.pass) + ' against ' + pc(o.random.pass) + ', and made ' + usd(n.random.halfEdgeEv) + ' against ' + usd(o.random.halfEdgeEv) + ' per attempt at half edge, ' + late + '. ' +
      (n.random.luckEv <= o.random.luckEv + 50 ? 'Shuffled, the no-edge trader did not gain (' + usd(n.random.luckEv) + ' against ' + usd(o.random.luckEv) + '), so that gain is not just more trading. ' : 'Shuffled, the no-edge trader gained a little too (' + usd(n.random.luckEv) + ' against ' + usd(o.random.luckEv) + '). ') +
      'Giving the DAX and FTSE trades the slots first did worse (' + usd(n.euFirst.halfEdgeEv) + '), so on a busy day give the room to US trades first. Among limits of 2 to 4 trades, ' + nbTxt + '.</span></p>';
  }
  function capHtml(preset) {
    const cs = RS.playbook.capStudy; const f = cs && cs.firms[preset.id];
    if (!f || !f.before || !f.after || capRule().id === 'cap2') return '';
    const pc = (v) => (v == null ? '-' : Math.round(v * 100) + '%');
    const usd = (v) => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
    const th = (n) => n + (['th', 'st', 'nd', 'rd'][n] || 'th');
    const k2 = cs.kept[cs.oldId] || {}; const k3 = cs.kept[cs.newId] || {}; const tot = cs.total || {};
    const ftse = 'turn_of_month|FTSE|1d'; const dax = 'turn_of_month|DAX|1d';
    const crowd = tot[ftse] ? 'only ' + k2[ftse] + ' of ' + tot[ftse] + ' FTSE 100 and ' + k2[dax] + ' of ' + tot[dax] + ' DAX turn-of-the-month trades got in. The new limit lets in ' + k3[ftse] + ' and ' + k3[dax] + '.' : 'few of the FTSE 100 and DAX turn-of-the-month trades got in.';
    const ids = Object.keys(CAP_LABEL).filter((id) => f.rules[id]);
    const row = (id) => { const x = f.rules[id]; return '<tr' + (id === cs.newId ? ' class="sel"' : '') + '><td>' + CAP_LABEL[id] + '</td><td class="r"><b>' + pc(x.pass) + '</b></td><td class="r down-t">' + pc(x.fail) + '</td><td class="r">' + usd(x.ev) + '</td><td class="r"><b>' + usd(x.halfEdgeEv) + '</b></td><td class="r ' + (x.halfLate >= 0 ? 'up-t' : 'down-t') + '">' + usd(x.halfLate) + '</td><td class="r">' + usd(x.luckEv) + '</td></tr>'; };
    const wf = f.walkforward; const all3 = Object.values(cs.firms).every((x) => x.walkforward && x.walkforward.pick === cs.newId);
    const b = f.before; const a = f.after; const o = f.rules[cs.oldId]; const n = f.rules[cs.newId];
    const fair = wf && wf.pick === cs.newId
      ? 'Picking the rule on attempts started before 2008 chose this one' + (all3 ? ' for all three firms we tested' : '') + ', and from 2008 on it still beat the old limit at half edge (' + usd(wf.lateEv) + ' against ' + usd(wf.baseLateEv) + ' per attempt, ' + th(wf.rankLate) + ' of ' + wf.of + ' rules).'
      : 'Picking the rule on attempts started before 2008 chose a different one here, so treat this change as less certain for this firm.';
    const more = a.luckEv > b.luckEv
      ? 'As simulated above, part of the gain is simply more trading: with the edge removed, the average attempt also went from ' + usd(b.luckEv) + ' to ' + usd(a.luckEv) + (a.aheadLuck != null ? ' and three-year runs ahead from ' + pc(b.aheadLuck) + ' to ' + pc(a.aheadLuck) : '') + ', because the fee caps what you can lose.'
      : 'Here the no-edge trader did not gain (' + usd(b.luckEv) + ' to ' + usd(a.luckEv) + ' per attempt), so the gain is not just more trading.';
    const bigger = f.oldAt04 ? ' Taking more risk the other way, 0.4% a trade with the old limit, passed ' + pc(f.oldAt04.pass) + ' and failed ' + pc(f.oldAt04.fail) + ', so spreading over more markets beats bigger trades.' : '';
    return '<div class="pp-funded pp-cap">' +
      '<div class="pf-head">' + Icons.ico('lab') + '<b>Round 9: room for the European trades</b><span>Dropping each strategy in turn showed the old limit of 2 stock-index trades was the weak spot. US signals usually came first, so ' + crowd + ' All rows: 0.3% risk, one attempt every 5th trading day, a year funded after a pass.</span></div>' +
      '<table class="grid num pp-mini"><thead><tr><th>Limit on open stock-index trades</th><th class="r">Pass</th><th class="r">Failed</th><th class="r">Average per attempt</th><th class="r">Half edge</th><th class="r">Half edge, from 2008</th><th class="r">No edge</th></tr></thead><tbody>' +
      ids.map(row).join('') + '</tbody></table>' +
      '<p class="pf-note">' + Icons.ico('check') + '<span><b>What changed for you.</b> Pass rate ' + pc(o.pass) + ' to ' + pc(n.pass) + ', failures ' + (pc(o.fail) === pc(n.fail) ? 'about the same (' + pc(n.fail) + ')' : pc(o.fail) + ' to ' + pc(n.fail)) + ', average per attempt ' + usd(o.ev) + ' to ' + usd(n.ev) + ' (' + usd(o.halfEdgeEv) + ' to ' + usd(n.halfEdgeEv) + ' at half edge)' + (a.aheadHalf != null ? ', and three-year runs ahead at half edge ' + pc(b.aheadHalf) + ' to ' + pc(a.aheadHalf) : '') + '. ' + fair + '</span></p>' + orderNote(preset) +
      '<p class="pf-note">' + Icons.ico('alert') + '<span><b>Warnings.</b> ' + more + bigger + (a.fundedLost > b.fundedLost + 0.02 ? ' More trades also lose more funded accounts: ' + pc(a.fundedLost) + ' of passed accounts were lost within the year, up from ' + pc(b.fundedLost) + ', which is one more reason to trade smaller once funded.' : '') + ' And this idea came from looking at every year first, so the check from 2008 is not fully blind.' + (n.halfLate < o.halfLate ? ' For this firm the new limit did worse from 2008 at half edge.' : '') + '</span></p></div>';
  }
  // Round 3: what a challenge fee bought, following the playbook into the funded account
  function fundedHtml(preset, risk) {
    const f = RS.playbook.funded && RS.playbook.funded[preset.id] && RS.playbook.funded[preset.id][risk];
    if (!f) return '';
    const fr = RS.playbook.fundedRules[preset.id];
    const pc = (v) => Math.round(v * 100) + '%';
    const usd = (v) => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
    const fee = preset.fee.firstTry;
    const good = f.halfEdgeEv > 0;
    const wf = RS.playbook.walkforward && RS.playbook.walkforward[preset.id];
    return '<div class="pp-funded">' +
      '<div class="pf-head">' + Icons.ico('target') + '<b>After you pass: what a fee bought</b><span>Same playbook at ' + (Number(risk) * 100).toFixed(1).replace(/\.0$/, '') + '% risk, followed for a year in the funded account (' + Math.round(fr.split * 100) + '% of profit to you, a payout every 14 days or later when flat' + (fr.bestDayShare ? ', best day at most half the profit' : '') + (fr.refund ? ', fee refunded with the first payout' : ', fee not refunded') + ')</span></div>' +
      '<div class="pf-tiles">' +
        '<div><b class="num">' + pc(f.paidAny) + '</b><span>of attempts got at least one payout</span></div>' +
        '<div><b class="num">$' + f.medianPaidIfPaid.toLocaleString('en-US') + '</b><span>typical total paid out in that year, when paid</span></div>' +
        '<div><b class="num">' + pc(f.fundedBreach) + '</b><span>of passed accounts were lost within the year</span></div>' +
        '<div><b class="num ' + (f.ev >= 0 ? 'up-t' : 'down-t') + '">' + usd(f.ev) + '</b><span>average result per $' + fee + ' attempt, as backtested</span></div>' +
        '<div><b class="num ' + (f.halfEdgeEv >= 0 ? 'up-t' : 'down-t') + '">' + usd(f.halfEdgeEv) + '</b><span>if the edge is only half as big</span></div>' +
        '<div><b class="num ' + (f.luckEv >= 0 ? 'up-t' : 'down-t') + '">' + usd(f.luckEv) + '</b><span>with no edge at all</span></div>' +
      '</div>' +
      '<p class="fine" style="margin:8px 2px 0">' + (good
        ? 'Read it this way: ' + pc(1 - f.paidAny) + ' of attempts never got a payout, so the average comes from the ' + pc(f.paidAny) + ' that did. It stays positive if the strategies keep at least half their past edge. Published stock-market anomalies earned about 26% less out of sample and 58% less after publication (McLean and Pontiff 2016), so plan for the half-edge number or worse, not the backtested one. Before 2020 the average was ' + usd(f.evPre2020) + ', since 2020 ' + usd(f.evSince2020) + '.'
        : 'Read it this way: at this firm the average turns negative if the strategies keep only half their past edge, because the 3% daily limit and the best-day rule make payouts rarer. Published stock-market anomalies earned about 26% less out of sample and 58% less after publication (McLean and Pontiff 2016). The 2-step type held up better when the edge was halved.') +
      (wf ? ' Walk-forward check' + (capRule().id !== 'cap2' ? ' of the earlier settings (with the old limit of 2 stock-index trades)' : '') + ': settings chosen on years before 2008 and tested on 2008 to 2026 still passed ' + pc(wf[0].pick.testPass) + ' (luck ' + pc(wf[0].pick.testLuck) + ', and ' + pc(wf[0].plainSameRiskTestPass) + ' without the playbook). The exact best risk level did not carry over between periods, so the app uses a simple default rather than a tuned one.' : '') +
      ' Overlapping start dates are not independent, so treat every number here as rough.</p>' +
      weekendHtml(preset, risk) + confidenceHtml(preset, risk) + '</div>';
  }
  // Round 7: how much costs matter, and an idea that was tested and rejected
  function testedHtml(preset) {
    const cs = RS.playbook.costStress && RS.playbook.costStress[preset.id];
    const vx = RS.playbook.vix && RS.playbook.vix.firms[preset.id];
    const dd = RS.playbook.drawdown && RS.playbook.drawdown.firms[preset.id];
    if (!cs && !vx && !dd && !(RS.playbook.payout && RS.playbook.payout.firms[preset.id]) && !(RS.playbook.weights && RS.playbook.weights.firms[preset.id])) return '';
    const pc = (v) => Math.round(v * 100) + '%';
    const usd = (v) => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
    let h = '<div class="pp-funded pp-tested"><div class="pf-head">' + Icons.ico('lab') + '<b>Also tested</b><span>Same playbook at 0.3% risk' + (capRule().id !== 'cap2' ? '. The cost, payout, sizing and phase-size checks use the new limit of 3 stock-index trades; the VIX and drawdown checks ran with the old limit of 2, so their numbers differ a little from the ones above.' : '') + '</span></div>';
    if (cs) {
      h += '<p class="pf-note">' + Icons.ico('bolt') + '<span><b>Trading costs matter a lot.</b> With spreads, commissions and slippage doubled, it passed ' + pc(cs.double.pass) + ' instead of ' + pc(cs.base.pass) + ' (luck ' + pc(cs.double.luck) + '), the average per attempt fell from ' + usd(cs.base.ev) + ' to ' + usd(cs.double.ev) + ' (' + usd(cs.double.halfEdgeEv) + ' at half edge), and the three-year runs ahead at half edge fell from ' + pc(cs.base.aheadHalf) + ' to ' + pc(cs.double.aheadHalf) + '. Pick the tightest-spread instruments your firm offers, use limit orders where you can, and avoid thin markets.</span></p>';
    }
    if (vx) {
      const vs = Object.entries(vx.variants).filter(([k]) => k !== 'base');
      const base = vx.variants.base;
      const better = vs.filter(([, v]) => v.ev > base.ev && v.halfEdgeEv > base.halfEdgeEv).length;
      const wf = vx.walkforward;
      h += '<p class="pf-note">' + Icons.ico('alert') + '<span><b>Stepping back when markets panic did not help.</b> Skipping or halving stock-index trades when the VIX closed above 25, 30, 35 or 40 the day before: ' + (better ? better + ' of ' + vs.length + ' versions beat the plain playbook both as backtested and at half edge' : 'none of the ' + vs.length + ' versions beat the plain playbook both as backtested and at half edge') + '. The version that looked best on years before 2008 ranked ' + wf.rankLate + (['th', 'st', 'nd', 'rd'][wf.rankLate] || 'th') + ' of ' + wf.of + ' afterwards. Buying dips earns much of its edge right after panics, and the personal stop already removes almost every daily-limit failure (' + pc(base.dailyLossFails) + ' of attempts here), so the app does not use it.</span></p>';
    }
    const po = RS.playbook.payout && RS.playbook.payout.firms[preset.id];
    if (po && po['365/0.003']) {
      const y = po['365/0.003'].policies; const qs = Object.keys(y).map(Number).sort((a, b) => a - b); const base = y[qs[0]]; const hi = y[qs[qs.length - 1]];
      const wfs = Object.values(RS.playbook.payout.firms).flatMap((f) => Object.values(f).map((z) => z.walkforward));
      const picked0 = wfs.filter((w) => w.pick === 0).length;
      const better = qs.slice(1).filter((q) => y[q].halfEdgeEv > base.halfEdgeEv).length;
      h += '<p class="pf-note">' + Icons.ico('clock') + '<span><b>Take each payout as soon as you are allowed.</b> A payout resets the account to its start, so we tried waiting until the profit reached ' + qs.slice(1, -1).map((q) => Math.round(q * 100) + '%').join(', ') + ' or ' + Math.round(qs[qs.length - 1] * 100) + '% of the account, to keep it as a cushion. ' +
        (better ? better + ' of ' + (qs.length - 1) + ' waiting rules did a little better at half edge here, but ' : 'None of them did better at half edge here: ') + 'waiting for ' + Math.round(qs[qs.length - 1] * 100) + '% paid ' + usd(hi.halfEdgeEv) + ' per attempt against ' + usd(base.halfEdgeEv) + (pc(hi.fundedLost) === pc(base.fundedLost) ? ', and lost as many funded accounts (' + pc(base.fundedLost) + ')' : ', though it lost ' + pc(hi.fundedLost) + ' of funded accounts against ' + pc(base.fundedLost)) + '. ' +
        'Choosing on years before 2008, "every time" won in ' + picked0 + ' of ' + wfs.length + ' firm, risk and horizon combinations.</span></p>';
    }
    const wt = RS.playbook.weights && RS.playbook.weights.firms[preset.id];
    if (wt && wt.walkforward && wt.schemes.equal) {
      const w = wt.walkforward; const pk = wt.schemes[w.pick]; const eq = wt.schemes.equal;
      const allPick = Object.values(RS.playbook.weights.firms).every((f) => f.walkforward.pick === w.pick);
      const worse = Object.values(RS.playbook.weights.firms).filter((f) => f.walkforward.lateEv < f.walkforward.baseLateEv).length;
      if (w.pick !== 'equal') {
        h += '<p class="pf-note">' + Icons.ico('alert') + '<span><b>Giving more risk to the strategies that looked best did not carry over.</b> Sizing each strategy by how well it did before 2008 looked great on those years (' + usd(pk.halfEarly) + ' per attempt at half edge against ' + usd(eq.halfEarly) + ' with equal sizes) but made ' + usd(pk.halfLate) + ' from 2008 on, against ' + usd(eq.halfLate) + ' with equal sizes' + (allPick ? ', and it fell short like this at ' + worse + ' of ' + Object.keys(RS.playbook.weights.firms).length + ' firms' : '') + '. IBS on the Nasdaq-100 lost a little before 2008 and became one of the playbook\'s biggest earners after it, so the app keeps every strategy at the same size.</span></p>';
      }
    }
    if (dd && dd.threeYear) {
      const b = dd.variants.base; const q = dd.variants.quarter50; const t = dd.threeYear;
      const anyBetter = Object.entries(t).some(([k, v]) => k !== 'base' && v.halfAhead > t.base.halfAhead);
      h += '<p class="pf-note">' + Icons.ico('alert') + '<span><b>Trading smaller after a losing stretch did not pay either.</b> Cutting new trades to a quarter of the size once down half the maximum loss cut failed challenges from ' + pc(b.fail) + ' to ' + pc(q.fail) + ' and lost funded accounts from ' + pc(b.fundedLost) + ' to ' + pc(q.fundedLost) + '. But smaller trades climb back slowly, so fewer challenges passed and less was paid out: over three years of re-buying at half edge, ' + pc(t.quarter50.halfAhead) + ' of runs ended ahead, against ' + pc(t.base.halfAhead) + ' at a steady size' + (anyBetter ? '' : ', and none of the four versions we tried left more runs ahead') + '. Keep the size steady and let the daily stop do the protecting.</span></p>';
    }
    const pr = RS.playbook.phaseRisk && RS.playbook.phaseRisk.firms[preset.id];
    if (pr && pr.plans['0.3/0.3'] && pr.plans['0.3/0.2'] && pr.plans['0.3/0.4']) {
      const base = pr.plans['0.3/0.3'].halfEdge; const sm = pr.plans['0.3/0.2'].halfEdge; const bg = pr.plans['0.3/0.4'].halfEdge; const tiny = pr.plans['0.3/0.15'] && pr.plans['0.3/0.15'].halfEdge;
      const d = Math.max(Math.abs(sm.ev - base.ev), Math.abs(bg.ev - base.ev));
      const both = sm.threeYear > base.threeYear && bg.threeYear > base.threeYear ? 'both a smaller and a bigger phase 2 ended a little ahead' : sm.threeYear < base.threeYear && bg.threeYear < base.threeYear ? 'both a smaller and a bigger phase 2 ended a little behind' : 'one ended ahead and the other behind';
      const behind = sm.ev < base.ev && bg.ev < base.ev && sm.threeYear < base.threeYear && bg.threeYear < base.threeYear;
      h += '<p class="pf-note">' + Icons.ico('target') + '<span><b>' + (behind ? 'Keep 0.3% in phase 2 too.' : 'Phase 2 size made little difference.') + '</b> Phase 2 asks for only 5%, so we tried trading it at 0.15%, 0.2% or 0.4% instead of 0.3%. Per attempt at half edge, ' + (behind ? '0.2% and 0.4% both made less (' + usd(sm.ev) + ' and ' + usd(bg.ev) + ' against the playbook\'s ' + usd(base.ev) + ')' : '0.2% and 0.4% came within $' + Math.round(d).toLocaleString('en-US') + ' of the playbook\'s ' + usd(base.ev)) + '. Over three years of re-buying, ' + both + ' (' + usd(sm.threeYear) + ' and ' + usd(bg.threeYear) + ' against ' + usd(base.threeYear) + ')' + (behind ? ', so the app keeps 0.3% throughout.' : ', so neither direction stands out and the app keeps 0.3% throughout.') +
        (tiny && tiny.ev < base.ev - 100 ? ' Cutting phase 2 to 0.15% made less per attempt (' + usd(tiny.ev) + ').' : '') + ' A smaller phase 2 mostly makes passing slower: at 0.2%, ' + pc(sm.timeout) + ' of attempts had neither passed nor failed after a year, against ' + pc(base.timeout) + '.</span></p>';
    }
    const pb = RS.playbook.postPub;
    if (pb && pb.postAll && pb.postAll.n) {
      const st = pb.strategies; const rs = Object.entries(st).filter(([k]) => k.startsWith('rsi2|')); const ib = Object.entries(st).find(([k]) => k.startsWith('ibs|'));
      const rsiUp = rs.length && rs.every(([, x]) => x.after.mean > x.before.mean);
      h += '<p class="pf-note">' + Icons.ico('lab') + '<span><b>The rules kept working after they were published.</b> Published market patterns lose about half their edge after publication on average. ' + pc(pb.postShare) + ' of the playbook\'s trades came after their rule was public (turn of the month from 1988, Turtle from 2003, RSI(2) from 2008, IBS from 2013), and those trades made on average ' + Math.round(pb.postAll.mean * 100) + '% of the amount they risked, after costs and financing.' +
        (rsiUp ? ' RSI(2) did a little better after its 2008 book than before.' : '') + (ib && ib[1].before.mean < 0.01 && ib[1].after.mean > 0.02 ? ' IBS on the Nasdaq-100 made almost nothing before 2013 and earned its profit after.' : '') +
        ' This is not independent proof, because these 10 rules were picked for doing well over these same years. The month-end rebalancing rule was only published in 2025.</span></p>';
    }
    const sp = RS.playbook.stopSlip && RS.playbook.stopSlip.firms[preset.id];
    if (sp && sp['0'] && sp['0.001'] && sp['0.0025'] && sp['0.005']) {
      const z = sp['0'].halfEdge; const cl = RS.playbook.stopSlip.clipped && RS.playbook.stopSlip.clipped[preset.id] && RS.playbook.stopSlip.clipped[preset.id]['0'];
      const neg = sp['0.001'].halfEdge.threeLate < 0;
      h += '<p class="pf-note">' + Icons.ico('alert') + '<span><b>Make the daily stop fill cleanly.</b> In these tests the personal stop closed everything on about ' + Math.round(z.stopsPerYear) + ' days a year at this firm. If each of those exits filled 0.25% of the account worse than its level, the half-edge average per attempt fell from ' + usd(z.ev) + ' to ' + usd(sp['0.0025'].halfEdge.ev) + ' (0.1% worse: ' + usd(sp['0.001'].halfEdge.ev) + '; 0.5% worse: ' + usd(sp['0.005'].halfEdge.ev) + ')' +
        (neg ? ', and even 0.1% turned the three-year runs started from 2008 negative at half edge' : '') + '. Use an automatic close-all at your stop level rather than closing by hand in a fast market.' +
        (cl ? ' The simulator is a little pessimistic in another way (it counts prices reached after a trade was already stopped out); without that the half-edge average was ' + usd(cl.halfEdge.ev) + '.' : '') + '</span></p>';
    }
    // Round 17: where the personal stop should sit
    const sv = RS.playbook.stopLevel; const sf = sv && sv.firms[preset.id]; const sw = sv && sv.walkforward && sv.walkforward[preset.id];
    const ch = sv && String(stopShare());
    if (sf && sf['0.5'] && sf[ch] && sf.none && preset.dailyLoss) {
      const lv = ['0.5', '0.7', '0.8', '0.9'].filter((k) => sf[k]);
      const pcs = (k) => Math.round(Number(k) * 100) + '%';
      const buf = (1 - stopShare()) * preset.dailyLoss.amount / preset.startBalance * 100;
      h += '<p class="pf-note">' + Icons.ico('shield') + '<span><b>Why the daily stop sits at ' + pcs(ch) + ' of the firm\'s limit (round 17).</b> We moved the stop between ' + pcs(lv[0]) + ' and ' + pcs(lv[lv.length - 1]) + ' of the daily limit, and tried no stop. Per attempt at half edge at this firm: ' + lv.map((k) => pcs(k) + ' ' + usd(sf[k].halfEdge.ev)).join(', ') + ', no stop ' + usd(sf.none.halfEdge.ev) + '. A tight stop closes the day on dips that often recovered: at ' + pcs(ch) + ' it fired on about ' + Math.round(sf[ch].halfEdge.stopsPerYear) + ' days a year, against ' + Math.round(sf['0.5'].halfEdge.stopsPerYear) + ' at 50% (at half edge).' +
        (sw && sw.single ? ' Picked on years before 2008, the best level was ' + pcs(sw.single.pick) + (sw.single.late > sw.single.baseLate ? ', and it beat 50% from 2008 (' + usd(sw.single.late) + ' against ' + usd(sw.single.baseLate) + ')' : '') + '.' : '') +
        (sf[ch].luck.ev > sf['0.5'].luck.ev ? ' Part of the gain is just more room to swing: with the edge removed, the average also rose (' + usd(sf['0.5'].luck.ev) + ' to ' + usd(sf[ch].luck.ev) + ').' : '') +
        ' The app stops at ' + pcs(ch) + ' rather than higher to keep a buffer of ' + buf.toFixed(1) + '% of the account before the firm\'s limit, because these tests assume the stop fills at its level. ' + pc(sf[ch].halfEdge.dailyFail) + ' of half-edge attempts still failed on the firm\'s daily limit.</span></p>';
    }
    return h + '</div>';
  }
  // Round 6: a trader who keeps re-buying for three years, and what a second account adds
  function planHtml(preset) {
    const B = RS.playbook.budget && RS.playbook.budget.firms[preset.id];
    if (!B) return '';
    const pc = (v) => Math.round(v * 100) + '%';
    const usd = (v) => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
    const d = (v) => '$' + Math.round(v).toLocaleString('en-US');
    const rk = (v) => (v * 100).toFixed(1).replace(/\.0$/, '') + '%';
    const { base, push } = B.plans;
    const row = (label, p) => '<tr><td>' + label + '</td><td class="r"><b>' + pc(p.playbook.ahead) + '</b></td><td class="r"><b>' + pc(p.halfEdge.ahead) + '</b></td><td class="r">' + pc(p.luck.ahead) + '</td><td class="r ' + (p.halfEdge.medianNet >= 0 ? 'up-t' : 'down-t') + '">' + usd(p.halfEdge.medianNet) + '</td><td class="r">' + d(p.halfEdge.meanFees) + ' <small>(1 in 10: ' + d(p.halfEdge.feesP90) + '+)</small></td></tr>';
    const h = base.halfEdge; const ph = push.halfEdge;
    const bothHalves = ph.early.ahead > h.early.ahead && ph.late.ahead > h.late.ahead;
    let txt = 'With half the edge, ' + pc(h.ahead) + ' of these three-year runs ended ahead at ' + rk(base.risk) + ' risk; the typical run ended at ' + usd(h.medianNet) + ' after fees, and 1 in 10 lost ' + d(-h.p10) + ' or more.' +
      (B.feeCaps['3'] ? ' Stopping after 3 fees left ' + pc(B.feeCaps['3'].ahead) + ' ahead, and a single fee ' + pc(B.feeCaps['1'].ahead) + '.' : '');
    txt += ' Risking ' + rk(push.risk) + ' in the challenge and ' + rk(push.fundedRisk) + ' once funded ' + (ph.ahead > h.ahead ? 'raised that to ' + pc(ph.ahead) + (bothHalves ? ', both for runs started before 2008 (' + pc(h.early.ahead) + ' to ' + pc(ph.early.ahead) + ') and from 2008 on (' + pc(h.late.ahead) + ' to ' + pc(ph.late.ahead) + ')' : '') : 'did not help (' + pc(ph.ahead) + ')') + '.' +
      (push.luck.ahead > base.luck.ahead ? ' It also lifted the no-edge trader from ' + pc(base.luck.ahead) + ' to ' + pc(push.luck.ahead) + ', so much of that gain is from taking more chances on a cheap fee, not from the strategies' + (push.playbook.ahead < base.playbook.ahead ? ', and with the full backtested edge it did a little worse' : '') + '.' : '') +
      ' Losing the challenge costs a fee; losing a funded account costs its future payouts, so trading smaller once funded is the safer half of that idea.';
    const two = B.twoAccounts; const tf = RS.playbook.budget.twoFirmsSameDay;
    let twoTxt = '';
    if (two && two['0'] && two['180']) {
      twoTxt = '<p class="pf-note">' + Icons.ico('shield') + '<span><b>A second account at the same time is the same bet.</b> Trading the same strategies, two accounts started the same day passed or failed together: at least one passed ' + pc(two['0'].either) + ' of the time, no more than one account. Started six months apart, at least one passed ' + pc(two['180'].either) + ' (' + pc(two['180'].ifIndependent) + ' if they were independent).' +
        (tf && preset.id.indexOf('2step') >= 0 ? ' A different firm on the same day barely helped: at least one of an FTMO-style and a FundedNext-style 2-step passed ' + pc(tf.either) + ', against ' + pc(tf.passB) + ' for the FundedNext-style one alone.' : '') + ' If you buy more than one, stagger them by months.</span></p>';
    }
    return '<div class="pp-funded pp-plan">' +
      '<div class="pf-head">' + Icons.ico('clock') + '<b>If you keep going: three years of re-buying</b><span>A new challenge the day after each failed one or each lost funded account, for three years, with the playbook above. Net is every payout minus every fee. One run started every 5th day from 1990 to 2023.</span></div>' +
      '<table class="grid num pp-mini"><thead><tr><th>Plan</th><th class="r">Ahead after 3 years</th><th class="r">Half edge</th><th class="r">No edge</th><th class="r">Typical net, half edge</th><th class="r">Fees paid, half edge</th></tr></thead><tbody>' +
      row(rk(base.risk) + ' risk throughout', base) + row(rk(push.risk) + ' in the challenge, ' + rk(push.fundedRisk) + ' once funded', push) +
      '</tbody></table>' +
      '<p class="pf-note">' + Icons.ico('target') + '<span><b>Read it this way.</b> ' + txt + '</span></p>' + twoTxt + '</div>';
  }
  // Round 13: FTMO's Standard funded account must be flat over weekends; the playbook holds through them
  function weekendHtml(preset, risk) {
    const w = RS.playbook.weekend && RS.playbook.weekend.firms[preset.id];
    const x = w && w[risk];
    if (!x || !preset.fundedWeekend) return '';
    const usd = (v) => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
    const swing = preset.id.indexOf('2step') >= 0;
    return '<p class="pf-note">' + Icons.ico('alert') + '<span><b>' + (swing ? 'Pick the Swing account type.' : 'This firm\'s funded account does not fit the playbook well.') + '</b> FTMO says funded Standard accounts must be flat through market breaks longer than 2 hours, which includes every weekend' + (swing ? '. Only the Swing type, sold with the 2-Step (leverage 1:30 instead of 1:100), may hold through them' : ', and the 1-Step has no Swing type') + '. Half to three quarters of the playbook\'s stock-index trades are held over a weekend or holiday. ' +
      'Simulated flat before each break once funded (closed at the last close, reopened at the next open, one more round of costs), the half-edge average for attempts started from 2008 fell from ' + usd(x.hold.halfLate) + ' to ' + usd(x.flat.halfLate) + ' per attempt' + (x.flat.halfEarly > x.hold.halfEarly ? ', though it did a little better before 2008 (' + usd(x.flat.halfEarly) + ' against ' + usd(x.hold.halfEarly) + ')' : '') + '. The challenge itself may hold over weekends. ' + (swing ? 'Swing also has no news window: a Standard funded account cannot open or close trades, stops included, from 2 minutes before to 2 minutes after selected news on the affected markets.' : 'The funded account also cannot open or close trades, stops included, from 2 minutes before to 2 minutes after selected news on the affected markets.') + ' Rules read from FTMO\'s help pages on 2026-11-23; check them before buying.</span></p>';
  }
  // Round 5: how sure the averages are, how lumpy they are, and whether the firm choice matters
  function confidenceHtml(preset, risk) {
    const c = RS.playbook.confidence && RS.playbook.confidence[preset.id] && RS.playbook.confidence[preset.id][risk];
    const usd = (v) => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
    let h = '';
    if (c) {
      h += '<p class="pf-note">' + Icons.ico('shield') + '<span><b>How sure is this?</b> Counting each start year as one draw and resampling them, the backtested average lands between ' + usd(c.playbook.lo) + ' and ' + usd(c.playbook.hi) + ' nine times in ten (half edge: ' + usd(c.halfEdge.lo) + ' to ' + usd(c.halfEdge.hi) + '). It is lumpy: in ' + c.playbook.yearsNegative + ' of ' + c.playbook.years + ' start years the average attempt lost money' + (c.halfEdge.yearsNegative > c.playbook.yearsNegative ? ', and ' + c.halfEdge.yearsNegative + ' of ' + c.halfEdge.years + ' at half edge' : '') + '. A few strong years carry the average, so you need enough attempts and patience to reach one.</span></p>';
    }
    const cf = RS.playbook.compareFirm;
    if (cf && preset.id.startsWith('ftmo_2step')) {
      h += '<p class="pf-note">' + Icons.ico('target') + '<span><b>The firm matters too.</b> With an 8% first target instead of 10%, a ' + esc(cf.label) + ' challenge (about $' + cf.fee + ', refunded with the first reward) passed ' + Math.round(cf.pass * 100) + '% and averaged ' + usd(cf.ev) + ' per attempt in the same test, ' + usd(cf.halfEdgeEv) + ' at half edge. Its rules were read from its help center on 2026-11-23; check them before buying.</span></p>';
    }
    return h;
  }
  function renderPropRates() {
    renderPlaybook();
    const preset = PRESETS.find((p) => p.id === propSel);
    const rows = RS.prop.filter((p) => p.presets[propSel]);
    const allowed = rows.filter((p) => p.presets[propSel].allowed);
    const blocked = rows.filter((p) => !p.presets[propSel].allowed);
    const best = (p) => Math.max(...RISK_COLS.map((r) => p.presets[propSel].byRisk[r[0]].recent));
    const order = (p) => (p.kind === 'baseline' ? 0 : p.kind === 'portfolio' ? 1 : 2);
    allowed.sort((a, b) => (order(a) - order(b)) || (best(b) - best(a)));
    const pc = (v) => Math.round(v * 100) + '%';
    const cell = (x) => {
      if (!x || !x.attempts) return '<td class="cell" style="--h:0">-</td>';
      const edge = x.pass - x.noEdge;
      const tip = (x.mtm ? 'Simulated day by day with all open positions together. ' : '') + 'Passed ' + pc(x.pass) + ' of ' + x.attempts + ' starts (since 2020: ' + pc(x.recent) + ' of ' + x.recentAttempts + '). Same trades with the edge removed: ' + pc(x.noEdge) + '. Failed ' + pc(x.fail) + ', still going after a year ' + pc(x.timeout) + '.' + (x.medDays ? ' Median ' + x.medDays + ' trading days to pass.' : '');
      return '<td class="cell' + (edge >= 0.1 ? ' edge' : edge <= 0.02 ? ' luck' : '') + '" style="--h:' + x.pass.toFixed(3) + '" title="' + esc(tip) + '"><b>' + pc(x.pass) + '</b><small>' + pc(x.recent) + ' since 2020</small></td>';
    };
    let bestRow = null;
    for (const p of allowed) {
      if (p.kind === 'baseline') continue;
      for (const r of RISK_COLS) {
        const x = p.presets[propSel].byRisk[r[0]];
        if (!bestRow || x.recent > bestRow.x.recent) bestRow = { p, r, x };
      }
    }
    const coin = rows.find((p) => p.kind === 'baseline');
    const coinBest = coin ? Math.max(...RISK_COLS.map((r) => coin.presets[propSel].byRisk[r[0]].pass)) : 0;
    const bestFailed = bestRow && bestRow.p.verdict === 'fails';
    const bestTxt = bestRow
      ? (bestFailed ? 'Highest since 2020' : 'Best since 2020') + ': <b>' + (bestRow.p.kind === 'portfolio' ? 'the ' + (bestRow.p.id === 'mix_holds_up' ? 'mix of the ' + RS.playbook.ids.length + ' that held up' : 'index daily mix') : esc(bestRow.p.name) + ' on ' + esc(MKT_SHORT[bestRow.p.id.split('|')[1]])) + '</b> at ' + bestRow.r[1] + ' risk per trade passed ' + pc(bestRow.x.recent) + ' of starts (all years ' + pc(bestRow.x.pass) + '; with its edge removed ' + pc(bestRow.x.noEdge) + ').' + (bestFailed ? ' But that strategy lost money after costs in our research, so treat its pass rate as luck.' : '') + ' A coin flip passes up to ' + pc(coinBest) + ' here, because a challenge rewards variance as much as skill.'
      : '';
    $('ppRates').innerHTML = '<h3>Historical pass rates: ' + esc(preset.label) + '</h3><p class="pp-best">' + bestTxt + ' ' + esc(preset.notes) + '</p>' +
      '<div class="rs-tablewrap" style="max-height:none"><table class="grid num pp-table"><thead><tr><th>Strategy · pass rate at each risk per trade</th>' + RISK_COLS.map((r) => '<th style="text-align:center">' + r[1] + ' <span style="opacity:.7">(' + r[2] + ')</span></th>').join('') + '</tr></thead><tbody>' +
      allowed.map((p) => '<tr class="' + (p.kind === 'baseline' ? 'base' : '') + '"><td>' + propRowName(p) + '</td>' + RISK_COLS.map((r) => cell(p.presets[propSel].byRisk[r[0]])).join('') + '</tr>').join('') +
      '</tbody></table></div>' +
      '<div class="pp-legend"><span><i></i>pass rate, all years (darker is higher)</span><span><b style="color:var(--up-t)">▲</b> beats the same trades with the edge removed by 10+ points</span><span>grey: no better than luck</span><span>hover a cell for fail and timeout rates</span></div>' +
      (blocked.length ? '<div class="pp-na">Not allowed here because they hold positions overnight: ' + blocked.map((p) => esc(p.kind === 'portfolio' ? (p.id === 'mix_holds_up' ? 'the held-up mix' : 'the index daily mix') : p.name + ' (' + MKT_SHORT[p.id.split('|')[1]] + ' ' + (RTF[p.id.split('|')[2]] || '') + ')')).join(', ') + '. Most of what held up in our research is in this list, which is why futures firms with intraday-only rules came out close to luck.</div>' : '') +
      '<p class="fine" style="margin:10px 2px 0">Each start replays the strategy\'s real historical trades in order under the firm\'s rules (daily and trailing limits, minimum days, consistency, flat-by times), with trade size set so one losing trade costs the column\'s risk per trade. Attempts that neither pass nor fail within a year count as not passed. Fees are not included. Source of rules: ' + esc(preset.source) + '.</p>';
  }
  async function startChallenge(id, btn) {
    if (btn) btn.disabled = true;
    try {
      await Api.call('startChallenge', { presetId: id, selfStop: propSelfStop });
      closeModal('propModal');
      const r = btn ? btn.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 3, width: 0 };
      Fx.confetti(r.left + r.width / 2, r.top, 90);
      accountSig = ''; chKey = '';
      await refreshAccount();
      refreshIdea(true);
    } catch (e) {
      Sound.play('error'); Fx.toast({ kind: 'error', title: 'Could not start', body: e.message });
    } finally { if (btn) btn.disabled = false; }
  }
  async function endChallenge() {
    try { await Api.call('endChallenge'); accountSig = ''; chKey = ''; await refreshAccount(); refreshIdea(true); } catch (e) { Fx.toast({ kind: 'error', title: 'Could not leave the challenge', body: e.message }); }
  }

  let chKey = '';
  function renderChallenge(c) {
    const card = $('challengeCard');
    document.body.classList.toggle('in-challenge', !!c);
    $('acctChip').querySelector('.lbl').textContent = c ? 'Challenge' : 'Equity';
    if (!c) { card.hidden = true; chKey = ''; return; }
    const m = (v) => money(v, 0);
    const key = [c.presetId, c.status, c.phase, c.attempt, c.paused ? 1 : 0].join(':');
    if (key !== chKey) {
      chKey = key;
      card.hidden = false;
      const status = c.status === 'passed' ? 'Passed' : c.status === 'failed' ? 'Failed' : c.paused ? 'Paused for today' : (c.phases > 1 ? 'Phase ' + c.phase + ' of ' + c.phases : 'Attempt ' + c.attempt);
      const banner = c.status === 'passed'
        ? '<div class="note good">' + Icons.ico('trophy') + ' <b>Passed.</b> At a real firm this is where the funded account starts, with its own rules. Most funded traders never get paid (Topstep 2025: 33% did).</div>'
        : c.status === 'failed'
          ? '<div class="note bad">' + Icons.ico('alert') + ' <b>Failed: ' + esc({ 'max loss': 'max loss hit', 'daily loss': 'daily loss limit hit', 'time limit': 'time ran out' }[c.reason] || c.reason) + '.</b> Most real attempts end this way. Check History, then try again.</div>'
          : c.paused ? '<div class="note">' + Icons.ico('shield') + ' Daily loss limit reached. New trades unlock at the next session (6 PM ET).</div>' : '';
      const meter = (id, label, room) => '<div class="ch-m' + (room ? ' room' : '') + '" data-m="' + id + '"><div class="ch-m-top"><span>' + label + '</span><b class="num"></b></div><div class="ch-bar"><i></i></div></div>';
      card.innerHTML = '<div class="card-head"><div class="card-title">' + Icons.ico('trophy') + esc(c.label) + '</div><span class="ch-status ' + (c.paused && c.status === 'active' ? 'paused' : c.status) + '">' + status + '</span></div>' +
        '<div class="ch-body">' + banner + meter('target', 'Profit target') + (c.dailyLimit ? meter('daily', c.selfStop ? 'Room to your daily stop' : 'Daily loss room', true) : '') + meter('floor', 'Max loss room', true) +
        '<div class="ch-meta"></div><div class="ch-actions">' + (c.status !== 'active' ? '<button class="ghost-btn" data-act="retry" data-sound="click">' + Icons.ico('refresh') + 'Try again</button>' : '') +
        '<button class="ghost-btn" data-act="rules" data-sound="click">' + Icons.ico('info') + 'Rules</button><button class="ghost-btn" data-act="exit" data-sound="click">' + Icons.ico('x') + 'Back to my account</button></div></div>';
      Icons.hydrate(card);
      card.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.act === 'exit') endChallenge();
        else if (b.dataset.act === 'retry') startChallenge(c.presetId, b);
        else { propSel = c.presetId; openProp(); }
      }));
    }
    const set = (id, txt, frac, lvl) => {
      const el = card.querySelector('.ch-m[data-m="' + id + '"]'); if (!el) return;
      el.querySelector('b').textContent = txt;
      el.querySelector('i').style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
      el.classList.toggle('low', lvl === 'low'); el.classList.toggle('mid', lvl === 'mid');
    };
    const lvl = (f) => (f < 0.3 ? 'low' : f < 0.6 ? 'mid' : '');
    set('target', (c.openProfit >= 0 ? '+' : '-') + m(Math.abs(c.openProfit)) + ' of ' + m(c.target), c.openProfit / c.target);
    if (c.dailyLimit) {
      const lim = c.selfStop || c.dailyLimit; const f = (lim - c.dayLoss) / lim;
      set('daily', m(Math.max(0, lim - c.dayLoss)) + ' left of ' + m(lim) + (c.selfStop ? ' (firm: ' + m(c.dailyLimit) + ')' : ''), f, lvl(f));
    }
    { const f = c.roomToFloor / c.maxLoss; set('floor', m(Math.max(0, c.roomToFloor)) + ' above ' + m(c.floor), f, lvl(f)); }
    const meta = [];
    meta.push('<span>Trading days ' + c.tradingDays + (c.minDays ? ' / ' + c.minDays + ' min' : '') + '</span>');
    if (c.daysLeft != null) meta.push('<span' + (c.daysLeft < 5 ? ' class="bad"' : '') + '>' + Math.ceil(c.daysLeft) + ' days left</span>');
    if (c.flatBy) meta.push('<span>Flat by ' + esc(c.flatBy) + '</span>');
    if (c.consistency && c.profit > 0) meta.push('<span' + (c.consistency.ok ? '' : ' class="bad"') + '>Best day ' + Math.round(c.consistency.bestDay / c.profit * 100) + '% of profit (max ' + Math.round(c.consistency.share * 100) + '%)</span>');
    meta.push('<span>Real fee: ' + esc(c.fee) + '</span>');
    const mb = card.querySelector('.ch-meta'); const html = meta.join('');
    if (mb.innerHTML !== html) mb.innerHTML = html;
  }

  // ---------- keyboard ----------
  function bindKeys() {
    addEventListener('keydown', (e) => {
      const typing = /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
      if (e.key === 'Escape') { document.querySelectorAll('.modal-back:not([hidden])').forEach((m) => { if (m.id !== 'welcomeModal') closeModal(m.id); }); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.modal-back:not([hidden])')) return; // shortcuts are for the main screen only
      const n = Number(e.key);
      if (n >= 1 && n <= 6) { Sound.play('toggle'); selectSymbol(st.symbol, st.catalog.timeframes[n - 1]); }
      else if (e.key === 'b' || e.key === 'B') { st.side = 'buy'; Sound.play('toggle'); segTicket(); fillTicketDefaults(true); }
      else if (e.key === 's' || e.key === 'S') { st.side = 'sell'; Sound.play('toggle'); segTicket(); fillTicketDefaults(true); }
      else if (e.key === 'e' || e.key === 'E') { const b = $('execBtn'); if (b && !b.disabled) b.click(); }
      else if (e.key === 'w' || e.key === 'W') { if ($('teachBtn') && !Lesson.isOpen()) startLesson(); }
      else if (e.key === 'm' || e.key === 'M') { $('soundBtn').click(); }
      else if (e.key === 'l' || e.key === 'L') { Sound.play('click'); openLearn(); }
      else if (e.key === 't' || e.key === 'T') { Sound.play('click'); openTop(); }
    });
  }

  window.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
