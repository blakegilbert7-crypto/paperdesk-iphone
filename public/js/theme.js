/* Themes and layouts. Loaded in <head> so the saved theme is applied before the first paint.
   A theme is CSS (renderer/themes.css) plus a palette for the canvas charts, window chrome colors
   and a sound pack. Layouts move the panels and are chosen separately (each theme suggests one). */
(function () {
  const BASE = {
    bg: '#0f141c', text: '#8b95a7', grid: 'rgba(255,255,255,0.035)', border: 'rgba(255,255,255,0.06)',
    cross: 'rgba(160,170,255,0.35)', crossLabel: '#3b3f8f', up: '#1fae7e', down: '#e5534b', upFill: 'rgba(31,174,126,0.08)',
    ema20: '#3987e5', ema50: '#d95926', vwap: '#d55181', priceLine: '#7d8cff', entry: '#c9d2ff', order: '#ffd166',
    idea: '#b9a6ff', pillBg: 'rgba(11,15,22,0.9)', upText: '#4fe0a8', downText: '#ff8a83', vline: 'rgba(160,170,255,0.38)',
    vlabel: '#a9b4ff', warn: '#f2b84b', a1: '#b197ff', a2: '#7cc4ff', ink: '255,255,255', muted: '#6d7789', line: '#3987e5', dot: '#0b0f17',
  };
  const THEMES = [
    { id: 'aurora', name: 'Aurora', tag: 'Violet glass and drifting light. The original.', layout: 'classic', sound: 'aurora',
      chrome: { color: '#0a0d14', symbol: '#c9d1d9', bg: '#070a10' },
      mini: ['#070a10', 'rgba(16,21,31,.9)', 'linear-gradient(135deg,#8b6cff,#3fa2ff)', '#1fae7e', '#e5534b'],
      pal: {} },
    { id: 'terminal', name: 'Terminal', tag: 'Phosphor green on black, monospace, scanlines. Dense and fast.', layout: 'wide', sound: 'terminal',
      chrome: { color: '#010301', symbol: '#86d98a', bg: '#020402' },
      mini: ['#020402', '#040a04', '#39ff7a', '#39ff7a', '#ff4d4d'],
      pal: { bg: '#030703', text: '#4f8a55', grid: 'rgba(57,255,122,0.05)', border: 'rgba(57,255,122,0.15)', cross: 'rgba(57,255,122,0.4)', crossLabel: '#0d3d1a',
        up: '#39ff7a', down: '#ff4d4d', upFill: 'rgba(57,255,122,0.06)', ema20: '#ffb000', ema50: '#00c8ff', vwap: '#ff4dd2', priceLine: '#39ff7a', entry: '#c8ffc8',
        order: '#ffb000', idea: '#ffc94d', pillBg: 'rgba(2,6,2,0.92)', upText: '#8cffb0', downText: '#ff8080', vline: 'rgba(57,255,122,0.35)', vlabel: '#8cffb0',
        warn: '#ffb000', a1: '#ffc94d', a2: '#39ff7a', ink: '140,255,170', muted: '#4f8a55', line: '#39ff7a', dot: '#020402' } },
    { id: 'daylight', name: 'Daylight', tag: 'Bright, airy and calm, for trading by a window.', layout: 'classic', sound: 'daylight',
      chrome: { color: '#f8f9fc', symbol: '#334155', bg: '#eef1f6' },
      mini: ['#eef1f6', '#ffffff', 'linear-gradient(135deg,#6d4aff,#2563eb)', '#0e9f6e', '#dc3c32'],
      pal: { bg: '#ffffff', text: '#64748b', grid: 'rgba(15,23,42,0.05)', border: 'rgba(15,23,42,0.1)', cross: 'rgba(37,99,235,0.35)', crossLabel: '#2563eb',
        up: '#0e9f6e', down: '#dc3c32', upFill: 'rgba(14,159,110,0.10)', ema20: '#2563eb', ema50: '#ea580c', vwap: '#db2777', priceLine: '#6d4aff', entry: '#334155',
        order: '#b45309', idea: '#6d4aff', pillBg: 'rgba(255,255,255,0.95)', upText: '#08775a', downText: '#b42318', vline: 'rgba(37,99,235,0.35)', vlabel: '#2563eb',
        warn: '#b45309', a1: '#6d4aff', a2: '#2563eb', ink: '15,23,42', muted: '#7b889c', line: '#2563eb', dot: '#ffffff' } },
    { id: 'synthwave', name: 'Synthwave', tag: 'Neon pink and cyan over a retro sunset grid.', layout: 'strip', sound: 'synthwave',
      chrome: { color: '#0e021e', symbol: '#d3a8f0', bg: '#0b0118' },
      mini: ['#140330', 'rgba(30,8,58,.9)', 'linear-gradient(135deg,#ff2bd6,#7b2bff,#00e5ff)', '#00f5a0', '#ff3864'],
      pal: { bg: 'rgba(18,5,42,0.6)', text: '#9168b5', grid: 'rgba(255,43,214,0.07)', border: 'rgba(255,43,214,0.2)', cross: 'rgba(0,229,255,0.45)', crossLabel: '#7b2bff',
        up: '#00f5a0', down: '#ff3864', upFill: 'rgba(0,245,160,0.08)', ema20: '#00e5ff', ema50: '#ff2bd6', vwap: '#ffd319', priceLine: '#ff2bd6', entry: '#fbeaff',
        order: '#ffd319', idea: '#ff8ae9', pillBg: 'rgba(18,4,36,0.92)', upText: '#7dffd0', downText: '#ff8aa6', vline: 'rgba(0,229,255,0.4)', vlabel: '#7ef3ff',
        warn: '#ffd319', a1: '#ff8ae9', a2: '#00e5ff', ink: '255,220,255', muted: '#9168b5', line: '#00e5ff', dot: '#12052a' } },
    { id: 'carbon', name: 'Carbon', tag: 'Flat graphite with one orange accent. No glow, no fuss.', layout: 'mirror', sound: 'carbon',
      chrome: { color: '#0c0c0d', symbol: '#a5a5ab', bg: '#0c0c0d' },
      mini: ['#0c0c0d', '#161617', '#ff6a00', '#2fbf71', '#ef4444'],
      pal: { bg: '#111112', text: '#7a7a80', grid: 'rgba(255,255,255,0.03)', border: '#262628', cross: 'rgba(255,138,42,0.4)', crossLabel: '#ff6a00',
        up: '#2fbf71', down: '#ef4444', upFill: 'rgba(47,191,113,0.08)', ema20: '#ff8a2a', ema50: '#8ab4ff', vwap: '#c792ea', priceLine: '#ff8a2a', entry: '#ededee',
        order: '#f5b301', idea: '#ff9a4d', pillBg: 'rgba(17,17,18,0.94)', upText: '#6fdc9f', downText: '#ff8585', vline: 'rgba(255,138,42,0.35)', vlabel: '#ffb27a',
        warn: '#f5b301', a1: '#ff9a4d', a2: '#ff8a2a', ink: '255,255,255', muted: '#6e6e75', line: '#ff8a2a', dot: '#111112' } },
    { id: 'glacier', name: 'Glacier', tag: 'Frosted deep-sea glass in aqua and ice blue.', layout: 'strip', sound: 'glacier',
      chrome: { color: '#03141f', symbol: '#a3cfd9', bg: '#021019' },
      mini: ['#021019', 'rgba(10,44,64,.8)', 'linear-gradient(135deg,#2de2e6,#5b8cff)', '#3ee6a6', '#ff6b81'],
      pal: { bg: 'rgba(0,0,0,0)', text: '#6b98a6', grid: 'rgba(160,240,255,0.05)', border: 'rgba(160,240,255,0.12)', cross: 'rgba(45,226,230,0.45)', crossLabel: '#0e7c93',
        up: '#3ee6a6', down: '#ff6b81', upFill: 'rgba(62,230,166,0.08)', ema20: '#2de2e6', ema50: '#ffc857', vwap: '#c89bff', priceLine: '#2de2e6', entry: '#e8fbff',
        order: '#ffc857', idea: '#a6c1ff', pillBg: 'rgba(3,22,34,0.92)', upText: '#8ff5cc', downText: '#ffa3b1', vline: 'rgba(45,226,230,0.4)', vlabel: '#8ef3f5',
        warn: '#ffc857', a1: '#a6c1ff', a2: '#2de2e6', ink: '220,250,255', muted: '#6b98a6', line: '#2de2e6', dot: '#021019' } },
  ];
  const LAYOUTS = [
    { id: 'classic', name: 'Classic', tip: 'Watchlist left, trade idea right' },
    { id: 'mirror', name: 'Mirrored', tip: 'Trade idea left, watchlist right' },
    { id: 'wide', name: 'Wide chart', tip: 'Slim watchlist, the most room for the chart' },
    { id: 'strip', name: 'Ticker strip', tip: 'Markets in a row of cards above the chart' },
  ];
  const byId = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
  const root = document.documentElement;
  let cur = THEMES[0]; let layout = 'classic'; const subs = [];
  let pal = Object.assign({}, BASE);

  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function chrome() {
    try { if (window.desk && window.desk.chrome) window.desk.chrome(cur.chrome); } catch (e) { /* not in the desktop app */ }
  }
  function fx() {
    let el = document.querySelector('.bg-fx');
    if (!el && document.body) { el = document.createElement('div'); el.setAttribute('aria-hidden', 'true'); document.body.prepend(el); }
    if (el) el.className = 'bg-fx ' + cur.id;
  }
  function apply(id, opts) {
    const o = opts || {};
    const t = byId(id); const changed = t !== cur;
    cur = t; pal = Object.assign({}, BASE, t.pal);
    if (o.animate && changed) { root.classList.add('theme-swap'); setTimeout(() => root.classList.remove('theme-swap'), 700); }
    root.dataset.theme = t.id;
    write('pd.theme', t.id);
    if (o.withLayout) setLayout(t.layout, true);
    fx(); chrome();
    if (window.Sound && Sound.setPack) Sound.setPack(t.sound);
    for (const f of subs) { try { f(t, pal); } catch (e) { /* a listener failed: keep going */ } }
    return t;
  }
  function setLayout(id, quiet) {
    layout = LAYOUTS.some((l) => l.id === id) ? id : 'classic';
    root.dataset.layout = layout;
    write('pd.layout', layout);
    if (!quiet) for (const f of subs) { try { f(cur, pal); } catch (e) { /* ignore */ } }
    window.dispatchEvent(new Event('resize'));
  }
  function onChange(f) { subs.push(f); }
  // rgba() from the theme's ink color (the color used for faint lines on this background)
  function ink(a) { return 'rgba(' + pal.ink + ',' + a + ')'; }
  function css(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }

  // Apply the saved choice now, before the body paints.
  const saved = read('pd.theme');
  cur = byId(saved); pal = Object.assign({}, BASE, cur.pal);
  root.dataset.theme = cur.id;
  layout = read('pd.layout') || cur.layout;
  root.dataset.layout = layout;
  document.addEventListener('DOMContentLoaded', () => { fx(); chrome(); if (window.Sound && Sound.setPack) Sound.setPack(cur.sound); });

  window.Theme = {
    THEMES, LAYOUTS, apply, setLayout, onChange, ink, css,
    get id() { return cur.id; }, get theme() { return cur; }, get layout() { return layout; }, get pal() { return pal; },
  };
})();
