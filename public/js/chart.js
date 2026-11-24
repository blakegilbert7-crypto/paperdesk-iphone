/* Main price chart: candles, indicators, trade boxes, price lines and markers. */
(function () {
  const LWC = window.LightweightCharts;
  // Colors come from the current theme (renderer/js/theme.js).
  const P = () => (window.Theme ? Theme.pal : { up: '#1fae7e', down: '#e5534b' });

  // Lightweight Charts renders UTC; shift timestamps so the axis shows local time.
  function toLocal(t) { return t - new Date(t * 1000).getTimezoneOffset() * 60; }
  function fromLocal(t) { return t + new Date(t * 1000).getTimezoneOffset() * 60; }

  const S = {
    chart: null, candles: null, volume: null, lines: {}, overlay: null, ctx: null, legend: null,
    times: [], bars: [], decimals: 2, ind: { ema20: true, ema50: true, vwap: false, volume: true },
    priceLines: [], boxes: [], previewBoxes: [], tfSec: 300, lastClose: null,
  };
  // Teaching walkthrough layer (driven by renderer/js/lesson.js): the current step, its temporary
  // line series and price lines, when it appeared (for the fade-in), and the view to go back to.
  const L = { on: false, step: null, series: [], plines: [], born: 0, saved: null, anim: 0, leftPad: 0 };

  function init(container, overlay, legend) {
    S.chart = LWC.createChart(container, Object.assign(chartTheme(), {
      autoSize: true,
      rightPriceScale: { borderColor: P().border, scaleMargins: { top: 0.12, bottom: 0.18 } },
      timeScale: { borderColor: P().border, timeVisible: true, secondsVisible: false, rightOffset: 22, barSpacing: 8 },
      handleScale: { axisPressedMouseMove: true },
    }));
    // Up candles hollow, down candles filled: direction is readable without color.
    S.candles = S.chart.addCandlestickSeries(Object.assign(candleTheme(), {
      autoscaleInfoProvider: (orig) => lessonAutoscale(orig()),
    }));
    S.volume = S.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    S.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    for (const k of ['ema20', 'ema50', 'vwap']) {
      S.lines[k] = S.chart.addLineSeries({ color: P()[k], lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    }
    S.overlay = overlay;
    S.ctx = overlay.getContext('2d');
    S.legend = legend;
    S.chart.subscribeCrosshairMove(onCrosshair);
    new ResizeObserver(sizeOverlay).observe(container);
    sizeOverlay();
    requestAnimationFrame(drawLoop);
  }

  // Theme colors for the chart and series; applyTheme re-colors everything live.
  function chartTheme() {
    const p = P(); const font = (window.Theme && Theme.css('--font')) || 'InterVar, Segoe UI, sans-serif';
    return {
      layout: { background: { type: 'solid', color: p.bg }, textColor: p.text, fontFamily: font, fontSize: 11 },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: p.cross, labelBackgroundColor: p.crossLabel }, horzLine: { color: p.cross, labelBackgroundColor: p.crossLabel } },
    };
  }
  function candleTheme() {
    const p = P();
    return { upColor: p.upFill, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down, priceLineColor: p.priceLine };
  }
  function applyTheme() {
    if (!S.chart) return;
    const p = P();
    S.chart.applyOptions(Object.assign(chartTheme(), { rightPriceScale: { borderColor: p.border }, timeScale: { borderColor: p.border } }));
    S.candles.applyOptions(candleTheme());
    for (const k of ['ema20', 'ema50', 'vwap']) S.lines[k].applyOptions({ color: p[k] });
    if (S.bars.length) S.volume.setData(S.bars.map(mapVol));
    if (S.lastLines) setTrades(S.lastLines.positions, S.lastLines.orders, S.lastLines.preview);
    if (S.lastMarkers) setMarkers(S.lastMarkers);
  }

  // Lesson colors arrive from the engine in the default palette; map them onto the theme's.
  const TC = { '1fae7e': 'up', 'e5534b': 'down', 'c9d2ff': 'entry', '3987e5': 'ema20', 'd95926': 'ema50', 'd55181': 'vwap', 'b197ff': 'a1', '7cc4ff': 'a2', 'f2b84b': 'warn' };
  const TCR = { '31,174,126': 'up', '229,83,75': 'down', '242,184,75': 'warn', '124,196,255': 'a2' };
  function tc(col) {
    if (!col || !window.Theme || Theme.id === 'aurora') return col;
    const h = /^#([0-9a-f]{6})$/i.exec(col);
    if (h) return TC[h[1].toLowerCase()] ? P()[TC[h[1].toLowerCase()]] : col;
    const r = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/.exec(col);
    if (r && TCR[r[1] + ',' + r[2] + ',' + r[3]]) return hexA(P()[TCR[r[1] + ',' + r[2] + ',' + r[3]]], r[4] != null ? +r[4] : 1);
    return col;
  }
  function rgbaPre(col) { const x = hexA(col, 1); return x.slice(0, x.lastIndexOf(',') + 1); }

  function sizeOverlay() {
    const r = S.overlay.getBoundingClientRect();
    S.overlay.width = Math.max(1, r.width * devicePixelRatio);
    S.overlay.height = Math.max(1, r.height * devicePixelRatio);
  }

  function fmt(p) { return p == null || !isFinite(p) ? '-' : Number(p).toFixed(S.decimals); }

  function onCrosshair(param) {
    let bar = null;
    if (param && param.time != null) bar = param.seriesData.get(S.candles);
    if (!bar) bar = S.bars.length ? S.bars[S.bars.length - 1] : null;
    if (!bar) { S.legend.innerHTML = ''; return; }
    const ch = bar.open ? (bar.close / bar.open - 1) * 100 : 0;
    S.legend.innerHTML = '<span><b>O</b>' + fmt(bar.open) + '</span><span><b>H</b>' + fmt(bar.high) + '</span><span><b>L</b>' + fmt(bar.low) + '</span><span><b>C</b>' + fmt(bar.close) + '</span><span class="' + (ch >= 0 ? 'up-t' : 'down-t') + '">' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%</span>';
  }

  function mapBar(b) {
    return { time: toLocal(b.time), open: b.open, high: b.high, low: b.low, close: b.close };
  }
  function mapVol(b) {
    return { time: toLocal(b.time), value: b.volume || 0, color: hexA(b.close >= b.open ? P().up : P().down, 0.35) };
  }

  function setData(res, opts) {
    const o = opts || {};
    if (L.on) { lessonClear(); L.on = false; L.step = null; L.saved = null; applyIndicatorVisibility(); }
    L.anim++;
    S.decimals = o.decimals != null ? o.decimals : 2;
    S.tfSec = o.tfSec || 300;
    const minMove = Math.pow(10, -S.decimals);
    S.candles.applyOptions({ priceFormat: { type: 'price', precision: S.decimals, minMove } });
    for (const k in S.lines) S.lines[k].applyOptions({ priceFormat: { type: 'price', precision: S.decimals, minMove } });
    S.bars = res.bars.map(mapBar);
    S.times = res.bars.map((b) => b.time);
    S.candles.setData(S.bars);
    const hasVol = res.bars.some((b) => b.volume > 0);
    S.volume.setData(hasVol ? res.bars.map(mapVol) : []);
    S.hasVol = hasVol;
    setIndicatorData(res);
    applyIndicatorVisibility();
    S.chart.timeScale().applyOptions({ timeVisible: S.tfSec < 86400 });
    const n = S.bars.length;
    S.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + 22 });
    onCrosshair(null);
  }

  function setIndicatorData(res) {
    const ind = res.ind || {};
    for (const k of ['ema20', 'ema50', 'vwap']) {
      const arr = ind[k] || [];
      const data = [];
      for (let i = 0; i < res.bars.length; i++) if (arr[i] != null && isFinite(arr[i])) data.push({ time: toLocal(res.bars[i].time), value: arr[i] });
      S.lines[k].setData(data);
    }
  }

  // Merge the newest bars into the chart (live updates).
  function update(res) {
    if (!S.bars.length || !res.bars.length) return null;
    const lastT = S.times[S.times.length - 1];
    let changed = null;
    res.bars.forEach((b, idx) => {
      if (b.time < lastT) return;
      const m = mapBar(b);
      S.candles.update(m);
      if (S.hasVol) S.volume.update(mapVol(b));
      const ind = res.ind || {};
      for (const k of ['ema20', 'ema50', 'vwap']) {
        const v = ind[k] && ind[k][idx];
        if (v != null && isFinite(v)) S.lines[k].update({ time: m.time, value: v });
      }
      if (b.time === S.times[S.times.length - 1]) { S.bars[S.bars.length - 1] = m; } else { S.bars.push(m); S.times.push(b.time); changed = 'newbar'; }
    });
    onCrosshair(null);
    return changed;
  }

  function setIndicators(state) {
    Object.assign(S.ind, state);
    applyIndicatorVisibility();
  }
  function applyIndicatorVisibility() {
    S.lines.ema20.applyOptions({ visible: !!S.ind.ema20 });
    S.lines.ema50.applyOptions({ visible: !!S.ind.ema50 });
    S.lines.vwap.applyOptions({ visible: !!S.ind.vwap && S.tfSec < 3600 });
    S.volume.applyOptions({ visible: !!S.ind.volume });
  }

  // ---- price lines + boxes ----
  function clearLines() {
    S.priceLines.forEach((l) => { try { S.candles.removePriceLine(l); } catch (e) { /* gone */ } });
    S.priceLines = [];
  }
  function line(price, color, title, style, width) {
    if (price == null || !isFinite(price)) return;
    S.priceLines.push(S.candles.createPriceLine({ price, color, lineWidth: width || 1, lineStyle: style == null ? LWC.LineStyle.Solid : style, axisLabelVisible: true, title }));
  }

  // positions/orders are for this symbol only
  function setTrades(positions, orders, preview) {
    S.lastLines = { positions, orders, preview };
    const p0 = P(); const UP = p0.up; const DOWN = p0.down;
    clearLines();
    S.boxes = [];
    for (const p of positions) {
      const sideTxt = p.dir > 0 ? 'LONG' : 'SHORT';
      const pnl = (p.upnl >= 0 ? '+' : '-') + '$' + Math.abs(p.upnl).toFixed(0);
      line(p.entry, p0.entry, sideTxt + ' ' + p.qty + '  ' + pnl, LWC.LineStyle.Solid, 2);
      line(p.stop, DOWN, 'STOP', LWC.LineStyle.Dashed);
      line(p.target, UP, 'TARGET', LWC.LineStyle.Dashed);
      S.boxes.push({ from: p.openedAt, entry: p.entry, stop: p.stop, target: p.target, alpha: 0.16 });
    }
    for (const o of orders) {
      line(o.price, p0.order, (o.side === 'buy' ? 'BUY ' : 'SELL ') + o.type.toUpperCase() + ' ' + o.qty, LWC.LineStyle.Dotted, 1);
    }
    if (preview) {
      line(preview.entry, p0.idea, 'IDEA ' + (preview.side === 'buy' ? 'BUY' : 'SELL'), LWC.LineStyle.LargeDashed, 1);
      line(preview.stop, hexA(DOWN, 0.8), 'IDEA STOP', LWC.LineStyle.LargeDashed, 1);
      if (preview.target != null) line(preview.target, hexA(UP, 0.8), 'IDEA TARGET', LWC.LineStyle.LargeDashed, 1);
      S.boxes.push({ from: null, entry: preview.entry, stop: preview.stop, target: preview.target, alpha: 0.1, dashed: true });
    }
  }

  function setMarkers(trades) {
    S.lastMarkers = trades;
    const UP = P().up; const DOWN = P().down;
    if (!S.times.length) { S.candles.setMarkers([]); return; }
    const first = S.times[0];
    const ms = [];
    for (const t of trades) {
      if (t.openedAt >= first) {
        ms.push({ time: toLocal(snap(t.openedAt)), position: t.dir > 0 ? 'belowBar' : 'aboveBar', color: t.dir > 0 ? UP : DOWN, shape: t.dir > 0 ? 'arrowUp' : 'arrowDown', text: (t.dir > 0 ? 'Buy ' : 'Sell ') + t.qty });
      }
      if (t.closedAt && t.closedAt >= first) {
        ms.push({ time: toLocal(snap(t.closedAt)), position: t.dir > 0 ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? UP : DOWN, shape: 'circle', text: (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(0) });
      }
    }
    ms.sort((a, b) => a.time - b.time);
    S.candles.setMarkers(ms);
  }

  function snap(t) {
    // latest bar time <= t
    let lo = 0; let hi = S.times.length - 1;
    if (t <= S.times[0]) return S.times[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S.times[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return S.times[lo];
  }
  function indexOf(t) {
    let lo = 0; let hi = S.times.length - 1;
    if (!S.times.length) return 0;
    if (t <= S.times[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S.times[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo + (t - S.times[lo]) / S.tfSec;
  }

  // Draw translucent risk (red) / reward (green) boxes like a position tool.
  function drawLoop() {
    requestAnimationFrame(drawLoop);
    const c = S.ctx;
    if (!c) return;
    const dpr = devicePixelRatio;
    // keep the canvas's pixel size in step with its box (window resizes, scrollbars, zoom)
    const cw = Math.round(S.overlay.clientWidth * dpr); const chh = Math.round(S.overlay.clientHeight * dpr);
    if (cw && chh && (S.overlay.width !== cw || S.overlay.height !== chh)) { S.overlay.width = cw; S.overlay.height = chh; }
    c.clearRect(0, 0, S.overlay.width, S.overlay.height);
    if ((!S.boxes.length && !S.focus && !L.on) || !S.bars.length) return;
    const ts = S.chart.timeScale();
    const paneW = ts.width();
    const lastIdx = S.bars.length - 1;
    // logicalToCoordinate only handles indices inside the data; extrapolate the rest
    const xa0 = ts.logicalToCoordinate(Math.max(0, lastIdx - 10));
    const xa1 = ts.logicalToCoordinate(lastIdx);
    const spacing = xa0 != null && xa1 != null ? (xa1 - xa0) / Math.min(10, lastIdx || 1) : 8;
    const xAt = (logical) => {
      const base = Math.max(0, Math.min(lastIdx, Math.floor(logical)));
      const xb = ts.logicalToCoordinate(base);
      return xb == null ? null : xb + (logical - base) * spacing;
    };
    for (const b of (L.on ? [] : S.boxes)) {
      const x0 = b.from == null ? xAt(lastIdx + 0.6) : xAt(indexOf(b.from));
      const x1 = b.from == null ? Math.min(paneW, (xAt(lastIdx + 0.6) || 0) + 150) : paneW;
      if (x0 == null || x1 == null) continue;
      const xa = Math.max(0, x0);
      const xb = Math.min(paneW, x1);
      if (xb <= xa) continue;
      const ye = S.candles.priceToCoordinate(b.entry);
      const zones = [[b.stop, rgbaPre(P().down)], [b.target, rgbaPre(P().up)]];
      for (const [px, col] of zones) {
        if (px == null) continue;
        const y = S.candles.priceToCoordinate(px);
        if (ye == null || y == null) continue;
        c.fillStyle = col + b.alpha + ')';
        c.fillRect(xa * dpr, Math.min(ye, y) * dpr, (xb - xa) * dpr, Math.abs(y - ye) * dpr);
        c.strokeStyle = col + (b.alpha * 2.5) + ')';
        c.lineWidth = dpr;
        if (b.dashed) c.setLineDash([5 * dpr, 4 * dpr]); else c.setLineDash([]);
        c.strokeRect(xa * dpr, Math.min(ye, y) * dpr, (xb - xa) * dpr, Math.abs(y - ye) * dpr);
      }
    }
    if (S.focus) drawPast(c, dpr, S.focus, xAt);
    if (L.on && L.step) drawLesson(c, dpr, xAt, spacing, paneW);
  }

  // A past trade: risk (and reward) box from entry to exit and a line from entry to exit price.
  function drawPast(c, dpr, f, xAt) {
    const xa = xAt(indexOf(f.entryTime));
    const xb = xAt(indexOf(f.exitTime) + 1);
    const ye = S.candles.priceToCoordinate(f.entry);
    if (xa == null || xb == null || ye == null) return null;
    c.setLineDash([]);
    const zones = [[f.stop, rgbaPre(P().down)], [f.target, rgbaPre(P().up)]];
    for (const [p, col] of zones) {
      if (p == null) continue;
      const y = S.candles.priceToCoordinate(p);
      if (y == null) continue;
      c.fillStyle = col + '0.18)';
      c.fillRect(xa * dpr, Math.min(ye, y) * dpr, (xb - xa) * dpr, Math.abs(y - ye) * dpr);
    }
    const yx = S.candles.priceToCoordinate(f.exit);
    if (yx == null) return null;
    c.strokeStyle = f.R >= 0 ? P().upText : P().downText;
    c.lineWidth = 2 * dpr;
    c.beginPath(); c.moveTo(xa * dpr, ye * dpr); c.lineTo(xb * dpr, yx * dpr); c.stroke();
    c.fillStyle = c.strokeStyle;
    c.beginPath(); c.arc(xb * dpr, yx * dpr, 4 * dpr, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(xa * dpr, ye * dpr, 3 * dpr, 0, Math.PI * 2); c.fill();
    return { xa, xb, ye, yx };
  }

  // ---- teaching walkthrough ----
  // A position in a step is a bar time (UTC seconds) or { t, plus } for bars after t.
  function lessonPos(x) { return x && typeof x === 'object' ? indexOf(x.t) + (x.plus || 0) : indexOf(x); }

  function lessonAutoscale(r) {
    if (!L.on || !L.step || !r || !r.priceRange) return r;
    let lo = r.priceRange.minValue; let hi = r.priceRange.maxValue;
    const add = (p) => { if (p != null && isFinite(p)) { lo = Math.min(lo, p); hi = Math.max(hi, p); } };
    const st = L.step;
    for (const lv of st.levels || []) add(lv.price);
    for (const z of st.zones || []) { add(z.top); add(z.bottom); }
    for (const m of st.marks || []) add(m.price);
    if (st.example) { add(st.example.entry); add(st.example.exit); add(st.example.stop); }
    return { priceRange: { minValue: lo, maxValue: hi }, margins: r.margins };
  }

  function lessonClear() {
    L.series.forEach((x) => { try { S.chart.removeSeries(x); } catch (e) { /* gone */ } });
    L.plines.forEach((x) => { try { S.candles.removePriceLine(x); } catch (e) { /* gone */ } });
    L.series = []; L.plines = [];
  }

  function animateRange(to, ms) {
    const ts = S.chart.timeScale();
    const from = ts.getVisibleLogicalRange();
    const id = ++L.anim;
    if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) { ts.setVisibleLogicalRange(to); return; }
    const t0 = performance.now(); const d = ms || 700;
    const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
    const tick = (now) => {
      if (id !== L.anim) return;
      const k = Math.min(1, (now - t0) / d); const e = ease(k);
      ts.setVisibleLogicalRange({ from: from.from + (to.from - from.from) * e, to: from.to + (to.to - from.to) * e });
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Show one lesson step: its lines, levels and drawings, zoomed to its view. leftPad (px) keeps
  // the step's view clear of the lesson card on the left of the chart.
  function lessonStep(step, opts) {
    if (!S.chart || !S.times.length) return;
    const o = opts || {};
    if (!L.on) {
      L.saved = S.chart.timeScale().getVisibleLogicalRange();
      L.on = true;
      for (const k in S.lines) S.lines[k].applyOptions({ visible: false });
      focusTrade(null);
    }
    if (o.leftPad != null) L.leftPad = o.leftPad;
    lessonClear();
    L.step = step; L.born = performance.now();
    const minMove = Math.pow(10, -S.decimals);
    for (const ln of step.lines || []) {
      const ser = S.chart.addLineSeries({ color: tc(ln.color), lineWidth: ln.width || 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: ln.label, priceFormat: { type: 'price', precision: S.decimals, minMove } });
      ser.setData(ln.points.map((p) => ({ time: toLocal(p[0]), value: p[1] })));
      L.series.push(ser);
    }
    for (const lv of step.levels || []) {
      if (lv.price == null || !isFinite(lv.price)) continue;
      L.plines.push(S.candles.createPriceLine({ price: lv.price, color: tc(lv.color), lineWidth: lv.dash ? 1 : 2, lineStyle: lv.dash ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid, axisLabelVisible: true, title: lv.label || '' }));
    }
    if (step.view) {
      let from = lessonPos(step.view.from) - 2;
      let to = lessonPos(step.view.to) + (step.view.ahead || 0) + 3;
      if (to - from < 26) { const mid = (from + to) / 2; from = mid - 13; to = mid + 13; }
      const w = S.chart.timeScale().width() || 800;
      const frac = Math.min(0.55, Math.max(0, L.leftPad / w));
      from -= (to - from) * frac / (1 - frac);
      animateRange({ from, to }, 750);
    }
  }

  function lessonEnd() {
    if (!L.on) return;
    lessonClear();
    L.on = false; L.step = null;
    applyIndicatorVisibility();
    if (L.saved) animateRange(L.saved, 600);
    L.saved = null;
  }

  function hexA(col, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(col || '');
    if (m) { const n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
    const r = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec((col || '').replace(/\s/g, ''));
    return r ? 'rgba(' + r[1] + ',' + r[2] + ',' + r[3] + ',' + a + ')' : col;
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  // a small label with a dark background; (x, y) in CSS px, anchored by align/above
  function pill(c, dpr, x, y, text, color, align, above) {
    c.font = '600 ' + (11 * dpr) + 'px InterVar, Segoe UI, sans-serif';
    const w = c.measureText(text).width + 12 * dpr; const h = 18 * dpr;
    let px = x * dpr - (align === 'center' ? w / 2 : align === 'right' ? w : 0);
    let py = y * dpr - (above ? h : 0);
    px = Math.max(2 * dpr, Math.min(S.overlay.width - w - 60 * dpr, px));
    py = Math.max(2 * dpr, Math.min(S.overlay.height - h - 24 * dpr, py));
    c.fillStyle = P().pillBg; rrect(c, px, py, w, h, 6 * dpr); c.fill();
    c.strokeStyle = hexA(color, 0.7); c.lineWidth = dpr; c.stroke();
    c.fillStyle = hexA(color, 1); c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillText(text, px + 6 * dpr, py + h / 2 + 0.5 * dpr);
  }

  function drawLesson(c, dpr, xAt, sp, paneW) {
    const st = L.step; const now = performance.now();
    const fade = Math.min(1, (now - L.born) / 450);
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    const Y = (v) => S.candles.priceToCoordinate(v);
    c.save();
    c.globalAlpha = fade;
    for (const v of st.vlines || []) {
      const x = xAt(lessonPos(v.t) - 0.5);
      if (x == null || x < 0 || x > paneW) continue;
      c.strokeStyle = P().vline; c.lineWidth = dpr; c.setLineDash([3 * dpr, 4 * dpr]);
      c.beginPath(); c.moveTo(x * dpr, 0); c.lineTo(x * dpr, S.overlay.height - 26 * dpr); c.stroke(); c.setLineDash([]);
      if (v.label) pill(c, dpr, x + 4, 30, v.label, P().vlabel, 'left', false);
    }
    for (const z of st.zones || []) {
      const xa = xAt(lessonPos(z.x0) - 0.45); const xb = xAt(lessonPos(z.x1) + 0.45);
      const ya = Y(z.top); const yb = Y(z.bottom);
      if (xa == null || xb == null || ya == null || yb == null) continue;
      const x0 = Math.max(0, xa); const x1 = Math.min(paneW, xb);
      if (x1 <= x0) continue;
      const y0 = Math.min(ya, yb); const h = Math.max(3, Math.abs(yb - ya));
      // sweep in from the left as the step appears
      const wv = (x1 - x0) * Math.min(1, (now - L.born) / 550);
      const zf = tc(z.fill); c.fillStyle = zf; c.fillRect(x0 * dpr, y0 * dpr, wv * dpr, h * dpr);
      c.strokeStyle = hexA(zf, 0.65); c.lineWidth = dpr;
      if (z.dashed) c.setLineDash([5 * dpr, 4 * dpr]);
      c.strokeRect(x0 * dpr, y0 * dpr, wv * dpr, h * dpr); c.setLineDash([]);
      if (z.label) pill(c, dpr, x0 + 2, z.below ? y0 + h + 4 : y0 - 4, z.label, hexA(zf, 1), 'left', !z.below);
    }
    for (const b of st.bars || []) {
      const k = Math.round(lessonPos(b.t)); const bar = S.bars[k];
      if (!bar) continue;
      const x = xAt(k); const yh = Y(bar.high); const yl = Y(bar.low);
      if (x == null || yh == null || yl == null) continue;
      const w = Math.max(10, sp * 0.9 + 8);
      const bc = tc(b.color); c.fillStyle = hexA(bc, 0.08 + 0.12 * pulse);
      rrect(c, (x - w / 2) * dpr, (yh - 7) * dpr, w * dpr, (yl - yh + 14) * dpr, 6 * dpr); c.fill();
      c.strokeStyle = hexA(bc, 0.55 + 0.45 * pulse); c.lineWidth = 2 * dpr; c.stroke();
      if (b.label) pill(c, dpr, x, yh - 12, b.label, bc, 'center', true);
    }
    for (const m of st.marks || []) {
      const x = xAt(lessonPos(m.t) + (m.ahead || 0)); const y = Y(m.price);
      if (x == null || y == null || x < 0 || x > paneW) continue;
      const mc = tc(m.color); c.fillStyle = hexA(mc, 1);
      c.beginPath(); c.arc(x * dpr, y * dpr, (4 + 2 * pulse) * dpr, 0, Math.PI * 2); c.fill();
      c.strokeStyle = hexA(mc, 0.35); c.lineWidth = 6 * dpr * pulse;
      c.beginPath(); c.arc(x * dpr, y * dpr, 8 * dpr, 0, Math.PI * 2); c.stroke();
      if (m.text) pill(c, dpr, x, y - 12, m.text, mc, 'center', true);
    }
    if (st.example) {
      const g = drawPast(c, dpr, st.example, xAt);
      if (g) pill(c, dpr, g.xb + 8, g.yx - 9, (st.example.R >= 0 ? '+' : '') + st.example.R.toFixed(2) + 'R', st.example.R >= 0 ? P().upText : P().downText, 'left', false);
    }
    c.restore();
  }

  // Show one past (backtest) trade: its box from entry to exit, and scroll to it.
  function focusTrade(t) {
    S.focus = t || null;
    if (!t || !S.times.length) { S.focusLines && S.focusLines.forEach((l) => { try { S.candles.removePriceLine(l); } catch (e) { /* gone */ } }); S.focusLines = []; return; }
    const i0 = Math.floor(indexOf(t.entryTime));
    const i1 = Math.ceil(indexOf(t.exitTime));
    const span = Math.max(30, (i1 - i0) * 3);
    S.chart.timeScale().setVisibleLogicalRange({ from: i0 - span / 2, to: i1 + span / 2 });
    (S.focusLines || []).forEach((l) => { try { S.candles.removePriceLine(l); } catch (e) { /* gone */ } });
    S.focusLines = [
      S.candles.createPriceLine({ price: t.entry, color: P().entry, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'PAST ENTRY' }),
      S.candles.createPriceLine({ price: t.exit, color: t.R >= 0 ? P().up : P().down, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'EXIT ' + (t.R >= 0 ? '+' : '') + t.R.toFixed(2) + 'R' }),
    ];
  }

  function lastPrice() { return S.bars.length ? S.bars[S.bars.length - 1].close : null; }

  if (window.Theme) Theme.onChange(() => applyTheme());
  window.PriceChart = { _s: S, focusTrade, init, setData, update, setIndicators, setTrades, setMarkers, lastPrice, toLocal, fromLocal, lessonStep, lessonEnd, applyTheme };
})();
