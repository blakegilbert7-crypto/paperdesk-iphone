/* iPhone build: bottom tab bar, the More sheet, card-style tables, notifications through the
   service worker, and app updates. Loaded after app.js; does nothing on a wide screen. */
(function () {
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const isPhone = () => root.classList.contains('phone');

  const ICON = {
    markets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    trade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 3 8-8"/><path d="M15 7h5v5"/></svg>',
    positions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18"/></svg>',
    top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20V9h6v11M3 20v-6h6M15 20v-8h6v8M2 20h20"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  };
  const TABS = [['markets', 'Markets'], ['trade', 'Trade'], ['positions', 'Positions'], ['top', 'Top'], ['more', 'More']];
  let base = root.getAttribute('data-ptab') || 'trade'; // the last content tab
  let nav; let sheet;

  function play(s) { try { if (window.Sound) Sound.play(s); } catch (e) { /* ignore */ } }

  function setTab(tab, opts) {
    const o = opts || {};
    if (tab === 'markets' || tab === 'trade' || tab === 'positions') {
      base = tab;
      root.setAttribute('data-ptab', tab);
      try { sessionStorage.setItem('pd.ptab', tab); } catch (e) { /* ignore */ }
      if (!o.keepOverlays) closeOverlays();
      const lay = document.querySelector('.layout');
      if (lay && !o.keepScroll) lay.scrollTop = 0;
      if (tab === 'trade') setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
    }
    mark(tab);
  }
  function mark(tab) {
    if (!nav) return;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  }
  function closeOverlays(except) {
    if (except !== 'top' && window.Top && Top.isOpen()) Top.close();
    if (except !== 'learn' && window.Learn && Learn.isOpen()) Learn.close();
    if (except !== 'more') closeMore();
  }

  // ---------------------------------------------------------------- tab bar
  function buildNav() {
    nav = document.createElement('nav');
    nav.className = 'ptabs';
    nav.setAttribute('aria-label', 'Sections');
    nav.innerHTML = TABS.map(([id, label]) => '<button data-tab="' + id + '" data-sound="none"><span class="pt-ico">' + ICON[id] + '</span><span class="pt-lbl">' + label + '</span><i class="pt-badge num" hidden></i></button>').join('');
    document.body.appendChild(nav);
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const tab = b.dataset.tab;
      play('tick');
      if (tab === 'top') {
        if (window.Top && Top.isOpen()) { Top.close(); mark(base); return; }
        closeOverlays('top');
        if (window.Top) Top.open();
        mark('top');
        return;
      }
      if (tab === 'more') {
        if (sheet && !sheet.hidden) { closeMore(); mark(base); return; }
        closeOverlays('more');
        openMore();
        return;
      }
      setTab(tab);
    });
    mark(base);
  }

  // ---------------------------------------------------------------- More sheet
  function row(id, icon, title, sub) {
    return '<button class="pm-row" data-act="' + id + '"><span class="pm-ico"><span class="ico" data-icon="' + icon + '"></span></span><span class="pm-txt"><b>' + title + '</b><small>' + sub + '</small></span><span class="pm-chev">' + ICON.chev + '</span></button>';
  }
  function buildMore() {
    sheet = document.createElement('div');
    sheet.className = 'pmore';
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'More');
    sheet.innerHTML =
      '<div class="pm-wrap">' +
      '<div class="pm-sec">Your risk style</div><div class="pm-risk" id="pmRisk"></div>' +
      '<div class="pm-sec">Learn and research</div>' +
      row('learn', 'cap', 'Learn', 'How the strategies work, with replays of real trades') +
      row('research', 'book', 'Research', 'What held up in the backtests and what failed') +
      row('prop', 'trophy', 'Prop challenge', 'Practise a prop firm challenge under its real rules') +
      '<div class="pm-sec">App</div>' +
      row('search', 'search', 'Search markets', 'Stocks, ETFs, crypto, forex and futures') +
      row('theme', 'palette', 'Themes and layout', 'Six looks, from Aurora to Daylight') +
      row('settings', 'settings', 'Settings', 'Alerts, guard rails, sounds and account reset') +
      '<button class="pm-row" data-act="sound"><span class="pm-ico"><span class="ico" data-icon="sound"></span></span><span class="pm-txt"><b>Sound effects</b><small id="pmSoundTxt">On</small></span><label class="switch"><input type="checkbox" id="pmSound" tabindex="-1"><span></span></label></button>' +
      '<p class="pm-fine">PaperDesk is a simulator. It never connects to a broker or moves real money, and it only watches the market while it is open on your phone. Past results do not predict future results.</p>' +
      '</div>';
    document.body.appendChild(sheet);
    const risk = $('riskSeg');
    if (risk) $('pmRisk').appendChild(risk);
    if (window.Icons && Icons.hydrate) Icons.hydrate(sheet);
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'sound') { e.preventDefault(); const s = $('soundBtn'); if (s) s.click(); setTimeout(syncSound, 30); return; }
      const target = { learn: 'learnBtn', research: 'researchBtn', prop: 'propBtn', search: 'searchBtn', theme: 'themeBtn', settings: 'settingsBtn' }[act];
      closeMore();
      mark(act === 'learn' ? 'more' : base);
      const el = target && $(target);
      if (el) el.click();
    });
  }
  function syncSound() {
    const on = !(window.Sound && Sound.enabled === false);
    const c = $('pmSound'); if (c) c.checked = on;
    const t = $('pmSoundTxt'); if (t) t.textContent = on ? 'On' : 'Off';
  }
  function openMore() {
    if (!sheet) buildMore();
    sheet.hidden = false; sheet.classList.remove('out');
    syncSound();
    const risk = $('riskSeg');
    const on = risk && risk.querySelector('button.active');
    if (risk && on && window.Fx) requestAnimationFrame(() => Fx.seg(risk, on.dataset.v));
    mark('more');
    play('open');
  }
  function closeMore() {
    if (!sheet || sheet.hidden) return;
    sheet.classList.add('out');
    setTimeout(() => { if (sheet.classList.contains('out')) sheet.hidden = true; }, 200);
  }

  // ---------------------------------------------------------------- tables as cards
  function labelTables() {
    document.querySelectorAll('#positionsPane .empty, #ordersPane .empty, #historyPane .empty').forEach((el) => {
      if (/on the right/.test(el.textContent)) el.innerHTML = el.innerHTML.replace(/on the right/g, 'in the Trade tab');
    });
    ['positionsPane', 'ordersPane', 'historyPane'].forEach((id) => {
      const pane = $(id); if (!pane) return;
      pane.querySelectorAll('table.grid').forEach((t) => {
        const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        t.querySelectorAll('tbody tr').forEach((tr) => {
          [...tr.children].forEach((td, i) => { if (td.dataset.label === undefined) td.dataset.label = heads[i] || ''; });
        });
      });
    });
  }

  // ---------------------------------------------------------------- badges and sync
  function badge(tab, n) {
    if (!nav) return;
    const i = nav.querySelector('button[data-tab="' + tab + '"] .pt-badge');
    if (!i) return;
    i.hidden = !n; i.textContent = n || '';
  }
  function syncBadges() {
    const pc = $('posCount'); badge('positions', pc ? Number(pc.textContent) || 0 : 0);
    const tb = document.querySelector('#topBtn .tb-badge'); badge('top', tb ? Number(tb.textContent) || 0 : 0);
  }
  function watch() {
    const mo = new MutationObserver(() => { labelTables(); syncBadges(); });
    ['positionsPane', 'ordersPane', 'historyPane', 'posCount', 'topBtn'].forEach((id) => { const el = $(id); if (el) mo.observe(el, { childList: true, subtree: true, characterData: true }); });
    // keep the tab bar in step when Top trades or Learn close themselves
    new MutationObserver(() => {
      const b = document.body.classList;
      if (!b.contains('top-open') && nav && nav.querySelector('button.on[data-tab="top"]')) mark(base);
      if (!b.contains('learn-open') && nav && nav.querySelector('button.on[data-tab="more"]') && (!sheet || sheet.hidden)) mark(base);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // ---------------------------------------------------------------- notifications and updates
  function shimNotifications() {
    const N = window.Notification;
    if (!N || !('serviceWorker' in navigator)) return;
    function PhoneNotification(title, opts) {
      const o = Object.assign({ icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' }, opts || {});
      delete o.silent;
      navigator.serviceWorker.ready.then((r) => r.showNotification(title, o)).catch(() => {});
      this.onclick = null;
      this.close = () => {};
    }
    Object.defineProperty(PhoneNotification, 'permission', { get: () => N.permission });
    PhoneNotification.requestPermission = (cb) => N.requestPermission(cb);
    window.Notification = PhoneNotification;
  }
  function registerWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      const go = () => { if (!reloaded) { reloaded = true; location.reload(); } };
      if (document.hidden) { document.addEventListener('visibilitychange', () => { if (!document.hidden) go(); }, { once: true }); return; }
      if (window.Fx && Fx.toast) Fx.toast({ title: 'PaperDesk was updated', body: 'Reload to get the newest version.', icon: 'refresh', ttl: 30000, actions: [{ label: 'Reload', onClick: go }] });
    });
  }

  function webCopy() {
    const rows = document.querySelectorAll('#settingsModal .set-row');
    rows.forEach((r) => {
      const b = r.querySelector('b');
      if (b && /Desktop notifications/.test(b.textContent)) {
        b.textContent = 'Notifications';
        const p = r.querySelector('p');
        if (p) p.textContent = 'Show a banner when a stop or target is hit, or a sell alert fires, while PaperDesk is open in the background. It only watches the market while it is open.';
      }
    });
  }

  function init() {
    buildNav();
    watch();
    labelTables();
    syncBadges();
    webCopy();
    shimNotifications();
    registerWorker();
    window.addEventListener('pd:symbol', () => { if (isPhone()) setTab('trade'); });
    document.addEventListener('click', (e) => {
      if (!isPhone()) return;
      if (e.target.closest('.w-row, .sr')) setTimeout(() => setTab('trade'), 0);
      if (e.target.closest('#acctChip')) setTab('positions');
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncBadges(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.Phone = { setTab };
})();
