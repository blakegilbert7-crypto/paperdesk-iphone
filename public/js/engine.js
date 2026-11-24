/* PaperDesk engine, bundled from core/ for the iPhone build. Paper money only. */
(function () {
"use strict";
var defs = {
"web/engine-entry.js": [function (module, exports, require) {
'use strict';
// PaperDesk engine for the iPhone (Home Screen) build: the same core modules as the Windows app,
// running inside the page. The paper account lives in this phone's localStorage. Yahoo prices go
// through the site's own relay (Yahoo does not allow browsers to read it directly); Coinbase allows
// browsers, so crypto goes straight there. Paper money only: nothing here can reach a broker.
const http = require('../core/http');

const VIA_RELAY = /^https:\/\/query[12]\.finance\.yahoo\.com\//;
const DIRECT = /^https:\/\/api\.exchange\.coinbase\.com\//;
const SYNC_BASE = location.origin + '/sync';
http.setFetch((url, opts) => {
  const o = Object.assign({}, opts || {});
  // sync codes go to this site's own /sync service, with their JSON body
  if (url.startsWith(SYNC_BASE + '/')) return fetch(url, o);
  // browsers set their own User-Agent; extra headers would also trigger CORS preflights
  const accept = o.headers && (o.headers.Accept || o.headers.accept);
  o.headers = accept ? { Accept: accept } : {};
  if (VIA_RELAY.test(url)) return fetch('relay?u=' + encodeURIComponent(url), o);
  if (DIRECT.test(url)) return fetch(url, o);
  return Promise.reject(new Error('Blocked host: ' + new URL(url).host));
});

const { PaperAccount } = require('../core/paper');
const { createApi } = require('../core/api');
const { Sync } = require('../core/sync');

const KEY = 'pd.account.v1';
class PhoneAccount extends PaperAccount {
  load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.version === 1) return s; } catch (e) { /* first run */ }
    return null;
  }
  save() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveNow(), 300); }
  saveNow() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch (e) {
      this.emit('event', { type: 'error', message: 'Could not save the paper account on this phone: ' + e.message });
    }
  }
}

const account = new PhoneAccount({});
const SYNC_KEY = 'pd.sync.v1';
account.sync = new Sync(account, {
  base: SYNC_BASE,
  store: {
    read() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) { return null; } },
    write(v) { try { if (v == null) localStorage.removeItem(SYNC_KEY); else localStorage.setItem(SYNC_KEY, JSON.stringify(v)); } catch (e) { /* storage full */ } },
  },
});
const api = createApi(account);
const clone = (x) => (x === undefined ? x : typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

async function call(method, params) {
  try {
    const result = await api.handle(method, clone(params || {}));
    return { ok: true, result: clone(result) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
function onEvent(cb) { account.on('event', (ev) => { try { cb(clone(ev)); } catch (e) { /* ignore */ } }); }

// The monitor loop: fills working orders and checks stops and targets while the app is open.
// iPhone pauses the page in the background; on return, the engine checks the bars it missed.
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { await account.tick(); } catch (e) { /* network hiccup: next tick */ } finally { ticking = false; }
}
setInterval(() => { if (!document.hidden) tick(); }, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { account.saveNow(); return; }
  account.sync.lastPull = 0; // back on screen: check for trades made on the other device
  tick();
});
addEventListener('pagehide', () => account.saveNow());

window.Engine = { call, onEvent, tick };

}, {"../core/http":"core/http.js","../core/paper":"core/paper.js","../core/api":"core/api.js","../core/sync":"core/sync.js"}],
"core/http.js": [function (module, exports, require) {
'use strict';
// Tiny HTTP JSON helper with a swappable fetch implementation. Inside the
// desktop app this is Electron's net.fetch (uses the Windows proxy settings and
// certificate store); in the dev server it is Node's fetch.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let fetchImpl = (url, opts) => fetch(url, opts);

function setFetch(fn) {
  fetchImpl = fn;
}

async function getJSON(url, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 12000);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: Object.assign({ 'User-Agent': BROWSER_UA, Accept: 'application/json' }, opts.headers || {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const host = new URL(url).host;
      const err = new Error('HTTP ' + res.status + ' from ' + host);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('Timed out contacting ' + new URL(url).host);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// JSON request for PaperDesk's own sync service: returns { status, json } for any HTTP status, so
// callers can handle 404 and 409 themselves. Throws only on network errors and timeouts.
async function requestJSON(method, url, body, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
  try {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('The sync service took too long to answer.');
    throw new Error('Could not reach the sync service. Check your internet connection.');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getJSON, requestJSON, setFetch, BROWSER_UA };

}, {}],
"core/paper.js": [function (module, exports, require) {
'use strict';
// The paper trading account: simulated cash, orders, positions and fills
// against live prices. Nothing here ever talks to a broker.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getInstrument, quoteToUsd, slippage, feeUsd, notionalUsd, roundToStep, roundPrice } = require('./markets');
const { roundTrip } = require('./costs');
const { getProfile, sizePosition, leverageFor } = require('./risk');
const { getPrice, getCandles, isBarClosed } = require('./data');
const { getStrategy, buildContext } = require('./strategies');
const { etParts, etOffsetSec } = require('./time');
const PROP = require('./prop');
const EXITS = require('./exits');

const DEFAULT_CASH = 100000;
// The personal daily stop for prop challenges, as a share of the firm's daily loss limit (research
// round 17 moved it from half the limit to 70%; see RESEARCH.md).
const SELF_STOP_SHARE = 0.7;
// Playbook guard rails for the regular account (on by default, switchable in Settings). They are
// the rules the research used for the playbook (RESEARCH.md rounds 2-17): a personal daily stop at
// 70% of the daily loss limit that closes everything, at most 2 US stock-index trades at once
// (they move together), a stop on every trade, and no trade risking more than twice the profile's
// risk per trade.
const GUARD = { dailyStopShare: SELF_STOP_SHARE, maxIndexTrades: 2, riskCapMult: 2 };
const US_INDEX = new Set(['SPY', 'QQQ', 'IWM', 'MES', 'MNQ']);
// Sell alerts: 'all' (the default, blake's pick) alerts when a trade's own strategy says sell and
// also when a winning trade looks shaky (core/exits.js; the shaky signs lowered results in testing,
// see RESEARCH.md round 20, so those alerts say so); 'tested' alerts only on the strategy's own
// exits (the ones the research tested); 'off' never alerts.
const SELL_MODES = ['off', 'tested', 'all'];
// Beast Mode (blake's secret code, entered under Settings > Enter a code): while it is on, every
// trade placed closes as a winner, at its target or one risk unit (1R) in profit, whichever the
// real exit beats, and the account's limits are lifted (profile caps, guard rails, the drawdown and
// daily-loss locks, challenge locks, closed-market market orders). Nothing on screen marks it: the
// trades look like any other trade. They carry a hidden beast flag so the mistakes panel, ghosts
// and sell alerts skip them.
const BEAST_CODE = 'beastmode99898';
function isBeastCode(code) { return String(code || '').toLowerCase().replace(/\s+/g, '') === BEAST_CODE; }
const EXIT_WORDS = { 'exit rule': 'its exit rule fired', 'trailing stop': 'price closed past its trailing stop', 'time limit': 'it reached its time limit' };

function nowSec() { return Math.floor(Date.now() / 1000); }

function localDayKey(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

// 16:00 New York time on the current trading day, as a UTC timestamp.
function usCloseUtc(utcSec) {
  const p = etParts(utcSec);
  const local = Date.UTC(p.year, p.month - 1, p.day, 16, 0, 0) / 1000;
  return local - etOffsetSec(utcSec);
}

// UTC time of an ET wall-clock minute on the current New York day.
function flatTimeUtc(utcSec, etMin) {
  const p = etParts(utcSec);
  return Date.UTC(p.year, p.month - 1, p.day, Math.floor(etMin / 60), etMin % 60, 0) / 1000 - etOffsetSec(utcSec);
}
// Between the firm's flat-by time and the 6 PM ET session open.
function afterFlatTime(preset) {
  const m = etParts(nowSec()).minutes;
  return m >= preset.flatByEt && m < 18 * 60;
}

function freshState(cash, profile) {
  const t = nowSec();
  return {
    version: 1,
    createdAt: t,
    startingCash: cash,
    balance: cash,
    profile: profile || 'medium',
    positions: [],
    orders: [],
    history: [],
    equityCurve: [{ time: t, value: cash }],
    day: { key: localDayKey(), startEquity: cash },
    nextId: 1,
  };
}

class PaperAccount extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.file = o.file || null;
    this.prices = new Map(); // symbol -> { price, time, status }
    this.queue = Promise.resolve();
    this.state = this.load() || freshState(DEFAULT_CASH);
    this.saveTimer = null;
  }

  // ----- persistence -----
  load() {
    if (!this.file) return null;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && s.version === 1) return s;
    } catch (e) { /* first run */ }
    return null;
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.emit('event', { type: 'error', message: 'Could not save account: ' + e.message });
    }
  }

  // Serialize every mutation so the monitor loop and the UI never race.
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ----- valuation -----
  // A Beast Mode trade is valued at its shown P&L (see beastShownNet), which only ever climbs, so
  // the position, the account equity and the day's P&L all read green. Its close books at least that.
  unrealized(pos, price) {
    if (pos.beast && price == null) return (pos.feesPaid || 0) + beastShownNet(pos);
    const inst = getInstrument(pos.symbol);
    const px = price != null ? price : pos.lastPrice != null ? pos.lastPrice : pos.entry;
    return (px - pos.entry) * pos.dir * pos.qty * inst.multiplier * quoteToUsd(inst, px);
  }

  usedNotional(market) {
    return this.state.positions.reduce((a, p) => {
      const inst = getInstrument(p.symbol);
      if (market && inst.market !== market) return a;
      return a + notionalUsd(inst, p.lastPrice || p.entry, p.qty);
    }, 0);
  }

  // open risk (to the stop) for one market group, including working orders
  clusterRisk(market) {
    const all = this.state.positions.concat(this.state.orders);
    return all.reduce((a, p) => {
      const inst = getInstrument(p.symbol);
      if (inst.market !== market || p.stop == null) return a;
      const px = p.entry || p.price;
      return a + Math.abs(px - p.stop) * p.qty * inst.multiplier * quoteToUsd(inst, px);
    }, 0);
  }

  equity() {
    return this.state.balance + this.state.positions.reduce((a, p) => a + this.unrealized(p), 0);
  }

  rollDay() {
    const key = localDayKey();
    if (this.state.day.key !== key) {
      this.state.day = { key, startEquity: this.equity() };
      this.save();
    }
  }

  dayPnl() {
    this.rollDay();
    return this.equity() - this.state.day.startEquity;
  }

  guardOn() { return !this.state.challenge && this.state.guard !== false; }
  guardStopUsd() {
    const profile = getProfile(this.state.profile);
    return this.state.day.startEquity * profile.dailyLossPct / 100 * GUARD.dailyStopShare;
  }
  indexTrades() {
    return this.state.positions.filter((p) => US_INDEX.has(p.symbol)).map((p) => p.symbol)
      .concat(this.state.orders.filter((o) => US_INDEX.has(o.symbol)).map((o) => o.symbol + ' order'));
  }
  // Would the guard rails block a new trade on this symbol right now? (shown on trade ideas)
  guardBlock(symbol) {
    if (!this.guardOn()) return null;
    if (this.state.day.guardStopped || this.dayPnl() <= -this.guardStopUsd()) return 'Your daily stop hit today, so the guard rails block new trades until tomorrow.';
    if (US_INDEX.has(symbol)) {
      const open = this.indexTrades();
      if (open.length >= GUARD.maxIndexTrades) return 'Guard rail: ' + open.length + ' US stock-index trades are already open (' + open.join(', ') + '); the playbook allows ' + GUARD.maxIndexTrades + ' at once.';
    }
    return null;
  }
  setGuard(on) {
    this.state.guard = !!on;
    this.save();
    return { ok: true, guard: this.state.guard };
  }
  sellMode() { return SELL_MODES.includes(this.state.sellAlerts) ? this.state.sellAlerts : 'all'; }
  setSellAlerts(mode) {
    if (!SELL_MODES.includes(mode)) throw new Error('Unknown sell alert setting.');
    this.state.sellAlerts = mode;
    this.save();
    return { ok: true, sellAlerts: mode };
  }
  setBeast(on) {
    this.state.beast = !!on;
    this.save();
    this.emit('event', { type: 'beast', quiet: true });
    return { ok: true, beast: this.state.beast };
  }

  guardView() {
    const on = this.guardOn();
    return {
      on, available: !this.state.challenge, setting: this.state.guard !== false, stopped: !!(on && this.state.day.guardStopped),
      dailyStopUsd: this.guardStopUsd(), dailyStopShare: GUARD.dailyStopShare, dayLossUsd: Math.max(0, -this.dayPnl()),
      indexOpen: this.indexTrades().length, maxIndexTrades: GUARD.maxIndexTrades, riskCapMult: GUARD.riskCapMult,
      riskCapUsd: this.equity() * getProfile(this.state.profile).riskPct / 100 * GUARD.riskCapMult,
    };
  }

  lockedReason() {
    const why = this.lockCheck();
    return this.state.beast ? null : why;
  }
  lockCheck() {
    const ch = this.state.challenge;
    if (ch) {
      if (ch.status === 'passed') return 'Challenge passed. Start a new challenge or go back to your regular account from the Prop Challenge panel.';
      if (ch.status === 'failed') return 'Challenge failed (' + ch.reason + '). Start a new one or go back to your regular account from the Prop Challenge panel.';
      if (ch.paused) return 'Daily loss limit hit: the firm pauses trading until the next session at 6 PM New York time (5 PM Central).';
      const preset = PROP.getPreset(ch.presetId);
      if (preset && preset.flatByEt != null && afterFlatTime(preset)) return 'This firm requires you to be flat by ' + preset.flatBy + '. New trades open at 6 PM New York time.';
      return null;
    }
    const profile = getProfile(this.state.profile);
    const eqNow = this.equity();
    this.state.peakEquity = Math.max(this.state.peakEquity || this.state.startingCash, eqNow);
    const dd = 1 - eqNow / this.state.peakEquity;
    if (dd * 100 >= profile.drawdownPct) {
      return 'Drawdown breaker: the account is ' + (dd * 100).toFixed(1) + '% below its peak (the ' + profile.name + ' limit is ' + profile.drawdownPct + '%). Trading is paused; reset the account in Settings or switch profile to continue.';
    }
    if (this.guardOn() && (this.state.day.guardStopped || this.dayPnl() <= -this.guardStopUsd())) {
      return 'Daily stop hit: your $' + Math.round(this.guardStopUsd()).toLocaleString('en-US') + ' daily stop (70% of the ' + profile.name + ' daily loss limit) was reached today. New trades unlock tomorrow. You can turn the guard rails off in Settings.';
    }
    const pnl = this.dayPnl();
    const limit = this.state.day.startEquity * profile.dailyLossPct / 100;
    if (pnl <= -limit) {
      return 'Daily loss limit hit (' + profile.dailyLossPct + '% under the ' + profile.name + ' profile). New trades unlock tomorrow. This is the rule that keeps one bad day from becoming a blown account.';
    }
    return null;
  }

  // ----- prices -----
  async refreshPrice(symbol) {
    const p = await getPrice(symbol);
    if (p) this.prices.set(symbol, p);
    return p;
  }

  async livePrice(symbol) {
    const p = await this.refreshPrice(symbol);
    if (!p) throw new Error('No live price for ' + symbol + ' right now.');
    return p;
  }

  // ----- orders -----
  async preview(params) {
    const inst = getInstrument(params.symbol);
    const profile = getProfile(this.state.profile);
    const dir = params.side === 'sell' ? -1 : 1;
    const type = params.type || 'market';
    let entry = Number(params.price);
    if (type === 'market' || !(entry > 0)) entry = (await this.livePrice(params.symbol)).price;
    const stop = params.stop != null && params.stop !== '' ? Number(params.stop) : null;
    const target = params.target != null && params.target !== '' ? Number(params.target) : null;
    const problems = [];
    const beast = !!this.state.beast;
    if (stop != null && (dir > 0 ? stop >= entry : stop <= entry)) problems.push('Stop loss must be ' + (dir > 0 ? 'below' : 'above') + ' the entry price for a ' + (dir > 0 ? 'buy' : 'sell') + '.');
    if (target != null && (dir > 0 ? target <= entry : target >= entry)) problems.push('Take profit must be ' + (dir > 0 ? 'above' : 'below') + ' the entry price for a ' + (dir > 0 ? 'buy' : 'sell') + '.');
    let qty = params.qty != null && params.qty !== '' ? roundToStep(Number(params.qty), inst.qtyStep) : null;
    let sizing = null;
    if (qty == null) {
      if (stop == null && !beast) problems.push('Set a stop loss so the app can size the trade to your risk, or enter a quantity.');
      else if (stop != null || beast) {
        // Beast Mode sizes a stop-less trade as if its stop were 1% away, and ignores used buying power.
        const sizeStop = stop != null ? stop : roundPrice(inst, entry * (1 - dir * 0.01));
        sizing = sizePosition({ inst, equity: this.equity(), entry, stop: sizeStop, profile, usedNotional: beast ? 0 : this.usedNotional(inst.market), riskPct: params.riskPct });
        qty = sizing.qty;
        if (!qty && beast) qty = inst.minQty;
        if (!qty && sizing.reason) problems.push(sizing.reason);
      }
    }
    qty = qty || 0;
    const q2u = quoteToUsd(inst, entry);
    const riskUsd = stop != null ? Math.abs(entry - stop) * qty * inst.multiplier * q2u : null;
    const rewardUsd = target != null ? Math.abs(target - entry) * qty * inst.multiplier * q2u : null;
    const notional = notionalUsd(inst, entry, qty);
    const lev = leverageFor(profile, inst);
    const room = this.equity() * lev - this.usedNotional(inst.market);
    if (!beast && qty && notional > room + 1e-6) {
      const maxQty = roundToStep(room / (entry * inst.multiplier * q2u), inst.qtyStep);
      problems.push('That is $' + Math.round(notional).toLocaleString('en-US') + ' of ' + inst.market + ' exposure; the ' + profile.name + ' profile allows $' + Math.max(0, Math.round(room)).toLocaleString('en-US') + ' more (' + lev + 'x equity). Max size now: ' + maxQty + ' ' + inst.unit + '.');
    }
    if (!beast && this.guardOn() && qty) {
      if (stop == null) problems.push('Guard rail: set a stop loss. Every playbook trade has one, so a bad trade stays a small loss. (Settings > Playbook guard rails)');
      const cap = this.equity() * profile.riskPct / 100 * GUARD.riskCapMult;
      if (riskUsd != null && riskUsd > cap * 1.001) problems.push('Guard rail: this risks $' + Math.round(riskUsd).toLocaleString('en-US') + ', more than twice your ' + profile.name + ' risk per trade ($' + Math.round(cap).toLocaleString('en-US') + ' cap). Shrink the size or tighten the stop.');
      if (US_INDEX.has(inst.symbol)) {
        const open = this.indexTrades();
        if (open.length >= GUARD.maxIndexTrades) problems.push('Guard rail: ' + open.length + ' US stock-index trades are already open (' + open.join(', ') + '). The playbook allows ' + GUARD.maxIndexTrades + ' because SPY, QQQ, IWM, MES and MNQ tend to fall together.');
      }
    }
    if (!beast && riskUsd != null && qty) {
      const capUsd = this.equity() * profile.clusterRiskPct / 100;
      const used = this.clusterRisk(inst.market);
      if (used + riskUsd > capUsd * 1.02) {
        problems.push('Open risk in ' + inst.market + ' would be $' + Math.round(used + riskUsd).toLocaleString('en-US') + '; the ' + profile.name + ' profile caps risk per market group at ' + profile.clusterRiskPct + '% ($' + Math.round(capUsd).toLocaleString('en-US') + ') because these markets tend to move together.');
      }
    }
    return {
      symbol: inst.symbol, side: dir > 0 ? 'buy' : 'sell', type, entry, stop, target, qty, notional,
      riskUsd, rewardUsd, rr: riskUsd && rewardUsd ? rewardUsd / riskUsd : null,
      riskPctOfEquity: riskUsd != null ? riskUsd / this.equity() * 100 : null,
      estFees: feeUsd(inst, entry, qty) * 2,
      estCost: roundTrip(inst, entry, qty).usd,
      capped: sizing && !beast ? sizing.capped : false,
      problems,
    };
  }

  placeOrder(params) {
    return this.exclusive(async () => {
      const inst = getInstrument(params.symbol);
      const profile = getProfile(this.state.profile);
      const locked = this.lockedReason();
      if (locked) throw new Error(locked);
      const beast = !!this.state.beast;
      const ch = this.state.challenge;
      if (ch && !beast) {
        const preset = PROP.getPreset(ch.presetId);
        if (preset.markets && !preset.markets.includes(inst.market)) {
          throw new Error(preset.label + ' accounts trade ' + preset.markets.join(' and ') + ' only. Pick a futures contract (or SPY/QQQ, which track the same indexes live).');
        }
      }
      const openCount = this.state.positions.length + this.state.orders.length;
      if (!beast && openCount >= profile.maxPositions) {
        throw new Error('The ' + profile.name + ' profile allows ' + profile.maxPositions + ' open trades/orders at once. Close one first, or switch profile.');
      }
      const type = params.type || 'market';
      const live = await this.livePrice(inst.symbol);
      if (!beast && type === 'market' && live.status && live.status.state === 'closed') {
        throw new Error(inst.symbol + ' market is closed right now. Use a limit or stop order, or try crypto (open 24/7).');
      }
      const pv = await this.preview(Object.assign({}, params, { type }));
      if (pv.problems.length) throw new Error(pv.problems[0]);
      if (!(pv.qty > 0)) throw new Error('Quantity must be greater than zero.');
      const dir = pv.side === 'buy' ? 1 : -1;
      const base = {
        symbol: inst.symbol, dir, qty: pv.qty, stop: pv.stop, target: pv.target,
        source: params.source === 'suggested' ? 'suggested' : 'manual',
        strategy: params.strategy || null, tf: params.tf || null, note: params.note || null,
        grade: params.grade || null,
        closeAt: this.closeAtFor(params, inst),
        // for "your mistakes, in dollars": what the app thought of it, and the stop it started with
        verdict: ['take', 'caution', 'skip'].includes(params.verdict) ? params.verdict : null,
        concerns: Array.isArray(params.concerns) ? params.concerns.slice(0, 6).map((c) => ({ tone: c && c.tone === 'bad' ? 'bad' : 'warn', text: String((c && c.text) || '').slice(0, 300) })) : null,
        stop0: pv.stop,
        managed: params.source === 'suggested' && params.strategy && params.tf && params.managed ? { strategy: params.strategy, tf: params.tf } : null,
        beast: this.state.beast ? true : undefined,
      };
      if (type === 'market') {
        const pos = this.openPosition(base, live.price, 'market');
        return { ok: true, position: pos };
      }
      const price = roundPrice(inst, Number(params.price));
      if (!(price > 0)) throw new Error('Enter a ' + type + ' price.');
      if (type === 'limit' && (dir > 0 ? price >= live.price : price <= live.price)) {
        throw new Error('A buy limit must be below the current price (a sell limit above it). Use a stop order to enter on a breakout.');
      }
      if (type === 'stop' && (dir > 0 ? price <= live.price : price >= live.price)) {
        throw new Error('A buy stop must be above the current price (a sell stop below it).');
      }
      const order = Object.assign({ id: this.state.nextId++, type, price, createdAt: nowSec(), side: dir > 0 ? 'buy' : 'sell' }, base);
      this.state.orders.push(order);
      this.save();
      this.emit('event', { type: 'order-placed', symbol: order.symbol, message: (dir > 0 ? 'Buy ' : 'Sell ') + type + ' order for ' + order.qty + ' ' + inst.symbol + ' @ ' + price + ' is working.', order });
      return { ok: true, order };
    });
  }

  openPosition(base, rawPrice, how) {
    const inst = getInstrument(base.symbol);
    const fill = roundPrice(inst, rawPrice + base.dir * slippage(inst, rawPrice));
    const fee = feeUsd(inst, fill, base.qty);
    this.state.balance -= fee;
    const q2u = quoteToUsd(inst, fill);
    const pos = Object.assign({}, base, {
      id: this.state.nextId++,
      side: base.dir > 0 ? 'long' : 'short',
      entry: fill, openedAt: nowSec(), feesPaid: fee, lastPrice: fill,
      riskUsd: base.stop != null ? Math.abs(fill - base.stop) * base.qty * inst.multiplier * q2u : null,
      mfe: 0, mae: 0,
    });
    if (pos.beast || this.state.beast) pos.beast = true; else delete pos.beast;
    this.state.positions.push(pos);
    if (this.state.challenge) this.state.challenge.tradedToday = true;
    this.save();
    this.emit('event', {
      type: 'opened', symbol: pos.symbol, sound: 'execute',
      message: (pos.dir > 0 ? 'Bought ' : 'Sold short ') + pos.qty + ' ' + pos.symbol + ' @ ' + fill + (how === 'market' ? '' : ' (' + how + ' order filled)'),
      position: pos,
    });
    return pos;
  }

  closePosition(id, reason, priceOverride) {
    return this.exclusive(async () => this._close(id, reason || 'manual', priceOverride));
  }

  async _close(id, reason, priceOverride) {
    const idx = this.state.positions.findIndex((p) => p.id === Number(id));
    if (idx < 0) throw new Error('Position not found (maybe it already closed).');
    const pos = this.state.positions[idx];
    const inst = getInstrument(pos.symbol);
    let raw = priceOverride;
    if (raw == null) {
      const live = await this.livePrice(pos.symbol);
      raw = live.price;
    }
    let exit = roundPrice(inst, raw - pos.dir * slippage(inst, raw));
    if (pos.beast) {
      const w = beastExit(pos, inst, exit);
      exit = w.exit;
      // never book less than the P&L the trade was showing
      const shown = beastShownNet(pos);
      if (netAt(pos, inst, exit) < shown) { exit = priceForNet(pos, inst, shown); w.forced = true; }
      // a forced win reads like an ordinary exit: a stop-out becomes the target (or a trailed stop)
      if (w.forced && reason === 'stop') reason = pos.target != null ? 'target' : 'trailing stop';
    }
    const fee = feeUsd(inst, exit, pos.qty);
    const gross = (exit - pos.entry) * pos.dir * pos.qty * inst.multiplier * quoteToUsd(inst, exit);
    const pnl = gross - fee - pos.feesPaid;
    this.state.balance += gross - fee;
    this.state.positions.splice(idx, 1);
    const rec = Object.assign({}, pos, {
      exit, closedAt: nowSec(), reason, pnl, fees: pos.feesPaid + fee,
      R: pos.riskUsd ? pnl / pos.riskUsd : null,
    });
    delete rec.lastPrice; delete rec.sellAt; delete rec.sellBar; delete rec.sellSent;
    if (this.state.challenge && this.state.challenge.status === 'active') {
      this.state.challenge.dayPnl += pnl; this.state.challenge.tradedToday = true;
    }
    this.state.history.unshift(rec);
    if (this.state.history.length > 500) this.state.history.length = 500;
    if (reason === 'manual' && !pos.beast && (pos.stop != null || pos.managed)) {
      const g = this.state.ghosts || (this.state.ghosts = []);
      g.push({ id: rec.id, symbol: pos.symbol, dir: pos.dir, qty: pos.qty, entry: pos.entry, stop: pos.stop, target: pos.target,
        managed: pos.managed, closeAt: pos.closeAt, openedAt: pos.openedAt, since: rec.closedAt, feesPaid: pos.feesPaid });
      if (g.length > 40) g.splice(0, g.length - 40);
    }
    this.pushEquity();
    this.save();
    const win = pnl > 0;
    const label = { target: 'Target hit', stop: 'Stopped out', 'trailing stop': 'Trailing stop hit', 'exit rule': 'Strategy exit', 'close of day': 'Closed at the bell', 'time limit': 'Time exit', 'challenge rule': 'Closed by the challenge rules', 'daily stop': 'Closed by your daily stop' }[reason] || 'Closed';
    this.emit('event', {
      type: 'closed', symbol: pos.symbol, sound: win ? 'win' : 'loss', win,
      message: label + ': ' + pos.symbol + ' ' + (pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2) + (rec.R != null ? ' (' + (rec.R >= 0 ? '+' : '') + rec.R.toFixed(2) + 'R)' : ''),
      trade: rec,
    });
    return rec;
  }

  cancelOrder(id) {
    return this.exclusive(async () => {
      const idx = this.state.orders.findIndex((o) => o.id === Number(id));
      if (idx < 0) throw new Error('Order not found.');
      const [o] = this.state.orders.splice(idx, 1);
      this.save();
      this.emit('event', { type: 'order-cancelled', symbol: o.symbol, message: 'Cancelled ' + o.side + ' ' + o.type + ' order on ' + o.symbol + '.' });
      return { ok: true };
    });
  }

  modifyPosition(id, changes) {
    return this.exclusive(async () => {
      const pos = this.state.positions.find((p) => p.id === Number(id));
      if (!pos) throw new Error('Position not found.');
      const inst = getInstrument(pos.symbol);
      const px = pos.lastPrice || pos.entry;
      if (changes.stop !== undefined) {
        const s = changes.stop === null || changes.stop === '' ? null : roundPrice(inst, Number(changes.stop));
        if (s != null && (pos.dir > 0 ? s >= px : s <= px)) throw new Error('Stop must be ' + (pos.dir > 0 ? 'below' : 'above') + ' the current price.');
        // moved further from the price (or removed): more risk than planned
        if (pos.stop != null && (s == null || (s - pos.stop) * pos.dir < 0)) pos.stopLoosened = true;
        pos.stop = s;
      }
      if (changes.target !== undefined) {
        const t = changes.target === null || changes.target === '' ? null : roundPrice(inst, Number(changes.target));
        if (t != null && (pos.dir > 0 ? t <= px : t >= px)) throw new Error('Target must be ' + (pos.dir > 0 ? 'above' : 'below') + ' the current price.');
        pos.target = t;
      }
      this.save();
      return { ok: true, position: pos };
    });
  }

  setProfile(id) {
    this.state.profile = getProfile(id).id;
    this.save();
    return { ok: true, profile: this.state.profile };
  }

  reset(cash) {
    return this.exclusive(async () => {
      const amount = Math.max(1000, Math.min(10000000, Number(cash) || DEFAULT_CASH));
      this.state = freshState(amount, this.state.profile);
      this.saveNow();
      this.emit('event', { type: 'reset', message: 'Account reset to $' + amount.toLocaleString('en-US') + ' of paper money.' });
      return { ok: true };
    });
  }

  pushEquity() {
    const t = nowSec();
    const v = this.equity();
    const curve = this.state.equityCurve;
    const last = curve[curve.length - 1];
    if (last && t - last.time < 60) { last.value = v; } else curve.push({ time: t, value: v });
    if (curve.length > 3000) curve.splice(0, curve.length - 3000);
  }

  // ----- the monitor loop: fills pending orders and enforces stops/targets -----
  tick() {
    const run = this.tickInner();
    // sync codes (core/sync.js): upload changes or fetch the other device's, outside the lock
    if (this.sync) run.then(() => this.sync.maybe(), () => this.sync.maybe());
    return run;
  }

  tickInner() {
    return this.exclusive(async () => {
      const symbols = new Set(this.state.positions.map((p) => p.symbol).concat(this.state.orders.map((o) => o.symbol)));
      for (const sym of symbols) {
        let data;
        try { data = await this.refreshPrice(sym); } catch (e) { continue; }
        if (!data || data.price == null) continue;
        await this.checkSymbol(sym, data);
      }
      for (const p of this.state.positions.slice()) {
        if (p.managed) {
          try { await this.manage(p); } catch (e) { /* data hiccup: try next tick */ }
        }
      }
      for (const p of this.state.positions.slice()) {
        if (!this.state.positions.includes(p)) continue;
        try { await this.sellCheck(p); } catch (e) { /* data hiccup: try next tick */ }
      }
      if (symbols.size) this.pushEquity();
      this.rollDay();
      await this.guardCheck();
      await this.challengeCheck();
      await this.ghostCheck();
    });
  }

  // ----- prop firm challenge mode -----
  closeAtFor(params, inst) {
    const now = nowSec();
    let t = params.eod && inst.session === 'us_equity' ? usCloseUtc(now) - 60 : null;
    const ch = this.state.challenge;
    const preset = ch && PROP.getPreset(ch.presetId);
    if (preset && preset.flatByEt != null) {
      const f = flatTimeUtc(now, preset.flatByEt) - 30;
      t = t == null ? f : Math.min(t, f);
    }
    return t;
  }

  startChallenge(presetId, opts) {
    const o = opts || {};
    return this.exclusive(async () => {
      const preset = PROP.getPreset(presetId);
      if (!preset) throw new Error('Unknown challenge type.');
      const prev = this.state.challenge ? this.state.stash : this.state;
      const fresh = freshState(preset.startBalance, this.state.profile);
      fresh.challenge = Object.assign(PROP.newChallengeState(preset, nowSec()), { attempt: ((this.state.challenge && this.state.challenge.attempt) || 0) + 1, selfStop: o.selfStop && preset.dailyLoss ? SELF_STOP_SHARE : null });
      fresh.stash = prev;
      this.state = fresh;
      this.saveNow();
      this.emit('event', { type: 'challenge', sound: 'execute', message: preset.label + ' challenge started: $' + preset.startBalance.toLocaleString('en-US') + ' account, target +$' + preset.phases[0].target.toLocaleString('en-US') + '. Good luck.' });
      return { ok: true };
    });
  }

  endChallenge() {
    return this.exclusive(async () => {
      if (!this.state.challenge) return { ok: true };
      const back = this.state.stash || freshState(DEFAULT_CASH, this.state.profile);
      back.profile = this.state.profile;
      this.state = back;
      this.saveNow();
      this.emit('event', { type: 'challenge', message: 'Back to your regular paper account.' });
      return { ok: true };
    });
  }

  // Follow trades you closed by hand to where their plan would have closed them (stop, target,
  // strategy exit, end of day), for "early exits vs the plan". Capped at 30 days.
  async ghostCheck() {
    const gs = this.state.ghosts;
    if (!gs || !gs.length) return;
    const now = nowSec();
    if (this._ghostAt && now - this._ghostAt < 20) return;
    this._ghostAt = now;
    for (const g of gs.slice()) {
      let data;
      try { data = await this.refreshPrice(g.symbol); } catch (e) { continue; }
      if (!data || data.price == null) continue;
      let exit = levelExit(g, data, g.since, now);
      if (!exit && g.managed) {
        try {
          const d = await this.manageDecision(g, data.price);
          if (d && d.close) exit = { price: data.price, reason: d.close };
          else if (d && d.trail != null) g.stop = d.trail;
        } catch (e) { /* data hiccup */ }
      }
      if (!exit && now - g.since > 30 * 86400) exit = { price: data.price, reason: 'still open after 30 days' };
      if (!exit) continue;
      const inst = getInstrument(g.symbol);
      const px = roundPrice(inst, exit.price - g.dir * slippage(inst, exit.price));
      const gross = (px - g.entry) * g.dir * g.qty * inst.multiplier * quoteToUsd(inst, px);
      const pnl = gross - feeUsd(inst, px, g.qty) - (g.feesPaid || 0);
      const rec = this.state.history.find((h) => h.id === g.id);
      if (rec) rec.plan = { pnl, reason: exit.reason, exit: px, closedAt: now };
      gs.splice(gs.indexOf(g), 1);
      this.save();
    }
  }

  // The guard rails' daily stop: at 70% of the profile's daily loss limit, close everything and
  // pause until tomorrow (the limit itself only blocks new trades).
  async guardCheck() {
    if (this.state.beast || !this.guardOn() || this.state.day.guardStopped) return;
    const stopUsd = this.guardStopUsd();
    if (this.dayPnl() > -stopUsd) return;
    this.state.day.guardStopped = true;
    const had = this.state.positions.length + this.state.orders.length;
    await this.closeAllFor('daily stop');
    this.save();
    this.emit('event', { type: 'guard', sound: 'loss', message: 'Your daily stop hit ($' + Math.round(stopUsd).toLocaleString('en-US') + ' down today, 70% of your daily loss limit). ' + (had ? 'Open trades were closed and orders cancelled; new' : 'New') + ' trades unlock tomorrow.' });
  }

  async closeAllFor(reason) {
    for (const p of this.state.positions.slice()) {
      try { await this._close(p.id, reason); } catch (e) { /* no price right now: retried next tick */ }
    }
    this.state.orders = [];
  }

  // Called every tick (inside the exclusive queue): applies the firm's rules.
  async challengeCheck() {
    const ch = this.state.challenge;
    if (!ch || ch.status !== 'active') return;
    const preset = PROP.getPreset(ch.presetId);
    const now = nowSec();
    if (PROP.dayKey(now) !== ch.dayKey) {
      PROP.rollDay(ch, preset, now, this.state.balance);
      this.save();
    }
    if (preset.maxCalendarDays && now - ch.startedAt > preset.maxCalendarDays * 86400) {
      return this.failChallenge(ch, preset, 'time limit');
    }
    const eq = this.equity();
    const r = PROP.checkEquity(ch, preset, eq, eq);
    if (r && r.startsWith('fail')) return this.failChallenge(ch, preset, r.slice(5));
    if ((r === 'pause' || r === 'selfstop') && !ch.paused) {
      ch.paused = true;
      await this.closeAllFor(r === 'selfstop' ? 'daily stop' : 'challenge rule');
      this.save();
      this.emit('event', {
        type: 'challenge', sound: 'loss',
        message: r === 'selfstop'
          ? 'Your daily stop hit ($' + Math.round(preset.dailyLoss.amount * ch.selfStop).toLocaleString('en-US') + ', ' + Math.round(ch.selfStop * 100) + '% of the firm\'s limit). Positions closed; trading resumes at the next session.'
          : 'Daily loss limit hit ($' + preset.dailyLoss.amount.toLocaleString('en-US') + '). Positions closed; trading resumes at the next session.',
      });
      return;
    }
    if (preset.flatByEt != null && afterFlatTime(preset) && this.state.positions.length) {
      await this.closeAllFor('challenge rule');
      this.emit('event', { type: 'challenge', message: 'Flat by ' + preset.flatBy + ': open positions were closed, as the firm requires.' });
    }
    if (!this.state.positions.length) {
      const view = Object.assign({}, ch, { dayPnls: ch.dayPnls.concat(ch.tradedToday ? [ch.dayPnl] : []), tradingDays: ch.tradingDays + (ch.tradedToday ? 1 : 0) });
      if (PROP.phasePassed(view, preset, this.state.balance)) {
        if (ch.phase + 1 < preset.phases.length) {
          ch.phase++;
          const B = preset.startBalance;
          Object.assign(ch, { hwm: B, floor: B - preset.maxLoss.amount, dayStartBalance: B, dayPnl: 0, dayPnls: [], tradingDays: 0, tradedToday: false, phaseStartedAt: now });
          this.state.balance = B; this.state.orders = [];
          this.state.equityCurve.push({ time: now, value: B });
          this.save();
          this.emit('event', { type: 'challenge', sound: 'win', confetti: true, message: 'Phase ' + ch.phase + ' passed! Phase ' + (ch.phase + 1) + ' starts now with a fresh $' + B.toLocaleString('en-US') + ' and a +$' + preset.phases[ch.phase].target.toLocaleString('en-US') + ' target.' });
        } else {
          ch.status = 'passed'; ch.endedAt = now;
          this.save();
          this.emit('event', { type: 'challenge', sound: 'win', confetti: true, message: 'Challenge passed! You hit the ' + preset.label + ' target without breaking a rule.' });
        }
      }
    }
  }

  async failChallenge(ch, preset, reason) {
    ch.status = 'failed'; ch.reason = reason; ch.endedAt = nowSec();
    await this.closeAllFor('challenge rule');
    this.save();
    const why = { 'max loss': 'the account fell to the max-loss level', 'daily loss': 'the daily loss limit was hit', 'time limit': 'time ran out' }[reason] || reason;
    this.emit('event', { type: 'challenge', sound: 'loss', message: 'Challenge failed: ' + why + '. That is the outcome most real attempts end in; review the History tab and try again.' });
  }

  challengeView() {
    const ch = this.state.challenge;
    if (!ch) return null;
    const preset = PROP.getPreset(ch.presetId);
    const eq = this.equity();
    const days = ch.dayPnls.concat(ch.tradedToday ? [ch.dayPnl] : []);
    const view = Object.assign({}, ch, { dayPnls: days, tradingDays: ch.tradingDays + (ch.tradedToday ? 1 : 0) });
    const target = PROP.phaseTarget(view, preset);
    const profit = this.state.balance - ch.startBalance;
    const best = days.length ? Math.max(0, ...days) : 0;
    return {
      presetId: preset.id, label: preset.label, group: preset.group, notes: preset.notes, source: preset.source, fee: preset.fee.text,
      status: ch.status, reason: ch.reason, paused: !!ch.paused, phase: ch.phase + 1, phases: preset.phases.length, attempt: ch.attempt || 1,
      startBalance: ch.startBalance, balance: this.state.balance, equity: eq, profit, openProfit: eq - ch.startBalance,
      target, baseTarget: preset.phases[ch.phase].target,
      dailyLimit: preset.dailyLoss ? preset.dailyLoss.amount : null, dailyMode: preset.dailyLoss ? preset.dailyLoss.onBreach : null,
      selfStop: ch.selfStop && preset.dailyLoss ? preset.dailyLoss.amount * ch.selfStop : null,
      dayStartBalance: ch.dayStartBalance, dayLoss: Math.max(0, ch.dayStartBalance - eq),
      floor: ch.floor, maxLoss: preset.maxLoss.amount, maxLossType: preset.maxLoss.type, roomToFloor: eq - ch.floor,
      tradingDays: view.tradingDays, minDays: preset.phases[ch.phase].minDays || 0,
      consistency: preset.consistency ? { share: preset.consistency.maxDayShare, mode: preset.consistency.mode, bestDay: best, ok: !(preset.consistency.mode === 'block_pass') || best <= preset.consistency.maxDayShare * Math.max(0, profit) } : null,
      daysLeft: preset.maxCalendarDays ? Math.max(0, preset.maxCalendarDays - (nowSec() - ch.startedAt) / 86400) : null,
      flatBy: preset.flatBy, startedAt: ch.startedAt, endedAt: ch.endedAt,
    };
  }

  async checkSymbol(sym, data) {
    const now = nowSec();
    const last = data.price;
    // pending orders
    for (const o of this.state.orders.slice()) {
      if (o.symbol !== sym) continue;
      const bars = data.bars.filter((b) => b.time + 60 > o.createdAt);
      let fillAt = null;
      for (const b of bars) {
        const afterPlace = b.time >= o.createdAt; // whole bar after the order was placed
        const hi = afterPlace ? b.high : last;
        const lo = afterPlace ? b.low : last;
        const open = afterPlace ? b.open : last;
        if (o.type === 'limit') {
          if (o.dir > 0 && lo <= o.price) fillAt = Math.min(o.price, open);
          if (o.dir < 0 && hi >= o.price) fillAt = Math.max(o.price, open);
        } else {
          if (o.dir > 0 && hi >= o.price) fillAt = Math.max(o.price, open);
          if (o.dir < 0 && lo <= o.price) fillAt = Math.min(o.price, open);
        }
        if (fillAt != null) break;
      }
      if (fillAt == null) {
        // delayed feeds may have no bars after the order yet: fall back to the last price
        if (o.type === 'limit' && (o.dir > 0 ? last <= o.price : last >= o.price)) fillAt = last;
        if (o.type === 'stop' && (o.dir > 0 ? last >= o.price : last <= o.price)) fillAt = last;
      }
      if (fillAt == null) continue;
      this.state.orders.splice(this.state.orders.indexOf(o), 1);
      const base = {
        symbol: o.symbol, dir: o.dir, qty: o.qty, stop: o.stop, target: o.target, source: o.source,
        strategy: o.strategy, tf: o.tf, note: o.note, grade: o.grade, closeAt: o.closeAt, managed: o.managed,
        verdict: o.verdict, concerns: o.concerns, stop0: o.stop0, beast: o.beast,
      };
      this.openPosition(base, fillAt, o.type);
    }
    // open positions
    for (const p of this.state.positions.slice()) {
      if (p.symbol !== sym) continue;
      p.lastPrice = last;
      const u = this.unrealized(p, last);
      p.mfe = Math.max(p.mfe || 0, u);
      p.mae = Math.min(p.mae || 0, u);
      if (p.beast) p.beastPeak = Math.max(p.beastPeak || 0, u - (p.feesPaid || 0));
      const exit = levelExit(p, data, p.openedAt, now);
      if (exit) await this._close(p.id, exit.reason, exit.price);
    }
  }

  // Strategy-managed exits: trailing stops and exit rules evaluated on the
  // position's own chart timeframe, once per closed bar.
  // Strategy exit or trailing-stop move for a position (or a ghost), on its own chart timeframe.
  async manageDecision(p, lastPrice) {
    const strat = getStrategy(p.managed.strategy);
    if (!strat) return null;
    const now = nowSec();
    const r = await getCandles(p.symbol, p.managed.tf, { limit: 600 });
    let bars = r.bars;
    if (bars.length && !isBarClosed(bars[bars.length - 1], p.managed.tf, now)) bars = bars.slice(0, -1);
    if (bars.length < 60) return null;
    const inst = getInstrument(p.symbol);
    const c = buildContext(bars, inst, p.managed.tf);
    return stratDecision(strat, c, bars.length - 1, p, lastPrice);
  }

  // "Time to sell?" check for an open trade, once per closed bar of its own chart. Records what
  // it finds on the position (shown in the Positions panel) and raises a sell alert when the
  // setting allows: always for the trade's own strategy exit, and for shaky signs only when
  // the user chose 'all'. Managed trades close themselves, so they only get the shaky notes.
  async sellCheck(p) {
    if (p.beast) return; // a Beast Mode trade can't lose, so there is nothing to warn about
    const mode = this.sellMode();
    const tf = (p.managed && p.managed.tf) || p.tf;
    const sid = (p.managed && p.managed.strategy) || p.strategy;
    if (!tf) return;
    const now = nowSec();
    if (p.sellAt && now - p.sellAt < 20) return;
    p.sellAt = now;
    const r = await getCandles(p.symbol, tf, { limit: 600 });
    let bars = r.bars || [];
    if (bars.length && !isBarClosed(bars[bars.length - 1], tf, now)) bars = bars.slice(0, -1);
    if (bars.length < 60) return;
    const i = bars.length - 1;
    if (p.sellBar === bars[i].time) return; // already looked at this bar
    p.sellBar = bars[i].time;
    const inst = getInstrument(p.symbol);
    const c = buildContext(bars, inst, tf);
    // the bar the trade was entered in, and the full bars since
    let k = i; while (k > 0 && bars[k].time > p.openedAt) k--;
    if (bars[k].time > p.openedAt) return; // entered before the loaded history
    const st = sellState(p, bars, k, i);
    const signs = st && i > k ? EXITS.shaky(c, i, st) : [];
    p.sellSigns = signs.map((h) => ({ id: h.id, name: h.name, text: h.text }));
    p.openR = st ? +EXITS.openR(st, bars[i].close).toFixed(2) : null;
    let due = null;
    const strat = sid && !p.managed ? getStrategy(sid) : null;
    if (strat && i > k) {
      const d = stratDecision(strat, c, i, p, p.lastPrice || bars[i].close);
      if (d && d.close) due = { reason: d.close, text: 'Its ' + (strat.name || sid) + ' strategy says sell: ' + EXIT_WORDS[d.close] + '.' };
    }
    p.sellDue = due;
    this.save();
    if (mode === 'off' || p.managed) return;
    const sent = p.sellSent || (p.sellSent = []);
    let alert = null;
    if (due && !sent.includes(due.reason)) { sent.push(due.reason); alert = { tested: true, title: 'Time to sell ' + p.symbol + '?', message: due.text, reasons: [{ name: 'Strategy exit', text: due.text }] }; }
    else if (mode === 'all' && signs.length) {
      const fresh = signs.filter((h) => !sent.includes(h.id));
      if (fresh.length) {
        for (const h of fresh) sent.push(h.id);
        alert = { tested: false, title: p.symbol + ' looks shaky', message: fresh[0].text, reasons: signs.map((h) => ({ name: h.name, text: h.text })) };
      }
    }
    if (!alert) return;
    const upnl = this.unrealized(p) - (p.feesPaid || 0);
    this.emit('event', Object.assign({ type: 'sell-alert', id: p.id, symbol: p.symbol, side: p.side, dir: p.dir, qty: p.qty, upnl, upnlR: p.riskUsd ? upnl / p.riskUsd : null }, alert));
  }

  async manage(p) {
    const now = nowSec();
    if (p.managedAt && now - p.managedAt < 10) return;
    p.managedAt = now;
    const d = await this.manageDecision(p, p.lastPrice);
    if (!d) return;
    if (d.close) { await this._close(p.id, d.close); return; }
    if (d.trail != null) {
      const old = p.stop;
      p.stop = d.trail;
      this.save();
      this.emit('event', { type: 'trail', symbol: p.symbol, quiet: true, message: 'Trailing stop on ' + p.symbol + ' moved ' + (old != null ? 'from ' + old + ' ' : '') + 'to ' + d.trail + '.', position: p });
    }
  }

  // ----- snapshot for the UI -----
  snapshot() {
    this.rollDay();
    const profile = getProfile(this.state.profile);
    const positions = this.state.positions.map((p) => {
      const inst = getInstrument(p.symbol);
      // shown net of the entry fee already paid, so the number matches what closing would book (before exit costs)
      const upnl = this.unrealized(p) - (p.feesPaid || 0);
      return Object.assign({}, p, {
        name: inst.name, decimals: inst.decimals, unit: inst.unit,
        upnl, upnlR: p.riskUsd ? upnl / p.riskUsd : null,
        notional: notionalUsd(inst, p.lastPrice || p.entry, p.qty),
        // where the progress bar sits: the price that matches the P&L shown
        markPx: p.beast ? p.entry + p.dir * (upnl + (p.feesPaid || 0)) / (p.qty * inst.multiplier * quoteToUsd(inst, p.entry)) : undefined,
      });
    });
    const eq = this.equity();
    const used = this.usedNotional();
    return {
      startingCash: this.state.startingCash,
      balance: this.state.balance,
      equity: eq,
      totalPnl: eq - this.state.startingCash,
      totalPnlPct: (eq / this.state.startingCash - 1) * 100,
      dayPnl: eq - this.state.day.startEquity,
      dayPnlPct: (eq / this.state.day.startEquity - 1) * 100,
      usedNotional: used,
      leverage: eq > 0 ? used / eq : 0,
      exposure: ['stocks', 'crypto', 'forex', 'futures'].map((m) => ({
        market: m, used: this.usedNotional(m), limit: eq * (profile.leverage[m] || 1),
        risk: this.clusterRisk(m), riskLimit: eq * profile.clusterRiskPct / 100,
      })),
      openRiskUsd: positions.reduce((a, p) => a + (p.stop != null ? Math.max(0, (p.lastPrice - p.stop) * p.dir) * p.qty * getInstrument(p.symbol).multiplier * quoteToUsd(getInstrument(p.symbol), p.lastPrice) : 0), 0),
      profile: profile.id,
      locked: this.lockedReason(),
      guard: this.guardView(),
      sellAlerts: this.sellMode(),
      challenge: this.challengeView(),
      positions,
      orders: this.state.orders,
      history: this.state.history.slice(0, 200),
      equityCurve: this.state.equityCurve.slice(-1000).concat([{ time: nowSec(), value: eq }]),
      // Beast Mode trades count in the stats like any trade (nothing on screen sets them apart), but
      // they teach nothing about mistakes, so that panel skips them.
      stats: tradeStats(this.state.history),
      mistakes: mistakesOf(this.state.history.filter((h) => !h.beast), this.state.ghosts),
      beast: !!this.state.beast,
    };
  }
}

// A strategy's own exit on closed bar i for an open trade: its exit rule, a trailing-stop move
// (or a close past the new trailing stop), or its time limit. Shared by managed trades, ghosts
// and sell alerts.
function stratDecision(strat, c, i, p, lastPrice) {
  const bars = c.bars;
  const last = lastPrice || bars[i].close;
  if (strat.exit && bars[i].time >= p.openedAt && strat.exit(c, i, p.dir)) return { close: 'exit rule' };
  if (strat.trail) {
    const t = roundPrice(c.inst, strat.trail(c, i, p.dir));
    if (isFinite(t) && (p.stop == null || (t - p.stop) * p.dir > 0)) {
      if ((last - t) * p.dir <= 0) return { close: 'trailing stop' };
      return { trail: t };
    }
  }
  if (strat.maxHold && bars.filter((b) => b.time >= p.openedAt).length >= strat.maxHold) return { close: 'time limit' };
  return null;
}

// The open trade as core/exits.js sees it: entry, first-stop distance, extremes since entry and
// bars held, from the entry bar k to bar i. Null without a stop (no R to measure in).
function sellState(p, bars, k, i) {
  const stop0 = p.stop0 != null ? p.stop0 : p.stop;
  if (stop0 == null) return null;
  const risk = Math.abs(p.entry - stop0);
  if (!(risk > 0)) return null;
  let hi = p.entry; let lo = p.entry;
  for (let j = k + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
  return { dir: p.dir, entry: p.entry, risk, hi, lo, bars: i - k + 1 };
}

// Beast Mode: the exit price that makes this trade a winner after all costs. The real exit is kept
// when it already wins by more than the forced one.
function netAt(pos, inst, x) {
  return (x - pos.entry) * pos.dir * pos.qty * inst.multiplier * quoteToUsd(inst, x) - feeUsd(inst, x, pos.qty) - (pos.feesPaid || 0);
}
// The exit price that books `net` dollars after all costs (rounded so it never books less).
function priceForNet(pos, inst, net) {
  let x = pos.entry;
  for (let k = 0; k < 4; k++) x = pos.entry + pos.dir * (net + feeUsd(inst, x, pos.qty) + (pos.feesPaid || 0)) / (pos.qty * inst.multiplier * quoteToUsd(inst, x));
  let r = roundPrice(inst, x);
  const tick = Math.pow(10, -inst.decimals);
  for (let k = 0; k < 6 && netAt(pos, inst, r) < net - 0.005; k++) r = roundPrice(inst, r + pos.dir * tick);
  return r;
}
// What a Beast Mode trade is guaranteed to close with: its target, or +1R, after costs.
function beastWinNet(pos, inst) {
  return netAt(pos, inst, beastExit(pos, inst, pos.entry).exit);
}
// Beast Mode's live P&L: it opens a little green and only ever climbs (at an uneven, live-looking
// pace) toward the guaranteed win. If the real price ever showed more, that peak holds instead.
function beastShownNet(pos, now) {
  const inst = getInstrument(pos.symbol);
  const win = Math.max(0.01, beastWinNet(pos, inst));
  const t = Math.max(0, (now != null ? now : Date.now() / 1000) - (pos.openedAt || 0));
  const k = (Number(pos.id) || 0) % 7;
  // warped clock: always moving forward (its rate stays above 0), just not at a steady speed
  const tau = t + 4 * (Math.sin(t / 5 + k) - Math.sin(k)) + 2 * (Math.sin(t / 13 + 2 * k) - Math.sin(2 * k));
  const f = 0.03 + 0.8 * (1 - Math.exp(-tau / 900)) + 0.15 * (1 - Math.exp(-tau / 14400));
  return Math.max(win * f, pos.beastPeak || 0);
}
function beastExit(pos, inst, realExit) {
  const dir = pos.dir;
  const stop0 = pos.stop0 != null ? pos.stop0 : pos.stop;
  const oneR = stop0 != null && Math.abs(pos.entry - stop0) > 0 ? Math.abs(pos.entry - stop0) : pos.entry * 0.01;
  let want = pos.target != null && (pos.target - pos.entry) * dir > 0 ? pos.target : pos.entry + dir * oneR;
  const pnlAt = (x) => netAt(pos, inst, x);
  // make sure the costs can't turn it into a loss
  for (let k = 0; k < 8 && pnlAt(roundPrice(inst, want)) <= 0; k++) want += dir * oneR;
  want = roundPrice(inst, want);
  if ((realExit - want) * dir >= 0 && pnlAt(realExit) > 0) return { exit: realExit, forced: false };
  return { exit: want, forced: true };
}

// Stop, target or end-of-day exit for a position (or a ghost) from bars since `since`.
function levelExit(p, data, since, now) {
  const last = data.price;
  const bars = data.bars.filter((b) => b.time >= Math.floor(since / 60) * 60);
  for (const b of bars) {
    const full = b.time >= since; // bar began after entry: its whole range counts
    const hi = full ? b.high : last;
    const lo = full ? b.low : last;
    const open = full ? b.open : last;
    if (p.stop != null) {
      if (p.dir > 0 && lo <= p.stop) return { price: Math.min(p.stop, open), reason: 'stop' };
      if (p.dir < 0 && hi >= p.stop) return { price: Math.max(p.stop, open), reason: 'stop' };
    }
    if (p.target != null) {
      if (p.dir > 0 && hi >= p.target) return { price: Math.max(p.target, open), reason: 'target' };
      if (p.dir < 0 && lo <= p.target) return { price: Math.min(p.target, open), reason: 'target' };
    }
  }
  if (p.stop != null && (p.dir > 0 ? last <= p.stop : last >= p.stop)) return { price: last, reason: 'stop' };
  if (p.target != null && (p.dir > 0 ? last >= p.target : last <= p.target)) return { price: last, reason: 'target' };
  if (p.closeAt && now >= p.closeAt) return { price: last, reason: 'close of day' };
  return null;
}

// "Your mistakes, in dollars": what trades against the app's advice, loosened stops and early
// exits cost (or made), next to trades that followed the plan. Everything is after costs.
function mistakesOf(history, ghosts) {
  const sum = (list, f) => list.reduce((a, h) => a + (f ? f(h) : h.pnl), 0);
  const pack = (list, extra) => Object.assign({ trades: list.length, pnl: sum(list), wins: list.filter((h) => h.pnl > 0).length,
    avgR: list.filter((h) => h.R != null).length ? sum(list.filter((h) => h.R != null), (h) => h.R) / list.filter((h) => h.R != null).length : null }, extra || {});
  const skip = history.filter((h) => h.source === 'suggested' && h.verdict === 'skip');
  const broke = history.filter((h) => h.source !== 'suggested' && h.concerns && h.concerns.some((c) => c.tone === 'bad'));
  const against = history.filter((h) => h.source !== 'suggested' && h.concerns && h.concerns.length && !h.concerns.some((c) => c.tone === 'bad'));
  const loose = history.filter((h) => h.stopLoosened);
  // the loss beyond what the original stop risked
  const extra = sum(loose, (h) => (h.riskUsd && h.pnl < -h.riskUsd ? -h.pnl - h.riskUsd : 0));
  const early = history.filter((h) => h.reason === 'manual' && h.plan);
  const tracking = (ghosts || []).length;
  const followed = history.filter((h) => h.source === 'suggested' && (h.verdict === 'take' || h.verdict === 'caution') && !h.stopLoosened && h.reason !== 'manual');
  return {
    skip: pack(skip),
    broke: pack(broke),
    against: pack(against),
    loosened: pack(loose, { extraLoss: extra }),
    early: pack(early, { planPnl: sum(early, (h) => h.plan.pnl), diff: sum(early) - sum(early, (h) => h.plan.pnl), tracking }),
    followed: pack(followed),
  };
}

function tradeStats(history) {
  const groups = { all: history, suggested: history.filter((h) => h.source === 'suggested'), manual: history.filter((h) => h.source !== 'suggested') };
  const out = {};
  for (const [k, list] of Object.entries(groups)) {
    const wins = list.filter((h) => h.pnl > 0);
    const losses = list.filter((h) => h.pnl <= 0);
    const gw = wins.reduce((a, h) => a + h.pnl, 0);
    const gl = losses.reduce((a, h) => a + h.pnl, 0);
    const rs = list.filter((h) => h.R != null);
    out[k] = {
      trades: list.length,
      winRate: list.length ? wins.length / list.length * 100 : 0,
      netPnl: gw + gl,
      profitFactor: gl < 0 ? gw / -gl : (gw > 0 ? null : 0),
      avgR: rs.length ? rs.reduce((a, h) => a + h.R, 0) / rs.length : null,
      best: list.reduce((m, h) => Math.max(m, h.pnl), 0),
      worst: list.reduce((m, h) => Math.min(m, h.pnl), 0),
    };
  }
  return out;
}

module.exports = { isBeastCode, beastExit, beastShownNet, stratDecision, sellState, PaperAccount, tradeStats, mistakesOf, usCloseUtc, DEFAULT_CASH };

}, {"fs":"web/shims/fs.js","path":"web/shims/path.js","events":"web/shims/events.js","./markets":"core/markets.js","./costs":"core/costs.js","./risk":"core/risk.js","./data":"core/data.js","./strategies":"core/strategies.js","./time":"core/time.js","./prop":"core/prop.js","./exits":"core/exits.js"}],
"web/shims/fs.js": [function (module, exports, require) {
'use strict';
// The phone build keeps the account in localStorage (see engine-entry.js), so no file access is needed.
module.exports = {};

}, {}],
"web/shims/path.js": [function (module, exports, require) {
'use strict';
module.exports = { dirname: (p) => String(p).replace(/\/[^/]*$/, ''), join: (...a) => a.join('/') };

}, {}],
"web/shims/events.js": [function (module, exports, require) {
'use strict';
// Minimal EventEmitter for the browser build of the engine.
class EventEmitter {
  constructor() { this._ev = {}; }
  on(name, fn) { (this._ev[name] = this._ev[name] || []).push(fn); return this; }
  addListener(name, fn) { return this.on(name, fn); }
  once(name, fn) { const w = (...a) => { this.off(name, w); fn.apply(this, a); }; return this.on(name, w); }
  off(name, fn) { const l = this._ev[name]; if (l) this._ev[name] = l.filter((f) => f !== fn); return this; }
  removeListener(name, fn) { return this.off(name, fn); }
  emit(name, ...args) {
    const l = (this._ev[name] || []).slice();
    for (const fn of l) { try { fn.apply(this, args); } catch (e) { setTimeout(() => { throw e; }); } }
    return l.length > 0;
  }
  listenerCount(name) { return (this._ev[name] || []).length; }
}
module.exports = { EventEmitter };

}, {}],
"core/markets.js": [function (module, exports, require) {
'use strict';
// Instrument catalog. Every market here uses free, no-key public data.
//
// Cost model (per side): fill price moves against you by slipBps of price plus
// slipTicks * tick, and you pay feeBps of notional plus feePerUnit per unit.
// Defaults follow RESEARCH.md: index ETFs 1 bp, single stocks 2 bp, FX 0.3-0.6 bp
// (about 0.7-1.2 pips round trip, typical all-in ECN/prop costs), crypto 0.60% retail
// exchange fee + 2 bp, micro futures 1 tick + the 2026 Topstep fee per contract.

const MARKETS = [
  { id: 'stocks', name: 'Stocks & ETFs', blurb: 'US-listed, live in regular hours (8:30 AM to 3:00 PM Central)' },
  { id: 'crypto', name: 'Crypto', blurb: 'Coinbase spot prices, live 24/7' },
  { id: 'forex', name: 'Forex', blurb: 'Major currency pairs, live 24/5' },
  { id: 'futures', name: 'Futures', blurb: 'CME micro contracts, prices delayed about 10 minutes' },
];

function stock(symbol, name, extra) {
  return Object.assign({
    symbol, name, market: 'stocks', provider: 'yahoo', providerSymbol: symbol,
    session: 'us_equity', qtyStep: 1, minQty: 1, multiplier: 1, quote: 'USD', tick: 0.01,
    slipBps: 2, slipTicks: 0, feeBps: 0, feePerUnit: 0, decimals: 2, unit: 'shares', delayedSec: 0,
  }, extra || {});
}
function crypto(symbol, name, qtyStep, decimals) {
  return {
    symbol, name, market: 'crypto', provider: 'coinbase', providerSymbol: symbol,
    session: '24_7', qtyStep, minQty: qtyStep, multiplier: 1, quote: 'USD', tick: Math.pow(10, -decimals),
    slipBps: 2, slipTicks: 0, feeBps: 60, feePerUnit: 0, decimals, unit: symbol.split('-')[0], delayedSec: 0,
  };
}
function fx(symbol, name, yahoo, quote, costBps, pip) {
  const decimals = pip === 0.01 ? 3 : 5;
  return {
    symbol, name, market: 'forex', provider: 'yahoo', providerSymbol: yahoo,
    session: 'fx', qtyStep: 1000, minQty: 1000, multiplier: 1, quote, tick: pip / 10,
    slipBps: costBps, slipTicks: 0, feeBps: 0, feePerUnit: 0, decimals, unit: 'units', delayedSec: 0, pip,
  };
}
function future(symbol, name, yahoo, multiplier, tick, decimals, feePerSide) {
  return {
    symbol, name, market: 'futures', provider: 'yahoo', providerSymbol: yahoo,
    session: 'cme', qtyStep: 1, minQty: 1, multiplier, quote: 'USD', tick,
    slipBps: 0, slipTicks: 1, feeBps: 0, feePerUnit: feePerSide || 0.85, decimals, unit: 'contracts', delayedSec: 600,
  };
}

const INSTRUMENTS = [
  stock('SPY', 'S&P 500 ETF', { slipBps: 1 }),
  stock('QQQ', 'Nasdaq-100 ETF', { slipBps: 1 }),
  stock('IWM', 'Russell 2000 ETF', { slipBps: 1.5 }),
  stock('GLD', 'Gold ETF'),
  stock('TLT', '20+ Year Treasury Bond ETF'),
  stock('NVDA', 'NVIDIA'),
  stock('TSLA', 'Tesla'),
  stock('AAPL', 'Apple'),
  stock('MSFT', 'Microsoft'),
  stock('AMZN', 'Amazon'),
  stock('META', 'Meta Platforms'),
  stock('AMD', 'AMD'),

  crypto('BTC-USD', 'Bitcoin', 0.0001, 2),
  crypto('ETH-USD', 'Ethereum', 0.001, 2),
  crypto('SOL-USD', 'Solana', 0.01, 2),
  crypto('XRP-USD', 'XRP', 1, 4),
  crypto('DOGE-USD', 'Dogecoin', 1, 5),

  fx('EURUSD', 'Euro / US Dollar', 'EURUSD=X', 'USD', 0.35, 0.0001),
  fx('USDJPY', 'US Dollar / Japanese Yen', 'JPY=X', 'JPY', 0.3, 0.01),
  fx('GBPUSD', 'British Pound / US Dollar', 'GBPUSD=X', 'USD', 0.45, 0.0001),
  fx('AUDUSD', 'Australian Dollar / US Dollar', 'AUDUSD=X', 'USD', 0.6, 0.0001),
  fx('USDCAD', 'US Dollar / Canadian Dollar', 'CAD=X', 'CAD', 0.6, 0.0001),

  future('MES', 'Micro E-mini S&P 500', 'ES=F', 5, 0.25, 2, 0.61),
  future('MNQ', 'Micro E-mini Nasdaq-100', 'NQ=F', 2, 0.25, 2, 0.61),
  future('MGC', 'Micro Gold', 'GC=F', 10, 0.1, 1, 0.96),
  future('MCL', 'Micro WTI Crude Oil', 'CL=F', 100, 0.01, 2, 0.86),
  future('SIL', 'Micro Silver', 'SI=F', 1000, 0.005, 3),
];

const BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

function getInstrument(symbol) {
  const inst = BY_SYMBOL.get(symbol);
  if (!inst) throw new Error('Unknown symbol: ' + symbol);
  return inst;
}

// Multiply a P&L amount in the instrument's quote currency to get USD.
// For XXX/USD pairs and USD-priced assets this is 1. For USD/XXX pairs the
// quote currency is XXX, and 1 XXX = 1/price USD.
function quoteToUsd(inst, price) {
  if (inst.quote === 'USD') return 1;
  return price > 0 ? 1 / price : 0;
}

// Price slippage applied on one side (always against the trader).
function slippage(inst, price) {
  return price * (inst.slipBps || 0) / 1e4 + (inst.slipTicks || 0) * inst.tick;
}

// USD fee for one side of a trade.
function feeUsd(inst, price, qty) {
  const notional = Math.abs(qty) * price * inst.multiplier * quoteToUsd(inst, price);
  return notional * (inst.feeBps || 0) / 1e4 + Math.abs(qty) * (inst.feePerUnit || 0);
}

function notionalUsd(inst, price, qty) {
  return Math.abs(qty) * price * inst.multiplier * quoteToUsd(inst, price);
}

function roundToStep(qty, step) {
  if (!(qty > 0)) return 0;
  const n = Math.floor(qty / step + 1e-9);
  const out = n * step;
  // trim floating noise
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(out.toFixed(decimals));
}

function roundPrice(inst, price) {
  return Number(price.toFixed(inst.decimals));
}

module.exports = {
  MARKETS, INSTRUMENTS, getInstrument, quoteToUsd, slippage, feeUsd, notionalUsd, roundToStep, roundPrice,
};

}, {}],
"core/costs.js": [function (module, exports, require) {
'use strict';
// Cost checker: what a planned trade costs round trip (spread and slippage plus fees) in dollars,
// basis points of exposure and R, and whether the same exposure is cheaper another way.
//
// Uses the app's own cost model (core/markets.js), the same one the paper fills and backtests use.
// The CFD line uses the round 4 research assumptions (RESEARCH.md section 1.8): about 1 bp a side
// of spread on an index CFD, plus overnight financing of roughly 1 bp a night for index longs
// (T-bill rate + 2.5% a year, less dividends), which came to 3 to 6 bp per daily index trade.

const { getInstrument, slippage, feeUsd, notionalUsd, quoteToUsd, roundToStep } = require('./markets');

// Same market, different wrapper. Prices differ (MES tracks the S&P 500 index, about 10x SPY), so
// the size is matched on dollar exposure, not on units.
const ALT = { SPY: ['MES'], MES: ['SPY'], QQQ: ['MNQ'], MNQ: ['QQQ'], GLD: ['MGC'], MGC: ['GLD'] };
const INDEX = new Set(['SPY', 'QQQ', 'IWM', 'MES', 'MNQ']);
// Average nights held per trade, from the research CFD financing table (section 1.8).
const NIGHTS = { rsi2: 3.4, ibs: 3.4, month_end_rebal: 5, turn_of_month: 4.6 };
const CFD_SPREAD_BP_SIDE = 1;
const CFD_FINANCE_BP_NIGHT = 1;

// Round-trip cost of qty units at price: slippage both ways plus a fee both ways.
function roundTrip(inst, price, qty) {
  const q = Math.abs(qty);
  if (!(q > 0) || !(price > 0)) return { usd: 0, slipUsd: 0, feeUsd: 0, bp: 0, notional: 0 };
  const fx = quoteToUsd(inst, price);
  const slipUsd = 2 * slippage(inst, price) * q * inst.multiplier * fx;
  const fees = 2 * feeUsd(inst, price, q);
  const notional = notionalUsd(inst, price, q);
  const usd = slipUsd + fees;
  return { usd, slipUsd, feeUsd: fees, bp: notional ? usd / notional * 1e4 : 0, notional };
}

const r2 = (x) => Math.round(x * 100) / 100;

// price lookup for the alternatives: (symbol) -> last price or null
async function costOf(o, priceOf) {
  const inst = getInstrument(o.symbol);
  const rt = roundTrip(inst, o.price, o.qty);
  const out = {
    usd: r2(rt.usd), bp: r2(rt.bp), R: o.riskUsd > 0 ? r2(rt.usd / o.riskUsd) : null,
    slipUsd: r2(rt.slipUsd), feeUsd: r2(rt.feeUsd), alts: [], cheaper: null, cfd: null, tip: null,
  };
  // Too big to size (one contract risks more than the profile allows): match the exposure the
  // profile would have taken instead, so the alternative can still be shown.
  let notional = rt.notional || (o.notional || 0);
  const unsized = !(o.qty > 0) && o.riskBudget > 0 && o.stop != null && o.price > 0 && o.stop !== o.price;
  if (unsized) notional = o.riskBudget * o.price / Math.abs(o.price - o.stop) * quoteToUsd(inst, o.price);
  // the same exposure through the other wrapper
  for (const sym of ALT[o.symbol] || []) {
    let p = null;
    try { p = await priceOf(sym); } catch (e) { p = null; }
    if (!(p > 0)) continue;
    const ai = getInstrument(sym);
    const unitNotional = notionalUsd(ai, p, 1);
    const raw = notional / unitNotional;
    const qty = roundToStep(raw, ai.qtyStep);
    const one = roundTrip(ai, p, Math.max(qty, ai.minQty));
    const alt = { symbol: sym, name: ai.name, unit: ai.unit, unitNotional: Math.round(unitNotional), qty, fits: qty >= ai.minQty };
    if (alt.fits) {
      const at = roundTrip(ai, p, qty);
      alt.usd = r2(at.usd); alt.bp = r2(at.bp);
      // how far the rounding moves the size away from the plan
      alt.sizeOffPct = Math.round((qty * unitNotional / notional - 1) * 100);
    } else {
      alt.bp = r2(one.bp);
      alt.note = 'One ' + ai.unit.replace(/s$/, '') + ' is ' + money(unitNotional) + ' of exposure, ' + (notional > 0 ? (unitNotional / notional).toFixed(1) + 'x' : 'more than') + ' this trade.';
    }
    out.alts.push(alt);
    if (alt.fits && Math.abs(alt.sizeOffPct) <= 25 && alt.usd < out.usd * 0.8 && out.usd - alt.usd >= 1) {
      out.cheaper = { symbol: sym, usd: alt.usd, bp: alt.bp, saveUsd: r2(out.usd - alt.usd), qty };
    }
  }
  // index CFDs at prop firms: spread plus overnight financing
  if (INDEX.has(o.symbol) && o.tf === '1d') {
    const nights = NIGHTS[o.strategy] || (o.avgBars ? Math.max(1, Math.round(o.avgBars * 1.4 * 10) / 10) : null);
    if (nights) {
      // shorts receive the T-bill rate minus the markup and pay dividends: about zero at today's rates
      const finBp = o.side === 'sell' ? 0 : CFD_FINANCE_BP_NIGHT * nights;
      const bp = 2 * CFD_SPREAD_BP_SIDE + finBp;
      out.cfd = { bp: r2(bp), spreadBp: 2 * CFD_SPREAD_BP_SIDE, financeBp: r2(finBp), nights, usd: r2(notional * bp / 1e4), short: o.side === 'sell' };
    }
  }
  const fit = out.alts.find((a) => a.fits);
  if (unsized && fit) {
    const oneRisk = Math.abs(o.price - o.stop) * inst.multiplier * quoteToUsd(inst, o.price) * inst.minQty;
    out.tip = 'One ' + o.symbol + ' ' + inst.unit.replace(/s$/, '') + ' risks ' + money(oneRisk) + ', more than this profile allows (' + money(o.riskBudget) + '). The same trade on ' + fit.symbol + ' fits: about ' + fit.qty + ' ' + fit.unit + '.';
    out.instead = { symbol: fit.symbol, qty: fit.qty };
    return out;
  }
  if (inst.market === 'crypto') out.tip = 'Fees here assume 0.60% a side, a typical retail taker fee. Limit (maker) orders and higher-volume fee tiers usually cost less: check your exchange\'s fee page.';
  else if (out.cheaper) out.tip = 'The same exposure through ' + out.cheaper.symbol + ' costs about ' + money(out.cheaper.usd) + ' instead of ' + money(out.usd) + '.';
  else if (out.R != null && out.R > 0.15) out.tip = 'Costs take ' + out.R.toFixed(2) + 'R of every trade here. Fewer, larger trades on a higher timeframe keep more of the edge.';
  return out;
}
function money(x) { return '$' + Math.round(x).toLocaleString('en-US'); }

module.exports = { roundTrip, costOf, ALT, NIGHTS };

}, {"./markets":"core/markets.js"}],
"core/risk.js": [function (module, exports, require) {
'use strict';
const { quoteToUsd, roundToStep, notionalUsd, slippage, feeUsd } = require('./markets');

// Risk profiles (values from RESEARCH.md section C). Percentages are of equity.
// leverage = max total notional as a multiple of equity, per market.
const PROFILES = {
  low: {
    id: 'low', name: 'Low', tagline: 'Capital first: tiny risk per trade, only A/B setups',
    riskPct: 0.25, stopAtr: 2.0, rr: 2.0, maxPositions: 2, clusterRiskPct: 0.5,
    dailyLossPct: 1, drawdownPct: 8, minScore: 62,
    leverage: { stocks: 1, crypto: 0.5, forex: 5, futures: 2 },
  },
  medium: {
    id: 'medium', name: 'Medium', tagline: 'Balanced: 0.5% risk per trade, A to C setups',
    riskPct: 0.5, stopAtr: 1.5, rr: 2.0, maxPositions: 4, clusterRiskPct: 1,
    dailyLossPct: 2, drawdownPct: 15, minScore: 48,
    leverage: { stocks: 2, crypto: 1, forex: 10, futures: 5 },
  },
  high: {
    id: 'high', name: 'High', tagline: 'Research-paper aggressive: 1% risk, tight stops, leverage',
    riskPct: 1.0, stopAtr: 1.0, rr: 3.0, maxPositions: 6, clusterRiskPct: 2,
    dailyLossPct: 3, drawdownPct: 25, minScore: 35,
    leverage: { stocks: 4, crypto: 2, forex: 20, futures: 10 },
  },
};

function leverageFor(profile, inst) {
  return (profile.leverage && profile.leverage[inst.market]) || 1;
}

function getProfile(id) {
  return PROFILES[id] || PROFILES.medium;
}

// How many units to trade so a stop-out loses riskPct of equity, capped by the
// profile's leverage limit (counting notional already in use). The loss at the stop counts the
// round trip's slippage and fees as well as the distance to the stop: on 1-hour crypto charts
// the fees alone can be larger than the stop distance, and leaving them out let a stop-out
// lose two to three times the risk budget (audit, round 21).
function sizePosition(opts) {
  const { inst, equity, entry, stop, profile } = opts;
  const riskPct = opts.riskPct != null ? opts.riskPct : profile.riskPct;
  const usedNotional = opts.usedNotional || 0;
  const q2u = quoteToUsd(inst, entry);
  const priceRisk = Math.abs(entry - stop) * inst.multiplier * q2u;
  const costPerUnit = (slippage(inst, entry) + slippage(inst, stop)) * inst.multiplier * q2u + feeUsd(inst, entry, 1) + feeUsd(inst, stop, 1);
  const perUnitRisk = priceRisk > 0 ? priceRisk + costPerUnit : priceRisk;
  const perUnitNotional = entry * inst.multiplier * q2u;
  if (!(perUnitRisk > 0) || !(perUnitNotional > 0) || !(equity > 0)) {
    return { qty: 0, reason: 'Stop must be on the other side of the entry price.' };
  }
  const riskBudget = equity * riskPct / 100;
  const byRisk = riskBudget / perUnitRisk;
  const maxLev = leverageFor(profile, inst);
  const notionalRoom = Math.max(0, equity * maxLev - usedNotional);
  const byLeverage = notionalRoom / perUnitNotional;
  const raw = Math.min(byRisk, byLeverage);
  const qty = roundToStep(raw, inst.qtyStep);
  const capped = byLeverage < byRisk;
  if (qty < inst.minQty && !capped && byRisk >= 0.6 * inst.minQty) {
    // one unit risks a bit more than the budget: allow it, but say so
    const q = inst.minQty;
    return {
      qty: q, riskUsd: q * priceRisk, lossAtStopUsd: q * perUnitRisk, notional: notionalUsd(inst, entry, q), perUnitRisk, capped: false,
      riskPctActual: (q * perUnitRisk) / equity * 100, roundedUp: true,
    };
  }
  if (qty < inst.minQty) {
    return {
      qty: 0, perUnitRisk, capped,
      reason: capped
        ? 'No buying power left for ' + inst.market + ' under the ' + profile.name + ' profile (' + maxLev + 'x equity limit).'
        : 'Risk budget is smaller than one ' + inst.unit.replace(/s$/, '') + '; widen the account or tighten the stop.',
    };
  }
  return {
    qty,
    riskUsd: qty * priceRisk, // the distance to the stop, before costs (what R is measured in)
    lossAtStopUsd: qty * perUnitRisk, // what a stop-out loses after slippage and fees
    notional: notionalUsd(inst, entry, qty),
    perUnitRisk,
    capped,
    riskPctActual: (qty * perUnitRisk) / equity * 100,
  };
}

module.exports = { PROFILES, getProfile, sizePosition, leverageFor };

}, {"./markets":"core/markets.js"}],
"core/data.js": [function (module, exports, require) {
'use strict';
// Market data: Yahoo Finance chart API (stocks, ETFs, forex, CME futures) and
// the Coinbase Exchange public API (crypto). No API keys. Results are cached;
// "tail" refreshes only re-download the newest bars so live polling is cheap.

const { getJSON, BROWSER_UA } = require('./http');

// Yahoo is picky about User-Agents and occasionally rate-limits one host, so
// try query1 with a short UA, then query2 with a full browser UA.
async function yahooGet(pathAndQuery) {
  const attempts = [
    ['https://query1.finance.yahoo.com', 'Mozilla/5.0'],
    ['https://query2.finance.yahoo.com', BROWSER_UA],
  ];
  let lastErr;
  for (const [host, ua] of attempts) {
    try {
      return await getJSON(host + pathAndQuery, { headers: { 'User-Agent': ua } });
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 429 && e.status !== 401 && e.status !== 403) throw e;
    }
  }
  throw lastErr;
}
const { getInstrument } = require('./markets');
const { sessionKey, isSessionOpen, secondsUntilOpen } = require('./time');

const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const TIMEFRAMES = Object.keys(TF_SEC);
const MAX_BARS = 2000;
const FULL_TTL_SEC = 15 * 60;

const cache = new Map(); // key -> { bars, fullAt, tailAt, meta, inflight }

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------- helpers ----------

function mergeBars(oldBars, newBars) {
  if (!oldBars || !oldBars.length) return newBars.slice();
  if (!newBars.length) return oldBars;
  const firstNew = newBars[0].time;
  // keep everything strictly older than the first new bar, then append new
  let cut = oldBars.length;
  while (cut > 0 && oldBars[cut - 1].time >= firstNew) cut--;
  const out = oldBars.slice(0, cut).concat(newBars);
  return out.length > MAX_BARS ? out.slice(out.length - MAX_BARS) : out;
}

// Aggregate bars into larger buckets. keyFn maps a bar to its bucket key; the
// bucket's time is the time of its first bar.
function aggregate(bars, keyFn) {
  const out = [];
  let cur = null;
  let curKey = null;
  for (const b of bars) {
    const k = keyFn(b);
    if (cur && k === curKey) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    } else {
      if (cur) out.push(cur);
      cur = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      curKey = k;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function to4h(bars, session) {
  if (session === 'us_equity') {
    // Stock hourly bars start at 9:30 ET; group four per session (9:30 and 13:30 ET).
    let lastDay = null;
    let idx = 0;
    const keyed = bars.map((b) => {
      const day = sessionKey(session, b.time);
      if (day !== lastDay) { idx = 0; lastDay = day; } else idx++;
      return { b, k: day * 10 + Math.floor(idx / 4) };
    });
    const map = new Map(keyed.map((x) => [x.b, x.k]));
    return aggregate(bars, (b) => map.get(b));
  }
  return aggregate(bars, (b) => Math.floor(b.time / 14400));
}

// ---------- Yahoo ----------

function yahooPath(sym, params) {
  const q = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  return '/v8/finance/chart/' + encodeURIComponent(sym) + '?' + q;
}

function yahooParams(tf, tail) {
  const now = nowSec();
  if (tail) {
    if (tf === '1h' || tf === '4h') return { interval: '60m', range: '5d' };
    if (tf === '1d') return { interval: '1d', range: '5d' };
    return { interval: tf, range: '1d' };
  }
  switch (tf) {
    case '1m': return { interval: '1m', range: '5d' };
    case '5m': return { interval: '5m', period1: now - 45 * 86400, period2: now };
    case '15m': return { interval: '15m', period1: now - 59 * 86400, period2: now };
    case '1h': return { interval: '60m', range: '1y' };
    case '4h': return { interval: '60m', range: '2y' };
    case '1d': return { interval: '1d', range: '10y' };
    default: throw new Error('Bad timeframe ' + tf);
  }
}

function parseYahoo(json, tfSecBase) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) {
    const msg = json && json.chart && json.chart.error && json.chart.error.description;
    throw new Error('Yahoo returned no data' + (msg ? ': ' + msg : ''));
  }
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i];
    const h = q.high && q.high[i];
    const l = q.low && q.low[i];
    const c = q.close && q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    const bar = { time: ts[i], open: o, high: h, low: l, close: c, volume: (q.volume && q.volume[i]) || 0 };
    const prev = bars[bars.length - 1];
    // Yahoo appends the live tick at an unaligned timestamp; fold it into the bar it belongs to.
    if (prev && tfSecBase < 86400 && bar.time - prev.time < tfSecBase) {
      prev.high = Math.max(prev.high, bar.high);
      prev.low = Math.min(prev.low, bar.low);
      prev.close = bar.close;
      prev.volume = Math.max(prev.volume, bar.volume);
      continue;
    }
    if (prev && bar.time === prev.time) {
      bars[bars.length - 1] = bar;
      continue;
    }
    bars.push(bar);
  }
  const m = result.meta || {};
  const meta = {
    price: m.regularMarketPrice,
    priceTime: m.regularMarketTime,
    prevClose: m.previousClose != null ? m.previousClose : m.chartPreviousClose,
    exchange: m.fullExchangeName || m.exchangeName,
  };
  return { bars, meta };
}

async function fetchYahoo(inst, tf, tail) {
  const params = yahooParams(tf, tail);
  const json = await yahooGet(yahooPath(inst.providerSymbol, params));
  const baseSec = tf === '4h' ? 3600 : TF_SEC[tf];
  const { bars, meta } = parseYahoo(json, baseSec);
  const out = tf === '4h' ? to4h(bars, inst.session) : bars;
  return { bars: out, meta };
}

// ---------- Coinbase ----------

function coinbaseGranularity(tf) {
  return { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 3600, '1d': 86400 }[tf];
}

async function fetchCoinbasePage(product, gran, endSec) {
  const start = endSec - gran * 300;
  const url = 'https://api.exchange.coinbase.com/products/' + product + '/candles?granularity=' + gran +
    '&start=' + new Date(start * 1000).toISOString() + '&end=' + new Date(endSec * 1000).toISOString();
  const rows = await getJSON(url);
  if (!Array.isArray(rows)) throw new Error('Coinbase returned unexpected data');
  // row: [time, low, high, open, close, volume]
  return rows.map((r) => ({ time: r[0], low: +r[1], high: +r[2], open: +r[3], close: +r[4], volume: +r[5] }));
}

async function fetchCoinbase(inst, tf, tail) {
  const gran = coinbaseGranularity(tf);
  const wantBase = tail ? 300 : (tf === '4h' ? 2400 : tf === '1d' ? 900 : 1500);
  const pages = Math.ceil(wantBase / 300);
  let end = Math.ceil(nowSec() / gran) * gran + gran;
  const all = new Map();
  for (let p = 0; p < pages; p++) {
    const rows = await fetchCoinbasePage(inst.providerSymbol, gran, end);
    if (!rows.length) break;
    for (const r of rows) all.set(r.time, r);
    end -= gran * 300;
  }
  let bars = Array.from(all.values()).sort((a, b) => a.time - b.time);
  if (tf === '4h') bars = to4h(bars, inst.session);
  const last = bars[bars.length - 1];
  return { bars, meta: { price: last ? last.close : null, priceTime: nowSec(), exchange: 'Coinbase' } };
}

// ---------- public API ----------

function fetchProvider(inst, tf, tail) {
  if (inst.provider === 'coinbase') return fetchCoinbase(inst, tf, tail);
  return fetchYahoo(inst, tf, tail);
}

function liveTtl(inst) {
  return inst.provider === 'coinbase' ? 2 : 4;
}

async function getCandles(symbol, tf, opts) {
  const o = opts || {};
  if (!TF_SEC[tf]) throw new Error('Unknown timeframe ' + tf);
  const inst = getInstrument(symbol);
  const key = symbol + '|' + tf;
  let entry = cache.get(key);
  const now = nowSec();
  if (!entry) { entry = { bars: [], fullAt: 0, tailAt: 0, meta: {}, inflight: null }; cache.set(key, entry); }

  const needFull = !entry.bars.length || now - entry.fullAt > FULL_TTL_SEC;
  const needTail = !needFull && o.live !== false && now - entry.tailAt >= liveTtl(inst);
  if ((needFull || needTail) && !entry.inflight) {
    entry.inflight = (async () => {
      try {
        const res = await fetchProvider(inst, tf, !needFull);
        // An aggregated tail can start mid-bucket; drop that partial first bucket.
        if (!needFull && tf === '4h' && res.bars.length > 1) res.bars.shift();
        entry.bars = needFull ? res.bars.slice(-MAX_BARS) : mergeBars(entry.bars, res.bars);
        entry.meta = Object.assign({}, entry.meta, res.meta);
        entry.tailAt = nowSec();
        if (needFull) entry.fullAt = entry.tailAt;
        entry.error = null;
      } catch (e) {
        entry.error = String(e.message || e);
        if (!entry.bars.length) throw e;
      } finally {
        entry.inflight = null;
      }
    })();
  }
  if (entry.inflight && (needFull || o.wait)) await entry.inflight;

  const bars = entry.bars;
  const limit = o.limit || bars.length;
  return {
    symbol, tf, bars: bars.slice(Math.max(0, bars.length - limit)),
    status: marketStatus(inst, bars, tf),
    meta: entry.meta, error: entry.error || null,
  };
}

// tf (optional): the bars' timeframe. A bar's time is its open, so on 4H and 1D charts the newest
// bar is hours old while the market trades; staleness is measured from the end of that bar instead.
function marketStatus(inst, bars, tf) {
  const now = nowSec();
  const open = isSessionOpen(inst.session, now);
  const last = bars && bars.length ? bars[bars.length - 1] : null;
  const lastTime = last ? last.time : 0;
  let state;
  if (!open) state = 'closed';
  else if (inst.delayedSec) state = 'delayed';
  else state = 'live';
  // An "open" market with no fresh data for a long time is probably a holiday.
  const fresh = tf && TF_SEC[tf] ? Math.min(now, lastTime + TF_SEC[tf]) : lastTime;
  if (state !== 'closed' && last && now - fresh > Math.max(3600, inst.delayedSec + 1800) && inst.session !== '24_7') {
    state = 'closed';
  }
  return {
    state,
    opensInSec: open ? 0 : secondsUntilOpen(inst.session, now),
    delayedSec: inst.delayedSec || 0,
    lastBarTime: lastTime,
  };
}

// Quick quotes for a watchlist: one Yahoo "spark" request for all Yahoo
// symbols, and one small Coinbase candle page per crypto pair.
const quoteCache = new Map(); // key -> { at, value }

async function cached(key, ttlSec, fn) {
  const hit = quoteCache.get(key);
  if (hit && nowSec() - hit.at < ttlSec) return hit.value;
  if (hit && hit.inflight) return hit.inflight;
  const entry = hit || {};
  entry.inflight = fn().then((v) => { quoteCache.set(key, { at: nowSec(), value: v }); return v; })
    .catch((e) => { quoteCache.delete(key); throw e; });
  quoteCache.set(key, entry);
  return entry.inflight;
}

async function yahooSpark(insts) {
  const syms = insts.map((i) => i.providerSymbol);
  const pq = '/v8/finance/spark?symbols=' + syms.map(encodeURIComponent).join(',') + '&range=1d&interval=5m';
  const json = await cached('spark|' + syms.join(','), 5, () => yahooGet(pq));
  return insts.map((inst) => {
    const d = json[inst.providerSymbol];
    if (!d || !d.close) return { symbol: inst.symbol, error: 'no data' };
    const closes = d.close.filter((x) => x != null);
    const last = closes[closes.length - 1];
    const ts = d.timestamp || [];
    const ref = d.chartPreviousClose || d.previousClose;
    return {
      symbol: inst.symbol, price: last, time: ts[ts.length - 1],
      changePct: ref ? (last / ref - 1) * 100 : 0,
      spark: closes.slice(-48),
      status: marketStatus(inst, [{ time: ts[ts.length - 1] || 0 }]).state,
    };
  });
}

async function coinbaseQuote(inst) {
  const rows = await cached('cbq|' + inst.symbol, 3, () => fetchCoinbasePage(inst.providerSymbol, 900, Math.ceil(nowSec() / 900) * 900 + 900));
  const bars = rows.slice().sort((a, b) => a.time - b.time);
  const last = bars[bars.length - 1];
  if (!last) return { symbol: inst.symbol, error: 'no data' };
  const dayAgo = bars.find((b) => b.time >= last.time - 86400) || bars[0];
  return {
    symbol: inst.symbol, price: last.close, time: last.time,
    changePct: (last.close / dayAgo.open - 1) * 100,
    spark: bars.slice(-48).map((b) => b.close),
    status: 'live',
  };
}

async function getQuotes(symbols) {
  const insts = symbols.map((s) => { try { return getInstrument(s); } catch (e) { return null; } }).filter(Boolean);
  const yahoo = insts.filter((i) => i.provider === 'yahoo');
  const cb = insts.filter((i) => i.provider === 'coinbase');
  const out = [];
  if (yahoo.length) {
    try { out.push(...await yahooSpark(yahoo)); } catch (e) { yahoo.forEach((i) => out.push({ symbol: i.symbol, error: String(e.message || e) })); }
  }
  const cbq = await Promise.all(cb.map((i) => coinbaseQuote(i).catch((e) => ({ symbol: i.symbol, error: String(e.message || e) }))));
  out.push(...cbq);
  return out;
}

async function getPrice(symbol) {
  const r = await getCandles(symbol, '1m', { limit: 30 });
  const last = r.bars[r.bars.length - 1];
  return last ? { price: last.close, time: last.time, bars: r.bars, status: r.status } : null;
}

function isBarClosed(bar, tf, now) {
  return (now || nowSec()) >= bar.time + TF_SEC[tf];
}

module.exports = {
  TF_SEC, TIMEFRAMES, getCandles, getQuotes, getPrice, marketStatus, isBarClosed,
  _internal: { mergeBars, aggregate, to4h, parseYahoo, cache },
};

}, {"./http":"core/http.js","./markets":"core/markets.js","./time":"core/time.js"}],
"core/time.js": [function (module, exports, require) {
'use strict';
// US Eastern time helpers without any timezone database (works the same on
// every Windows install). DST: second Sunday of March 2:00 to first Sunday of
// November 2:00 local time.

function nthSundayUtcDay(year, month, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSunday + 7 * (n - 1);
}

function isEasternDst(utcSec) {
  const d = new Date(utcSec * 1000);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 2, nthSundayUtcDay(y, 2, 2), 7) / 1000; // 2:00 EST = 07:00 UTC
  const end = Date.UTC(y, 10, nthSundayUtcDay(y, 10, 1), 6) / 1000; // 2:00 EDT = 06:00 UTC
  return utcSec >= start && utcSec < end;
}

function etOffsetSec(utcSec) {
  return (isEasternDst(utcSec) ? -4 : -5) * 3600;
}

// Returns wall-clock parts in New York time.
function etParts(utcSec) {
  const d = new Date((utcSec + etOffsetSec(utcSec)) * 1000);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function ymd(p) {
  return p.year * 10000 + p.month * 100 + p.day;
}

function utcYmd(utcSec) {
  const d = new Date(utcSec * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// A key that is constant within one trading session.
function sessionKey(session, utcSec) {
  switch (session) {
    case 'us_equity': return ymd(etParts(utcSec));
    case 'cme': return ymd(etParts(utcSec + 6 * 3600)); // session opens 18:00 ET the prior evening
    case 'fx': return ymd(etParts(utcSec + 7 * 3600)); // FX day rolls at 17:00 ET
    default: return utcYmd(utcSec);
  }
}

// Is the market open at this instant (ignoring exchange holidays)?
function isSessionOpen(session, utcSec) {
  if (session === '24_7') return true;
  const p = etParts(utcSec);
  const wd = p.weekday; // 0 = Sunday
  const m = p.minutes;
  if (session === 'us_equity') {
    return wd >= 1 && wd <= 5 && m >= 570 && m < 960; // 9:30 to 16:00 ET
  }
  if (session === 'fx') {
    if (wd === 6) return false;
    if (wd === 0) return m >= 17 * 60;
    if (wd === 5) return m < 17 * 60;
    return true;
  }
  if (session === 'cme') {
    if (wd === 6) return false;
    if (wd === 0) return m >= 18 * 60;
    if (wd === 5) return m < 17 * 60;
    return !(m >= 17 * 60 && m < 18 * 60); // daily maintenance break
  }
  return true;
}

// Seconds until the session next opens (0 if open). Scans forward in 5 minute steps.
function secondsUntilOpen(session, utcSec) {
  if (isSessionOpen(session, utcSec)) return 0;
  const step = 300;
  let t = Math.floor(utcSec / step) * step + step;
  for (let i = 0; i < 12 * 24 * 8; i++, t += step) {
    if (isSessionOpen(session, t)) return t - utcSec;
  }
  return null;
}

module.exports = { isEasternDst, etOffsetSec, etParts, sessionKey, isSessionOpen, secondsUntilOpen };

}, {}],
"core/strategies.js": [function (module, exports, require) {
'use strict';
// Strategy library. Each strategy marks entry signals on CLOSED bars:
// sig[i] = 1 (long) / -1 (short) / 0, acted on at the next bar's open.
// Rules and sources are documented in RESEARCH.md.
//
// Optional hooks:
//   initialStop(c, i, dir, entry, profile) -> stop price
//   trail(c, i, dir)   -> trailing stop level computed from bar i (tightens only)
//   exit(c, i, dir)    -> true to exit at bar i's close
//   noTarget           -> no fixed profit target (exits by trail / rule / close)
//   targetR            -> fixed reward:risk target (otherwise the profile's)

const ind = require('./indicators');
const { sessionKey, etParts } = require('./time');

function buildContext(bars, inst, tf) {
  const close = bars.map((b) => b.close);
  const keys = bars.map((b) => sessionKey(inst.session, b.time));
  const hasVolume = bars.slice(-200).some((b) => b.volume > 0);
  const c = {
    bars, inst, tf, keys, hasVolume, close,
    ema20: ind.ema(close, 20),
    ema50: ind.ema(close, 50),
    sma5: ind.sma(close, 5),
    sma200: ind.sma(close, 200),
    rsi2: ind.rsi(close, 2),
    rsi14: ind.rsi(close, 14),
    atr14: ind.atr(bars, 14),
    atr20: ind.atr(bars, 20),
    don20: ind.donchian(bars, 20),
    don10: ind.donchian(bars, 10),
    vwap: ind.vwap(bars, (b) => sessionKey(inst.session, b.time)),
  };
  return c;
}

function fmt(inst, p) {
  return Number(p).toFixed(inst.decimals);
}

// ---- Noise-area bands for the intraday momentum strategy (US stocks, 5m) ----
// sigma(slot) = mean over the previous 14 sessions of |close(slot)/open - 1|.
function noiseBands(c) {
  if (c._noise) return c._noise;
  const { bars, keys } = c;
  const n = bars.length;
  const upper = new Array(n).fill(NaN);
  const lower = new Array(n).fill(NaN);
  const slotOf = new Array(n).fill(-1);
  const days = []; // { key, open, prevClose, moves: Map(slot -> move) }
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (!cur || keys[i] !== cur.key) {
      const prevClose = i > 0 ? bars[i - 1].close : bars[i].open;
      cur = { key: keys[i], open: bars[i].open, prevClose, moves: new Map(), first: i };
      days.push(cur);
    }
    const endMin = etParts(bars[i].time + 300).minutes; // bar END time (5m bars)
    const slot = endMin - 570;
    slotOf[i] = slot;
    cur.moves.set(slot, Math.abs(bars[i].close / cur.open - 1));
  }
  let di = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || keys[i] !== keys[i - 1]) di++;
    if (di < 14) continue;
    const slot = slotOf[i];
    let sum = 0; let cnt = 0;
    for (let k = di - 14; k < di; k++) {
      const m = days[k].moves.get(slot);
      if (m != null) { sum += m; cnt++; }
    }
    if (cnt < 10) continue;
    const sigma = sum / cnt;
    const d = days[di];
    upper[i] = Math.max(d.open, d.prevClose) * (1 + sigma);
    lower[i] = Math.min(d.open, d.prevClose) * (1 - sigma);
  }
  c._noise = { upper, lower, slotOf };
  return c._noise;
}

function prevSessionClose(c, i) {
  for (let j = i; j > 0; j--) if (c.keys[j] !== c.keys[j - 1]) return c.bars[j - 1].close;
  return NaN;
}

const STRATEGIES = [
  {
    id: 'noise_momentum',
    name: 'Intraday Momentum',
    style: 'Day trading (US index ETFs & stocks)',
    summary: 'Rides moves that break out of the normal intraday "noise" range, checked every half hour, with a VWAP trailing stop.',
    evidence: 'Zarattini, Aziz & Barbon (2024) on SPY, 2007-2024: 19.6%/yr, Sharpe 1.33 after commissions and slippage.',
    caveat: 'Much of the edge came from their volatility sizing and VWAP stop; a plain version had Sharpe 0.61.',
    rules: [
      'Noise band = today\'s open (or prior close) +/- the average move at this time of day over the last 14 sessions.',
      'At each :00 and :30 from 10:00 ET: buy if price is above the upper band, short if below the lower band.',
      'Trailing stop at the band or session VWAP, whichever is tighter. Flat at the close.',
    ],
    tfs: ['5m'],
    maxHold: 80,
    noTarget: true,
    eodStocks: true,
    applies: (inst, tf) => inst.session === 'us_equity' && tf === '5m',
    signals(c) {
      const { upper, lower, slotOf } = noiseBands(c);
      const n = c.bars.length;
      const sig = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        const s = slotOf[i];
        if (s < 30 || s >= 390 || s % 30 !== 0 || !(upper[i] > 0)) continue;
        if (c.bars[i].close > upper[i]) sig[i] = 1;
        else if (c.bars[i].close < lower[i]) sig[i] = -1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) {
      return this.trail(c, i, dir, entry);
    },
    trail(c, i, dir) {
      const { upper, lower } = noiseBands(c);
      const v = c.vwap[i];
      if (dir > 0) return Math.max(isFinite(upper[i]) ? upper[i] : -Infinity, v);
      return Math.min(isFinite(lower[i]) ? lower[i] : Infinity, v);
    },
    why(c, i, dir) {
      const { upper, lower } = noiseBands(c);
      return dir > 0
        ? 'Price broke above today\'s noise band (' + fmt(c.inst, upper[i]) + '), a sign of real buying pressure rather than random chop.'
        : 'Price broke below today\'s noise band (' + fmt(c.inst, lower[i]) + '), a sign of real selling pressure rather than random chop.';
    },
    pending(c, i) {
      const { upper, lower } = noiseBands(c);
      if (!(upper[i] > 0)) return null;
      const px = c.bars[i].close;
      if (px < upper[i] && px > lower[i]) {
        const up = upper[i] - px < px - lower[i];
        return up
          ? { dir: 1, type: 'stop', price: upper[i], why: 'Inside the noise band; a push above ' + fmt(c.inst, upper[i]) + ' at the next half-hour check would trigger a long.' }
          : { dir: -1, type: 'stop', price: lower[i], why: 'Inside the noise band; a drop below ' + fmt(c.inst, lower[i]) + ' at the next half-hour check would trigger a short.' };
      }
      return null;
    },
  },
  {
    id: 'orb',
    name: 'Opening Range Breakout',
    style: 'Day trading (US stocks)',
    summary: 'Trades in the direction of the first 5-minute candle of the day, stop at its other end, target 10R or the close.',
    evidence: 'Zarattini & Aziz (2023) on QQQ, 2016-2023: 33%/yr, Sharpe 1.13 (with 1% risk, 4x cap).',
    caveat: 'The paper assumed zero slippage; an independent replication came out near break-even after costs.',
    rules: [
      'US stocks/ETFs on the 5-minute chart, regular hours.',
      'First 5-minute candle green: buy at the second candle. Red: short. Doji: skip the day.',
      'Stop at the other end of the first candle. Target 10R, otherwise exit at the close.',
    ],
    tfs: ['5m'],
    maxHold: 100,
    targetR: 10,
    eodStocks: true,
    applies: (inst, tf) => inst.session === 'us_equity' && tf === '5m',
    signals(c) {
      const n = c.bars.length;
      const sig = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (c.keys[i] === c.keys[i - 1]) continue;
        const b = c.bars[i];
        if (etParts(b.time).minutes !== 570) continue;
        const body = b.close - b.open;
        if (Math.abs(body) < 0.05 * (b.high - b.low || 1e-9)) continue;
        sig[i] = body > 0 ? 1 : -1;
      }
      return sig;
    },
    initialStop(c, i, dir) {
      return dir > 0 ? c.bars[i].low : c.bars[i].high;
    },
    why(c, i, dir) {
      return 'The opening 5-minute candle was ' + (dir > 0 ? 'green' : 'red') + ' (' + fmt(c.inst, c.bars[i].open) + ' to ' + fmt(c.inst, c.bars[i].close) + '), so ORB trades ' + (dir > 0 ? 'long' : 'short') + ' with the stop at its ' + (dir > 0 ? 'low' : 'high') + '.';
    },
    pending() { return null; },
  },
  {
    id: 'last_half_hour',
    name: 'Last Half-Hour Momentum',
    style: 'Day trading (US index ETFs)',
    summary: 'At 3:30 PM ET, trades in the direction of the morning move (prior close to 10:00) and exits at the close.',
    evidence: 'Gao, Han, Li & Zhou (JFE 2018) on SPY, 1993-2013: Sharpe 1.08, 6.7%/yr.',
    caveat: 'Much of the effect came from the 2008 crisis; small edge, one trade a day.',
    rules: [
      'Index ETFs (SPY, QQQ, IWM) on the 5-minute chart.',
      'Morning signal: return from the prior close to 10:00 ET.',
      'At 3:30 PM ET enter in that direction; exit at the 4:00 PM close. Catastrophe stop 3x ATR.',
    ],
    tfs: ['5m'],
    maxHold: 7,
    noTarget: true,
    eodStocks: true,
    applies: (inst, tf) => ['SPY', 'QQQ', 'IWM'].includes(inst.symbol) && tf === '5m',
    signals(c) {
      const n = c.bars.length;
      const sig = new Int8Array(n);
      let tenAm = NaN; let key = null;
      for (let i = 0; i < n; i++) {
        if (c.keys[i] !== key) { key = c.keys[i]; tenAm = NaN; }
        const endMin = etParts(c.bars[i].time + 300).minutes;
        if (endMin === 600) {
          const pc = prevSessionClose(c, i);
          tenAm = pc > 0 ? c.bars[i].close / pc - 1 : NaN;
        }
        if (endMin === 930 && isFinite(tenAm) && tenAm !== 0) sig[i] = tenAm > 0 ? 1 : -1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) {
      return entry - dir * 3 * c.atr14[i];
    },
    why(c, i, dir) {
      return 'This morning\'s move into 10:00 ET was ' + (dir > 0 ? 'up' : 'down') + ', and the research finds the last half hour tends to follow it.';
    },
    pending() { return null; },
  },
  {
    id: 'turtle',
    name: 'Turtle Breakout 20/10',
    style: 'Trend following',
    summary: 'Classic Turtle rules: enter on a 20-bar breakout, exit on a 10-bar breakout the other way. Lets winners run.',
    evidence: 'Turtle trading rules; trend following has a Sharpe above 1 across 58 futures markets (Moskowitz, Ooi & Pedersen 2012).',
    caveat: 'Usually wins under half its trades; costs matter a lot on short timeframes. On crypto the research supports long-only on 1h+ bars.',
    rules: [
      'Enter when price closes above the prior 20-bar high (below the 20-bar low for shorts; crypto is long-only).',
      'Initial stop 2x ATR(20), the Turtles\' "2N".',
      'Trailing exit at the 10-bar low (10-bar high for shorts). No fixed target.',
    ],
    maxHold: 250,
    noTarget: true,
    applies: () => true,
    signals(c) {
      const n = c.bars.length;
      const sig = new Int8Array(n);
      const longOnly = c.inst.market === 'crypto';
      for (let i = 21; i < n; i++) {
        const b = c.bars[i];
        const p = c.bars[i - 1];
        if (b.close > c.don20.hi[i] && !(p.close > c.don20.hi[i - 1])) sig[i] = 1;
        else if (!longOnly && b.close < c.don20.lo[i] && !(p.close < c.don20.lo[i - 1])) sig[i] = -1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) {
      return entry - dir * 2 * c.atr20[i];
    },
    trail(c, i, dir) {
      // 10-bar extreme including bar i
      let lo = Infinity; let hi = -Infinity;
      for (let j = Math.max(0, i - 9); j <= i; j++) { lo = Math.min(lo, c.bars[j].low); hi = Math.max(hi, c.bars[j].high); }
      return dir > 0 ? lo : hi;
    },
    why(c, i, dir) {
      return (dir > 0 ? 'Closed above the 20-bar high of ' + fmt(c.inst, c.don20.hi[i]) : 'Closed below the 20-bar low of ' + fmt(c.inst, c.don20.lo[i])) + ', a fresh Turtle breakout.';
    },
    pending(c, i) {
      let hi = -Infinity; let lo = Infinity;
      for (let j = Math.max(0, i - 19); j <= i; j++) { hi = Math.max(hi, c.bars[j].high); lo = Math.min(lo, c.bars[j].low); }
      const px = c.bars[i].close;
      const longOnly = c.inst.market === 'crypto';
      if (px > c.ema50[i] || longOnly) {
        return { dir: 1, type: 'stop', price: hi + c.inst.tick, why: 'A close above the 20-bar high at ' + fmt(c.inst, hi) + ' would start a new Turtle long.' };
      }
      return { dir: -1, type: 'stop', price: lo - c.inst.tick, why: 'A close below the 20-bar low at ' + fmt(c.inst, lo) + ' would start a new Turtle short.' };
    },
  },
  {
    id: 'rsi2',
    name: 'RSI(2) Pullback',
    style: 'Mean reversion',
    summary: 'Larry Connors\' rule: buy sharp 1-3 bar dips inside a long-term uptrend, sell into the bounce.',
    evidence: 'Our 1990-2026 tests: S&P 500 t-stat 4.1 and Nasdaq-100 3.1 after costs, both positive since 2020. The strongest daily result in our research.',
    caveat: 'Built for stock indexes on daily bars. It failed on forex, crypto and on 1-hour bars in our tests. Long-only.',
    rules: [
      'Uptrend filter: price above its 200-bar SMA.',
      'Buy when RSI(2) drops below 10.',
      'Sell when price closes above its 5-bar SMA. Catastrophe stop 3x ATR.',
    ],
    maxHold: 20,
    noTarget: true,
    applies: () => true,
    signals(c) {
      const n = c.bars.length;
      const sig = new Int8Array(n);
      for (let i = 200; i < n; i++) {
        if (c.bars[i].close > c.sma200[i] && c.rsi2[i] < 10) sig[i] = 1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) {
      return entry - dir * 3 * c.atr14[i];
    },
    exit(c, i, dir) {
      return dir > 0 ? c.bars[i].close > c.sma5[i] : c.bars[i].close < c.sma5[i];
    },
    why(c, i) {
      return 'RSI(2) is ' + c.rsi2[i].toFixed(1) + ' (a sharp dip) while price holds above its 200-bar average at ' + fmt(c.inst, c.sma200[i]) + '.';
    },
    pending() { return null; },
  },
  {
    id: 'trend_pullback',
    name: 'Trend Pullback',
    style: 'Trend following (classic)',
    summary: 'Buys dips to the 20 EMA in an uptrend (sells rallies in a downtrend) once price bounces back.',
    evidence: 'A widely taught chart rule, not an academic result. Judge it by the live backtest numbers.',
    caveat: 'No published evidence; included as a common discretionary setup.',
    rules: [
      'Trend: 20 EMA above a rising 50 EMA (mirror for shorts).',
      'Pullback: the bar dips to the 20 EMA but closes back above it as a green bar, RSI(14) 40-70.',
      'Stop and target from your risk profile (ATR multiple and reward:risk).',
    ],
    maxHold: 40,
    applies: () => true,
    signals(c) {
      const n = c.bars.length;
      const sig = new Int8Array(n);
      for (let i = 55; i < n; i++) {
        const b = c.bars[i];
        const up = c.ema20[i] > c.ema50[i] && c.ema50[i] > c.ema50[i - 5] && b.close > c.ema50[i];
        const dn = c.ema20[i] < c.ema50[i] && c.ema50[i] < c.ema50[i - 5] && b.close < c.ema50[i];
        if (up && b.low <= c.ema20[i] && b.close > c.ema20[i] && b.close > b.open && c.rsi14[i] >= 40 && c.rsi14[i] <= 70) sig[i] = 1;
        else if (dn && b.high >= c.ema20[i] && b.close < c.ema20[i] && b.close < b.open && c.rsi14[i] <= 60 && c.rsi14[i] >= 30) sig[i] = -1;
      }
      return sig;
    },
    why(c, i, dir) {
      return dir > 0
        ? 'Uptrend (20 EMA > 50 EMA) and price just bounced off the 20 EMA at ' + fmt(c.inst, c.ema20[i]) + '.'
        : 'Downtrend (20 EMA < 50 EMA) and price just got rejected at the 20 EMA at ' + fmt(c.inst, c.ema20[i]) + '.';
    },
    pending(c, i) {
      const b = c.bars[i];
      if (c.ema20[i] > c.ema50[i] && c.ema50[i] > c.ema50[i - 5] && b.close > c.ema20[i]) {
        return { dir: 1, type: 'limit', price: c.ema20[i], why: 'Uptrend in place; waiting for a dip to the 20 EMA at ' + fmt(c.inst, c.ema20[i]) + '.' };
      }
      if (c.ema20[i] < c.ema50[i] && c.ema50[i] < c.ema50[i - 5] && b.close < c.ema20[i]) {
        return { dir: -1, type: 'limit', price: c.ema20[i], why: 'Downtrend in place; waiting for a rally to the 20 EMA at ' + fmt(c.inst, c.ema20[i]) + '.' };
      }
      return null;
    },
  },
];

const INDEX_DAILY = ['SPY', 'QQQ', 'IWM', 'MES', 'MNQ'];
function monthOf(t) { const p = etParts(t); return p.year * 12 + p.month; }
function ymdOf(t) { const p = etParts(t); return p.year * 10000 + p.month * 100 + p.day; }
function nextWeekday(t) { let x = t + 86400; while ([0, 6].includes(etParts(x).weekday)) x += 86400; return x; }
function bizDaysLeftAfter(t) { let k = 0; let x = nextWeekday(t); const m = monthOf(t); while (monthOf(x) === m) { k++; x = nextWeekday(x); } return k; }
function prevBond(c, i) { for (let j = i; j >= 0; j--) { const v = c.bond.get(ymdOf(c.bars[j].time)); if (v != null) return v; } return NaN; }

STRATEGIES.push(
  {
    id: 'ibs',
    name: 'IBS Reversal',
    style: 'Mean reversion (daily)',
    summary: 'Buys index days that close near their low, sells the first close above the prior day\'s high.',
    evidence: 'Our 1990-2026 test: Nasdaq-100 2.86 t-stat, profitable in 73% of years; S&P 500 weaker (t 2.1). Index daily returns have reversed since about 1999 (Baltussen, van Bekkum & Da 2019).',
    caveat: 'Small edge per trade; crashes hurt the long side. Built for stock indexes on daily bars.',
    rules: [
      'Daily bars on index ETFs/futures (also gold).',
      'Internal bar strength = (close - low) / (high - low). Buy when it is under 0.2.',
      'Sell at the first close above the prior day\'s high, or after 5 days. Catastrophe stop 3x ATR.',
    ],
    maxHold: 5,
    noTarget: true,
    applies: (inst, tf) => tf === '1d' && INDEX_DAILY.concat(['GLD', 'MGC']).includes(inst.symbol),
    signals(c) {
      const n = c.bars.length; const sig = new Int8Array(n);
      for (let i = 20; i < n; i++) {
        const b = c.bars[i]; const r = b.high - b.low;
        if (r > 0 && (b.close - b.low) / r < 0.2) sig[i] = 1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) { return entry - dir * 3 * c.atr14[i]; },
    exit(c, i) { return i > 0 && c.bars[i].close > c.bars[i - 1].high; },
    why(c, i) {
      const b = c.bars[i];
      return 'Closed in the bottom ' + Math.round((b.close - b.low) / (b.high - b.low) * 100) + '% of today\'s range; index days like this have tended to bounce.';
    },
    pending() { return null; },
  },
  {
    id: 'month_end_rebal',
    name: 'Month-End Rebalancing Flow',
    style: 'Calendar flow (daily)',
    summary: 'In the last 5 trading days of the month, trades against pension-fund rebalancing: short stocks if they beat bonds this month, buy if they lagged.',
    evidence: 'Harvey, Mazzoleni & Melone (2025, NBER): Sharpe 1.1 in 1997-2023. Our tests 2002-2026: S&P 500 t-stat 2.9, profitable in 68% of years; Russell 2000 t-stat 3.2, profitable in 84% of years. Both positive since 2020.',
    caveat: 'New paper with no independent follow-up yet, and a crowded idea. Did not work on the Nasdaq-100 in our test.',
    rules: [
      'S&P 500 (SPY or MES) or Russell 2000 (IWM), daily bars. Bonds = TLT.',
      'Five trading days before month-end: compare this month\'s stock return with the bond return.',
      'Stocks ahead: sell short. Stocks behind: buy. Exit at the last close of the month. Catastrophe stop 3x ATR.',
    ],
    maxHold: 7,
    noTarget: true,
    needs: 'bond',
    applies: (inst, tf) => tf === '1d' && ['SPY', 'MES', 'IWM'].includes(inst.symbol),
    signals(c) {
      const n = c.bars.length; const sig = new Int8Array(n);
      if (!c.bond) return sig;
      let mStartIdx = 0; let mStartBond = NaN;
      for (let i = 1; i < n; i++) {
        if (monthOf(c.bars[i].time) !== monthOf(c.bars[i - 1].time)) { mStartIdx = i - 1; mStartBond = prevBond(c, i - 1); }
        if (bizDaysLeftAfter(nextWeekday(c.bars[i].time)) >= 5 || bizDaysLeftAfter(c.bars[i].time) < 5) continue;
        const rs = c.bars[i].close / c.bars[mStartIdx].close - 1;
        const rb = prevBond(c, i) / mStartBond - 1;
        if (isFinite(rs) && isFinite(rb)) sig[i] = rs > rb ? -1 : 1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) { return entry - dir * 3 * c.atr14[i]; },
    exit(c, i) { return monthOf(nextWeekday(c.bars[i].time)) !== monthOf(c.bars[i].time); },
    why(c, i, dir) {
      return dir < 0
        ? 'Stocks have beaten bonds this month, so balanced funds are expected to sell stocks into month-end.'
        : 'Stocks have lagged bonds this month, so balanced funds are expected to buy stocks into month-end.';
    },
    pending() { return null; },
  },
  {
    id: 'turn_of_month',
    name: 'Turn of the Month',
    style: 'Calendar effect (daily)',
    summary: 'Holds the stock index from the last trading day of the month through the third trading day of the next.',
    evidence: 'McConnell & Xu (2008), 1926-2005. Our 1990-2026 tests: held up on the Russell 2000 (t-stat 4.0), DAX (3.1) and FTSE 100 (3.6); mixed on the S&P 500 and Nasdaq-100; failed on the Nikkei and Euro Stoxx 50.',
    caveat: 'The effect has weakened over time (CXO: near zero in the latest quarter of the sample). Strongest on small caps and Europe in our tests.',
    rules: [
      'Index ETFs/futures, daily bars, long only.',
      'Buy at the open of the last trading day of the month.',
      'Sell at the close of the 3rd trading day of the new month. Catastrophe stop 3x ATR.',
    ],
    maxHold: 8,
    noTarget: true,
    applies: (inst, tf) => tf === '1d' && INDEX_DAILY.includes(inst.symbol),
    signals(c) {
      const n = c.bars.length; const sig = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const d1 = nextWeekday(c.bars[i].time); const d2 = nextWeekday(d1);
        if (monthOf(d1) !== monthOf(d2)) sig[i] = 1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) { return entry - dir * 3 * c.atr14[i]; },
    exit(c, i) {
      const m = monthOf(c.bars[i].time); let k = 0;
      for (let j = i; j >= 0 && monthOf(c.bars[j].time) === m; j--) k++;
      return k >= 3 && k < 10;
    },
    why() { return 'Tomorrow is the last trading day of the month; month-end cash flows have historically lifted stocks into the first days of the new month.'; },
    pending() { return null; },
  },
  {
    id: 'tlt_month_end',
    name: 'Treasury Month-End',
    style: 'Calendar flow (daily)',
    summary: 'Holds long-term Treasury bonds over the last 5 trading days of the month, when bond index funds buy to keep up with their index\'s month-end changes.',
    evidence: 'Hartley & Schwarz (2019). Our round 19 test on TLT\'s real prices, 2002-2026: +38 bp a trade as published (t-stat 4.0, up in 80% of years). The way the app trades it (next open, 3x ATR safety stop): +25 bp (t-stat 2.7), +28 bp since 2010 and +21 bp with costs doubled.',
    caveat: 'One market and one ETF, with no longer history to check it on. Since 2023 it made only +13 bp a trade over 45 trades (t-stat 0.6), and Fed or jobs-report days in the window can swamp the effect.',
    rules: [
      'Long-term Treasuries (TLT), daily bars, long only.',
      'Buy when 5 trading days of the month are left.',
      'Sell at the last close of the month. Catastrophe stop 3x ATR.',
    ],
    noTarget: true,
    maxHold: 8,
    applies: (inst, tf) => tf === '1d' && inst.symbol === 'TLT',
    signals(c) {
      const n = c.bars.length; const sig = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (bizDaysLeftAfter(nextWeekday(c.bars[i].time)) >= 5 || bizDaysLeftAfter(c.bars[i].time) < 5) continue;
        sig[i] = 1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) { return entry - dir * 3 * c.atr14[i]; },
    exit(c, i) { return monthOf(nextWeekday(c.bars[i].time)) !== monthOf(c.bars[i].time); },
    why() { return 'Five trading days of the month are left. Bond index funds rebalance at month-end, when their index adds newly issued, longer bonds, and long Treasuries have tended to rise into that.'; },
    pending() { return null; },
  },
  {
    id: 'donchian55',
    name: 'Turtle Breakout 55/20',
    style: 'Trend following (slow)',
    summary: 'The Turtles\' slower system: enter on a 55-bar breakout, exit on a 20-bar breakout the other way.',
    evidence: 'Original Turtle rules. Our tests: gold 4h and 1h and crypto daily held up best; stock indexes and FX were weak, matching research that equity and FX trends faded after 2009.',
    caveat: 'Long losing streaks between big trends. Crypto is long-only.',
    rules: [
      'Enter on a close above the prior 55-bar high (below the 55-bar low for shorts).',
      'Initial stop 2x ATR(20).',
      'Trailing exit at the 20-bar low (20-bar high for shorts). No fixed target.',
    ],
    maxHold: 400,
    noTarget: true,
    applies: (inst, tf) => ['1h', '4h', '1d'].includes(tf),
    signals(c) {
      const d55 = c.don55 || (c.don55 = ind.donchian(c.bars, 55));
      const n = c.bars.length; const sig = new Int8Array(n);
      const longOnly = c.inst.market === 'crypto';
      for (let i = 56; i < n; i++) {
        const b = c.bars[i]; const p = c.bars[i - 1];
        if (b.close > d55.hi[i] && !(p.close > d55.hi[i - 1])) sig[i] = 1;
        else if (!longOnly && b.close < d55.lo[i] && !(p.close < d55.lo[i - 1])) sig[i] = -1;
      }
      return sig;
    },
    initialStop(c, i, dir, entry) { return entry - dir * 2 * c.atr20[i]; },
    trail(c, i, dir) {
      let lo = Infinity; let hi = -Infinity;
      for (let j = Math.max(0, i - 19); j <= i; j++) { lo = Math.min(lo, c.bars[j].low); hi = Math.max(hi, c.bars[j].high); }
      return dir > 0 ? lo : hi;
    },
    why(c, i, dir) {
      const d55 = c.don55 || (c.don55 = ind.donchian(c.bars, 55));
      return (dir > 0 ? 'Closed above the 55-bar high of ' + fmt(c.inst, d55.hi[i]) : 'Closed below the 55-bar low of ' + fmt(c.inst, d55.lo[i])) + ', a slow Turtle breakout.';
    },
    pending(c, i) {
      let hi = -Infinity; let lo = Infinity;
      for (let j = Math.max(0, i - 54); j <= i; j++) { hi = Math.max(hi, c.bars[j].high); lo = Math.min(lo, c.bars[j].low); }
      const px = c.bars[i].close;
      if (px > c.ema50[i] || c.inst.market === 'crypto') return { dir: 1, type: 'stop', price: hi + c.inst.tick, why: 'A break above the 55-bar high at ' + fmt(c.inst, hi) + ' would start a slow Turtle long.' };
      return { dir: -1, type: 'stop', price: lo - c.inst.tick, why: 'A break below the 55-bar low at ' + fmt(c.inst, lo) + ' would start a slow Turtle short.' };
    },
  },
);

function applicableStrategies(inst, tf) {
  return STRATEGIES.filter((s) => s.applies(inst, tf));
}

function getStrategy(id) {
  return STRATEGIES.find((s) => s.id === id);
}

module.exports = { STRATEGIES, buildContext, applicableStrategies, getStrategy, noiseBands, calendar: { monthOf, nextWeekday, bizDaysLeftAfter } };

}, {"./indicators":"core/indicators.js","./time":"core/time.js"}],
"core/indicators.js": [function (module, exports, require) {
'use strict';
// Plain-array technical indicators. Each returns an array the same length as
// the input with NaN where the value is not defined yet.

function sma(values, n) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(values, n) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { seed += values[i]; continue; }
    if (i === n - 1) { seed += values[i]; prev = seed / n; out[i] = prev; continue; }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
function rsi(values, n) {
  const out = new Array(values.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) {
        gain /= n; loss /= n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

// Wilder's ATR
function atr(bars, n) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(NaN);
  let prev = NaN;
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < n) {
      sum += tr[i];
      if (i === n - 1) { prev = sum / n; out[i] = prev; }
    } else {
      prev = (prev * (n - 1) + tr[i]) / n;
      out[i] = prev;
    }
  }
  return out;
}

// Highest high / lowest low of the n bars BEFORE bar i (excludes bar i).
function donchian(bars, n) {
  const hi = new Array(bars.length).fill(NaN);
  const lo = new Array(bars.length).fill(NaN);
  for (let i = n; i < bars.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - n; j < i; j++) {
      if (bars[j].high > h) h = bars[j].high;
      if (bars[j].low < l) l = bars[j].low;
    }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
}

// Session-anchored VWAP. keyFn(bar) returns the session id. When a market has
// no volume (forex), every bar gets equal weight.
function vwap(bars, keyFn) {
  const out = new Array(bars.length).fill(NaN);
  let key = null;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const k = keyFn(b);
    if (k !== key) { key = k; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume > 0 ? b.volume : 1;
    pv += tp * v; vol += v;
    out[i] = pv / vol;
  }
  return out;
}

// Wilder's ADX (trend strength)
function adx(bars, n) {
  const len = bars.length;
  const out = new Array(len).fill(NaN);
  if (len < 2 * n + 1) return out;
  const tr = trueRange(bars);
  let trS = 0; let pS = 0; let mS = 0; let dxSum = 0; let adxPrev = NaN;
  for (let i = 1; i < len; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    if (i <= n) {
      trS += tr[i]; pS += pdm; mS += mdm;
      if (i < n) continue;
    } else {
      trS = trS - trS / n + tr[i];
      pS = pS - pS / n + pdm;
      mS = mS - mS / n + mdm;
    }
    const pdi = trS ? 100 * pS / trS : 0;
    const mdi = trS ? 100 * mS / trS : 0;
    const dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (i < 2 * n) { dxSum += dx; continue; }
    if (i === 2 * n) { dxSum += dx; adxPrev = dxSum / (n + 1); out[i] = adxPrev; continue; }
    adxPrev = (adxPrev * (n - 1) + dx) / n;
    out[i] = adxPrev;
  }
  return out;
}

module.exports = { sma, ema, rsi, atr, trueRange, donchian, vwap, adx };

}, {}],
"core/prop.js": [function (module, exports, require) {
'use strict';
// Prop firm challenge rules and a simulator. Used by the research scripts (historical
// pass rates) and by the paper account's Challenge mode (live rule checks).
//
// Presets follow each firm's published rules as checked on 2026-11-23. Firms change
// rules often: always read the firm's own rules page before paying for a challenge.
// Amounts are in USD of the account's starting balance.

const { sessionKey } = require('./time');

const PRESETS = [
  {
    id: 'topstep_50k', label: 'Topstep-style 50K futures', group: 'futures', startBalance: 50000,
    phases: [{ target: 3000, minDays: 2 }],
    dailyLoss: { amount: 1000, onBreach: 'pause' },
    maxLoss: { amount: 2000, type: 'trailing_eod', lockAt: 50000 },
    consistency: { maxDayShare: 0.55, mode: 'raise_target' },
    intradayOnly: true, flatBy: '3:10 PM CT', flatByEt: 16 * 60 + 10, markets: ['futures', 'stocks'], maxCalendarDays: null,
    fee: { text: '$49 a month, $149 to activate the funded account', firstTry: 49 + 149, monthly: 49 },
    notes: 'Target $3,000. Max loss $2,000 trails your best end-of-day balance and stops at $50,000. Optional $1,000 daily limit only pauses the day. Best day must stay under 55% of total profit (a bigger day raises the target).',
    source: 'help.topstep.com, Trading Combine parameters (Nov 2026)',
  },
  {
    id: 'apex_50k_eod', label: 'Apex-style 50K EOD futures', group: 'futures', startBalance: 50000,
    phases: [{ target: 3000, minDays: 1 }],
    dailyLoss: { amount: 1000, onBreach: 'pause' },
    maxLoss: { amount: 2000, type: 'trailing_eod', lockAt: 50000 },
    consistency: null,
    intradayOnly: true, flatBy: '4:59 PM ET', flatByEt: 16 * 60 + 59, markets: ['futures', 'stocks'], maxCalendarDays: 30,
    fee: { text: 'About $590 list (discount codes are common) plus $129 activation', firstTry: 590 + 129 },
    notes: 'Target $3,000 within 30 calendar days. Max loss $2,000 trails end-of-day balance. $1,000 daily limit pauses the day.',
    source: 'Apex 4.0 rules via secondary sources (official site blocked automated reads), Nov 2026',
  },
  {
    id: 'apex_50k_intraday', label: 'Apex-style 50K intraday trail', group: 'futures', startBalance: 50000,
    phases: [{ target: 3000, minDays: 1 }],
    dailyLoss: null,
    maxLoss: { amount: 2000, type: 'trailing_intraday', lockAt: 50000 },
    consistency: null,
    intradayOnly: true, flatBy: '4:59 PM ET', flatByEt: 16 * 60 + 59, markets: ['futures', 'stocks'], maxCalendarDays: 30,
    fee: { text: 'About $249 list plus $99 activation', firstTry: 249 + 99 },
    notes: 'Target $3,000 within 30 calendar days. Max loss $2,000 trails your highest open profit, including profit you never banked.',
    source: 'Apex 4.0 rules via secondary sources, Nov 2026',
  },
  {
    id: 'eod50_consistency', label: 'MFFU/Lucid-style 50K (EOD + 50% rule)', group: 'futures', startBalance: 50000,
    phases: [{ target: 3000, minDays: 2 }],
    dailyLoss: null,
    maxLoss: { amount: 2000, type: 'trailing_eod', lockAt: 50100 },
    consistency: { maxDayShare: 0.5, mode: 'block_pass' },
    intradayOnly: true, flatBy: '4:10 PM ET', flatByEt: 16 * 60 + 10, markets: ['futures', 'stocks'], maxCalendarDays: null,
    fee: { text: 'About $150 to $209 one-time', firstTry: 209 },
    notes: 'Target $3,000. Max loss $2,000 trails end-of-day balance. No single day may be half or more of your profit when you pass.',
    source: 'help.myfundedfutures.com Rapid 50K (Aug 2026); support.lucidtrading.com (Aug 2026)',
  },
  {
    id: 'ftmo_2step_100k', label: 'FTMO-style 2-step 100K', group: 'cfd', startBalance: 100000,
    phases: [{ target: 10000, minDays: 4 }, { target: 5000, minDays: 4 }],
    dailyLoss: { amount: 5000, onBreach: 'fail' },
    maxLoss: { amount: 10000, type: 'static', lockAt: null },
    consistency: null,
    intradayOnly: false, flatBy: null, maxCalendarDays: null,
    fee: { text: 'EUR 540, refunded with the first payout', firstTry: 590 },
    notes: 'Phase 1: +10%, phase 2: +5%, at least 4 trading days each. Fail at a 5% loss in one day (counting open trades) or 10% below the start.',
    source: 'ftmo.com/en/trading-objectives (Nov 2026)',
    // ftmo.com FAQ (read 2026-11-23): funded Standard accounts must be flat through market breaks over
    // 2 hours; the Swing type (2-Step only, 1:30 leverage) may hold through them
    fundedWeekend: 'Funded: weekend holds need the Swing type (pick it at checkout)',
  },
  {
    id: 'ftmo_1step_100k', label: 'FTMO-style 1-step 100K', group: 'cfd', startBalance: 100000,
    phases: [{ target: 10000, minDays: 0 }],
    dailyLoss: { amount: 3000, onBreach: 'fail' },
    maxLoss: { amount: 10000, type: 'trailing_eod', lockAt: null },
    consistency: { maxDayShare: 0.5, mode: 'block_pass' },
    intradayOnly: false, flatBy: null, maxCalendarDays: null,
    fee: { text: 'EUR 499, not refunded', firstTry: 545 },
    notes: 'One phase: +10%. Fail at a 3% loss in one day or 10% below your best end-of-day balance. Best day must be at most half of total profit to pass.',
    source: 'ftmo.com/blog/introducing-the-1-step-ftmo-challenge (Oct 2026)',
    fundedWeekend: 'Funded: flat before weekends (no Swing type for the 1-Step)',
  },
];

function getPreset(id) { return PRESETS.find((p) => p.id === id); }

// Trading day used by the firms: futures reset at 5 PM CT, FTMO at midnight Prague,
// both 6 PM New York time for most of the year.
function dayKey(t) { return sessionKey('cme', t); }

function keyToDate(k) { return Date.UTC(Math.floor(k / 10000), Math.floor(k / 100) % 100 - 1, k % 100); }

// Live rule state for an account in Challenge mode. Pure functions so the paper
// account and the simulator share one implementation.
function newChallengeState(preset, now) {
  return {
    presetId: preset.id, phase: 0, startBalance: preset.startBalance, startedAt: now, phaseStartedAt: now,
    hwm: preset.startBalance, floor: preset.startBalance - preset.maxLoss.amount,
    dayKey: dayKey(now), dayStartBalance: preset.startBalance, dayPnl: 0, paused: false,
    tradingDays: 0, tradedToday: false, dayPnls: [], status: 'active', reason: null, endedAt: null,
  };
}

// Advance to a new trading day if needed: close out yesterday for EOD trailing.
function rollDay(st, preset, now, balance) {
  const k = dayKey(now);
  if (k === st.dayKey) return false;
  endOfDay(st, preset, balance);
  st.dayKey = k; st.dayStartBalance = balance; st.dayPnl = 0; st.paused = false; st.tradedToday = false;
  return true;
}

function endOfDay(st, preset, balance) {
  if (st.tradedToday) { st.tradingDays++; st.dayPnls.push(st.dayPnl); }
  if (preset.maxLoss.type === 'trailing_eod') {
    st.hwm = Math.max(st.hwm, balance);
    const lvl = st.hwm - preset.maxLoss.amount;
    st.floor = Math.max(st.floor, preset.maxLoss.lockAt != null ? Math.min(lvl, preset.maxLoss.lockAt) : lvl);
  }
}

// Check equity against the limits. Returns 'fail:<reason>', 'pause' or null.
function checkEquity(st, preset, equity, peakEquity) {
  if (preset.maxLoss.type === 'trailing_intraday' && peakEquity != null) {
    st.hwm = Math.max(st.hwm, peakEquity);
    const lvl = st.hwm - preset.maxLoss.amount;
    st.floor = Math.max(st.floor, preset.maxLoss.lockAt != null ? Math.min(lvl, preset.maxLoss.lockAt) : lvl);
  }
  if (equity <= st.floor + 1e-9) return 'fail:max loss';
  if (preset.dailyLoss && st.dayStartBalance - equity >= preset.dailyLoss.amount - 1e-9) {
    return preset.dailyLoss.onBreach === 'fail' ? 'fail:daily loss' : 'pause';
  }
  // optional personal stop, a share of the firm's daily limit (research: 70% of the limit since round 17)
  if (preset.dailyLoss && st.selfStop && st.dayStartBalance - equity >= preset.dailyLoss.amount * st.selfStop - 1e-9) return 'selfstop';
  return null;
}

// Profit target for the current phase, including a consistency-raised target.
function phaseTarget(st, preset) {
  const base = preset.phases[st.phase].target;
  const c = preset.consistency;
  const days = st.dayPnls.concat(st.tradedToday ? [st.dayPnl] : []);
  const best = days.length ? Math.max(0, ...days) : 0;
  if (c && c.mode === 'raise_target' && best > 0) return Math.max(base, best / c.maxDayShare);
  return base;
}

// Has the current phase been passed at this (end-of-day) balance?
function phasePassed(st, preset, balance) {
  const ph = preset.phases[st.phase];
  const profit = balance - st.startBalance;
  if (profit < phaseTarget(st, preset) - 1e-9) return false;
  if (st.tradingDays < (ph.minDays || 0)) return false;
  const c = preset.consistency;
  if (c && c.mode === 'block_pass') {
    const best = st.dayPnls.length ? Math.max(0, ...st.dayPnls) : 0;
    if (best > c.maxDayShare * profit + 1e-9) return false;
  }
  return true;
}

// Simulate one attempt over closed trades (sorted by exit time), each with
// { exitDay, entryDay, pnl, mae, mfe } in USD at this account's size, starting on
// days[startIdx]. `days` lists every calendar day key in the data. maxDays caps how
// long an attempt may run (calendar days) when the firm has no time limit.
function simulateAttempt(preset, trades, startIdx, days, firstTradeIdx, maxDays) {
  const B = preset.startBalance;
  const ml = preset.maxLoss; const dl = preset.dailyLoss; const cons = preset.consistency;
  let phase = 0; let bal = B; let hwm = B; let floor = B - ml.amount;
  let tradingDays = 0; let bestDay = 0; let ti = firstTradeIdx;
  const start = days[startIdx];
  const limit = Math.min(preset.maxCalendarDays || Infinity, maxDays || Infinity);
  for (let di = startIdx; di < days.length; di++) {
    if (di - startIdx >= limit) return { result: preset.maxCalendarDays && limit === preset.maxCalendarDays ? 'fail' : 'timeout', reason: 'time limit', days: di - startIdx, tradingDays };
    const k = days[di];
    const dayStart = bal; let dayPnl = 0; let paused = false; let traded = false;
    while (ti < trades.length && trades[ti].exitDay === k) {
      const t = trades[ti++];
      if (t.entryDay < start || paused) continue;
      traded = true;
      const low = bal + t.mae; const high = bal + t.mfe;
      if (ml.type === 'trailing_intraday') {
        hwm = Math.max(hwm, high);
        const lvl = hwm - ml.amount; floor = Math.max(floor, ml.lockAt != null ? Math.min(lvl, ml.lockAt) : lvl);
      }
      if (low <= floor + 1e-9) return { result: 'fail', reason: 'max loss', days: di - startIdx + 1, tradingDays: tradingDays + 1 };
      if (dl && dayStart - low >= dl.amount - 1e-9) {
        if (dl.onBreach === 'fail') return { result: 'fail', reason: 'daily loss', days: di - startIdx + 1, tradingDays: tradingDays + 1 };
        // the limit closes the trade at that level (best case: no gap through it), so a
        // later recovery is not banked
        const realized = -(dl.amount - (dayStart - bal));
        bal += realized; dayPnl += realized; paused = true;
        if (bal <= floor + 1e-9) return { result: 'fail', reason: 'max loss', days: di - startIdx + 1, tradingDays: tradingDays + 1 };
        continue;
      }
      bal += t.pnl; dayPnl += t.pnl;
      if (bal <= floor + 1e-9) return { result: 'fail', reason: 'max loss', days: di - startIdx + 1, tradingDays: tradingDays + 1 };
    }
    // end of the trading day
    if (traded) { tradingDays++; if (dayPnl > bestDay) bestDay = dayPnl; }
    if (ml.type === 'trailing_eod') {
      hwm = Math.max(hwm, bal);
      const lvl = hwm - ml.amount; floor = Math.max(floor, ml.lockAt != null ? Math.min(lvl, ml.lockAt) : lvl);
    }
    const ph = preset.phases[phase];
    const profit = bal - B;
    let target = ph.target;
    if (cons && cons.mode === 'raise_target' && bestDay > 0) target = Math.max(target, bestDay / cons.maxDayShare);
    const consOk = !(cons && cons.mode === 'block_pass') || bestDay <= cons.maxDayShare * profit + 1e-9;
    if (profit >= target - 1e-9 && tradingDays >= (ph.minDays || 0) && consOk) {
      if (phase + 1 >= preset.phases.length) return { result: 'pass', days: di - startIdx + 1, tradingDays };
      phase++; bal = B; hwm = B; floor = B - ml.amount; tradingDays = 0; bestDay = 0;
    }
  }
  return { result: 'open', days: days.length - startIdx, tradingDays };
}

// Pass rate over every possible start day. `trades` in USD for this preset's account.
function passRates(preset, trades, days, opts) {
  const o = opts || {};
  const step = o.step || 1;
  const sorted = trades.slice().sort((a, b) => a.exitTime - b.exitTime).map((t) => Object.assign({}, t, { exitDay: dayKey(t.exitTime), entryDay: dayKey(t.entryTime) }));
  const out = { attempts: 0, pass: 0, fail: 0, timeout: 0, open: 0, reasons: {}, daysToPass: [], daysToFail: [], calToPass: [] };
  let ti = 0;
  for (let s = 0; s < days.length; s += step) {
    while (ti < sorted.length && sorted[ti].exitDay < days[s]) ti++;
    if (o.fromDay && days[s] < o.fromDay) continue;
    if (o.toDay && days[s] >= o.toDay) continue;
    const r = simulateAttempt(preset, sorted, s, days, ti, o.maxDays);
    if (r.result === 'open') { out.open++; continue; }
    out.attempts++;
    if (r.result === 'pass') { out.pass++; out.daysToPass.push(r.tradingDays); out.calToPass.push(r.days); } else if (r.result === 'timeout') { out.timeout++; } else { out.fail++; out.reasons[r.reason] = (out.reasons[r.reason] || 0) + 1; out.daysToFail.push(r.tradingDays); }
  }
  const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  return {
    attempts: out.attempts, passRate: out.attempts ? out.pass / out.attempts : null, failRate: out.attempts ? out.fail / out.attempts : null,
    timeoutRate: out.attempts ? out.timeout / out.attempts : null, pass: out.pass, fail: out.fail, timeout: out.timeout, open: out.open,
    reasons: out.reasons, medianTradingDaysToPass: med(out.daysToPass), medianCalendarDaysToPass: med(out.calToPass), medianTradingDaysToFail: med(out.daysToFail),
  };
}

module.exports = {
  PRESETS, getPreset, dayKey, newChallengeState, rollDay, endOfDay, checkEquity, phaseTarget, phasePassed,
  simulateAttempt, passRates,
};

}, {"./time":"core/time.js"}],
"core/exits.js": [function (module, exports, require) {
'use strict';
// "Time to sell?" rules: signs that a winning trade is turning shaky. Each rule is checked on a
// closed bar of the trade's own chart, only while the trade is in profit. The same functions run
// in the research test (research/run-exits.js) and in the live alert (core/paper.js), so the app
// only alerts on rules exactly as they were tested.
//
// st = { dir, entry, risk (price distance to the first stop), hi, lo (extremes since entry,
//        including bar i), bars (bars held, including bar i) }

function openR(st, price) { return (price - st.entry) * st.dir / st.risk; }
function bestR(st) { return ((st.dir > 0 ? st.hi : st.lo) - st.entry) * st.dir / st.risk; }
function trueRange(bars, k) { const b = bars[k]; const pc = k > 0 ? bars[k - 1].close : b.open; return Math.max(b.high, pc) - Math.min(b.low, pc); }
function avgTR(bars, i, n) { if (i < n) return NaN; let s = 0; for (let k = i - n + 1; k <= i; k++) s += trueRange(bars, k); return s / n; }

const RULES = {
  // Gave back half of the best open profit after being up at least 1R.
  giveback: {
    name: 'Gave back half its profit',
    test(c, i, st) {
      const best = bestR(st); const now = openR(st, c.bars[i].close);
      return best >= 1 && now > 0 && now <= best * 0.5 ? { now, best } : null;
    },
    text: (h) => 'It was up ' + h.best.toFixed(1) + 'R and is now up ' + h.now.toFixed(1) + 'R: half the open profit has gone.',
  },
  // Closed back through the 20-bar average against the trade (after being through it the bar before).
  ema20: {
    name: 'Lost its 20-bar average',
    test(c, i, st) {
      const now = openR(st, c.bars[i].close);
      if (!(now >= 0.5) || !(c.ema20[i] > 0) || !(c.ema20[i - 1] > 0)) return null;
      const d = st.dir;
      return (c.bars[i].close - c.ema20[i]) * d < 0 && (c.bars[i - 1].close - c.ema20[i - 1]) * d >= 0 ? { now } : null;
    },
    text: (h) => 'Up ' + h.now.toFixed(1) + 'R, but the last bar closed back through the 20-bar average against the trade.',
  },
  // A big bar against the trade (range 1.5x the 14-bar average) that closes near its worst point.
  reversal: {
    name: 'Sharp reversal bar',
    test(c, i, st) {
      const b = c.bars[i]; const now = openR(st, b.close); const atr = c.atr14[i - 1];
      if (!(now >= 0.5) || !(atr > 0)) return null;
      const range = b.high - b.low; if (!(range >= 1.5 * atr)) return null;
      const where = (b.close - b.low) / range; // 0 = closed at the low
      const against = st.dir > 0 ? (b.close < b.open && where <= 0.25) : (b.close > b.open && where >= 0.75);
      return against ? { now, size: range / atr } : null;
    },
    text: (h) => 'Up ' + h.now.toFixed(1) + 'R, then a bar ' + h.size.toFixed(1) + 'x the usual size closed near its worst point against the trade.',
  },
  // Closed beyond the last 3 bars' extreme against the trade.
  break3: {
    name: 'Broke the last 3 bars',
    test(c, i, st) {
      const b = c.bars[i]; const now = openR(st, b.close);
      if (!(now >= 0.5) || i < 4) return null;
      let ext = st.dir > 0 ? Infinity : -Infinity;
      for (let k = i - 3; k < i; k++) ext = st.dir > 0 ? Math.min(ext, c.bars[k].low) : Math.max(ext, c.bars[k].high);
      return (b.close - ext) * st.dir < 0 ? { now } : null;
    },
    text: (h) => 'Up ' + h.now.toFixed(1) + 'R, but it just closed beyond the last three bars against the trade.',
  },
  // Volatility jumped: the last 5 bars' range is 1.8x the 50-bar average.
  volspike: {
    name: 'Volatility jumped',
    test(c, i, st) {
      const now = openR(st, c.bars[i].close); if (!(now > 0.25)) return null;
      const a5 = avgTR(c.bars, i, 5); const a50 = avgTR(c.bars, i - 5, 50);
      return a5 > 0 && a50 > 0 && a5 / a50 >= 1.8 ? { now, x: a5 / a50 } : null;
    },
    text: (h) => 'Up ' + h.now.toFixed(1) + 'R while the market got ' + h.x.toFixed(1) + 'x more volatile than usual.',
  },
  // Stretched far from its 20-bar average (3x the 14-bar ATR) after being up at least 1R.
  stretch: {
    name: 'Stretched far from average',
    test(c, i, st) {
      const now = openR(st, c.bars[i].close); const atr = c.atr14[i];
      if (!(now >= 1) || !(atr > 0) || !(c.ema20[i] > 0)) return null;
      const x = (c.bars[i].close - c.ema20[i]) * st.dir / atr;
      return x >= 3 ? { now, x } : null;
    },
    text: (h) => 'Up ' + h.now.toFixed(1) + 'R and ' + h.x.toFixed(1) + ' ATRs past its 20-bar average: a stretched move.',
  },
  // Overbought (long) or oversold (short) on the 14-bar RSI while up at least 1R.
  rsi14: {
    name: 'Overbought',
    test(c, i, st) {
      const now = openR(st, c.bars[i].close); const r = c.rsi14[i];
      if (!(now >= 1) || !isFinite(r)) return null;
      return (st.dir > 0 ? r >= 80 : r <= 20) ? { now, r } : null;
    },
    text: (h) => 'Up ' + h.now.toFixed(1) + 'R with the 14-bar RSI at ' + h.r.toFixed(0) + (h.r >= 50 ? ', overbought.' : ', oversold.'),
  },
  // Going nowhere: held 15 bars or more and still less than 0.25R up.
  stale: {
    name: 'Going nowhere',
    test(c, i, st) {
      const now = openR(st, c.bars[i].close);
      return st.bars >= 15 && now > 0 && now < 0.25 ? { now, bars: st.bars } : null;
    },
    text: (h) => 'Held ' + h.bars + ' bars and only ' + h.now.toFixed(2) + 'R up: the move has stalled.',
  },
};

// Every rule that fires on bar i, in order.
function shaky(c, i, st, ids) {
  const out = [];
  for (const id of ids || Object.keys(RULES)) {
    const r = RULES[id]; if (!r) continue;
    let hit = null; try { hit = r.test(c, i, st); } catch (e) { hit = null; }
    if (hit) out.push({ id, name: r.name, text: r.text(hit), nowR: hit.now });
  }
  return out;
}

module.exports = { RULES, shaky, openR, bestR };

}, {}],
"core/api.js": [function (module, exports, require) {
'use strict';
// One dispatch table used by both the Electron IPC bridge and the dev server.

const { MARKETS, INSTRUMENTS, getInstrument } = require('./markets');
const { TIMEFRAMES, getCandles, getQuotes } = require('./data');
const { PROFILES } = require('./risk');
const { STRATEGIES } = require('./strategies');
const advisor = require('./advisor');
const ind = require('./indicators');
const { sessionKey } = require('./time');
const research = require('./research');
const PROP = require('./prop');
const top = require('./top');
const { isBeastCode } = require('./paper');

function createApi(account) {
  const methods = {
    catalog() {
      return {
        markets: MARKETS,
        instruments: INSTRUMENTS,
        timeframes: TIMEFRAMES,
        profiles: PROFILES,
        strategies: STRATEGIES.map((s) => ({ id: s.id, name: s.name, style: s.style, summary: s.summary, rules: s.rules, evidence: s.evidence, caveat: s.caveat })),
      };
    },
    async candles({ symbol, tf, limit }) {
      // indicators need warm-up history, so compute on the full cached series then slice
      const r = await getCandles(symbol, tf, { limit: 2000 });
      const inst = getInstrument(symbol);
      const close = r.bars.map((b) => b.close);
      const round = (arr) => arr.map((v) => (isFinite(v) ? Number(v.toFixed(inst.decimals + 2)) : null));
      const full = {
        ema20: round(ind.ema(close, 20)),
        ema50: round(ind.ema(close, 50)),
        vwap: round(ind.vwap(r.bars, (b) => sessionKey(inst.session, b.time))),
      };
      const n = Math.min(r.bars.length, limit || 1500);
      const from = r.bars.length - n;
      return {
        symbol, tf, status: r.status, meta: r.meta, error: r.error,
        bars: r.bars.slice(from),
        ind: { ema20: full.ema20.slice(from), ema50: full.ema50.slice(from), vwap: full.vwap.slice(from) },
      };
    },
    async quotes({ symbols }) {
      return getQuotes(symbols || INSTRUMENTS.map((i) => i.symbol));
    },
    // Settings > Get my code / Enter a code. The same box also takes the Beast Mode code.
    syncStatus() {
      return account.sync ? account.sync.status() : { available: false, linked: false };
    },
    async syncCreate() {
      if (!account.sync) throw new Error('Sync is not available in this version.');
      return account.sync.create();
    },
    async enterCode({ code }) {
      if (isBeastCode(code)) {
        const r = account.setBeast(!account.state.beast);
        return { kind: 'beast', beast: r.beast };
      }
      if (!account.sync) throw new Error('Sync is not available in this version.');
      return { kind: 'sync', status: await account.sync.join(code) };
    },
    syncUnlink() {
      return account.sync ? account.sync.unlink() : { available: false, linked: false };
    },
    async syncNow() {
      return account.sync ? account.sync.now() : { available: false, linked: false };
    },
    async suggest({ symbol, tf, profile, prefer, signals }) {
      const p = profile || account.state.profile;
      return advisor.suggest({ symbol, tf, profile: p, prefer, signals: !!signals, equity: account.equity(), usedNotionalFor: (m) => account.usedNotional(m), guardFor: (s) => account.guardBlock(s) });
    },
    async closeWatch() {
      return advisor.closeWatch();
    },
    topList() {
      return top.scanList();
    },
    async scanTop({ items, profile }) {
      const p = profile || account.state.profile;
      const eq = account.equity();
      return top.scanBatch(items || [], (symbol, tf) => advisor.suggest({ symbol, tf, profile: p, equity: eq, noLesson: true, allIdeas: true, usedNotionalFor: (m) => account.usedNotional(m), guardFor: (s) => account.guardBlock(s) }), 3);
    },
    async playbookToday({ profile }) {
      return advisor.playbookToday({ profile: profile || account.state.profile });
    },
    async strategyLab({ symbol, tf, profile }) {
      return advisor.strategyLab({ symbol, tf, profile: profile || account.state.profile });
    },
    account() {
      return account.snapshot();
    },
    async preview(params) {
      return account.preview(params);
    },
    async placeOrder(params) {
      getInstrument(params.symbol);
      return account.placeOrder(params);
    },
    async closePosition({ id }) {
      return account.closePosition(id, 'manual');
    },
    async closeAll() {
      const ids = account.state.positions.map((p) => p.id);
      const out = [];
      for (const id of ids) {
        try { out.push(await account.closePosition(id, 'manual')); } catch (e) { /* already closed */ }
      }
      return { closed: out.length };
    },
    async cancelOrder({ id }) {
      return account.cancelOrder(id);
    },
    async modifyPosition({ id, stop, target }) {
      return account.modifyPosition(id, { stop, target });
    },
    setProfile({ profile }) {
      return account.setProfile(profile);
    },
    setGuard({ on }) {
      return account.setGuard(on);
    },
    setSellAlerts({ mode }) {
      return account.setSellAlerts(mode);
    },
    async resetAccount({ cash }) {
      return account.reset(cash);
    },
    research() {
      return research.results;
    },
    propPresets() {
      return PROP.PRESETS;
    },
    async startChallenge({ presetId, selfStop }) {
      return account.startChallenge(presetId, { selfStop: !!selfStop });
    },
    async endChallenge() {
      return account.endChallenge();
    },
  };

  async function handle(method, params) {
    const fn = methods[method];
    if (!fn) throw new Error('Unknown method ' + method);
    return fn(params || {});
  }

  return { handle, methods };
}

module.exports = { createApi };

}, {"./markets":"core/markets.js","./data":"core/data.js","./risk":"core/risk.js","./strategies":"core/strategies.js","./advisor":"core/advisor.js","./indicators":"core/indicators.js","./time":"core/time.js","./research":"core/research.js","./prop":"core/prop.js","./top":"core/top.js","./paper":"core/paper.js"}],
"core/advisor.js": [function (module, exports, require) {
'use strict';
// The trade advisor: backtests every applicable strategy on the chart you are
// looking at, checks which ones are signalling right now, and turns the best
// one into a concrete paper-trade plan sized for your risk profile.

const { getCandles, isBarClosed, TF_SEC } = require('./data');
const { getInstrument, roundPrice } = require('./markets');
const { buildContext, applicableStrategies, getStrategy, calendar } = require('./strategies');
const { runBacktest, planFor } = require('./backtest');
const { getProfile, sizePosition, leverageFor } = require('./risk');
const { researchFor } = require('./research');
const { etParts } = require('./time');
const lesson = require('./lesson');
const top = require('./top');
const costs = require('./costs');

// How much the long-history research (1990-2026, see RESEARCH.md) moves a setup's score.
const RESEARCH_BONUS = { holds: 10, mixed: 3, fails: -15 };

const EXIT_TEXT = {
  noise_momentum: 'Trailing stop follows the noise band / VWAP every bar; flat by the 3:00 PM CT close.',
  orb: 'Target 10R, otherwise flat at the 3:00 PM CT close.',
  last_half_hour: 'Exit at the 3:00 PM CT close (catastrophe stop 3x ATR).',
  turtle: 'Trailing stop moves up to the 10-bar low (down to the 10-bar high for shorts) every bar. No fixed target: winners run.',
  rsi2: 'Exit when price closes above its 5-bar average (checked every bar), or at the catastrophe stop.',
  trend_pullback: 'Fixed stop and target from your risk profile.',
  ibs: 'Exit at the first close above the prior day\'s high, or after 5 days. Catastrophe stop 3x ATR.',
  month_end_rebal: 'Exit at the last close of the month. Catastrophe stop 3x ATR.',
  tlt_month_end: 'Exit at the last close of the month. Catastrophe stop 3x ATR.',
  turn_of_month: 'Exit at the close of the 3rd trading day of the new month. Catastrophe stop 3x ATR.',
  donchian55: 'Trailing stop moves to the 20-bar low (20-bar high for shorts) every bar. No fixed target.',
};
const ind = require('./indicators');

const HIGHER_TF = { '1m': '15m', '5m': '1h', '15m': '4h', '1h': '1d', '4h': '1d', '1d': null };

function closedBars(bars, tf) {
  if (!bars.length) return bars;
  const last = bars[bars.length - 1];
  return isBarClosed(last, tf) ? bars : bars.slice(0, -1);
}

function trendOf(bars) {
  if (bars.length < 60) return 0;
  const close = bars.map((b) => b.close);
  const e20 = ind.ema(close, 20);
  const e50 = ind.ema(close, 50);
  const i = close.length - 1;
  if (e20[i] > e50[i] && close[i] > e50[i]) return 1;
  if (e20[i] < e50[i] && close[i] < e50[i]) return -1;
  return 0;
}

async function higherTfTrend(symbol, tf) {
  const htf = HIGHER_TF[tf];
  if (!htf) return { tf: null, dir: 0 };
  try {
    const r = await getCandles(symbol, htf, { limit: 300, live: false });
    return { tf: htf, dir: trendOf(closedBars(r.bars, htf)) };
  } catch (e) {
    return { tf: htf, dir: 0, error: String(e.message || e) };
  }
}

function clampScore(x) { return Math.max(0, Math.min(100, Math.round(x))); }

function grade(score) {
  if (score >= 75) return 'A';
  if (score >= 62) return 'B';
  if (score >= 48) return 'C';
  return 'D';
}

function scoreOf(bt, dir, htfDir, fresh, pending) {
  const s = bt.stats;
  const shrink = s.trades / (s.trades + 25);
  let score = 50 + 35 * Math.tanh(2 * s.expectancyR * shrink);
  if (s.trades < 8) score = Math.min(score, 55);
  if (s.profitFactor > 1.3 && s.trades >= 10) score += 4;
  if (htfDir === dir) score += 8;
  else if (htfDir === -dir) score -= 12;
  if (fresh === 0) score += 4;
  if (pending) score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Should this idea be taken at all? 'skip' when the evidence is against it, 'caution' when it has
// a signal but something to watch, 'take' when every check passes. Each reason names its check so
// the app can show it (and the walkthrough step that explains it).
function verdictOf(o) {
  const { st, research, meets, score, profile, htf, dir, sizing, inst, tf } = o;
  const bad = []; const warn = []; const good = [];
  if (o.guard) bad.push({ k: 'guard', text: o.guard });
  const r2 = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + 'R';
  if (research && research.verdict === 'fails') {
    bad.push({ k: 'research', text: 'Our long-history test (' + research.market + ', ' + research.from + '-' + research.to + ') found no edge after costs: ' + (research.netBp >= 0 ? '+' : '') + research.netBp + ' bp per trade.' });
  } else if (research && research.verdict === 'holds' && research.check === 'weaker') {
    warn.push({ k: 'research', text: 'Held up over ' + research.from + '-' + research.to + ' (' + research.market + '), but ' + research.checkText.replace(/^Our/, 'our') });
  } else if (research && research.verdict === 'holds') {
    good.push({ k: 'research', text: 'Held up in our long-history test (' + research.market + ', ' + research.from + '-' + research.to + ', ' + research.trades.toLocaleString('en-US') + ' trades)' + (research.check === 'condition' ? '. ' + research.checkText : research.check === 'passed' ? ' and passed our triple check.' : '.') });
  } else if (research && research.verdict === 'mixed') {
    warn.push({ k: 'research', text: 'The long-history test was mixed (' + research.market + ', ' + (research.netBp >= 0 ? '+' : '') + research.netBp + ' bp per trade, but not strong enough to call an edge).' });
  } else {
    warn.push({ k: 'research', text: 'There is no long-history test for this strategy on ' + inst.symbol + ' ' + tf + ', only this chart\'s own history.' });
  }
  // A losing record on the chart's ~1,500 loaded bars sorts out strategies that do not suit a
  // market, so on its own it means skip. But when the long-history test is positive, a weak
  // recent record did not predict a worse next trade in our walk-forward test (round 21:
  // +0.044R a trade, t 2.6, over 8,259 such trades), so then it is only a caution.
  const longOk = research && (research.verdict === 'holds' || (research.verdict === 'mixed' && research.netBp > 0));
  if (st.trades >= 10 && st.expectancyR <= 0 && longOk) warn.push({ k: 'backtest', text: 'Its last ' + st.trades + ' signals on this chart averaged ' + r2(st.expectancyR) + ' per trade after costs. The long history is what counts here: in our tests a weak recent run inside a positive long history did not predict a worse next trade.' });
  else if (st.trades >= 10 && st.expectancyR <= 0) bad.push({ k: 'backtest', text: 'It lost money on this chart: ' + r2(st.expectancyR) + ' per trade over ' + st.trades + ' past signals, after costs.' });
  else if (st.trades >= 10) good.push({ k: 'backtest', text: 'Made ' + r2(st.expectancyR) + ' per trade over ' + st.trades + ' past signals on this chart, after costs.' });
  else if (st.trades >= 3 && st.expectancyR <= 0) warn.push({ k: 'backtest', text: 'Its ' + st.trades + ' past signals on this chart lost ' + r2(st.expectancyR) + ' per trade. Too few to judge, but not encouraging.' });
  else warn.push({ k: 'backtest', text: 'Only ' + st.trades + ' past signal' + (st.trades === 1 ? '' : 's') + ' on this chart, too few to trust.' });
  if (!meets) bad.push({ k: 'grade', text: 'Grade ' + grade(score) + ' is below your ' + profile.name + ' profile\'s minimum (' + grade(profile.minScore) + ').' });
  if (o.fresh === 1) warn.push({ k: 'late', text: 'The signal is one bar old, so you would enter a bar late. In our tests a late entry kept about three quarters of the edge on calendar trades and lost it on trend trades.' });
  if (htf && htf.tf && htf.dir === -dir) warn.push({ k: 'trend', text: 'The ' + htf.tf + ' trend points the other way.' });
  else if (htf && htf.tf && htf.dir === dir) good.push({ k: 'trend', text: 'The ' + htf.tf + ' trend agrees.' });
  if (st.costPerTradeR != null && st.costPerTradeR > 0.15) warn.push({ k: 'cost', text: 'Fees and spread eat about ' + st.costPerTradeR.toFixed(2) + 'R per trade here.' });
  if (sizing && sizing.roundedUp) warn.push({ k: 'size', text: 'The smallest size risks ' + sizing.riskPctActual.toFixed(2) + '% instead of ' + profile.riskPct + '%.' });
  if (sizing && !sizing.qty) bad.push({ k: 'size', text: sizing.capped ? 'No buying power left for ' + inst.market + ' under this risk profile.' : 'One ' + inst.unit.replace(/s$/, '') + ' risks ' + (sizing.perUnitRisk ? '$' + Math.round(sizing.perUnitRisk).toLocaleString('en-US') : 'more') + ', more than your ' + profile.name + ' profile allows per trade.' });
  const level = bad.length ? 'skip' : warn.length ? 'caution' : 'take';
  const title = { skip: 'Better to skip', caution: 'Take with care', take: 'Worth taking' }[level];
  const line = level === 'skip'
    ? (bad.every((b) => b.k === 'guard') ? 'The setup is fine, but your guard rails block a new trade here right now.'
      : bad.every((b) => b.k === 'size' || b.k === 'guard') ? 'The setup is fine, but it is too big to size at your risk here.' + (costs.ALT[inst.symbol] ? ' The cost box shows a smaller way to trade it.' : '')
        : 'The evidence is against this one. Not trading is a valid trade.')
    : level === 'caution'
      ? 'It has a signal, but ' + (warn.length === 1 ? 'one thing needs' : warn.length + ' things need') + ' care. Keep the size small.'
      : 'Every check passes. It can still lose: that is what the stop is for.';
  return { level, title, line, bad, warn, good };
}

function describeStats(s, tf) {
  if (!s.trades) return 'No past signals in the loaded ' + tf + ' history, so there is no track record yet.';
  return 'On the last ' + s.barsTested.toLocaleString('en-US') + ' ' + tf + ' bars this setup fired ' + s.trades +
    ' times: ' + s.winRate.toFixed(0) + '% winners, ' + (s.expectancyR >= 0 ? '+' : '') + s.expectancyR.toFixed(2) +
    'R per trade after costs, max drawdown ' + s.maxDrawdownPct.toFixed(1) + '%.';
}

// sessionClose: count today's US daily bar as closed once the session has ended (it is final at
// 4 PM ET; closedBars would wait until the next open)
async function analyze(symbol, tf, profileId, sessionClose) {
  const inst = getInstrument(symbol);
  const profile = getProfile(profileId);
  const r = await getCandles(symbol, tf, { limit: 1500 });
  const all = r.bars;
  if (all.length < 80) throw new Error('Not enough price history for ' + symbol + ' on ' + tf + ' yet.');
  const lastBar = all[all.length - 1];
  const done = sessionClose && tf === '1d' && inst.session === 'us_equity' && r.status && r.status.state === 'closed' && Date.now() / 1000 >= lastBar.time + 6.5 * 3600;
  const bars = done ? all : closedBars(all, tf);
  const c = buildContext(bars, inst, tf);
  const strategies = applicableStrategies(inst, tf);
  if (strategies.some((s) => s.needs === 'bond')) c.bond = await bondCloses();
  const results = strategies.map((strat) => ({ strat, bt: runBacktest(c, strat, profile), research: researchFor(strat.id, symbol, tf) }));
  return { inst, profile, c, all, bars, results, status: r.status };
}

// Daily TLT closes keyed by ET date, for the month-end rebalancing strategy.
async function bondCloses() {
  try {
    const r = await getCandles('TLT', '1d', { limit: 1500, live: false });
    const m = new Map();
    for (const b of r.bars) { const p = etParts(b.time); m.set(p.year * 10000 + p.month * 100 + p.day, b.close); }
    return m;
  } catch (e) {
    return null;
  }
}

function researchWarning(rs) {
  if (!rs) return null;
  if (rs.verdict === 'fails') return 'Our long-history test (' + rs.market + ' ' + rs.tf.replace('_rth', '') + ', ' + rs.from + '-' + rs.to + ') found no edge after costs: ' + (rs.netBp >= 0 ? '+' : '') + rs.netBp + ' bp per trade. Treat this as practice, not an edge.';
  return null;
}

async function suggest(params) {
  const { symbol, tf } = params;
  const { inst, profile, c, all, bars, results, status } = await analyze(symbol, tf, params.profile, true);
  const htf = await higherTfTrend(symbol, tf);
  const live = all[all.length - 1].close;
  const iLast = bars.length - 1;
  const atrNow = c.atr14[iLast];

  const candidates = [];
  for (const { strat, bt, research } of results) {
    const rb = research ? RESEARCH_BONUS[research.verdict] : 0;
    const sig = strat.signals(c);
    // fresh = signal on the last closed bar (0) or the one before it (1)
    for (let age = 0; age <= 1; age++) {
      const i = iLast - age;
      const dir = sig[i];
      if (!dir) continue;
      // Dip-buying entries one bar late lost their whole edge in our tests (+0.017R on time,
      // -0.002R a bar late, research/run-stale.js), so a day-old dip is not offered.
      if (age === 1 && /^Mean reversion/.test(strat.style || '')) break;
      const plan = planFor(c, strat, profile, i, dir, live);
      // skip if price already ran away from the signal (more than 1 ATR)
      if (Math.abs(live - bars[i].close) > (atrNow || 0) * 1.0) continue;
      candidates.push({
        strat, bt, dir, signalIndex: i, fresh: age, pending: false, entryType: 'market', entry: live, plan,
        why: strat.why(c, i, dir), score: clampScore(scoreOf(bt, dir, htf.dir, age, false) + rb), research,
      });
      break;
    }
    if (strat.pending) {
      const p = strat.pending(c, iLast);
      if (p && isFinite(p.price)) {
        // a limit must be on the favourable side of price, a stop on the far side
        const validLimit = p.type === 'limit' && (p.dir > 0 ? p.price < live : p.price > live);
        const validStop = p.type === 'stop' && (p.dir > 0 ? p.price > live : p.price < live);
        if (validLimit || validStop) {
          const plan = planFor(c, strat, profile, iLast, p.dir, p.price);
          candidates.push({
            strat, bt, dir: p.dir, signalIndex: iLast, fresh: null, pending: true, entryType: p.type, entry: p.price, plan,
            why: p.why, score: clampScore(scoreOf(bt, p.dir, htf.dir, null, true) + rb), research,
          });
        }
      }
    }
  }

  const ranked = candidates.sort((a, b) => (b.score - a.score) || (a.pending - b.pending));
  const out = {
    symbol, tf, profile: profile.id, price: live, status,
    htf, atr: atrNow, atrPct: atrNow / live * 100,
    generatedAt: Math.floor(Date.now() / 1000),
    strategiesChecked: results.map(({ strat, bt, research }) => ({ id: strat.id, name: strat.name, stats: bt.stats, research })),
    idea: null,
    alternatives: [],
  };
  // Chart signals: each strategy's past entries and exits (and the trade it is in now), for the
  // BUY / SELL markers on the candles.
  if (params.signals) out.signals = signalsOf(results, bars);
  if (!ranked.length) {
    out.message = 'No strategy has a setup on ' + symbol + ' ' + tf + ' right now. Try another timeframe or market, or place your own trade.';
    return out;
  }

  const equity = params.equity || 100000;
  const guardNote = params.guardFor ? params.guardFor(symbol) : null;
  const makeIdea = (best) => {
    const entry = roundPrice(inst, best.entry);
    const stop = roundPrice(inst, best.plan.stop);
    const target = best.plan.target != null ? roundPrice(inst, best.plan.target) : null;
    const usedNotional = params.usedNotionalFor ? params.usedNotionalFor(inst.market) : 0;
    const sizing = sizePosition({ inst, equity, entry, stop, profile, usedNotional });
    const st = best.bt.stats;
    const reasons = [best.why, describeStats(st, tf)];
    if (best.research && best.research.verdict !== 'fails') reasons.push('Long-history test: ' + best.research.text);
    const warnings = [];
    const rw = researchWarning(best.research);
    if (rw) warnings.push(rw);
    if (st.trades >= 5 && st.expectancyR < 0) warnings.push('This setup has lost money here recently (' + st.expectancyR.toFixed(2) + 'R per trade). Sitting out is a valid choice.');
    if (st.costPerTradeR != null && st.costPerTradeR > 0.15) warnings.push('Fees and spread cost about ' + st.costPerTradeR.toFixed(2) + 'R per round trip on ' + tf + '. Higher timeframes keep more of the edge' + (inst.market === 'crypto' ? ' (crypto fees are about 0.6% per side).' : '.'));
    if (htf.tf) {
      reasons.push(htf.dir === best.dir
        ? 'The ' + htf.tf + ' trend agrees (' + (htf.dir > 0 ? 'up' : 'down') + ').'
        : htf.dir === -best.dir
          ? 'Caution: the ' + htf.tf + ' trend points the other way (' + (htf.dir > 0 ? 'up' : 'down') + ').'
          : 'The ' + htf.tf + ' trend is sideways.');
    }
    if (sizing.roundedUp) warnings.push('One ' + inst.unit.replace(/s$/, '') + ' is the smallest size, which risks ' + sizing.riskPctActual.toFixed(2) + '% of equity instead of ' + profile.riskPct + '%.');
    if (sizing.capped) reasons.push('Size is capped by the ' + profile.name + ' ' + inst.market + ' exposure limit (' + leverageFor(profile, inst) + 'x equity).');
    const meets = best.score >= profile.minScore;
    const idea = {
      strategy: { id: best.strat.id, name: best.strat.name, style: best.strat.style, summary: best.strat.summary, rules: best.strat.rules, evidence: best.strat.evidence, caveat: best.strat.caveat },
      exitPlan: EXIT_TEXT[best.strat.id] || '',
      managed: !!(best.strat.trail || best.strat.exit),
      warnings,
      side: best.dir > 0 ? 'buy' : 'sell',
      entryType: best.entryType,
      entry, stop, target, rr: best.plan.rr,
      qty: sizing.qty, riskUsd: sizing.riskUsd || 0, notional: sizing.notional || 0, sizingNote: sizing.reason || null,
      rewardUsd: best.plan.rr ? (sizing.riskUsd || 0) * best.plan.rr : null,
      score: best.score, grade: grade(best.score), meetsProfile: meets,
      pending: best.pending,
      eod: !!(best.strat.eodStocks && inst.session === 'us_equity'),
      maxHoldBars: best.strat.maxHold,
      backtest: best.bt.stats,
      research: best.research || null,
      reasons,
      headline: (best.pending ? 'Setup forming: ' : '') + (best.dir > 0 ? 'Buy ' : 'Sell ') + symbol + ' (' + best.strat.name + ')',
    };
    idea.verdict = verdictOf({ st, research: best.research, meets, score: best.score, profile, htf, dir: best.dir, sizing, inst, tf, guard: guardNote, fresh: best.fresh });
    if (!meets) idea.profileNote = 'This ' + grade(best.score) + ' setup is below the ' + profile.name + ' profile minimum (' + grade(profile.minScore) + '). You can still paper-trade it to learn.';
    return { idea, entry, stop, target, sizing };
  };
  // Evidence first, the same order as Top trades: the verdict, then how strong the long-history
  // evidence is, then a live signal before a resting order, then the grade score.
  const scored = ranked.map((cand) => ({ cand, made: makeIdea(cand) }));
  const ordKey = (x) => ({ verdict: x.made.idea.verdict, evidence: { tier: top.evidenceTier(x.cand.research) }, pending: x.cand.pending, score: x.cand.score, symbol });
  scored.sort((a, b) => top.compareRows(ordKey(a), ordKey(b)));
  let pick = scored[0];
  const pf = params.prefer;
  if (pf) {
    const hit = scored.find((x) => x.cand.strat.id === pf.strategy && (x.cand.dir > 0 ? 'buy' : 'sell') === pf.side && !!x.cand.pending === !!pf.pending);
    if (hit) pick = hit;
  }
  const best = pick.cand; const made = pick.made;
  out.alternatives = scored.filter((x) => x !== pick).slice(0, 3).map(({ cand: x }) => ({ strategy: x.strat.name, side: x.dir > 0 ? 'buy' : 'sell', score: x.score, grade: grade(x.score), pending: x.pending }));
  out.idea = made.idea;
  const { entry, stop, target, sizing } = made;
  if (params.allIdeas) out.ideas = scored.map((x) => x.made.idea);
  // Cost checker: what each returned idea costs round trip, and whether it is cheaper elsewhere.
  const priceOf = async (sym) => { const r = await getCandles(sym, '1d', { limit: 5, live: false }); const b = r.bars[r.bars.length - 1]; return b ? b.close : null; };
  const costFor = (x) => costs.costOf({
    symbol, tf, price: x.made.entry, stop: x.made.stop, qty: x.made.sizing.qty, riskUsd: x.made.sizing.riskUsd || 0, notional: x.made.sizing.notional || 0,
    riskBudget: equity * profile.riskPct / 100, strategy: x.cand.strat.id, avgBars: x.cand.bt.stats.avgBars, side: x.cand.dir > 0 ? 'buy' : 'sell',
  }, priceOf).then((cst) => { x.made.idea.cost = cst; }).catch(() => { x.made.idea.cost = null; });
  await Promise.all((params.allIdeas ? scored : [pick]).map(costFor));
  if (!params.noLesson) try {
    out.idea.lesson = lesson.build({
      c, strat: best.strat, cand: best, inst, tf, symbol, sizing, profile, equity, bt: best.bt, research: best.research, htf,
      entry, stop, target, rr: best.plan.rr, marketClosed: !!(status && status.state === 'closed'),
    });
  } catch (e) {
    out.idea.lesson = null; out.idea.lessonError = String((e && e.message) || e);
  }
  return out;
}

const r2 = (x) => Math.round(x * 100) / 100;
function signalsOf(results, bars) {
  return results.map(({ strat, bt, research }) => {
    const o = bt.openTrade;
    return {
      id: strat.id, name: strat.name, style: strat.style,
      verdict: research ? research.verdict : null,
      stats: { trades: bt.stats.trades, winRate: bt.stats.winRate, expectancyR: bt.stats.expectancyR },
      trades: bt.trades.slice(-80).map((t) => ({ dir: t.dir, entryTime: t.entryTime, exitTime: t.exitTime, entry: t.entry, exit: t.exit, R: r2(t.R), reason: t.reason })),
      open: o ? { dir: o.dir, entryTime: bars[o.entryIdx].time, entry: o.entryFill, stop: o.stop, target: o.target } : null,
    };
  });
}

async function strategyLab(params) {
  const { symbol, tf } = params;
  const { inst, profile, results, bars } = await analyze(symbol, tf, params.profile);
  return {
    symbol, tf, profile: profile.id, bars: bars.length,
    from: bars[0].time, to: bars[bars.length - 1].time,
    strategies: results.map(({ strat, bt, research }) => ({
      id: strat.id, name: strat.name, style: strat.style, summary: strat.summary, rules: strat.rules,
      evidence: strat.evidence, caveat: strat.caveat, research,
      stats: bt.stats,
      curve: downsample(bt.curve, 160),
      trades: bt.trades.slice(-40),
    })),
    costs: { slipBps: inst.slipBps, slipTicks: inst.slipTicks, feeBps: inst.feeBps, feePerUnit: inst.feePerUnit },
    tfSec: TF_SEC[tf],
  };
}

function downsample(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let k = 0; k < max; k++) out.push(points[Math.floor(k * step)]);
  out.push(points[points.length - 1]);
  return out;
}

// The research playbook (RESEARCH.md, sections 1.7 and 1.8): what each of its strategies that
// PaperDesk can chart says today. DAX and FTSE turn of the month follow the same calendar as the
// Russell 2000 one (holidays aside), so they share its row.
const PLAYBOOK_LIVE = [
  { strategy: 'rsi2', research: 'rsi2|ES|1d', symbol: 'SPY', tf: '1d', market: 'S&P 500', cfd: 'US500' },
  { strategy: 'rsi2', research: 'rsi2|NQ|1d', symbol: 'QQQ', tf: '1d', market: 'Nasdaq-100', cfd: 'US100' },
  { strategy: 'ibs', research: 'ibs|NQ|1d', symbol: 'QQQ', tf: '1d', market: 'Nasdaq-100', cfd: 'US100' },
  { strategy: 'month_end_rebal', research: 'month_end_rebal|ES|1d', symbol: 'SPY', tf: '1d', market: 'S&P 500', cfd: 'US500' },
  { strategy: 'month_end_rebal', research: 'month_end_rebal|RUT|1d', symbol: 'IWM', tf: '1d', market: 'Russell 2000', cfd: 'US2000' },
  { strategy: 'turn_of_month', research: 'turn_of_month|RUT|1d', symbol: 'IWM', tf: '1d', market: 'Russell 2000, DAX and FTSE 100', cfd: 'US2000, GER40, UK100' },
  { strategy: 'turtle', research: 'turtle|BTC|1d', symbol: 'BTC-USD', tf: '1d', market: 'Bitcoin', cfd: 'BTCUSD' },
  { strategy: 'turtle', research: 'turtle|USDJPY|1h', symbol: 'USDJPY', tf: '1h', market: 'USD/JPY', cfd: 'USDJPY' },
];

// When a calendar strategy next enters (the open of that day), counting weekdays only.
function nextWindow(strategy, t) {
  const { monthOf, nextWeekday, bizDaysLeftAfter } = calendar;
  let x = t;
  for (let k = 0; k < 45; k++) {
    x = nextWeekday(x);
    if (strategy === 'turn_of_month' && monthOf(nextWeekday(x)) !== monthOf(nextWeekday(nextWeekday(x)))) return nextWeekday(x);
    if (strategy === 'month_end_rebal' && bizDaysLeftAfter(nextWeekday(x)) < 5 && bizDaysLeftAfter(x) >= 5) return nextWeekday(x);
  }
  return null;
}

// How far the market is from a signal, in words (non-calendar strategies)
function nearText(strategy, c, i) {
  const b = c.bars[i];
  if (strategy === 'rsi2') return 'RSI(2) is ' + c.rsi2[i].toFixed(0) + '; it buys below 10' + (b.close > c.sma200[i] ? '.' : ', and only above the 200-day average (now ' + fmt(c.inst, c.sma200[i]) + ').');
  if (strategy === 'ibs') { const r = b.high - b.low; return r > 0 ? 'Last close was ' + Math.round((b.close - b.low) / r * 100) + '% up its day\'s range; it buys under 20%.' : null; }
  if (strategy === 'turtle') return 'Breaks out on a close above ' + fmt(c.inst, c.don20.hi[i]) + (c.inst.market === 'crypto' ? ' (long only).' : ' or below ' + fmt(c.inst, c.don20.lo[i]) + '.');
  return null;
}
function fmt(inst, p) { return p == null || !isFinite(p) ? '-' : p.toFixed(inst.decimals); }

async function playbookToday(params) {
  const cache = new Map();
  const get = (sym, tf) => { const k = sym + '|' + tf; if (!cache.has(k)) cache.set(k, analyze(sym, tf, (params || {}).profile, true)); return cache.get(k); };
  const rows = await Promise.all(PLAYBOOK_LIVE.map(async (p) => {
    try {
      const a = await get(p.symbol, p.tf);
      const r = a.results.find((x) => x.strat.id === p.strategy);
      if (!r) return Object.assign({}, p, { state: 'error', text: 'Not available on this chart.' });
      const last = a.bars.length - 1; const sig = r.strat.signals(a.c); const open = r.bt.openTrade;
      const out = Object.assign({}, p, { name: r.strat.name, price: a.all[a.all.length - 1].close, asOf: a.bars[last].time, decimals: a.inst.decimals, exitText: EXIT_TEXT[p.strategy] || null, research: r.research ? r.research.verdict : null });
      if (open) return Object.assign(out, { state: 'in', dir: open.dir, since: a.bars[open.entryIdx].time, entry: open.entryFill, stop: open.stop, exitNow: !!(r.strat.exit && open.entryIdx < last + 1 && r.strat.exit(a.c, last, open.dir)) });
      if (sig[last]) return Object.assign(out, { state: 'signal', dir: sig[last], why: r.strat.why(a.c, last, sig[last]) });
      return Object.assign(out, { state: 'none', next: nextWindow(p.strategy, a.bars[last].time), near: nearText(p.strategy, a.c, last) });
    } catch (e) {
      return Object.assign({}, p, { state: 'error', text: String(e.message || e) });
    }
  }));
  return { rows, generated: Math.floor(Date.now() / 1000) };
}

// Buy-at-the-close watch. Round 18 found RSI(2) and IBS did as well or better when bought at the
// signal day's close (and RSI(2) on the Nasdaq-100 only worked that way). During the session the
// last daily bar is today's, still forming: this asks "if it closed at this price, would the rule
// fire?", and at what price it would.
const CLOSE_WATCH = [
  { strategy: 'rsi2', symbol: 'SPY', research: 'rsi2|ES|1d', label: 'RSI(2) on SPY', market: 'S&P 500' },
  { strategy: 'rsi2', symbol: 'QQQ', research: 'rsi2|NQ|1d', label: 'RSI(2) on QQQ', market: 'Nasdaq-100', mustClose: true },
  { strategy: 'ibs', symbol: 'QQQ', research: 'ibs|NQ|1d', label: 'IBS on QQQ', market: 'Nasdaq-100' },
];
function rsi2Last(closes) { const r = ind.rsi(closes, 2); return r[r.length - 1]; }
async function closeWatch() {
  const now = Math.floor(Date.now() / 1000);
  const p = etParts(now);
  const minsToClose = 960 - p.minutes;
  const cache = new Map();
  const rows = await Promise.all(CLOSE_WATCH.map(async (w) => {
    try {
      if (!cache.has(w.symbol)) cache.set(w.symbol, getCandles(w.symbol, '1d', { limit: 400 }));
      const r = await cache.get(w.symbol);
      const inst = getInstrument(w.symbol);
      const open = r.status && r.status.state !== 'closed';
      const bars = r.bars; const n = bars.length; const b = bars[n - 1];
      const closes = bars.map((x) => x.close);
      const sma200 = (k, c) => { let s = 0; for (let j = k - 199; j <= k; j++) s += j === k ? c : closes[j]; return s / 200; };
      const out = Object.assign({}, w, { price: b.close, open, minsToClose: open ? minsToClose : null, barTime: b.time, decimals: inst.decimals });
      if (w.strategy === 'rsi2') {
        const v = rsi2Last(closes); const avg = sma200(n - 1, b.close);
        const fires = b.close > avg && v < 10;
        // the highest close that would still give RSI(2) under 10 (and stay above the average)
        let lo = b.close * 0.85; let hi = b.close * 1.15; const at = (c) => { const cc = closes.slice(); cc[n - 1] = c; return rsi2Last(cc); };
        if (at(lo) >= 10) lo = null;
        else { for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (at(m) < 10) lo = m; else hi = m; } }
        Object.assign(out, { value: v, valueText: 'RSI(2) ' + v.toFixed(0), need: 'under 10', above200: b.close > avg, avg200: avg,
          fireBelow: lo != null && lo > avg ? roundPrice(inst, lo) : null,
          state: fires ? 'fire' : (v < 25 && b.close > avg ? 'near' : 'far') });
        if (b.close <= avg) out.note = 'Below its 200-day average (' + avg.toFixed(inst.decimals) + '), so the rule sits out.';
      } else {
        const range = b.high - b.low; const v = range > 0 ? (b.close - b.low) / range : 0.5;
        Object.assign(out, { value: v * 100, valueText: Math.round(v * 100) + '% up the day\'s range', need: 'under 20%',
          fireBelow: range > 0 ? roundPrice(inst, b.low + 0.2 * range) : null,
          state: v < 0.2 ? 'fire' : v < 0.35 ? 'near' : 'far' });
      }
      return out;
    } catch (e) {
      return Object.assign({}, w, { state: 'error', text: String((e && e.message) || e) });
    }
  }));
  return { rows, minsToClose, weekday: p.weekday, generatedAt: now };
}

module.exports = { suggest, strategyLab, playbookToday, closeWatch, grade, HIGHER_TF, _internal: { scoreOf, verdictOf, closedBars, trendOf, getStrategy, nextWindow }, analyze };

}, {"./data":"core/data.js","./markets":"core/markets.js","./strategies":"core/strategies.js","./backtest":"core/backtest.js","./risk":"core/risk.js","./research":"core/research.js","./time":"core/time.js","./lesson":"core/lesson.js","./top":"core/top.js","./costs":"core/costs.js","./indicators":"core/indicators.js"}],
"core/backtest.js": [function (module, exports, require) {
'use strict';
// Bar-by-bar backtester shared by the trade advisor and the Strategy Lab.
// Conservative assumptions: enter at the NEXT bar's open, pay slippage and
// fees on both sides, and if a bar touches both stop and target, assume the
// stop was hit first.

const { quoteToUsd, slippage, feeUsd } = require('./markets');
const { leverageFor } = require('./risk');

function stopDistance(c, strat, profile, i) {
  const a = c.atr14[i];
  if (!(a > 0)) return NaN;
  return a * profile.stopAtr;
}

// Build a trade plan (stop and target) for an entry at `entry` from signal bar i.
function planFor(c, strat, profile, i, dir, entry) {
  let stop = strat.initialStop ? strat.initialStop(c, i, dir, entry, profile) : entry - dir * stopDistance(c, strat, profile, i);
  // keep the stop on the right side and at least a quarter ATR away
  const minDist = (c.atr14[i] || 0) * 0.25;
  if (!isFinite(stop) || (entry - stop) * dir < minDist) stop = entry - dir * minDist;
  const risk = Math.abs(entry - stop);
  const rr = strat.noTarget ? null : (strat.targetR || profile.rr);
  const target = rr ? entry + dir * rr * risk : null;
  return { stop, target, risk, rr };
}

function isSessionEnd(c, i) {
  return i + 1 < c.bars.length && c.keys[i + 1] !== c.keys[i];
}

function runBacktest(c, strat, profile, opts) {
  const o = opts || {};
  const bars = c.bars;
  const inst = c.inst;
  const n = bars.length;
  const sig = strat.signals(c);
  const trades = [];
  const curve = [];
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let pos = null;
  const eod = strat.eodStocks && inst.session === 'us_equity';
  const start = o.start || 0;

  function closeTrade(i, rawExit, reason) {
    const dir = pos.dir;
    const exitFill = rawExit - dir * slippage(inst, rawExit);
    const q2u = quoteToUsd(inst, pos.entryFill);
    const perUnitRiskUsd = pos.riskPerUnit * inst.multiplier * q2u;
    const fees = feeUsd(inst, pos.entryFill, 1) + feeUsd(inst, exitFill, 1);
    const pnlUsd = (exitFill - pos.entryFill) * dir * inst.multiplier * quoteToUsd(inst, exitFill) - fees;
    const R = perUnitRiskUsd > 0 ? pnlUsd / perUnitRiskUsd : 0;
    const effRisk = Math.min(profile.riskPct / 100, leverageFor(profile, inst) * pos.riskPerUnit / pos.entryFill);
    equity *= Math.max(0.0001, 1 + effRisk * R);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
    // Worst and best open profit while the trade was on, in R before costs. On the
    // exit bar the adverse move is clipped at the stop (a deeper move would have
    // stopped the trade) and the favourable move at the target.
    const b = bars[i];
    let lo; let hi;
    if (dir > 0) {
      lo = Math.min(pos.lo, Math.max(b.low, Math.min(pos.stop, rawExit)));
      hi = Math.max(pos.hi, pos.target != null ? Math.min(b.high, Math.max(pos.target, rawExit)) : b.high);
    } else {
      hi = Math.max(pos.hi, Math.min(b.high, Math.max(pos.stop, rawExit)));
      lo = Math.min(pos.lo, pos.target != null ? Math.max(b.low, Math.min(pos.target, rawExit)) : b.low);
    }
    const maeR = Math.min(0, ((dir > 0 ? lo : hi) - pos.entryFill) * dir / pos.riskPerUnit);
    const mfeR = Math.max(0, ((dir > 0 ? hi : lo) - pos.entryFill) * dir / pos.riskPerUnit);
    trades.push({
      dir, entryTime: bars[pos.entryIdx].time, exitTime: bars[i].time, entry: pos.entryFill, exit: exitFill,
      stop: pos.initialStop, target: pos.target, R, reason: reason === 'stop' && pos.stop !== pos.initialStop ? 'trailing stop' : reason, bars: i - pos.entryIdx + 1,
      maeR, mfeR,
    });
    curve.push({ time: bars[i].time, value: equity });
    pos = null;
  }

  for (let i = Math.max(1, start); i < n; i++) {
    const b = bars[i];
    const hadPos = !!pos;
    if (pos && strat.trail && i - 1 >= pos.entryIdx) {
      const t = strat.trail(c, i - 1, pos.dir);
      if (isFinite(t) && (t - pos.stop) * pos.dir > 0) pos.stop = t;
    }
    if (pos) {
      const d = pos.dir;
      const stopHit = d > 0 ? b.low <= pos.stop : b.high >= pos.stop;
      const tgtHit = pos.target != null && (d > 0 ? b.high >= pos.target : b.low <= pos.target);
      const gapStop = d > 0 ? b.open <= pos.stop : b.open >= pos.stop;
      const gapTgt = pos.target != null && (d > 0 ? b.open >= pos.target : b.open <= pos.target);
      if (gapStop) closeTrade(i, b.open, 'stop');
      else if (gapTgt) closeTrade(i, b.open, 'target');
      else if (stopHit) closeTrade(i, pos.stop, 'stop');
      else if (tgtHit) closeTrade(i, pos.target, 'target');
      else if (strat.exit && strat.exit(c, i, d)) closeTrade(i, b.close, 'exit rule');
      // research hook: an extra exit checked at the bar's close (core/exits.js rules)
      else if (o.overlay && i > pos.entryIdx && o.overlay(c, i, { dir: d, entry: pos.entryFill, risk: pos.riskPerUnit, hi: Math.max(pos.hi, b.high), lo: Math.min(pos.lo, b.low), bars: i - pos.entryIdx + 1 })) closeTrade(i, b.close, 'sell alert');
      else if (eod && isSessionEnd(c, i)) closeTrade(i, b.close, 'close of day');
      else if (i - pos.entryIdx + 1 >= strat.maxHold) closeTrade(i, b.close, 'time');
      if (pos) { pos.lo = Math.min(pos.lo, b.low); pos.hi = Math.max(pos.hi, b.high); }
    }
    // signal on bar i-1 -> enter at bar i open
    const s = sig[i - 1];
    if (!pos && !hadPos && s !== 0 && !(eod && c.keys[i] !== c.keys[i - 1])) {
      const entryFill = b.open + s * slippage(inst, b.open);
      const plan = planFor(c, strat, profile, i - 1, s, entryFill);
      if (plan.risk > 0 && isFinite(plan.risk)) {
        pos = { dir: s, entryIdx: i, entryFill, stop: plan.stop, initialStop: plan.stop, target: plan.target, riskPerUnit: plan.risk, lo: entryFill, hi: entryFill };
        // the entry bar itself can hit the stop/target
        const d = s;
        if (d > 0 ? b.low <= pos.stop : b.high >= pos.stop) closeTrade(i, pos.stop, 'stop');
        else if (pos.target != null && (d > 0 ? b.high >= pos.target : b.low <= pos.target)) closeTrade(i, pos.target, 'target');
        if (pos) { pos.lo = Math.min(pos.lo, b.low); pos.hi = Math.max(pos.hi, b.high); }
      }
    }
  }
  const stats = summarize(trades, equity, maxDd, n);
  const firstBar = bars[Math.min(n - 1, 200)];
  stats.buyHoldPct = n > 201 ? (bars[n - 1].close / firstBar.open - 1) * 100 : null;
  stats.exposurePct = n ? trades.reduce((a, t) => a + t.bars, 0) / n * 100 : 0;
  stats.costPerTradeR = costInR(c, strat, profile);
  return { trades, curve, stats, openTrade: pos };
}

// Average round-trip cost expressed in R for a typical stop on this chart.
function costInR(c, strat, profile) {
  const i = c.bars.length - 1;
  if (i < 20) return null;
  const px = c.bars[i].close;
  const plan = planFor(c, strat, profile, i, 1, px);
  const inst = c.inst;
  const costPrice = 2 * slippage(inst, px) + 2 * feeUsd(inst, px, 1) / (inst.multiplier * quoteToUsd(inst, px));
  return plan.risk > 0 ? costPrice / plan.risk : null;
}

function summarize(trades, equity, maxDd, nBars) {
  const n = trades.length;
  const wins = trades.filter((t) => t.R > 0);
  const losses = trades.filter((t) => t.R <= 0);
  const sumW = wins.reduce((a, t) => a + t.R, 0);
  const sumL = losses.reduce((a, t) => a + t.R, 0);
  const exp = n ? (sumW + sumL) / n : 0;
  const sd = n > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.R - exp) * (t.R - exp), 0) / (n - 1)) : 0;
  return {
    trades: n,
    winRate: n ? wins.length / n * 100 : 0,
    avgWinR: wins.length ? sumW / wins.length : 0,
    avgLossR: losses.length ? sumL / losses.length : 0,
    expectancyR: exp,
    profitFactor: sumL < 0 ? sumW / -sumL : (sumW > 0 ? 99 : 0),
    totalReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    sqn: sd > 0 ? Math.sqrt(Math.min(n, 100)) * exp / sd : 0,
    avgBars: n ? trades.reduce((a, t) => a + t.bars, 0) / n : 0,
    barsTested: nBars,
  };
}

module.exports = { runBacktest, planFor, stopDistance, summarize, costInR };

}, {"./markets":"core/markets.js","./risk":"core/risk.js"}],
"core/research.js": [function (module, exports, require) {
'use strict';
// Results of the long-history research run (research/ folder), bundled with the app.
// Maps an app instrument + timeframe to the matching research test, if one exists.
const results = require('./research-results.json');

const byId = new Map(results.strategies.map((s) => [s.id, s]));
// Round 19 (research/run-r19.js): rules tested on the app's own ETF symbols
const r19 = require('./research-r19.json');
const bySymbol = new Map();
for (const s of r19.strategies) for (const sym of s.symbols) bySymbol.set(s.strategy + '|' + sym + '|' + s.tf, s);
const MARKET_OF = {
  SPY: 'ES', MES: 'ES', QQQ: 'NQ', MNQ: 'NQ', IWM: 'RUT', GLD: 'GC', MGC: 'GC', MCL: 'CL',
  EURUSD: 'EURUSD', GBPUSD: 'GBPUSD', USDJPY: 'USDJPY', 'BTC-USD': 'BTC', 'ETH-USD': 'ETH',
};
const VERDICT_TEXT = { holds: 'Held up', mixed: 'Mixed', fails: 'Failed' };

function researchFor(strategyId, symbol, tf) {
  const r19r = bySymbol.get(strategyId + '|' + symbol + '|' + tf);
  if (r19r) return r19Of(r19r);
  const m = MARKET_OF[symbol];
  if (!m) return null;
  const rtf = tf === '5m' ? '5m_rth' : tf;
  const r = byId.get(strategyId + '|' + m + '|' + rtf);
  if (!r) return null;
  return {
    id: r.id, verdict: r.verdict, label: VERDICT_TEXT[r.verdict], market: r.marketLabel, tf: r.tf, from: r.from, to: r.to,
    trades: r.trades, sharpe: r.sharpe, tStat: r.tStat, netBp: r.netBp, pctYearsPositive: r.pctYearsPositive,
    check: r.check ? r.check.status : null, checkText: checkText(r),
    text: r.marketLabel + ' ' + r.tf.replace('_rth', ' US hours') + ', ' + r.from + '-' + r.to + ': ' + r.trades.toLocaleString('en-US') + ' trades, ' +
      (r.netBp >= 0 ? '+' : '') + r.netBp + ' bp per trade after costs, Sharpe ' + r.sharpe + ', profitable in ' + r.pctYearsPositive + '% of years.',
  };
}

function r19Of(r) {
  const c = r.check;
  const bp = (x) => (x.netBp >= 0 ? '+' : '') + x.netBp + ' bp';
  return {
    id: r.id, verdict: r.verdict, label: VERDICT_TEXT[r.verdict], market: r.marketLabel, tf: r.tf, from: r.from, to: r.to,
    trades: r.trades, sharpe: r.sharpe, tStat: r.tStat, netBp: r.netBp, pctYearsPositive: r.pctYearsPositive, round: 19,
    check: c.status,
    checkText: 'Passed our triple check (round 19): re-tested on ' + c.etf.symbol + '\'s real prices the way the app trades it, ' + bp(r) + ' per trade from 2000, ' + bp(c.since2010) + ' since 2010 and ' + bp(c.cost2x) + ' with costs doubled.',
    text: r.marketLabel + ' daily, ' + r.from + '-' + r.to + ': ' + r.trades.toLocaleString('en-US') + ' trades, ' + bp(r) + ' per trade after costs (t-stat ' + r.tStat + '), profitable in ' + r.pctYearsPositive + '% of years.',
  };
}

// Round 18's triple check, in a sentence
function checkText(r) {
  const c = r.check; if (!c) return null;
  const bp = (x) => (x.netBp >= 0 ? '+' : '') + x.netBp + ' bp';
  if (c.status === 'passed') return 'Passed our triple check: rebuilt from scratch, re-tested on ' + (c.etf ? c.etf.symbol + '\'s real prices' : 'its own prices') + ' with costs doubled, and still positive from 2000 and from 2010.';
  if (c.status === 'condition') return 'Passed our triple check only when entering at the close (a market-on-close order): ' + (c.etf ? c.etf.symbol + ' ' + bp(c.etf.closeEntry) + ' per trade at the close, ' + bp(c.etf.base) + ' at the next open.' : '');
  const why = [];
  if (c.etf && c.etf.base.t < 2) why.push('on ' + c.etf.symbol + '\'s real prices since ' + c.etf.from + ' it made ' + bp(c.etf.base) + ' per trade (t-stat ' + c.etf.base.t + ')');
  if (c.since2010.t < 2) why.push('since 2010 it made ' + bp(c.since2010) + ' per trade (t-stat ' + c.since2010.t + ')');
  if (c.cost2x.t < 2) why.push('with costs doubled it falls to ' + bp(c.cost2x) + ' per trade (t-stat ' + c.cost2x.t + ')');
  return 'Our triple check found it weaker than it looked: ' + why.slice(0, 2).join(', and ') + '. Still positive, but too little to be sure the edge is there.';
}

module.exports = { results, r19, researchFor, MARKET_OF };

}, {"./research-results.json":"core/research-results.json","./research-r19.json":"core/research-r19.json"}],
"core/research-results.json": [function (module, exports, require) {
module.exports = {"generated":"2026-11-24","trials":151,"sr0Annual":0.66,"holdoutFrom":"2020-01-01","risks":[0.0025,0.005,0.01,0.02],"maxDays":365,"step":5,"strategies":[{"id":"noise_momentum|ES|5m_rth","strategy":"noise_momentum","name":"Intraday Momentum","market":"ES","marketLabel":"S&P 500 (MES)","tf":"5m_rth","sizing":"vol","from":2012,"to":2026,"trades":5740,"tradesPerYear":387.2,"winRate":19.7,"grossBp":1.2,"costBp":2.7,"netBp":-1.5,"tStat":-5.33,"sharpe":-1.32,"annReturnPct":-18.3,"maxDdPct":273.8,"pctYearsPositive":27,"isExp":-0.083,"oosExp":-0.004,"oosTrades":2584,"dsr":0,"verdict":"fails","byYear":{"2012":-39.7,"2013":-62.2,"2014":-46.6,"2015":-16.2,"2016":-40.5,"2017":-44.1,"2018":16.4,"2019":-28.5,"2020":2.5,"2021":-4.2,"2022":11.7,"2023":-1.9,"2024":8.7,"2025":-9.5,"2026":-17.6}},{"id":"noise_momentum|NQ|5m_rth","strategy":"noise_momentum","name":"Intraday Momentum","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"5m_rth","sizing":"vol","from":2012,"to":2026,"trades":5685,"tradesPerYear":383.5,"winRate":22.6,"grossBp":2.3,"costBp":1.8,"netBp":0.5,"tStat":0.49,"sharpe":0.12,"annReturnPct":1.7,"maxDdPct":95.3,"pctYearsPositive":47,"isExp":-0.022,"oosExp":0.038,"oosTrades":2533,"dsr":0.02,"verdict":"fails","byYear":{"2012":-25.2,"2013":-19.6,"2014":-22.8,"2015":7.5,"2016":-19.2,"2017":-12.6,"2018":28.8,"2019":-7.4,"2020":24.3,"2021":16.9,"2022":17.7,"2023":-0.5,"2024":37.6,"2025":-6.5,"2026":5.9}},{"id":"orb|ES|5m_rth","strategy":"orb","name":"Opening Range Breakout","market":"ES","marketLabel":"S&P 500 (MES)","tf":"5m_rth","sizing":"risk","from":2012,"to":2026,"trades":3448,"tradesPerYear":232.6,"winRate":14.2,"grossBp":-0.1,"costBp":2.7,"netBp":-2.8,"tStat":-6.75,"sharpe":-1.73,"annReturnPct":-52.1,"maxDdPct":771.8,"pctYearsPositive":7,"isExp":-0.308,"oosExp":-0.129,"oosTrades":1624,"dsr":0,"verdict":"fails","byYear":{"2012":-144.1,"2013":-107.3,"2014":-91.1,"2015":-56.4,"2016":-37.8,"2017":-63.1,"2018":-34.2,"2019":-27.8,"2020":-58.1,"2021":-17.1,"2022":13.7,"2023":-25.9,"2024":-65.7,"2025":-22.2,"2026":-34.7}},{"id":"orb|NQ|5m_rth","strategy":"orb","name":"Opening Range Breakout","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"5m_rth","sizing":"risk","from":2012,"to":2026,"trades":3574,"tradesPerYear":241.1,"winRate":15.9,"grossBp":-0.1,"costBp":1.7,"netBp":-1.8,"tStat":-3.26,"sharpe":-0.84,"annReturnPct":-27.8,"maxDdPct":435.3,"pctYearsPositive":27,"isExp":-0.192,"oosExp":-0.024,"oosTrades":1620,"dsr":0,"verdict":"fails","byYear":{"2012":-148.2,"2013":-24.1,"2014":-87,"2015":-60.4,"2016":12.4,"2017":3.9,"2018":-35.6,"2019":-35.7,"2020":-23.1,"2021":-0.1,"2022":49.2,"2023":-47,"2024":-16.2,"2025":36.5,"2026":-37.4}},{"id":"last_half_hour|ES|5m_rth","strategy":"last_half_hour","name":"Last Half-Hour Momentum","market":"ES","marketLabel":"S&P 500 (MES)","tf":"5m_rth","sizing":"vol","from":2012,"to":2026,"trades":3596,"tradesPerYear":242.6,"winRate":41.9,"grossBp":0.9,"costBp":2.7,"netBp":-1.8,"tStat":-8.91,"sharpe":-2.29,"annReturnPct":-17.4,"maxDdPct":258.9,"pctYearsPositive":13,"isExp":-0.105,"oosExp":-0.032,"oosTrades":1642,"dsr":0,"verdict":"fails","byYear":{"2012":-39.7,"2013":-30.7,"2014":-33.9,"2015":-7.1,"2016":-28,"2017":-47.1,"2018":2.9,"2019":-21.8,"2020":-3.7,"2021":-15.6,"2022":-7.3,"2023":5.2,"2024":-11.4,"2025":-6.4,"2026":-12.8}},{"id":"last_half_hour|NQ|5m_rth","strategy":"last_half_hour","name":"Last Half-Hour Momentum","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"5m_rth","sizing":"vol","from":2012,"to":2026,"trades":3606,"tradesPerYear":243.3,"winRate":46.1,"grossBp":0.9,"costBp":1.7,"netBp":-0.8,"tStat":-4.66,"sharpe":-1.2,"annReturnPct":-8.2,"maxDdPct":124.4,"pctYearsPositive":20,"isExp":-0.059,"oosExp":-0.003,"oosTrades":1629,"dsr":0,"verdict":"fails","byYear":{"2012":-34.6,"2013":-16.3,"2014":-19.3,"2015":-1.2,"2016":-22.4,"2017":-27.8,"2018":14.1,"2019":-9,"2020":6.5,"2021":-1.6,"2022":-1.2,"2023":7.5,"2024":-2.3,"2025":-7.5,"2026":-7.1}},{"id":"gap_fade|ES|5m_rth","strategy":"gap_fade","name":"Opening Gap Fade","market":"ES","marketLabel":"S&P 500 (MES)","tf":"5m_rth","sizing":"risk","from":2012,"to":2026,"trades":2561,"tradesPerYear":172.8,"winRate":49,"grossBp":0.3,"costBp":2.8,"netBp":-2.4,"tStat":-3.99,"sharpe":-1.02,"annReturnPct":-12.6,"maxDdPct":191.2,"pctYearsPositive":20,"isExp":-0.116,"oosExp":-0.018,"oosTrades":1135,"dsr":0,"verdict":"fails","byYear":{"2012":-31.4,"2013":-20.6,"2014":-15.1,"2015":-17,"2016":-18.2,"2017":-37.2,"2018":-12.2,"2019":-13.9,"2020":14,"2021":-13.2,"2022":-14.3,"2023":12.4,"2024":-13.2,"2025":7,"2026":-13.5}},{"id":"gap_fade|NQ|5m_rth","strategy":"gap_fade","name":"Opening Gap Fade","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"5m_rth","sizing":"risk","from":2012,"to":2026,"trades":2464,"tradesPerYear":166.2,"winRate":49.8,"grossBp":0,"costBp":1.8,"netBp":-1.8,"tStat":-2.56,"sharpe":-0.66,"annReturnPct":-8.2,"maxDdPct":142.1,"pctYearsPositive":20,"isExp":-0.081,"oosExp":-0.005,"oosTrades":1038,"dsr":0,"verdict":"fails","byYear":{"2012":-24.4,"2013":-7.2,"2014":-31.4,"2015":-8.5,"2016":-18.5,"2017":-0.6,"2018":-11.6,"2019":-13.5,"2020":5.5,"2021":-5.1,"2022":-15.1,"2023":-2.7,"2024":-4.9,"2025":12.8,"2026":4.2}},{"id":"orb30|ES|5m_rth","strategy":"orb30","name":"30-Minute Opening Range Breakout","market":"ES","marketLabel":"S&P 500 (MES)","tf":"5m_rth","sizing":"risk","from":2012,"to":2026,"trades":3719,"tradesPerYear":250.9,"winRate":33.8,"grossBp":-0.5,"costBp":2.7,"netBp":-3.2,"tStat":-3.39,"sharpe":-0.87,"annReturnPct":-22.8,"maxDdPct":377.8,"pctYearsPositive":33,"isExp":-0.164,"oosExp":-0.003,"oosTrades":1695,"dsr":0,"verdict":"fails","byYear":{"2012":-68.1,"2013":-86.5,"2014":-72.8,"2015":-8.7,"2016":-49.1,"2017":-59.7,"2018":23.1,"2019":-11.1,"2020":-31.7,"2021":0.5,"2022":50.1,"2023":15,"2024":-27.2,"2025":-19.1,"2026":7.6}},{"id":"orb30|NQ|5m_rth","strategy":"orb30","name":"30-Minute Opening Range Breakout","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"5m_rth","sizing":"risk","from":2012,"to":2026,"trades":3708,"tradesPerYear":250.1,"winRate":34.7,"grossBp":1.2,"costBp":1.7,"netBp":-0.6,"tStat":0.6,"sharpe":0.15,"annReturnPct":4.6,"maxDdPct":126.6,"pctYearsPositive":53,"isExp":-0.042,"oosExp":0.091,"oosTrades":1679,"dsr":0.02,"verdict":"fails","byYear":{"2012":-39.9,"2013":-39.7,"2014":-2.8,"2015":-8,"2016":1.3,"2017":-27.8,"2018":41.8,"2019":-9.5,"2020":-4.9,"2021":38.1,"2022":66.9,"2023":1.3,"2024":32.4,"2025":17.6,"2026":0.7}},{"id":"turtle|ES|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3573,"tradesPerYear":241,"winRate":33.6,"grossBp":-1.6,"costBp":2.8,"netBp":-4.3,"tStat":-4.52,"sharpe":-1.18,"annReturnPct":-23.7,"maxDdPct":351.9,"pctYearsPositive":27,"isExp":-0.134,"oosExp":-0.056,"oosTrades":1630,"dsr":0,"verdict":"fails","byYear":{"2012":-54.5,"2013":-55.7,"2014":-56.5,"2015":-16.5,"2016":-35.4,"2017":-54,"2018":26.7,"2019":-14.8,"2020":-23.4,"2021":7.7,"2022":18.2,"2023":-26.9,"2024":19.2,"2025":-44.7,"2026":-40.5}},{"id":"turtle|ES|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"ES","marketLabel":"S&P 500 (MES)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":888,"tradesPerYear":59.9,"winRate":32.4,"grossBp":-4.2,"costBp":2.7,"netBp":-6.9,"tStat":-2.01,"sharpe":-0.51,"annReturnPct":-4.8,"maxDdPct":75,"pctYearsPositive":33,"isExp":-0.107,"oosExp":-0.051,"oosTrades":417,"dsr":0,"verdict":"fails","byYear":{"2012":-4.4,"2013":-1.9,"2014":-3,"2015":-11.9,"2016":-18,"2017":-23.3,"2018":15.9,"2019":-3.8,"2020":5.5,"2021":-10.2,"2022":5.9,"2023":4.2,"2024":1.3,"2025":-12.1,"2026":-16}},{"id":"turtle|ES|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"risk","from":1990,"to":2026,"trades":366,"tradesPerYear":9.9,"winRate":37.4,"grossBp":8.8,"costBp":7.2,"netBp":1.6,"tStat":-0.02,"sharpe":0,"annReturnPct":0,"maxDdPct":25.4,"pctYearsPositive":43,"isExp":-0.035,"oosExp":0.149,"oosTrades":66,"dsr":0,"verdict":"fails","byYear":{"1990":-3,"1991":-5,"1992":-5.9,"1993":-7.5,"1994":-3.1,"1995":7.4,"1996":0.9,"1997":6.4,"1998":5,"1999":-6,"2000":-6.8,"2001":4.9,"2002":4.1,"2003":-1.9,"2004":2.2,"2005":-2,"2006":-5.6,"2007":-1.7,"2008":5.6,"2009":-1.2,"2010":3.6,"2011":-0.3,"2012":0.8,"2013":-2,"2014":-3.2,"2015":-6.1,"2016":0.6,"2017":-1.5,"2018":7.4,"2019":1.7,"2020":6.3,"2021":-1.9,"2022":3.3,"2023":-0.5,"2024":6.6,"2025":-1.9,"2026":-0.3}},{"id":"turtle|NQ|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3590,"tradesPerYear":242.2,"winRate":35.3,"grossBp":0.9,"costBp":1.8,"netBp":-0.9,"tStat":-0.45,"sharpe":-0.12,"annReturnPct":-2.5,"maxDdPct":109,"pctYearsPositive":40,"isExp":-0.043,"oosExp":0.03,"oosTrades":1592,"dsr":0,"verdict":"fails","byYear":{"2012":-3.3,"2013":-47.3,"2014":-37.4,"2015":2.5,"2016":-0.3,"2017":-16.5,"2018":26,"2019":-9.4,"2020":17.4,"2021":28.9,"2022":8.4,"2023":-16.2,"2024":44.7,"2025":-17.3,"2026":-17.5}},{"id":"turtle|NQ|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":881,"tradesPerYear":59.4,"winRate":36.3,"grossBp":-4.1,"costBp":1.7,"netBp":-5.8,"tStat":-0.48,"sharpe":-0.12,"annReturnPct":-1.2,"maxDdPct":29.8,"pctYearsPositive":53,"isExp":-0.03,"oosExp":-0.008,"oosTrades":411,"dsr":0,"verdict":"fails","byYear":{"2012":3.2,"2013":-9.3,"2014":-7.9,"2015":0.1,"2016":-6.1,"2017":0.2,"2018":9.6,"2019":-4,"2020":3.5,"2021":2.3,"2022":0.8,"2023":-2,"2024":1.4,"2025":-1.5,"2026":-8}},{"id":"turtle|NQ|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"risk","from":1990,"to":2026,"trades":366,"tradesPerYear":9.9,"winRate":35.8,"grossBp":5.9,"costBp":9.4,"netBp":-3.5,"tStat":-0.12,"sharpe":-0.02,"annReturnPct":-0.1,"maxDdPct":25.3,"pctYearsPositive":51,"isExp":-0.035,"oosExp":0.117,"oosTrades":64,"dsr":0,"verdict":"fails","byYear":{"1990":6.3,"1991":-3.1,"1992":0.2,"1993":-2.8,"1994":-5.7,"1995":-1.8,"1996":0.4,"1997":3.7,"1998":-0.4,"1999":1.1,"2000":0.4,"2001":2,"2002":3.3,"2003":-3.8,"2004":-2.3,"2005":2.9,"2006":-1.6,"2007":-7.4,"2008":6.8,"2009":-3.4,"2010":2.4,"2011":-1.7,"2012":2.6,"2013":-5.3,"2014":-0.6,"2015":-3.2,"2016":-3.4,"2017":1.8,"2018":-0.7,"2019":-0.5,"2020":3.7,"2021":1.7,"2022":0.8,"2023":5.4,"2024":2,"2025":-3.4,"2026":0.1}},{"id":"turtle|GC|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"GC","marketLabel":"Gold (MGC)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3154,"tradesPerYear":212.7,"winRate":34.4,"grossBp":2.7,"costBp":2.4,"netBp":0.3,"tStat":0.51,"sharpe":0.13,"annReturnPct":3,"maxDdPct":82.8,"pctYearsPositive":53,"isExp":0.003,"oosExp":0.027,"oosTrades":1425,"dsr":0.02,"verdict":"fails","byYear":{"2012":14.3,"2013":26.6,"2014":9.9,"2015":-5.1,"2016":-14.3,"2017":3.7,"2018":-34.9,"2019":5.7,"2020":29.8,"2021":-16.1,"2022":-15.3,"2023":-0.7,"2024":-2.2,"2025":21,"2026":21.6}},{"id":"turtle|GC|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"GC","marketLabel":"Gold (MGC)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":813,"tradesPerYear":54.8,"winRate":35.9,"grossBp":5.9,"costBp":2.4,"netBp":3.5,"tStat":1.05,"sharpe":0.27,"annReturnPct":3,"maxDdPct":40.3,"pctYearsPositive":53,"isExp":0.052,"oosExp":0.059,"oosTrades":375,"dsr":0.05,"verdict":"fails","byYear":{"2012":-5.7,"2013":15.4,"2014":4.2,"2015":-7.4,"2016":12.1,"2017":-3,"2018":-4.9,"2019":3.5,"2020":21.1,"2021":-5.8,"2022":-15.1,"2023":-2.2,"2024":7.4,"2025":18.7,"2026":6.8}},{"id":"turtle|GC|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"GC","marketLabel":"Gold (MGC)","tf":"1d","sizing":"risk","from":2001,"to":2026,"trades":211,"tradesPerYear":8.2,"winRate":33.2,"grossBp":6,"costBp":4.1,"netBp":1.9,"tStat":0.92,"sharpe":0.19,"annReturnPct":0.8,"maxDdPct":17.7,"pctYearsPositive":62,"isExp":0.134,"oosExp":-0.003,"oosTrades":59,"dsr":0.01,"verdict":"fails","byYear":{"2001":1.1,"2002":0.7,"2003":5.8,"2004":-0.1,"2005":-7.7,"2006":-0.8,"2007":1.2,"2008":2.7,"2009":2.2,"2010":0.6,"2011":4.1,"2012":2.6,"2013":-2.5,"2014":-1.1,"2015":-0.5,"2016":2,"2017":-1.3,"2018":2.9,"2019":6.4,"2020":-1.9,"2021":-0.8,"2022":-0.5,"2023":1.1,"2024":1,"2025":2.3,"2026":0.7}},{"id":"turtle|CL|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1h","sizing":"risk","from":2012,"to":2023,"trades":2804,"tradesPerYear":235.4,"winRate":34.7,"grossBp":4.5,"costBp":6,"netBp":-1.5,"tStat":-1.1,"sharpe":-0.32,"annReturnPct":-6.8,"maxDdPct":89.4,"pctYearsPositive":25,"isExp":-0.042,"oosExp":0.001,"oosTrades":860,"dsr":0,"verdict":"fails","byYear":{"2012":-15.7,"2013":-6,"2014":15.3,"2015":-25.2,"2016":21.1,"2017":-19.5,"2018":-11.4,"2019":-39.7,"2020":24.3,"2021":-8.9,"2022":-9.8,"2023":-5}},{"id":"turtle|CL|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"CL","marketLabel":"Crude oil (MCL)","tf":"4h","sizing":"risk","from":2012,"to":2023,"trades":667,"tradesPerYear":56,"winRate":36.1,"grossBp":15.9,"costBp":6,"netBp":9.9,"tStat":0.55,"sharpe":0.16,"annReturnPct":1.6,"maxDdPct":23.7,"pctYearsPositive":58,"isExp":0.05,"oosExp":-0.016,"oosTrades":222,"dsr":0.04,"verdict":"fails","byYear":{"2012":-8.8,"2013":6.4,"2014":20.9,"2015":0.6,"2016":6.6,"2017":-5.7,"2018":8.7,"2019":-6.6,"2020":9.8,"2021":-5.1,"2022":-8.2,"2023":0}},{"id":"turtle|CL|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1d","sizing":"risk","from":2012,"to":2023,"trades":105,"tradesPerYear":8.8,"winRate":42.9,"grossBp":175.8,"costBp":6,"netBp":169.8,"tStat":1.55,"sharpe":0.44,"annReturnPct":2.7,"maxDdPct":5.1,"pctYearsPositive":58,"isExp":0.253,"oosExp":0.454,"oosTrades":30,"dsr":0.13,"verdict":"mixed","byYear":{"2012":1.4,"2013":-1.6,"2014":-1.9,"2015":17.9,"2016":0.4,"2017":-0.5,"2018":-0.3,"2019":3.1,"2020":8.8,"2021":5.7,"2022":2.7,"2023":-3},"financing":{"nights":25.6,"finBp":16.4,"netAfterBp":153.4,"crypto20AfterBp":null}},{"id":"turtle|EURUSD|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"EURUSD","marketLabel":"EUR/USD","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3510,"tradesPerYear":236.7,"winRate":33.9,"grossBp":-0.6,"costBp":0.7,"netBp":-1.3,"tStat":-1.95,"sharpe":-0.49,"annReturnPct":-10.2,"maxDdPct":164.6,"pctYearsPositive":27,"isExp":-0.013,"oosExp":-0.078,"oosTrades":1632,"dsr":0,"verdict":"fails","byYear":{"2012":5.5,"2013":-30.8,"2014":-7.4,"2015":13.7,"2016":-8,"2017":12.8,"2018":5.6,"2019":-15.7,"2020":-23.1,"2021":-22.2,"2022":-14.1,"2023":-1.5,"2024":-31.1,"2025":-10.7,"2026":-24.6}},{"id":"turtle|EURUSD|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"EURUSD","marketLabel":"EUR/USD","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":862,"tradesPerYear":58.1,"winRate":34.1,"grossBp":-2.3,"costBp":0.7,"netBp":-3,"tStat":-0.68,"sharpe":-0.17,"annReturnPct":-1.7,"maxDdPct":49.3,"pctYearsPositive":40,"isExp":-0.029,"oosExp":-0.03,"oosTrades":391,"dsr":0,"verdict":"fails","byYear":{"2012":6.6,"2013":-7,"2014":-5.5,"2015":7.8,"2016":-11.6,"2017":-12.1,"2018":-0.7,"2019":5.1,"2020":14.4,"2021":-11.4,"2022":8.6,"2023":-18.6,"2024":-8.3,"2025":-1,"2026":8.1}},{"id":"turtle|EURUSD|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"EURUSD","marketLabel":"EUR/USD","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":186,"tradesPerYear":8.5,"winRate":30.1,"grossBp":-4.1,"costBp":0.7,"netBp":-4.8,"tStat":-0.51,"sharpe":-0.11,"annReturnPct":-0.4,"maxDdPct":24.3,"pctYearsPositive":43,"isExp":0.001,"oosExp":-0.147,"oosTrades":57,"dsr":0,"verdict":"fails","byYear":{"2004":1.1,"2005":-0.6,"2006":0,"2007":1.3,"2008":-5.4,"2009":-0.1,"2010":7.2,"2011":-0.7,"2012":2,"2013":-2.2,"2014":4.8,"2015":4.3,"2016":-2.3,"2017":-0.8,"2018":-0.3,"2019":-8.1,"2020":-1.9,"2021":0.8,"2022":-4.2,"2023":0.4,"2024":-4.8,"2025":-0.1,"2026":1.4}},{"id":"turtle|GBPUSD|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3507,"tradesPerYear":236.5,"winRate":35,"grossBp":0.5,"costBp":0.9,"netBp":-0.4,"tStat":-0.68,"sharpe":-0.17,"annReturnPct":-3.5,"maxDdPct":115.3,"pctYearsPositive":33,"isExp":0.018,"oosExp":-0.053,"oosTrades":1633,"dsr":0,"verdict":"fails","byYear":{"2012":-13.3,"2013":29.9,"2014":-4.3,"2015":9.3,"2016":27.9,"2017":-8.7,"2018":-19.1,"2019":10.5,"2020":3.9,"2021":-3.3,"2022":-25,"2023":-23.5,"2024":-29.5,"2025":-0.9,"2026":-6.4}},{"id":"turtle|GBPUSD|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"GBPUSD","marketLabel":"GBP/USD","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":867,"tradesPerYear":58.5,"winRate":34.4,"grossBp":1.9,"costBp":0.9,"netBp":1,"tStat":0.39,"sharpe":0.09,"annReturnPct":1,"maxDdPct":47,"pctYearsPositive":47,"isExp":0.082,"oosExp":-0.057,"oosTrades":402,"dsr":0.01,"verdict":"fails","byYear":{"2012":-8.9,"2013":2.6,"2014":-0.2,"2015":13,"2016":19.6,"2017":-5.3,"2018":9,"2019":8,"2020":7,"2021":-9.2,"2022":3.9,"2023":-17.6,"2024":-2.8,"2025":-1,"2026":-2.8}},{"id":"turtle|GBPUSD|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":187,"tradesPerYear":8.5,"winRate":33.7,"grossBp":-21.1,"costBp":0.9,"netBp":-22,"tStat":-1.11,"sharpe":-0.23,"annReturnPct":-0.7,"maxDdPct":22.2,"pctYearsPositive":39,"isExp":-0.06,"oosExp":-0.154,"oosTrades":53,"dsr":0,"verdict":"fails","byYear":{"2004":-2.2,"2005":1.4,"2006":1.4,"2007":-2.3,"2008":6.1,"2009":-8.3,"2010":2.9,"2011":-2.7,"2012":0.1,"2013":2.8,"2014":-1.2,"2015":0.1,"2016":-0.6,"2017":-0.4,"2018":-1.6,"2019":-3.7,"2020":-3,"2021":-2.1,"2022":2.8,"2023":1,"2024":-3.6,"2025":-2,"2026":-1.3}},{"id":"turtle|USDJPY|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"USDJPY","marketLabel":"USD/JPY","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3238,"tradesPerYear":218.4,"winRate":35.3,"grossBp":2.3,"costBp":0.6,"netBp":1.7,"tStat":2.67,"sharpe":0.67,"annReturnPct":15.7,"maxDdPct":48.9,"pctYearsPositive":73,"isExp":0.046,"oosExp":0.102,"oosTrades":1483,"dsr":0.51,"verdict":"holds","byYear":{"2012":16.5,"2013":30.9,"2014":24,"2015":3.3,"2016":42.9,"2017":-9.3,"2018":-10.4,"2019":-17.6,"2020":35.6,"2021":27,"2022":51.3,"2023":3.2,"2024":29.3,"2025":20,"2026":-14.6},"robust":{"variants":7,"positive":7,"strong":3,"medianSharpe":0.45,"worstSharpe":0.21,"bestSharpe":0.71,"windows":11,"negWindows":0,"worstWindow":{"from":2015,"to":2019,"sharpe":0.08},"net2x":1.1,"net3x":0.5,"baseLabel":"20/10"},"check":{"status":"weaker","staleOpenPct":22,"sameTrades":3238,"researchTrades":3238,"since2000":{"trades":3238,"netBp":1.7,"t":2.25,"yearsUp":67},"since2010":{"trades":3238,"netBp":1.7,"t":2.25,"yearsUp":67},"since2023":{"trades":843,"netBp":1,"t":0.64,"yearsUp":50},"closeEntry":{"trades":3137,"netBp":1.6,"t":2.14,"yearsUp":67},"cost2x":{"trades":3244,"netBp":1.1,"t":1.43,"yearsUp":67},"etf":null},"financing":{"nights":1,"finBp":0.2,"netAfterBp":1.5,"crypto20AfterBp":null}},{"id":"turtle|USDJPY|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"USDJPY","marketLabel":"USD/JPY","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":857,"tradesPerYear":57.8,"winRate":35.5,"grossBp":4.2,"costBp":0.6,"netBp":3.6,"tStat":1.4,"sharpe":0.34,"annReturnPct":4.1,"maxDdPct":23.9,"pctYearsPositive":67,"isExp":0.068,"oosExp":0.072,"oosTrades":397,"dsr":0.09,"verdict":"fails","byYear":{"2012":5.6,"2013":-3.8,"2014":15.4,"2015":-9.9,"2016":23.8,"2017":0.5,"2018":2.7,"2019":-6,"2020":8.1,"2021":3.4,"2022":28.5,"2023":-9,"2024":8.5,"2025":-10.8,"2026":3.2}},{"id":"turtle|USDJPY|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"USDJPY","marketLabel":"USD/JPY","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":171,"tradesPerYear":7.8,"winRate":35.7,"grossBp":-6.7,"costBp":0.6,"netBp":-7.3,"tStat":0.55,"sharpe":0.11,"annReturnPct":0.4,"maxDdPct":18.8,"pctYearsPositive":52,"isExp":0.002,"oosExp":0.245,"oosTrades":39,"dsr":0,"verdict":"fails","byYear":{"2004":0.3,"2005":2.6,"2006":-6.1,"2007":2.1,"2008":-7,"2009":-1.5,"2010":-1.8,"2011":-4.3,"2012":2.2,"2013":4.1,"2014":6.8,"2015":-0.6,"2016":2.1,"2017":-1.3,"2018":-0.2,"2019":2.7,"2020":-1,"2021":4.6,"2022":5.6,"2023":0.6,"2024":7.8,"2025":-3.6,"2026":-4.4}},{"id":"turtle|BTC|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"BTC","marketLabel":"Bitcoin","tf":"1h","sizing":"risk","from":2018,"to":2026,"trades":1306,"tradesPerYear":164.3,"winRate":19.2,"grossBp":19.2,"costBp":124.1,"netBp":-104.9,"tStat":-12.92,"sharpe":-3.41,"annReturnPct":-111.3,"maxDdPct":985.3,"pctYearsPositive":0,"isExp":-0.424,"oosExp":-0.831,"oosTrades":1054,"dsr":0,"verdict":"fails","byYear":{"2018":-90.7,"2019":-16.3,"2020":-79.6,"2021":-68.7,"2022":-112.1,"2023":-149.5,"2024":-100.3,"2025":-228.9,"2026":-137.3}},{"id":"turtle|BTC|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"BTC","marketLabel":"Bitcoin","tf":"4h","sizing":"risk","from":2018,"to":2026,"trades":330,"tradesPerYear":41.5,"winRate":29.4,"grossBp":76.6,"costBp":124.4,"netBp":-47.9,"tStat":0.01,"sharpe":0,"annReturnPct":0.1,"maxDdPct":48.8,"pctYearsPositive":44,"isExp":0.305,"oosExp":-0.073,"oosTrades":265,"dsr":0.01,"verdict":"fails","byYear":{"2018":-7.1,"2019":26.9,"2020":13.1,"2021":-2,"2022":-16.6,"2023":12.2,"2024":7.2,"2025":-23.4,"2026":-9.9}},{"id":"turtle|BTC|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"BTC","marketLabel":"Bitcoin","tf":"1d","sizing":"risk","from":2014,"to":2026,"trades":74,"tradesPerYear":6.1,"winRate":48.6,"grossBp":1037.9,"costBp":130.4,"netBp":907.5,"tStat":3.15,"sharpe":0.71,"annReturnPct":10.9,"maxDdPct":6,"pctYearsPositive":62,"isExp":3.042,"oosExp":1.021,"oosTrades":46,"dsr":0.66,"verdict":"holds","byYear":{"2014":-1.1,"2015":5.5,"2016":10.2,"2017":51.9,"2018":-2.9,"2019":21.6,"2020":18.9,"2021":7.5,"2022":-3.9,"2023":19.1,"2024":9.3,"2025":-2.1,"2026":-1.8},"robust":{"variants":7,"positive":7,"strong":7,"medianSharpe":0.58,"worstSharpe":0.48,"bestSharpe":0.8,"windows":9,"negWindows":0,"worstWindow":{"from":2022,"to":2026,"sharpe":0.45},"net2x":777.1,"net3x":646.7,"baseLabel":"20/10"},"check":{"status":"passed","staleOpenPct":2,"sameTrades":74,"researchTrades":74,"since2000":{"trades":74,"netBp":907.5,"t":3.13,"yearsUp":62},"since2010":{"trades":74,"netBp":907.5,"t":3.13,"yearsUp":62},"since2023":{"trades":27,"netBp":408.1,"t":1.29,"yearsUp":50},"closeEntry":{"trades":74,"netBp":904.6,"t":3.12,"yearsUp":62},"cost2x":{"trades":74,"netBp":777.4,"t":2.7,"yearsUp":62},"etf":null},"financing":{"nights":21.7,"finBp":59.6,"netAfterBp":847.9,"crypto20AfterBp":788.3}},{"id":"turtle|ETH|1h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"ETH","marketLabel":"Ethereum","tf":"1h","sizing":"risk","from":2018,"to":2026,"trades":1305,"tradesPerYear":164.2,"winRate":22.7,"grossBp":23.7,"costBp":124.1,"netBp":-100.4,"tStat":-10.85,"sharpe":-2.93,"annReturnPct":-80.9,"maxDdPct":715.6,"pctYearsPositive":0,"isExp":-0.423,"oosExp":-0.579,"oosTrades":1044,"dsr":0,"verdict":"fails","byYear":{"2018":-72.8,"2019":-37.6,"2020":-16.9,"2021":-28.5,"2022":-90.8,"2023":-183.8,"2024":-119.3,"2025":-84.9,"2026":-80}},{"id":"turtle|ETH|4h","strategy":"turtle","name":"Turtle Breakout 20/10","market":"ETH","marketLabel":"Ethereum","tf":"4h","sizing":"risk","from":2018,"to":2026,"trades":339,"tradesPerYear":42.6,"winRate":28.6,"grossBp":98,"costBp":124.6,"netBp":-26.6,"tStat":0.47,"sharpe":0.13,"annReturnPct":2.2,"maxDdPct":50.1,"pctYearsPositive":33,"isExp":0.202,"oosExp":0.024,"oosTrades":277,"dsr":0.02,"verdict":"fails","byYear":{"2018":2.3,"2019":10.2,"2020":35.7,"2021":-0.6,"2022":-7,"2023":-2.5,"2024":-13.5,"2025":-1.9,"2026":-3.5}},{"id":"turtle|ETH|1d","strategy":"turtle","name":"Turtle Breakout 20/10","market":"ETH","marketLabel":"Ethereum","tf":"1d","sizing":"risk","from":2017,"to":2026,"trades":52,"tradesPerYear":5.8,"winRate":50,"grossBp":966.2,"costBp":130,"netBp":836.2,"tStat":2.29,"sharpe":0.61,"annReturnPct":5.2,"maxDdPct":6.3,"pctYearsPositive":60,"isExp":0.096,"oosExp":1.094,"oosTrades":42,"dsr":0.39,"verdict":"mixed","byYear":{"2017":-1.1,"2018":1.1,"2019":1,"2020":18.4,"2021":22.2,"2022":-0.3,"2023":5.6,"2024":3.4,"2025":-0.5,"2026":-2.9},"financing":{"nights":19.2,"finBp":52.7,"netAfterBp":783.5,"crypto20AfterBp":730.8}},{"id":"donchian55|ES|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":1685,"tradesPerYear":113.7,"winRate":30.8,"grossBp":-1.8,"costBp":2.7,"netBp":-4.6,"tStat":-2.39,"sharpe":-0.61,"annReturnPct":-10.5,"maxDdPct":154.9,"pctYearsPositive":20,"isExp":-0.1,"oosExp":-0.082,"oosTrades":780,"dsr":0,"verdict":"fails","byYear":{"2012":-12.7,"2013":-4.7,"2014":-17.9,"2015":-25,"2016":-29.9,"2017":-22.9,"2018":30.8,"2019":-8.4,"2020":-9.9,"2021":-9.8,"2022":9.8,"2023":-10.8,"2024":12.4,"2025":-32.5,"2026":-23.4}},{"id":"donchian55|ES|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"ES","marketLabel":"S&P 500 (MES)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":451,"tradesPerYear":30.4,"winRate":29.9,"grossBp":-5,"costBp":2.7,"netBp":-7.7,"tStat":-1.39,"sharpe":-0.36,"annReturnPct":-3,"maxDdPct":50.9,"pctYearsPositive":33,"isExp":-0.126,"oosExp":-0.069,"oosTrades":214,"dsr":0,"verdict":"fails","byYear":{"2012":-14.6,"2013":-3.1,"2014":-3,"2015":-8.9,"2016":-13.6,"2017":-0.5,"2018":14.8,"2019":-1,"2020":5.8,"2021":-11.2,"2022":3.5,"2023":6.8,"2024":4.5,"2025":-6.1,"2026":-18}},{"id":"donchian55|ES|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"risk","from":1990,"to":2026,"trades":173,"tradesPerYear":4.7,"winRate":34.7,"grossBp":45.3,"costBp":6.4,"netBp":38.9,"tStat":1.07,"sharpe":0.18,"annReturnPct":0.8,"maxDdPct":12.5,"pctYearsPositive":57,"isExp":0.205,"oosExp":0,"oosTrades":36,"dsr":0,"verdict":"fails","byYear":{"1990":3.3,"1991":2,"1992":-3,"1993":-3.2,"1994":-1.8,"1995":14.3,"1996":4.1,"1997":0.2,"1998":0.7,"1999":2.3,"2000":-4.8,"2001":2.1,"2002":1.6,"2003":-1.2,"2004":-1.1,"2005":-2,"2006":-5.1,"2007":0.9,"2008":2.6,"2009":-0.5,"2010":2.7,"2011":3,"2012":1.9,"2013":1.2,"2014":-3.1,"2015":-4.8,"2016":-2,"2017":3.4,"2018":8.3,"2019":3.2,"2020":4.4,"2021":2.2,"2022":-3.3,"2023":-0.7,"2024":5.5,"2025":-2.2,"2026":-3}},{"id":"donchian55|NQ|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":1668,"tradesPerYear":112.5,"winRate":32.4,"grossBp":0.1,"costBp":1.7,"netBp":-1.6,"tStat":0.59,"sharpe":0.15,"annReturnPct":2.8,"maxDdPct":44.3,"pctYearsPositive":47,"isExp":0.037,"oosExp":0.01,"oosTrades":766,"dsr":0.02,"verdict":"fails","byYear":{"2012":16.7,"2013":-11.4,"2014":-4,"2015":17.1,"2016":-16.4,"2017":11.7,"2018":25.7,"2019":-6,"2020":-8.9,"2021":10.4,"2022":7.2,"2023":-8.5,"2024":38.4,"2025":-24.9,"2026":-5.6}},{"id":"donchian55|NQ|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":436,"tradesPerYear":29.4,"winRate":32.1,"grossBp":-2.7,"costBp":1.8,"netBp":-4.5,"tStat":-0.06,"sharpe":-0.02,"annReturnPct":-0.1,"maxDdPct":50.2,"pctYearsPositive":53,"isExp":-0.094,"oosExp":0.114,"oosTrades":188,"dsr":0,"verdict":"fails","byYear":{"2012":-7.9,"2013":-5.7,"2014":-12.3,"2015":-7.7,"2016":-6.4,"2017":5.8,"2018":4.5,"2019":6.3,"2020":5.2,"2021":2.2,"2022":-3.9,"2023":17.2,"2024":2.8,"2025":-2.7,"2026":0.7}},{"id":"donchian55|NQ|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"risk","from":1990,"to":2026,"trades":175,"tradesPerYear":4.7,"winRate":34.3,"grossBp":110.6,"costBp":9.7,"netBp":100.9,"tStat":1.93,"sharpe":0.32,"annReturnPct":1.5,"maxDdPct":11.1,"pctYearsPositive":65,"isExp":0.306,"oosExp":0.389,"oosTrades":29,"dsr":0.01,"verdict":"mixed","byYear":{"1990":5.7,"1991":1.2,"1992":2,"1993":-2.9,"1994":-3.7,"1995":10.2,"1996":-1.9,"1997":9.3,"1998":1.2,"1999":1.1,"2000":4.4,"2001":0.8,"2002":0.9,"2003":0.3,"2004":-4.7,"2005":0.3,"2006":4.4,"2007":-0.8,"2008":2.6,"2009":8.4,"2010":0,"2011":-0.2,"2012":4,"2013":-1.5,"2014":5.2,"2015":-4.4,"2016":-2,"2017":2.8,"2018":-1.7,"2019":-0.3,"2020":7.1,"2021":1.4,"2022":1.5,"2023":1.9,"2024":3.9,"2025":1.2,"2026":-1.7},"financing":{"nights":40.9,"finBp":39.1,"netAfterBp":61.8,"crypto20AfterBp":null}},{"id":"donchian55|GC|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"GC","marketLabel":"Gold (MGC)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":1484,"tradesPerYear":100.1,"winRate":32.8,"grossBp":5.2,"costBp":2.4,"netBp":2.8,"tStat":1.56,"sharpe":0.4,"annReturnPct":8.5,"maxDdPct":77.5,"pctYearsPositive":60,"isExp":0.095,"oosExp":0.074,"oosTrades":673,"dsr":0.13,"verdict":"mixed","byYear":{"2012":-12.6,"2013":36,"2014":19.2,"2015":3.8,"2016":4.1,"2017":-0.2,"2018":-7.8,"2019":12.5,"2020":65,"2021":-9.5,"2022":-25,"2023":-2.2,"2024":5.1,"2025":26.8,"2026":11.3},"financing":{"nights":1.5,"finBp":1.2,"netAfterBp":1.6,"crypto20AfterBp":null}},{"id":"donchian55|GC|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"GC","marketLabel":"Gold (MGC)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":390,"tradesPerYear":26.3,"winRate":32.6,"grossBp":9.1,"costBp":2.4,"netBp":6.7,"tStat":1.76,"sharpe":0.45,"annReturnPct":4.9,"maxDdPct":22.3,"pctYearsPositive":67,"isExp":0.166,"oosExp":0.212,"oosTrades":181,"dsr":0.17,"verdict":"mixed","byYear":{"2012":-3.8,"2013":11.7,"2014":-7.7,"2015":3.6,"2016":11.9,"2017":10.8,"2018":2.2,"2019":-1.6,"2020":16.2,"2021":-11,"2022":-1.8,"2023":14.7,"2024":1.4,"2025":25.3,"2026":1.2},"financing":{"nights":6.4,"finBp":5.3,"netAfterBp":1.4,"crypto20AfterBp":null}},{"id":"donchian55|GC|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"GC","marketLabel":"Gold (MGC)","tf":"1d","sizing":"risk","from":2001,"to":2026,"trades":93,"tradesPerYear":3.6,"winRate":34.4,"grossBp":94.7,"costBp":4,"netBp":90.7,"tStat":1.73,"sharpe":0.36,"annReturnPct":1.9,"maxDdPct":10.4,"pctYearsPositive":54,"isExp":0.5,"oosExp":0.608,"oosTrades":24,"dsr":0.03,"verdict":"mixed","byYear":{"2001":-2.5,"2002":-0.1,"2003":1.9,"2004":0.3,"2005":-2.8,"2006":9.2,"2007":-2.2,"2008":13.2,"2009":4,"2010":-0.5,"2011":6.5,"2012":-1,"2013":5.2,"2014":-2.7,"2015":-1.9,"2016":0.7,"2017":-3.5,"2018":3.8,"2019":4.5,"2020":3.2,"2021":-1.8,"2022":-1.9,"2023":-3.3,"2024":3.5,"2025":6,"2026":11.1},"financing":{"nights":44.5,"finBp":46.1,"netAfterBp":44.6,"crypto20AfterBp":null}},{"id":"donchian55|CL|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1h","sizing":"risk","from":2012,"to":2023,"trades":1266,"tradesPerYear":106.3,"winRate":32,"grossBp":8.3,"costBp":6,"netBp":2.3,"tStat":0.7,"sharpe":0.2,"annReturnPct":3.8,"maxDdPct":41.5,"pctYearsPositive":50,"isExp":0.063,"oosExp":-0.02,"oosTrades":414,"dsr":0.05,"verdict":"fails","byYear":{"2012":-1.9,"2013":22.6,"2014":27.1,"2015":-14.2,"2016":9.5,"2017":12.9,"2018":2.9,"2019":-5.7,"2020":14.6,"2021":-2.4,"2022":-11,"2023":-9.3}},{"id":"donchian55|CL|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"CL","marketLabel":"Crude oil (MCL)","tf":"4h","sizing":"risk","from":2012,"to":2023,"trades":322,"tradesPerYear":27,"winRate":32.9,"grossBp":23.1,"costBp":6,"netBp":17.1,"tStat":1.37,"sharpe":0.39,"annReturnPct":4.7,"maxDdPct":37.6,"pctYearsPositive":67,"isExp":0.314,"oosExp":-0.066,"oosTrades":120,"dsr":0.13,"verdict":"fails","byYear":{"2012":2.5,"2013":8.2,"2014":8.2,"2015":22.3,"2016":2.5,"2017":1.9,"2018":25.6,"2019":-7.8,"2020":20.8,"2021":-7.7,"2022":-17.9,"2023":-3.2}},{"id":"donchian55|CL|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1d","sizing":"risk","from":2012,"to":2023,"trades":51,"tradesPerYear":4.3,"winRate":41.2,"grossBp":163.8,"costBp":6,"netBp":157.8,"tStat":1.15,"sharpe":0.33,"annReturnPct":1.9,"maxDdPct":6.9,"pctYearsPositive":58,"isExp":0.512,"oosExp":0.344,"oosTrades":18,"dsr":0.05,"verdict":"fails","byYear":{"2012":2,"2013":-1,"2014":-2,"2015":15.9,"2016":0.3,"2017":-3.3,"2018":3.2,"2019":2.4,"2020":7.3,"2021":3,"2022":-2.3,"2023":-2.5}},{"id":"donchian55|EURUSD|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"EURUSD","marketLabel":"EUR/USD","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":1676,"tradesPerYear":113,"winRate":28.9,"grossBp":-2.2,"costBp":0.7,"netBp":-2.9,"tStat":-2.69,"sharpe":-0.66,"annReturnPct":-11.6,"maxDdPct":175.5,"pctYearsPositive":27,"isExp":-0.043,"oosExp":-0.167,"oosTrades":797,"dsr":0,"verdict":"fails","byYear":{"2012":-0.8,"2013":-27.5,"2014":-20.9,"2015":12.4,"2016":-19.1,"2017":-20.2,"2018":16,"2019":13.1,"2020":-8,"2021":-12.8,"2022":1.8,"2023":-33.9,"2024":-38.2,"2025":-16.4,"2026":-16.8}},{"id":"donchian55|EURUSD|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"EURUSD","marketLabel":"EUR/USD","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":435,"tradesPerYear":29.3,"winRate":30.6,"grossBp":-3.1,"costBp":0.7,"netBp":-3.8,"tStat":-0.65,"sharpe":-0.16,"annReturnPct":-1.4,"maxDdPct":43.7,"pctYearsPositive":40,"isExp":-0.048,"oosExp":-0.05,"oosTrades":203,"dsr":0,"verdict":"fails","byYear":{"2012":0.2,"2013":0.2,"2014":-3.5,"2015":11.4,"2016":-7.2,"2017":-1.4,"2018":-1.6,"2019":-8.5,"2020":4.5,"2021":-4.8,"2022":9.6,"2023":-5,"2024":-14,"2025":-6.4,"2026":5.2}},{"id":"donchian55|EURUSD|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"EURUSD","marketLabel":"EUR/USD","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":86,"tradesPerYear":3.9,"winRate":24.4,"grossBp":-31.5,"costBp":0.7,"netBp":-32.2,"tStat":0.17,"sharpe":0.03,"annReturnPct":0.2,"maxDdPct":21,"pctYearsPositive":32,"isExp":0.256,"oosExp":-0.405,"oosTrades":27,"dsr":0,"verdict":"fails","byYear":{"2004":-1.5,"2005":2.5,"2006":-0.2,"2007":5.5,"2008":-9.1,"2009":2.9,"2010":3,"2011":-2.7,"2012":-1,"2013":-0.4,"2015":21.5,"2016":-1.7,"2017":4.2,"2018":-1.3,"2019":-6,"2020":-1.7,"2021":-1.4,"2022":-3.5,"2023":-3.1,"2024":-3,"2025":2.9,"2026":-1.6}},{"id":"donchian55|GBPUSD|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":1646,"tradesPerYear":111,"winRate":31.7,"grossBp":0.4,"costBp":0.9,"netBp":-0.5,"tStat":-0.42,"sharpe":-0.1,"annReturnPct":-1.9,"maxDdPct":87.8,"pctYearsPositive":40,"isExp":0.033,"oosExp":-0.076,"oosTrades":761,"dsr":0,"verdict":"fails","byYear":{"2012":1.4,"2013":-2.4,"2014":12.6,"2015":10.5,"2016":19.5,"2017":-18.3,"2018":-3.7,"2019":4.5,"2020":-9,"2021":-6.3,"2022":-2.7,"2023":-22,"2024":-15.4,"2025":15.8,"2026":-12.9}},{"id":"donchian55|GBPUSD|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"GBPUSD","marketLabel":"GBP/USD","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":451,"tradesPerYear":30.4,"winRate":29.5,"grossBp":-7.5,"costBp":0.9,"netBp":-8.4,"tStat":-1.09,"sharpe":-0.27,"annReturnPct":-2.5,"maxDdPct":62,"pctYearsPositive":40,"isExp":-0.007,"oosExp":-0.174,"oosTrades":203,"dsr":0,"verdict":"fails","byYear":{"2012":3.3,"2013":1,"2014":0.7,"2015":7.1,"2016":1.3,"2017":-8.5,"2018":-4.5,"2019":-1.2,"2020":-13.8,"2021":-11.4,"2022":10.1,"2023":-11.4,"2024":-0.9,"2025":-7.3,"2026":-1.6}},{"id":"donchian55|GBPUSD|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":87,"tradesPerYear":4,"winRate":25.3,"grossBp":-45.4,"costBp":0.9,"netBp":-46.3,"tStat":-1.09,"sharpe":-0.22,"annReturnPct":-0.6,"maxDdPct":18.5,"pctYearsPositive":39,"isExp":-0.056,"oosExp":-0.483,"oosTrades":23,"dsr":0,"verdict":"fails","byYear":{"2004":-1.8,"2005":2.8,"2006":0.7,"2007":-2.3,"2008":3.6,"2009":-3.4,"2010":0.5,"2011":-3.4,"2012":-3.7,"2013":2.9,"2014":-1.5,"2015":7.2,"2016":-0.7,"2017":-1.8,"2018":1,"2019":-3.7,"2020":-2.2,"2021":0.3,"2022":0.3,"2023":-3.2,"2024":-2.2,"2025":-1.1,"2026":-3}},{"id":"donchian55|USDJPY|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"USDJPY","marketLabel":"USD/JPY","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":1627,"tradesPerYear":109.7,"winRate":32.1,"grossBp":2,"costBp":0.6,"netBp":1.4,"tStat":1.75,"sharpe":0.43,"annReturnPct":9,"maxDdPct":44.5,"pctYearsPositive":53,"isExp":0.076,"oosExp":0.09,"oosTrades":762,"dsr":0.16,"verdict":"mixed","byYear":{"2012":9.8,"2013":4.6,"2014":25,"2015":-2.9,"2016":36.1,"2017":-1.5,"2018":-12.7,"2019":4.8,"2020":32,"2021":29.2,"2022":30.3,"2023":-1.9,"2024":-12.3,"2025":-4.5,"2026":-1.9},"financing":{"nights":1.5,"finBp":0.3,"netAfterBp":1.2,"crypto20AfterBp":null}},{"id":"donchian55|USDJPY|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"USDJPY","marketLabel":"USD/JPY","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":399,"tradesPerYear":26.9,"winRate":30.8,"grossBp":10.8,"costBp":0.6,"netBp":10.2,"tStat":1.36,"sharpe":0.33,"annReturnPct":3.6,"maxDdPct":29.4,"pctYearsPositive":60,"isExp":0.222,"oosExp":0.04,"oosTrades":192,"dsr":0.07,"verdict":"fails","byYear":{"2012":7.6,"2013":15,"2014":11.2,"2015":0.7,"2016":17.1,"2017":-1.2,"2018":-3.6,"2019":-3.1,"2020":-5.2,"2021":-11.1,"2022":22.2,"2023":5.6,"2024":13.4,"2025":-17.6,"2026":2.6}},{"id":"donchian55|USDJPY|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"USDJPY","marketLabel":"USD/JPY","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":84,"tradesPerYear":3.8,"winRate":34.5,"grossBp":-30.7,"costBp":0.6,"netBp":-31.3,"tStat":0.06,"sharpe":0.01,"annReturnPct":0,"maxDdPct":18.6,"pctYearsPositive":43,"isExp":-0.007,"oosExp":0.054,"oosTrades":27,"dsr":0,"verdict":"fails","byYear":{"2004":-2,"2005":4.1,"2006":-3.4,"2007":0.9,"2008":-7.7,"2009":-2.5,"2010":-2.9,"2011":-3,"2012":1.5,"2013":10.8,"2014":5.2,"2015":-2.2,"2016":-1.4,"2017":2.4,"2018":0,"2019":-0.3,"2020":-1,"2021":3,"2022":3.8,"2023":0.8,"2024":2.8,"2025":-3.9,"2026":-4}},{"id":"donchian55|BTC|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"BTC","marketLabel":"Bitcoin","tf":"1h","sizing":"risk","from":2018,"to":2026,"trades":658,"tradesPerYear":82.8,"winRate":20.1,"grossBp":24.5,"costBp":124.1,"netBp":-99.6,"tStat":-5.7,"sharpe":-1.55,"annReturnPct":-49.3,"maxDdPct":449.5,"pctYearsPositive":11,"isExp":-0.124,"oosExp":-0.776,"oosTrades":542,"dsr":0,"verdict":"fails","byYear":{"2018":-23.5,"2019":9.1,"2020":-11.8,"2021":-49.8,"2022":-52.4,"2023":-78.8,"2024":-43.5,"2025":-111.5,"2026":-73}},{"id":"donchian55|BTC|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"BTC","marketLabel":"Bitcoin","tf":"4h","sizing":"risk","from":2018,"to":2026,"trades":157,"tradesPerYear":19.8,"winRate":30.6,"grossBp":177.2,"costBp":125.1,"netBp":52.2,"tStat":1.12,"sharpe":0.31,"annReturnPct":5.6,"maxDdPct":32.2,"pctYearsPositive":44,"isExp":0.499,"oosExp":0.273,"oosTrades":126,"dsr":0.07,"verdict":"fails","byYear":{"2018":-5.8,"2019":21.2,"2020":32.5,"2021":-0.2,"2022":-6.5,"2023":24.5,"2024":9.5,"2025":-10.1,"2026":-15.3}},{"id":"donchian55|BTC|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"BTC","marketLabel":"Bitcoin","tf":"1d","sizing":"risk","from":2015,"to":2026,"trades":37,"tradesPerYear":3.3,"winRate":51.4,"grossBp":2306.2,"costBp":138.3,"netBp":2167.9,"tStat":2.3,"sharpe":0.52,"annReturnPct":13.3,"maxDdPct":3.4,"pctYearsPositive":58,"isExp":5.87,"oosExp":3.446,"oosTrades":23,"dsr":0.08,"verdict":"mixed","byYear":{"2015":-0.1,"2016":22.9,"2017":26.8,"2018":12.8,"2019":19.8,"2020":-1.6,"2021":62.8,"2022":-1.2,"2023":2,"2024":19.2,"2025":-1,"2026":-0.9},"financing":{"nights":38.4,"finBp":105.1,"netAfterBp":2062.8,"crypto20AfterBp":1957.7}},{"id":"donchian55|ETH|1h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"ETH","marketLabel":"Ethereum","tf":"1h","sizing":"risk","from":2018,"to":2026,"trades":639,"tradesPerYear":80.4,"winRate":21.6,"grossBp":43.5,"costBp":124.2,"netBp":-80.7,"tStat":-4.16,"sharpe":-1.15,"annReturnPct":-30.4,"maxDdPct":276.7,"pctYearsPositive":22,"isExp":-0.36,"oosExp":-0.434,"oosTrades":517,"dsr":0,"verdict":"fails","byYear":{"2018":-12.1,"2019":-31.9,"2020":18.5,"2021":0.2,"2022":-50.1,"2023":-50.5,"2024":-61.9,"2025":-35.3,"2026":-45.3}},{"id":"donchian55|ETH|4h","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"ETH","marketLabel":"Ethereum","tf":"4h","sizing":"risk","from":2018,"to":2026,"trades":156,"tradesPerYear":19.6,"winRate":33.3,"grossBp":242.7,"costBp":125.5,"netBp":117.2,"tStat":1.62,"sharpe":0.45,"annReturnPct":7.5,"maxDdPct":17.8,"pctYearsPositive":67,"isExp":0.65,"oosExp":0.381,"oosTrades":132,"dsr":0.18,"verdict":"mixed","byYear":{"2018":-1.6,"2019":17.2,"2020":23.8,"2021":7.6,"2022":-0.7,"2023":1.2,"2024":16,"2025":11.2,"2026":-8.8},"financing":{"nights":4.9,"finBp":13.3,"netAfterBp":103.9,"crypto20AfterBp":90.6}},{"id":"donchian55|ETH|1d","strategy":"donchian55","name":"Turtle Breakout 55/20","market":"ETH","marketLabel":"Ethereum","tf":"1d","sizing":"risk","from":2018,"to":2026,"trades":27,"tradesPerYear":3.3,"winRate":48.1,"grossBp":1352.8,"costBp":132.4,"netBp":1220.4,"tStat":1.54,"sharpe":0.42,"annReturnPct":4.9,"maxDdPct":3.3,"pctYearsPositive":78,"isExp":-0.424,"oosExp":2.09,"oosTrades":22,"dsr":0.02,"verdict":"mixed","byYear":{"2018":-2.2,"2019":0.1,"2020":6.5,"2021":29.7,"2022":-2.2,"2023":0.3,"2024":6.2,"2025":5.5,"2026":0.1},"financing":{"nights":31.7,"finBp":86.8,"netAfterBp":1133.6,"crypto20AfterBp":1046.8}},{"id":"trend_pullback|ES|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3376,"tradesPerYear":227.7,"winRate":31.8,"grossBp":-1.5,"costBp":2.8,"netBp":-4.3,"tStat":-5.88,"sharpe":-1.48,"annReturnPct":-31.9,"maxDdPct":511.4,"pctYearsPositive":20,"isExp":-0.19,"oosExp":-0.076,"oosTrades":1476,"dsr":0,"verdict":"fails","byYear":{"2012":-38.6,"2013":-42,"2014":-58.7,"2015":-33.3,"2016":-70.5,"2017":-83.6,"2018":2.5,"2019":-36.9,"2020":-28.7,"2021":-24.8,"2022":-17.3,"2023":-37.8,"2024":-23,"2025":11.4,"2026":8.4}},{"id":"trend_pullback|ES|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"ES","marketLabel":"S&P 500 (MES)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":881,"tradesPerYear":59.4,"winRate":34.8,"grossBp":-1.6,"costBp":2.7,"netBp":-4.3,"tStat":-0.1,"sharpe":-0.03,"annReturnPct":-0.3,"maxDdPct":53.6,"pctYearsPositive":53,"isExp":-0.011,"oosExp":0.003,"oosTrades":405,"dsr":0,"verdict":"fails","byYear":{"2012":-11.1,"2013":13.2,"2014":3,"2015":-7.2,"2016":-22.5,"2017":-13.3,"2018":20.8,"2019":11.8,"2020":9.4,"2021":5.6,"2022":-14.4,"2023":3.8,"2024":-5.5,"2025":-1.4,"2026":3.6}},{"id":"trend_pullback|ES|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"risk","from":1990,"to":2026,"trades":346,"tradesPerYear":9.4,"winRate":34.4,"grossBp":12.1,"costBp":7.1,"netBp":5,"tStat":0.04,"sharpe":0.01,"annReturnPct":0,"maxDdPct":20.4,"pctYearsPositive":35,"isExp":-0.01,"oosExp":0.062,"oosTrades":63,"dsr":0,"verdict":"fails","byYear":{"1990":-1.6,"1991":-6.2,"1992":-3.8,"1993":-3.1,"1994":1.3,"1995":8.2,"1996":-4.5,"1997":-2.3,"1998":6.9,"1999":2.9,"2000":-2.1,"2001":-3.1,"2002":-1.2,"2003":8.8,"2004":-4.2,"2005":-5.3,"2006":4.7,"2007":-2.2,"2008":-0.2,"2009":11.9,"2010":-0.2,"2011":-3.2,"2012":-1.2,"2013":-3.3,"2014":-3.1,"2015":-4.2,"2016":-1.1,"2017":3.9,"2018":3.9,"2019":0.9,"2020":-1.2,"2021":-0.1,"2022":-2.7,"2023":1,"2024":3.8,"2025":5.2,"2026":-2.1}},{"id":"trend_pullback|NQ|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3406,"tradesPerYear":229.8,"winRate":33.1,"grossBp":-1.6,"costBp":1.8,"netBp":-3.3,"tStat":-2.93,"sharpe":-0.74,"annReturnPct":-16.2,"maxDdPct":293.3,"pctYearsPositive":27,"isExp":-0.145,"oosExp":0.026,"oosTrades":1487,"dsr":0,"verdict":"fails","byYear":{"2012":-45.4,"2013":-85.3,"2014":-48.4,"2015":-13.4,"2016":-39.8,"2017":-24.5,"2018":-2.1,"2019":-19.1,"2020":21.1,"2021":-0.7,"2022":-21.7,"2023":18.9,"2024":-0.8,"2025":5.6,"2026":15.7}},{"id":"trend_pullback|NQ|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":884,"tradesPerYear":59.6,"winRate":34.2,"grossBp":-1,"costBp":1.7,"netBp":-2.7,"tStat":-0.05,"sharpe":-0.01,"annReturnPct":-0.1,"maxDdPct":44.4,"pctYearsPositive":67,"isExp":-0.017,"oosExp":0.014,"oosTrades":406,"dsr":0,"verdict":"fails","byYear":{"2012":0.9,"2013":-19.6,"2014":6.1,"2015":-21,"2016":2.4,"2017":6.1,"2018":2.9,"2019":14.2,"2020":20.2,"2021":1.2,"2022":-12.1,"2023":6.7,"2024":-10.7,"2025":2.2,"2026":-1.7}},{"id":"trend_pullback|NQ|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"risk","from":1990,"to":2026,"trades":343,"tradesPerYear":9.3,"winRate":34.1,"grossBp":8,"costBp":10.4,"netBp":-2.5,"tStat":-0.25,"sharpe":-0.04,"annReturnPct":-0.2,"maxDdPct":28,"pctYearsPositive":43,"isExp":-0.055,"oosExp":0.192,"oosTrades":49,"dsr":0,"verdict":"fails","byYear":{"1990":-4.7,"1991":2.5,"1992":-2.4,"1993":-4.6,"1994":-3.9,"1995":1,"1996":5.6,"1997":-4.3,"1998":-2.2,"1999":-4.1,"2000":3,"2001":-0.9,"2002":7.9,"2003":2,"2004":-2.6,"2005":-2.4,"2006":4.3,"2007":-3.2,"2008":-3.1,"2009":3.9,"2010":1,"2011":-4,"2012":-7.4,"2013":5.2,"2014":-0.1,"2015":-7.4,"2016":-6.9,"2017":5.9,"2018":7.9,"2019":-2,"2020":5.9,"2021":-2.8,"2022":-2.1,"2023":3,"2024":0.9,"2025":5.1,"2026":-0.5}},{"id":"trend_pullback|GC|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"GC","marketLabel":"Gold (MGC)","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3199,"tradesPerYear":215.8,"winRate":34.7,"grossBp":0.9,"costBp":2.4,"netBp":-1.5,"tStat":-1.75,"sharpe":-0.44,"annReturnPct":-9.3,"maxDdPct":208.7,"pctYearsPositive":33,"isExp":-0.067,"oosExp":-0.015,"oosTrades":1464,"dsr":0,"verdict":"fails","byYear":{"2012":-30.2,"2013":15,"2014":27.3,"2015":-35.1,"2016":-48.6,"2017":-4.8,"2018":-24.8,"2019":-14.5,"2020":-12.5,"2021":-41.6,"2022":-8.1,"2023":20.9,"2024":1.5,"2025":23.8,"2026":-6.8}},{"id":"trend_pullback|GC|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"GC","marketLabel":"Gold (MGC)","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":824,"tradesPerYear":55.6,"winRate":37,"grossBp":3.4,"costBp":2.4,"netBp":1,"tStat":1.41,"sharpe":0.36,"annReturnPct":3.9,"maxDdPct":47,"pctYearsPositive":60,"isExp":0.04,"oosExp":0.106,"oosTrades":383,"dsr":0.12,"verdict":"fails","byYear":{"2012":-4.7,"2013":6.6,"2014":10,"2015":2.4,"2016":3.9,"2017":25.2,"2018":-8.7,"2019":-17.2,"2020":-13.4,"2021":8.4,"2022":12.2,"2023":32.1,"2024":-1.3,"2025":6.7,"2026":-4.1}},{"id":"trend_pullback|GC|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"GC","marketLabel":"Gold (MGC)","tf":"1d","sizing":"risk","from":2001,"to":2026,"trades":189,"tradesPerYear":7.3,"winRate":38.6,"grossBp":19.6,"costBp":3.8,"netBp":15.9,"tStat":0.87,"sharpe":0.19,"annReturnPct":0.8,"maxDdPct":20.3,"pctYearsPositive":54,"isExp":-0.028,"oosExp":0.379,"oosTrades":61,"dsr":0.01,"verdict":"fails","byYear":{"2001":2.3,"2002":7.2,"2003":-1.8,"2004":2.5,"2005":1.4,"2006":-1.9,"2007":-3.8,"2008":0.9,"2009":-3.4,"2010":1.8,"2011":-0.3,"2012":-2.8,"2013":5.8,"2014":-0.3,"2015":-3.1,"2016":1,"2017":-5.4,"2018":-2.5,"2019":-1.1,"2020":1.4,"2021":2.9,"2022":5.9,"2023":-2.1,"2024":6,"2025":5.4,"2026":3.6}},{"id":"trend_pullback|CL|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1h","sizing":"risk","from":2012,"to":2023,"trades":2637,"tradesPerYear":221.4,"winRate":32.2,"grossBp":-3.4,"costBp":6,"netBp":-9.3,"tStat":-4.45,"sharpe":-1.26,"annReturnPct":-26.9,"maxDdPct":325.5,"pctYearsPositive":8,"isExp":-0.133,"oosExp":-0.096,"oosTrades":838,"dsr":0,"verdict":"fails","byYear":{"2012":-47.4,"2013":-63.9,"2014":-19.2,"2015":3.7,"2016":-13.9,"2017":-17.6,"2018":-31.2,"2019":-49,"2020":-43.8,"2021":-10.6,"2022":-1.3,"2023":-25.9}},{"id":"trend_pullback|CL|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"CL","marketLabel":"Crude oil (MCL)","tf":"4h","sizing":"risk","from":2012,"to":2023,"trades":672,"tradesPerYear":56.4,"winRate":37.5,"grossBp":26.7,"costBp":6,"netBp":20.7,"tStat":1.38,"sharpe":0.39,"annReturnPct":4.3,"maxDdPct":23.6,"pctYearsPositive":67,"isExp":0.067,"oosExp":0.093,"oosTrades":227,"dsr":0.17,"verdict":"fails","byYear":{"2012":-3.1,"2013":-11.4,"2014":21.2,"2015":16.4,"2016":4.3,"2017":9.9,"2018":1.6,"2019":-8.8,"2020":16.9,"2021":9.3,"2022":0.5,"2023":-5.6}},{"id":"trend_pullback|CL|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1d","sizing":"risk","from":2012,"to":2023,"trades":107,"tradesPerYear":9,"winRate":32.7,"grossBp":7.8,"costBp":6.2,"netBp":1.6,"tStat":-0.62,"sharpe":-0.18,"annReturnPct":-0.7,"maxDdPct":18.6,"pctYearsPositive":42,"isExp":-0.216,"oosExp":0.264,"oosTrades":30,"dsr":0,"verdict":"fails","byYear":{"2012":-4.1,"2013":-5.1,"2014":2.2,"2015":-0.1,"2016":-4.1,"2017":-3.2,"2018":0.9,"2019":-3.1,"2020":4.4,"2021":2.9,"2022":2.5,"2023":-1.9}},{"id":"trend_pullback|EURUSD|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"EURUSD","marketLabel":"EUR/USD","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3495,"tradesPerYear":235.7,"winRate":33.6,"grossBp":-0.1,"costBp":0.7,"netBp":-0.8,"tStat":-1.68,"sharpe":-0.41,"annReturnPct":-9.3,"maxDdPct":181,"pctYearsPositive":33,"isExp":-0.039,"oosExp":-0.041,"oosTrades":1626,"dsr":0,"verdict":"fails","byYear":{"2012":18,"2013":-45.8,"2014":-48.4,"2015":-19.4,"2016":-9.9,"2017":-14.2,"2018":37,"2019":11.6,"2020":19.2,"2021":-31.5,"2022":-37.6,"2023":-18.3,"2024":-1,"2025":3.9,"2026":-2}},{"id":"trend_pullback|EURUSD|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"EURUSD","marketLabel":"EUR/USD","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":916,"tradesPerYear":61.8,"winRate":33,"grossBp":-0.5,"costBp":0.7,"netBp":-1.2,"tStat":-0.69,"sharpe":-0.17,"annReturnPct":-2,"maxDdPct":47.1,"pctYearsPositive":33,"isExp":-0.065,"oosExp":0.006,"oosTrades":424,"dsr":0,"verdict":"fails","byYear":{"2012":-0.1,"2013":-9.8,"2014":-11.8,"2015":12.1,"2016":-6.9,"2017":0.1,"2018":-8.5,"2019":-7.2,"2020":-4.2,"2021":8.4,"2022":-9,"2023":9.3,"2024":12,"2025":-8.5,"2026":-5.3}},{"id":"trend_pullback|EURUSD|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"EURUSD","marketLabel":"EUR/USD","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":145,"tradesPerYear":6.6,"winRate":34.5,"grossBp":-15.4,"costBp":0.7,"netBp":-16.1,"tStat":-0.38,"sharpe":-0.08,"annReturnPct":-0.3,"maxDdPct":20.4,"pctYearsPositive":43,"isExp":-0.07,"oosExp":0.053,"oosTrades":27,"dsr":0,"verdict":"fails","byYear":{"2004":-3,"2005":-2.3,"2006":0.8,"2007":-5.1,"2008":-5.6,"2009":-2.2,"2010":3,"2011":4,"2012":-0.2,"2013":-2,"2014":2.9,"2015":-3.6,"2016":-0.1,"2017":1.6,"2018":0.7,"2019":2.8,"2020":-1,"2021":0.2,"2022":5,"2025":-1.2,"2026":-1.6}},{"id":"trend_pullback|GBPUSD|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3465,"tradesPerYear":233.7,"winRate":33.3,"grossBp":-0.1,"costBp":0.9,"netBp":-1,"tStat":-2.11,"sharpe":-0.52,"annReturnPct":-11.6,"maxDdPct":189,"pctYearsPositive":27,"isExp":-0.024,"oosExp":-0.08,"oosTrades":1577,"dsr":0,"verdict":"fails","byYear":{"2012":-19.5,"2013":3.2,"2014":-50.3,"2015":-6.7,"2016":-2.7,"2017":11.1,"2018":20.4,"2019":-1.3,"2020":11.9,"2021":-56.3,"2022":-13,"2023":-20.5,"2024":-25.2,"2025":-4.1,"2026":-19.3}},{"id":"trend_pullback|GBPUSD|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"GBPUSD","marketLabel":"GBP/USD","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":892,"tradesPerYear":60.2,"winRate":32.5,"grossBp":-2.3,"costBp":0.9,"netBp":-3.2,"tStat":-1.2,"sharpe":-0.29,"annReturnPct":-3.3,"maxDdPct":75.1,"pctYearsPositive":27,"isExp":-0.118,"oosExp":0.009,"oosTrades":436,"dsr":0,"verdict":"fails","byYear":{"2012":-2.8,"2013":2.3,"2014":-12.4,"2015":-12.9,"2016":-10.5,"2017":-8.5,"2018":-3.3,"2019":-5.6,"2020":-4.2,"2021":-4.8,"2022":8.1,"2023":17.5,"2024":4.8,"2025":-1.1,"2026":-16.3}},{"id":"trend_pullback|GBPUSD|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":187,"tradesPerYear":8.5,"winRate":34.2,"grossBp":-1.4,"costBp":0.9,"netBp":-2.3,"tStat":-0.19,"sharpe":-0.04,"annReturnPct":-0.2,"maxDdPct":23.7,"pctYearsPositive":43,"isExp":-0.045,"oosExp":0.037,"oosTrades":59,"dsr":0,"verdict":"fails","byYear":{"2004":-3,"2005":0,"2006":-5,"2007":-7.3,"2008":-4.3,"2009":2.2,"2010":2,"2011":-1.7,"2012":0.3,"2013":4.2,"2014":1.1,"2015":1.6,"2016":-2.6,"2017":1.9,"2018":6,"2019":-1,"2020":-1,"2021":-2.4,"2022":0,"2023":1.1,"2024":7,"2025":-1,"2026":-1.4}},{"id":"trend_pullback|USDJPY|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"USDJPY","marketLabel":"USD/JPY","tf":"1h","sizing":"risk","from":2012,"to":2026,"trades":3262,"tradesPerYear":220,"winRate":34,"grossBp":-0.2,"costBp":0.6,"netBp":-0.8,"tStat":-1.25,"sharpe":-0.31,"annReturnPct":-6.7,"maxDdPct":131.1,"pctYearsPositive":27,"isExp":-0.037,"oosExp":-0.023,"oosTrades":1492,"dsr":0,"verdict":"fails","byYear":{"2012":-5.2,"2013":-9.5,"2014":26.2,"2015":-3.2,"2016":-1.9,"2017":-17.5,"2018":-20.6,"2019":-33.2,"2020":-19.2,"2021":9.8,"2022":17.4,"2023":-20.9,"2024":-13.3,"2025":10.3,"2026":-19}},{"id":"trend_pullback|USDJPY|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"USDJPY","marketLabel":"USD/JPY","tf":"4h","sizing":"risk","from":2012,"to":2026,"trades":835,"tradesPerYear":56.3,"winRate":36.3,"grossBp":5.3,"costBp":0.6,"netBp":4.7,"tStat":1.04,"sharpe":0.26,"annReturnPct":2.9,"maxDdPct":45,"pctYearsPositive":40,"isExp":0.105,"oosExp":-0.012,"oosTrades":384,"dsr":0.05,"verdict":"fails","byYear":{"2012":-3.7,"2013":15.8,"2014":-5.1,"2015":-6.4,"2016":22.4,"2017":21.7,"2018":16.8,"2019":-14.2,"2020":-17.2,"2021":-5.4,"2022":7,"2023":-2.8,"2024":14.3,"2025":-0.1,"2026":-0.3}},{"id":"trend_pullback|USDJPY|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"USDJPY","marketLabel":"USD/JPY","tf":"1d","sizing":"risk","from":2004,"to":2026,"trades":147,"tradesPerYear":6.7,"winRate":37.4,"grossBp":-17.7,"costBp":0.6,"netBp":-18.3,"tStat":-0.28,"sharpe":-0.06,"annReturnPct":-0.2,"maxDdPct":20.6,"pctYearsPositive":50,"isExp":-0.056,"oosExp":0.109,"oosTrades":22,"dsr":0,"verdict":"fails","byYear":{"2004":-4.1,"2005":0.9,"2006":-7.6,"2007":2.5,"2008":-5.4,"2009":-3.8,"2010":2.1,"2011":4.7,"2012":-1.8,"2013":0.5,"2014":-0.4,"2015":-1,"2016":5.2,"2017":-1.1,"2018":3,"2019":-0.6,"2020":1.9,"2021":0.3,"2022":2,"2026":-1.7}},{"id":"trend_pullback|BTC|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"BTC","marketLabel":"Bitcoin","tf":"1h","sizing":"risk","from":2018,"to":2026,"trades":2752,"tradesPerYear":346.2,"winRate":27.5,"grossBp":-1.1,"costBp":124,"netBp":-125.1,"tStat":-43.04,"sharpe":-9.59,"annReturnPct":-370.4,"maxDdPct":3273.3,"pctYearsPositive":0,"isExp":-0.955,"oosExp":-1.251,"oosTrades":2172,"dsr":0,"verdict":"fails","byYear":{"2018":-243.3,"2019":-310.9,"2020":-341.3,"2021":-233,"2022":-344.5,"2023":-552.4,"2024":-340.4,"2025":-472.8,"2026":-432.4}},{"id":"trend_pullback|BTC|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"BTC","marketLabel":"Bitcoin","tf":"4h","sizing":"risk","from":2018,"to":2026,"trades":637,"tradesPerYear":80.1,"winRate":34.2,"grossBp":-1.6,"costBp":124.2,"netBp":-125.8,"tStat":-9.42,"sharpe":-2.47,"annReturnPct":-37.7,"maxDdPct":336.9,"pctYearsPositive":0,"isExp":-0.452,"oosExp":-0.542,"oosTrades":503,"dsr":0,"verdict":"fails","byYear":{"2018":-31.2,"2019":-29.5,"2020":-36.2,"2021":-20.4,"2022":-39.6,"2023":-48.7,"2024":-25.3,"2025":-49.5,"2026":-52.9}},{"id":"trend_pullback|BTC|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"BTC","marketLabel":"Bitcoin","tf":"1d","sizing":"risk","from":2014,"to":2026,"trades":141,"tradesPerYear":11.6,"winRate":34,"grossBp":13,"costBp":124.2,"netBp":-111.2,"tStat":-1.8,"sharpe":-0.43,"annReturnPct":-2.4,"maxDdPct":34,"pctYearsPositive":31,"isExp":-0.057,"oosExp":-0.294,"oosTrades":91,"dsr":0,"verdict":"fails","byYear":{"2014":1.9,"2015":-3.7,"2016":-3.1,"2017":5,"2018":-4.7,"2019":3,"2020":-6.9,"2021":-2.2,"2022":2.2,"2023":-7.8,"2024":-6.4,"2025":-1.3,"2026":-5.5}},{"id":"trend_pullback|ETH|1h","strategy":"trend_pullback","name":"Trend Pullback","market":"ETH","marketLabel":"Ethereum","tf":"1h","sizing":"risk","from":2018,"to":2026,"trades":2777,"tradesPerYear":349.4,"winRate":30.5,"grossBp":-1.7,"costBp":124,"netBp":-125.7,"tStat":-34,"sharpe":-7.95,"annReturnPct":-290.5,"maxDdPct":2570.7,"pctYearsPositive":0,"isExp":-0.715,"oosExp":-0.981,"oosTrades":2178,"dsr":0,"verdict":"fails","byYear":{"2018":-183.9,"2019":-244.6,"2020":-224.5,"2021":-177.3,"2022":-240.5,"2023":-533.1,"2024":-302.5,"2025":-314.6,"2026":-345}},{"id":"trend_pullback|ETH|4h","strategy":"trend_pullback","name":"Trend Pullback","market":"ETH","marketLabel":"Ethereum","tf":"4h","sizing":"risk","from":2018,"to":2026,"trades":649,"tradesPerYear":81.6,"winRate":31.6,"grossBp":-34.7,"costBp":124.2,"netBp":-158.9,"tStat":-9.63,"sharpe":-2.54,"annReturnPct":-37.3,"maxDdPct":331.3,"pctYearsPositive":0,"isExp":-0.376,"oosExp":-0.543,"oosTrades":514,"dsr":0,"verdict":"fails","byYear":{"2018":-39.7,"2019":-9.7,"2020":-41.4,"2021":-22.7,"2022":-35.4,"2023":-62.5,"2024":-37.4,"2025":-46.1,"2026":-34.9}},{"id":"trend_pullback|ETH|1d","strategy":"trend_pullback","name":"Trend Pullback","market":"ETH","marketLabel":"Ethereum","tf":"1d","sizing":"risk","from":2018,"to":2026,"trades":107,"tradesPerYear":13.2,"winRate":41.1,"grossBp":152.7,"costBp":124,"netBp":28.6,"tStat":0.34,"sharpe":0.1,"annReturnPct":0.6,"maxDdPct":20.7,"pctYearsPositive":67,"isExp":0.172,"oosExp":0.018,"oosTrades":86,"dsr":0.02,"verdict":"fails","byYear":{"2018":1.8,"2019":3,"2020":4.2,"2021":4.3,"2022":-3.5,"2023":-5.9,"2024":-5.7,"2025":4.3,"2026":2.6}},{"id":"rsi2|ES|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"vol","from":1991,"to":2026,"trades":323,"tradesPerYear":9,"winRate":74.3,"grossBp":43.2,"costBp":6.8,"netBp":36.4,"tStat":4.1,"sharpe":0.66,"annReturnPct":8,"maxDdPct":28.7,"pctYearsPositive":70,"isExp":0.878,"oosExp":1.055,"oosTrades":64,"dsr":0.5,"verdict":"holds","byYear":{"1991":11.7,"1992":13.1,"1993":3.6,"1994":-6.2,"1995":24.4,"1996":-6,"1997":40.2,"1998":6.3,"1999":24.5,"2000":-16.1,"2003":15.1,"2004":1.4,"2005":10,"2006":23.8,"2007":-3.9,"2009":14.4,"2010":4.6,"2011":-3.8,"2012":25.6,"2013":10.8,"2014":-0.7,"2015":13.2,"2016":12.4,"2017":23.1,"2018":-19.7,"2019":5.8,"2020":-1,"2021":26.1,"2022":-8.8,"2023":-3.6,"2024":28,"2025":8.5,"2026":18.2},"robust":{"variants":48,"positive":48,"strong":42,"medianSharpe":0.61,"worstSharpe":0.08,"bestSharpe":0.84,"windows":33,"negWindows":0,"worstWindow":{"from":2000,"to":2004,"sharpe":0.01},"net2x":29.6,"net3x":22.8,"baseLabel":"lvl 10, exit SMA 5, RSI 2, trend filter"},"check":{"status":"passed","staleOpenPct":40,"sameTrades":323,"researchTrades":323,"since2000":{"trades":213,"netBp":29.5,"t":2.71,"yearsUp":71},"since2010":{"trades":154,"netBp":27.2,"t":2.09,"yearsUp":65},"since2023":{"trades":44,"netBp":43.2,"t":2.27,"yearsUp":75},"closeEntry":{"trades":310,"netBp":40.7,"t":4.72,"yearsUp":73},"cost2x":{"trades":323,"netBp":29.4,"t":3.4,"yearsUp":67},"etf":{"symbol":"SPY","from":1993,"base":{"trades":277,"netBp":41.9,"t":4.21,"yearsUp":77},"closeEntry":{"trades":268,"netBp":58.5,"t":5.98,"yearsUp":81},"cost2x":{"trades":277,"netBp":40,"t":4.02,"yearsUp":77},"since2023":{"trades":44,"netBp":39.4,"t":2.03,"yearsUp":75}}},"financing":{"nights":3.4,"finBp":3.4,"netAfterBp":33,"crypto20AfterBp":null}},{"id":"rsi2|ES|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1h","sizing":"vol","from":2012,"to":2026,"trades":2500,"tradesPerYear":168.6,"winRate":60.2,"grossBp":1.9,"costBp":2.7,"netBp":-0.9,"tStat":-2.91,"sharpe":-0.73,"annReturnPct":-7.7,"maxDdPct":139.8,"pctYearsPositive":27,"isExp":-0.088,"oosExp":0.006,"oosTrades":1110,"dsr":0,"verdict":"fails","byYear":{"2012":-20.5,"2013":-18.7,"2014":-12.1,"2015":-17.2,"2016":-12.3,"2017":-20,"2018":-11.2,"2019":-9.9,"2020":-1.1,"2021":0.4,"2022":4.4,"2023":5.3,"2024":-2,"2025":4.5,"2026":-4.2}},{"id":"ibs|ES|1d","strategy":"ibs","name":"IBS Reversal","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":1174,"tradesPerYear":31.8,"winRate":64.7,"grossBp":20.8,"costBp":7,"netBp":13.8,"tStat":2.14,"sharpe":0.35,"annReturnPct":8,"maxDdPct":146.1,"pctYearsPositive":68,"isExp":0.209,"oosExp":0.431,"oosTrades":228,"dsr":0.03,"verdict":"mixed","byYear":{"1990":-8.2,"1991":-4.4,"1992":-3.1,"1993":-11.1,"1994":-39.4,"1995":29,"1996":-31.7,"1997":11.2,"1998":5,"1999":13.5,"2000":-24.4,"2001":-54.4,"2002":-1.8,"2003":27.5,"2004":45.4,"2005":15.4,"2006":45.2,"2007":2.8,"2008":-5.6,"2009":-1.7,"2010":18.8,"2011":15.2,"2012":6.8,"2013":42.6,"2014":22.5,"2015":19.6,"2016":18.9,"2017":20.6,"2018":4.9,"2019":11.9,"2020":29.8,"2021":15.1,"2022":6.7,"2023":9.1,"2024":24.7,"2025":22.2,"2026":-2.6},"robust":{"variants":20,"positive":20,"strong":8,"medianSharpe":0.31,"worstSharpe":0.06,"bestSharpe":0.55,"windows":33,"negWindows":10,"worstWindow":{"from":1990,"to":1994,"sharpe":-0.55},"net2x":6.8,"net3x":-0.2,"baseLabel":"IBS < 0.2, exit prevHigh"},"financing":{"nights":3.5,"finBp":3.3,"netAfterBp":10.5,"crypto20AfterBp":null}},{"id":"rsi2|NQ|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"vol","from":1991,"to":2026,"trades":321,"tradesPerYear":8.9,"winRate":69.8,"grossBp":51.3,"costBp":9.2,"netBp":42.1,"tStat":3.11,"sharpe":0.51,"annReturnPct":6.3,"maxDdPct":39.6,"pctYearsPositive":79,"isExp":0.681,"oosExp":0.883,"oosTrades":62,"dsr":0.2,"verdict":"holds","byYear":{"1991":3.8,"1992":2,"1993":17.2,"1994":-14.1,"1995":25.5,"1996":9.4,"1997":18,"1998":4.1,"1999":12.6,"2000":6.8,"2003":18,"2004":5.1,"2005":-3.2,"2006":1.8,"2007":0,"2008":-8.4,"2009":20.1,"2010":1.4,"2011":10.9,"2012":19.4,"2013":17.3,"2014":15.5,"2015":-6.1,"2016":-8.9,"2017":17.4,"2018":-13.1,"2019":3.9,"2020":3,"2021":16.9,"2022":-8.1,"2023":12,"2024":21.6,"2025":5.9,"2026":3.5},"robust":{"variants":48,"positive":47,"strong":36,"medianSharpe":0.51,"worstSharpe":-0.04,"bestSharpe":1,"windows":33,"negWindows":2,"worstWindow":{"from":2004,"to":2008,"sharpe":-0.09},"net2x":32.8,"net3x":23.6,"baseLabel":"lvl 10, exit SMA 5, RSI 2, trend filter"},"check":{"status":"condition","staleOpenPct":24,"sameTrades":321,"researchTrades":321,"since2000":{"trades":221,"netBp":33.8,"t":1.99,"yearsUp":64},"since2010":{"trades":161,"netBp":24.9,"t":1.36,"yearsUp":65},"since2023":{"trades":43,"netBp":51,"t":2.11,"yearsUp":75},"closeEntry":{"trades":310,"netBp":49.3,"t":3.6,"yearsUp":74},"cost2x":{"trades":321,"netBp":31.9,"t":2.23,"yearsUp":62},"etf":{"symbol":"QQQ","from":1999,"base":{"trades":226,"netBp":24,"t":1.44,"yearsUp":68},"closeEntry":{"trades":220,"netBp":47.1,"t":2.9,"yearsUp":76},"cost2x":{"trades":226,"netBp":22.1,"t":1.32,"yearsUp":68},"since2023":{"trades":43,"netBp":45.2,"t":1.88,"yearsUp":75}}},"financing":{"nights":3.5,"finBp":4.3,"netAfterBp":37.7,"crypto20AfterBp":null}},{"id":"rsi2|NQ|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1h","sizing":"vol","from":2012,"to":2026,"trades":2458,"tradesPerYear":165.8,"winRate":62.8,"grossBp":2.3,"costBp":1.7,"netBp":0.6,"tStat":-0.13,"sharpe":-0.03,"annReturnPct":-0.4,"maxDdPct":34.1,"pctYearsPositive":40,"isExp":-0.009,"oosExp":0.006,"oosTrades":1086,"dsr":0,"verdict":"fails","byYear":{"2012":-17.5,"2013":-1.1,"2014":6.3,"2015":-4,"2016":-10.2,"2017":1.9,"2018":-4.1,"2019":16.4,"2020":-15.4,"2021":4.4,"2022":-0.5,"2023":10.8,"2024":-12.6,"2025":24.8,"2026":-4.5}},{"id":"ibs|NQ|1d","strategy":"ibs","name":"IBS Reversal","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":1230,"tradesPerYear":33.4,"winRate":66.2,"grossBp":36.7,"costBp":9.7,"netBp":26.9,"tStat":2.86,"sharpe":0.47,"annReturnPct":11,"maxDdPct":163.4,"pctYearsPositive":73,"isExp":0.29,"oosExp":0.5,"oosTrades":232,"dsr":0.13,"verdict":"holds","byYear":{"1990":-42.1,"1991":-21.5,"1992":-37.9,"1993":-31.4,"1994":-22.8,"1995":7.9,"1996":21.8,"1997":8.2,"1998":45.9,"1999":29.7,"2000":-0.8,"2001":-4.6,"2002":-4.5,"2003":46.8,"2004":48.8,"2005":-5.5,"2006":24.7,"2007":7,"2008":7,"2009":25.5,"2010":17.3,"2011":14.2,"2012":6.8,"2013":44.5,"2014":18.2,"2015":2.9,"2016":13.3,"2017":34.9,"2018":24,"2019":11.6,"2020":13.7,"2021":30.2,"2022":16.4,"2023":36.1,"2024":28.8,"2025":-14.1,"2026":4.8},"robust":{"variants":20,"positive":20,"strong":11,"medianSharpe":0.39,"worstSharpe":0.19,"bestSharpe":0.56,"windows":33,"negWindows":4,"worstWindow":{"from":1990,"to":1994,"sharpe":-1.18},"net2x":17.2,"net3x":7.4,"baseLabel":"IBS < 0.2, exit prevHigh"},"check":{"status":"passed","staleOpenPct":24,"sameTrades":1230,"researchTrades":1230,"since2000":{"trades":879,"netBp":33,"t":2.99,"yearsUp":89},"since2010":{"trades":520,"netBp":34.6,"t":3.2,"yearsUp":100},"since2023":{"trades":121,"netBp":35.9,"t":1.78,"yearsUp":100},"closeEntry":{"trades":1244,"netBp":23.9,"t":2.94,"yearsUp":76},"cost2x":{"trades":1230,"netBp":17.1,"t":1.86,"yearsUp":73},"etf":{"symbol":"QQQ","from":1999,"base":{"trades":851,"netBp":32,"t":2.88,"yearsUp":89},"closeEntry":{"trades":856,"netBp":30,"t":2.9,"yearsUp":86},"cost2x":{"trades":851,"netBp":30.1,"t":2.71,"yearsUp":82},"since2023":{"trades":115,"netBp":17,"t":0.79,"yearsUp":100}}},"financing":{"nights":3.4,"finBp":4.2,"netAfterBp":22.7,"crypto20AfterBp":null}},{"id":"rsi2|GC|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"GC","marketLabel":"Gold (MGC)","tf":"1d","sizing":"vol","from":2002,"to":2026,"trades":154,"tradesPerYear":6.2,"winRate":63.6,"grossBp":21.9,"costBp":4.1,"netBp":17.8,"tStat":1.12,"sharpe":0.24,"annReturnPct":2.2,"maxDdPct":38.5,"pctYearsPositive":52,"isExp":0.56,"oosExp":-0.088,"oosTrades":44,"dsr":0.02,"verdict":"fails","byYear":{"2002":4.4,"2003":-0.2,"2004":-1.3,"2005":19.9,"2006":1.3,"2007":9.7,"2008":-3.3,"2009":21.5,"2010":10.1,"2011":4.6,"2012":-1,"2014":-7.3,"2016":-5.9,"2017":1.6,"2018":-0.3,"2019":7.7,"2020":12.5,"2021":-13.5,"2022":-2,"2023":-13,"2024":1.7,"2025":18.2,"2026":-7.7}},{"id":"rsi2|GC|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"GC","marketLabel":"Gold (MGC)","tf":"1h","sizing":"vol","from":2012,"to":2026,"trades":2103,"tradesPerYear":141.9,"winRate":62.2,"grossBp":1.2,"costBp":2.4,"netBp":-1.2,"tStat":-2.01,"sharpe":-0.51,"annReturnPct":-5.6,"maxDdPct":104.8,"pctYearsPositive":27,"isExp":-0.075,"oosExp":-0.002,"oosTrades":1023,"dsr":0,"verdict":"fails","byYear":{"2012":-22.3,"2013":-5.9,"2014":-3.5,"2015":-7.2,"2016":-19.8,"2017":2.6,"2018":-11.5,"2019":-13.8,"2020":-2.3,"2021":-1.1,"2022":-5.1,"2023":-8.4,"2024":0.1,"2025":8.7,"2026":5.7}},{"id":"ibs|GC|1d","strategy":"ibs","name":"IBS Reversal","market":"GC","marketLabel":"Gold (MGC)","tf":"1d","sizing":"vol","from":2001,"to":2026,"trades":724,"tradesPerYear":28.1,"winRate":62,"grossBp":15.4,"costBp":4.2,"netBp":11.2,"tStat":1.59,"sharpe":0.34,"annReturnPct":6.7,"maxDdPct":103.2,"pctYearsPositive":58,"isExp":0.285,"oosExp":0.087,"oosTrades":175,"dsr":0.07,"verdict":"mixed","byYear":{"2001":10.5,"2002":44.4,"2003":13.8,"2004":-6.6,"2005":23.2,"2006":14.8,"2007":17.3,"2008":-6.2,"2009":18.5,"2010":29.7,"2011":11.3,"2012":40.5,"2013":-12.3,"2014":-13.5,"2015":-25.5,"2016":13.6,"2017":8.4,"2018":-18.3,"2019":-7.2,"2020":0.3,"2021":-24.6,"2022":0,"2023":-0.9,"2024":36.2,"2025":20.6,"2026":-16.3},"financing":{"nights":4.2,"finBp":4.8,"netAfterBp":6.4,"crypto20AfterBp":null}},{"id":"rsi2|CL|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1d","sizing":"vol","from":2013,"to":2023,"trades":63,"tradesPerYear":5.8,"winRate":60.3,"grossBp":16.4,"costBp":5.7,"netBp":10.6,"tStat":-0.6,"sharpe":-0.17,"annReturnPct":-2,"maxDdPct":50.3,"pctYearsPositive":50,"isExp":-0.328,"oosExp":-0.487,"oosTrades":19,"dsr":0,"verdict":"fails","byYear":{"2013":5.4,"2014":-23.7,"2016":-7.8,"2017":0.6,"2018":15.6,"2019":-4.5,"2020":-27.8,"2021":21.2,"2022":-8.1,"2023":5.5}},{"id":"rsi2|CL|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1h","sizing":"vol","from":2012,"to":2023,"trades":1767,"tradesPerYear":148.3,"winRate":60.8,"grossBp":2.6,"costBp":6,"netBp":-3.3,"tStat":-1.9,"sharpe":-0.54,"annReturnPct":-5.7,"maxDdPct":75.3,"pctYearsPositive":25,"isExp":-0.029,"oosExp":-0.058,"oosTrades":588,"dsr":0,"verdict":"fails","byYear":{"2012":-4.8,"2013":3.3,"2014":-0.6,"2015":-8.8,"2016":-14.5,"2017":1.8,"2018":-4.3,"2019":-5.9,"2020":-12.9,"2021":6.7,"2022":-18.3,"2023":-9.7}},{"id":"ibs|CL|1d","strategy":"ibs","name":"IBS Reversal","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1d","sizing":"vol","from":2012,"to":2023,"trades":379,"tradesPerYear":31.8,"winRate":57,"grossBp":-7.3,"costBp":6.1,"netBp":-13.4,"tStat":-1.03,"sharpe":-0.3,"annReturnPct":-7.7,"maxDdPct":169.7,"pctYearsPositive":50,"isExp":-0.366,"oosExp":0.016,"oosTrades":124,"dsr":0,"verdict":"fails","byYear":{"2012":-4.8,"2013":1.1,"2014":-60.3,"2015":-46.8,"2016":15.1,"2017":9.2,"2018":2.2,"2019":-9,"2020":-52.1,"2021":45,"2022":25.7,"2023":-16.6}},{"id":"rsi2|EURUSD|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"EURUSD","marketLabel":"EUR/USD","tf":"1d","sizing":"vol","from":2004,"to":2026,"trades":127,"tradesPerYear":5.8,"winRate":60.6,"grossBp":-2.8,"costBp":0.7,"netBp":-3.5,"tStat":-0.78,"sharpe":-0.16,"annReturnPct":-1.8,"maxDdPct":93.3,"pctYearsPositive":45,"isExp":0.02,"oosExp":-1.03,"oosTrades":41,"dsr":0,"verdict":"fails","byYear":{"2004":2,"2005":-0.1,"2006":-0.6,"2007":8.5,"2008":24.7,"2009":2.7,"2010":-9.4,"2011":-14.6,"2012":3.6,"2013":-8.6,"2014":7.1,"2016":-5.4,"2017":5.4,"2018":-13.5,"2020":0.7,"2021":-24,"2023":-15.1,"2024":-9.7,"2025":6.5,"2026":-0.7}},{"id":"rsi2|EURUSD|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"EURUSD","marketLabel":"EUR/USD","tf":"1h","sizing":"vol","from":2012,"to":2026,"trades":2016,"tradesPerYear":136,"winRate":61.7,"grossBp":0.9,"costBp":0.7,"netBp":0.2,"tStat":0.23,"sharpe":0.06,"annReturnPct":0.6,"maxDdPct":53.2,"pctYearsPositive":53,"isExp":0.015,"oosExp":-0.007,"oosTrades":934,"dsr":0.01,"verdict":"fails","byYear":{"2012":-1.4,"2013":26.7,"2014":-17.5,"2015":7,"2016":-21.9,"2017":13.3,"2018":1.9,"2019":8.3,"2020":-5.3,"2021":-6,"2022":-11.8,"2023":-15.3,"2024":2.8,"2025":25,"2026":3.7}},{"id":"ibs|EURUSD|1d","strategy":"ibs","name":"IBS Reversal","market":"EURUSD","marketLabel":"EUR/USD","tf":"1d","sizing":"vol","from":2004,"to":2026,"trades":804,"tradesPerYear":36.7,"winRate":55.6,"grossBp":-2.5,"costBp":0.7,"netBp":-3.2,"tStat":-0.95,"sharpe":-0.2,"annReturnPct":-5.1,"maxDdPct":258.7,"pctYearsPositive":39,"isExp":-0.068,"oosExp":-0.343,"oosTrades":229,"dsr":0,"verdict":"fails","byYear":{"2004":32.4,"2005":-1.9,"2006":62.8,"2007":2.5,"2008":-4.6,"2009":16.6,"2010":-9.1,"2011":-9.8,"2012":-16.2,"2013":11.1,"2014":-92.6,"2015":-43.4,"2016":-1.8,"2017":16.2,"2018":-11.7,"2019":11.4,"2020":3.6,"2021":-34.2,"2022":-3.6,"2023":-14.7,"2024":-19.4,"2025":32.5,"2026":-43.4}},{"id":"rsi2|GBPUSD|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1d","sizing":"vol","from":2004,"to":2026,"trades":140,"tradesPerYear":6.4,"winRate":62.9,"grossBp":-4.1,"costBp":0.9,"netBp":-5,"tStat":-1.03,"sharpe":-0.21,"annReturnPct":-2.4,"maxDdPct":85.5,"pctYearsPositive":40,"isExp":-0.497,"oosExp":-0.145,"oosTrades":44,"dsr":0,"verdict":"fails","byYear":{"2004":2.6,"2005":-12.8,"2006":7.3,"2007":20.2,"2009":10,"2010":-5.5,"2011":-11.1,"2012":-15,"2013":-3.9,"2014":-13.8,"2015":-7.2,"2017":1,"2018":-12.3,"2019":-7,"2020":18.1,"2021":3.8,"2023":-9.5,"2024":-2.7,"2025":-16.9,"2026":0.8}},{"id":"rsi2|GBPUSD|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1h","sizing":"vol","from":2012,"to":2026,"trades":2051,"tradesPerYear":138.3,"winRate":60.7,"grossBp":0.6,"costBp":0.9,"netBp":-0.3,"tStat":-1.1,"sharpe":-0.27,"annReturnPct":-3,"maxDdPct":68.9,"pctYearsPositive":33,"isExp":-0.037,"oosExp":-0.004,"oosTrades":952,"dsr":0,"verdict":"fails","byYear":{"2012":-1.8,"2013":-0.7,"2014":0.9,"2015":-5.9,"2016":-10.1,"2017":-8.9,"2018":-6,"2019":-8.4,"2020":0.5,"2021":-9,"2022":7.1,"2023":-11.8,"2024":0.6,"2025":-4,"2026":12.7}},{"id":"ibs|GBPUSD|1d","strategy":"ibs","name":"IBS Reversal","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1d","sizing":"vol","from":2004,"to":2026,"trades":779,"tradesPerYear":35.5,"winRate":56.5,"grossBp":-1.7,"costBp":0.9,"netBp":-2.6,"tStat":-0.67,"sharpe":-0.14,"annReturnPct":-3.4,"maxDdPct":179.3,"pctYearsPositive":35,"isExp":-0.102,"oosExp":-0.094,"oosTrades":235,"dsr":0,"verdict":"fails","byYear":{"2004":28.7,"2005":-33.3,"2006":50,"2007":-8.6,"2008":-57.7,"2009":10.8,"2010":26.6,"2011":-33.2,"2012":-32.1,"2013":-5.9,"2014":-3.5,"2015":-17.5,"2016":-24.3,"2017":24,"2018":-17,"2019":38.6,"2020":15.9,"2021":-21.8,"2022":-17.2,"2023":-1.7,"2024":-2.7,"2025":-5.7,"2026":10.4}},{"id":"rsi2|USDJPY|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"USDJPY","marketLabel":"USD/JPY","tf":"1d","sizing":"vol","from":2004,"to":2026,"trades":135,"tradesPerYear":6.2,"winRate":69.6,"grossBp":-3.4,"costBp":0.6,"netBp":-4,"tStat":-0.26,"sharpe":-0.05,"annReturnPct":-0.6,"maxDdPct":40.1,"pctYearsPositive":48,"isExp":0.015,"oosExp":-0.338,"oosTrades":44,"dsr":0,"verdict":"fails","byYear":{"2004":-8.2,"2005":0.1,"2006":-11.3,"2007":-4.5,"2008":0.1,"2009":-3.8,"2010":3.1,"2011":-5.8,"2012":7.8,"2013":10.7,"2014":24.5,"2015":3.6,"2017":-15.5,"2018":0.7,"2020":-9.2,"2021":5.6,"2022":-3.6,"2023":-3.6,"2024":-2.3,"2025":-5.4,"2026":3.6}},{"id":"rsi2|USDJPY|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"USDJPY","marketLabel":"USD/JPY","tf":"1h","sizing":"vol","from":2012,"to":2026,"trades":2235,"tradesPerYear":150.7,"winRate":63,"grossBp":0.6,"costBp":0.6,"netBp":0,"tStat":-0.45,"sharpe":-0.11,"annReturnPct":-1.3,"maxDdPct":38.1,"pctYearsPositive":33,"isExp":0.003,"oosExp":-0.021,"oosTrades":1081,"dsr":0,"verdict":"fails","byYear":{"2012":-2.6,"2013":10.9,"2014":-8.7,"2015":-1.7,"2016":20.7,"2017":-5.2,"2018":-9.2,"2019":-0.7,"2020":-3,"2021":-0.6,"2022":6.9,"2023":0.9,"2024":6.7,"2025":-25.2,"2026":-8}},{"id":"ibs|USDJPY|1d","strategy":"ibs","name":"IBS Reversal","market":"USDJPY","marketLabel":"USD/JPY","tf":"1d","sizing":"vol","from":2004,"to":2026,"trades":803,"tradesPerYear":36.6,"winRate":58.5,"grossBp":3,"costBp":0.6,"netBp":2.4,"tStat":-0.15,"sharpe":-0.03,"annReturnPct":-0.8,"maxDdPct":147.8,"pctYearsPositive":65,"isExp":-0.068,"oosExp":0.067,"oosTrades":268,"dsr":0,"verdict":"fails","byYear":{"2004":18.5,"2005":12.9,"2006":-2.7,"2007":23.9,"2008":4.6,"2009":-32.6,"2010":-42.5,"2011":-37.1,"2012":13.3,"2013":20.6,"2014":9.9,"2015":12.8,"2016":2.4,"2017":-25.4,"2018":3.8,"2019":-18.6,"2020":-47.5,"2021":40.2,"2022":18,"2023":16.4,"2024":3.1,"2025":0.7,"2026":-13}},{"id":"rsi2|BTC|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"BTC","marketLabel":"Bitcoin","tf":"1d","sizing":"vol","from":2015,"to":2026,"trades":124,"tradesPerYear":11,"winRate":58.9,"grossBp":99.3,"costBp":124.6,"netBp":-25.3,"tStat":-1.27,"sharpe":-0.3,"annReturnPct":-6,"maxDdPct":83,"pctYearsPositive":27,"isExp":-0.819,"oosExp":-0.42,"oosTrades":72,"dsr":0,"verdict":"fails","byYear":{"2015":-2.4,"2016":-16.7,"2017":8.3,"2018":-9,"2019":-22.8,"2020":10.7,"2021":-8.4,"2023":-17,"2024":-12.5,"2025":-5.8,"2026":2.7}},{"id":"rsi2|BTC|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"BTC","marketLabel":"Bitcoin","tf":"1h","sizing":"vol","from":2018,"to":2026,"trades":1701,"tradesPerYear":214,"winRate":7,"grossBp":6.2,"costBp":124,"netBp":-117.9,"tStat":-43.34,"sharpe":-7.86,"annReturnPct":-185.8,"maxDdPct":1640.7,"pctYearsPositive":0,"isExp":-0.747,"oosExp":-1.017,"oosTrades":1369,"dsr":0,"verdict":"fails","byYear":{"2018":-111.5,"2019":-136.5,"2020":-183.6,"2021":-144.3,"2022":-159.5,"2023":-227,"2024":-211.2,"2025":-270.5,"2026":-196.7}},{"id":"ibs|BTC|1d","strategy":"ibs","name":"IBS Reversal","market":"BTC","marketLabel":"Bitcoin","tf":"1d","sizing":"vol","from":2014,"to":2026,"trades":487,"tradesPerYear":40,"winRate":51.3,"grossBp":42.3,"costBp":124.2,"netBp":-81.9,"tStat":-4.4,"sharpe":-1.03,"annReturnPct":-34.9,"maxDdPct":424.2,"pctYearsPositive":15,"isExp":-0.824,"oosExp":-0.909,"oosTrades":269,"dsr":0,"verdict":"fails","byYear":{"2014":-33.8,"2015":-49.5,"2016":-31.6,"2017":39.9,"2018":-77.6,"2019":-26.7,"2020":3.7,"2021":-21.6,"2022":-44.3,"2023":-23.2,"2024":-46.6,"2025":-64.6,"2026":-48.4}},{"id":"rsi2|ETH|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"ETH","marketLabel":"Ethereum","tf":"1d","sizing":"vol","from":2019,"to":2026,"trades":69,"tradesPerYear":9.6,"winRate":55.1,"grossBp":49.8,"costBp":124.3,"netBp":-74.5,"tStat":-1.45,"sharpe":-0.4,"annReturnPct":-6,"maxDdPct":67.1,"pctYearsPositive":25,"isExp":-1.171,"oosExp":-0.736,"oosTrades":62,"dsr":0,"verdict":"fails","byYear":{"2019":-8.2,"2020":1.8,"2021":-9.4,"2022":-4.4,"2023":-15.6,"2024":-29.7,"2025":13.8,"2026":-2.1}},{"id":"rsi2|ETH|1h","strategy":"rsi2","name":"RSI(2) Pullback","market":"ETH","marketLabel":"Ethereum","tf":"1h","sizing":"vol","from":2018,"to":2026,"trades":1675,"tradesPerYear":210.7,"winRate":13.4,"grossBp":6.4,"costBp":124,"netBp":-117.6,"tStat":-34.46,"sharpe":-7.05,"annReturnPct":-138.4,"maxDdPct":1222.7,"pctYearsPositive":0,"isExp":-0.527,"oosExp":-0.781,"oosTrades":1340,"dsr":0,"verdict":"fails","byYear":{"2018":-73.3,"2019":-103.2,"2020":-113.9,"2021":-129,"2022":-100,"2023":-257.9,"2024":-170.9,"2025":-137.9,"2026":-136.6}},{"id":"ibs|ETH|1d","strategy":"ibs","name":"IBS Reversal","market":"ETH","marketLabel":"Ethereum","tf":"1d","sizing":"vol","from":2017,"to":2026,"trades":380,"tradesPerYear":42.1,"winRate":50.8,"grossBp":-11.4,"costBp":123.9,"netBp":-135.3,"tStat":-3.52,"sharpe":-0.96,"annReturnPct":-37.8,"maxDdPct":349.1,"pctYearsPositive":20,"isExp":-1.33,"oosExp":-0.74,"oosTrades":279,"dsr":0,"verdict":"fails","byYear":{"2017":4.2,"2018":-99.2,"2019":-39.4,"2020":30.1,"2021":-34.9,"2022":-53.3,"2023":-21.3,"2024":-53.6,"2025":-38.5,"2026":-34.7}},{"id":"tsmom|ES|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"vol","from":1991,"to":2026,"trades":101,"tradesPerYear":2.8,"winRate":32.7,"grossBp":309.1,"costBp":8.1,"netBp":301,"tStat":1.63,"sharpe":0.27,"annReturnPct":20.2,"maxDdPct":66.8,"pctYearsPositive":70,"isExp":7.701,"oosExp":4.762,"oosTrades":11,"dsr":0,"verdict":"mixed","byYear":{"1991":-5.2,"1994":6.6,"1995":-16.4,"1998":424,"2000":39.4,"2001":0.4,"2002":41.1,"2003":17.3,"2008":76.3,"2009":41.7,"2011":0.8,"2012":3,"2015":77.1,"2016":-57.8,"2018":66.2,"2019":-4,"2020":-33.1,"2022":33.8,"2023":-1.3,"2025":35.7},"financing":{"nights":122.3,"finBp":97.4,"netAfterBp":203.5,"crypto20AfterBp":null}},{"id":"tsmom|NQ|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"vol","from":1991,"to":2026,"trades":109,"tradesPerYear":3,"winRate":33.9,"grossBp":488.5,"costBp":7.7,"netBp":480.8,"tStat":1.95,"sharpe":0.32,"annReturnPct":21.8,"maxDdPct":38.8,"pctYearsPositive":62,"isExp":8.09,"oosExp":2.994,"oosTrades":15,"dsr":0,"verdict":"mixed","byYear":{"1991":-16.2,"1994":70.5,"1995":-19.4,"1998":353.4,"2000":68.6,"2003":28.9,"2004":15.7,"2005":25.5,"2006":-14.9,"2008":-16.2,"2009":19.1,"2011":68.8,"2013":30.6,"2015":120.5,"2016":-16.6,"2018":71.9,"2019":-12.2,"2020":-22.3,"2022":12.1,"2023":-3.7,"2025":41.2},"financing":{"nights":113.3,"finBp":114.4,"netAfterBp":366.5,"crypto20AfterBp":null}},{"id":"tsmom|GC|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"GC","marketLabel":"Gold (MGC)","tf":"1d","sizing":"vol","from":2008,"to":2026,"trades":107,"tradesPerYear":5.7,"winRate":26.2,"grossBp":184.3,"costBp":3.1,"netBp":181.2,"tStat":1.09,"sharpe":0.23,"annReturnPct":17.7,"maxDdPct":113.8,"pctYearsPositive":43,"isExp":5.694,"oosExp":1.466,"oosTrades":36,"dsr":0,"verdict":"fails","byYear":{"2008":323.4,"2009":-22.4,"2012":86.8,"2013":-7.3,"2014":36.6,"2015":13,"2016":-8.7,"2017":-66.2,"2018":-18.5,"2019":-10,"2021":70.6,"2022":-54.7,"2023":-16.2,"2026":130.9}},{"id":"tsmom|CL|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"CL","marketLabel":"Crude oil (MCL)","tf":"1d","sizing":"vol","from":2013,"to":2023,"trades":63,"tradesPerYear":5.8,"winRate":30.2,"grossBp":12.4,"costBp":6.1,"netBp":6.4,"tStat":0.35,"sharpe":0.1,"annReturnPct":3,"maxDdPct":58.2,"pctYearsPositive":40,"isExp":1.323,"oosExp":-0.579,"oosTrades":25,"dsr":0.01,"verdict":"fails","byYear":{"2013":-13.1,"2014":3.8,"2016":76,"2017":-13.3,"2018":10.4,"2019":-6.1,"2020":-13.9,"2021":-5.1,"2022":14.2,"2023":-17.1}},{"id":"tsmom|EURUSD|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"EURUSD","marketLabel":"EUR/USD","tf":"1d","sizing":"vol","from":2005,"to":2026,"trades":143,"tradesPerYear":6.8,"winRate":31.5,"grossBp":-50.6,"costBp":0.7,"netBp":-51.3,"tStat":-0.26,"sharpe":-0.05,"annReturnPct":-1.9,"maxDdPct":216.5,"pctYearsPositive":44,"isExp":-1.238,"oosExp":2.368,"oosTrades":37,"dsr":0,"verdict":"fails","byYear":{"2005":-72.5,"2006":-11,"2008":19,"2009":-12.9,"2010":-68.9,"2011":-52.4,"2012":-15,"2013":7,"2014":-9.7,"2016":84.3,"2017":-19.4,"2018":12.9,"2020":7.1,"2021":6.3,"2023":52.5,"2024":-4.7,"2025":-7.1,"2026":40.9}},{"id":"tsmom|GBPUSD|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"GBPUSD","marketLabel":"GBP/USD","tf":"1d","sizing":"vol","from":2005,"to":2026,"trades":159,"tradesPerYear":7.6,"winRate":29.6,"grossBp":-19.2,"costBp":0.9,"netBp":-20.1,"tStat":-0.74,"sharpe":-0.15,"annReturnPct":-4.7,"maxDdPct":170,"pctYearsPositive":32,"isExp":-1.107,"oosExp":0.118,"oosTrades":56,"dsr":0,"verdict":"fails","byYear":{"2005":-48.2,"2006":-16.9,"2008":10.5,"2009":64.3,"2010":-54,"2011":-48.2,"2012":-6.1,"2013":-48.5,"2014":-13.3,"2017":84.1,"2018":-45.6,"2019":4.2,"2020":27.8,"2021":-1.7,"2022":-26.3,"2023":59.6,"2024":-40.1,"2025":-2.1,"2026":-6.8}},{"id":"tsmom|USDJPY|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"USDJPY","marketLabel":"USD/JPY","tf":"1d","sizing":"vol","from":2005,"to":2026,"trades":156,"tradesPerYear":7.4,"winRate":30.8,"grossBp":26.7,"costBp":0.6,"netBp":26.1,"tStat":0.91,"sharpe":0.19,"annReturnPct":10.9,"maxDdPct":162.5,"pctYearsPositive":41,"isExp":2.147,"oosExp":0.278,"oosTrades":46,"dsr":0,"verdict":"fails","byYear":{"2005":-20.8,"2006":23.4,"2007":-25.2,"2009":67,"2010":-19,"2012":22.5,"2014":179.3,"2016":87.7,"2017":-7.5,"2018":-82.6,"2019":21.9,"2020":-65.5,"2021":-1.5,"2023":125.2,"2024":-12.1,"2025":-27.8,"2026":-16.1}},{"id":"tsmom|BTC|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"BTC","marketLabel":"Bitcoin","tf":"1d","sizing":"vol","from":2015,"to":2026,"trades":21,"tradesPerYear":1.9,"winRate":38.1,"grossBp":15800.6,"costBp":221.9,"netBp":15578.7,"tStat":1.24,"sharpe":0.29,"annReturnPct":421,"maxDdPct":34.5,"pctYearsPositive":50,"isExp":1025.13,"oosExp":60.184,"oosTrades":17,"dsr":0,"verdict":"fails","byYear":{"2015":3.4,"2018":4085,"2020":-2.7,"2021":813.2,"2022":-5.6,"2023":-11.3,"2025":272.1,"2026":-30.5}},{"id":"tsmom|ETH|1d","strategy":"tsmom","name":"12-Month Trend (time-series momentum)","market":"ETH","marketLabel":"Ethereum","tf":"1d","sizing":"vol","from":2018,"to":2026,"trades":27,"tradesPerYear":3.3,"winRate":40.7,"grossBp":4532.7,"costBp":152.1,"netBp":4380.6,"tStat":0.96,"sharpe":0.27,"annReturnPct":94,"maxDdPct":51.2,"pctYearsPositive":25,"isExp":-7.91,"oosExp":36.336,"oosTrades":24,"dsr":0,"verdict":"fails","byYear":{"2018":-5.9,"2019":-17.8,"2020":-3.9,"2022":880.1,"2023":-5.5,"2024":52.6,"2025":-7.1,"2026":-44.2}},{"id":"turn_of_month|ES|1d","strategy":"turn_of_month","name":"Turn of the Month","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":424,"tradesPerYear":11.5,"winRate":57.3,"grossBp":31.9,"costBp":6.9,"netBp":25,"tStat":2.55,"sharpe":0.42,"annReturnPct":6.3,"maxDdPct":52.5,"pctYearsPositive":59,"isExp":0.501,"oosExp":0.77,"oosTrades":79,"dsr":0.07,"verdict":"mixed","byYear":{"1990":25,"1991":-9.2,"1992":-12.1,"1993":-13,"1994":-11.6,"1995":43,"1996":25.7,"1997":13.6,"1998":-13.7,"1999":19.4,"2000":9.6,"2001":6,"2002":-16.4,"2003":28.9,"2004":16.2,"2005":2,"2006":4.5,"2007":-1.8,"2008":-23.5,"2009":-2.4,"2010":34.9,"2011":10.8,"2012":16.4,"2013":14.5,"2014":-5.4,"2015":-5.7,"2016":-13.3,"2017":17.3,"2018":1.7,"2019":6.5,"2020":34.2,"2021":8.7,"2022":-0.8,"2023":9.5,"2024":-5.9,"2025":-8.1,"2026":28.2},"financing":{"nights":4.6,"finBp":4.3,"netAfterBp":20.7,"crypto20AfterBp":null}},{"id":"turn_of_month|NQ|1d","strategy":"turn_of_month","name":"Turn of the Month","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":424,"tradesPerYear":11.5,"winRate":55.9,"grossBp":44.2,"costBp":9.7,"netBp":34.5,"tStat":2.21,"sharpe":0.36,"annReturnPct":5.5,"maxDdPct":37.1,"pctYearsPositive":70,"isExp":0.489,"oosExp":0.454,"oosTrades":79,"dsr":0.04,"verdict":"mixed","byYear":{"1990":19.1,"1991":1.5,"1992":1.9,"1993":8.2,"1994":-9.2,"1995":15.9,"1996":8.6,"1997":19.9,"1998":-28.6,"1999":25.5,"2000":2.7,"2001":2.8,"2002":-18.2,"2003":24,"2004":4,"2005":1,"2006":-0.6,"2007":3.8,"2008":-19.7,"2009":1.6,"2010":26.8,"2011":17.3,"2012":11.1,"2013":23.2,"2014":2.1,"2015":-4.9,"2016":-14.8,"2017":11.8,"2018":5.5,"2019":18.3,"2020":42,"2021":-1,"2022":-4.1,"2023":11.5,"2024":-10.7,"2025":-9.9,"2026":16.3},"financing":{"nights":4.6,"finBp":5.6,"netAfterBp":28.9,"crypto20AfterBp":null}},{"id":"rod_momentum|ES|5m_rth","strategy":"rod_momentum","name":"Market Intraday Momentum (last 30 min)","market":"ES","marketLabel":"S&P 500 (MES)","tf":"5m_rth","sizing":"vol","from":2012,"to":2026,"trades":3626,"tradesPerYear":244.6,"winRate":42.7,"grossBp":1.2,"costBp":2.7,"netBp":-1.5,"tStat":-7.89,"sharpe":-2.03,"annReturnPct":-16.8,"maxDdPct":249.8,"pctYearsPositive":13,"isExp":-0.102,"oosExp":-0.03,"oosTrades":1659,"dsr":0,"verdict":"fails","byYear":{"2012":-39.6,"2013":-31.7,"2014":-39.7,"2015":-0.9,"2016":-26.2,"2017":-54.6,"2018":8.2,"2019":-15.2,"2020":-3.2,"2021":-12.4,"2022":13.4,"2023":-3.2,"2024":-13.2,"2025":-16.2,"2026":-15.1}},{"id":"rod_momentum|NQ|5m_rth","strategy":"rod_momentum","name":"Market Intraday Momentum (last 30 min)","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"5m_rth","sizing":"vol","from":2012,"to":2026,"trades":3625,"tradesPerYear":244.5,"winRate":46.7,"grossBp":1.2,"costBp":1.7,"netBp":-0.5,"tStat":-4.24,"sharpe":-1.09,"annReturnPct":-8.1,"maxDdPct":122.4,"pctYearsPositive":27,"isExp":-0.056,"oosExp":-0.005,"oosTrades":1646,"dsr":0,"verdict":"fails","byYear":{"2012":-21.7,"2013":-27.8,"2014":-23,"2015":-6.7,"2016":-16.4,"2017":-25.5,"2018":17.2,"2019":-7.5,"2020":6.5,"2021":2.9,"2022":16.2,"2023":-1.7,"2024":-8.5,"2025":-17.5,"2026":-6.5}},{"id":"rod_momentum|GC|5m_pit","strategy":"rod_momentum","name":"Market Intraday Momentum (last 30 min)","market":"GC","marketLabel":"Gold (MGC)","tf":"5m_pit","sizing":"vol","from":2012,"to":2026,"trades":3698,"tradesPerYear":249.5,"winRate":39.8,"grossBp":0.3,"costBp":2.4,"netBp":-2.1,"tStat":-10,"sharpe":-2.53,"annReturnPct":-13.7,"maxDdPct":207.8,"pctYearsPositive":7,"isExp":-0.067,"oosExp":-0.04,"oosTrades":1645,"dsr":0,"verdict":"fails","byYear":{"2012":-7.2,"2013":-5.6,"2014":-15.2,"2015":-21,"2016":-18.3,"2017":-26.4,"2018":-21.8,"2019":-22.3,"2020":-11.4,"2021":-13.4,"2022":-9.7,"2023":-16.9,"2024":-8.5,"2025":2.4,"2026":-7.6}},{"id":"rod_momentum|CL|5m_pit","strategy":"rod_momentum","name":"Market Intraday Momentum (last 30 min)","market":"CL","marketLabel":"Crude oil (MCL)","tf":"5m_pit","sizing":"vol","from":2012,"to":2023,"trades":2881,"tradesPerYear":241.9,"winRate":42.4,"grossBp":0.5,"costBp":6.1,"netBp":-5.6,"tStat":-7.04,"sharpe":-2.02,"annReturnPct":-14.5,"maxDdPct":175,"pctYearsPositive":0,"isExp":-0.057,"oosExp":-0.066,"oosTrades":881,"dsr":0,"verdict":"fails","byYear":{"2012":-10.7,"2013":-5.6,"2014":-2.3,"2015":-8.1,"2016":-23.4,"2017":-26.2,"2018":-8.2,"2019":-29.8,"2020":-28.3,"2021":-13.1,"2022":-14.7,"2023":-2.4}},{"id":"month_end_rebal|ES|1d","strategy":"month_end_rebal","name":"Month-End Rebalancing Flow","market":"ES","marketLabel":"S&P 500 (MES)","tf":"1d","sizing":"vol","from":2002,"to":2026,"trades":281,"tradesPerYear":11.3,"winRate":57.3,"grossBp":42.8,"costBp":4.2,"netBp":38.6,"tStat":2.88,"sharpe":0.47,"annReturnPct":5.6,"maxDdPct":25.4,"pctYearsPositive":68,"isExp":0.8,"oosExp":0.546,"oosTrades":79,"dsr":0.1,"verdict":"holds","byYear":{"2002":-9.5,"2003":-4.2,"2004":28.9,"2005":1,"2006":13.4,"2007":18.4,"2008":10.1,"2009":8.4,"2010":-0.9,"2011":18.2,"2012":8.2,"2013":9.1,"2014":12.3,"2015":14.6,"2016":-0.9,"2017":3.3,"2018":37.4,"2019":-6,"2020":21.3,"2021":9.5,"2022":13.7,"2023":-8.5,"2024":23.5,"2025":-11.5,"2026":-4.9},"robust":{"variants":7,"positive":7,"strong":6,"medianSharpe":0.41,"worstSharpe":0.25,"bestSharpe":0.47,"windows":23,"negWindows":0,"worstWindow":{"from":2022,"to":2026,"sharpe":0.19},"net2x":34.4,"net3x":30.2,"baseLabel":"last 5 days"},"check":{"status":"passed","staleOpenPct":21,"sameTrades":281,"researchTrades":281,"since2000":{"trades":281,"netBp":38.6,"t":3.06,"yearsUp":68},"since2010":{"trades":195,"netBp":35,"t":2.48,"yearsUp":71},"since2023":{"trades":45,"netBp":9.8,"t":0.39,"yearsUp":50},"closeEntry":{"trades":281,"netBp":38.1,"t":2.92,"yearsUp":68},"cost2x":{"trades":281,"netBp":34.4,"t":2.73,"yearsUp":68},"etf":{"symbol":"SPY","from":1993,"base":{"trades":281,"netBp":36,"t":2.94,"yearsUp":80},"closeEntry":{"trades":281,"netBp":37.2,"t":2.78,"yearsUp":72},"cost2x":{"trades":281,"netBp":34,"t":2.78,"yearsUp":72},"since2023":{"trades":45,"netBp":13.2,"t":0.59,"yearsUp":25}}},"financing":{"nights":5,"finBp":3.4,"netAfterBp":35.2,"crypto20AfterBp":null}},{"id":"month_end_rebal|NQ|1d","strategy":"month_end_rebal","name":"Month-End Rebalancing Flow","market":"NQ","marketLabel":"Nasdaq-100 (MNQ)","tf":"1d","sizing":"vol","from":2002,"to":2026,"trades":281,"tradesPerYear":11.3,"winRate":50.2,"grossBp":21.8,"costBp":3.8,"netBp":18,"tStat":0.61,"sharpe":0.1,"annReturnPct":1.2,"maxDdPct":45.9,"pctYearsPositive":52,"isExp":0.235,"oosExp":-0.046,"oosTrades":79,"dsr":0,"verdict":"fails","byYear":{"2002":-0.6,"2003":11.7,"2004":3.7,"2005":-8.1,"2006":-8.1,"2007":13,"2008":-4.2,"2009":8.3,"2010":6.2,"2011":25.6,"2012":5.7,"2013":6.1,"2014":-21.6,"2015":-1.8,"2016":15.1,"2017":-11.6,"2018":12.2,"2019":-4.1,"2020":17.9,"2021":-7.8,"2022":7.5,"2023":-20.9,"2024":26.5,"2025":-21.2,"2026":-5.7}},{"id":"rsi2|RUT|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"RUT","marketLabel":"Russell 2000","tf":"1d","sizing":"vol","from":1991,"to":2026,"trades":305,"tradesPerYear":8.5,"winRate":65.6,"grossBp":25.8,"costBp":3,"netBp":22.8,"tStat":1.29,"sharpe":0.21,"annReturnPct":2.5,"maxDdPct":64,"pctYearsPositive":63,"isExp":0.157,"oosExp":0.99,"oosTrades":55,"dsr":0,"verdict":"fails","byYear":{"1991":-5.6,"1992":-36.9,"1993":18.3,"1994":-6.4,"1995":22,"1996":-26.2,"1997":-0.7,"1998":-8,"1999":-12.6,"2000":-0.6,"2001":4,"2002":-0.2,"2003":23,"2004":5.2,"2005":2.4,"2006":4.9,"2007":5,"2008":1.1,"2009":10.1,"2010":1.9,"2011":2.9,"2012":1.8,"2013":7.7,"2014":7.5,"2015":17.4,"2016":10.4,"2017":9.6,"2018":-11.5,"2019":-8.4,"2020":-3.1,"2021":13.1,"2023":-3,"2024":5.3,"2025":16.9,"2026":26.2}},{"id":"ibs|RUT|1d","strategy":"ibs","name":"IBS Reversal","market":"RUT","marketLabel":"Russell 2000","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":1276,"tradesPerYear":34.6,"winRate":60.8,"grossBp":9.2,"costBp":3,"netBp":6.2,"tStat":-1.35,"sharpe":-0.22,"annReturnPct":-5.3,"maxDdPct":463.4,"pctYearsPositive":43,"isExp":-0.2,"oosExp":0.04,"oosTrades":256,"dsr":0,"verdict":"fails","byYear":{"1990":-63.4,"1991":-12.9,"1992":-57.7,"1993":-46.8,"1994":-65.9,"1995":-19.9,"1996":-31.6,"1997":-26.4,"1998":-61.3,"1999":-13.4,"2000":-21.9,"2001":-6.4,"2002":-3.6,"2003":43,"2004":28.1,"2005":12.2,"2006":21.5,"2007":16.7,"2008":-0.1,"2009":19.3,"2010":25.1,"2011":10.5,"2012":-4.8,"2013":44.9,"2014":10.6,"2015":-39.4,"2016":19.3,"2017":9.1,"2018":-1.4,"2019":14.7,"2020":-10.7,"2021":-7.1,"2022":7.9,"2023":22.8,"2024":-26.4,"2025":23.1,"2026":-1.8}},{"id":"turn_of_month|RUT|1d","strategy":"turn_of_month","name":"Turn of the Month","market":"RUT","marketLabel":"Russell 2000","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":424,"tradesPerYear":11.5,"winRate":60.8,"grossBp":36.5,"costBp":3,"netBp":33.5,"tStat":4.01,"sharpe":0.65,"annReturnPct":10.7,"maxDdPct":46.1,"pctYearsPositive":68,"isExp":1.04,"oosExp":0.443,"oosTrades":79,"dsr":0.48,"verdict":"holds","byYear":{"1990":35.9,"1991":31.1,"1992":27.5,"1993":54.8,"1994":5.8,"1995":54.1,"1996":21.5,"1997":51.3,"1998":0.5,"1999":23.5,"2000":18.8,"2001":-0.3,"2002":-21.1,"2003":33.5,"2004":8.7,"2005":14.2,"2006":3,"2007":-15.2,"2008":-19.9,"2009":-4.2,"2010":29.1,"2011":2.8,"2012":11.4,"2013":18.7,"2014":-6.6,"2015":-5.6,"2016":-10,"2017":-13,"2018":-2.9,"2019":10.6,"2020":15.8,"2021":10.1,"2022":-2,"2023":7.2,"2024":-27,"2025":6,"2026":25.9},"robust":{"variants":15,"positive":15,"strong":13,"medianSharpe":0.67,"worstSharpe":0.48,"bestSharpe":0.78,"windows":33,"negWindows":8,"worstWindow":{"from":2014,"to":2018,"sharpe":-0.55},"net2x":30.5,"net3x":27.4,"baseLabel":"enter 1 day left, exit day 3"},"check":{"status":"weaker","staleOpenPct":37,"sameTrades":424,"researchTrades":424,"since2000":{"trades":309,"netBp":18.6,"t":1.13,"yearsUp":59},"since2010":{"trades":193,"netBp":19.1,"t":1.01,"yearsUp":59},"since2023":{"trades":44,"netBp":14.1,"t":0.36,"yearsUp":75},"closeEntry":{"trades":424,"netBp":30.9,"t":2.37,"yearsUp":62},"cost2x":{"trades":424,"netBp":30.6,"t":2.38,"yearsUp":62},"etf":{"symbol":"IWM","from":2000,"base":{"trades":304,"netBp":14.9,"t":0.96,"yearsUp":59},"closeEntry":{"trades":304,"netBp":16.3,"t":1.01,"yearsUp":56},"cost2x":{"trades":304,"netBp":13,"t":0.83,"yearsUp":59},"since2023":{"trades":44,"netBp":9.9,"t":0.24,"yearsUp":75}}},"financing":{"nights":4.6,"finBp":5,"netAfterBp":28.5,"crypto20AfterBp":null}},{"id":"rsi2|DAX|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"DAX","marketLabel":"DAX 40","tf":"1d","sizing":"vol","from":1995,"to":2026,"trades":239,"tradesPerYear":7.5,"winRate":67.8,"grossBp":28.1,"costBp":2,"netBp":26.1,"tStat":1.38,"sharpe":0.24,"annReturnPct":2.9,"maxDdPct":68,"pctYearsPositive":61,"isExp":0.463,"oosExp":0.181,"oosTrades":58,"dsr":0.01,"verdict":"fails","byYear":{"1995":5.2,"1996":1.7,"1997":31.8,"1998":3.5,"1999":-3.1,"2000":9.2,"2002":-6.5,"2003":6.9,"2004":2.6,"2005":24.4,"2006":0.6,"2007":-6,"2008":-8.6,"2009":3.4,"2010":8.7,"2011":-8.6,"2012":20.6,"2013":23.3,"2014":-7.1,"2015":-3.7,"2016":-4.9,"2017":4.8,"2018":-17,"2019":2.6,"2020":-25.4,"2021":-14.4,"2022":4.6,"2023":20.6,"2024":7.2,"2025":19.4,"2026":-1.4}},{"id":"ibs|DAX|1d","strategy":"ibs","name":"IBS Reversal","market":"DAX","marketLabel":"DAX 40","tf":"1d","sizing":"vol","from":1994,"to":2026,"trades":1022,"tradesPerYear":31.1,"winRate":63.3,"grossBp":10,"costBp":2,"netBp":8,"tStat":1.07,"sharpe":0.19,"annReturnPct":4.3,"maxDdPct":136.9,"pctYearsPositive":58,"isExp":0.269,"oosExp":-0.355,"oosTrades":213,"dsr":0,"verdict":"fails","byYear":{"1994":12.8,"1995":24.4,"1996":30.1,"1997":12.8,"1998":-10.8,"1999":12.8,"2000":-10,"2001":-38.7,"2002":-12,"2003":41.5,"2004":27.3,"2005":36.2,"2006":28.7,"2007":9.9,"2008":-9,"2009":27.5,"2010":5.2,"2011":-8.2,"2012":4.7,"2013":38.5,"2014":-33.9,"2015":20.5,"2016":5.4,"2017":45.2,"2018":-59.8,"2019":16.5,"2020":-7.7,"2021":-0.6,"2022":-10.4,"2023":-26.4,"2024":4.6,"2025":-21.6,"2026":-13.7}},{"id":"turn_of_month|DAX|1d","strategy":"turn_of_month","name":"Turn of the Month","market":"DAX","marketLabel":"DAX 40","tf":"1d","sizing":"vol","from":1994,"to":2026,"trades":392,"tradesPerYear":11.9,"winRate":58.7,"grossBp":38.6,"costBp":2,"netBp":36.6,"tStat":3.1,"sharpe":0.53,"annReturnPct":8.6,"maxDdPct":58.4,"pctYearsPositive":61,"isExp":0.754,"oosExp":0.599,"oosTrades":83,"dsr":0.24,"verdict":"holds","byYear":{"1994":3.9,"1995":23.9,"1996":15.9,"1997":41.7,"1998":-9.2,"1999":32.4,"2000":20.8,"2001":8,"2002":-20.4,"2003":41.3,"2004":17.4,"2005":36.5,"2006":0.3,"2007":16.2,"2008":-4.9,"2009":-0.6,"2010":34.5,"2011":-9.7,"2012":8.5,"2013":-3.5,"2014":-15.1,"2015":-4.6,"2016":-25.2,"2017":30.9,"2018":-22.3,"2019":16.2,"2020":17.7,"2021":25.4,"2022":-6.7,"2023":10.3,"2024":-9.6,"2025":-0.4,"2026":13},"robust":{"variants":15,"positive":15,"strong":12,"medianSharpe":0.41,"worstSharpe":0.31,"bestSharpe":0.53,"windows":29,"negWindows":5,"worstWindow":{"from":2012,"to":2016,"sharpe":-0.51},"net2x":34.6,"net3x":32.6,"baseLabel":"enter 1 day left, exit day 3"},"check":{"status":"weaker","staleOpenPct":0,"sameTrades":392,"researchTrades":392,"since2000":{"trades":323,"netBp":29.2,"t":1.91,"yearsUp":63},"since2010":{"trades":203,"netBp":11.7,"t":0.69,"yearsUp":53},"since2023":{"trades":46,"netBp":21.7,"t":0.68,"yearsUp":75},"closeEntry":{"trades":392,"netBp":40.8,"t":2.85,"yearsUp":70},"cost2x":{"trades":392,"netBp":34.6,"t":2.45,"yearsUp":67},"etf":null},"financing":{"nights":4.5,"finBp":6.1,"netAfterBp":30.5,"crypto20AfterBp":null}},{"id":"rsi2|FTSE|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"FTSE","marketLabel":"FTSE 100","tf":"1d","sizing":"vol","from":1991,"to":2026,"trades":271,"tradesPerYear":7.6,"winRate":70.5,"grossBp":28.7,"costBp":2,"netBp":26.7,"tStat":2.3,"sharpe":0.37,"annReturnPct":4.6,"maxDdPct":67.8,"pctYearsPositive":61,"isExp":0.99,"oosExp":-0.769,"oosTrades":56,"dsr":0.05,"verdict":"fails","byYear":{"1991":-3,"1992":-18.4,"1993":-10.7,"1994":14.1,"1995":27.2,"1996":8.7,"1997":-4.9,"1998":5.4,"1999":16.9,"2000":11.1,"2003":4.8,"2004":23.9,"2005":-2.4,"2006":7.7,"2007":5.9,"2009":10.6,"2010":9.2,"2011":6.1,"2012":20.3,"2013":35.4,"2014":-4,"2015":18.8,"2016":24.8,"2017":24.4,"2018":-2.6,"2019":-16.3,"2020":-3.1,"2021":9.5,"2022":-11.9,"2023":-15.4,"2024":-16.4,"2025":0.9,"2026":-6.6}},{"id":"ibs|FTSE|1d","strategy":"ibs","name":"IBS Reversal","market":"FTSE","marketLabel":"FTSE 100","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":1263,"tradesPerYear":34.2,"winRate":64.1,"grossBp":13.1,"costBp":2,"netBp":11.1,"tStat":1.99,"sharpe":0.33,"annReturnPct":8.2,"maxDdPct":94.5,"pctYearsPositive":59,"isExp":0.249,"oosExp":0.189,"oosTrades":220,"dsr":0.02,"verdict":"mixed","byYear":{"1990":-22.3,"1991":32.5,"1992":23.7,"1993":44.2,"1994":-7.7,"1995":35.2,"1996":19.4,"1997":-16.2,"1998":-23,"1999":-3.9,"2000":13.8,"2001":-4.1,"2002":-22.5,"2003":39.2,"2004":41.1,"2005":52.3,"2006":26.6,"2007":4.5,"2008":-29.9,"2009":25.1,"2010":26.1,"2011":14,"2012":16.4,"2013":33.7,"2014":-20.4,"2015":-21.1,"2016":17.9,"2017":3.1,"2018":-15.2,"2019":-23.2,"2020":-25.4,"2021":18.4,"2022":5,"2023":-12.9,"2024":-2.8,"2025":11.6,"2026":48.3},"financing":{"nights":3.5,"finBp":1.7,"netAfterBp":9.4,"crypto20AfterBp":null}},{"id":"turn_of_month|FTSE|1d","strategy":"turn_of_month","name":"Turn of the Month","market":"FTSE","marketLabel":"FTSE 100","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":432,"tradesPerYear":11.7,"winRate":57.6,"grossBp":33.6,"costBp":2,"netBp":31.6,"tStat":3.59,"sharpe":0.58,"annReturnPct":9.4,"maxDdPct":55.4,"pctYearsPositive":70,"isExp":0.793,"oosExp":0.824,"oosTrades":81,"dsr":0.32,"verdict":"holds","byYear":{"1990":12.4,"1991":17.9,"1992":-7.9,"1993":22.6,"1994":1.1,"1995":32.8,"1996":12.8,"1997":25.2,"1998":4.9,"1999":28.4,"2000":18.8,"2001":3.4,"2002":-23.2,"2003":25.4,"2004":11.7,"2005":46.6,"2006":7.2,"2007":13.2,"2008":-1.5,"2009":-3.2,"2010":36.7,"2011":-7.5,"2012":19.8,"2013":-1.7,"2014":-8,"2015":0.9,"2016":-26.5,"2017":28.9,"2018":-18.6,"2019":6.1,"2020":14.5,"2021":25,"2022":8.4,"2023":-5.1,"2024":-13.3,"2025":13,"2026":23.9},"robust":{"variants":15,"positive":15,"strong":9,"medianSharpe":0.41,"worstSharpe":0.29,"bestSharpe":0.58,"windows":33,"negWindows":4,"worstWindow":{"from":2014,"to":2018,"sharpe":-0.31},"net2x":29.6,"net3x":27.6,"baseLabel":"enter 1 day left, exit day 3"},"check":{"status":"weaker","staleOpenPct":72,"sameTrades":432,"researchTrades":432,"since2000":{"trades":317,"netBp":24.5,"t":2.15,"yearsUp":67},"since2010":{"trades":198,"netBp":13.4,"t":1.01,"yearsUp":53},"since2023":{"trades":46,"netBp":9.3,"t":0.47,"yearsUp":50},"closeEntry":{"trades":432,"netBp":33.8,"t":3.46,"yearsUp":70},"cost2x":{"trades":432,"netBp":29.7,"t":3.07,"yearsUp":70},"etf":null},"financing":{"nights":4.5,"finBp":2.1,"netAfterBp":29.5,"crypto20AfterBp":null}},{"id":"rsi2|N225|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"N225","marketLabel":"Nikkei 225","tf":"1d","sizing":"vol","from":1991,"to":2026,"trades":224,"tradesPerYear":6.2,"winRate":68.8,"grossBp":18.7,"costBp":3,"netBp":15.7,"tStat":1.14,"sharpe":0.19,"annReturnPct":2,"maxDdPct":29.7,"pctYearsPositive":58,"isExp":0.13,"oosExp":0.922,"oosTrades":58,"dsr":0,"verdict":"fails","byYear":{"1991":-3.8,"1993":-1.4,"1994":-0.7,"1995":4.7,"1996":-9.4,"1997":1.4,"1998":-1.3,"1999":13.4,"2000":11.3,"2002":-19.6,"2003":5.4,"2004":-7.3,"2005":14.9,"2006":-4.8,"2007":1.5,"2009":-16.4,"2010":8.3,"2011":-2.4,"2012":-2.7,"2013":11.7,"2014":-5.4,"2015":-5.7,"2016":3.4,"2017":21.2,"2018":19.8,"2019":-14.3,"2020":19.1,"2021":13.6,"2022":1,"2023":6.8,"2024":7.2,"2025":0.7,"2026":5.1}},{"id":"ibs|N225|1d","strategy":"ibs","name":"IBS Reversal","market":"N225","marketLabel":"Nikkei 225","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":1297,"tradesPerYear":35.2,"winRate":60.4,"grossBp":12.9,"costBp":3,"netBp":9.9,"tStat":0.24,"sharpe":0.04,"annReturnPct":0.9,"maxDdPct":163.4,"pctYearsPositive":51,"isExp":0.007,"oosExp":0.119,"oosTrades":215,"dsr":0,"verdict":"fails","byYear":{"1990":-61.2,"1991":-13.1,"1992":-32.9,"1993":-28.5,"1994":14.9,"1995":-21.8,"1996":-3.4,"1997":2.8,"1998":-6.7,"1999":42.5,"2000":-31.5,"2001":17.5,"2002":-12.1,"2003":-0.4,"2004":23.2,"2005":45.8,"2006":19.7,"2007":-21.3,"2008":-20.1,"2009":7.6,"2010":41,"2011":-3.9,"2012":-6.5,"2013":61.6,"2014":0.7,"2015":-4.4,"2016":8.9,"2017":6.8,"2018":-37,"2019":24.7,"2020":4,"2021":-31.4,"2022":8.1,"2023":5.6,"2024":10.1,"2025":25,"2026":-1.4}},{"id":"turn_of_month|N225|1d","strategy":"turn_of_month","name":"Turn of the Month","market":"N225","marketLabel":"Nikkei 225","tf":"1d","sizing":"vol","from":1990,"to":2026,"trades":420,"tradesPerYear":11.4,"winRate":51.7,"grossBp":6.8,"costBp":3,"netBp":3.8,"tStat":0.68,"sharpe":0.11,"annReturnPct":1.7,"maxDdPct":65.6,"pctYearsPositive":49,"isExp":0.104,"oosExp":0.347,"oosTrades":78,"dsr":0,"verdict":"fails","byYear":{"1990":-9.3,"1991":-4.1,"1992":-2.7,"1993":15.4,"1994":23.3,"1995":7.5,"1996":3,"1997":-22.8,"1998":-5.4,"1999":-0.6,"2000":10.8,"2001":-15.3,"2002":-14.8,"2003":21.6,"2004":10.8,"2005":43.1,"2006":9.1,"2007":-8.6,"2008":-22.8,"2009":7.6,"2010":12.6,"2011":-2,"2012":-20.1,"2013":-4.3,"2014":1.4,"2015":-3.7,"2016":-25.4,"2017":40.7,"2018":-5.3,"2019":-4,"2020":18.7,"2021":5.5,"2022":-2.9,"2023":12.8,"2024":10,"2025":-30.7,"2026":13.6}},{"id":"rsi2|STOXX|1d","strategy":"rsi2","name":"RSI(2) Pullback","market":"STOXX","marketLabel":"Euro Stoxx 50","tf":"1d","sizing":"vol","from":2009,"to":2026,"trades":129,"tradesPerYear":7.2,"winRate":69.8,"grossBp":23.3,"costBp":4,"netBp":19.3,"tStat":0.81,"sharpe":0.19,"annReturnPct":2.1,"maxDdPct":36.6,"pctYearsPositive":67,"isExp":0.161,"oosExp":0.499,"oosTrades":57,"dsr":0.02,"verdict":"fails","byYear":{"2009":12.3,"2010":-0.8,"2011":-7.4,"2012":7.7,"2013":1.1,"2014":5.4,"2015":1.6,"2016":-9.4,"2017":1.2,"2018":-9.9,"2019":9.8,"2020":-7.3,"2021":7.8,"2022":7,"2023":4.1,"2024":12.9,"2025":-0.6,"2026":4.5}},{"id":"ibs|STOXX|1d","strategy":"ibs","name":"IBS Reversal","market":"STOXX","marketLabel":"Euro Stoxx 50","tf":"1d","sizing":"vol","from":2008,"to":2026,"trades":585,"tradesPerYear":31,"winRate":60,"grossBp":3.5,"costBp":4,"netBp":-0.5,"tStat":-0.58,"sharpe":-0.13,"annReturnPct":-2.9,"maxDdPct":111.6,"pctYearsPositive":47,"isExp":-0.069,"oosExp":-0.134,"oosTrades":220,"dsr":0,"verdict":"fails","byYear":{"2008":-4.3,"2009":15.5,"2010":-13.5,"2011":16.1,"2012":7,"2013":8.5,"2014":-24.5,"2015":3.3,"2016":-13.9,"2017":26.7,"2018":-37.1,"2019":-9.1,"2020":-20.2,"2021":0.4,"2022":-9.7,"2023":-4.8,"2024":-0.4,"2025":2.9,"2026":2.3}},{"id":"turn_of_month|STOXX|1d","strategy":"turn_of_month","name":"Turn of the Month","market":"STOXX","marketLabel":"Euro Stoxx 50","tf":"1d","sizing":"vol","from":2008,"to":2026,"trades":222,"tradesPerYear":11.8,"winRate":54.5,"grossBp":10.1,"costBp":4,"netBp":6.1,"tStat":-0.04,"sharpe":-0.01,"annReturnPct":-0.1,"maxDdPct":61.1,"pctYearsPositive":47,"isExp":-0.179,"oosExp":0.275,"oosTrades":82,"dsr":0,"verdict":"fails","byYear":{"2008":3.7,"2009":-8.6,"2010":28,"2011":-7.8,"2012":12.3,"2013":-22.6,"2014":-5.8,"2015":2,"2016":-32.2,"2017":25.2,"2018":-14.2,"2019":-5.1,"2020":14.5,"2021":20,"2022":-6.5,"2023":8.4,"2024":-19,"2025":-7.8,"2026":12.9}},{"id":"month_end_rebal|RUT|1d","strategy":"month_end_rebal","name":"Month-End Rebalancing Flow","market":"RUT","marketLabel":"Russell 2000","tf":"1d","sizing":"vol","from":2002,"to":2026,"trades":281,"tradesPerYear":11.3,"winRate":54.1,"grossBp":56.8,"costBp":3,"netBp":53.8,"tStat":3.2,"sharpe":0.52,"annReturnPct":6.4,"maxDdPct":28.5,"pctYearsPositive":84,"isExp":0.7,"oosExp":1.218,"oosTrades":79,"dsr":0.17,"verdict":"holds","byYear":{"2002":-7,"2003":13.2,"2004":22.7,"2005":-4.4,"2006":7,"2007":17.6,"2008":3,"2009":11.3,"2010":4.6,"2011":17.8,"2012":10.2,"2013":12.6,"2014":-17.7,"2015":11.9,"2016":1.1,"2017":8.4,"2018":38.1,"2019":-8.9,"2020":36.3,"2021":14.7,"2022":5.3,"2023":12.4,"2024":3.7,"2025":19.9,"2026":3.9},"robust":{"variants":7,"positive":7,"strong":7,"medianSharpe":0.42,"worstSharpe":0.37,"bestSharpe":0.56,"windows":23,"negWindows":0,"worstWindow":{"from":2013,"to":2017,"sharpe":0.23},"net2x":50.8,"net3x":47.8,"baseLabel":"last 5 days"},"check":{"status":"passed","staleOpenPct":18,"sameTrades":281,"researchTrades":281,"since2000":{"trades":281,"netBp":53.8,"t":3.15,"yearsUp":72},"since2010":{"trades":195,"netBp":49.9,"t":2.75,"yearsUp":76},"since2023":{"trades":45,"netBp":48.8,"t":1.78,"yearsUp":75},"closeEntry":{"trades":281,"netBp":48.4,"t":2.81,"yearsUp":64},"cost2x":{"trades":281,"netBp":50.8,"t":2.97,"yearsUp":72},"etf":{"symbol":"IWM","from":2000,"base":{"trades":281,"netBp":55.3,"t":3.3,"yearsUp":80},"closeEntry":{"trades":281,"netBp":47.8,"t":2.76,"yearsUp":68},"cost2x":{"trades":281,"netBp":53.3,"t":3.18,"yearsUp":80},"since2023":{"trades":45,"netBp":53.2,"t":1.95,"yearsUp":75}}},"financing":{"nights":5,"finBp":3.2,"netAfterBp":50.6,"crypto20AfterBp":null}}],"prop":[{"id":"coin_flip_baseline","kind":"baseline","verdict":null,"name":null,"overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.106,"recent":0.206,"noEdge":0.064,"fail":0.393,"timeout":0.501,"attempts":682,"recentAttempts":97,"medDays":190,"reasons":{"max loss":268}},"0.005":{"pass":0.201,"recent":0.305,"noEdge":0.155,"fail":0.798,"timeout":0.001,"attempts":703,"recentAttempts":118,"medDays":74,"reasons":{"max loss":561}},"0.01":{"pass":0.234,"recent":0.264,"noEdge":0.201,"fail":0.766,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":16,"reasons":{"max loss":555}},"0.02":{"pass":0.3,"recent":0.276,"noEdge":0.222,"fail":0.7,"timeout":0,"attempts":730,"recentAttempts":145,"medDays":5,"reasons":{"max loss":511}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":null,"reasons":{"time limit":725}},"0.005":{"pass":0.004,"recent":0,"noEdge":0.003,"fail":0.996,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":20,"reasons":{"time limit":644,"max loss":78}},"0.01":{"pass":0.167,"recent":0.171,"noEdge":0.117,"fail":0.833,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":12,"reasons":{"time limit":157,"max loss":447}},"0.02":{"pass":0.3,"recent":0.276,"noEdge":0.222,"fail":0.7,"timeout":0,"attempts":730,"recentAttempts":145,"medDays":5,"reasons":{"max loss":511}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":null,"reasons":{"time limit":725}},"0.005":{"pass":0.004,"recent":0,"noEdge":0.003,"fail":0.996,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":20,"reasons":{"time limit":644,"max loss":78}},"0.01":{"pass":0.167,"recent":0.171,"noEdge":0.117,"fail":0.833,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":12,"reasons":{"time limit":157,"max loss":447}},"0.02":{"pass":0.3,"recent":0.276,"noEdge":0.222,"fail":0.7,"timeout":0,"attempts":730,"recentAttempts":145,"medDays":5,"reasons":{"max loss":511}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0.106,"recent":0.206,"noEdge":0.064,"fail":0.399,"timeout":0.496,"attempts":682,"recentAttempts":97,"medDays":190,"reasons":{"max loss":272}},"0.005":{"pass":0.201,"recent":0.305,"noEdge":0.15,"fail":0.798,"timeout":0.001,"attempts":703,"recentAttempts":118,"medDays":74,"reasons":{"max loss":561}},"0.01":{"pass":0.234,"recent":0.264,"noEdge":0.2,"fail":0.766,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":16,"reasons":{"max loss":555}},"0.02":{"pass":0.3,"recent":0.276,"noEdge":0.222,"fail":0.7,"timeout":0,"attempts":730,"recentAttempts":145,"medDays":5,"reasons":{"max loss":511}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":658,"recentAttempts":73,"medDays":null,"reasons":{}},"0.005":{"pass":0.024,"recent":0.024,"noEdge":0.003,"fail":0.063,"timeout":0.913,"attempts":667,"recentAttempts":82,"medDays":102,"reasons":{"max loss":42}},"0.01":{"pass":0.209,"recent":0.295,"noEdge":0.185,"fail":0.577,"timeout":0.214,"attempts":697,"recentAttempts":112,"medDays":21,"reasons":{"max loss":402}},"0.02":{"pass":0.31,"recent":0.417,"noEdge":0.276,"fail":0.69,"timeout":0,"attempts":717,"recentAttempts":132,"medDays":13,"reasons":{"max loss":495}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":658,"recentAttempts":73,"medDays":null,"reasons":{}},"0.005":{"pass":0.199,"recent":0.447,"noEdge":0.129,"fail":0.168,"timeout":0.633,"attempts":679,"recentAttempts":94,"medDays":174,"reasons":{"max loss":114}},"0.01":{"pass":0.366,"recent":0.487,"noEdge":0.302,"fail":0.634,"timeout":0,"attempts":702,"recentAttempts":117,"medDays":70,"reasons":{"max loss":445}},"0.02":{"pass":0.389,"recent":0.4,"noEdge":0.316,"fail":0.611,"timeout":0,"attempts":725,"recentAttempts":140,"medDays":15,"reasons":{"max loss":443}}}}}},{"id":"turtle|CL|1d","kind":"single","verdict":"mixed","name":"Turtle Breakout 20/10","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":792,"recentAttempts":214,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":792,"recentAttempts":214,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":792,"recentAttempts":214,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":792,"recentAttempts":214,"medDays":null,"reasons":{}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":792,"recentAttempts":214,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":792,"recentAttempts":214,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":792,"recentAttempts":214,"medDays":null,"reasons":{}},"0.02":{"pass":0.006,"recent":0.023,"noEdge":0.006,"fail":0,"timeout":0.994,"attempts":792,"recentAttempts":214,"medDays":3,"reasons":{}}}}}},{"id":"turtle|USDJPY|1h","kind":"single","verdict":"holds","name":"Turtle Breakout 20/10","overnightShare":0.6,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.04,"recent":0.094,"noEdge":0.004,"fail":0,"timeout":0.96,"attempts":1011,"recentAttempts":427,"medDays":47,"reasons":{}},"0.005":{"pass":0.272,"recent":0.294,"noEdge":0.105,"fail":0.163,"timeout":0.565,"attempts":1040,"recentAttempts":456,"medDays":31,"reasons":{"max loss":169}},"0.01":{"pass":0.388,"recent":0.487,"noEdge":0.226,"fail":0.578,"timeout":0.034,"attempts":1075,"recentAttempts":491,"medDays":19,"reasons":{"max loss":621}},"0.02":{"pass":0.243,"recent":0.254,"noEdge":0.188,"fail":0.757,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":6,"reasons":{"max loss":711,"daily loss":107}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.159,"recent":0.208,"noEdge":0.059,"fail":0,"timeout":0.841,"attempts":1011,"recentAttempts":427,"medDays":114,"reasons":{}},"0.005":{"pass":0.469,"recent":0.595,"noEdge":0.229,"fail":0.283,"timeout":0.248,"attempts":1041,"recentAttempts":457,"medDays":89,"reasons":{"max loss":295}},"0.01":{"pass":0.32,"recent":0.395,"noEdge":0.186,"fail":0.679,"timeout":0.001,"attempts":1078,"recentAttempts":494,"medDays":33,"reasons":{"max loss":661,"daily loss":71}},"0.02":{"pass":0.114,"recent":0.118,"noEdge":0.08,"fail":0.886,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":9,"reasons":{"daily loss":694,"max loss":265}}}}}},{"id":"turtle|BTC|1d","kind":"single","verdict":"holds","name":"Turtle Breakout 20/10","overnightShare":0.96,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":797,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":797,"recentAttempts":422,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":797,"recentAttempts":422,"medDays":null,"reasons":{}},"0.02":{"pass":0.01,"recent":0.019,"noEdge":0,"fail":0.029,"timeout":0.961,"attempts":797,"recentAttempts":422,"medDays":4,"reasons":{"max loss":23}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":797,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0.055,"recent":0.052,"noEdge":0,"fail":0,"timeout":0.945,"attempts":797,"recentAttempts":422,"medDays":4,"reasons":{}},"0.01":{"pass":0.055,"recent":0.052,"noEdge":0,"fail":0,"timeout":0.945,"attempts":797,"recentAttempts":422,"medDays":4,"reasons":{}},"0.02":{"pass":0.055,"recent":0.052,"noEdge":0,"fail":0.036,"timeout":0.908,"attempts":797,"recentAttempts":422,"medDays":4,"reasons":{"max loss":29}}}}}},{"id":"turtle|ETH|1d","kind":"single","verdict":"mixed","name":"Turtle Breakout 20/10","overnightShare":0.96,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":572,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":572,"recentAttempts":422,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":572,"recentAttempts":422,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.031,"timeout":0.969,"attempts":572,"recentAttempts":422,"medDays":null,"reasons":{"max loss":18}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":572,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0.023,"recent":0.031,"noEdge":0,"fail":0,"timeout":0.977,"attempts":572,"recentAttempts":422,"medDays":6,"reasons":{}},"0.01":{"pass":0.063,"recent":0.036,"noEdge":0,"fail":0,"timeout":0.937,"attempts":572,"recentAttempts":422,"medDays":4,"reasons":{}},"0.02":{"pass":0.063,"recent":0.036,"noEdge":0,"fail":0.07,"timeout":0.867,"attempts":572,"recentAttempts":422,"medDays":4,"reasons":{"max loss":40}}}}}},{"id":"donchian55|NQ|1d","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":0.99,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.088,"timeout":0.912,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{"max loss":229}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.096,"timeout":0.904,"attempts":2588,"recentAttempts":423,"medDays":null,"reasons":{"max loss":249}}}}}},{"id":"donchian55|GC|1h","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":0.66,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.006,"recent":0,"noEdge":0.001,"fail":0.008,"timeout":0.986,"attempts":1010,"recentAttempts":426,"medDays":24,"reasons":{"max loss":8}},"0.005":{"pass":0.199,"recent":0.207,"noEdge":0.123,"fail":0.194,"timeout":0.607,"attempts":1010,"recentAttempts":426,"medDays":16,"reasons":{"max loss":196}},"0.01":{"pass":0.391,"recent":0.349,"noEdge":0.223,"fail":0.467,"timeout":0.141,"attempts":1040,"recentAttempts":456,"medDays":13,"reasons":{"max loss":486}},"0.02":{"pass":0.249,"recent":0.24,"noEdge":0.141,"fail":0.751,"timeout":0,"attempts":1075,"recentAttempts":491,"medDays":5,"reasons":{"max loss":804,"daily loss":3}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.109,"recent":0.042,"noEdge":0.085,"fail":0.012,"timeout":0.879,"attempts":1010,"recentAttempts":426,"medDays":62,"reasons":{"max loss":12}},"0.005":{"pass":0.307,"recent":0.265,"noEdge":0.197,"fail":0.236,"timeout":0.457,"attempts":1010,"recentAttempts":426,"medDays":59,"reasons":{"max loss":238}},"0.01":{"pass":0.311,"recent":0.234,"noEdge":0.179,"fail":0.655,"timeout":0.035,"attempts":1072,"recentAttempts":488,"medDays":44,"reasons":{"max loss":666,"daily loss":36}},"0.02":{"pass":0.076,"recent":0.122,"noEdge":0.05,"fail":0.924,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":9,"reasons":{"max loss":640,"daily loss":355}}}}}},{"id":"donchian55|GC|4h","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":0.89,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1006,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1006,"recentAttempts":426,"medDays":null,"reasons":{}},"0.01":{"pass":0.106,"recent":0.138,"noEdge":0.043,"fail":0.1,"timeout":0.793,"attempts":1006,"recentAttempts":426,"medDays":6,"reasons":{"max loss":101}},"0.02":{"pass":0.229,"recent":0.26,"noEdge":0.116,"fail":0.53,"timeout":0.241,"attempts":1018,"recentAttempts":438,"medDays":5,"reasons":{"max loss":540}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1006,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0.029,"recent":0.068,"noEdge":0.015,"fail":0,"timeout":0.971,"attempts":1006,"recentAttempts":426,"medDays":12,"reasons":{}},"0.01":{"pass":0.17,"recent":0.207,"noEdge":0.041,"fail":0.105,"timeout":0.725,"attempts":1006,"recentAttempts":426,"medDays":17,"reasons":{"max loss":106}},"0.02":{"pass":0.119,"recent":0.098,"noEdge":0.063,"fail":0.778,"timeout":0.102,"attempts":1038,"recentAttempts":458,"medDays":12,"reasons":{"max loss":808}}}}}},{"id":"donchian55|GC|1d","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.005,"timeout":0.995,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{"max loss":9}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.045,"timeout":0.955,"attempts":1767,"recentAttempts":414,"medDays":null,"reasons":{"daily loss":71,"max loss":9}}}}}},{"id":"donchian55|USDJPY|1h","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":0.66,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0.191,"recent":0.182,"noEdge":0.094,"fail":0.151,"timeout":0.657,"attempts":1024,"recentAttempts":440,"medDays":19,"reasons":{"max loss":155}},"0.01":{"pass":0.329,"recent":0.288,"noEdge":0.211,"fail":0.636,"timeout":0.035,"attempts":1049,"recentAttempts":465,"medDays":13,"reasons":{"max loss":667}},"0.02":{"pass":0.251,"recent":0.226,"noEdge":0.175,"fail":0.749,"timeout":0,"attempts":1079,"recentAttempts":495,"medDays":5,"reasons":{"max loss":806,"daily loss":2}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.085,"recent":0.054,"noEdge":0.037,"fail":0,"timeout":0.915,"attempts":1010,"recentAttempts":426,"medDays":70,"reasons":{}},"0.005":{"pass":0.293,"recent":0.285,"noEdge":0.211,"fail":0.393,"timeout":0.314,"attempts":1036,"recentAttempts":452,"medDays":56,"reasons":{"max loss":407}},"0.01":{"pass":0.365,"recent":0.276,"noEdge":0.212,"fail":0.635,"timeout":0,"attempts":1076,"recentAttempts":492,"medDays":34,"reasons":{"max loss":676,"daily loss":7}},"0.02":{"pass":0.147,"recent":0.084,"noEdge":0.09,"fail":0.853,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":12,"reasons":{"max loss":689,"daily loss":235}}}}}},{"id":"donchian55|BTC|1d","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":0.95,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":754,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":754,"recentAttempts":422,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":754,"recentAttempts":422,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":754,"recentAttempts":422,"medDays":null,"reasons":{}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":754,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0.016,"recent":0,"noEdge":0,"fail":0,"timeout":0.984,"attempts":754,"recentAttempts":422,"medDays":3,"reasons":{}},"0.01":{"pass":0.016,"recent":0,"noEdge":0,"fail":0,"timeout":0.984,"attempts":754,"recentAttempts":422,"medDays":3,"reasons":{}},"0.02":{"pass":0.016,"recent":0,"noEdge":0,"fail":0,"timeout":0.984,"attempts":754,"recentAttempts":422,"medDays":3,"reasons":{}}}}}},{"id":"donchian55|ETH|4h","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":0.94,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":560,"recentAttempts":419,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":560,"recentAttempts":419,"medDays":null,"reasons":{}},"0.01":{"pass":0.213,"recent":0.104,"noEdge":0.05,"fail":0.164,"timeout":0.623,"attempts":592,"recentAttempts":451,"medDays":8,"reasons":{"max loss":97}},"0.02":{"pass":0.285,"recent":0.181,"noEdge":0.106,"fail":0.557,"timeout":0.158,"attempts":600,"recentAttempts":459,"medDays":4,"reasons":{"max loss":334}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":560,"recentAttempts":419,"medDays":null,"reasons":{}},"0.005":{"pass":0.036,"recent":0.002,"noEdge":0,"fail":0,"timeout":0.964,"attempts":560,"recentAttempts":419,"medDays":9,"reasons":{}},"0.01":{"pass":0.076,"recent":0.002,"noEdge":0.032,"fail":0.201,"timeout":0.723,"attempts":592,"recentAttempts":451,"medDays":9,"reasons":{"max loss":119}},"0.02":{"pass":0.08,"recent":0.009,"noEdge":0.031,"fail":0.748,"timeout":0.172,"attempts":600,"recentAttempts":459,"medDays":7,"reasons":{"max loss":449}}}}}},{"id":"donchian55|ETH|1d","kind":"single","verdict":"mixed","name":"Turtle Breakout 55/20","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":567,"recentAttempts":422,"medDays":null,"reasons":{}}}}}},{"id":"rsi2|ES|1d","kind":"single","verdict":"holds","name":"RSI(2) Pullback","overnightShare":0.99,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2532,"recentAttempts":427,"medDays":null,"reasons":{}},"0.005":{"pass":0.033,"recent":0.044,"noEdge":0.002,"fail":0.146,"timeout":0.821,"attempts":2532,"recentAttempts":427,"medDays":4,"reasons":{"daily loss":320,"max loss":49}},"0.01":{"pass":0.052,"recent":0.018,"noEdge":0.006,"fail":0.768,"timeout":0.18,"attempts":2594,"recentAttempts":489,"medDays":4,"reasons":{"daily loss":1877,"max loss":116}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.902,"timeout":0.098,"attempts":2601,"recentAttempts":496,"medDays":null,"reasons":{"daily loss":1616,"max loss":730}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.003,"recent":0.016,"noEdge":0,"fail":0.028,"timeout":0.968,"attempts":2532,"recentAttempts":427,"medDays":11,"reasons":{"daily loss":72}},"0.005":{"pass":0.083,"recent":0.108,"noEdge":0.006,"fail":0.728,"timeout":0.189,"attempts":2594,"recentAttempts":489,"medDays":8,"reasons":{"daily loss":1889}},"0.01":{"pass":0.088,"recent":0.067,"noEdge":0.021,"fail":0.823,"timeout":0.09,"attempts":2594,"recentAttempts":489,"medDays":3,"reasons":{"daily loss":2016,"max loss":118}},"0.02":{"pass":0.026,"recent":0.022,"noEdge":0,"fail":0.899,"timeout":0.075,"attempts":2604,"recentAttempts":499,"medDays":3,"reasons":{"daily loss":1392,"max loss":949}}}}}},{"id":"ibs|ES|1d","kind":"single","verdict":"mixed","name":"IBS Reversal","overnightShare":0.99,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.046,"timeout":0.954,"attempts":2611,"recentAttempts":428,"medDays":null,"reasons":{"max loss":121}},"0.005":{"pass":0.16,"recent":0.31,"noEdge":0.08,"fail":0.524,"timeout":0.315,"attempts":2625,"recentAttempts":442,"medDays":7,"reasons":{"daily loss":831,"max loss":545}},"0.01":{"pass":0.054,"recent":0.071,"noEdge":0.035,"fail":0.946,"timeout":0,"attempts":2662,"recentAttempts":479,"medDays":4,"reasons":{"daily loss":2406,"max loss":113}},"0.02":{"pass":0.004,"recent":0.002,"noEdge":0.003,"fail":0.996,"timeout":0,"attempts":2672,"recentAttempts":489,"medDays":4,"reasons":{"max loss":893,"daily loss":1767}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.082,"recent":0.175,"noEdge":0.021,"fail":0.12,"timeout":0.798,"attempts":2611,"recentAttempts":428,"medDays":27,"reasons":{"daily loss":145,"max loss":169}},"0.005":{"pass":0.076,"recent":0.087,"noEdge":0.056,"fail":0.924,"timeout":0,"attempts":2653,"recentAttempts":470,"medDays":9,"reasons":{"daily loss":2451}},"0.01":{"pass":0.079,"recent":0.125,"noEdge":0.053,"fail":0.921,"timeout":0,"attempts":2680,"recentAttempts":497,"medDays":4,"reasons":{"daily loss":2386,"max loss":83}},"0.02":{"pass":0.039,"recent":0.111,"noEdge":0.033,"fail":0.961,"timeout":0,"attempts":2680,"recentAttempts":497,"medDays":3,"reasons":{"daily loss":1609,"max loss":966}}}}}},{"id":"rsi2|NQ|1d","kind":"single","verdict":"holds","name":"RSI(2) Pullback","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.028,"timeout":0.972,"attempts":2532,"recentAttempts":427,"medDays":null,"reasons":{"daily loss":72}},"0.005":{"pass":0.012,"recent":0,"noEdge":0,"fail":0.128,"timeout":0.86,"attempts":2532,"recentAttempts":427,"medDays":5,"reasons":{"daily loss":273,"max loss":51}},"0.01":{"pass":0.045,"recent":0.028,"noEdge":0,"fail":0.811,"timeout":0.144,"attempts":2604,"recentAttempts":499,"medDays":4,"reasons":{"daily loss":2029,"max loss":83}},"0.02":{"pass":0.001,"recent":0.006,"noEdge":0,"fail":0.929,"timeout":0.07,"attempts":2604,"recentAttempts":499,"medDays":4,"reasons":{"daily loss":1793,"max loss":625}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.003,"recent":0,"noEdge":0,"fail":0.028,"timeout":0.969,"attempts":2532,"recentAttempts":427,"medDays":15,"reasons":{"daily loss":72}},"0.005":{"pass":0.076,"recent":0.13,"noEdge":0,"fail":0.721,"timeout":0.203,"attempts":2604,"recentAttempts":499,"medDays":10,"reasons":{"daily loss":1844,"max loss":33}},"0.01":{"pass":0.086,"recent":0.072,"noEdge":0.023,"fail":0.831,"timeout":0.083,"attempts":2604,"recentAttempts":499,"medDays":4,"reasons":{"daily loss":2104,"max loss":61}},"0.02":{"pass":0.048,"recent":0.04,"noEdge":0.004,"fail":0.891,"timeout":0.061,"attempts":2604,"recentAttempts":499,"medDays":3,"reasons":{"daily loss":1571,"max loss":748}}}}}},{"id":"ibs|NQ|1d","kind":"single","verdict":"holds","name":"IBS Reversal","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.002,"recent":0.014,"noEdge":0,"fail":0.087,"timeout":0.91,"attempts":2614,"recentAttempts":428,"medDays":14,"reasons":{"max loss":156,"daily loss":72}},"0.005":{"pass":0.246,"recent":0.451,"noEdge":0.106,"fail":0.535,"timeout":0.218,"attempts":2614,"recentAttempts":428,"medDays":8,"reasons":{"max loss":379,"daily loss":1020}},"0.01":{"pass":0.069,"recent":0.127,"noEdge":0.042,"fail":0.931,"timeout":0,"attempts":2665,"recentAttempts":479,"medDays":4,"reasons":{"daily loss":2254,"max loss":226}},"0.02":{"pass":0.001,"recent":0,"noEdge":0,"fail":0.999,"timeout":0,"attempts":2682,"recentAttempts":496,"medDays":4,"reasons":{"daily loss":1814,"max loss":866}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.146,"recent":0.245,"noEdge":0.032,"fail":0.205,"timeout":0.65,"attempts":2614,"recentAttempts":428,"medDays":28,"reasons":{"max loss":235,"daily loss":300}},"0.005":{"pass":0.105,"recent":0.115,"noEdge":0.045,"fail":0.895,"timeout":0,"attempts":2665,"recentAttempts":479,"medDays":9,"reasons":{"daily loss":2351,"max loss":34}},"0.01":{"pass":0.069,"recent":0.083,"noEdge":0.046,"fail":0.931,"timeout":0,"attempts":2682,"recentAttempts":496,"medDays":4,"reasons":{"daily loss":2338,"max loss":158}},"0.02":{"pass":0.032,"recent":0.05,"noEdge":0.013,"fail":0.968,"timeout":0,"attempts":2683,"recentAttempts":497,"medDays":3,"reasons":{"daily loss":1595,"max loss":1001}}}}}},{"id":"ibs|GC|1d","kind":"single","verdict":"mixed","name":"IBS Reversal","overnightShare":0.99,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.029,"timeout":0.971,"attempts":1799,"recentAttempts":430,"medDays":null,"reasons":{"max loss":53}},"0.005":{"pass":0.147,"recent":0.144,"noEdge":0.068,"fail":0.436,"timeout":0.418,"attempts":1856,"recentAttempts":487,"medDays":9,"reasons":{"max loss":379,"daily loss":430}},"0.01":{"pass":0.147,"recent":0.066,"noEdge":0.076,"fail":0.839,"timeout":0.014,"attempts":1871,"recentAttempts":502,"medDays":4,"reasons":{"daily loss":1401,"max loss":168}},"0.02":{"pass":0.013,"recent":0,"noEdge":0.005,"fail":0.987,"timeout":0,"attempts":1871,"recentAttempts":502,"medDays":4,"reasons":{"daily loss":1411,"max loss":435}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.077,"recent":0.098,"noEdge":0.034,"fail":0.212,"timeout":0.711,"attempts":1839,"recentAttempts":470,"medDays":24,"reasons":{"max loss":112,"daily loss":278}},"0.005":{"pass":0.174,"recent":0.113,"noEdge":0.131,"fail":0.803,"timeout":0.023,"attempts":1866,"recentAttempts":497,"medDays":11,"reasons":{"daily loss":1484,"max loss":14}},"0.01":{"pass":0.075,"recent":0.084,"noEdge":0.046,"fail":0.925,"timeout":0,"attempts":1871,"recentAttempts":502,"medDays":4,"reasons":{"daily loss":1649,"max loss":82}},"0.02":{"pass":0.026,"recent":0.028,"noEdge":0.019,"fail":0.974,"timeout":0,"attempts":1871,"recentAttempts":502,"medDays":3,"reasons":{"daily loss":1418,"max loss":404}}}}}},{"id":"tsmom|ES|1d","kind":"single","verdict":"mixed","name":"12-Month Trend (time-series momentum)","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.063,"timeout":0.937,"attempts":2431,"recentAttempts":312,"medDays":null,"reasons":{"max loss":154}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.086,"timeout":0.914,"attempts":2431,"recentAttempts":312,"medDays":null,"reasons":{"max loss":205,"daily loss":5}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0.283,"timeout":0.717,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"daily loss":629,"max loss":80}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.396,"timeout":0.604,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"max loss":299,"daily loss":691}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.078,"timeout":0.922,"attempts":2431,"recentAttempts":312,"medDays":null,"reasons":{"max loss":125,"daily loss":65}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.184,"timeout":0.816,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"daily loss":399,"max loss":61}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0.362,"timeout":0.638,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"daily loss":862,"max loss":44}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.435,"timeout":0.565,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"daily loss":814,"max loss":274}}}}}},{"id":"tsmom|NQ|1d","kind":"single","verdict":"mixed","name":"12-Month Trend (time-series momentum)","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2431,"recentAttempts":312,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.174,"timeout":0.826,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"daily loss":200,"max loss":236}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0.332,"timeout":0.668,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"max loss":225,"daily loss":605}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.446,"timeout":0.554,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"max loss":627,"daily loss":489}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.046,"timeout":0.954,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"daily loss":114}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.276,"timeout":0.724,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"daily loss":690}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":0.404,"timeout":0.596,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"max loss":138,"daily loss":872}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":0.495,"timeout":0.505,"attempts":2503,"recentAttempts":384,"medDays":null,"reasons":{"max loss":443,"daily loss":796}}}}}},{"id":"turn_of_month|ES|1d","kind":"single","verdict":"mixed","name":"Turn of the Month","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":2613,"recentAttempts":427,"medDays":null,"reasons":{}},"0.005":{"pass":0.04,"recent":0,"noEdge":0.023,"fail":0.149,"timeout":0.811,"attempts":2613,"recentAttempts":427,"medDays":5,"reasons":{"max loss":202,"daily loss":187}},"0.01":{"pass":0.073,"recent":0.067,"noEdge":0.023,"fail":0.917,"timeout":0.01,"attempts":2636,"recentAttempts":450,"medDays":4,"reasons":{"daily loss":2237,"max loss":179}},"0.02":{"pass":0.002,"recent":0,"noEdge":0,"fail":0.998,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":4,"reasons":{"daily loss":1848,"max loss":831}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.026,"recent":0,"noEdge":0.002,"fail":0.055,"timeout":0.918,"attempts":2613,"recentAttempts":427,"medDays":11,"reasons":{"daily loss":145}},"0.005":{"pass":0.11,"recent":0.104,"noEdge":0.063,"fail":0.816,"timeout":0.073,"attempts":2648,"recentAttempts":462,"medDays":7,"reasons":{"daily loss":2140,"max loss":22}},"0.01":{"pass":0.047,"recent":0.048,"noEdge":0.018,"fail":0.953,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":4,"reasons":{"daily loss":2503,"max loss":55}},"0.02":{"pass":0.009,"recent":0,"noEdge":0.002,"fail":0.991,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":3,"reasons":{"daily loss":1785,"max loss":875}}}}}},{"id":"turn_of_month|NQ|1d","kind":"single","verdict":"mixed","name":"Turn of the Month","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.007,"timeout":0.993,"attempts":2613,"recentAttempts":427,"medDays":null,"reasons":{"max loss":17}},"0.005":{"pass":0.019,"recent":0,"noEdge":0.012,"fail":0.178,"timeout":0.804,"attempts":2613,"recentAttempts":427,"medDays":4,"reasons":{"max loss":156,"daily loss":308}},"0.01":{"pass":0.023,"recent":0.026,"noEdge":0.009,"fail":0.971,"timeout":0.006,"attempts":2642,"recentAttempts":456,"medDays":4,"reasons":{"max loss":281,"daily loss":2284}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":null,"reasons":{"daily loss":1964,"max loss":721}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.011,"recent":0,"noEdge":0,"fail":0.069,"timeout":0.919,"attempts":2613,"recentAttempts":427,"medDays":9,"reasons":{"max loss":36,"daily loss":145}},"0.005":{"pass":0.087,"recent":0.066,"noEdge":0.037,"fail":0.841,"timeout":0.072,"attempts":2642,"recentAttempts":456,"medDays":7,"reasons":{"daily loss":2223}},"0.01":{"pass":0.038,"recent":0.036,"noEdge":0.018,"fail":0.962,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":4,"reasons":{"max loss":123,"daily loss":2459}},"0.02":{"pass":0.007,"recent":0,"noEdge":0,"fail":0.993,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":3,"reasons":{"daily loss":1768,"max loss":899}}}}}},{"id":"month_end_rebal|ES|1d","kind":"single","verdict":"holds","name":"Month-End Rebalancing Flow","overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1694,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0.003,"recent":0,"noEdge":0,"fail":0.074,"timeout":0.923,"attempts":1694,"recentAttempts":426,"medDays":4,"reasons":{"daily loss":72,"max loss":54}},"0.01":{"pass":0.1,"recent":0.033,"noEdge":0.014,"fail":0.838,"timeout":0.063,"attempts":1754,"recentAttempts":486,"medDays":4,"reasons":{"daily loss":1304,"max loss":165}},"0.02":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1766,"recentAttempts":498,"medDays":null,"reasons":{"daily loss":1400,"max loss":366}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1694,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0.133,"recent":0.127,"noEdge":0.038,"fail":0.646,"timeout":0.221,"attempts":1694,"recentAttempts":426,"medDays":8,"reasons":{"daily loss":1095}},"0.01":{"pass":0.069,"recent":0.036,"noEdge":0.015,"fail":0.931,"timeout":0,"attempts":1766,"recentAttempts":498,"medDays":4,"reasons":{"daily loss":1633,"max loss":12}},"0.02":{"pass":0.02,"recent":0,"noEdge":0,"fail":0.98,"timeout":0,"attempts":1766,"recentAttempts":498,"medDays":3,"reasons":{"daily loss":1423,"max loss":307}}}}}},{"id":"noise_momentum|ES|5m_rth","kind":"single","verdict":"fails","name":"Intraday Momentum","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.16,"fail":0.657,"timeout":0.343,"attempts":1031,"recentAttempts":451,"medDays":null,"reasons":{"max loss":677}},"0.005":{"pass":0.036,"recent":0.054,"noEdge":0.331,"fail":0.916,"timeout":0.048,"attempts":1064,"recentAttempts":484,"medDays":101,"reasons":{"max loss":975}},"0.01":{"pass":0.078,"recent":0.134,"noEdge":0.274,"fail":0.902,"timeout":0.02,"attempts":1073,"recentAttempts":493,"medDays":36,"reasons":{"max loss":968}},"0.02":{"pass":0.059,"recent":0.093,"noEdge":0.198,"fail":0.94,"timeout":0.001,"attempts":1077,"recentAttempts":497,"medDays":17,"reasons":{"max loss":1012}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":null,"reasons":{"time limit":1067,"max loss":7}},"0.005":{"pass":0.007,"recent":0.006,"noEdge":0.007,"fail":0.993,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":9,"reasons":{"time limit":957,"max loss":109}},"0.01":{"pass":0.036,"recent":0.045,"noEdge":0.069,"fail":0.964,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":7,"reasons":{"max loss":454,"time limit":581}},"0.02":{"pass":0.116,"recent":0.147,"noEdge":0.178,"fail":0.884,"timeout":0,"attempts":1078,"recentAttempts":498,"medDays":5,"reasons":{"max loss":812,"time limit":141}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":null,"reasons":{"time limit":1065,"max loss":9}},"0.005":{"pass":0.005,"recent":0,"noEdge":0.005,"fail":0.995,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":12,"reasons":{"max loss":165,"time limit":904}},"0.01":{"pass":0.016,"recent":0.018,"noEdge":0.032,"fail":0.984,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":11,"reasons":{"max loss":663,"time limit":394}},"0.02":{"pass":0.015,"recent":0.018,"noEdge":0.034,"fail":0.985,"timeout":0,"attempts":1079,"recentAttempts":499,"medDays":7,"reasons":{"max loss":1014,"time limit":49}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.143,"fail":0.658,"timeout":0.342,"attempts":1031,"recentAttempts":451,"medDays":null,"reasons":{"max loss":678}},"0.005":{"pass":0.036,"recent":0.054,"noEdge":0.293,"fail":0.921,"timeout":0.043,"attempts":1064,"recentAttempts":484,"medDays":101,"reasons":{"max loss":980}},"0.01":{"pass":0.072,"recent":0.124,"noEdge":0.253,"fail":0.914,"timeout":0.014,"attempts":1073,"recentAttempts":493,"medDays":39,"reasons":{"max loss":981}},"0.02":{"pass":0.046,"recent":0.076,"noEdge":0.165,"fail":0.951,"timeout":0.003,"attempts":1078,"recentAttempts":498,"medDays":18,"reasons":{"max loss":1025}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.218,"timeout":0.782,"attempts":1007,"recentAttempts":427,"medDays":null,"reasons":{"max loss":220}},"0.005":{"pass":0,"recent":0,"noEdge":0.04,"fail":0.471,"timeout":0.529,"attempts":1013,"recentAttempts":433,"medDays":null,"reasons":{"max loss":477}},"0.01":{"pass":0.021,"recent":0.022,"noEdge":0.249,"fail":0.767,"timeout":0.212,"attempts":1045,"recentAttempts":465,"medDays":25,"reasons":{"max loss":732,"daily loss":69}},"0.02":{"pass":0.099,"recent":0.175,"noEdge":0.327,"fail":0.899,"timeout":0.003,"attempts":1065,"recentAttempts":485,"medDays":14,"reasons":{"max loss":884,"daily loss":73}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.248,"timeout":0.752,"attempts":1007,"recentAttempts":427,"medDays":null,"reasons":{"max loss":250}},"0.005":{"pass":0.006,"recent":0,"noEdge":0.196,"fail":0.58,"timeout":0.414,"attempts":1016,"recentAttempts":436,"medDays":67,"reasons":{"max loss":510,"daily loss":79}},"0.01":{"pass":0.085,"recent":0.154,"noEdge":0.325,"fail":0.81,"timeout":0.104,"attempts":1053,"recentAttempts":473,"medDays":93,"reasons":{"max loss":661,"daily loss":192}},"0.02":{"pass":0.043,"recent":0.055,"noEdge":0.144,"fail":0.957,"timeout":0,"attempts":1070,"recentAttempts":490,"medDays":24,"reasons":{"daily loss":685,"max loss":339}}}}}},{"id":"noise_momentum|NQ|5m_rth","kind":"single","verdict":"fails","name":"Intraday Momentum","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.111,"recent":0.215,"noEdge":0.09,"fail":0.31,"timeout":0.579,"attempts":1007,"recentAttempts":427,"medDays":129,"reasons":{"max loss":312}},"0.005":{"pass":0.36,"recent":0.485,"noEdge":0.301,"fail":0.541,"timeout":0.098,"attempts":1007,"recentAttempts":427,"medDays":78,"reasons":{"max loss":545}},"0.01":{"pass":0.248,"recent":0.331,"noEdge":0.22,"fail":0.739,"timeout":0.013,"attempts":1075,"recentAttempts":495,"medDays":25,"reasons":{"max loss":794}},"0.02":{"pass":0.178,"recent":0.236,"noEdge":0.171,"fail":0.819,"timeout":0.004,"attempts":1076,"recentAttempts":496,"medDays":12,"reasons":{"max loss":881}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":null,"reasons":{"time limit":1074}},"0.005":{"pass":0.011,"recent":0.014,"noEdge":0.01,"fail":0.989,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":11,"reasons":{"time limit":1008,"max loss":54}},"0.01":{"pass":0.078,"recent":0.067,"noEdge":0.074,"fail":0.922,"timeout":0,"attempts":1076,"recentAttempts":496,"medDays":9,"reasons":{"max loss":323,"time limit":669}},"0.02":{"pass":0.205,"recent":0.221,"noEdge":0.194,"fail":0.795,"timeout":0,"attempts":1077,"recentAttempts":497,"medDays":5,"reasons":{"max loss":654,"time limit":202}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":null,"reasons":{"time limit":1074}},"0.005":{"pass":0.006,"recent":0.006,"noEdge":0.005,"fail":0.994,"timeout":0,"attempts":1074,"recentAttempts":494,"medDays":12,"reasons":{"max loss":111,"time limit":957}},"0.01":{"pass":0.049,"recent":0.036,"noEdge":0.045,"fail":0.951,"timeout":0,"attempts":1077,"recentAttempts":497,"medDays":9,"reasons":{"max loss":499,"time limit":525}},"0.02":{"pass":0.056,"recent":0.068,"noEdge":0.051,"fail":0.944,"timeout":0,"attempts":1077,"recentAttempts":497,"medDays":6,"reasons":{"max loss":938,"time limit":79}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0.089,"recent":0.183,"noEdge":0.077,"fail":0.31,"timeout":0.601,"attempts":1007,"recentAttempts":427,"medDays":127,"reasons":{"max loss":312}},"0.005":{"pass":0.348,"recent":0.461,"noEdge":0.289,"fail":0.552,"timeout":0.1,"attempts":1007,"recentAttempts":427,"medDays":77,"reasons":{"max loss":556}},"0.01":{"pass":0.229,"recent":0.298,"noEdge":0.203,"fail":0.751,"timeout":0.02,"attempts":1074,"recentAttempts":494,"medDays":25,"reasons":{"max loss":807}},"0.02":{"pass":0.165,"recent":0.222,"noEdge":0.159,"fail":0.834,"timeout":0.001,"attempts":1076,"recentAttempts":496,"medDays":13,"reasons":{"max loss":897}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.01,"timeout":0.99,"attempts":1007,"recentAttempts":427,"medDays":null,"reasons":{"max loss":10}},"0.005":{"pass":0.029,"recent":0.068,"noEdge":0.025,"fail":0.222,"timeout":0.749,"attempts":1007,"recentAttempts":427,"medDays":60,"reasons":{"max loss":224}},"0.01":{"pass":0.331,"recent":0.532,"noEdge":0.275,"fail":0.458,"timeout":0.212,"attempts":1007,"recentAttempts":427,"medDays":35,"reasons":{"max loss":397,"daily loss":64}},"0.02":{"pass":0.325,"recent":0.47,"noEdge":0.296,"fail":0.667,"timeout":0.008,"attempts":1054,"recentAttempts":474,"medDays":11,"reasons":{"max loss":622,"daily loss":81}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.019,"timeout":0.981,"attempts":1007,"recentAttempts":427,"medDays":null,"reasons":{"max loss":19}},"0.005":{"pass":0.141,"recent":0.276,"noEdge":0.096,"fail":0.335,"timeout":0.524,"attempts":1007,"recentAttempts":427,"medDays":126,"reasons":{"max loss":264,"daily loss":73}},"0.01":{"pass":0.439,"recent":0.565,"noEdge":0.398,"fail":0.422,"timeout":0.139,"attempts":1008,"recentAttempts":428,"medDays":72,"reasons":{"max loss":270,"daily loss":155}},"0.02":{"pass":0.211,"recent":0.274,"noEdge":0.182,"fail":0.785,"timeout":0.004,"attempts":1072,"recentAttempts":492,"medDays":23,"reasons":{"max loss":217,"daily loss":625}}}}}},{"id":"orb|ES|5m_rth","kind":"single","verdict":"fails","name":"Opening Range Breakout","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.08,"recent":0.13,"noEdge":0.388,"fail":0.92,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":38,"reasons":{"max loss":992}},"0.005":{"pass":0.075,"recent":0.101,"noEdge":0.247,"fail":0.925,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":17,"reasons":{"max loss":999}},"0.01":{"pass":0.058,"recent":0.069,"noEdge":0.162,"fail":0.942,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":11,"reasons":{"max loss":1017}},"0.02":{"pass":0.061,"recent":0.069,"noEdge":0.152,"fail":0.939,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":12,"reasons":{"max loss":1014}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0.02,"recent":0.024,"noEdge":0.049,"fail":0.98,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":13,"reasons":{"max loss":445,"time limit":611}},"0.005":{"pass":0.106,"recent":0.137,"noEdge":0.204,"fail":0.894,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":8,"reasons":{"max loss":849,"time limit":117}},"0.01":{"pass":0.167,"recent":0.21,"noEdge":0.264,"fail":0.833,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":4,"reasons":{"max loss":889,"time limit":11}},"0.02":{"pass":0.184,"recent":0.224,"noEdge":0.254,"fail":0.816,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":3,"reasons":{"max loss":873,"time limit":8}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0.02,"recent":0.024,"noEdge":0.048,"fail":0.98,"timeout":0,"attempts":1079,"recentAttempts":495,"medDays":13,"reasons":{"max loss":566,"time limit":491}},"0.005":{"pass":0.025,"recent":0.024,"noEdge":0.056,"fail":0.975,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":9,"reasons":{"max loss":1032,"time limit":21}},"0.01":{"pass":0.015,"recent":0.014,"noEdge":0.036,"fail":0.985,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":5,"reasons":{"max loss":1066,"time limit":1}},"0.02":{"pass":0.006,"recent":0.002,"noEdge":0.018,"fail":0.994,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":5,"reasons":{"max loss":1075,"time limit":1}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0.078,"recent":0.126,"noEdge":0.386,"fail":0.922,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":38,"reasons":{"max loss":994}},"0.005":{"pass":0.061,"recent":0.083,"noEdge":0.228,"fail":0.939,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":19,"reasons":{"max loss":1014}},"0.01":{"pass":0.049,"recent":0.05,"noEdge":0.144,"fail":0.951,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":16,"reasons":{"max loss":1027}},"0.02":{"pass":0.049,"recent":0.052,"noEdge":0.128,"fail":0.951,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":15,"reasons":{"max loss":1027}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.232,"fail":0.899,"timeout":0.101,"attempts":1060,"recentAttempts":476,"medDays":null,"reasons":{"max loss":953}},"0.005":{"pass":0.069,"recent":0.088,"noEdge":0.319,"fail":0.931,"timeout":0,"attempts":1074,"recentAttempts":490,"medDays":21,"reasons":{"max loss":1000}},"0.01":{"pass":0.1,"recent":0.132,"noEdge":0.279,"fail":0.9,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":12,"reasons":{"max loss":969}},"0.02":{"pass":0.109,"recent":0.107,"noEdge":0.266,"fail":0.891,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":6,"reasons":{"max loss":960}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.034,"recent":0.058,"noEdge":0.35,"fail":0.941,"timeout":0.025,"attempts":1063,"recentAttempts":479,"medDays":89,"reasons":{"max loss":1000}},"0.005":{"pass":0.115,"recent":0.153,"noEdge":0.415,"fail":0.885,"timeout":0,"attempts":1074,"recentAttempts":490,"medDays":33,"reasons":{"max loss":915,"daily loss":36}},"0.01":{"pass":0.089,"recent":0.113,"noEdge":0.247,"fail":0.911,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":26,"reasons":{"max loss":954,"daily loss":28}},"0.02":{"pass":0.066,"recent":0.043,"noEdge":0.184,"fail":0.934,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":22,"reasons":{"max loss":986,"daily loss":21}}}}}},{"id":"orb|NQ|5m_rth","kind":"single","verdict":"fails","name":"Opening Range Breakout","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.109,"recent":0.15,"noEdge":0.312,"fail":0.891,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":33,"reasons":{"max loss":960}},"0.005":{"pass":0.128,"recent":0.155,"noEdge":0.219,"fail":0.872,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":20,"reasons":{"max loss":943}},"0.01":{"pass":0.104,"recent":0.124,"noEdge":0.162,"fail":0.896,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":17,"reasons":{"max loss":970}},"0.02":{"pass":0.091,"recent":0.1,"noEdge":0.146,"fail":0.909,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":13,"reasons":{"max loss":984}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0.031,"recent":0.034,"noEdge":0.045,"fail":0.969,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":13,"reasons":{"max loss":334,"time limit":711}},"0.005":{"pass":0.132,"recent":0.163,"noEdge":0.204,"fail":0.868,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":9,"reasons":{"max loss":758,"time limit":180}},"0.01":{"pass":0.235,"recent":0.287,"noEdge":0.287,"fail":0.765,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":4,"reasons":{"max loss":819,"time limit":9}},"0.02":{"pass":0.241,"recent":0.275,"noEdge":0.291,"fail":0.759,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":3,"reasons":{"max loss":819,"time limit":3}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0.031,"recent":0.034,"noEdge":0.045,"fail":0.969,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":13,"reasons":{"max loss":481,"time limit":567}},"0.005":{"pass":0.032,"recent":0.03,"noEdge":0.061,"fail":0.968,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":11,"reasons":{"max loss":1007,"time limit":39}},"0.01":{"pass":0.02,"recent":0.02,"noEdge":0.034,"fail":0.98,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":8,"reasons":{"max loss":1060}},"0.02":{"pass":0.012,"recent":0.006,"noEdge":0.017,"fail":0.988,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":6,"reasons":{"max loss":1070}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0.107,"recent":0.144,"noEdge":0.311,"fail":0.893,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":32,"reasons":{"max loss":963}},"0.005":{"pass":0.114,"recent":0.143,"noEdge":0.202,"fail":0.886,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":22,"reasons":{"max loss":958}},"0.01":{"pass":0.085,"recent":0.1,"noEdge":0.139,"fail":0.915,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":22,"reasons":{"max loss":990}},"0.02":{"pass":0.074,"recent":0.076,"noEdge":0.123,"fail":0.926,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":17,"reasons":{"max loss":1003}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.049,"recent":0.11,"noEdge":0.153,"fail":0.755,"timeout":0.196,"attempts":1046,"recentAttempts":462,"medDays":10,"reasons":{"max loss":790}},"0.005":{"pass":0.092,"recent":0.168,"noEdge":0.294,"fail":0.899,"timeout":0.009,"attempts":1066,"recentAttempts":482,"medDays":11,"reasons":{"max loss":947,"daily loss":11}},"0.01":{"pass":0.14,"recent":0.152,"noEdge":0.25,"fail":0.86,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":10,"reasons":{"max loss":913,"daily loss":13}},"0.02":{"pass":0.176,"recent":0.189,"noEdge":0.29,"fail":0.824,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":5,"reasons":{"max loss":872,"daily loss":20}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.078,"recent":0.149,"noEdge":0.31,"fail":0.869,"timeout":0.053,"attempts":1055,"recentAttempts":471,"medDays":94,"reasons":{"max loss":904,"daily loss":13}},"0.005":{"pass":0.194,"recent":0.238,"noEdge":0.406,"fail":0.806,"timeout":0,"attempts":1068,"recentAttempts":484,"medDays":37,"reasons":{"max loss":842,"daily loss":19}},"0.01":{"pass":0.127,"recent":0.125,"noEdge":0.213,"fail":0.873,"timeout":0,"attempts":1079,"recentAttempts":495,"medDays":26,"reasons":{"max loss":924,"daily loss":18}},"0.02":{"pass":0.104,"recent":0.108,"noEdge":0.177,"fail":0.896,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":19,"reasons":{"max loss":943,"daily loss":27}}}}}},{"id":"last_half_hour|ES|5m_rth","kind":"single","verdict":"fails","name":"Last Half-Hour Momentum","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.002,"fail":0.577,"timeout":0.423,"attempts":1018,"recentAttempts":434,"medDays":null,"reasons":{"max loss":587}},"0.005":{"pass":0.002,"recent":0,"noEdge":0.316,"fail":0.902,"timeout":0.096,"attempts":1056,"recentAttempts":472,"medDays":112,"reasons":{"max loss":953}},"0.01":{"pass":0.066,"recent":0.102,"noEdge":0.349,"fail":0.921,"timeout":0.013,"attempts":1073,"recentAttempts":489,"medDays":65,"reasons":{"max loss":988}},"0.02":{"pass":0.093,"recent":0.146,"noEdge":0.274,"fail":0.907,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":22,"reasons":{"max loss":977}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1070,"max loss":7}},"0.01":{"pass":0.007,"recent":0.004,"noEdge":0.017,"fail":0.993,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"time limit":775,"max loss":294}},"0.02":{"pass":0.051,"recent":0.061,"noEdge":0.116,"fail":0.949,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":13,"reasons":{"max loss":707,"time limit":315}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1069,"max loss":8}},"0.01":{"pass":0.007,"recent":0.004,"noEdge":0.017,"fail":0.993,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"time limit":733,"max loss":336}},"0.02":{"pass":0.032,"recent":0.039,"noEdge":0.103,"fail":0.968,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":13,"reasons":{"max loss":832,"time limit":211}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.002,"fail":0.577,"timeout":0.423,"attempts":1018,"recentAttempts":434,"medDays":null,"reasons":{"max loss":587}},"0.005":{"pass":0.002,"recent":0,"noEdge":0.316,"fail":0.902,"timeout":0.096,"attempts":1056,"recentAttempts":472,"medDays":112,"reasons":{"max loss":953}},"0.01":{"pass":0.066,"recent":0.102,"noEdge":0.348,"fail":0.921,"timeout":0.013,"attempts":1073,"recentAttempts":489,"medDays":65,"reasons":{"max loss":988}},"0.02":{"pass":0.088,"recent":0.144,"noEdge":0.272,"fail":0.912,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":24,"reasons":{"max loss":982}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.109,"timeout":0.891,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":110}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.449,"timeout":0.551,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":453}},"0.01":{"pass":0,"recent":0,"noEdge":0.19,"fail":0.711,"timeout":0.289,"attempts":1026,"recentAttempts":442,"medDays":null,"reasons":{"max loss":729}},"0.02":{"pass":0.024,"recent":0.032,"noEdge":0.339,"fail":0.903,"timeout":0.073,"attempts":1056,"recentAttempts":472,"medDays":58,"reasons":{"max loss":916,"daily loss":38}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.112,"timeout":0.888,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":113}},"0.005":{"pass":0,"recent":0,"noEdge":0.031,"fail":0.471,"timeout":0.529,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":476}},"0.01":{"pass":0.006,"recent":0,"noEdge":0.364,"fail":0.867,"timeout":0.127,"attempts":1026,"recentAttempts":442,"medDays":72,"reasons":{"max loss":834,"daily loss":56}},"0.02":{"pass":0.121,"recent":0.209,"noEdge":0.36,"fail":0.844,"timeout":0.035,"attempts":1072,"recentAttempts":488,"medDays":95,"reasons":{"max loss":800,"daily loss":105}}}}}},{"id":"last_half_hour|NQ|5m_rth","kind":"single","verdict":"fails","name":"Last Half-Hour Momentum","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.001,"fail":0.313,"timeout":0.687,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":316}},"0.005":{"pass":0.031,"recent":0.007,"noEdge":0.23,"fail":0.685,"timeout":0.283,"attempts":1020,"recentAttempts":436,"medDays":144,"reasons":{"max loss":699}},"0.01":{"pass":0.187,"recent":0.324,"noEdge":0.334,"fail":0.812,"timeout":0.001,"attempts":1028,"recentAttempts":444,"medDays":91,"reasons":{"max loss":835}},"0.02":{"pass":0.145,"recent":0.207,"noEdge":0.302,"fail":0.855,"timeout":0,"attempts":1072,"recentAttempts":488,"medDays":28,"reasons":{"max loss":917}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0.002,"recent":0,"noEdge":0.003,"fail":0.998,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":18,"reasons":{"time limit":1073,"max loss":2}},"0.01":{"pass":0.006,"recent":0,"noEdge":0.006,"fail":0.994,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"time limit":932,"max loss":139}},"0.02":{"pass":0.044,"recent":0.053,"noEdge":0.081,"fail":0.956,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"time limit":454,"max loss":576}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0.002,"recent":0,"noEdge":0.003,"fail":0.998,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":18,"reasons":{"time limit":1072,"max loss":3}},"0.01":{"pass":0.006,"recent":0,"noEdge":0.006,"fail":0.994,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"time limit":905,"max loss":166}},"0.02":{"pass":0.035,"recent":0.045,"noEdge":0.072,"fail":0.965,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"max loss":700,"time limit":339}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.001,"fail":0.313,"timeout":0.687,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":316}},"0.005":{"pass":0.031,"recent":0.007,"noEdge":0.23,"fail":0.685,"timeout":0.283,"attempts":1020,"recentAttempts":436,"medDays":144,"reasons":{"max loss":699}},"0.01":{"pass":0.187,"recent":0.324,"noEdge":0.332,"fail":0.813,"timeout":0,"attempts":1028,"recentAttempts":444,"medDays":91,"reasons":{"max loss":836}},"0.02":{"pass":0.148,"recent":0.207,"noEdge":0.291,"fail":0.852,"timeout":0,"attempts":1072,"recentAttempts":488,"medDays":30,"reasons":{"max loss":913}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.207,"timeout":0.793,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":209}},"0.01":{"pass":0.002,"recent":0,"noEdge":0.116,"fail":0.46,"timeout":0.538,"attempts":1010,"recentAttempts":426,"medDays":95,"reasons":{"max loss":465}},"0.02":{"pass":0.129,"recent":0.206,"noEdge":0.349,"fail":0.753,"timeout":0.118,"attempts":1025,"recentAttempts":441,"medDays":39,"reasons":{"max loss":760,"daily loss":12}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0.026,"fail":0.215,"timeout":0.785,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":217}},"0.01":{"pass":0.071,"recent":0.067,"noEdge":0.318,"fail":0.599,"timeout":0.33,"attempts":1014,"recentAttempts":430,"medDays":131,"reasons":{"max loss":607}},"0.02":{"pass":0.208,"recent":0.351,"noEdge":0.339,"fail":0.79,"timeout":0.002,"attempts":1025,"recentAttempts":441,"medDays":83,"reasons":{"max loss":574,"daily loss":236}}}}}},{"id":"gap_fade|ES|5m_rth","kind":"single","verdict":"fails","name":"Opening Gap Fade","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.101,"fail":0.61,"timeout":0.39,"attempts":1048,"recentAttempts":464,"medDays":null,"reasons":{"max loss":639}},"0.005":{"pass":0.093,"recent":0.175,"noEdge":0.275,"fail":0.878,"timeout":0.029,"attempts":1071,"recentAttempts":487,"medDays":73,"reasons":{"max loss":940}},"0.01":{"pass":0.139,"recent":0.199,"noEdge":0.235,"fail":0.861,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":19,"reasons":{"max loss":927}},"0.02":{"pass":0.182,"recent":0.211,"noEdge":0.25,"fail":0.818,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":7,"reasons":{"max loss":885}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1018,"max loss":59}},"0.01":{"pass":0.037,"recent":0.055,"noEdge":0.066,"fail":0.963,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"time limit":529,"max loss":508}},"0.02":{"pass":0.165,"recent":0.201,"noEdge":0.237,"fail":0.835,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":6,"reasons":{"max loss":836,"time limit":68}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":995,"max loss":82}},"0.01":{"pass":0.037,"recent":0.055,"noEdge":0.066,"fail":0.963,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"max loss":582,"time limit":455}},"0.02":{"pass":0.132,"recent":0.173,"noEdge":0.195,"fail":0.868,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":6,"reasons":{"max loss":905,"time limit":34}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.101,"fail":0.61,"timeout":0.39,"attempts":1048,"recentAttempts":464,"medDays":null,"reasons":{"max loss":639}},"0.005":{"pass":0.09,"recent":0.166,"noEdge":0.269,"fail":0.881,"timeout":0.029,"attempts":1071,"recentAttempts":487,"medDays":78,"reasons":{"max loss":944}},"0.01":{"pass":0.139,"recent":0.199,"noEdge":0.224,"fail":0.861,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":19,"reasons":{"max loss":927}},"0.02":{"pass":0.17,"recent":0.207,"noEdge":0.243,"fail":0.83,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":7,"reasons":{"max loss":898}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.021,"timeout":0.979,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":21}},"0.005":{"pass":0,"recent":0,"noEdge":0.008,"fail":0.347,"timeout":0.653,"attempts":1023,"recentAttempts":439,"medDays":null,"reasons":{"max loss":355}},"0.01":{"pass":0.073,"recent":0.124,"noEdge":0.232,"fail":0.754,"timeout":0.173,"attempts":1069,"recentAttempts":485,"medDays":24,"reasons":{"max loss":806}},"0.02":{"pass":0.138,"recent":0.246,"noEdge":0.299,"fail":0.862,"timeout":0,"attempts":1072,"recentAttempts":488,"medDays":9,"reasons":{"max loss":924}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.029,"timeout":0.971,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":29}},"0.005":{"pass":0.024,"recent":0.037,"noEdge":0.158,"fail":0.461,"timeout":0.515,"attempts":1043,"recentAttempts":459,"medDays":99,"reasons":{"max loss":481}},"0.01":{"pass":0.11,"recent":0.196,"noEdge":0.334,"fail":0.867,"timeout":0.022,"attempts":1069,"recentAttempts":485,"medDays":55,"reasons":{"max loss":889,"daily loss":38}},"0.02":{"pass":0.186,"recent":0.258,"noEdge":0.353,"fail":0.814,"timeout":0,"attempts":1072,"recentAttempts":488,"medDays":19,"reasons":{"max loss":854,"daily loss":19}}}}}},{"id":"gap_fade|NQ|5m_rth","kind":"single","verdict":"fails","name":"Opening Gap Fade","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.028,"fail":0.591,"timeout":0.409,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":597}},"0.005":{"pass":0.103,"recent":0.123,"noEdge":0.258,"fail":0.864,"timeout":0.034,"attempts":1063,"recentAttempts":479,"medDays":78,"reasons":{"max loss":918}},"0.01":{"pass":0.206,"recent":0.256,"noEdge":0.275,"fail":0.794,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":20,"reasons":{"max loss":855}},"0.02":{"pass":0.222,"recent":0.252,"noEdge":0.268,"fail":0.778,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":6,"reasons":{"max loss":841}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1019,"max loss":58}},"0.01":{"pass":0.054,"recent":0.049,"noEdge":0.078,"fail":0.946,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"max loss":481,"time limit":538}},"0.02":{"pass":0.206,"recent":0.223,"noEdge":0.248,"fail":0.794,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":6,"reasons":{"max loss":807,"time limit":51}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1006,"max loss":71}},"0.01":{"pass":0.054,"recent":0.049,"noEdge":0.076,"fail":0.946,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"max loss":566,"time limit":453}},"0.02":{"pass":0.166,"recent":0.179,"noEdge":0.204,"fail":0.834,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":6,"reasons":{"max loss":871,"time limit":31}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.028,"fail":0.594,"timeout":0.406,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":600}},"0.005":{"pass":0.103,"recent":0.123,"noEdge":0.249,"fail":0.867,"timeout":0.03,"attempts":1063,"recentAttempts":479,"medDays":78,"reasons":{"max loss":922}},"0.01":{"pass":0.205,"recent":0.254,"noEdge":0.269,"fail":0.795,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":20,"reasons":{"max loss":856}},"0.02":{"pass":0.212,"recent":0.249,"noEdge":0.265,"fail":0.788,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":6,"reasons":{"max loss":852}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.003,"timeout":0.997,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":3}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.291,"timeout":0.709,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":294}},"0.01":{"pass":0.052,"recent":0.067,"noEdge":0.175,"fail":0.686,"timeout":0.261,"attempts":1049,"recentAttempts":465,"medDays":56,"reasons":{"max loss":720}},"0.02":{"pass":0.2,"recent":0.224,"noEdge":0.319,"fail":0.796,"timeout":0.004,"attempts":1074,"recentAttempts":490,"medDays":13,"reasons":{"max loss":827,"daily loss":28}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.012,"timeout":0.988,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":12}},"0.005":{"pass":0.004,"recent":0.009,"noEdge":0.079,"fail":0.426,"timeout":0.57,"attempts":1010,"recentAttempts":426,"medDays":146,"reasons":{"max loss":430}},"0.01":{"pass":0.171,"recent":0.203,"noEdge":0.374,"fail":0.746,"timeout":0.083,"attempts":1067,"recentAttempts":483,"medDays":62,"reasons":{"max loss":761,"daily loss":35}},"0.02":{"pass":0.294,"recent":0.361,"noEdge":0.364,"fail":0.706,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":19,"reasons":{"max loss":738,"daily loss":22}}}}}},{"id":"orb30|ES|5m_rth","kind":"single","verdict":"fails","name":"30-Minute Opening Range Breakout","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.121,"recent":0.194,"noEdge":0.333,"fail":0.841,"timeout":0.038,"attempts":1059,"recentAttempts":475,"medDays":85,"reasons":{"max loss":891}},"0.005":{"pass":0.131,"recent":0.198,"noEdge":0.274,"fail":0.869,"timeout":0,"attempts":1069,"recentAttempts":485,"medDays":37,"reasons":{"max loss":929}},"0.01":{"pass":0.127,"recent":0.181,"noEdge":0.204,"fail":0.873,"timeout":0,"attempts":1075,"recentAttempts":491,"medDays":16,"reasons":{"max loss":938}},"0.02":{"pass":0.124,"recent":0.157,"noEdge":0.165,"fail":0.876,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":8,"reasons":{"max loss":946}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0.005,"recent":0,"noEdge":0.014,"fail":0.995,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":15,"reasons":{"time limit":1015,"max loss":57}},"0.005":{"pass":0.066,"recent":0.077,"noEdge":0.092,"fail":0.934,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"time limit":539,"max loss":467}},"0.01":{"pass":0.166,"recent":0.209,"noEdge":0.226,"fail":0.834,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":7,"reasons":{"max loss":811,"time limit":91}},"0.02":{"pass":0.214,"recent":0.248,"noEdge":0.255,"fail":0.786,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":3,"reasons":{"max loss":850,"time limit":1}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0.003,"recent":0,"noEdge":0.009,"fail":0.997,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":18,"reasons":{"time limit":972,"max loss":102}},"0.005":{"pass":0.037,"recent":0.034,"noEdge":0.052,"fail":0.963,"timeout":0,"attempts":1079,"recentAttempts":495,"medDays":13,"reasons":{"time limit":398,"max loss":641}},"0.01":{"pass":0.052,"recent":0.076,"noEdge":0.091,"fail":0.948,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":11,"reasons":{"max loss":983,"time limit":43}},"0.02":{"pass":0.018,"recent":0.022,"noEdge":0.031,"fail":0.982,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":4,"reasons":{"max loss":1063}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0.115,"recent":0.189,"noEdge":0.327,"fail":0.847,"timeout":0.038,"attempts":1059,"recentAttempts":475,"medDays":86,"reasons":{"max loss":897}},"0.005":{"pass":0.12,"recent":0.186,"noEdge":0.265,"fail":0.88,"timeout":0,"attempts":1069,"recentAttempts":485,"medDays":42,"reasons":{"max loss":941}},"0.01":{"pass":0.114,"recent":0.165,"noEdge":0.186,"fail":0.886,"timeout":0,"attempts":1075,"recentAttempts":491,"medDays":20,"reasons":{"max loss":952}},"0.02":{"pass":0.102,"recent":0.133,"noEdge":0.149,"fail":0.898,"timeout":0,"attempts":1080,"recentAttempts":496,"medDays":9,"reasons":{"max loss":970}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.047,"fail":0.405,"timeout":0.595,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":409}},"0.005":{"pass":0.084,"recent":0.159,"noEdge":0.303,"fail":0.74,"timeout":0.176,"attempts":1030,"recentAttempts":446,"medDays":35,"reasons":{"max loss":762}},"0.01":{"pass":0.146,"recent":0.239,"noEdge":0.305,"fail":0.853,"timeout":0.001,"attempts":1066,"recentAttempts":482,"medDays":15,"reasons":{"max loss":909}},"0.02":{"pass":0.146,"recent":0.209,"noEdge":0.248,"fail":0.854,"timeout":0,"attempts":1071,"recentAttempts":487,"medDays":8,"reasons":{"max loss":910,"daily loss":5}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.048,"recent":0.113,"noEdge":0.181,"fail":0.48,"timeout":0.472,"attempts":1010,"recentAttempts":426,"medDays":174,"reasons":{"max loss":485}},"0.005":{"pass":0.152,"recent":0.268,"noEdge":0.403,"fail":0.828,"timeout":0.02,"attempts":1051,"recentAttempts":467,"medDays":86,"reasons":{"max loss":870}},"0.01":{"pass":0.177,"recent":0.276,"noEdge":0.293,"fail":0.823,"timeout":0,"attempts":1069,"recentAttempts":485,"medDays":38,"reasons":{"max loss":874,"daily loss":6}},"0.02":{"pass":0.131,"recent":0.19,"noEdge":0.195,"fail":0.869,"timeout":0,"attempts":1073,"recentAttempts":489,"medDays":16,"reasons":{"max loss":907,"daily loss":25}}}}}},{"id":"orb30|NQ|5m_rth","kind":"single","verdict":"fails","name":"30-Minute Opening Range Breakout","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.244,"recent":0.397,"noEdge":0.23,"fail":0.705,"timeout":0.051,"attempts":1048,"recentAttempts":464,"medDays":76,"reasons":{"max loss":739}},"0.005":{"pass":0.218,"recent":0.293,"noEdge":0.184,"fail":0.782,"timeout":0,"attempts":1062,"recentAttempts":478,"medDays":34,"reasons":{"max loss":830}},"0.01":{"pass":0.172,"recent":0.21,"noEdge":0.151,"fail":0.828,"timeout":0,"attempts":1074,"recentAttempts":490,"medDays":21,"reasons":{"max loss":889}},"0.02":{"pass":0.136,"recent":0.129,"noEdge":0.129,"fail":0.864,"timeout":0,"attempts":1079,"recentAttempts":495,"medDays":10,"reasons":{"max loss":932}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0.014,"recent":0.016,"noEdge":0.014,"fail":0.986,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":16,"reasons":{"time limit":1025,"max loss":37}},"0.005":{"pass":0.125,"recent":0.126,"noEdge":0.123,"fail":0.875,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":11,"reasons":{"time limit":586,"max loss":356}},"0.01":{"pass":0.216,"recent":0.239,"noEdge":0.208,"fail":0.784,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":5,"reasons":{"max loss":658,"time limit":189}},"0.02":{"pass":0.25,"recent":0.251,"noEdge":0.247,"fail":0.75,"timeout":0,"attempts":1082,"recentAttempts":498,"medDays":3,"reasons":{"max loss":802,"time limit":9}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0.012,"recent":0.012,"noEdge":0.012,"fail":0.988,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":16,"reasons":{"time limit":964,"max loss":100}},"0.005":{"pass":0.063,"recent":0.062,"noEdge":0.059,"fail":0.937,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":11,"reasons":{"time limit":417,"max loss":596}},"0.01":{"pass":0.045,"recent":0.054,"noEdge":0.043,"fail":0.955,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":9,"reasons":{"max loss":911,"time limit":121}},"0.02":{"pass":0.03,"recent":0.02,"noEdge":0.029,"fail":0.97,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":6,"reasons":{"max loss":1045,"time limit":5}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0.239,"recent":0.394,"noEdge":0.225,"fail":0.71,"timeout":0.052,"attempts":1048,"recentAttempts":464,"medDays":79,"reasons":{"max loss":744}},"0.005":{"pass":0.204,"recent":0.272,"noEdge":0.173,"fail":0.794,"timeout":0.002,"attempts":1062,"recentAttempts":478,"medDays":37,"reasons":{"max loss":843}},"0.01":{"pass":0.158,"recent":0.188,"noEdge":0.135,"fail":0.839,"timeout":0.003,"attempts":1074,"recentAttempts":490,"medDays":26,"reasons":{"max loss":901}},"0.02":{"pass":0.117,"recent":0.109,"noEdge":0.11,"fail":0.882,"timeout":0.001,"attempts":1079,"recentAttempts":495,"medDays":11,"reasons":{"max loss":952}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.053,"recent":0.12,"noEdge":0.047,"fail":0.143,"timeout":0.804,"attempts":1010,"recentAttempts":426,"medDays":46,"reasons":{"max loss":144}},"0.005":{"pass":0.283,"recent":0.428,"noEdge":0.233,"fail":0.453,"timeout":0.265,"attempts":1012,"recentAttempts":428,"medDays":28,"reasons":{"max loss":458}},"0.01":{"pass":0.299,"recent":0.398,"noEdge":0.247,"fail":0.694,"timeout":0.007,"attempts":1069,"recentAttempts":485,"medDays":9,"reasons":{"max loss":742}},"0.02":{"pass":0.196,"recent":0.216,"noEdge":0.178,"fail":0.804,"timeout":0,"attempts":1079,"recentAttempts":495,"medDays":7,"reasons":{"max loss":868}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.183,"recent":0.284,"noEdge":0.159,"fail":0.292,"timeout":0.525,"attempts":1010,"recentAttempts":426,"medDays":153,"reasons":{"max loss":295}},"0.005":{"pass":0.375,"recent":0.538,"noEdge":0.32,"fail":0.524,"timeout":0.102,"attempts":1041,"recentAttempts":457,"medDays":101,"reasons":{"max loss":545}},"0.01":{"pass":0.289,"recent":0.438,"noEdge":0.242,"fail":0.71,"timeout":0.001,"attempts":1070,"recentAttempts":486,"medDays":46,"reasons":{"max loss":739,"daily loss":21}},"0.02":{"pass":0.171,"recent":0.185,"noEdge":0.139,"fail":0.829,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":20,"reasons":{"max loss":893,"daily loss":3}}}}}},{"id":"rod_momentum|ES|5m_rth","kind":"single","verdict":"fails","name":"Market Intraday Momentum (last 30 min)","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.08,"fail":0.61,"timeout":0.39,"attempts":1017,"recentAttempts":433,"medDays":null,"reasons":{"max loss":620}},"0.005":{"pass":0.056,"recent":0.09,"noEdge":0.317,"fail":0.87,"timeout":0.073,"attempts":1049,"recentAttempts":465,"medDays":175,"reasons":{"max loss":913}},"0.01":{"pass":0.086,"recent":0.127,"noEdge":0.333,"fail":0.907,"timeout":0.007,"attempts":1065,"recentAttempts":481,"medDays":53,"reasons":{"max loss":966}},"0.02":{"pass":0.106,"recent":0.122,"noEdge":0.258,"fail":0.894,"timeout":0,"attempts":1074,"recentAttempts":490,"medDays":21,"reasons":{"max loss":960}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1053,"max loss":24}},"0.01":{"pass":0.018,"recent":0.014,"noEdge":0.032,"fail":0.982,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":13,"reasons":{"max loss":316,"time limit":742}},"0.02":{"pass":0.065,"recent":0.061,"noEdge":0.15,"fail":0.935,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":10,"reasons":{"max loss":723,"time limit":284}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1045,"max loss":32}},"0.01":{"pass":0.014,"recent":0.01,"noEdge":0.028,"fail":0.986,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"max loss":369,"time limit":693}},"0.02":{"pass":0.052,"recent":0.057,"noEdge":0.123,"fail":0.948,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":10,"reasons":{"max loss":835,"time limit":186}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.08,"fail":0.61,"timeout":0.39,"attempts":1017,"recentAttempts":433,"medDays":null,"reasons":{"max loss":620}},"0.005":{"pass":0.056,"recent":0.09,"noEdge":0.317,"fail":0.87,"timeout":0.073,"attempts":1049,"recentAttempts":465,"medDays":175,"reasons":{"max loss":913}},"0.01":{"pass":0.069,"recent":0.087,"noEdge":0.32,"fail":0.931,"timeout":0,"attempts":1065,"recentAttempts":481,"medDays":53,"reasons":{"max loss":992}},"0.02":{"pass":0.101,"recent":0.116,"noEdge":0.248,"fail":0.899,"timeout":0,"attempts":1074,"recentAttempts":490,"medDays":21,"reasons":{"max loss":966}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.096,"timeout":0.904,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":97}},"0.005":{"pass":0,"recent":0,"noEdge":0.016,"fail":0.395,"timeout":0.605,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":399}},"0.01":{"pass":0.007,"recent":0.011,"noEdge":0.212,"fail":0.742,"timeout":0.251,"attempts":1031,"recentAttempts":447,"medDays":93,"reasons":{"max loss":765}},"0.02":{"pass":0.037,"recent":0.044,"noEdge":0.262,"fail":0.962,"timeout":0.001,"attempts":1063,"recentAttempts":479,"medDays":20,"reasons":{"max loss":914,"daily loss":109}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.097,"timeout":0.903,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":98}},"0.005":{"pass":0,"recent":0,"noEdge":0.11,"fail":0.446,"timeout":0.554,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":450}},"0.01":{"pass":0.033,"recent":0.044,"noEdge":0.301,"fail":0.888,"timeout":0.079,"attempts":1034,"recentAttempts":450,"medDays":95,"reasons":{"max loss":814,"daily loss":104}},"0.02":{"pass":0.05,"recent":0.053,"noEdge":0.215,"fail":0.95,"timeout":0,"attempts":1074,"recentAttempts":490,"medDays":36,"reasons":{"daily loss":394,"max loss":626}}}}}},{"id":"rod_momentum|NQ|5m_rth","kind":"single","verdict":"fails","name":"Market Intraday Momentum (last 30 min)","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.003,"recent":0.007,"noEdge":0.081,"fail":0.397,"timeout":0.6,"attempts":1010,"recentAttempts":426,"medDays":246,"reasons":{"max loss":401}},"0.005":{"pass":0.15,"recent":0.181,"noEdge":0.214,"fail":0.773,"timeout":0.077,"attempts":1025,"recentAttempts":441,"medDays":120,"reasons":{"max loss":792}},"0.01":{"pass":0.156,"recent":0.196,"noEdge":0.248,"fail":0.844,"timeout":0,"attempts":1028,"recentAttempts":444,"medDays":62,"reasons":{"max loss":868}},"0.02":{"pass":0.138,"recent":0.163,"noEdge":0.214,"fail":0.862,"timeout":0,"attempts":1068,"recentAttempts":484,"medDays":25,"reasons":{"max loss":921}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0.003,"recent":0,"noEdge":0.003,"fail":0.997,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":18,"reasons":{"time limit":1064,"max loss":10}},"0.01":{"pass":0.013,"recent":0.014,"noEdge":0.018,"fail":0.987,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"time limit":923,"max loss":140}},"0.02":{"pass":0.062,"recent":0.063,"noEdge":0.098,"fail":0.938,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"max loss":604,"time limit":406}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0.003,"recent":0,"noEdge":0.003,"fail":0.997,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":18,"reasons":{"time limit":1058,"max loss":16}},"0.01":{"pass":0.012,"recent":0.012,"noEdge":0.018,"fail":0.988,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":14,"reasons":{"max loss":185,"time limit":879}},"0.02":{"pass":0.057,"recent":0.065,"noEdge":0.087,"fail":0.943,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":13,"reasons":{"max loss":716,"time limit":300}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0.003,"recent":0.007,"noEdge":0.081,"fail":0.397,"timeout":0.6,"attempts":1010,"recentAttempts":426,"medDays":246,"reasons":{"max loss":401}},"0.005":{"pass":0.15,"recent":0.181,"noEdge":0.214,"fail":0.774,"timeout":0.076,"attempts":1025,"recentAttempts":441,"medDays":120,"reasons":{"max loss":793}},"0.01":{"pass":0.155,"recent":0.194,"noEdge":0.247,"fail":0.845,"timeout":0,"attempts":1028,"recentAttempts":444,"medDays":62,"reasons":{"max loss":869}},"0.02":{"pass":0.136,"recent":0.188,"noEdge":0.206,"fail":0.864,"timeout":0,"attempts":1073,"recentAttempts":489,"medDays":24,"reasons":{"max loss":927}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0.015,"fail":0.206,"timeout":0.794,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":208}},"0.01":{"pass":0.109,"recent":0.101,"noEdge":0.201,"fail":0.604,"timeout":0.287,"attempts":1010,"recentAttempts":426,"medDays":59,"reasons":{"max loss":610}},"0.02":{"pass":0.07,"recent":0.077,"noEdge":0.188,"fail":0.919,"timeout":0.011,"attempts":1028,"recentAttempts":444,"medDays":20,"reasons":{"max loss":805,"daily loss":140}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0.032,"recent":0.063,"noEdge":0.142,"fail":0.243,"timeout":0.726,"attempts":1010,"recentAttempts":426,"medDays":196,"reasons":{"max loss":245}},"0.01":{"pass":0.175,"recent":0.213,"noEdge":0.234,"fail":0.672,"timeout":0.153,"attempts":1012,"recentAttempts":428,"medDays":99,"reasons":{"max loss":680}},"0.02":{"pass":0.109,"recent":0.147,"noEdge":0.177,"fail":0.891,"timeout":0,"attempts":1074,"recentAttempts":490,"medDays":50,"reasons":{"daily loss":440,"max loss":517}}}}}},{"id":"rod_momentum|GC|5m_pit","kind":"single","verdict":"fails","name":"Market Intraday Momentum (last 30 min)","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.501,"timeout":0.499,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":506}},"0.005":{"pass":0,"recent":0,"noEdge":0.081,"fail":0.885,"timeout":0.115,"attempts":1074,"recentAttempts":490,"medDays":null,"reasons":{"max loss":950}},"0.01":{"pass":0.044,"recent":0.095,"noEdge":0.296,"fail":0.95,"timeout":0.006,"attempts":1077,"recentAttempts":493,"medDays":159,"reasons":{"max loss":1023}},"0.02":{"pass":0.033,"recent":0.063,"noEdge":0.295,"fail":0.967,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":43,"reasons":{"max loss":1042}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1076,"max loss":1}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":999,"max loss":78}},"0.02":{"pass":0.014,"recent":0.012,"noEdge":0.036,"fail":0.986,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":15,"reasons":{"time limit":550,"max loss":513}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1077}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":1076,"max loss":1}},"0.01":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":1077,"recentAttempts":493,"medDays":null,"reasons":{"time limit":966,"max loss":111}},"0.02":{"pass":0.01,"recent":0.016,"noEdge":0.032,"fail":0.99,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":18,"reasons":{"max loss":608,"time limit":459}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.501,"timeout":0.499,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":506}},"0.005":{"pass":0,"recent":0,"noEdge":0.081,"fail":0.885,"timeout":0.115,"attempts":1074,"recentAttempts":490,"medDays":null,"reasons":{"max loss":950}},"0.01":{"pass":0.043,"recent":0.093,"noEdge":0.293,"fail":0.951,"timeout":0.006,"attempts":1077,"recentAttempts":493,"medDays":162,"reasons":{"max loss":1024}},"0.02":{"pass":0.036,"recent":0.071,"noEdge":0.301,"fail":0.964,"timeout":0,"attempts":1078,"recentAttempts":494,"medDays":46,"reasons":{"max loss":1039}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.269,"timeout":0.731,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":272}},"0.01":{"pass":0,"recent":0,"noEdge":0.056,"fail":0.763,"timeout":0.237,"attempts":1019,"recentAttempts":435,"medDays":null,"reasons":{"max loss":762,"daily loss":15}},"0.02":{"pass":0.022,"recent":0.049,"noEdge":0.191,"fail":0.94,"timeout":0.038,"attempts":1076,"recentAttempts":492,"medDays":40,"reasons":{"max loss":977,"daily loss":34}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0.009,"fail":0.285,"timeout":0.715,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":288}},"0.01":{"pass":0,"recent":0,"noEdge":0.118,"fail":0.804,"timeout":0.196,"attempts":1038,"recentAttempts":454,"medDays":null,"reasons":{"max loss":794,"daily loss":41}},"0.02":{"pass":0.043,"recent":0.093,"noEdge":0.305,"fail":0.941,"timeout":0.017,"attempts":1077,"recentAttempts":493,"medDays":131,"reasons":{"max loss":881,"daily loss":132}}}}}},{"id":"rod_momentum|CL|5m_pit","kind":"single","verdict":"fails","name":"Market Intraday Momentum (last 30 min)","overnightShare":0,"presets":{"topstep_50k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.008,"fail":0.625,"timeout":0.375,"attempts":797,"recentAttempts":213,"medDays":null,"reasons":{"max loss":498}},"0.005":{"pass":0.036,"recent":0,"noEdge":0.141,"fail":0.911,"timeout":0.052,"attempts":801,"recentAttempts":217,"medDays":109,"reasons":{"max loss":730}},"0.01":{"pass":0.04,"recent":0.007,"noEdge":0.28,"fail":0.96,"timeout":0,"attempts":860,"recentAttempts":276,"medDays":41,"reasons":{"max loss":826}},"0.02":{"pass":0.067,"recent":0.053,"noEdge":0.222,"fail":0.933,"timeout":0,"attempts":867,"recentAttempts":283,"medDays":20,"reasons":{"max loss":809}}}},"apex_50k_eod":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":864,"recentAttempts":280,"medDays":null,"reasons":{"time limit":864}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":864,"recentAttempts":280,"medDays":null,"reasons":{"time limit":856,"max loss":8}},"0.01":{"pass":0.005,"recent":0.004,"noEdge":0.006,"fail":0.995,"timeout":0,"attempts":864,"recentAttempts":280,"medDays":15,"reasons":{"time limit":717,"max loss":143}},"0.02":{"pass":0.048,"recent":0.032,"noEdge":0.106,"fail":0.952,"timeout":0,"attempts":867,"recentAttempts":283,"medDays":16,"reasons":{"max loss":558,"time limit":267}}}},"apex_50k_intraday":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":864,"recentAttempts":280,"medDays":null,"reasons":{"time limit":864}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":1,"timeout":0,"attempts":864,"recentAttempts":280,"medDays":null,"reasons":{"time limit":856,"max loss":8}},"0.01":{"pass":0.001,"recent":0.004,"noEdge":0.002,"fail":0.999,"timeout":0,"attempts":864,"recentAttempts":280,"medDays":14,"reasons":{"max loss":189,"time limit":674}},"0.02":{"pass":0.029,"recent":0.025,"noEdge":0.083,"fail":0.971,"timeout":0,"attempts":867,"recentAttempts":283,"medDays":16,"reasons":{"max loss":640,"time limit":202}}}},"eod50_consistency":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.008,"fail":0.625,"timeout":0.375,"attempts":797,"recentAttempts":213,"medDays":null,"reasons":{"max loss":498}},"0.005":{"pass":0.036,"recent":0,"noEdge":0.141,"fail":0.911,"timeout":0.052,"attempts":801,"recentAttempts":217,"medDays":109,"reasons":{"max loss":730}},"0.01":{"pass":0.038,"recent":0.007,"noEdge":0.285,"fail":0.962,"timeout":0,"attempts":861,"recentAttempts":277,"medDays":42,"reasons":{"max loss":828}},"0.02":{"pass":0.067,"recent":0.053,"noEdge":0.245,"fail":0.933,"timeout":0,"attempts":867,"recentAttempts":283,"medDays":24,"reasons":{"max loss":809}}}},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":797,"recentAttempts":213,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.417,"timeout":0.583,"attempts":797,"recentAttempts":213,"medDays":null,"reasons":{"max loss":332}},"0.01":{"pass":0.005,"recent":0,"noEdge":0.085,"fail":0.817,"timeout":0.178,"attempts":797,"recentAttempts":213,"medDays":29,"reasons":{"max loss":651}},"0.02":{"pass":0.047,"recent":0,"noEdge":0.193,"fail":0.939,"timeout":0.014,"attempts":851,"recentAttempts":267,"medDays":16,"reasons":{"max loss":753,"daily loss":46}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":797,"recentAttempts":213,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0.063,"fail":0.479,"timeout":0.521,"attempts":797,"recentAttempts":213,"medDays":null,"reasons":{"max loss":382}},"0.01":{"pass":0.048,"recent":0,"noEdge":0.208,"fail":0.878,"timeout":0.074,"attempts":851,"recentAttempts":267,"medDays":96,"reasons":{"max loss":692,"daily loss":55}},"0.02":{"pass":0.027,"recent":0.022,"noEdge":0.284,"fail":0.973,"timeout":0,"attempts":854,"recentAttempts":270,"medDays":38,"reasons":{"daily loss":250,"max loss":581}}}}}},{"id":"turtle|EURUSD|4h","kind":"single","verdict":"fails","name":"Turtle Breakout 20/10","overnightShare":0.88,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0,"recent":0,"noEdge":0,"fail":0.047,"timeout":0.953,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":47}},"0.01":{"pass":0.031,"recent":0,"noEdge":0.039,"fail":0.359,"timeout":0.61,"attempts":1010,"recentAttempts":426,"medDays":4,"reasons":{"max loss":363}},"0.02":{"pass":0.155,"recent":0.107,"noEdge":0.171,"fail":0.792,"timeout":0.053,"attempts":1053,"recentAttempts":469,"medDays":7,"reasons":{"max loss":834}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0,"timeout":1,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{}},"0.005":{"pass":0.034,"recent":0,"noEdge":0.046,"fail":0.057,"timeout":0.909,"attempts":1010,"recentAttempts":426,"medDays":42,"reasons":{"max loss":58}},"0.01":{"pass":0.092,"recent":0.08,"noEdge":0.143,"fail":0.508,"timeout":0.399,"attempts":1019,"recentAttempts":435,"medDays":39,"reasons":{"max loss":518}},"0.02":{"pass":0.127,"recent":0.065,"noEdge":0.146,"fail":0.859,"timeout":0.014,"attempts":1079,"recentAttempts":495,"medDays":13,"reasons":{"max loss":829,"daily loss":98}}}}}},{"id":"trend_pullback|ES|1h","kind":"single","verdict":"fails","name":"Trend Pullback","overnightShare":0.33,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0,"fail":0.486,"timeout":0.514,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":491}},"0.005":{"pass":0.001,"recent":0.002,"noEdge":0.165,"fail":0.842,"timeout":0.157,"attempts":1011,"recentAttempts":427,"medDays":65,"reasons":{"max loss":851}},"0.01":{"pass":0.093,"recent":0.122,"noEdge":0.344,"fail":0.907,"timeout":0,"attempts":1060,"recentAttempts":476,"medDays":15,"reasons":{"max loss":961}},"0.02":{"pass":0.123,"recent":0.149,"noEdge":0.221,"fail":0.877,"timeout":0,"attempts":1081,"recentAttempts":497,"medDays":6,"reasons":{"max loss":704,"daily loss":244}}}},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0,"recent":0,"noEdge":0.091,"fail":0.572,"timeout":0.428,"attempts":1010,"recentAttempts":426,"medDays":null,"reasons":{"max loss":578}},"0.005":{"pass":0.084,"recent":0.159,"noEdge":0.346,"fail":0.893,"timeout":0.023,"attempts":1036,"recentAttempts":452,"medDays":105,"reasons":{"max loss":925}},"0.01":{"pass":0.106,"recent":0.124,"noEdge":0.35,"fail":0.894,"timeout":0,"attempts":1076,"recentAttempts":492,"medDays":19,"reasons":{"max loss":463,"daily loss":499}},"0.02":{"pass":0.093,"recent":0.094,"noEdge":0.153,"fail":0.907,"timeout":0,"attempts":1083,"recentAttempts":499,"medDays":6,"reasons":{"max loss":178,"daily loss":804}}}}}},{"id":"mix_holds_up","kind":"portfolio","verdict":null,"name":null,"overnightShare":0.76,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.274,"recent":0.255,"noEdge":0.124,"fail":0.704,"timeout":0.022,"attempts":2673,"recentAttempts":487,"medDays":11,"medCalendarDays":133,"pre2020":0.279,"reasons":{"max loss":262,"daily loss":1620},"mtm":true},"0.005":{"pass":0.143,"recent":0.16,"noEdge":0.072,"fail":0.857,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":5,"medCalendarDays":54,"pre2020":0.139,"reasons":{"daily loss":2119,"max loss":183},"mtm":true},"0.01":{"pass":0.055,"recent":0.102,"noEdge":0.032,"fail":0.945,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":4,"medCalendarDays":32,"pre2020":0.044,"reasons":{"daily loss":2175,"max loss":362},"mtm":true},"0.02":{"pass":0.02,"recent":0.06,"noEdge":0.015,"fail":0.98,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":4,"medCalendarDays":17,"pre2020":0.011,"reasons":{"daily loss":1886,"max loss":744},"mtm":true}},"mtm":true},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.164,"recent":0.19,"noEdge":0.069,"fail":0.836,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":15,"medCalendarDays":62,"pre2020":0.158,"reasons":{"max loss":45,"daily loss":2199},"mtm":true},"0.005":{"pass":0.118,"recent":0.126,"noEdge":0.071,"fail":0.882,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":6,"medCalendarDays":24,"pre2020":0.116,"reasons":{"daily loss":2328,"max loss":41},"mtm":true},"0.01":{"pass":0.116,"recent":0.118,"noEdge":0.077,"fail":0.884,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":3,"medCalendarDays":11,"pre2020":0.115,"reasons":{"daily loss":2227,"max loss":147},"mtm":true},"0.02":{"pass":0.105,"recent":0.098,"noEdge":0.072,"fail":0.895,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":2,"medCalendarDays":6,"pre2020":0.107,"reasons":{"daily loss":2012,"max loss":390},"mtm":true}},"mtm":true}}},{"id":"mix_index_daily","kind":"portfolio","verdict":null,"name":null,"overnightShare":1,"presets":{"topstep_50k":{"allowed":false},"apex_50k_eod":{"allowed":false},"apex_50k_intraday":{"allowed":false},"eod50_consistency":{"allowed":false},"ftmo_2step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.084,"recent":0.241,"noEdge":0.005,"fail":0.373,"timeout":0.544,"attempts":2614,"recentAttempts":428,"medDays":12,"medCalendarDays":317,"pre2020":0.053,"reasons":{"max loss":176,"daily loss":798},"mtm":true},"0.005":{"pass":0.159,"recent":0.294,"noEdge":0.071,"fail":0.841,"timeout":0,"attempts":2656,"recentAttempts":470,"medDays":6,"medCalendarDays":158,"pre2020":0.13,"reasons":{"daily loss":2092,"max loss":142},"mtm":true},"0.01":{"pass":0.053,"recent":0.111,"noEdge":0.028,"fail":0.947,"timeout":0,"attempts":2682,"recentAttempts":496,"medDays":4,"medCalendarDays":61,"pre2020":0.04,"reasons":{"daily loss":2383,"max loss":157},"mtm":true},"0.02":{"pass":0.01,"recent":0.012,"noEdge":0.007,"fail":0.99,"timeout":0,"attempts":2684,"recentAttempts":498,"medDays":4,"medCalendarDays":64,"pre2020":0.009,"reasons":{"daily loss":2254,"max loss":404},"mtm":true}},"mtm":true},"ftmo_1step_100k":{"allowed":true,"byRisk":{"0.0025":{"pass":0.198,"recent":0.402,"noEdge":0.044,"fail":0.711,"timeout":0.091,"attempts":2614,"recentAttempts":428,"medDays":29,"medCalendarDays":217,"pre2020":0.158,"reasons":{"max loss":45,"daily loss":1814},"mtm":true},"0.005":{"pass":0.089,"recent":0.131,"noEdge":0.036,"fail":0.911,"timeout":0,"attempts":2682,"recentAttempts":496,"medDays":8,"medCalendarDays":63,"pre2020":0.08,"reasons":{"daily loss":2423,"max loss":20},"mtm":true},"0.01":{"pass":0.059,"recent":0.062,"noEdge":0.044,"fail":0.941,"timeout":0,"attempts":2684,"recentAttempts":498,"medDays":4,"medCalendarDays":27,"pre2020":0.058,"reasons":{"daily loss":2451,"max loss":75},"mtm":true},"0.02":{"pass":0.054,"recent":0.08,"noEdge":0.036,"fail":0.946,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":3,"medCalendarDays":14,"pre2020":0.048,"reasons":{"daily loss":2293,"max loss":247},"mtm":true}},"mtm":true}}}],"portfolios":{"mix_holds_up":["turtle|USDJPY|1h","turtle|BTC|1d","rsi2|ES|1d","rsi2|NQ|1d","ibs|NQ|1d","month_end_rebal|ES|1d","turn_of_month|RUT|1d","turn_of_month|DAX|1d","turn_of_month|FTSE|1d","month_end_rebal|RUT|1d"]},"playbook":{"ids":["turtle|USDJPY|1h","turtle|BTC|1d","rsi2|ES|1d","rsi2|NQ|1d","ibs|NQ|1d","month_end_rebal|ES|1d","turn_of_month|RUT|1d","turn_of_month|DAX|1d","turn_of_month|FTSE|1d","month_end_rebal|RUT|1d"],"cap":2,"selfStopShare":0.7,"presets":{"ftmo_2step_100k":{"plain":{"0.002":{"pass":0.313,"recent":0.438,"noEdge":0.116,"fail":0.618,"timeout":0.069,"attempts":2636,"recentAttempts":450,"medDays":16,"medCalendarDays":174,"pre2020":0.288,"reasons":{"max loss":224,"daily loss":1405},"mtm":true},"0.003":{"pass":0.222,"recent":0.287,"noEdge":0.111,"fail":0.778,"timeout":0,"attempts":2673,"recentAttempts":487,"medDays":9,"medCalendarDays":101,"pre2020":0.208,"reasons":{"max loss":250,"daily loss":1829},"mtm":true},"0.004":{"pass":0.166,"recent":0.197,"noEdge":0.073,"fail":0.834,"timeout":0,"attempts":2679,"recentAttempts":493,"medDays":6,"medCalendarDays":69,"pre2020":0.16,"reasons":{"max loss":234,"daily loss":1999},"mtm":true},"0.005":{"pass":0.143,"recent":0.16,"noEdge":0.072,"fail":0.857,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":5,"medCalendarDays":54,"pre2020":0.139,"reasons":{"daily loss":2119,"max loss":183},"mtm":true}},"playbook":{"0.002":{"pass":0.376,"recent":0.464,"noEdge":0.111,"fail":0.194,"timeout":0.429,"attempts":2617,"recentAttempts":431,"medDays":16,"medCalendarDays":226,"pre2020":0.359,"reasons":{"max loss":437,"daily loss":72},"mtm":true},"0.003":{"pass":0.512,"recent":0.529,"noEdge":0.168,"fail":0.34,"timeout":0.149,"attempts":2676,"recentAttempts":490,"medDays":15,"medCalendarDays":179,"pre2020":0.508,"reasons":{"max loss":881,"daily loss":28},"mtm":true},"0.004":{"pass":0.546,"recent":0.613,"noEdge":0.182,"fail":0.424,"timeout":0.03,"attempts":2679,"recentAttempts":493,"medDays":11,"medCalendarDays":149,"pre2020":0.532,"reasons":{"max loss":1135},"mtm":true},"0.005":{"pass":0.435,"recent":0.457,"noEdge":0.212,"fail":0.546,"timeout":0.019,"attempts":2680,"recentAttempts":494,"medDays":8,"medCalendarDays":114,"pre2020":0.43,"reasons":{"max loss":1393,"daily loss":70},"mtm":true}}},"ftmo_1step_100k":{"plain":{"0.002":{"pass":0.197,"recent":0.26,"noEdge":0.082,"fail":0.803,"timeout":0,"attempts":2675,"recentAttempts":489,"medDays":22,"medCalendarDays":85,"pre2020":0.183,"reasons":{"max loss":48,"daily loss":2099},"mtm":true},"0.003":{"pass":0.156,"recent":0.154,"noEdge":0.082,"fail":0.844,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":12,"medCalendarDays":47,"pre2020":0.157,"reasons":{"daily loss":2234,"max loss":31},"mtm":true},"0.004":{"pass":0.124,"recent":0.118,"noEdge":0.069,"fail":0.876,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":8,"medCalendarDays":32,"pre2020":0.125,"reasons":{"daily loss":2302,"max loss":51},"mtm":true},"0.005":{"pass":0.118,"recent":0.126,"noEdge":0.071,"fail":0.882,"timeout":0,"attempts":2685,"recentAttempts":499,"medDays":6,"medCalendarDays":24,"pre2020":0.116,"reasons":{"daily loss":2328,"max loss":41},"mtm":true}},"playbook":{"0.002":{"pass":0.57,"recent":0.691,"noEdge":0.209,"fail":0.246,"timeout":0.184,"attempts":2671,"recentAttempts":485,"medDays":48,"medCalendarDays":174,"pre2020":0.543,"reasons":{"max loss":623,"daily loss":35},"mtm":true},"0.003":{"pass":0.573,"recent":0.574,"noEdge":0.27,"fail":0.37,"timeout":0.057,"attempts":2679,"recentAttempts":493,"medDays":32,"medCalendarDays":123,"pre2020":0.573,"reasons":{"max loss":890,"daily loss":100},"mtm":true},"0.004":{"pass":0.536,"recent":0.454,"noEdge":0.268,"fail":0.461,"timeout":0.003,"attempts":2679,"recentAttempts":493,"medDays":22,"medCalendarDays":96,"pre2020":0.554,"reasons":{"max loss":1185,"daily loss":50},"mtm":true},"0.005":{"pass":0.483,"recent":0.327,"noEdge":0.263,"fail":0.514,"timeout":0.003,"attempts":2679,"recentAttempts":493,"medDays":19,"medCalendarDays":78,"pre2020":0.519,"reasons":{"max loss":1316,"daily loss":60},"mtm":true}}}},"funded":{"ftmo_2step_100k":{"0.002":{"pass":0.368,"paidAny":0.342,"meanPaid":3767,"ev":3177,"medianPaidIfPaid":9582,"fundedBreach":0.348,"evPre2020":3075,"evSince2020":3807,"attempts":2541,"halfEdgeEv":1160,"halfEdgePaidAny":0.222,"luckEv":64,"plainEv":2533,"plainPaidAny":0.266},"0.003":{"pass":0.531,"paidAny":0.483,"meanPaid":6891,"ev":6301,"medianPaidIfPaid":11440,"fundedBreach":0.501,"evPre2020":5838,"evSince2020":9150,"attempts":2541,"halfEdgeEv":2666,"halfEdgePaidAny":0.277,"luckEv":769,"plainEv":886,"plainPaidAny":0.173},"0.004":{"pass":0.553,"paidAny":0.471,"meanPaid":6989,"ev":6399,"medianPaidIfPaid":11304,"fundedBreach":0.769,"evPre2020":6127,"evSince2020":8074,"attempts":2541,"halfEdgeEv":2482,"halfEdgePaidAny":0.268,"luckEv":731,"plainEv":126,"plainPaidAny":0.101},"0.005":{"pass":0.437,"paidAny":0.331,"meanPaid":4662,"ev":4072,"medianPaidIfPaid":8929,"fundedBreach":0.89,"evPre2020":4477,"evSince2020":1580,"attempts":2541,"halfEdgeEv":1698,"halfEdgePaidAny":0.202,"luckEv":811,"plainEv":-2,"plainPaidAny":0.078}},"ftmo_1step_100k":{"0.002":{"pass":0.575,"paidAny":0.414,"meanPaid":4802,"ev":4257,"medianPaidIfPaid":9778,"fundedBreach":0.332,"evPre2020":3911,"evSince2020":6387,"attempts":2541,"halfEdgeEv":1111,"halfEdgePaidAny":0.178,"luckEv":299,"plainEv":124,"plainPaidAny":0.09},"0.003":{"pass":0.58,"paidAny":0.326,"meanPaid":4503,"ev":3958,"medianPaidIfPaid":11346,"fundedBreach":0.558,"evPre2020":4012,"evSince2020":3625,"attempts":2541,"halfEdgeEv":1750,"halfEdgePaidAny":0.186,"luckEv":507,"plainEv":-291,"plainPaidAny":0.043},"0.004":{"pass":0.545,"paidAny":0.303,"meanPaid":5295,"ev":4750,"medianPaidIfPaid":13515,"fundedBreach":0.73,"evPre2020":4957,"evSince2020":3481,"attempts":2541,"halfEdgeEv":1350,"halfEdgePaidAny":0.159,"luckEv":335,"plainEv":-388,"plainPaidAny":0.016},"0.005":{"pass":0.494,"paidAny":0.238,"meanPaid":4308,"ev":3763,"medianPaidIfPaid":17556,"fundedBreach":0.819,"evPre2020":4270,"evSince2020":644,"attempts":2541,"halfEdgeEv":607,"halfEdgePaidAny":0.107,"luckEv":2,"plainEv":-352,"plainPaidAny":0.015}}},"fundedRules":{"ftmo_2step_100k":{"split":0.8,"every":14,"refund":true,"bestDayShare":null},"ftmo_1step_100k":{"split":0.9,"every":14,"refund":false,"bestDayShare":0.5},"fundednext_2step_100k":{"split":0.8,"first":21,"every":14,"refund":true,"bestDayShare":null}},"financing":true,"confidence":{"ftmo_2step_100k":{"0.002":{"playbook":{"ev":3177,"lo":1932,"hi":4483,"probNeg":0,"years":35,"yearsNegative":13,"worstYear":-590,"bestYear":16885},"halfEdge":{"ev":1160,"lo":401,"hi":2036,"probNeg":0.005,"years":35,"yearsNegative":20,"worstYear":-590,"bestYear":11027},"luck":{"ev":64,"lo":-301,"hi":519,"probNeg":0.417,"years":35,"yearsNegative":28,"worstYear":-590,"bestYear":5710}},"0.003":{"playbook":{"ev":6301,"lo":4257,"hi":8637,"probNeg":0,"years":35,"yearsNegative":7,"worstYear":-590,"bestYear":30147},"halfEdge":{"ev":2666,"lo":1286,"hi":4363,"probNeg":0,"years":35,"yearsNegative":17,"worstYear":-590,"bestYear":24340},"luck":{"ev":769,"lo":3,"hi":1818,"probNeg":0.05,"years":35,"yearsNegative":28,"worstYear":-590,"bestYear":14687}},"0.004":{"playbook":{"ev":6399,"lo":4283,"hi":9170,"probNeg":0,"years":35,"yearsNegative":3,"worstYear":-590,"bestYear":38532},"halfEdge":{"ev":2482,"lo":1076,"hi":4455,"probNeg":0,"years":35,"yearsNegative":16,"worstYear":-590,"bestYear":29069},"luck":{"ev":731,"lo":-35,"hi":1879,"probNeg":0.06,"years":35,"yearsNegative":26,"worstYear":-590,"bestYear":16936}},"0.005":{"playbook":{"ev":4072,"lo":2047,"hi":6477,"probNeg":0,"years":35,"yearsNegative":7,"worstYear":-590,"bestYear":39954},"halfEdge":{"ev":1698,"lo":515,"hi":3242,"probNeg":0,"years":35,"yearsNegative":16,"worstYear":-590,"bestYear":25400},"luck":{"ev":811,"lo":-13,"hi":1902,"probNeg":0.055,"years":35,"yearsNegative":22,"worstYear":-590,"bestYear":17910}}},"ftmo_1step_100k":{"0.002":{"playbook":{"ev":4257,"lo":2871,"hi":5870,"probNeg":0,"years":35,"yearsNegative":13,"worstYear":-545,"bestYear":20723},"halfEdge":{"ev":1111,"lo":282,"hi":2210,"probNeg":0.007,"years":35,"yearsNegative":23,"worstYear":-545,"bestYear":16482},"luck":{"ev":299,"lo":-300,"hi":1123,"probNeg":0.247,"years":35,"yearsNegative":29,"worstYear":-545,"bestYear":12981}},"0.003":{"playbook":{"ev":3958,"lo":2220,"hi":5777,"probNeg":0,"years":35,"yearsNegative":10,"worstYear":-545,"bestYear":27408},"halfEdge":{"ev":1750,"lo":585,"hi":3093,"probNeg":0.002,"years":35,"yearsNegative":20,"worstYear":-545,"bestYear":21825},"luck":{"ev":507,"lo":-245,"hi":1470,"probNeg":0.149,"years":35,"yearsNegative":29,"worstYear":-545,"bestYear":15446}},"0.004":{"playbook":{"ev":4750,"lo":2830,"hi":7145,"probNeg":0,"years":35,"yearsNegative":9,"worstYear":-545,"bestYear":25728},"halfEdge":{"ev":1350,"lo":521,"hi":2506,"probNeg":0.002,"years":35,"yearsNegative":21,"worstYear":-545,"bestYear":15484},"luck":{"ev":335,"lo":-202,"hi":1098,"probNeg":0.182,"years":35,"yearsNegative":27,"worstYear":-545,"bestYear":11477}},"0.005":{"playbook":{"ev":3763,"lo":2517,"hi":5306,"probNeg":0,"years":35,"yearsNegative":12,"worstYear":-545,"bestYear":18428},"halfEdge":{"ev":607,"lo":175,"hi":1158,"probNeg":0.006,"years":35,"yearsNegative":20,"worstYear":-545,"bestYear":5417},"luck":{"ev":2,"lo":-295,"hi":375,"probNeg":0.498,"years":35,"yearsNegative":25,"worstYear":-545,"bestYear":4478}}},"fundednext_2step_100k":{"0.002":{"playbook":{"ev":4157,"lo":2734,"hi":5604,"probNeg":0,"years":35,"yearsNegative":13,"worstYear":-550,"bestYear":17610},"halfEdge":{"ev":1661,"lo":777,"hi":2641,"probNeg":0.001,"years":35,"yearsNegative":17,"worstYear":-550,"bestYear":12001},"luck":{"ev":405,"lo":-54,"hi":989,"probNeg":0.075,"years":35,"yearsNegative":25,"worstYear":-550,"bestYear":7229}},"0.003":{"playbook":{"ev":7461,"lo":5336,"hi":9800,"probNeg":0,"years":35,"yearsNegative":5,"worstYear":-550,"bestYear":30351},"halfEdge":{"ev":3294,"lo":1843,"hi":5054,"probNeg":0,"years":35,"yearsNegative":15,"worstYear":-550,"bestYear":25012},"luck":{"ev":1028,"lo":180,"hi":2182,"probNeg":0.02,"years":35,"yearsNegative":26,"worstYear":-550,"bestYear":15952}},"0.004":{"playbook":{"ev":7015,"lo":4841,"hi":9815,"probNeg":0,"years":35,"yearsNegative":2,"worstYear":-424,"bestYear":39172},"halfEdge":{"ev":2785,"lo":1380,"hi":4776,"probNeg":0,"years":35,"yearsNegative":13,"worstYear":-550,"bestYear":30373},"luck":{"ev":999,"lo":175,"hi":2246,"probNeg":0.016,"years":35,"yearsNegative":23,"worstYear":-550,"bestYear":18162}},"0.005":{"playbook":{"ev":4378,"lo":2455,"hi":6765,"probNeg":0,"years":35,"yearsNegative":6,"worstYear":-550,"bestYear":40484},"halfEdge":{"ev":2125,"lo":911,"hi":3715,"probNeg":0,"years":35,"yearsNegative":11,"worstYear":-550,"bestYear":26271},"luck":{"ev":1007,"lo":186,"hi":2146,"probNeg":0.009,"years":35,"yearsNegative":20,"worstYear":-550,"bestYear":18876}}}},"compareFirm":{"id":"fundednext_2step_100k","label":"FundedNext-style 2-step","target1":0.08,"risk":0.003,"fee":550,"pass":0.597,"paidAny":0.55,"ev":7461,"halfEdgeEv":3294,"luckEv":1028},"budget":{"horizonDays":1095,"firms":{"ftmo_2step_100k":{"plans":{"base":{"risk":0.003,"fundedRisk":0.003,"playbook":{"meanNet":23325,"medianNet":19148,"p10":3828,"p90":46995,"ahead":0.936,"meanFees":1688,"feesP90":2360,"feesMax":4130,"lo":18938,"hi":27408,"early":{"traders":1309,"meanNet":22046,"ahead":0.963},"late":{"traders":1159,"meanNet":24769,"ahead":0.905},"since2020":{"traders":282,"meanNet":25959,"ahead":1}},"halfEdge":{"meanNet":11400,"medianNet":8135,"p10":-1770,"p90":30593,"ahead":0.737,"meanFees":2084,"feesP90":3540,"feesMax":4130,"lo":8099,"hi":14618,"early":{"traders":1309,"meanNet":11408,"ahead":0.715},"late":{"traders":1159,"meanNet":11392,"ahead":0.761},"since2020":{"traders":282,"meanNet":8803,"ahead":0.535}},"luck":{"meanNet":2866,"medianNet":-1180,"p10":-4130,"p90":16852,"ahead":0.427,"meanFees":2678,"feesP90":4130,"feesMax":5900,"lo":743,"hi":5212,"early":{"traders":1309,"meanNet":5032,"ahead":0.5},"late":{"traders":1159,"meanNet":420,"ahead":0.343},"since2020":{"traders":282,"meanNet":-1507,"ahead":0.213}}},"push":{"risk":0.004,"fundedRisk":0.002,"playbook":{"meanNet":20580,"medianNet":19557,"p10":5368,"p90":35896,"ahead":0.984,"meanFees":1668,"feesP90":2950,"feesMax":4720,"lo":17704,"hi":23133,"early":{"traders":1309,"meanNet":19214,"ahead":0.991},"late":{"traders":1159,"meanNet":22123,"ahead":0.977},"since2020":{"traders":282,"meanNet":22256,"ahead":1}},"halfEdge":{"meanNet":10982,"medianNet":10898,"p10":-1512,"p90":26157,"ahead":0.869,"meanFees":2182,"feesP90":3540,"feesMax":4720,"lo":8515,"hi":13213,"early":{"traders":1309,"meanNet":10633,"ahead":0.855},"late":{"traders":1159,"meanNet":11376,"ahead":0.884},"since2020":{"traders":282,"meanNet":10640,"ahead":1}},"luck":{"meanNet":2753,"medianNet":-292,"p10":-4720,"p90":15626,"ahead":0.488,"meanFees":3194,"feesP90":5310,"feesMax":6490,"lo":963,"hi":4632,"early":{"traders":1309,"meanNet":4290,"ahead":0.638},"late":{"traders":1159,"meanNet":1017,"ahead":0.319},"since2020":{"traders":282,"meanNet":1762,"ahead":0.394}}}},"feeCaps":{"1":{"ahead":0.372,"meanNet":4513},"3":{"ahead":0.669,"meanNet":10430},"5":{"ahead":0.73,"meanNet":11360},"any":{"ahead":0.737,"meanNet":11400}},"twoAccounts":{"0":{"pairs":2614,"passA":0.523,"passB":0.523,"both":0.523,"either":0.523,"ifIndependent":0.772,"bothFail":0.325,"failA":0.325},"30":{"pairs":2608,"passA":0.524,"passB":0.524,"both":0.447,"either":0.601,"ifIndependent":0.773,"bothFail":0.249,"failA":0.324},"90":{"pairs":2596,"passA":0.524,"passB":0.527,"both":0.396,"either":0.654,"ifIndependent":0.775,"bothFail":0.204,"failA":0.323},"180":{"pairs":2578,"passA":0.527,"passB":0.53,"both":0.33,"either":0.727,"ifIndependent":0.778,"bothFail":0.143,"failA":0.318},"365":{"pairs":2541,"passA":0.531,"passB":0.527,"both":0.27,"either":0.787,"ifIndependent":0.778,"bothFail":0.104,"failA":0.313}}},"ftmo_1step_100k":{"plans":{"base":{"risk":0.003,"fundedRisk":0.003,"playbook":{"meanNet":19115,"medianNet":15706,"p10":-1635,"p90":42848,"ahead":0.811,"meanFees":1949,"feesP90":2725,"feesMax":3270,"lo":14457,"hi":23450,"early":{"traders":1309,"meanNet":20752,"ahead":0.859},"late":{"traders":1159,"meanNet":17266,"ahead":0.758},"since2020":{"traders":282,"meanNet":18153,"ahead":1}},"halfEdge":{"meanNet":6790,"medianNet":2061,"p10":-3270,"p90":23086,"ahead":0.571,"meanFees":2414,"feesP90":3270,"feesMax":4905,"lo":3698,"hi":9927,"early":{"traders":1309,"meanNet":10136,"ahead":0.714},"late":{"traders":1159,"meanNet":3012,"ahead":0.41},"since2020":{"traders":282,"meanNet":-2555,"ahead":0.11}},"luck":{"meanNet":1128,"medianNet":-2725,"p10":-4905,"p90":11115,"ahead":0.32,"meanFees":3087,"feesP90":4905,"feesMax":5450,"lo":-1012,"hi":3517,"early":{"traders":1309,"meanNet":4384,"ahead":0.484},"late":{"traders":1159,"meanNet":-2550,"ahead":0.135},"since2020":{"traders":282,"meanNet":-4182,"ahead":0.004}}},"push":{"risk":0.004,"fundedRisk":0.002,"playbook":{"meanNet":20627,"medianNet":21049,"p10":751,"p90":39605,"ahead":0.908,"meanFees":1633,"feesP90":3270,"feesMax":4360,"lo":17086,"hi":23771,"early":{"traders":1309,"meanNet":19163,"ahead":0.93},"late":{"traders":1159,"meanNet":22281,"ahead":0.883},"since2020":{"traders":282,"meanNet":25032,"ahead":1}},"halfEdge":{"meanNet":8208,"medianNet":7254,"p10":-2725,"p90":20848,"ahead":0.811,"meanFees":2344,"feesP90":4360,"feesMax":5995,"lo":5769,"hi":10763,"early":{"traders":1309,"meanNet":9786,"ahead":0.874},"late":{"traders":1159,"meanNet":6426,"ahead":0.739},"since2020":{"traders":282,"meanNet":8515,"ahead":0.865}},"luck":{"meanNet":2867,"medianNet":330,"p10":-5450,"p90":14675,"ahead":0.514,"meanFees":3182,"feesP90":5995,"feesMax":7085,"lo":916,"hi":5179,"early":{"traders":1309,"meanNet":5472,"ahead":0.567},"late":{"traders":1159,"meanNet":-76,"ahead":0.455},"since2020":{"traders":282,"meanNet":726,"ahead":0.514}}}},"feeCaps":{"1":{"ahead":0.22,"meanNet":2858},"3":{"ahead":0.484,"meanNet":6410},"5":{"ahead":0.566,"meanNet":6922},"any":{"ahead":0.571,"meanNet":6790}},"twoAccounts":{"0":{"pairs":2614,"passA":0.581,"passB":0.581,"both":0.581,"either":0.581,"ifIndependent":0.824,"bothFail":0.361,"failA":0.361},"30":{"pairs":2608,"passA":0.58,"passB":0.582,"both":0.498,"either":0.663,"ifIndependent":0.824,"bothFail":0.292,"failA":0.362},"90":{"pairs":2596,"passA":0.578,"passB":0.585,"both":0.417,"either":0.745,"ifIndependent":0.825,"bothFail":0.213,"failA":0.363},"180":{"pairs":2578,"passA":0.578,"passB":0.589,"both":0.359,"either":0.808,"ifIndependent":0.826,"bothFail":0.145,"failA":0.363},"365":{"pairs":2541,"passA":0.58,"passB":0.583,"both":0.33,"either":0.833,"ifIndependent":0.825,"bothFail":0.12,"failA":0.36}}},"fundednext_2step_100k":{"plans":{"base":{"risk":0.003,"fundedRisk":0.003,"playbook":{"meanNet":25592,"medianNet":23554,"p10":5133,"p90":48759,"ahead":0.966,"meanFees":1619,"feesP90":2200,"feesMax":3850,"lo":21296,"hi":29503,"early":{"traders":1309,"meanNet":23396,"ahead":0.973},"late":{"traders":1159,"meanNet":28072,"ahead":0.959},"since2020":{"traders":282,"meanNet":28893,"ahead":1}},"halfEdge":{"meanNet":13681,"medianNet":11027,"p10":-1650,"p90":32626,"ahead":0.824,"meanFees":1991,"feesP90":3300,"feesMax":4950,"lo":10253,"hi":16923,"early":{"traders":1309,"meanNet":12976,"ahead":0.765},"late":{"traders":1159,"meanNet":14476,"ahead":0.89},"since2020":{"traders":282,"meanNet":12197,"ahead":0.904}},"luck":{"meanNet":3822,"medianNet":-716,"p10":-3850,"p90":18342,"ahead":0.465,"meanFees":2667,"feesP90":3850,"feesMax":5500,"lo":1525,"hi":6311,"early":{"traders":1309,"meanNet":6307,"ahead":0.54},"late":{"traders":1159,"meanNet":1015,"ahead":0.381},"since2020":{"traders":282,"meanNet":-1020,"ahead":0.213}}},"push":{"risk":0.004,"fundedRisk":0.002,"playbook":{"meanNet":22050,"medianNet":21298,"p10":7101,"p90":36490,"ahead":0.996,"meanFees":1479,"feesP90":2750,"feesMax":3850,"lo":19177,"hi":24558,"early":{"traders":1309,"meanNet":20356,"ahead":0.992},"late":{"traders":1159,"meanNet":23963,"ahead":1},"since2020":{"traders":282,"meanNet":23648,"ahead":1}},"halfEdge":{"meanNet":12338,"medianNet":11537,"p10":256,"p90":27118,"ahead":0.92,"meanFees":2023,"feesP90":3300,"feesMax":4400,"lo":9909,"hi":14570,"early":{"traders":1309,"meanNet":12315,"ahead":0.926},"late":{"traders":1159,"meanNet":12363,"ahead":0.914},"since2020":{"traders":282,"meanNet":11310,"ahead":1}},"luck":{"meanNet":4426,"medianNet":2916,"p10":-3431,"p90":15296,"ahead":0.569,"meanFees":2831,"feesP90":4950,"feesMax":6050,"lo":2591,"hi":6340,"early":{"traders":1309,"meanNet":5997,"ahead":0.663},"late":{"traders":1159,"meanNet":2651,"ahead":0.462},"since2020":{"traders":282,"meanNet":712,"ahead":0.238}}}},"feeCaps":{"1":{"ahead":0.413,"meanNet":5287},"3":{"ahead":0.703,"meanNet":12271},"5":{"ahead":0.81,"meanNet":13555},"any":{"ahead":0.824,"meanNet":13681}},"twoAccounts":{"0":{"pairs":2614,"passA":0.593,"passB":0.593,"both":0.593,"either":0.593,"ifIndependent":0.834,"bothFail":0.322,"failA":0.322},"30":{"pairs":2608,"passA":0.593,"passB":0.594,"both":0.515,"either":0.672,"ifIndependent":0.835,"bothFail":0.238,"failA":0.322},"90":{"pairs":2596,"passA":0.592,"passB":0.597,"both":0.474,"either":0.715,"ifIndependent":0.835,"bothFail":0.2,"failA":0.322},"180":{"pairs":2578,"passA":0.593,"passB":0.601,"both":0.403,"either":0.791,"ifIndependent":0.838,"bothFail":0.14,"failA":0.32},"365":{"pairs":2541,"passA":0.597,"passB":0.595,"both":0.337,"either":0.855,"ifIndependent":0.837,"bothFail":0.088,"failA":0.316}}}},"twoFirmsSameDay":{"pairs":2614,"passA":0.523,"passB":0.593,"both":0.518,"either":0.598,"ifIndependent":0.806}},"costStress":{"ftmo_2step_100k":{"base":{"pass":0.512,"luck":0.168,"ev":6301,"halfEdgeEv":2666,"aheadHalf":0.737},"double":{"pass":0.434,"luck":0.182,"ev":4590,"halfEdgeEv":2163,"aheadHalf":0.692}},"ftmo_1step_100k":{"base":{"pass":0.573,"luck":0.27,"ev":3958,"halfEdgeEv":1750,"aheadHalf":0.571},"double":{"pass":0.487,"luck":0.267,"ev":2687,"halfEdgeEv":1370,"aheadHalf":0.489}}},"vix":{"hotShare":{"25":0.179,"30":0.078,"35":0.04,"40":0.024},"firms":{"ftmo_2step_100k":{"walkforward":{"pick":"skip35","earlyEv":1875,"lateEv":44,"baseLateEv":277,"rankLate":6,"of":9},"variants":{"base":{"label":"no filter","pass":0.369,"fail":0.266,"dailyLossFails":0,"ev":3409,"halfEdgeEv":1075,"halfEarly":1826,"halfLate":277},"skip25":{"label":"skip index trades when VIX > 25","pass":0.3,"fail":0.202,"dailyLossFails":0,"ev":2236,"halfEdgeEv":723,"halfEarly":1675,"halfLate":-287},"half25":{"label":"half size when VIX > 25","pass":0.342,"fail":0.203,"dailyLossFails":0,"ev":2831,"halfEdgeEv":750,"halfEarly":1619,"halfLate":-173},"skip30":{"label":"skip index trades when VIX > 30","pass":0.34,"fail":0.229,"dailyLossFails":0,"ev":2910,"halfEdgeEv":826,"halfEarly":1628,"halfLate":-26},"half30":{"label":"half size when VIX > 30","pass":0.347,"fail":0.244,"dailyLossFails":0,"ev":3117,"halfEdgeEv":966,"halfEarly":1734,"halfLate":151},"skip35":{"label":"skip index trades when VIX > 35","pass":0.344,"fail":0.262,"dailyLossFails":0,"ev":3118,"halfEdgeEv":987,"halfEarly":1875,"halfLate":44},"half35":{"label":"half size when VIX > 35","pass":0.346,"fail":0.265,"dailyLossFails":0,"ev":3115,"halfEdgeEv":950,"halfEarly":1765,"halfLate":83},"skip40":{"label":"skip index trades when VIX > 40","pass":0.355,"fail":0.261,"dailyLossFails":0,"ev":3246,"halfEdgeEv":1042,"halfEarly":1857,"halfLate":176},"half40":{"label":"half size when VIX > 40","pass":0.351,"fail":0.265,"dailyLossFails":0,"ev":3189,"halfEdgeEv":1017,"halfEarly":1826,"halfLate":158}}},"ftmo_1step_100k":{"walkforward":{"pick":"skip30","earlyEv":1905,"lateEv":-230,"baseLateEv":-65,"rankLate":6,"of":9},"variants":{"base":{"label":"no filter","pass":0.449,"fail":0.373,"dailyLossFails":0.016,"ev":2287,"halfEdgeEv":600,"halfEarly":1225,"halfLate":-65},"skip25":{"label":"skip index trades when VIX > 25","pass":0.4,"fail":0.3,"dailyLossFails":0.018,"ev":1556,"halfEdgeEv":603,"halfEarly":1527,"halfLate":-377},"half25":{"label":"half size when VIX > 25","pass":0.454,"fail":0.323,"dailyLossFails":0.017,"ev":1951,"halfEdgeEv":455,"halfEarly":1258,"halfLate":-399},"skip30":{"label":"skip index trades when VIX > 30","pass":0.444,"fail":0.339,"dailyLossFails":0.016,"ev":2216,"halfEdgeEv":870,"halfEarly":1905,"halfLate":-230},"half30":{"label":"half size when VIX > 30","pass":0.444,"fail":0.349,"dailyLossFails":0.016,"ev":2139,"halfEdgeEv":587,"halfEarly":1395,"halfLate":-272},"skip35":{"label":"skip index trades when VIX > 35","pass":0.436,"fail":0.348,"dailyLossFails":0.016,"ev":2190,"halfEdgeEv":658,"halfEarly":1448,"halfLate":-182},"half35":{"label":"half size when VIX > 35","pass":0.45,"fail":0.351,"dailyLossFails":0.016,"ev":2244,"halfEdgeEv":571,"halfEarly":1279,"halfLate":-181},"skip40":{"label":"skip index trades when VIX > 40","pass":0.437,"fail":0.363,"dailyLossFails":0.016,"ev":2268,"halfEdgeEv":596,"halfEarly":1293,"halfLate":-145},"half40":{"label":"half size when VIX > 40","pass":0.453,"fail":0.358,"dailyLossFails":0.016,"ev":2415,"halfEdgeEv":642,"halfEarly":1274,"halfLate":-30}}},"fundednext_2step_100k":{"walkforward":{"pick":"skip35","earlyEv":2385,"lateEv":266,"baseLateEv":597,"rankLate":6,"of":9},"variants":{"base":{"label":"no filter","pass":0.482,"fail":0.263,"dailyLossFails":0,"ev":4101,"halfEdgeEv":1440,"halfEarly":2233,"halfLate":597},"skip25":{"label":"skip index trades when VIX > 25","pass":0.419,"fail":0.196,"dailyLossFails":0,"ev":2960,"halfEdgeEv":993,"halfEarly":2012,"halfLate":-89},"half25":{"label":"half size when VIX > 25","pass":0.444,"fail":0.207,"dailyLossFails":0,"ev":3449,"halfEdgeEv":1129,"halfEarly":2131,"halfLate":64},"skip30":{"label":"skip index trades when VIX > 30","pass":0.442,"fail":0.231,"dailyLossFails":0,"ev":3507,"halfEdgeEv":1172,"halfEarly":2051,"halfLate":238},"half30":{"label":"half size when VIX > 30","pass":0.452,"fail":0.244,"dailyLossFails":0,"ev":3751,"halfEdgeEv":1307,"halfEarly":2157,"halfLate":404},"skip35":{"label":"skip index trades when VIX > 35","pass":0.44,"fail":0.259,"dailyLossFails":0,"ev":3628,"halfEdgeEv":1357,"halfEarly":2385,"halfLate":266},"half35":{"label":"half size when VIX > 35","pass":0.462,"fail":0.262,"dailyLossFails":0,"ev":3838,"halfEdgeEv":1286,"halfEarly":2207,"halfLate":308},"skip40":{"label":"skip index trades when VIX > 40","pass":0.462,"fail":0.257,"dailyLossFails":0,"ev":3901,"halfEdgeEv":1366,"halfEarly":2263,"halfLate":413},"half40":{"label":"half size when VIX > 40","pass":0.463,"fail":0.262,"dailyLossFails":0,"ev":3900,"halfEdgeEv":1349,"halfEarly":2232,"halfLate":412}}}}},"drawdown":{"firms":{"ftmo_2step_100k":{"walkforward":{"pick":"base","earlyEv":1826,"lateEv":277,"baseLateEv":277,"rankLate":1,"of":7},"variants":{"base":{"label":"same size always","pass":0.369,"fail":0.266,"fundedLost":0.432,"ev":3409,"halfEdgeEv":1075},"half30":{"label":"half size once down 30% of the max loss","pass":0.294,"fail":0.111,"fundedLost":0.226,"ev":2096,"halfEdgeEv":522},"half50":{"label":"half size once down 50% of the max loss","pass":0.346,"fail":0.15,"fundedLost":0.28,"ev":3050,"halfEdgeEv":826},"half70":{"label":"half size once down 70% of the max loss","pass":0.367,"fail":0.189,"fundedLost":0.281,"ev":3474,"halfEdgeEv":1050},"quarter50":{"label":"quarter size once down 50% of the max loss","pass":0.329,"fail":0.063,"fundedLost":0.123,"ev":2629,"halfEdgeEv":562},"steps":{"label":"three-quarter size from 25% down, half from 50%, quarter from 75%","pass":0.322,"fail":0.091,"fundedLost":0.151,"ev":2652,"halfEdgeEv":703},"linear":{"label":"size falls in step with the drawdown (never below a quarter)","pass":0.296,"fail":0.056,"fundedLost":0.128,"ev":2439,"halfEdgeEv":514}},"threeYear":{"base":{"ahead":0.88,"halfAhead":0.612,"halfMedian":2000,"halfFees":1606},"half70":{"ahead":0.861,"halfAhead":0.564,"halfMedian":2276,"halfFees":1426},"half50":{"ahead":0.831,"halfAhead":0.5,"halfMedian":-1,"halfFees":1327},"quarter50":{"ahead":0.688,"halfAhead":0.389,"halfMedian":-590,"halfFees":961},"linear":{"ahead":0.719,"halfAhead":0.351,"halfMedian":-590,"halfFees":934}}},"ftmo_1step_100k":{"walkforward":{"pick":"half70","earlyEv":1238,"lateEv":-116,"baseLateEv":-65,"rankLate":4,"of":7},"variants":{"base":{"label":"same size always","pass":0.449,"fail":0.373,"fundedLost":0.423,"ev":2287,"halfEdgeEv":600},"half30":{"label":"half size once down 30% of the max loss","pass":0.437,"fail":0.267,"fundedLost":0.142,"ev":2152,"halfEdgeEv":496},"half50":{"label":"half size once down 50% of the max loss","pass":0.434,"fail":0.316,"fundedLost":0.278,"ev":2181,"halfEdgeEv":594},"half70":{"label":"half size once down 70% of the max loss","pass":0.443,"fail":0.355,"fundedLost":0.399,"ev":2167,"halfEdgeEv":581},"quarter50":{"label":"quarter size once down 50% of the max loss","pass":0.432,"fail":0.255,"fundedLost":0.201,"ev":2057,"halfEdgeEv":562},"steps":{"label":"three-quarter size from 25% down, half from 50%, quarter from 75%","pass":0.428,"fail":0.304,"fundedLost":0.223,"ev":2066,"halfEdgeEv":497},"linear":{"label":"size falls in step with the drawdown (never below a quarter)","pass":0.431,"fail":0.238,"fundedLost":0.133,"ev":1766,"halfEdgeEv":389}},"threeYear":{"base":{"ahead":0.708,"halfAhead":0.468,"halfMedian":-545,"halfFees":2142},"half70":{"ahead":0.704,"halfAhead":0.449,"halfMedian":-1090,"halfFees":1988},"half50":{"ahead":0.691,"halfAhead":0.386,"halfMedian":-1090,"halfFees":1837},"quarter50":{"ahead":0.577,"halfAhead":0.355,"halfMedian":-1090,"halfFees":1433},"linear":{"ahead":0.576,"halfAhead":0.279,"halfMedian":-1090,"halfFees":1253}}},"fundednext_2step_100k":{"walkforward":{"pick":"base","earlyEv":2233,"lateEv":597,"baseLateEv":597,"rankLate":2,"of":7},"variants":{"base":{"label":"same size always","pass":0.482,"fail":0.263,"fundedLost":0.478,"ev":4101,"halfEdgeEv":1440},"half30":{"label":"half size once down 30% of the max loss","pass":0.39,"fail":0.111,"fundedLost":0.233,"ev":2633,"halfEdgeEv":782},"half50":{"label":"half size once down 50% of the max loss","pass":0.44,"fail":0.149,"fundedLost":0.273,"ev":3689,"halfEdgeEv":1096},"half70":{"label":"half size once down 70% of the max loss","pass":0.483,"fail":0.194,"fundedLost":0.299,"ev":4355,"halfEdgeEv":1426},"quarter50":{"label":"quarter size once down 50% of the max loss","pass":0.419,"fail":0.062,"fundedLost":0.115,"ev":3125,"halfEdgeEv":788},"steps":{"label":"three-quarter size from 25% down, half from 50%, quarter from 75%","pass":0.418,"fail":0.089,"fundedLost":0.187,"ev":3176,"halfEdgeEv":989},"linear":{"label":"size falls in step with the drawdown (never below a quarter)","pass":0.377,"fail":0.056,"fundedLost":0.135,"ev":2950,"halfEdgeEv":755}},"threeYear":{"base":{"ahead":0.938,"halfAhead":0.673,"halfMedian":3075,"halfFees":1620},"half70":{"ahead":0.92,"halfAhead":0.652,"halfMedian":3436,"halfFees":1429},"half50":{"ahead":0.853,"halfAhead":0.598,"halfMedian":1863,"halfFees":1293},"quarter50":{"ahead":0.732,"halfAhead":0.435,"halfMedian":-550,"halfFees":947},"linear":{"ahead":0.755,"halfAhead":0.386,"halfMedian":-550,"halfFees":881}}}}},"capRule":{"id":"cap3us2","maxIndex":3,"maxUs":2,"text":"at most 3 stock-index trades at once, no more than 2 of them US"},"sideStudiesCap":"cap2","capStudy":{"split":20080101,"rules":[{"id":"cap2","label":"at most 2 index trades (the playbook)","drop":null},{"id":"cap2market","label":"at most 2, and 1 per index","drop":null},{"id":"cap2region","label":"at most 1 US and 1 European index trade","drop":null},{"id":"cap3","label":"at most 3 index trades","drop":null},{"id":"cap3region","label":"at most 3, of which at most 2 US","drop":null},{"id":"cap2noTomRut","label":"at most 2, without turn of the month on the Russell 2000","drop":"turn_of_month|RUT|1d"}],"kept":{"cap2":{"ibs|NQ|1d":967,"turn_of_month|RUT|1d":401,"turn_of_month|FTSE|1d":59,"rsi2|ES|1d":263,"rsi2|NQ|1d":223,"turn_of_month|DAX|1d":285,"month_end_rebal|ES|1d":255,"month_end_rebal|RUT|1d":175,"turtle|USDJPY|1h":3238,"turtle|BTC|1d":74},"cap2market":{"ibs|NQ|1d":923,"turn_of_month|RUT|1d":407,"turn_of_month|FTSE|1d":59,"rsi2|ES|1d":266,"rsi2|NQ|1d":185,"turn_of_month|DAX|1d":286,"month_end_rebal|ES|1d":253,"month_end_rebal|RUT|1d":181,"turtle|USDJPY|1h":3238,"turtle|BTC|1d":74},"cap2region":{"ibs|NQ|1d":888,"turn_of_month|FTSE|1d":70,"turn_of_month|RUT|1d":311,"rsi2|ES|1d":180,"rsi2|NQ|1d":97,"turn_of_month|DAX|1d":371,"month_end_rebal|ES|1d":177,"turtle|USDJPY|1h":3238,"turtle|BTC|1d":74,"month_end_rebal|RUT|1d":1},"cap3":{"ibs|NQ|1d":1116,"turn_of_month|RUT|1d":414,"turn_of_month|FTSE|1d":300,"rsi2|ES|1d":294,"rsi2|NQ|1d":285,"turn_of_month|DAX|1d":360,"month_end_rebal|ES|1d":266,"month_end_rebal|RUT|1d":254,"turtle|USDJPY|1h":3238,"turtle|BTC|1d":74},"cap3region":{"ibs|NQ|1d":988,"turn_of_month|RUT|1d":402,"turn_of_month|FTSE|1d":340,"rsi2|ES|1d":267,"rsi2|NQ|1d":224,"turn_of_month|DAX|1d":382,"month_end_rebal|ES|1d":255,"month_end_rebal|RUT|1d":175,"turtle|USDJPY|1h":3238,"turtle|BTC|1d":74},"cap2noTomRut":{"ibs|NQ|1d":953,"turn_of_month|FTSE|1d":336,"rsi2|ES|1d":260,"rsi2|NQ|1d":218,"turn_of_month|DAX|1d":364,"month_end_rebal|ES|1d":255,"month_end_rebal|RUT|1d":175,"turtle|USDJPY|1h":3238,"turtle|BTC|1d":74}},"total":{"turtle|USDJPY|1h":3238,"turtle|BTC|1d":74,"rsi2|ES|1d":323,"rsi2|NQ|1d":321,"ibs|NQ|1d":1230,"month_end_rebal|ES|1d":281,"turn_of_month|RUT|1d":424,"turn_of_month|DAX|1d":392,"turn_of_month|FTSE|1d":432,"month_end_rebal|RUT|1d":281},"newId":"cap3region","oldId":"cap2","firms":{"ftmo_2step_100k":{"walkforward":{"pick":"cap3region","earlyEv":2899,"lateEv":904,"baseLateEv":277,"rankLate":3,"of":6},"rules":{"cap2":{"pass":0.369,"fail":0.266,"luckPass":0.089,"ev":3409,"halfEdgeEv":1075,"halfEarly":1826,"halfLate":277,"luckEv":273},"cap2market":{"pass":0.39,"fail":0.248,"luckPass":0.079,"ev":3280,"halfEdgeEv":932,"halfEarly":1713,"halfLate":102,"luckEv":19},"cap2region":{"pass":0.36,"fail":0.179,"luckPass":0.094,"ev":2630,"halfEdgeEv":748,"halfEarly":944,"halfLate":539,"luckEv":-96},"cap3":{"pass":0.46,"fail":0.299,"luckPass":0.147,"ev":4859,"halfEdgeEv":1863,"halfEarly":2588,"halfLate":1093,"luckEv":240},"cap3region":{"pass":0.513,"fail":0.263,"luckPass":0.135,"ev":5100,"halfEdgeEv":1932,"halfEarly":2899,"halfLate":904,"luckEv":483},"cap2noTomRut":{"pass":0.488,"fail":0.267,"luckPass":0.122,"ev":5015,"halfEdgeEv":1566,"halfEarly":2112,"halfLate":986,"luckEv":203}},"oldAt04":{"pass":0.382,"fail":0.469},"before":{"pass":0.364,"fail":0.283,"luck":0.085,"ev":3409,"fundedLost":0.432,"halfEdgeEv":1075,"luckEv":273,"aheadHalf":0.612,"aheadLuck":0.318,"range":[2102,4980],"halfRange":[193,2221],"halfYearsNeg":[26,35]},"after":{"pass":0.512,"fail":0.34,"luck":0.168,"ev":6301,"fundedLost":0.501,"halfEdgeEv":2666,"luckEv":769,"aheadHalf":0.737,"aheadLuck":0.427,"range":[4257,8637],"halfRange":[1286,4363],"halfYearsNeg":[17,35]}},"ftmo_1step_100k":{"walkforward":{"pick":"cap3region","earlyEv":2549,"lateEv":291,"baseLateEv":-65,"rankLate":1,"of":6},"rules":{"cap2":{"pass":0.449,"fail":0.373,"luckPass":0.167,"ev":2287,"halfEdgeEv":600,"halfEarly":1225,"halfLate":-65,"luckEv":-75},"cap2market":{"pass":0.464,"fail":0.338,"luckPass":0.181,"ev":2589,"halfEdgeEv":588,"halfEarly":1240,"halfLate":-105,"luckEv":-201},"cap2region":{"pass":0.456,"fail":0.284,"luckPass":0.207,"ev":2117,"halfEdgeEv":600,"halfEarly":1172,"halfLate":-9,"luckEv":-38},"cap3":{"pass":0.516,"fail":0.39,"luckPass":0.232,"ev":3263,"halfEdgeEv":832,"halfEarly":1848,"halfLate":-247,"luckEv":-27},"cap3region":{"pass":0.582,"fail":0.325,"luckPass":0.264,"ev":3578,"halfEdgeEv":1454,"halfEarly":2549,"halfLate":291,"luckEv":-153},"cap2noTomRut":{"pass":0.449,"fail":0.389,"luckPass":0.179,"ev":2368,"halfEdgeEv":518,"halfEarly":1175,"halfLate":-181,"luckEv":-336}},"oldAt04":{"pass":0.526,"fail":0.453},"before":{"pass":0.452,"fail":0.379,"luck":0.159,"ev":2287,"fundedLost":0.423,"halfEdgeEv":600,"luckEv":-75,"aheadHalf":0.468,"aheadLuck":0.242,"range":[1148,3743],"halfRange":[-115,1652],"halfYearsNeg":[25,35]},"after":{"pass":0.573,"fail":0.37,"luck":0.27,"ev":3958,"fundedLost":0.558,"halfEdgeEv":1750,"luckEv":507,"aheadHalf":0.571,"aheadLuck":0.32,"range":[2220,5777],"halfRange":[585,3093],"halfYearsNeg":[20,35]}},"fundednext_2step_100k":{"walkforward":{"pick":"cap3region","earlyEv":3391,"lateEv":1161,"baseLateEv":597,"rankLate":3,"of":6},"rules":{"cap2":{"pass":0.482,"fail":0.263,"luckPass":0.127,"ev":4101,"halfEdgeEv":1440,"halfEarly":2233,"halfLate":597,"luckEv":517},"cap2market":{"pass":0.481,"fail":0.257,"luckPass":0.129,"ev":3934,"halfEdgeEv":1296,"halfEarly":2171,"halfLate":366,"luckEv":252},"cap2region":{"pass":0.439,"fail":0.192,"luckPass":0.155,"ev":3393,"halfEdgeEv":1378,"halfEarly":1714,"halfLate":1020,"luckEv":223},"cap3":{"pass":0.508,"fail":0.329,"luckPass":0.189,"ev":5569,"halfEdgeEv":2222,"halfEarly":3032,"halfLate":1361,"luckEv":555},"cap3region":{"pass":0.574,"fail":0.269,"luckPass":0.183,"ev":5815,"halfEdgeEv":2309,"halfEarly":3391,"halfLate":1161,"luckEv":777},"cap2noTomRut":{"pass":0.542,"fail":0.257,"luckPass":0.175,"ev":5694,"halfEdgeEv":2195,"halfEarly":2928,"halfLate":1416,"luckEv":498}},"oldAt04":null,"before":{"pass":null,"fail":null,"luck":null,"ev":4101,"fundedLost":0.478,"halfEdgeEv":1440,"luckEv":517,"aheadHalf":0.673,"aheadLuck":0.367,"range":[2731,5740],"halfRange":[491,2700],"halfYearsNeg":[22,35]},"after":{"pass":null,"fail":null,"luck":null,"ev":7461,"fundedLost":0.484,"halfEdgeEv":3294,"luckEv":1028,"aheadHalf":0.824,"aheadLuck":0.465,"range":[5336,9800],"halfRange":[1843,5054],"halfYearsNeg":[15,35]}}}},"capCheck":{"rules":[{"id":"n2us1","n":2,"u":1,"order":"time","label":"at most 2, at most 1 US"},{"id":"n2us2","n":2,"u":2,"order":"time","label":"at most 2, at most 2 US"},{"id":"n3us1","n":3,"u":1,"order":"time","label":"at most 3, at most 1 US"},{"id":"n3us2","n":3,"u":2,"order":"time","label":"at most 3, at most 2 US"},{"id":"n3us3","n":3,"u":3,"order":"time","label":"at most 3, at most 3 US"},{"id":"n4us1","n":4,"u":1,"order":"time","label":"at most 4, at most 1 US"},{"id":"n4us2","n":4,"u":2,"order":"time","label":"at most 4, at most 2 US"},{"id":"n4us3","n":4,"u":3,"order":"time","label":"at most 4, at most 3 US"},{"id":"n4us4","n":4,"u":4,"order":"time","label":"at most 4"},{"id":"none","n":99,"u":99,"order":"time","label":"no limit (personal stop only)"},{"id":"n2us2-eu","n":2,"u":2,"order":"euFirst","label":"at most 2, at most 2 US, European trades first"},{"id":"n2us2-r1","n":2,"u":2,"order":"random:1","label":"at most 2, at most 2 US, random order 1"},{"id":"n2us2-r2","n":2,"u":2,"order":"random:2","label":"at most 2, at most 2 US, random order 2"},{"id":"n2us2-r3","n":2,"u":2,"order":"random:3","label":"at most 2, at most 2 US, random order 3"},{"id":"n3us2-eu","n":3,"u":2,"order":"euFirst","label":"at most 3, at most 2 US, European trades first"},{"id":"n3us2-r1","n":3,"u":2,"order":"random:1","label":"at most 3, at most 2 US, random order 1"},{"id":"n3us2-r2","n":3,"u":2,"order":"random:2","label":"at most 3, at most 2 US, random order 2"},{"id":"n3us2-r3","n":3,"u":2,"order":"random:3","label":"at most 3, at most 2 US, random order 3"}],"firms":{"ftmo_2step_100k":{"neighbors":{"n2us1":{"n":2,"u":1,"pass":0.364,"fail":0.178,"ev":2845,"halfEdgeEv":908,"halfLate":613,"luckEv":10},"n2us2":{"n":2,"u":2,"pass":0.369,"fail":0.266,"ev":3409,"halfEdgeEv":1075,"halfLate":277,"luckEv":273},"n3us1":{"n":3,"u":1,"pass":0.432,"fail":0.249,"ev":4069,"halfEdgeEv":1607,"halfLate":1058,"luckEv":220},"n3us2":{"n":3,"u":2,"pass":0.513,"fail":0.263,"ev":5100,"halfEdgeEv":1932,"halfLate":904,"luckEv":483},"n3us3":{"n":3,"u":3,"pass":0.46,"fail":0.299,"ev":4859,"halfEdgeEv":1863,"halfLate":1093,"luckEv":240},"n4us1":{"n":4,"u":1,"pass":0.432,"fail":0.249,"ev":4069,"halfEdgeEv":1607,"halfLate":1058,"luckEv":220},"n4us2":{"n":4,"u":2,"pass":0.5,"fail":0.297,"ev":4300,"halfEdgeEv":1559,"halfLate":899,"luckEv":-1},"n4us3":{"n":4,"u":3,"pass":0.434,"fail":0.343,"ev":4393,"halfEdgeEv":1130,"halfLate":480,"luckEv":-245},"n4us4":{"n":4,"u":4,"pass":0.439,"fail":0.365,"ev":4414,"halfEdgeEv":1253,"halfLate":768,"luckEv":-234},"none":{"n":99,"u":99,"pass":0.427,"fail":0.398,"ev":3981,"halfEdgeEv":1329,"halfLate":844,"luckEv":-190}},"order":{"old":{"usFirst":{"pass":0.369,"fail":0.266,"ev":3409,"halfEdgeEv":1075,"halfLate":277,"luckEv":273},"euFirst":{"pass":0.471,"fail":0.239,"ev":4205,"halfEdgeEv":1137,"halfLate":872,"luckEv":16},"random":{"n":13,"halfEdgeEv":1296,"halfLate":702,"luckEv":127,"failAvg":0.242,"ev":4114,"pass":0.444,"halfMin":632,"halfMax":1816,"lateMin":169,"lateMax":1189}},"new":{"usFirst":{"pass":0.513,"fail":0.263,"ev":5100,"halfEdgeEv":1932,"halfLate":904,"luckEv":483},"euFirst":{"pass":0.511,"fail":0.28,"ev":4112,"halfEdgeEv":1334,"halfLate":703,"luckEv":85},"random":{"n":13,"halfEdgeEv":1879,"halfLate":1031,"luckEv":51,"failAvg":0.287,"ev":5226,"pass":0.509,"halfMin":1559,"halfMax":2277,"lateMin":608,"lateMax":1700}}}},"ftmo_1step_100k":{"neighbors":{"n2us1":{"n":2,"u":1,"pass":0.458,"fail":0.281,"ev":2247,"halfEdgeEv":665,"halfLate":-8,"luckEv":44},"n2us2":{"n":2,"u":2,"pass":0.449,"fail":0.373,"ev":2287,"halfEdgeEv":600,"halfLate":-65,"luckEv":-75},"n3us1":{"n":3,"u":1,"pass":0.503,"fail":0.318,"ev":1986,"halfEdgeEv":480,"halfLate":-424,"luckEv":-169},"n3us2":{"n":3,"u":2,"pass":0.582,"fail":0.325,"ev":3578,"halfEdgeEv":1454,"halfLate":291,"luckEv":-153},"n3us3":{"n":3,"u":3,"pass":0.516,"fail":0.39,"ev":3263,"halfEdgeEv":832,"halfLate":-247,"luckEv":-27},"n4us1":{"n":4,"u":1,"pass":0.503,"fail":0.318,"ev":1986,"halfEdgeEv":480,"halfLate":-424,"luckEv":-169},"n4us2":{"n":4,"u":2,"pass":0.528,"fail":0.4,"ev":2397,"halfEdgeEv":459,"halfLate":-162,"luckEv":-240},"n4us3":{"n":4,"u":3,"pass":0.503,"fail":0.433,"ev":3118,"halfEdgeEv":357,"halfLate":-350,"luckEv":-196},"n4us4":{"n":4,"u":4,"pass":0.495,"fail":0.452,"ev":2888,"halfEdgeEv":334,"halfLate":-431,"luckEv":-197},"none":{"n":99,"u":99,"pass":0.479,"fail":0.472,"ev":3038,"halfEdgeEv":570,"halfLate":-212,"luckEv":-130}},"order":{"old":{"usFirst":{"pass":0.449,"fail":0.373,"ev":2287,"halfEdgeEv":600,"halfLate":-65,"luckEv":-75},"euFirst":{"pass":0.475,"fail":0.418,"ev":2629,"halfEdgeEv":268,"halfLate":-427,"luckEv":-411},"random":{"n":13,"halfEdgeEv":631,"halfLate":177,"luckEv":-259,"failAvg":0.377,"ev":2347,"pass":0.481,"halfMin":203,"halfMax":942,"lateMin":-99,"lateMax":753}},"new":{"usFirst":{"pass":0.582,"fail":0.325,"ev":3578,"halfEdgeEv":1454,"halfLate":291,"luckEv":-153},"euFirst":{"pass":0.53,"fail":0.381,"ev":2337,"halfEdgeEv":732,"halfLate":34,"luckEv":-299},"random":{"n":13,"halfEdgeEv":849,"halfLate":179,"luckEv":-186,"failAvg":0.391,"ev":2866,"pass":0.538,"halfMin":560,"halfMax":1107,"lateMin":-24,"lateMax":374}}}},"fundednext_2step_100k":{"neighbors":{"n2us1":{"n":2,"u":1,"pass":0.454,"fail":0.19,"ev":3757,"halfEdgeEv":1484,"halfLate":1025,"luckEv":287},"n2us2":{"n":2,"u":2,"pass":0.482,"fail":0.263,"ev":4101,"halfEdgeEv":1440,"halfLate":597,"luckEv":517},"n3us1":{"n":3,"u":1,"pass":0.505,"fail":0.264,"ev":4864,"halfEdgeEv":2338,"halfLate":1667,"luckEv":509},"n3us2":{"n":3,"u":2,"pass":0.574,"fail":0.269,"ev":5815,"halfEdgeEv":2309,"halfLate":1161,"luckEv":777},"n3us3":{"n":3,"u":3,"pass":0.508,"fail":0.329,"ev":5569,"halfEdgeEv":2222,"halfLate":1361,"luckEv":555},"n4us1":{"n":4,"u":1,"pass":0.505,"fail":0.264,"ev":4864,"halfEdgeEv":2338,"halfLate":1667,"luckEv":509},"n4us2":{"n":4,"u":2,"pass":0.548,"fail":0.329,"ev":4965,"halfEdgeEv":1980,"halfLate":1272,"luckEv":314},"n4us3":{"n":4,"u":3,"pass":0.508,"fail":0.349,"ev":5086,"halfEdgeEv":1645,"halfLate":1084,"luckEv":-69},"n4us4":{"n":4,"u":4,"pass":0.501,"fail":0.369,"ev":4975,"halfEdgeEv":1759,"halfLate":1304,"luckEv":-57},"none":{"n":99,"u":99,"pass":0.477,"fail":0.409,"ev":4491,"halfEdgeEv":1813,"halfLate":1410,"luckEv":-37}},"order":{"old":{"usFirst":{"pass":0.482,"fail":0.263,"ev":4101,"halfEdgeEv":1440,"halfLate":597,"luckEv":517},"euFirst":{"pass":0.535,"fail":0.238,"ev":4792,"halfEdgeEv":1564,"halfLate":1226,"luckEv":247},"random":{"n":13,"halfEdgeEv":1748,"halfLate":1092,"luckEv":371,"failAvg":0.241,"ev":4844,"pass":0.521,"halfMin":914,"halfMax":2353,"lateMin":574,"lateMax":1778}},"new":{"usFirst":{"pass":0.574,"fail":0.269,"ev":5815,"halfEdgeEv":2309,"halfLate":1161,"luckEv":777},"euFirst":{"pass":0.575,"fail":0.289,"ev":4890,"halfEdgeEv":1724,"halfLate":971,"luckEv":299},"random":{"n":13,"halfEdgeEv":2399,"halfLate":1449,"luckEv":338,"failAvg":0.294,"ev":6060,"pass":0.573,"halfMin":2037,"halfMax":2810,"lateMin":919,"lateMax":2109}}}}}},"payout":{"policies":[0,0.01,0.02,0.03,0.05],"firms":{"ftmo_2step_100k":{"365/0.003":{"walkforward":{"pick":0,"lateEv":1925,"baseLateEv":1925,"rankLate":1,"of":5},"policies":{"0":{"ev":6301,"halfEdgeEv":2666,"luckEv":769,"fundedLost":0.501,"paidAny":0.483,"payoutsPerPass":6.3,"halfLate":1925},"0.01":{"ev":6261,"halfEdgeEv":2602,"luckEv":722,"fundedLost":0.514,"paidAny":0.466,"payoutsPerPass":4.77,"halfLate":1825},"0.02":{"ev":6359,"halfEdgeEv":2585,"luckEv":679,"fundedLost":0.44,"paidAny":0.456,"payoutsPerPass":3.58,"halfLate":1882},"0.03":{"ev":6249,"halfEdgeEv":2513,"luckEv":593,"fundedLost":0.43,"paidAny":0.441,"payoutsPerPass":2.85,"halfLate":1802},"0.05":{"ev":5744,"halfEdgeEv":2245,"luckEv":543,"fundedLost":0.444,"paidAny":0.402,"payoutsPerPass":2.02,"halfLate":1501}}},"365/0.002":{"walkforward":{"pick":0,"lateEv":1739,"baseLateEv":1739,"rankLate":1,"of":5},"policies":{"0":{"ev":4788,"halfEdgeEv":2000,"luckEv":476,"fundedLost":0.356,"paidAny":0.505,"payoutsPerPass":6.87,"halfLate":1739},"0.01":{"ev":4729,"halfEdgeEv":1892,"luckEv":442,"fundedLost":0.349,"paidAny":0.487,"payoutsPerPass":4.63,"halfLate":1580},"0.02":{"ev":4550,"halfEdgeEv":1870,"luckEv":418,"fundedLost":0.335,"paidAny":0.448,"payoutsPerPass":3.07,"halfLate":1608},"0.03":{"ev":4470,"halfEdgeEv":1723,"luckEv":395,"fundedLost":0.334,"paidAny":0.435,"payoutsPerPass":2.48,"halfLate":1422},"0.05":{"ev":3927,"halfEdgeEv":1590,"luckEv":264,"fundedLost":0.308,"paidAny":0.377,"payoutsPerPass":1.56,"halfLate":1266}}},"730/0.003":{"walkforward":{"pick":0,"lateEv":2578,"baseLateEv":2578,"rankLate":3,"of":5},"policies":{"0":{"ev":8420,"halfEdgeEv":3363,"luckEv":839,"fundedLost":0.842,"paidAny":0.489,"payoutsPerPass":8.22,"halfLate":2578},"0.01":{"ev":8316,"halfEdgeEv":3314,"luckEv":788,"fundedLost":0.842,"paidAny":0.472,"payoutsPerPass":6.15,"halfLate":2536},"0.02":{"ev":9174,"halfEdgeEv":3316,"luckEv":738,"fundedLost":0.753,"paidAny":0.462,"payoutsPerPass":5.04,"halfLate":2645},"0.03":{"ev":9061,"halfEdgeEv":3293,"luckEv":648,"fundedLost":0.753,"paidAny":0.452,"payoutsPerPass":4.02,"halfLate":2605},"0.05":{"ev":8553,"halfEdgeEv":3224,"luckEv":601,"fundedLost":0.784,"paidAny":0.422,"payoutsPerPass":2.91,"halfLate":2513}}},"730/0.002":{"walkforward":{"pick":0,"lateEv":2773,"baseLateEv":2773,"rankLate":1,"of":5},"policies":{"0":{"ev":7491,"halfEdgeEv":3079,"luckEv":714,"fundedLost":0.56,"paidAny":0.515,"payoutsPerPass":11.13,"halfLate":2773},"0.01":{"ev":7429,"halfEdgeEv":2980,"luckEv":663,"fundedLost":0.552,"paidAny":0.496,"payoutsPerPass":7.29,"halfLate":2631},"0.02":{"ev":7396,"halfEdgeEv":2934,"luckEv":644,"fundedLost":0.539,"paidAny":0.469,"payoutsPerPass":4.94,"halfLate":2586},"0.03":{"ev":7320,"halfEdgeEv":2741,"luckEv":600,"fundedLost":0.52,"paidAny":0.462,"payoutsPerPass":3.92,"halfLate":2407},"0.05":{"ev":6797,"halfEdgeEv":2617,"luckEv":606,"fundedLost":0.504,"paidAny":0.444,"payoutsPerPass":2.54,"halfLate":2234}}}},"ftmo_1step_100k":{"365/0.003":{"walkforward":{"pick":0.03,"lateEv":855,"baseLateEv":864,"rankLate":5,"of":5},"policies":{"0":{"ev":3958,"halfEdgeEv":1750,"luckEv":507,"fundedLost":0.558,"paidAny":0.326,"payoutsPerPass":0.98,"halfLate":864},"0.01":{"ev":3958,"halfEdgeEv":1750,"luckEv":507,"fundedLost":0.558,"paidAny":0.326,"payoutsPerPass":0.98,"halfLate":864},"0.02":{"ev":3971,"halfEdgeEv":1738,"luckEv":506,"fundedLost":0.558,"paidAny":0.311,"payoutsPerPass":0.95,"halfLate":863},"0.03":{"ev":3931,"halfEdgeEv":1747,"luckEv":509,"fundedLost":0.558,"paidAny":0.311,"payoutsPerPass":0.9,"halfLate":855},"0.05":{"ev":3887,"halfEdgeEv":1711,"luckEv":415,"fundedLost":0.558,"paidAny":0.301,"payoutsPerPass":0.88,"halfLate":860}}},"365/0.002":{"walkforward":{"pick":0.02,"lateEv":426,"baseLateEv":424,"rankLate":1,"of":5},"policies":{"0":{"ev":4124,"halfEdgeEv":1254,"luckEv":274,"fundedLost":0.329,"paidAny":0.417,"payoutsPerPass":1.6,"halfLate":424},"0.01":{"ev":4125,"halfEdgeEv":1249,"luckEv":274,"fundedLost":0.329,"paidAny":0.417,"payoutsPerPass":1.6,"halfLate":424},"0.02":{"ev":4122,"halfEdgeEv":1260,"luckEv":244,"fundedLost":0.329,"paidAny":0.408,"payoutsPerPass":1.55,"halfLate":426},"0.03":{"ev":4121,"halfEdgeEv":1186,"luckEv":247,"fundedLost":0.329,"paidAny":0.405,"payoutsPerPass":1.47,"halfLate":420},"0.05":{"ev":3922,"halfEdgeEv":1138,"luckEv":177,"fundedLost":0.329,"paidAny":0.38,"payoutsPerPass":1.13,"halfLate":382}}},"730/0.003":{"walkforward":{"pick":0.03,"lateEv":1534,"baseLateEv":1544,"rankLate":5,"of":5},"policies":{"0":{"ev":6350,"halfEdgeEv":2767,"luckEv":823,"fundedLost":0.825,"paidAny":0.346,"payoutsPerPass":1.39,"halfLate":1544},"0.01":{"ev":6350,"halfEdgeEv":2767,"luckEv":823,"fundedLost":0.825,"paidAny":0.346,"payoutsPerPass":1.39,"halfLate":1544},"0.02":{"ev":6363,"halfEdgeEv":2755,"luckEv":822,"fundedLost":0.825,"paidAny":0.33,"payoutsPerPass":1.36,"halfLate":1543},"0.03":{"ev":6310,"halfEdgeEv":2764,"luckEv":825,"fundedLost":0.825,"paidAny":0.33,"payoutsPerPass":1.3,"halfLate":1534},"0.05":{"ev":6258,"halfEdgeEv":2730,"luckEv":727,"fundedLost":0.825,"paidAny":0.32,"payoutsPerPass":1.28,"halfLate":1539}}},"730/0.002":{"walkforward":{"pick":0.05,"lateEv":1142,"baseLateEv":1172,"rankLate":5,"of":5},"policies":{"0":{"ev":7169,"halfEdgeEv":2427,"luckEv":936,"fundedLost":0.579,"paidAny":0.431,"payoutsPerPass":2.6,"halfLate":1172},"0.01":{"ev":7169,"halfEdgeEv":2422,"luckEv":936,"fundedLost":0.579,"paidAny":0.431,"payoutsPerPass":2.6,"halfLate":1172},"0.02":{"ev":7176,"halfEdgeEv":2441,"luckEv":859,"fundedLost":0.579,"paidAny":0.422,"payoutsPerPass":2.55,"halfLate":1174},"0.03":{"ev":7073,"halfEdgeEv":2523,"luckEv":862,"fundedLost":0.579,"paidAny":0.419,"payoutsPerPass":2.39,"halfLate":1168},"0.05":{"ev":6830,"halfEdgeEv":2550,"luckEv":829,"fundedLost":0.579,"paidAny":0.405,"payoutsPerPass":1.87,"halfLate":1142}}}},"fundednext_2step_100k":{"365/0.003":{"walkforward":{"pick":0,"lateEv":2668,"baseLateEv":2668,"rankLate":1,"of":5},"policies":{"0":{"ev":7461,"halfEdgeEv":3294,"luckEv":1028,"fundedLost":0.484,"paidAny":0.55,"payoutsPerPass":6.31,"halfLate":2668},"0.01":{"ev":7447,"halfEdgeEv":3240,"luckEv":967,"fundedLost":0.495,"paidAny":0.538,"payoutsPerPass":4.87,"halfLate":2616},"0.02":{"ev":7541,"halfEdgeEv":3228,"luckEv":906,"fundedLost":0.407,"paidAny":0.528,"payoutsPerPass":3.71,"halfLate":2655},"0.03":{"ev":7367,"halfEdgeEv":3143,"luckEv":832,"fundedLost":0.402,"paidAny":0.516,"payoutsPerPass":2.96,"halfLate":2585},"0.05":{"ev":6856,"halfEdgeEv":2829,"luckEv":787,"fundedLost":0.406,"paidAny":0.473,"payoutsPerPass":2.12,"halfLate":2235}}},"365/0.002":{"walkforward":{"pick":0,"lateEv":2239,"baseLateEv":2239,"rankLate":1,"of":5},"policies":{"0":{"ev":5448,"halfEdgeEv":2499,"luckEv":792,"fundedLost":0.348,"paidAny":0.564,"payoutsPerPass":6.54,"halfLate":2239},"0.01":{"ev":5396,"halfEdgeEv":2395,"luckEv":745,"fundedLost":0.341,"paidAny":0.544,"payoutsPerPass":4.52,"halfLate":2086},"0.02":{"ev":5190,"halfEdgeEv":2333,"luckEv":722,"fundedLost":0.323,"paidAny":0.512,"payoutsPerPass":3.04,"halfLate":2080},"0.03":{"ev":5092,"halfEdgeEv":2185,"luckEv":694,"fundedLost":0.312,"paidAny":0.487,"payoutsPerPass":2.46,"halfLate":1884},"0.05":{"ev":4467,"halfEdgeEv":1966,"luckEv":546,"fundedLost":0.299,"paidAny":0.425,"payoutsPerPass":1.56,"halfLate":1599}}},"730/0.003":{"walkforward":{"pick":0,"lateEv":3769,"baseLateEv":3769,"rankLate":4,"of":5},"policies":{"0":{"ev":9855,"halfEdgeEv":4262,"luckEv":1139,"fundedLost":0.856,"paidAny":0.557,"payoutsPerPass":8.31,"halfLate":3769},"0.01":{"ev":9791,"halfEdgeEv":4220,"luckEv":1073,"fundedLost":0.856,"paidAny":0.545,"payoutsPerPass":6.32,"halfLate":3761},"0.02":{"ev":10886,"halfEdgeEv":4262,"luckEv":992,"fundedLost":0.756,"paidAny":0.535,"payoutsPerPass":5.28,"halfLate":3918},"0.03":{"ev":10712,"halfEdgeEv":4209,"luckEv":912,"fundedLost":0.759,"paidAny":0.522,"payoutsPerPass":4.23,"halfLate":3859},"0.05":{"ev":10234,"halfEdgeEv":4179,"luckEv":874,"fundedLost":0.778,"paidAny":0.492,"payoutsPerPass":3.09,"halfLate":3780}}},"730/0.002":{"walkforward":{"pick":0,"lateEv":3500,"baseLateEv":3500,"rankLate":1,"of":5},"policies":{"0":{"ev":8514,"halfEdgeEv":3813,"luckEv":1097,"fundedLost":0.572,"paidAny":0.576,"payoutsPerPass":10.81,"halfLate":3500},"0.01":{"ev":8446,"halfEdgeEv":3714,"luckEv":1040,"fundedLost":0.562,"paidAny":0.556,"payoutsPerPass":7.2,"halfLate":3362},"0.02":{"ev":8412,"halfEdgeEv":3640,"luckEv":1022,"fundedLost":0.549,"paidAny":0.532,"payoutsPerPass":4.95,"halfLate":3300},"0.03":{"ev":8399,"halfEdgeEv":3443,"luckEv":961,"fundedLost":0.51,"paidAny":0.524,"payoutsPerPass":3.96,"halfLate":3091},"0.05":{"ev":7736,"halfEdgeEv":3298,"luckEv":969,"fundedLost":0.508,"paidAny":0.498,"payoutsPerPass":2.58,"halfLate":2914}}}}}},"weights":{"sharpeBefore2008":{"turtle|USDJPY|1h":null,"turtle|BTC|1d":null,"rsi2|ES|1d":0.18323254613151663,"rsi2|NQ|1d":0.12047223033066685,"ibs|NQ|1d":-0.025467007146553013,"month_end_rebal|ES|1d":0.23497703624382357,"turn_of_month|RUT|1d":0.31314786352400426,"turn_of_month|DAX|1d":0.28337325562572857,"turn_of_month|FTSE|1d":0.24829419898509078,"month_end_rebal|RUT|1d":0.3346339987089303},"schemes":[{"id":"equal","label":"same size for every strategy (the playbook)"},{"id":"sharpe","label":"size in proportion to the Sharpe ratio before 2008 (at most 2x)"},{"id":"sqrtSharpe","label":"size in proportion to the square root of that Sharpe ratio"},{"id":"dip15","label":"dip-buying (RSI(2), IBS) 1.5x the others"},{"id":"calendar15","label":"calendar rules 1.5x the others"},{"id":"trendHalf","label":"trend rules (Turtle) at half the others"}],"firms":{"ftmo_2step_100k":{"walkforward":{"pick":"sharpe","earlyEv":7187,"lateEv":1712,"baseLateEv":1925,"rankLate":4,"of":6},"schemes":{"equal":{"pass":0.531,"fail":0.313,"ev":6301,"halfEdgeEv":2666,"halfEarly":3364,"halfLate":1925},"sharpe":{"pass":0.568,"fail":0.359,"ev":9140,"halfEdgeEv":4533,"halfEarly":7187,"halfLate":1712},"sqrtSharpe":{"pass":0.588,"fail":0.328,"ev":9197,"halfEdgeEv":3920,"halfEarly":6256,"halfLate":1439},"dip15":{"pass":0.534,"fail":0.348,"ev":6158,"halfEdgeEv":2831,"halfEarly":2977,"halfLate":2675},"calendar15":{"pass":0.542,"fail":0.384,"ev":7779,"halfEdgeEv":3694,"halfEarly":5359,"halfLate":1924},"trendHalf":{"pass":0.585,"fail":0.369,"ev":6661,"halfEdgeEv":2841,"halfEarly":4080,"halfLate":1526}}},"ftmo_1step_100k":{"walkforward":{"pick":"sharpe","earlyEv":5908,"lateEv":-499,"baseLateEv":864,"rankLate":6,"of":6},"schemes":{"equal":{"pass":0.58,"fail":0.36,"ev":3958,"halfEdgeEv":1750,"halfEarly":2585,"halfLate":864},"sharpe":{"pass":0.563,"fail":0.406,"ev":5325,"halfEdgeEv":2801,"halfEarly":5908,"halfLate":-499},"sqrtSharpe":{"pass":0.596,"fail":0.361,"ev":5669,"halfEdgeEv":2732,"halfEarly":5768,"halfLate":-494},"dip15":{"pass":0.566,"fail":0.389,"ev":4874,"halfEdgeEv":1607,"halfEarly":2428,"halfLate":735},"calendar15":{"pass":0.616,"fail":0.379,"ev":5578,"halfEdgeEv":2417,"halfEarly":4290,"halfLate":427},"trendHalf":{"pass":0.541,"fail":0.458,"ev":4397,"halfEdgeEv":1465,"halfEarly":2529,"halfLate":334}}},"fundednext_2step_100k":{"walkforward":{"pick":"sharpe","earlyEv":7936,"lateEv":2411,"baseLateEv":2668,"rankLate":4,"of":6},"schemes":{"equal":{"pass":0.597,"fail":0.316,"ev":7461,"halfEdgeEv":3294,"halfEarly":3882,"halfLate":2668},"sharpe":{"pass":0.623,"fail":0.335,"ev":10202,"halfEdgeEv":5257,"halfEarly":7936,"halfLate":2411},"sqrtSharpe":{"pass":0.636,"fail":0.314,"ev":10112,"halfEdgeEv":4322,"halfEarly":6743,"halfLate":1750},"dip15":{"pass":0.588,"fail":0.344,"ev":6781,"halfEdgeEv":3176,"halfEarly":3312,"halfLate":3032},"calendar15":{"pass":0.586,"fail":0.372,"ev":8465,"halfEdgeEv":4248,"halfEarly":5901,"halfLate":2492},"trendHalf":{"pass":0.626,"fail":0.358,"ev":7179,"halfEdgeEv":3353,"halfEarly":4445,"halfLate":2194}}}}},"weekend":{"held":{"ibs|NQ|1d":{"trades":988,"split":523},"turn_of_month|RUT|1d":{"trades":402,"split":300},"turn_of_month|FTSE|1d":{"trades":340,"split":258},"rsi2|ES|1d":{"trades":267,"split":134},"rsi2|NQ|1d":{"trades":224,"split":110},"turn_of_month|DAX|1d":{"trades":382,"split":278},"month_end_rebal|ES|1d":{"trades":255,"split":149},"month_end_rebal|RUT|1d":{"trades":175,"split":104},"turtle|USDJPY|1h":{"trades":3238,"split":447},"turtle|BTC|1d":{"trades":74,"split":0}},"firms":{"ftmo_2step_100k":{"0.002":{"hold":{"ev":3177,"halfEdgeEv":1160,"halfEarly":1413,"halfLate":891,"luckEv":64,"fundedLost":0.348,"paidAny":0.342},"flat":{"ev":2905,"halfEdgeEv":1172,"halfEarly":1513,"halfLate":810,"luckEv":121,"fundedLost":0.428,"paidAny":0.337}},"0.003":{"hold":{"ev":6301,"halfEdgeEv":2666,"halfEarly":3364,"halfLate":1925,"luckEv":769,"fundedLost":0.501,"paidAny":0.483},"flat":{"ev":6060,"halfEdgeEv":2795,"halfEarly":3627,"halfLate":1912,"luckEv":753,"fundedLost":0.549,"paidAny":0.481}}},"ftmo_1step_100k":{"0.002":{"hold":{"ev":4257,"halfEdgeEv":1111,"halfEarly":1787,"halfLate":392,"luckEv":299,"fundedLost":0.332,"paidAny":0.414},"flat":{"ev":4706,"halfEdgeEv":1787,"halfEarly":2695,"halfLate":824,"luckEv":492,"fundedLost":0.232,"paidAny":0.456}},"0.003":{"hold":{"ev":3958,"halfEdgeEv":1750,"halfEarly":2585,"halfLate":864,"luckEv":507,"fundedLost":0.558,"paidAny":0.326},"flat":{"ev":5016,"halfEdgeEv":1683,"halfEarly":3143,"halfLate":132,"luckEv":217,"fundedLost":0.538,"paidAny":0.36}}},"fundednext_2step_100k":{"0.002":{"hold":{"ev":4157,"halfEdgeEv":1661,"halfEarly":1895,"halfLate":1413,"luckEv":405,"fundedLost":0.321,"paidAny":0.412},"flat":{"ev":3874,"halfEdgeEv":1638,"halfEarly":1982,"halfLate":1272,"luckEv":471,"fundedLost":0.41,"paidAny":0.417}},"0.003":{"hold":{"ev":7461,"halfEdgeEv":3294,"halfEarly":3882,"halfLate":2668,"luckEv":1028,"fundedLost":0.484,"paidAny":0.55},"flat":{"ev":6911,"halfEdgeEv":3316,"halfEarly":4351,"halfLate":2215,"luckEv":1054,"fundedLost":0.554,"paidAny":0.541}}}}},"phaseRisk":{"plans":[{"id":"0.3/0.3","p":[1,1],"label":"0.3% in both phases (the playbook)"},{"id":"0.3/0.2","p":[1,0.6666666666666666],"label":"0.3% in phase 1, 0.2% in phase 2"},{"id":"0.3/0.15","p":[1,0.5],"label":"0.3% in phase 1, 0.15% in phase 2"},{"id":"0.3/0.4","p":[1,1.3333333333333333],"label":"0.3% in phase 1, 0.4% in phase 2"},{"id":"0.4/0.3","p":[1.3333333333333333,1],"label":"0.4% in phase 1, 0.3% in phase 2"},{"id":"0.4/0.2","p":[1.3333333333333333,0.6666666666666666],"label":"0.4% in phase 1, 0.2% in phase 2"},{"id":"0.2/0.2","p":[0.6666666666666666,0.6666666666666666],"label":"0.2% in both phases"}],"firms":{"ftmo_2step_100k":{"walkforward":{"single":{"pick":"0.3/0.4","early":3481,"late":1327,"baseLate":1925,"rankLate":5,"of":7},"three":{"pick":"0.4/0.3","early":13349,"late":13784,"baseLate":11392,"rankLate":1,"of":7}},"plans":{"0.3/0.3":{"playbook":{"pass":0.531,"timeout":0.156,"medDays":179,"ev":6301,"threeYear":23325,"threeAhead":0.936,"threeEarly":22046,"threeLate":24769},"halfEdge":{"pass":0.328,"timeout":0.186,"medDays":196,"ev":2666,"threeYear":11400,"threeAhead":0.737,"threeEarly":11408,"threeLate":11392},"luck":{"pass":0.177,"timeout":0.177,"medDays":197,"ev":769,"threeYear":2866,"threeAhead":0.427,"threeEarly":5032,"threeLate":420}},"0.3/0.2":{"playbook":{"pass":0.473,"timeout":0.245,"medDays":193,"ev":5596,"threeYear":22111,"threeAhead":0.921,"threeEarly":20451,"threeLate":23985},"halfEdge":{"pass":0.317,"timeout":0.246,"medDays":211,"ev":2341,"threeYear":10385,"threeAhead":0.744,"threeEarly":10175,"threeLate":10623},"luck":{"pass":0.173,"timeout":0.221,"medDays":220,"ev":780,"threeYear":3209,"threeAhead":0.491,"threeEarly":4987,"threeLate":1200}},"0.3/0.15":{"playbook":{"pass":0.445,"timeout":0.3,"medDays":214,"ev":5008,"threeYear":20746,"threeAhead":0.913,"threeEarly":18833,"threeLate":22908},"halfEdge":{"pass":0.25,"timeout":0.331,"medDays":235,"ev":2022,"threeYear":9171,"threeAhead":0.702,"threeEarly":9532,"threeLate":8762},"luck":{"pass":0.143,"timeout":0.261,"medDays":255,"ev":501,"threeYear":2838,"threeAhead":0.481,"threeEarly":4304,"threeLate":1183}},"0.3/0.4":{"playbook":{"pass":0.536,"timeout":0.111,"medDays":169,"ev":6038,"threeYear":23207,"threeAhead":0.937,"threeEarly":21260,"threeLate":25405},"halfEdge":{"pass":0.33,"timeout":0.158,"medDays":179,"ev":2436,"threeYear":10580,"threeAhead":0.768,"threeEarly":10616,"threeLate":10540},"luck":{"pass":0.168,"timeout":0.128,"medDays":187,"ev":631,"threeYear":2480,"threeAhead":0.357,"threeEarly":4819,"threeLate":-161}},"0.4/0.3":{"playbook":{"pass":0.562,"timeout":0.057,"medDays":159,"ev":6688,"threeYear":26400,"threeAhead":0.962,"threeEarly":23711,"threeLate":29437},"halfEdge":{"pass":0.376,"timeout":0.094,"medDays":163,"ev":2696,"threeYear":13553,"threeAhead":0.838,"threeEarly":13349,"threeLate":13784},"luck":{"pass":0.204,"timeout":0.095,"medDays":161,"ev":720,"threeYear":3311,"threeAhead":0.525,"threeEarly":5597,"threeLate":729}},"0.4/0.2":{"playbook":{"pass":0.505,"timeout":0.154,"medDays":172,"ev":5999,"threeYear":24130,"threeAhead":0.967,"threeEarly":21816,"threeLate":26745},"halfEdge":{"pass":0.339,"timeout":0.177,"medDays":185,"ev":2360,"threeYear":11792,"threeAhead":0.829,"threeEarly":11921,"threeLate":11646},"luck":{"pass":0.193,"timeout":0.146,"medDays":188,"ev":731,"threeYear":3484,"threeAhead":0.558,"threeEarly":5436,"threeLate":1279}},"0.2/0.2":{"playbook":{"pass":0.368,"timeout":0.436,"medDays":225,"ev":4446,"threeYear":18219,"threeAhead":0.85,"threeEarly":16278,"threeLate":20412},"halfEdge":{"pass":0.235,"timeout":0.469,"medDays":256,"ev":1765,"threeYear":8319,"threeAhead":0.637,"threeEarly":8249,"threeLate":8397},"luck":{"pass":0.115,"timeout":0.441,"medDays":261,"ev":357,"threeYear":2457,"threeAhead":0.417,"threeEarly":3509,"threeLate":1269}}}},"fundednext_2step_100k":{"walkforward":{"single":{"pick":"0.3/0.4","early":4090,"late":1980,"baseLate":2668,"rankLate":5,"of":7},"three":{"pick":"0.4/0.3","early":14174,"late":15536,"baseLate":14476,"rankLate":1,"of":7}},"plans":{"0.3/0.3":{"playbook":{"pass":0.597,"timeout":0.087,"medDays":161,"ev":7461,"threeYear":25592,"threeAhead":0.966,"threeEarly":23396,"threeLate":28072},"halfEdge":{"pass":0.392,"timeout":0.135,"medDays":173,"ev":3294,"threeYear":13681,"threeAhead":0.824,"threeEarly":12976,"threeLate":14476},"luck":{"pass":0.226,"timeout":0.127,"medDays":179,"ev":1028,"threeYear":3822,"threeAhead":0.465,"threeEarly":6307,"threeLate":1015}},"0.3/0.2":{"playbook":{"pass":0.526,"timeout":0.195,"medDays":179,"ev":6683,"threeYear":24165,"threeAhead":0.956,"threeEarly":21777,"threeLate":26862},"halfEdge":{"pass":0.37,"timeout":0.212,"medDays":197,"ev":2902,"threeYear":12155,"threeAhead":0.803,"threeEarly":12055,"threeLate":12268},"luck":{"pass":0.214,"timeout":0.19,"medDays":202,"ev":1101,"threeYear":4001,"threeAhead":0.537,"threeEarly":6065,"threeLate":1671}},"0.3/0.15":{"playbook":{"pass":0.484,"timeout":0.264,"medDays":199,"ev":5860,"threeYear":22728,"threeAhead":0.941,"threeEarly":20911,"threeLate":24780},"halfEdge":{"pass":0.306,"timeout":0.293,"medDays":213,"ev":2459,"threeYear":10533,"threeAhead":0.737,"threeEarly":11022,"threeLate":9980},"luck":{"pass":0.177,"timeout":0.236,"medDays":230,"ev":733,"threeYear":3595,"threeAhead":0.513,"threeEarly":5594,"threeLate":1337}},"0.3/0.4":{"playbook":{"pass":0.581,"timeout":0.07,"medDays":151,"ev":6940,"threeYear":26280,"threeAhead":0.962,"threeEarly":23516,"threeLate":29402},"halfEdge":{"pass":0.384,"timeout":0.096,"medDays":158,"ev":3067,"threeYear":12308,"threeAhead":0.788,"threeEarly":11796,"threeLate":12886},"luck":{"pass":0.214,"timeout":0.083,"medDays":165,"ev":936,"threeYear":3371,"threeAhead":0.466,"threeEarly":5966,"threeLate":441}},"0.4/0.3":{"playbook":{"pass":0.597,"timeout":0.035,"medDays":142,"ev":7522,"threeYear":28503,"threeAhead":0.976,"threeEarly":25447,"threeLate":31955},"halfEdge":{"pass":0.418,"timeout":0.066,"medDays":147,"ev":3208,"threeYear":14813,"threeAhead":0.868,"threeEarly":14174,"threeLate":15536},"luck":{"pass":0.241,"timeout":0.065,"medDays":141,"ev":940,"threeYear":4716,"threeAhead":0.572,"threeEarly":6811,"threeLate":2351}},"0.4/0.2":{"playbook":{"pass":0.545,"timeout":0.137,"medDays":159,"ev":7042,"threeYear":25903,"threeAhead":0.96,"threeEarly":23290,"threeLate":28854},"halfEdge":{"pass":0.384,"timeout":0.152,"medDays":172,"ev":2791,"threeYear":13118,"threeAhead":0.853,"threeEarly":12942,"threeLate":13318},"luck":{"pass":0.231,"timeout":0.135,"medDays":174,"ev":978,"threeYear":4748,"threeAhead":0.635,"threeEarly":6787,"threeLate":2445}},"0.2/0.2":{"playbook":{"pass":0.445,"timeout":0.36,"medDays":207,"ev":5912,"threeYear":21487,"threeAhead":0.887,"threeEarly":18783,"threeLate":24542},"halfEdge":{"pass":0.301,"timeout":0.399,"medDays":230,"ev":2266,"threeYear":9715,"threeAhead":0.711,"threeEarly":9421,"threeLate":10047},"luck":{"pass":0.166,"timeout":0.377,"medDays":241,"ev":712,"threeYear":3038,"threeAhead":0.489,"threeEarly":4365,"threeLate":1540}}}}}},"postPub":{"postShare":0.793,"postAll":{"n":5029,"mean":0.0928,"t":4.71,"win":0.444},"strategies":{"turtle|USDJPY|1h":{"family":"turtle","pubYear":2003,"source":"The Original Turtle Trading Rules (Faith, made public 2003)","firstYear":2012,"before":{"n":0,"mean":null,"t":null,"win":null},"after":{"n":3238,"mean":0.0638,"t":2.38,"win":0.351},"ratio":null},"turtle|BTC|1d":{"family":"turtle","pubYear":2003,"source":"The Original Turtle Trading Rules (Faith, made public 2003)","firstYear":2014,"before":{"n":0,"mean":null,"t":null,"win":null},"after":{"n":74,"mean":1.6747,"t":3.04,"win":0.432},"ratio":null},"rsi2|ES|1d":{"family":"rsi2","pubYear":2008,"source":"Connors and Alvarez, Short Term Trading Strategies That Work (2008)","firstYear":1991,"before":{"n":142,"mean":0.0972,"t":2.62,"win":0.718},"after":{"n":125,"mean":0.112,"t":2.64,"win":0.728},"ratio":1.15},"rsi2|NQ|1d":{"family":"rsi2","pubYear":2008,"source":"Connors and Alvarez, Short Term Trading Strategies That Work (2008)","firstYear":1991,"before":{"n":111,"mean":0.0678,"t":1.58,"win":0.685},"after":{"n":113,"mean":0.0945,"t":1.87,"win":0.726},"ratio":1.39},"ibs|NQ|1d":{"family":"ibs","pubYear":2013,"source":"Pagonidis, The IBS Effect: Mean Reversion in Equity ETFs (2013)","firstYear":1990,"before":{"n":670,"mean":0.0016,"t":0.09,"win":0.618},"after":{"n":318,"mean":0.0402,"t":1.51,"win":0.682},"ratio":25.13},"month_end_rebal|ES|1d":{"family":"month_end_rebal","pubYear":2025,"source":"Harvey, Mazzoleni and Melone (2025)","firstYear":2002,"before":{"n":234,"mean":0.0929,"t":2.86,"win":0.568},"after":{"n":21,"mean":-0.0502,"t":-0.59,"win":0.381},"ratio":-0.54},"turn_of_month|RUT|1d":{"family":"turn_of_month","pubYear":1988,"source":"Ariel (1987), Lakonishok and Smidt (1988)","firstYear":1990,"before":{"n":0,"mean":null,"t":null,"win":null},"after":{"n":402,"mean":0.1094,"t":3.62,"win":0.602},"ratio":null},"turn_of_month|DAX|1d":{"family":"turn_of_month","pubYear":1988,"source":"Ariel (1987), Lakonishok and Smidt (1988)","firstYear":1994,"before":{"n":0,"mean":null,"t":null,"win":null},"after":{"n":382,"mean":0.0605,"t":2.32,"win":0.576},"ratio":null},"turn_of_month|FTSE|1d":{"family":"turn_of_month","pubYear":1988,"source":"Ariel (1987), Lakonishok and Smidt (1988)","firstYear":1990,"before":{"n":0,"mean":null,"t":null,"win":null},"after":{"n":340,"mean":0.0879,"t":3.2,"win":0.574},"ratio":null},"month_end_rebal|RUT|1d":{"family":"month_end_rebal","pubYear":2025,"source":"Harvey, Mazzoleni and Melone (2025)","firstYear":2002,"before":{"n":159,"mean":0.1185,"t":2.57,"win":0.553},"after":{"n":16,"mean":0.1696,"t":1.73,"win":0.563},"ratio":1.43}}},"stopSlip":{"slips":[0,0.001,0.0025,0.005,0.01],"firms":{"ftmo_2step_100k":{"0":{"playbook":{"pass":0.531,"fail":0.313,"dailyFail":0.011,"fundedLost":0.501,"ev":6301,"stopsPerYear":5.6,"threeYear":23325,"threeAhead":0.936,"threeLate":24769},"halfEdge":{"pass":0.328,"fail":0.486,"dailyFail":0.01,"fundedLost":0.595,"ev":2666,"stopsPerYear":6.4,"threeYear":11400,"threeAhead":0.737,"threeLate":11392},"luck":{"pass":0.177,"fail":0.646,"dailyFail":0.006,"fundedLost":0.829,"ev":769,"stopsPerYear":7.2,"threeYear":2866,"threeAhead":0.427,"threeLate":420}},"0.001":{"playbook":{"pass":0.521,"fail":0.32,"dailyFail":0.011,"fundedLost":0.557,"ev":5945,"stopsPerYear":5.6,"threeYear":21920,"threeAhead":0.934,"threeLate":23856},"halfEdge":{"pass":0.314,"fail":0.499,"dailyFail":0.01,"fundedLost":0.639,"ev":2487,"stopsPerYear":6.4,"threeYear":10471,"threeAhead":0.707,"threeLate":10266},"luck":{"pass":0.161,"fail":0.662,"dailyFail":0.006,"fundedLost":0.829,"ev":665,"stopsPerYear":7.2,"threeYear":2340,"threeAhead":0.412,"threeLate":-42}},"0.0025":{"playbook":{"pass":0.503,"fail":0.348,"dailyFail":0.011,"fundedLost":0.561,"ev":5575,"stopsPerYear":5.6,"threeYear":21461,"threeAhead":0.932,"threeLate":23614},"halfEdge":{"pass":0.305,"fail":0.519,"dailyFail":0.01,"fundedLost":0.728,"ev":2290,"stopsPerYear":6.5,"threeYear":9301,"threeAhead":0.665,"threeLate":8566},"luck":{"pass":0.157,"fail":0.689,"dailyFail":0.005,"fundedLost":0.833,"ev":602,"stopsPerYear":7.3,"threeYear":2074,"threeAhead":0.403,"threeLate":-79}},"0.005":{"playbook":{"pass":0.461,"fail":0.409,"dailyFail":0.011,"fundedLost":0.611,"ev":4942,"stopsPerYear":5.7,"threeYear":19827,"threeAhead":0.918,"threeLate":22520},"halfEdge":{"pass":0.281,"fail":0.567,"dailyFail":0.01,"fundedLost":0.754,"ev":1995,"stopsPerYear":6.6,"threeYear":8230,"threeAhead":0.616,"threeLate":8526},"luck":{"pass":0.138,"fail":0.733,"dailyFail":0.005,"fundedLost":0.829,"ev":464,"stopsPerYear":7.4,"threeYear":1472,"threeAhead":0.363,"threeLate":-722}},"0.01":{"playbook":{"pass":0.403,"fail":0.495,"dailyFail":0.01,"fundedLost":0.692,"ev":4023,"stopsPerYear":5.9,"threeYear":16811,"threeAhead":0.858,"threeLate":19280},"halfEdge":{"pass":0.247,"fail":0.645,"dailyFail":0.009,"fundedLost":0.788,"ev":1573,"stopsPerYear":6.7,"threeYear":6259,"threeAhead":0.511,"threeLate":5953},"luck":{"pass":0.125,"fail":0.785,"dailyFail":0.005,"fundedLost":0.836,"ev":245,"stopsPerYear":7.6,"threeYear":346,"threeAhead":0.247,"threeLate":-1814}}},"ftmo_1step_100k":{"0":{"playbook":{"pass":0.58,"fail":0.36,"dailyFail":0.039,"fundedLost":0.558,"ev":3958,"stopsPerYear":13.1,"threeYear":19115,"threeAhead":0.811,"threeLate":17266},"halfEdge":{"pass":0.406,"fail":0.544,"dailyFail":0.046,"fundedLost":0.672,"ev":1750,"stopsPerYear":14.2,"threeYear":6790,"threeAhead":0.571,"threeLate":3012},"luck":{"pass":0.273,"fail":0.664,"dailyFail":0.035,"fundedLost":0.749,"ev":507,"stopsPerYear":15.2,"threeYear":1128,"threeAhead":0.32,"threeLate":-2550}},"0.001":{"playbook":{"pass":0.552,"fail":0.4,"dailyFail":0.04,"fundedLost":0.602,"ev":3480,"stopsPerYear":13.2,"threeYear":16275,"threeAhead":0.778,"threeLate":14183},"halfEdge":{"pass":0.348,"fail":0.599,"dailyFail":0.046,"fundedLost":0.783,"ev":1025,"stopsPerYear":14.4,"threeYear":3418,"threeAhead":0.447,"threeLate":-1499},"luck":{"pass":0.254,"fail":0.701,"dailyFail":0.033,"fundedLost":0.817,"ev":133,"stopsPerYear":15.2,"threeYear":-722,"threeAhead":0.223,"threeLate":-2736}},"0.0025":{"playbook":{"pass":0.49,"fail":0.475,"dailyFail":0.039,"fundedLost":0.676,"ev":2678,"stopsPerYear":13.2,"threeYear":14765,"threeAhead":0.726,"threeLate":14866},"halfEdge":{"pass":0.322,"fail":0.647,"dailyFail":0.045,"fundedLost":0.803,"ev":704,"stopsPerYear":14.2,"threeYear":2326,"threeAhead":0.377,"threeLate":-1309},"luck":{"pass":0.231,"fail":0.736,"dailyFail":0.031,"fundedLost":0.84,"ev":-17,"stopsPerYear":15.5,"threeYear":-1764,"threeAhead":0.156,"threeLate":-4032}},"0.005":{"playbook":{"pass":0.41,"fail":0.558,"dailyFail":0.035,"fundedLost":0.818,"ev":1531,"stopsPerYear":13.8,"threeYear":9576,"threeAhead":0.651,"threeLate":9128},"halfEdge":{"pass":0.274,"fail":0.715,"dailyFail":0.039,"fundedLost":0.843,"ev":465,"stopsPerYear":15.1,"threeYear":1190,"threeAhead":0.302,"threeLate":-2948},"luck":{"pass":0.195,"fail":0.795,"dailyFail":0.024,"fundedLost":0.911,"ev":-205,"stopsPerYear":15.8,"threeYear":-2728,"threeAhead":0.144,"threeLate":-5139}},"0.01":{"playbook":{"pass":0.097,"fail":0.903,"dailyFail":0.903,"fundedLost":1,"ev":-468,"stopsPerYear":13.3,"threeYear":-17166,"threeAhead":0.045,"threeLate":-19193},"halfEdge":{"pass":0.062,"fail":0.938,"dailyFail":0.938,"fundedLost":1,"ev":-525,"stopsPerYear":14.6,"threeYear":-20135,"threeAhead":0,"threeLate":-22052},"luck":{"pass":0.045,"fail":0.955,"dailyFail":0.955,"fundedLost":1,"ev":-534,"stopsPerYear":15.5,"threeYear":-22936,"threeAhead":0,"threeLate":-25775}}},"fundednext_2step_100k":{"0":{"playbook":{"pass":0.597,"fail":0.316,"dailyFail":0.011,"fundedLost":0.484,"ev":7461,"stopsPerYear":5.6,"threeYear":25592,"threeAhead":0.966,"threeLate":28072},"halfEdge":{"pass":0.392,"fail":0.473,"dailyFail":0.01,"fundedLost":0.55,"ev":3294,"stopsPerYear":6.3,"threeYear":13681,"threeAhead":0.824,"threeLate":14476},"luck":{"pass":0.226,"fail":0.647,"dailyFail":0.006,"fundedLost":0.822,"ev":1028,"stopsPerYear":7.2,"threeYear":3822,"threeAhead":0.465,"threeLate":1015}},"0.001":{"playbook":{"pass":0.587,"fail":0.326,"dailyFail":0.011,"fundedLost":0.526,"ev":7122,"stopsPerYear":5.6,"threeYear":24743,"threeAhead":0.964,"threeLate":27893},"halfEdge":{"pass":0.365,"fail":0.499,"dailyFail":0.01,"fundedLost":0.577,"ev":3096,"stopsPerYear":6.3,"threeYear":12994,"threeAhead":0.801,"threeLate":13280},"luck":{"pass":0.205,"fail":0.671,"dailyFail":0.006,"fundedLost":0.812,"ev":915,"stopsPerYear":7.3,"threeYear":3233,"threeAhead":0.425,"threeLate":380}},"0.0025":{"playbook":{"pass":0.561,"fail":0.35,"dailyFail":0.011,"fundedLost":0.525,"ev":6627,"stopsPerYear":5.6,"threeYear":23649,"threeAhead":0.944,"threeLate":26814},"halfEdge":{"pass":0.342,"fail":0.528,"dailyFail":0.01,"fundedLost":0.666,"ev":2742,"stopsPerYear":6.5,"threeYear":11387,"threeAhead":0.752,"threeLate":11021},"luck":{"pass":0.198,"fail":0.697,"dailyFail":0.005,"fundedLost":0.823,"ev":821,"stopsPerYear":7.3,"threeYear":2798,"threeAhead":0.389,"threeLate":345}},"0.005":{"playbook":{"pass":0.524,"fail":0.395,"dailyFail":0.011,"fundedLost":0.59,"ev":5804,"stopsPerYear":5.7,"threeYear":22030,"threeAhead":0.932,"threeLate":25179},"halfEdge":{"pass":0.321,"fail":0.57,"dailyFail":0.01,"fundedLost":0.707,"ev":2391,"stopsPerYear":6.6,"threeYear":9826,"threeAhead":0.689,"threeLate":10293},"luck":{"pass":0.175,"fail":0.739,"dailyFail":0.005,"fundedLost":0.831,"ev":664,"stopsPerYear":7.5,"threeYear":2189,"threeAhead":0.365,"threeLate":-107}},"0.01":{"playbook":{"pass":0.458,"fail":0.479,"dailyFail":0.009,"fundedLost":0.708,"ev":4535,"stopsPerYear":6,"threeYear":20074,"threeAhead":0.905,"threeLate":23413},"halfEdge":{"pass":0.281,"fail":0.638,"dailyFail":0.009,"fundedLost":0.756,"ev":1931,"stopsPerYear":6.7,"threeYear":7604,"threeAhead":0.579,"threeLate":7924},"luck":{"pass":0.157,"fail":0.782,"dailyFail":0.005,"fundedLost":0.822,"ev":459,"stopsPerYear":7.6,"threeYear":1644,"threeAhead":0.388,"threeLate":-1008}}}},"clipped":{"ftmo_2step_100k":{"0":{"playbook":{"pass":0.549,"fail":0.3,"dailyFail":0.011,"fundedLost":0.5,"ev":6675,"stopsPerYear":5.3,"threeYear":24647,"threeAhead":0.967,"threeLate":27378},"halfEdge":{"pass":0.342,"fail":0.456,"dailyFail":0.011,"fundedLost":0.599,"ev":2952,"stopsPerYear":5.9,"threeYear":11790,"threeAhead":0.75,"threeLate":11980},"luck":{"pass":0.18,"fail":0.632,"dailyFail":0.006,"fundedLost":0.832,"ev":869,"stopsPerYear":6.8,"threeYear":3207,"threeAhead":0.437,"threeLate":864}},"0.001":{"playbook":{"pass":0.54,"fail":0.305,"dailyFail":0.011,"fundedLost":0.543,"ev":6352,"stopsPerYear":5.3,"threeYear":23613,"threeAhead":0.968,"threeLate":27276},"halfEdge":{"pass":0.329,"fail":0.478,"dailyFail":0.011,"fundedLost":0.595,"ev":2772,"stopsPerYear":5.9,"threeYear":11234,"threeAhead":0.742,"threeLate":11543},"luck":{"pass":0.168,"fail":0.641,"dailyFail":0.006,"fundedLost":0.829,"ev":802,"stopsPerYear":6.8,"threeYear":2748,"threeAhead":0.429,"threeLate":436}},"0.0025":{"playbook":{"pass":0.522,"fail":0.328,"dailyFail":0.011,"fundedLost":0.552,"ev":5954,"stopsPerYear":5.3,"threeYear":22878,"threeAhead":0.968,"threeLate":26439},"halfEdge":{"pass":0.317,"fail":0.501,"dailyFail":0.011,"fundedLost":0.664,"ev":2558,"stopsPerYear":6,"threeYear":10221,"threeAhead":0.698,"threeLate":10198},"luck":{"pass":0.164,"fail":0.67,"dailyFail":0.006,"fundedLost":0.837,"ev":719,"stopsPerYear":6.9,"threeYear":2463,"threeAhead":0.411,"threeLate":316}},"0.005":{"playbook":{"pass":0.478,"fail":0.39,"dailyFail":0.011,"fundedLost":0.606,"ev":5271,"stopsPerYear":5.4,"threeYear":20332,"threeAhead":0.932,"threeLate":23339},"halfEdge":{"pass":0.292,"fail":0.555,"dailyFail":0.011,"fundedLost":0.686,"ev":2290,"stopsPerYear":6.1,"threeYear":9183,"threeAhead":0.645,"threeLate":10043},"luck":{"pass":0.146,"fail":0.71,"dailyFail":0.006,"fundedLost":0.836,"ev":564,"stopsPerYear":7,"threeYear":2118,"threeAhead":0.389,"threeLate":217}},"0.01":{"playbook":{"pass":0.421,"fail":0.471,"dailyFail":0.011,"fundedLost":0.676,"ev":4375,"stopsPerYear":5.6,"threeYear":17243,"threeAhead":0.885,"threeLate":19783},"halfEdge":{"pass":0.255,"fail":0.625,"dailyFail":0.011,"fundedLost":0.716,"ev":1781,"stopsPerYear":6.2,"threeYear":6787,"threeAhead":0.557,"threeLate":6626},"luck":{"pass":0.137,"fail":0.76,"dailyFail":0.006,"fundedLost":0.831,"ev":357,"stopsPerYear":7.1,"threeYear":815,"threeAhead":0.251,"threeLate":-1164}}},"ftmo_1step_100k":{"0":{"playbook":{"pass":0.617,"fail":0.333,"dailyFail":0.04,"fundedLost":0.486,"ev":5252,"stopsPerYear":12.4,"threeYear":22482,"threeAhead":0.926,"threeLate":23183},"halfEdge":{"pass":0.436,"fail":0.512,"dailyFail":0.055,"fundedLost":0.644,"ev":1893,"stopsPerYear":13.6,"threeYear":8664,"threeAhead":0.667,"threeLate":5971},"luck":{"pass":0.302,"fail":0.622,"dailyFail":0.043,"fundedLost":0.695,"ev":618,"stopsPerYear":14.4,"threeYear":2412,"threeAhead":0.4,"threeLate":-208}},"0.001":{"playbook":{"pass":0.593,"fail":0.367,"dailyFail":0.04,"fundedLost":0.517,"ev":4802,"stopsPerYear":12.5,"threeYear":20777,"threeAhead":0.897,"threeLate":21553},"halfEdge":{"pass":0.388,"fail":0.553,"dailyFail":0.054,"fundedLost":0.744,"ev":1206,"stopsPerYear":13.8,"threeYear":6689,"threeAhead":0.66,"threeLate":4488},"luck":{"pass":0.279,"fail":0.669,"dailyFail":0.041,"fundedLost":0.818,"ev":188,"stopsPerYear":14.3,"threeYear":249,"threeAhead":0.288,"threeLate":-669}},"0.0025":{"playbook":{"pass":0.542,"fail":0.423,"dailyFail":0.041,"fundedLost":0.587,"ev":3957,"stopsPerYear":12.5,"threeYear":17926,"threeAhead":0.84,"threeLate":20053},"halfEdge":{"pass":0.353,"fail":0.604,"dailyFail":0.048,"fundedLost":0.808,"ev":782,"stopsPerYear":13.8,"threeYear":3787,"threeAhead":0.451,"threeLate":1803},"luck":{"pass":0.255,"fail":0.713,"dailyFail":0.038,"fundedLost":0.835,"ev":-17,"stopsPerYear":14.7,"threeYear":-1679,"threeAhead":0.156,"threeLate":-3855}},"0.005":{"playbook":{"pass":0.462,"fail":0.511,"dailyFail":0.037,"fundedLost":0.777,"ev":2579,"stopsPerYear":12.7,"threeYear":13835,"threeAhead":0.79,"threeLate":18193},"halfEdge":{"pass":0.301,"fail":0.685,"dailyFail":0.042,"fundedLost":0.843,"ev":534,"stopsPerYear":14.2,"threeYear":2943,"threeAhead":0.443,"threeLate":784},"luck":{"pass":0.213,"fail":0.776,"dailyFail":0.031,"fundedLost":0.919,"ev":-205,"stopsPerYear":14.9,"threeYear":-2568,"threeAhead":0.143,"threeLate":-4798}},"0.01":{"playbook":{"pass":0.104,"fail":0.896,"dailyFail":0.896,"fundedLost":1,"ev":-433,"stopsPerYear":12.9,"threeYear":-16038,"threeAhead":0.045,"threeLate":-16995},"halfEdge":{"pass":0.063,"fail":0.937,"dailyFail":0.937,"fundedLost":1,"ev":-525,"stopsPerYear":14.2,"threeYear":-19156,"threeAhead":0,"threeLate":-20173},"luck":{"pass":0.048,"fail":0.952,"dailyFail":0.952,"fundedLost":1,"ev":-534,"stopsPerYear":14.9,"threeYear":-21592,"threeAhead":0,"threeLate":-23118}}},"fundednext_2step_100k":{"0":{"playbook":{"pass":0.616,"fail":0.298,"dailyFail":0.008,"fundedLost":0.476,"ev":7914,"stopsPerYear":5.3,"threeYear":26623,"threeAhead":0.984,"threeLate":30076},"halfEdge":{"pass":0.414,"fail":0.448,"dailyFail":0.011,"fundedLost":0.55,"ev":3724,"stopsPerYear":5.8,"threeYear":14348,"threeAhead":0.829,"threeLate":15466},"luck":{"pass":0.234,"fail":0.631,"dailyFail":0.006,"fundedLost":0.825,"ev":1164,"stopsPerYear":6.8,"threeYear":4262,"threeAhead":0.475,"threeLate":1617}},"0.001":{"playbook":{"pass":0.608,"fail":0.307,"dailyFail":0.008,"fundedLost":0.51,"ev":7610,"stopsPerYear":5.3,"threeYear":25841,"threeAhead":0.983,"threeLate":29996},"halfEdge":{"pass":0.388,"fail":0.481,"dailyFail":0.011,"fundedLost":0.544,"ev":3511,"stopsPerYear":5.8,"threeYear":13979,"threeAhead":0.817,"threeLate":14870},"luck":{"pass":0.217,"fail":0.645,"dailyFail":0.006,"fundedLost":0.819,"ev":1074,"stopsPerYear":6.9,"threeYear":3703,"threeAhead":0.444,"threeLate":929}},"0.0025":{"playbook":{"pass":0.588,"fail":0.328,"dailyFail":0.008,"fundedLost":0.52,"ev":7137,"stopsPerYear":5.3,"threeYear":25318,"threeAhead":0.98,"threeLate":30126},"halfEdge":{"pass":0.365,"fail":0.512,"dailyFail":0.011,"fundedLost":0.627,"ev":3139,"stopsPerYear":6,"threeYear":12433,"threeAhead":0.784,"threeLate":12740},"luck":{"pass":0.211,"fail":0.669,"dailyFail":0.006,"fundedLost":0.828,"ev":983,"stopsPerYear":6.9,"threeYear":3216,"threeAhead":0.424,"threeLate":835}},"0.005":{"playbook":{"pass":0.545,"fail":0.378,"dailyFail":0.008,"fundedLost":0.585,"ev":6215,"stopsPerYear":5.5,"threeYear":23391,"threeAhead":0.964,"threeLate":27695},"halfEdge":{"pass":0.342,"fail":0.553,"dailyFail":0.011,"fundedLost":0.667,"ev":2727,"stopsPerYear":6.1,"threeYear":10813,"threeAhead":0.742,"threeLate":11837},"luck":{"pass":0.189,"fail":0.713,"dailyFail":0.006,"fundedLost":0.827,"ev":833,"stopsPerYear":7,"threeYear":2737,"threeAhead":0.402,"threeLate":579}},"0.01":{"playbook":{"pass":0.474,"fail":0.456,"dailyFail":0.008,"fundedLost":0.679,"ev":4959,"stopsPerYear":5.6,"threeYear":19833,"threeAhead":0.915,"threeLate":22519},"halfEdge":{"pass":0.297,"fail":0.617,"dailyFail":0.011,"fundedLost":0.71,"ev":2176,"stopsPerYear":6.2,"threeYear":8141,"threeAhead":0.604,"threeLate":8806},"luck":{"pass":0.172,"fail":0.751,"dailyFail":0.006,"fundedLost":0.83,"ev":582,"stopsPerYear":7.1,"threeYear":1995,"threeAhead":0.382,"threeLate":-407}}}}},"stopLevel":{"shares":[0.5,0.7,0.8,0.9,null],"chosen":0.7,"firms":{"ftmo_2step_100k":{"0.5":{"playbook":{"pass":0.513,"fail":0.263,"dailyFail":0,"ev":5100,"evEarly":5902,"evLate":4248,"stopsPerYear":10.2,"threeYear":20189,"threeAhead":0.96},"halfEdge":{"pass":0.288,"fail":0.42,"dailyFail":0,"ev":1932,"evEarly":2899,"evLate":904,"stopsPerYear":11.1,"threeYear":8738,"threeAhead":0.675},"luck":{"pass":0.135,"fail":0.612,"dailyFail":0,"ev":483,"evEarly":1264,"evLate":-347,"stopsPerYear":11.9,"threeYear":2736,"threeAhead":0.42}},"0.7":{"playbook":{"pass":0.531,"fail":0.313,"dailyFail":0.011,"ev":6301,"evEarly":6630,"evLate":5950,"stopsPerYear":5.6,"threeYear":23325,"threeAhead":0.936},"halfEdge":{"pass":0.328,"fail":0.486,"dailyFail":0.01,"ev":2666,"evEarly":3364,"evLate":1925,"stopsPerYear":6.4,"threeYear":11400,"threeAhead":0.737},"luck":{"pass":0.177,"fail":0.646,"dailyFail":0.006,"ev":769,"evEarly":1585,"evLate":-99,"stopsPerYear":7.2,"threeYear":2866,"threeAhead":0.427}},"0.8":{"playbook":{"pass":0.506,"fail":0.358,"dailyFail":0.011,"ev":6270,"evEarly":6995,"evLate":5500,"stopsPerYear":4.4,"threeYear":23752,"threeAhead":0.936},"halfEdge":{"pass":0.39,"fail":0.481,"dailyFail":0.025,"ev":3437,"evEarly":4465,"evLate":2346,"stopsPerYear":4.7,"threeYear":13458,"threeAhead":0.803},"luck":{"pass":0.205,"fail":0.611,"dailyFail":0.018,"ev":916,"evEarly":1770,"evLate":9,"stopsPerYear":5.3,"threeYear":3617,"threeAhead":0.458}},"0.9":{"playbook":{"pass":0.501,"fail":0.39,"dailyFail":0.011,"ev":6500,"evEarly":6857,"evLate":6121,"stopsPerYear":3.3,"threeYear":24108,"threeAhead":0.94},"halfEdge":{"pass":0.382,"fail":0.514,"dailyFail":0.03,"ev":3141,"evEarly":4118,"evLate":2103,"stopsPerYear":4,"threeYear":12686,"threeAhead":0.784},"luck":{"pass":0.21,"fail":0.647,"dailyFail":0.02,"ev":853,"evEarly":1767,"evLate":-118,"stopsPerYear":4.3,"threeYear":3408,"threeAhead":0.502}},"none":{"playbook":{"pass":0.307,"fail":0.657,"dailyFail":0.488,"ev":2340,"evEarly":2392,"evLate":2284,"stopsPerYear":0,"threeYear":13831,"threeAhead":0.719},"halfEdge":{"pass":0.259,"fail":0.728,"dailyFail":0.561,"ev":1210,"evEarly":1310,"evLate":1104,"stopsPerYear":0,"threeYear":5892,"threeAhead":0.626},"luck":{"pass":0.169,"fail":0.822,"dailyFail":0.689,"ev":228,"evEarly":314,"evLate":135,"stopsPerYear":0,"threeYear":-613,"threeAhead":0.329}}},"ftmo_1step_100k":{"0.5":{"playbook":{"pass":0.582,"fail":0.325,"dailyFail":0.016,"ev":3578,"evEarly":5414,"evLate":1628,"stopsPerYear":18.9,"threeYear":13645,"threeAhead":0.768},"halfEdge":{"pass":0.405,"fail":0.501,"dailyFail":0.015,"ev":1454,"evEarly":2549,"evLate":291,"stopsPerYear":19.7,"threeYear":5645,"threeAhead":0.478},"luck":{"pass":0.264,"fail":0.605,"dailyFail":0.007,"ev":-153,"evEarly":69,"evLate":-388,"stopsPerYear":21.1,"threeYear":-716,"threeAhead":0.238}},"0.7":{"playbook":{"pass":0.58,"fail":0.36,"dailyFail":0.039,"ev":3958,"evEarly":4504,"evLate":3378,"stopsPerYear":13.1,"threeYear":19115,"threeAhead":0.811},"halfEdge":{"pass":0.406,"fail":0.544,"dailyFail":0.046,"ev":1750,"evEarly":2585,"evLate":864,"stopsPerYear":14.2,"threeYear":6790,"threeAhead":0.571},"luck":{"pass":0.273,"fail":0.664,"dailyFail":0.035,"ev":507,"evEarly":1196,"evLate":-225,"stopsPerYear":15.2,"threeYear":1128,"threeAhead":0.32}},"0.8":{"playbook":{"pass":0.635,"fail":0.342,"dailyFail":0.04,"ev":5941,"evEarly":6806,"evLate":5021,"stopsPerYear":10.6,"threeYear":25866,"threeAhead":0.994},"halfEdge":{"pass":0.48,"fail":0.47,"dailyFail":0.046,"ev":2840,"evEarly":3968,"evLate":1643,"stopsPerYear":11.1,"threeYear":11058,"threeAhead":0.697},"luck":{"pass":0.303,"fail":0.633,"dailyFail":0.049,"ev":568,"evEarly":1241,"evLate":-147,"stopsPerYear":12.6,"threeYear":3254,"threeAhead":0.436}},"0.9":{"playbook":{"pass":0.666,"fail":0.322,"dailyFail":0.044,"ev":6754,"evEarly":7461,"evLate":6003,"stopsPerYear":8.9,"threeYear":27191,"threeAhead":0.941},"halfEdge":{"pass":0.479,"fail":0.469,"dailyFail":0.052,"ev":2627,"evEarly":4689,"evLate":437,"stopsPerYear":9.9,"threeYear":12352,"threeAhead":0.77},"luck":{"pass":0.31,"fail":0.63,"dailyFail":0.075,"ev":834,"evEarly":1876,"evLate":-274,"stopsPerYear":10.6,"threeYear":3338,"threeAhead":0.445}},"none":{"playbook":{"pass":0.174,"fail":0.826,"dailyFail":0.816,"ev":-292,"evEarly":-314,"evLate":-268,"stopsPerYear":0,"threeYear":-6747,"threeAhead":0.132},"halfEdge":{"pass":0.136,"fail":0.864,"dailyFail":0.863,"ev":-384,"evEarly":-363,"evLate":-407,"stopsPerYear":0,"threeYear":-10736,"threeAhead":0.117},"luck":{"pass":0.098,"fail":0.902,"dailyFail":0.898,"ev":-442,"evEarly":-419,"evLate":-467,"stopsPerYear":0,"threeYear":-13494,"threeAhead":0.001}}},"fundednext_2step_100k":{"0.5":{"playbook":{"pass":0.574,"fail":0.269,"dailyFail":0,"ev":5815,"evEarly":6573,"evLate":5009,"stopsPerYear":10.2,"threeYear":21889,"threeAhead":0.972},"halfEdge":{"pass":0.352,"fail":0.425,"dailyFail":0,"ev":2309,"evEarly":3391,"evLate":1161,"stopsPerYear":11.1,"threeYear":9836,"threeAhead":0.735},"luck":{"pass":0.183,"fail":0.604,"dailyFail":0,"ev":777,"evEarly":1673,"evLate":-174,"stopsPerYear":11.8,"threeYear":3641,"threeAhead":0.436}},"0.7":{"playbook":{"pass":0.597,"fail":0.316,"dailyFail":0.011,"ev":7461,"evEarly":7535,"evLate":7382,"stopsPerYear":5.6,"threeYear":25592,"threeAhead":0.966},"halfEdge":{"pass":0.392,"fail":0.473,"dailyFail":0.01,"ev":3294,"evEarly":3882,"evLate":2668,"stopsPerYear":6.3,"threeYear":13681,"threeAhead":0.824},"luck":{"pass":0.226,"fail":0.647,"dailyFail":0.006,"ev":1028,"evEarly":1952,"evLate":47,"stopsPerYear":7.2,"threeYear":3822,"threeAhead":0.465}},"0.8":{"playbook":{"pass":0.56,"fail":0.355,"dailyFail":0.008,"ev":7223,"evEarly":7779,"evLate":6631,"stopsPerYear":4.4,"threeYear":26422,"threeAhead":0.964},"halfEdge":{"pass":0.434,"fail":0.479,"dailyFail":0.025,"ev":3957,"evEarly":5016,"evLate":2831,"stopsPerYear":4.7,"threeYear":15128,"threeAhead":0.867},"luck":{"pass":0.26,"fail":0.617,"dailyFail":0.018,"ev":1258,"evEarly":2270,"evLate":182,"stopsPerYear":5.3,"threeYear":4921,"threeAhead":0.546}},"0.9":{"playbook":{"pass":0.553,"fail":0.375,"dailyFail":0.009,"ev":7284,"evEarly":7484,"evLate":7071,"stopsPerYear":3.4,"threeYear":27165,"threeAhead":0.97},"halfEdge":{"pass":0.418,"fail":0.514,"dailyFail":0.028,"ev":3580,"evEarly":4541,"evLate":2558,"stopsPerYear":4,"threeYear":13998,"threeAhead":0.837},"luck":{"pass":0.266,"fail":0.629,"dailyFail":0.02,"ev":1184,"evEarly":2216,"evLate":89,"stopsPerYear":4.3,"threeYear":5135,"threeAhead":0.582}},"none":{"playbook":{"pass":0.354,"fail":0.624,"dailyFail":0.453,"ev":2947,"evEarly":2807,"evLate":3096,"stopsPerYear":0,"threeYear":17110,"threeAhead":0.831},"halfEdge":{"pass":0.296,"fail":0.695,"dailyFail":0.521,"ev":1578,"evEarly":1632,"evLate":1521,"stopsPerYear":0,"threeYear":8286,"threeAhead":0.702},"luck":{"pass":0.21,"fail":0.786,"dailyFail":0.638,"ev":479,"evEarly":523,"evLate":432,"stopsPerYear":0,"threeYear":1238,"threeAhead":0.439}}}},"slip25":{"ftmo_2step_100k":{"0.5":{"playbook":{"pass":0.438,"fail":0.337,"dailyFail":0,"ev":3665,"evEarly":4539,"evLate":2737,"stopsPerYear":10.4,"threeYear":16009,"threeAhead":0.911},"halfEdge":{"pass":0.231,"fail":0.534,"dailyFail":0,"ev":1109,"evEarly":1872,"evLate":298,"stopsPerYear":11.3,"threeYear":5863,"threeAhead":0.594},"luck":{"pass":0.109,"fail":0.703,"dailyFail":0,"ev":90,"evEarly":603,"evLate":-454,"stopsPerYear":12.2,"threeYear":717,"threeAhead":0.305}},"0.7":{"playbook":{"pass":0.503,"fail":0.348,"dailyFail":0.011,"ev":5575,"evEarly":5701,"evLate":5441,"stopsPerYear":5.6,"threeYear":21461,"threeAhead":0.932},"halfEdge":{"pass":0.305,"fail":0.519,"dailyFail":0.01,"ev":2290,"evEarly":2963,"evLate":1574,"stopsPerYear":6.5,"threeYear":9301,"threeAhead":0.665},"luck":{"pass":0.157,"fail":0.689,"dailyFail":0.005,"ev":602,"evEarly":1346,"evLate":-189,"stopsPerYear":7.3,"threeYear":2074,"threeAhead":0.403}},"0.8":{"playbook":{"pass":0.49,"fail":0.385,"dailyFail":0.011,"ev":5851,"evEarly":6563,"evLate":5096,"stopsPerYear":4.5,"threeYear":22420,"threeAhead":0.92},"halfEdge":{"pass":0.379,"fail":0.506,"dailyFail":0.025,"ev":3094,"evEarly":3962,"evLate":2171,"stopsPerYear":4.7,"threeYear":12277,"threeAhead":0.828},"luck":{"pass":0.189,"fail":0.653,"dailyFail":0.018,"ev":691,"evEarly":1427,"evLate":-91,"stopsPerYear":5.4,"threeYear":2531,"threeAhead":0.404}},"0.9":{"playbook":{"pass":0.476,"fail":0.412,"dailyFail":0.011,"ev":5562,"evEarly":5538,"evLate":5588,"stopsPerYear":3.4,"threeYear":22530,"threeAhead":0.898},"halfEdge":{"pass":0.361,"fail":0.551,"dailyFail":0.029,"ev":2391,"evEarly":2839,"evLate":1914,"stopsPerYear":4.1,"threeYear":10268,"threeAhead":0.755},"luck":{"pass":0.192,"fail":0.675,"dailyFail":0.02,"ev":494,"evEarly":1130,"evLate":-181,"stopsPerYear":4.4,"threeYear":2443,"threeAhead":0.483}},"none":{"playbook":{"pass":0.307,"fail":0.657,"dailyFail":0.488,"ev":2340,"evEarly":2392,"evLate":2284,"stopsPerYear":0,"threeYear":13831,"threeAhead":0.719},"halfEdge":{"pass":0.259,"fail":0.728,"dailyFail":0.561,"ev":1210,"evEarly":1310,"evLate":1104,"stopsPerYear":0,"threeYear":5892,"threeAhead":0.626},"luck":{"pass":0.169,"fail":0.822,"dailyFail":0.689,"ev":228,"evEarly":314,"evLate":135,"stopsPerYear":0,"threeYear":-613,"threeAhead":0.329}}},"ftmo_1step_100k":{"0.5":{"playbook":{"pass":0.421,"fail":0.522,"dailyFail":0.013,"ev":1501,"evEarly":2555,"evLate":382,"stopsPerYear":19.3,"threeYear":6848,"threeAhead":0.669},"halfEdge":{"pass":0.303,"fail":0.614,"dailyFail":0.007,"ev":338,"evEarly":974,"evLate":-337,"stopsPerYear":20.1,"threeYear":913,"threeAhead":0.382},"luck":{"pass":0.169,"fail":0.778,"dailyFail":0.005,"ev":-416,"evEarly":-302,"evLate":-536,"stopsPerYear":21.8,"threeYear":-2595,"threeAhead":0.11}},"0.7":{"playbook":{"pass":0.49,"fail":0.475,"dailyFail":0.039,"ev":2678,"evEarly":3211,"evLate":2112,"stopsPerYear":13.2,"threeYear":14765,"threeAhead":0.726},"halfEdge":{"pass":0.322,"fail":0.647,"dailyFail":0.045,"ev":704,"evEarly":1518,"evLate":-162,"stopsPerYear":14.2,"threeYear":2326,"threeAhead":0.377},"luck":{"pass":0.231,"fail":0.736,"dailyFail":0.031,"ev":-17,"evEarly":382,"evLate":-441,"stopsPerYear":15.5,"threeYear":-1764,"threeAhead":0.156}},"0.8":{"playbook":{"pass":0.58,"fail":0.39,"dailyFail":0.043,"ev":4325,"evEarly":5560,"evLate":3014,"stopsPerYear":10.8,"threeYear":20367,"threeAhead":0.846},"halfEdge":{"pass":0.41,"fail":0.554,"dailyFail":0.045,"ev":1330,"evEarly":2747,"evLate":-176,"stopsPerYear":11.6,"threeYear":5363,"threeAhead":0.489},"luck":{"pass":0.248,"fail":0.706,"dailyFail":0.041,"ev":176,"evEarly":702,"evLate":-382,"stopsPerYear":12.8,"threeYear":893,"threeAhead":0.296}},"0.9":{"playbook":{"pass":0.614,"fail":0.368,"dailyFail":0.035,"ev":5239,"evEarly":6408,"evLate":3997,"stopsPerYear":9.1,"threeYear":22251,"threeAhead":0.925},"halfEdge":{"pass":0.438,"fail":0.534,"dailyFail":0.044,"ev":1986,"evEarly":3553,"evLate":321,"stopsPerYear":10.1,"threeYear":9482,"threeAhead":0.696},"luck":{"pass":0.267,"fail":0.712,"dailyFail":0.07,"ev":416,"evEarly":1144,"evLate":-358,"stopsPerYear":11.1,"threeYear":2420,"threeAhead":0.501}},"none":{"playbook":{"pass":0.174,"fail":0.826,"dailyFail":0.816,"ev":-292,"evEarly":-314,"evLate":-268,"stopsPerYear":0,"threeYear":-6747,"threeAhead":0.132},"halfEdge":{"pass":0.136,"fail":0.864,"dailyFail":0.863,"ev":-384,"evEarly":-363,"evLate":-407,"stopsPerYear":0,"threeYear":-10736,"threeAhead":0.117},"luck":{"pass":0.098,"fail":0.902,"dailyFail":0.898,"ev":-442,"evEarly":-419,"evLate":-467,"stopsPerYear":0,"threeYear":-13494,"threeAhead":0.001}}},"fundednext_2step_100k":{"0.5":{"playbook":{"pass":0.506,"fail":0.334,"dailyFail":0,"ev":4297,"evEarly":5145,"evLate":3396,"stopsPerYear":10.3,"threeYear":17431,"threeAhead":0.947},"halfEdge":{"pass":0.294,"fail":0.522,"dailyFail":0,"ev":1488,"evEarly":2322,"evLate":602,"stopsPerYear":11.3,"threeYear":6780,"threeAhead":0.627},"luck":{"pass":0.16,"fail":0.686,"dailyFail":0,"ev":337,"evEarly":961,"evLate":-327,"stopsPerYear":12.2,"threeYear":1442,"threeAhead":0.402}},"0.7":{"playbook":{"pass":0.561,"fail":0.35,"dailyFail":0.011,"ev":6627,"evEarly":6472,"evLate":6792,"stopsPerYear":5.6,"threeYear":23649,"threeAhead":0.944},"halfEdge":{"pass":0.342,"fail":0.528,"dailyFail":0.01,"ev":2742,"evEarly":3393,"evLate":2050,"stopsPerYear":6.5,"threeYear":11387,"threeAhead":0.752},"luck":{"pass":0.198,"fail":0.697,"dailyFail":0.005,"ev":821,"evEarly":1708,"evLate":-122,"stopsPerYear":7.3,"threeYear":2798,"threeAhead":0.389}},"0.8":{"playbook":{"pass":0.54,"fail":0.387,"dailyFail":0.009,"ev":6653,"evEarly":7122,"evLate":6155,"stopsPerYear":4.5,"threeYear":24261,"threeAhead":0.955},"halfEdge":{"pass":0.416,"fail":0.51,"dailyFail":0.024,"ev":3545,"evEarly":4456,"evLate":2577,"stopsPerYear":4.8,"threeYear":13479,"threeAhead":0.827},"luck":{"pass":0.246,"fail":0.645,"dailyFail":0.018,"ev":1014,"evEarly":1866,"evLate":108,"stopsPerYear":5.4,"threeYear":4139,"threeAhead":0.506}},"0.9":{"playbook":{"pass":0.535,"fail":0.395,"dailyFail":0.009,"ev":6299,"evEarly":6411,"evLate":6181,"stopsPerYear":3.5,"threeYear":25612,"threeAhead":0.961},"halfEdge":{"pass":0.4,"fail":0.545,"dailyFail":0.027,"ev":2631,"evEarly":3300,"evLate":1920,"stopsPerYear":4.2,"threeYear":12099,"threeAhead":0.782},"luck":{"pass":0.252,"fail":0.654,"dailyFail":0.02,"ev":961,"evEarly":1856,"evLate":9,"stopsPerYear":4.4,"threeYear":4170,"threeAhead":0.571}},"none":{"playbook":{"pass":0.354,"fail":0.624,"dailyFail":0.453,"ev":2947,"evEarly":2807,"evLate":3096,"stopsPerYear":0,"threeYear":17110,"threeAhead":0.831},"halfEdge":{"pass":0.296,"fail":0.695,"dailyFail":0.521,"ev":1578,"evEarly":1632,"evLate":1521,"stopsPerYear":0,"threeYear":8286,"threeAhead":0.702},"luck":{"pass":0.21,"fail":0.786,"dailyFail":0.638,"ev":479,"evEarly":523,"evLate":432,"stopsPerYear":0,"threeYear":1238,"threeAhead":0.439}}}},"walkforward":{"ftmo_2step_100k":{"single":{"pick":0.8,"early":4465,"late":2346,"baseLate":904,"rankLate":1,"bestLate":0.8,"of":5},"three":{"pick":0.8,"early":14532,"late":12244,"baseLate":5603,"rankLate":1,"bestLate":0.8,"of":5},"slip25":{"pick":0.8,"early":3962,"late":2171,"baseLate":298,"rankLate":1,"bestLate":0.8,"of":5}},"ftmo_1step_100k":{"single":{"pick":0.9,"early":4689,"late":437,"baseLate":291,"rankLate":3,"bestLate":0.8,"of":5},"three":{"pick":0.9,"early":15798,"late":8460,"baseLate":2599,"rankLate":1,"bestLate":0.9,"of":5},"slip25":{"pick":0.9,"early":3553,"late":321,"baseLate":-337,"rankLate":1,"bestLate":0.9,"of":5}},"fundednext_2step_100k":{"single":{"pick":0.8,"early":5016,"late":2831,"baseLate":1161,"rankLate":1,"bestLate":0.8,"of":5},"three":{"pick":0.8,"early":16694,"late":13359,"baseLate":6516,"rankLate":2,"bestLate":0.7,"of":5},"slip25":{"pick":0.8,"early":4456,"late":2577,"baseLate":602,"rankLate":1,"bestLate":0.8,"of":5}}}},"tripleCheck":{"dropped":["turtle|USDJPY|1h","turn_of_month|RUT|1d","turn_of_month|FTSE|1d","turn_of_month|DAX|1d"],"kept":["turtle|BTC|1d","rsi2|ES|1d","rsi2|NQ|1d","ibs|NQ|1d","month_end_rebal|ES|1d","month_end_rebal|RUT|1d"],"firms":{"ftmo_2step_100k":{"all":{"playbook":{"pass":0.531,"fail":0.313,"ev":6301,"evLate":5950,"threeYear":23325,"threeAhead":0.936},"halfEdge":{"pass":0.328,"fail":0.486,"ev":2666,"evLate":1925,"threeYear":11400,"threeAhead":0.737},"luck":{"pass":0.177,"fail":0.646,"ev":769,"evLate":-99,"threeYear":2866,"threeAhead":0.427}},"passed":{"playbook":{"pass":0.297,"fail":0.188,"ev":2562,"evLate":3700,"threeYear":11060,"threeAhead":0.796},"halfEdge":{"pass":0.171,"fail":0.276,"ev":951,"evLate":1246,"threeYear":4823,"threeAhead":0.627},"luck":{"pass":0.097,"fail":0.379,"ev":-9,"evLate":36,"threeYear":1032,"threeAhead":0.321}}},"ftmo_1step_100k":{"all":{"playbook":{"pass":0.58,"fail":0.36,"ev":3958,"evLate":3378,"threeYear":19115,"threeAhead":0.811},"halfEdge":{"pass":0.406,"fail":0.544,"ev":1750,"evLate":864,"threeYear":6790,"threeAhead":0.571},"luck":{"pass":0.273,"fail":0.664,"ev":507,"evLate":-225,"threeYear":1128,"threeAhead":0.32}},"passed":{"playbook":{"pass":0.449,"fail":0.25,"ev":2583,"evLate":3544,"threeYear":11441,"threeAhead":0.75},"halfEdge":{"pass":0.286,"fail":0.351,"ev":756,"evLate":864,"threeYear":4516,"threeAhead":0.506},"luck":{"pass":0.171,"fail":0.513,"ev":61,"evLate":80,"threeYear":1045,"threeAhead":0.265}}},"fundednext_2step_100k":{"all":{"playbook":{"pass":0.597,"fail":0.316,"ev":7461,"evLate":7382,"threeYear":25592,"threeAhead":0.966},"halfEdge":{"pass":0.392,"fail":0.473,"ev":3294,"evLate":2668,"threeYear":13681,"threeAhead":0.824},"luck":{"pass":0.226,"fail":0.647,"ev":1028,"evLate":47,"threeYear":3822,"threeAhead":0.465}},"passed":{"playbook":{"pass":0.384,"fail":0.194,"ev":3281,"evLate":4653,"threeYear":12651,"threeAhead":0.848},"halfEdge":{"pass":0.229,"fail":0.286,"ev":1481,"evLate":1951,"threeYear":6185,"threeAhead":0.686},"luck":{"pass":0.116,"fail":0.389,"ev":291,"evLate":438,"threeYear":1608,"threeAhead":0.371}}}}},"leaveOut":{"ftmo_2step_100k":{"all":{"label":"all 10","ids":10,"pass":0.369,"fail":0.266,"ev":3409,"halfEdgeEv":1075,"halfEarly":1826,"halfLate":277,"luckEv":273},"minus:turtle|USDJPY|1h":{"label":"without turtle|USDJPY|1h","ids":9,"pass":0.399,"fail":0.205,"ev":3799,"halfEdgeEv":1342,"halfEarly":1826,"halfLate":828,"luckEv":199},"minus:turtle|BTC|1d":{"label":"without turtle|BTC|1d","ids":9,"pass":0.322,"fail":0.285,"ev":2950,"halfEdgeEv":1017,"halfEarly":1826,"halfLate":157,"luckEv":248},"minus:rsi2|ES|1d":{"label":"without rsi2|ES|1d","ids":9,"pass":0.365,"fail":0.264,"ev":3470,"halfEdgeEv":1241,"halfEarly":1717,"halfLate":734,"luckEv":268},"minus:rsi2|NQ|1d":{"label":"without rsi2|NQ|1d","ids":9,"pass":0.367,"fail":0.259,"ev":3293,"halfEdgeEv":982,"halfEarly":1433,"halfLate":504,"luckEv":-42},"minus:ibs|NQ|1d":{"label":"without ibs|NQ|1d","ids":9,"pass":0.362,"fail":0.22,"ev":2930,"halfEdgeEv":748,"halfEarly":1301,"halfLate":161,"luckEv":-146},"minus:month_end_rebal|ES|1d":{"label":"without month_end_rebal|ES|1d","ids":9,"pass":0.362,"fail":0.231,"ev":3520,"halfEdgeEv":1060,"halfEarly":1670,"halfLate":412,"luckEv":128},"minus:turn_of_month|RUT|1d":{"label":"without turn_of_month|RUT|1d","ids":9,"pass":0.488,"fail":0.267,"ev":5015,"halfEdgeEv":1566,"halfEarly":2112,"halfLate":986,"luckEv":203},"minus:turn_of_month|DAX|1d":{"label":"without turn_of_month|DAX|1d","ids":9,"pass":0.422,"fail":0.261,"ev":3271,"halfEdgeEv":841,"halfEarly":1532,"halfLate":107,"luckEv":-71},"minus:turn_of_month|FTSE|1d":{"label":"without turn_of_month|FTSE|1d","ids":9,"pass":0.374,"fail":0.255,"ev":3356,"halfEdgeEv":996,"halfEarly":1709,"halfLate":237,"luckEv":142},"minus:month_end_rebal|RUT|1d":{"label":"without month_end_rebal|RUT|1d","ids":9,"pass":0.379,"fail":0.263,"ev":3159,"halfEdgeEv":734,"halfEarly":1266,"halfLate":168,"luckEv":-85},"noCrypto":{"label":"without Bitcoin","ids":9,"pass":0.322,"fail":0.285,"ev":2950,"halfEdgeEv":1017,"halfEarly":1826,"halfLate":157,"luckEv":248},"indexOnly":{"label":"stock indexes only","ids":8,"pass":0.365,"fail":0.22,"ev":3249,"halfEdgeEv":1062,"halfEarly":1826,"halfLate":250,"luckEv":211},"usOnly":{"label":"without the DAX and FTSE","ids":8,"pass":0.301,"fail":0.257,"ev":2199,"halfEdgeEv":312,"halfEarly":629,"halfLate":-25,"luckEv":-232},"noDipBuying":{"label":"without RSI(2) and IBS","ids":7,"pass":0.328,"fail":0.201,"ev":2079,"halfEdgeEv":799,"halfEarly":1264,"halfLate":305,"luckEv":196},"noTomRutNoUsdjpy":{"label":"without turn of the month on RUT and Turtle USD/JPY","ids":8,"pass":0.489,"fail":0.21,"ev":4996,"halfEdgeEv":1739,"halfEarly":2112,"halfLate":1344,"luckEv":334},"calendarOnly":{"label":"calendar rules only (month-end, turn of the month)","ids":5,"pass":0.278,"fail":0.158,"ev":1461,"halfEdgeEv":468,"halfEarly":1264,"halfLate":-379,"luckEv":14}},"fundednext_2step_100k":{"all":{"label":"all 10","ids":10,"pass":0.482,"fail":0.263,"ev":4101,"halfEdgeEv":1440,"halfEarly":2233,"halfLate":597,"luckEv":517},"minus:turtle|USDJPY|1h":{"label":"without turtle|USDJPY|1h","ids":9,"pass":0.499,"fail":0.21,"ev":4697,"halfEdgeEv":1995,"halfEarly":2233,"halfLate":1741,"luckEv":468},"minus:turtle|BTC|1d":{"label":"without turtle|BTC|1d","ids":9,"pass":0.431,"fail":0.287,"ev":3597,"halfEdgeEv":1383,"halfEarly":2233,"halfLate":481,"luckEv":471},"minus:rsi2|ES|1d":{"label":"without rsi2|ES|1d","ids":9,"pass":0.459,"fail":0.25,"ev":4123,"halfEdgeEv":1797,"halfEarly":2217,"halfLate":1351,"luckEv":571},"minus:rsi2|NQ|1d":{"label":"without rsi2|NQ|1d","ids":9,"pass":0.458,"fail":0.244,"ev":3889,"halfEdgeEv":1486,"halfEarly":2076,"halfLate":859,"luckEv":129},"minus:ibs|NQ|1d":{"label":"without ibs|NQ|1d","ids":9,"pass":0.46,"fail":0.214,"ev":3667,"halfEdgeEv":1106,"halfEarly":1850,"halfLate":314,"luckEv":173},"minus:month_end_rebal|ES|1d":{"label":"without month_end_rebal|ES|1d","ids":9,"pass":0.457,"fail":0.235,"ev":4283,"halfEdgeEv":1443,"halfEarly":2052,"halfLate":797,"luckEv":373},"minus:turn_of_month|RUT|1d":{"label":"without turn_of_month|RUT|1d","ids":9,"pass":0.542,"fail":0.257,"ev":5694,"halfEdgeEv":2195,"halfEarly":2928,"halfLate":1416,"luckEv":498},"minus:turn_of_month|DAX|1d":{"label":"without turn_of_month|DAX|1d","ids":9,"pass":0.51,"fail":0.259,"ev":4179,"halfEdgeEv":1242,"halfEarly":1999,"halfLate":439,"luckEv":161},"minus:turn_of_month|FTSE|1d":{"label":"without turn_of_month|FTSE|1d","ids":9,"pass":0.47,"fail":0.258,"ev":4017,"halfEdgeEv":1409,"halfEarly":2162,"halfLate":609,"luckEv":462},"minus:month_end_rebal|RUT|1d":{"label":"without month_end_rebal|RUT|1d","ids":9,"pass":0.493,"fail":0.251,"ev":3991,"halfEdgeEv":1152,"halfEarly":1728,"halfLate":540,"luckEv":166},"noCrypto":{"label":"without Bitcoin","ids":9,"pass":0.431,"fail":0.287,"ev":3597,"halfEdgeEv":1383,"halfEarly":2233,"halfLate":481,"luckEv":471},"indexOnly":{"label":"stock indexes only","ids":8,"pass":0.468,"fail":0.227,"ev":4140,"halfEdgeEv":1537,"halfEarly":2233,"halfLate":797,"luckEv":462},"usOnly":{"label":"without the DAX and FTSE","ids":8,"pass":0.405,"fail":0.245,"ev":2935,"halfEdgeEv":623,"halfEarly":1029,"halfLate":191,"luckEv":-103},"noDipBuying":{"label":"without RSI(2) and IBS","ids":7,"pass":0.407,"fail":0.222,"ev":2854,"halfEdgeEv":1266,"halfEarly":1987,"halfLate":501,"luckEv":455},"noTomRutNoUsdjpy":{"label":"without turn of the month on RUT and Turtle USD/JPY","ids":8,"pass":0.532,"fail":0.207,"ev":5717,"halfEdgeEv":2505,"halfEarly":2928,"halfLate":2055,"luckEv":667},"calendarOnly":{"label":"calendar rules only (month-end, turn of the month)","ids":5,"pass":0.35,"fail":0.181,"ev":2288,"halfEdgeEv":938,"halfEarly":1987,"halfLate":-176,"luckEv":272}}},"ablation":{"ftmo_2step_100k":{"0.003":{"plain":{"pass":0.222,"fail":0.778},"capOnly":{"pass":0.331,"fail":0.614},"stopOnly":{"pass":0.409,"fail":0.419},"both":{"pass":0.364,"fail":0.283}},"0.004":{"plain":{"pass":0.166,"fail":0.834},"capOnly":{"pass":0.218,"fail":0.772},"stopOnly":{"pass":0.391,"fail":0.557},"both":{"pass":0.382,"fail":0.469}},"0.005":{"plain":{"pass":0.143,"fail":0.857},"capOnly":{"pass":0.136,"fail":0.864},"stopOnly":{"pass":0.364,"fail":0.623},"both":{"pass":0.374,"fail":0.563}}},"ftmo_1step_100k":{"0.003":{"plain":{"pass":0.156,"fail":0.844},"capOnly":{"pass":0.142,"fail":0.858},"stopOnly":{"pass":0.468,"fail":0.485},"both":{"pass":0.452,"fail":0.379}},"0.004":{"plain":{"pass":0.124,"fail":0.876},"capOnly":{"pass":0.156,"fail":0.844},"stopOnly":{"pass":0.474,"fail":0.517},"both":{"pass":0.526,"fail":0.453}},"0.005":{"plain":{"pass":0.118,"fail":0.882},"capOnly":{"pass":0.132,"fail":0.868},"stopOnly":{"pass":0.427,"fail":0.573},"both":{"pass":0.468,"fail":0.513}}}},"walkforward":{"ftmo_2step_100k":[{"split":2008,"configs":144,"rank":37,"pick":{"cap":3,"share":0.3,"risk":0.004,"trainPass":0.452,"testPass":0.364,"testFail":0.554,"testLuck":0.08},"plainSameRiskTestPass":0.164,"plainSameRiskTestFail":0.836,"app":{"testPass":0.405,"testFail":0.318,"testLuck":0.037}},{"split":2015,"configs":144,"rank":14,"pick":{"cap":3,"share":0.6,"risk":0.002,"trainPass":0.41,"testPass":0.413,"testFail":0.368,"testLuck":0.025},"plainSameRiskTestPass":0.301,"plainSameRiskTestFail":0.699,"app":{"testPass":0.443,"testFail":0.402,"testLuck":0.06}}],"ftmo_1step_100k":[{"split":2008,"configs":144,"rank":27,"pick":{"cap":null,"share":0.3,"risk":0.002,"trainPass":0.481,"testPass":0.348,"testFail":0.393,"testLuck":0.055},"plainSameRiskTestPass":0.193,"plainSameRiskTestFail":0.807,"app":{"testPass":0.393,"testFail":0.456,"testLuck":0.119}},{"split":2015,"configs":144,"rank":38,"pick":{"cap":null,"share":0.3,"risk":0.002,"trainPass":0.47,"testPass":0.291,"testFail":0.451,"testLuck":0.025},"plainSameRiskTestPass":0.217,"plainSameRiskTestFail":0.783,"app":{"testPass":0.373,"testFail":0.51,"testLuck":0.12}}]}}};
}, {}],
"core/research-r19.json": [function (module, exports, require) {
module.exports = {"round":19,"generated":"2026-11-24","strategies":[{"id":"tlt_month_end|TLT|1d","strategy":"tlt_month_end","name":"Treasury Month-End","symbols":["TLT"],"marketLabel":"Long Treasuries (TLT)","tf":"1d","from":2002,"to":2026,"trades":281,"netBp":25.2,"tStat":2.71,"sharpe":0.52,"pctYearsPositive":68,"verdict":"holds","published":{"netBp":37.6,"tStat":4.04,"trades":291,"since2020":{"trades":82,"netBp":26.8,"tStat":1.36,"winRate":51,"yearsUp":71}},"check":{"status":"passed","round":19,"etf":{"symbol":"TLT","from":2002},"since2010":{"trades":195,"netBp":28,"tStat":2.57,"winRate":61,"yearsUp":71},"cost2x":{"trades":281,"netBp":21.2,"tStat":2.28,"winRate":60,"yearsUp":68},"since2023":{"trades":45,"netBp":12.9,"tStat":0.57,"winRate":51,"yearsUp":50},"sameExitDay":267,"researchTrades":291}}]};
}, {}],
"core/lesson.js": [function (module, exports, require) {
'use strict';
// "Walk me through it": turns a trade idea into a short lesson. Each step has plain-language text
// with the real numbers, and says what to show on the chart: where to zoom, lines (averages,
// bands), price levels, shaded zones, highlighted bars, notes and an optional gauge. The renderer
// (renderer/js/lesson.js) plays the steps over the price chart.
//
// Times are bar open times in UTC seconds. A future point is { t: <last closed bar>, plus: bars }.

const { noiseBands, calendar } = require('./strategies');
const { etParts } = require('./time');

const COL = { trend: '#b197ff', fast: '#3987e5', slow: '#d95926', band: '#f2b84b', vwap: '#d55181', up: '#1fae7e', down: '#e5534b', entry: '#c9d2ff', info: '#7cc4ff', zone: 'rgba(242,184,75,0.10)', red: 'rgba(229,83,75,0.14)', green: 'rgba(31,174,126,0.14)', blue: 'rgba(124,196,255,0.10)' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function build(o) {
  const { c, strat, cand, inst, tf, symbol, sizing, profile, equity, bt, research, htf } = o;
  const entry = o.entry; const stop = o.stop; const target = o.target;
  const n = c.bars.length; const i = Math.min(cand.signalIndex, n - 1); const b = c.bars[i];
  const dir = cand.dir; const long = dir > 0; const pending = !!cand.pending;
  const daily = tf === '1d';
  const P = (v) => (v == null || !isFinite(v) ? '-' : Number(v).toFixed(inst.decimals));
  const pct = (x, d) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + '%';
  const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
  const tAt = (k) => c.bars[Math.max(0, Math.min(n - 1, k))].time;
  const last = c.bars[n - 1].time;
  const fut = (k) => ({ t: last, plus: k });
  const when = (t) => {
    if (daily) { const p = etParts(t + 6 * 3600); return MON[p.month - 1] + ' ' + p.day; }
    return new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const clock = (t) => new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const pts = (arr, k0, k1) => { const out = []; for (let k = Math.max(0, k0); k <= Math.min(n - 1, k1); k++) if (arr[k] != null && isFinite(arr[k])) out.push([c.bars[k].time, +arr[k]]); return out; };
  const view = (k0, k1, ahead) => ({ from: tAt(k0), to: tAt(k1), ahead: ahead || 0 });
  const buySell = long ? 'buy' : 'sell short';
  const Buy = long ? 'Buy' : 'Sell short';
  const atr = c.atr14[i];
  const steps = [];
  // checks: the rule's conditions with today's values; step = the lesson step that shows each one
  const checks = [];
  const chk = (label, value, ok) => checks.push({ label, value, ok, step: steps.length - 1 });
  const unitWord = (inst.unit || 'units');

  // ---------- intro ----------
  steps.push({
    title: 'What this trade is',
    text: '**' + strat.name + '** is a ' + strat.style.replace(/\s*\(.*\)\s*/, '').toLowerCase() + ' strategy. ' + strat.summary + '\n\nThe app checked every strategy that fits ' + symbol + ' on the ' + tf + ' chart, and this one ' +
      (pending ? 'is closest to a signal right now.' : 'has a signal right now.') + ' The next steps show exactly what it saw on the chart, then where to get in and out, how big to trade, and how it did before.',
    view: view(n - 90, n - 1, 6),
  });

  // ---------- the setup, per strategy ----------
  const sid = strat.id;
  if (sid === 'rsi2') {
    const k0 = Math.max(0, i - 230);
    const above = b.close / c.sma200[i] - 1;
    steps.push({
      title: 'Is the long-term trend up?',
      text: 'This rule only buys dips when the market is in a long-term uptrend. The purple line is the **200-bar average**: the average close of the last 200 bars, now ' + P(c.sma200[i]) + '.\n\nThe last close, ' + P(b.close) + ', is **' + pct(above) + '** ' + (above >= 0 ? 'above' : 'below') + ' it, so the uptrend filter is ' + (above >= 0 ? 'on.' : 'off.'),
      view: view(k0, i, 4),
      lines: [{ label: '200-bar average', color: COL.trend, points: pts(c.sma200, k0, n - 1), width: 2 }],
      bars: [{ t: b.time, label: 'Last close ' + P(b.close), color: COL.trend }],
    });
    chk('Close above the 200-bar average', pct(above), above > 0);
    let k = i; while (k > 0 && i - k < 6 && c.bars[k].close < c.bars[k - 1].close) k--;
    const downs = i - k; const from = c.bars[k].close; const drop = b.close / from - 1;
    let lo = Infinity; let hi = -Infinity; for (let j = k; j <= i; j++) { lo = Math.min(lo, c.bars[j].low); hi = Math.max(hi, c.bars[j].high); }
    steps.push({
      title: 'A sharp short-term dip',
      text: '**RSI(2)** compares the last 2 bars\' gains with their losses on a 0 to 100 scale. A low reading means the last couple of bars fell hard.\n\nAfter ' + (downs ? downs + ' down close' + (downs > 1 ? 's' : '') + ' in a row (' + pct(drop) + ')' : 'the latest bars') + ', RSI(2) is **' + c.rsi2[i].toFixed(1) + '**. The rule buys under 10: a quick, sharp drop inside an uptrend, the kind that has often bounced back within days.',
      view: view(i - 28, i, 4),
      zones: downs ? [{ x0: tAt(k), x1: b.time, top: hi, bottom: lo, fill: COL.red, below: true, label: pct(drop) + ' in ' + downs + ' bar' + (downs > 1 ? 's' : '') }] : [],
      bars: [{ t: b.time, label: 'RSI(2) ' + c.rsi2[i].toFixed(1), color: COL.down }],
      gauge: { label: 'RSI(2)', value: c.rsi2[i], min: 0, max: 100, threshold: 10, rule: 'below', text: c.rsi2[i].toFixed(1) + ' (buys under 10)' },
    });
    chk('RSI(2) under 10', c.rsi2[i].toFixed(1), c.rsi2[i] < 10);
  } else if (sid === 'ibs') {
    const r = b.high - b.low; const ibs = r > 0 ? (b.close - b.low) / r : 0.5;
    steps.push({
      title: 'Where did the day close in its range?',
      text: '**Internal bar strength (IBS)** says where a bar closed within its own range: 0% at the low, 100% at the high.\n\nThe ' + when(b.time) + ' bar went from ' + P(b.low) + ' to ' + P(b.high) + ' and closed at ' + P(b.close) + ', so IBS = (' + P(b.close) + ' − ' + P(b.low) + ') ÷ (' + P(b.high) + ' − ' + P(b.low) + ') = **' + Math.round(ibs * 100) + '%**. Under 20% means it closed near the low of the day.',
      view: view(i - 22, i, 4),
      zones: [{ x0: b.time, x1: b.time, top: b.high, bottom: b.low, fill: 'rgba(124,196,255,0.16)' }],
      levels: [{ price: b.high, label: 'High ' + P(b.high), color: COL.info, dash: true }, { price: b.low, label: 'Low ' + P(b.low), color: COL.info, dash: true }, { price: b.close, label: 'Close ' + P(b.close), color: COL.down }],
      bars: [{ t: b.time, label: 'IBS ' + Math.round(ibs * 100) + '%', color: COL.down }],
      gauge: { label: 'IBS', value: ibs * 100, min: 0, max: 100, threshold: 20, rule: 'below', text: Math.round(ibs * 100) + '% (buys under 20%)' },
    });
    chk('Closed in the bottom 20% of its range', Math.round(ibs * 100) + '%', ibs < 0.2);
    steps.push({
      title: 'Why a weak close can bounce',
      text: 'When a stock index closes at the bottom of its day, a lot of the selling has often already happened. Since about 1999, index days like this have tended to recover over the next day or two.\n\nThe dots mark the last times this rule fired on this chart, with how each trade ended. It is a small edge per trade, so it only pays over many trades.',
      view: view(i - 70, i, 4),
      marks: (bt.trades || []).filter((t) => t.entryTime >= tAt(i - 70)).slice(-6).map((t) => ({ t: t.entryTime, price: t.entry, text: (t.R >= 0 ? '+' : '') + t.R.toFixed(1) + 'R', color: t.R >= 0 ? COL.up : COL.down })),
    });
  } else if (sid === 'tlt_month_end') {
    const { monthOf, nextWeekday } = calendar;
    const vl = []; for (let k = Math.max(1, i - 50); k <= i; k++) if (monthOf(c.bars[k].time) !== monthOf(c.bars[k - 1].time)) vl.push({ t: c.bars[k].time, label: MON[(monthOf(c.bars[k].time) - 1) % 12] });
    const past = (bt.trades || []).filter((t) => t.entryTime >= tAt(i - 50)).slice(-4).map((t) => ({ x0: t.entryTime, x1: t.exitTime, top: Math.max(t.entry, t.exit), bottom: Math.min(t.entry, t.exit), fill: t.R >= 0 ? COL.green : COL.red, label: pct((t.exit / t.entry - 1) * t.dir) }));
    let x = b.time; const ends = []; while (ends.length < 8) { x = nextWeekday(x); ends.push(x); if (monthOf(nextWeekday(x)) !== monthOf(x)) break; }
    steps.push({
      title: 'Why bonds rise into month-end',
      text: 'Bond index funds must hold what their index holds. At each month-end the index adds the bonds the Treasury issued during the month, which are often longer than the ones it drops, so the funds **buy long bonds** in the last days of the month.\n\nHartley and Schwarz (2019) found long Treasuries have tended to rise over those days. TLT holds Treasuries with 20 or more years left, the bonds this buying affects most.',
      view: view(i - 48, i, ends.length + 2),
      vlines: vl,
      zones: past,
    });
    steps.push({
      title: 'The last 5 trading days',
      text: 'The rule only looks at the calendar: it buys when **5 trading days of the month are left** and sells at the **last close of the month**. The shaded boxes are the last few month-ends on this chart and how each went; the dashed box ahead is this one (to about ' + when(ends[ends.length - 1]) + ').',
      view: view(i - 48, i, ends.length + 2),
      vlines: vl,
      zones: past.concat([{ x0: fut(1), x1: fut(ends.length), top: b.close + 1.5 * atr, bottom: b.close - 1.5 * atr, fill: COL.zone, dashed: true, label: 'This month-end' }]),
    });
    chk('5 trading days of the month left', ends.length + ' left', true);
  } else if (sid === 'turn_of_month' || sid === 'month_end_rebal') {
    const { monthOf, nextWeekday, bizDaysLeftAfter } = calendar;
    const vl = []; for (let k = Math.max(1, i - 50); k <= i; k++) if (monthOf(c.bars[k].time) !== monthOf(c.bars[k - 1].time)) vl.push({ t: c.bars[k].time, label: MON[(monthOf(c.bars[k].time) - 1) % 12] });
    const past = (bt.trades || []).filter((t) => t.entryTime >= tAt(i - 50)).slice(-4).map((t) => ({ x0: t.entryTime, x1: t.exitTime, top: Math.max(t.entry, t.exit), bottom: Math.min(t.entry, t.exit), fill: t.R >= 0 ? COL.green : COL.red, label: pct((t.exit / t.entry - 1) * t.dir) }));
    if (sid === 'turn_of_month') {
      // window: next trading day (last of the month) to the 3rd trading day of the new month
      let x = b.time; const days = []; for (let k = 0; k < 4; k++) { x = nextWeekday(x); days.push(x); }
      steps.push({
        title: 'The calendar window',
        text: 'This rule only looks at the calendar. It buys at the open of the **last trading day of the month** (' + when(days[0]) + ') and sells at the close of the **3rd trading day of the next month** (about ' + when(days[3]) + ').\n\nAround these days, paychecks, pension contributions and fund rebalancing put new money into stocks. The shaded boxes are the last few windows on this chart and how each one went; the dashed box ahead is the next one.',
        view: view(i - 48, i, 7),
        vlines: vl,
        zones: past.concat([{ x0: fut(1), x1: fut(4), top: b.close + 1.5 * atr, bottom: b.close - 1.5 * atr, fill: COL.zone, dashed: true, label: 'Next window' }]),
      });
      chk('Next trading day is the last of the month', when(days[0]), true);
    } else {
      let m0 = i; while (m0 > 0 && monthOf(c.bars[m0 - 1].time) === monthOf(b.time)) m0--;
      const base = m0 > 0 ? m0 - 1 : m0;
      const rs = b.close / c.bars[base].close - 1;
      let rb = null;
      if (c.bond) { const ymd = (t) => { const p = etParts(t); return p.year * 10000 + p.month * 100 + p.day; }; const bv = (k) => { for (let j = k; j >= 0; j--) { const v = c.bond.get(ymd(c.bars[j].time)); if (v != null) return v; } return NaN; }; rb = bv(i) / bv(base) - 1; }
      steps.push({
        title: 'Stocks against bonds this month',
        text: 'Big funds hold a fixed mix of stocks and bonds, and many top it back up to that mix near month-end. If stocks beat bonds during the month, they must **sell stocks**; if stocks lagged, they must **buy**.\n\nSince the last close of last month (' + P(c.bars[base].close) + '), ' + symbol + ' is **' + pct(rs) + '**' + (rb != null && isFinite(rb) ? ' and long-term Treasury bonds (TLT) are **' + pct(rb) + '**' : '') + '. Stocks are ' + (long ? 'behind' : 'ahead') + ', so the rule expects ' + (long ? 'buying' : 'selling') + ' in the last 5 trading days and ' + (long ? 'buys' : 'sells short') + '.',
        view: view(base - 3, i, 6),
        levels: [{ price: c.bars[base].close, label: 'Start of month ' + P(c.bars[base].close), color: COL.info, dash: true }],
        zones: [{ x0: tAt(base), x1: b.time, top: Math.max(b.close, c.bars[base].close), bottom: Math.min(b.close, c.bars[base].close), fill: rs >= 0 ? COL.green : COL.red, label: 'Stocks ' + pct(rs) }],
        vlines: vl,
      });
      chk(long ? 'Stocks behind bonds this month' : 'Stocks ahead of bonds this month', 'stocks ' + pct(rs) + (rb != null && isFinite(rb) ? ', bonds ' + pct(rb) : ''), true);
      let x = b.time; let k = 0; const ends = []; while (k < 8) { x = nextWeekday(x); ends.push(x); k++; if (monthOf(nextWeekday(x)) !== monthOf(x)) break; }
      steps.push({
        title: 'The last 5 trading days',
        text: 'The trade only lives in the last 5 trading days of the month, when that rebalancing happens. The shaded boxes are the last few month-ends on this chart and how each went; the dashed box ahead is this one, ending at the last close of the month (about ' + when(ends[ends.length - 1]) + ').',
        view: view(i - 48, i, ends.length + 2),
        vlines: vl,
        zones: past.concat([{ x0: fut(1), x1: fut(ends.length), top: b.close + 1.5 * atr, bottom: b.close - 1.5 * atr, fill: COL.zone, dashed: true, label: 'This month-end' }]),
      });
      chk('Inside the last 5 trading days of the month', ends.length + ' left', true);
    }
  } else if (sid === 'turtle' || sid === 'donchian55') {
    const N = sid === 'turtle' ? 20 : 55; const X = sid === 'turtle' ? 10 : 20;
    const k0 = pending ? i - N + 1 : i - N; const k1 = pending ? i : i - 1;
    let hi = -Infinity; let lo = Infinity; for (let j = Math.max(0, k0); j <= k1; j++) { hi = Math.max(hi, c.bars[j].high); lo = Math.min(lo, c.bars[j].low); }
    steps.push({
      title: 'The ' + N + '-bar range',
      text: 'Over the ' + (pending ? 'last' : 'previous') + ' ' + N + ' bars, price stayed between **' + P(lo) + '** and **' + P(hi) + '** (the shaded box). Trend followers wait for price to leave a range like this, because every big trend starts with a break out of one.' +
        (inst.market === 'crypto' ? '\n\nOn crypto the research only supports the long side, so only upside breaks count.' : ''),
      view: view(i - N - 12, i, 5),
      zones: [{ x0: tAt(k0), x1: tAt(k1), top: hi, bottom: lo, fill: COL.zone, label: N + '-bar range' }],
      levels: [{ price: hi, label: N + '-bar high ' + P(hi), color: COL.band, dash: true }, { price: lo, label: N + '-bar low ' + P(lo), color: COL.band, dash: true }],
    });
    steps.push(pending ? {
      title: 'Waiting for the break',
      text: 'No breakout yet. The last close was ' + P(b.close) + '. A close ' + (long ? 'above ' + P(hi) : 'below ' + P(lo)) + ' would start a new ' + (long ? 'long' : 'short') + ', so the plan is a ' + (long ? 'buy' : 'sell') + ' stop order just past it at **' + P(entry) + '**. If price never gets there, there is no trade and nothing is lost.',
      view: view(i - 25, i, 6),
      levels: [{ price: entry, label: 'Order ' + P(entry), color: COL.entry }],
      bars: [{ t: b.time, label: 'Last close ' + P(b.close), color: COL.info }],
    } : {
      title: 'The breakout',
      text: 'The ' + when(b.time) + ' bar closed at **' + P(b.close) + '**, ' + (long ? 'above the ' + N + '-bar high of ' + P(hi) : 'below the ' + N + '-bar low of ' + P(lo)) + '. That is the signal: price has left its range, and the rule joins the move.',
      view: view(i - 25, i, 6),
      levels: [{ price: long ? hi : lo, label: (long ? 'Old high ' : 'Old low ') + P(long ? hi : lo), color: COL.band, dash: true }],
      bars: [{ t: b.time, label: 'Breakout close ' + P(b.close), color: long ? COL.up : COL.down }],
    });
    chk('Close ' + (long ? 'above the ' + N + '-bar high' : 'below the ' + N + '-bar low'), pending ? 'not yet, last ' + P(b.close) : P(b.close), pending ? null : true);
    o.trailN = X;
  } else if (sid === 'trend_pullback') {
    const k0 = i - 90;
    steps.push({
      title: 'Is there a trend?',
      text: 'An **EMA** is an average of recent closes that counts the newest ones most. The blue line is the 20-bar EMA (' + P(c.ema20[i]) + ') and the orange one the 50-bar EMA (' + P(c.ema50[i]) + ').\n\n' + (long ? 'The 20 is above the 50 and the 50 is rising: an uptrend.' : 'The 20 is below the 50 and the 50 is falling: a downtrend.'),
      view: view(k0, i, 5),
      lines: [{ label: '20 EMA', color: COL.fast, points: pts(c.ema20, k0, n - 1), width: 2 }, { label: '50 EMA', color: COL.slow, points: pts(c.ema50, k0, n - 1), width: 2 }],
    });
    chk(long ? '20 EMA above a rising 50 EMA' : '20 EMA below a falling 50 EMA', P(c.ema20[i]) + ' vs ' + P(c.ema50[i]), true);
    steps.push(pending ? {
      title: 'Waiting for a pullback',
      text: 'In a trend, prices tend to breathe back to the 20 EMA before moving on. The plan is a ' + (long ? 'buy' : 'sell') + ' limit order at the 20 EMA, **' + P(entry) + '**: it only fills if price ' + (long ? 'dips' : 'rallies') + ' back to it.',
      view: view(i - 35, i, 6),
      lines: [{ label: '20 EMA', color: COL.fast, points: pts(c.ema20, i - 35, n - 1), width: 2 }],
      levels: [{ price: entry, label: 'Limit ' + P(entry), color: COL.entry }],
    } : {
      title: 'The pullback bar',
      text: 'The ' + when(b.time) + ' bar ' + (long ? 'dipped to' : 'rallied to') + ' the 20 EMA (' + P(c.ema20[i]) + ') and closed back on the trend side at ' + P(b.close) + ', a ' + (long ? 'green' : 'red') + ' bar, with RSI(14) at ' + c.rsi14[i].toFixed(0) + ' (not stretched). ' + (long ? 'Buyers' : 'Sellers') + ' stepped in at the average.',
      view: view(i - 35, i, 6),
      lines: [{ label: '20 EMA', color: COL.fast, points: pts(c.ema20, i - 35, n - 1), width: 2 }],
      bars: [{ t: b.time, label: 'Pullback bar', color: long ? COL.up : COL.down }],
    });
    chk(pending ? 'Price back at the 20 EMA' : 'Bounced off the 20 EMA', pending ? 'waiting, order at ' + P(entry) : 'RSI(14) ' + c.rsi14[i].toFixed(0), pending ? null : true);
  } else if (sid === 'noise_momentum') {
    const nb = noiseBands(c); let s0 = i; while (s0 > 0 && c.keys[s0 - 1] === c.keys[i]) s0--;
    steps.push({
      title: 'Today\'s noise band',
      text: 'Every half hour this rule asks: has price moved further from today\'s open than it normally does by this time of day? The yellow lines are that **normal range**, from the average move at each time of day over the last 14 days. Inside them is just noise.\n\nThe pink line is **VWAP**, the average price paid today.',
      view: view(s0 - 3, i, 6),
      lines: [{ label: 'Upper band', color: COL.band, points: pts(nb.upper, s0, i), width: 2 }, { label: 'Lower band', color: COL.band, points: pts(nb.lower, s0, i), width: 2 }, { label: 'VWAP', color: COL.vwap, points: pts(c.vwap, s0, i), width: 1 }],
    });
    steps.push(pending ? {
      title: 'Inside the band for now',
      text: 'Price is still inside the band. A close ' + (long ? 'above ' : 'below ') + P(entry) + ' at the next :00 or :30 check would trigger a ' + (long ? 'long' : 'short') + '.',
      view: view(s0 - 3, i, 6),
      levels: [{ price: entry, label: 'Trigger ' + P(entry), color: COL.entry }],
    } : {
      title: 'The break out of the noise',
      text: 'At the ' + clock(b.time + 300) + ' check, price closed at **' + P(b.close) + '**, ' + (long ? 'above the upper band (' + P(nb.upper[i]) + ')' : 'below the lower band (' + P(nb.lower[i]) + ')') + '. That is a sign of real ' + (long ? 'buying' : 'selling') + ' pressure rather than random chop.',
      view: view(s0 - 3, i, 6),
      bars: [{ t: b.time, label: 'Signal ' + P(b.close), color: long ? COL.up : COL.down }],
      lines: [{ label: long ? 'Upper band' : 'Lower band', color: COL.band, points: pts(long ? nb.upper : nb.lower, s0, i), width: 2 }],
    });
    chk('Close outside the noise band', pending ? 'not yet, trigger ' + P(entry) : P(b.close), pending ? null : true);
  } else if (sid === 'orb') {
    steps.push({
      title: 'The opening candle',
      text: 'The first 5-minute candle of the day went from ' + P(b.open) + ' to ' + P(b.close) + ', a **' + (long ? 'green' : 'red') + '** candle. The idea: the opening burst shows which side is in a hurry today, so the rule trades ' + (long ? 'long' : 'short') + ' from the second candle.',
      view: view(i - 8, i, 14),
      zones: [{ x0: b.time, x1: b.time, top: b.high, bottom: b.low, fill: long ? COL.green : COL.red }],
      bars: [{ t: b.time, label: 'First candle', color: long ? COL.up : COL.down }],
    });
    chk('First 5-minute candle ' + (long ? 'green' : 'red'), P(b.open) + ' to ' + P(b.close), true);
  } else if (sid === 'last_half_hour') {
    let s0 = i; while (s0 > 0 && c.keys[s0 - 1] === c.keys[i]) s0--;
    let k10 = s0; for (let k = s0; k <= i; k++) if (etParts(c.bars[k].time + 300).minutes === 600) { k10 = k; break; }
    const pc = s0 > 0 ? c.bars[s0 - 1].close : b.open; const mv = c.bars[k10].close / pc - 1;
    steps.push({
      title: 'The morning move',
      text: 'From yesterday\'s close (' + P(pc) + ') to 10:00 ET, ' + symbol + ' moved **' + pct(mv, 2) + '**. Research on SPY found the last half hour of the day tends to move the same way, partly because big traders finish the day\'s orders and some funds rebalance at the close.',
      view: view(s0 - 4, i, 8),
      levels: [{ price: pc, label: 'Yesterday\'s close ' + P(pc), color: COL.info, dash: true }],
      zones: [{ x0: tAt(s0), x1: tAt(k10), top: Math.max(pc, c.bars[k10].close), bottom: Math.min(pc, c.bars[k10].close), fill: mv >= 0 ? COL.green : COL.red, label: 'Morning ' + pct(mv, 2) }],
      bars: [{ t: b.time, label: '3:30 PM ET entry', color: COL.info }],
    });
    chk('Morning move ' + (long ? 'up' : 'down'), pct(mv, 2), true);
  }

  const stepOf = {};
  // ---------- entry ----------
  stepOf.entry = steps.length;
  const nearView = view(i - 30, i, 12);
  // the triple check re-ran the daily dip rules with entry at the signal day's close
  const closeTip = !pending && tf === '1d' && (sid === 'rsi2' || sid === 'ibs') && research && research.check
    ? (research.check === 'condition'
      ? '\n\n**Timing matters here.** On this market the rule only passed our triple check when buying at the close of the signal day, with a market-on-close order placed a few minutes before 4 PM ET. Waiting for the next open gave up about half the edge.'
      : '\n\n**Tip:** in our triple check, buying at the close of the signal day (a market-on-close order a few minutes before 4 PM ET) did about as well as the next open, or better. If you see the signal forming near the close, you can get in then.')
    : '';
  steps.push({
    title: 'Getting in',
    text: pending
      ? (cand.entryType === 'limit'
        ? 'Place a ' + (long ? 'buy' : 'sell') + ' **limit** order at **' + P(entry) + '**. A limit order only fills at that price or better, so you only get in if price comes back to it.'
        : 'Place a ' + (long ? 'buy' : 'sell') + ' **stop** order at **' + P(entry) + '**. A stop order waits and turns into a market order once price reaches it, so you only get in if the breakout happens.')
      : Buy + ' at about **' + P(entry) + '**, the current price. The rule decides on a closed bar (the ' + when(b.time) + ' bar), and the backtest gets in at the next bar\'s open, so getting in now is the closest match.' +
        (o.marketClosed ? ' The market is closed right now, so a market order fills when it opens.' : '') + closeTip,
    view: nearView,
    levels: [{ price: entry, label: (pending ? 'Order ' : 'Entry ') + P(entry), color: COL.entry }],
    marks: [{ t: last, price: entry, text: pending ? 'Order here' : Buy + ' here', color: long ? COL.up : COL.down, ahead: 2 }],
  });

  // ---------- stop ----------
  const dist = Math.abs(entry - stop); const distPct = dist / entry;
  let why;
  if (['rsi2', 'ibs', 'turn_of_month', 'month_end_rebal', 'tlt_month_end', 'last_half_hour'].includes(sid)) {
    why = 'It sits about **3 ATR** away. ATR(14) is the average bar range over the last 14 bars (' + P(atr) + ' here), so a 3-ATR move against you is rare and crash-like. This stop is a safety net: the trade normally ends through its exit rule, not here.';
  } else if (sid === 'turtle' || sid === 'donchian55') {
    why = 'This is the Turtles\' **2N** stop. N is the 20-bar ATR, the average bar range (' + P(c.atr20[i]) + ' here). Two of those gives the trade room for normal wiggles, so only a real reversal stops it out.';
  } else if (sid === 'orb') {
    why = 'It sits at the other end of the opening candle. If price goes back through the whole first candle, the opening move has failed and there is no reason to stay.';
  } else if (sid === 'noise_momentum') {
    why = 'It sits at the noise band or VWAP, whichever is closer, and it follows price as the day goes on. If price falls back into the noise, the move is over.';
  } else {
    why = 'It sits ' + (dist / (atr || dist)).toFixed(1) + ' ATR away, from your ' + profile.name + ' profile. ATR(14), the average bar range, is ' + P(atr) + '.';
  }
  const zoneEnd = fut(12);
  stepOf.stop = steps.length;
  steps.push({
    title: 'Where it is wrong: the stop',
    text: 'The stop is at **' + P(stop) + '**, ' + P(dist) + ' (' + (distPct * 100).toFixed(2) + '%) ' + (long ? 'below' : 'above') + ' the entry. ' + why,
    view: nearView,
    levels: [{ price: entry, label: 'Entry ' + P(entry), color: COL.entry }, { price: stop, label: 'Stop ' + P(stop), color: COL.down, dash: true }],
    zones: [{ x0: fut(0), x1: zoneEnd, top: Math.max(entry, stop), bottom: Math.min(entry, stop), fill: COL.red, label: 'Risk' }],
  });

  // ---------- exit ----------
  let exitStep;
  const lb = c.bars[n - 1];
  const zonesRT = [{ x0: fut(0), x1: zoneEnd, top: Math.max(entry, stop), bottom: Math.min(entry, stop), fill: COL.red }];
  if (target != null) zonesRT.push({ x0: fut(0), x1: zoneEnd, top: Math.max(entry, target), bottom: Math.min(entry, target), fill: COL.green, label: 'Target' });
  if (sid === 'rsi2') {
    const gap = c.sma5[n - 1] - lb.close;
    exitStep = { text: 'Sell at the **first close above the 5-bar average** (the blue line, now ' + P(c.sma5[n - 1]) + (gap > 0 ? ', ' + P(gap) + ' above the last close' : '') + '). That usually comes within a few days, once the dip bounces. There is no fixed target: the bounce itself is the target.', lines: [{ label: '5-bar average', color: COL.info, points: pts(c.sma5, i - 30, n - 1), width: 2 }] };
  } else if (sid === 'ibs') {
    exitStep = { text: 'Sell at the **first close above the previous day\'s high**. For the next day that means a close above ' + P(lb.high) + ', the high of the last finished day (' + when(lb.time) + '). If that has not happened after 5 days, sell anyway.', levels: [{ price: lb.high, label: 'Last day\'s high ' + P(lb.high), color: COL.up, dash: true }] };
  } else if (sid === 'turn_of_month') {
    exitStep = { text: 'Sell at the **close of the 3rd trading day of the new month**, whatever the price. No target: the trade is about the calendar window, not a price level.' };
  } else if (sid === 'tlt_month_end') {
    exitStep = { text: 'Sell at the **last close of the month**, whatever the price. The funds\' buying is done once the month turns.' };
  } else if (sid === 'month_end_rebal') {
    exitStep = { text: 'Close the trade at the **last close of the month**, whatever the price. Once the month turns, the rebalancing flow is over.' };
  } else if (sid === 'turtle' || sid === 'donchian55') {
    const X = o.trailN || 10; let lo = Infinity; let hi = -Infinity; for (let j = Math.max(0, n - X); j <= n - 1; j++) { lo = Math.min(lo, c.bars[j].low); hi = Math.max(hi, c.bars[j].high); }
    const tr = long ? lo : hi; const tighter = long ? tr > stop : tr < stop;
    exitStep = { text: 'There is no target. The stop **trails**: after every bar it moves ' + (long ? 'up to the lowest low' : 'down to the highest high') + ' of the last ' + X + ' bars if that is ' + (long ? 'higher' : 'lower') + ', and it never moves back. ' +
      (tighter ? 'Right now that level is ' + P(tr) + ', so the stop would already move there.' : 'Right now that level is ' + P(tr) + ', still ' + (long ? 'below' : 'above') + ' the 2N stop, so the 2N stop counts for now.') +
      ' As a trend goes on, the stop follows it and locks in profit. Most Turtle trades are small losses; a few long trends pay for them, so let the winners run.', levels: tighter ? [{ price: tr, label: X + '-bar ' + (long ? 'low ' : 'high ') + P(tr), color: COL.band, dash: true }] : [] };
  } else if (sid === 'noise_momentum') {
    exitStep = { text: 'The stop **trails** at the noise band or VWAP every bar, and the trade is closed by the end of the day (3:00 PM CT) at the latest. No overnight risk.' };
  } else if (sid === 'orb') {
    exitStep = { text: 'The target is **10 times the risk** (' + P(target) + '), which is rarely reached. Most days the trade is simply closed at the end of the day (3:00 PM CT).' };
  } else if (sid === 'last_half_hour') {
    exitStep = { text: 'Close the trade at the **end of the day** (3:00 PM CT). It only holds for the last half hour.' };
  } else {
    exitStep = { text: target != null ? 'Take profit at **' + P(target) + '**, ' + (o.rr || 2) + ' times the distance to the stop. If the stop is hit first, the loss is 1 unit of risk; if the target is hit, the gain is ' + (o.rr || 2) + '.' : 'Exit by the strategy\'s rule.' };
  }
  stepOf.exit = steps.length;
  steps.push(Object.assign({ title: 'Getting out', view: nearView, zones: zonesRT, levels: [{ price: entry, label: 'Entry ' + P(entry), color: COL.entry }, { price: stop, label: 'Stop ' + P(stop), color: COL.down, dash: true }].concat(target != null ? [{ price: target, label: 'Target ' + P(target), color: COL.up, dash: true }] : []) }, exitStep, exitStep.levels ? { levels: [{ price: entry, label: 'Entry ' + P(entry), color: COL.entry }, { price: stop, label: 'Stop ' + P(stop), color: COL.down, dash: true }].concat(exitStep.levels) } : {}));

  // ---------- size ----------
  const riskUsd = sizing.riskUsd || 0;
  stepOf.size = steps.length;
  steps.push({
    title: 'How much to trade',
    text: sizing.qty
      ? 'Your **' + profile.name + '** risk profile risks ' + profile.riskPct + '% of the account per trade: about **' + usd(riskUsd) + '** of ' + usd(equity) + '. The stop is ' + P(dist) + ' away per ' + unitWord.replace(/s$/, '') + ', so the size is **' + sizing.qty + ' ' + unitWord + '** (' + usd(sizing.notional || 0) + ' of ' + symbol + ').\n\nIf the stop is hit you lose about ' + usd(riskUsd) + '. Traders call that amount **1R**: a +2R trade makes twice what was risked.' +
        (sizing.capped ? ' The size is capped by your profile\'s exposure limit, so the real risk is a bit lower.' : '') + (sizing.roundedUp ? ' One ' + unitWord.replace(/s$/, '') + ' is the smallest size, which risks a bit more than the profile wants.' : '')
      : 'This trade is too small to size with your account and risk profile' + (sizing.reason ? ': ' + sizing.reason : '.'),
    view: nearView,
    levels: [{ price: entry, label: 'Entry ' + P(entry), color: COL.entry }, { price: stop, label: 'Stop: lose ' + usd(riskUsd), color: COL.down, dash: true }].concat(target != null ? [{ price: target, label: 'Target: make ' + usd(riskUsd * (o.rr || 0)), color: COL.up, dash: true }] : []),
    zones: zonesRT,
    facts: [{ k: 'Risk', v: usd(riskUsd), tone: 'down' }, { k: 'Size', v: sizing.qty ? sizing.qty + ' ' + unitWord : '-' }, { k: 'Position value', v: usd(sizing.notional || 0) }],
  });

  // ---------- track record ----------
  const s = bt.stats || {};
  const ex = (bt.trades || []).filter((t) => t.exitTime <= last).slice(-1)[0];
  const rec = s.trades
    ? 'On this chart\'s loaded history the rule fired **' + s.trades + '** times: ' + s.winRate.toFixed(0) + '% winners, ' + (s.expectancyR >= 0 ? '+' : '') + s.expectancyR.toFixed(2) + 'R per trade on average after costs.'
    : 'There are no past signals in the loaded history, so there is no track record on this chart.';
  const rs = research ? (research.verdict === 'fails' ? ' Our long-history test found **no edge** after costs on this market: treat it as practice.' : ' Long-history test: ' + research.text) : '';
  const htfTxt = htf && htf.tf ? (htf.dir === dir ? ' The ' + htf.tf + ' trend agrees.' : htf.dir === -dir ? ' Careful: the ' + htf.tf + ' trend points the other way.' : '') : '';
  const exTxt = ex ? '\n\nThe last one (highlighted): ' + (ex.dir > 0 ? 'bought' : 'sold short') + ' on ' + when(ex.entryTime) + ' at ' + P(ex.entry) + ', closed on ' + when(ex.exitTime) + ' at ' + P(ex.exit) + ' (' + reasonText(ex.reason) + '), **' + (ex.R >= 0 ? '+' : '') + ex.R.toFixed(2) + 'R**.' : '';
  stepOf.record = steps.length;
  steps.push({
    title: 'How it has done before',
    text: rec + rs + htfTxt + exTxt + '\n\nPast results do not promise the next trade. That is why the size is small: one trade should never matter much.',
    view: ex ? exampleView(c, ex, n) : nearView,
    example: ex ? { entryTime: ex.entryTime, exitTime: ex.exitTime, entry: ex.entry, exit: ex.exit, stop: ex.stop, R: ex.R, dir: ex.dir } : null,
    facts: s.trades ? [{ k: 'Signals', v: String(s.trades) }, { k: 'Winners', v: s.winRate.toFixed(0) + '%' }, { k: 'Average', v: (s.expectancyR >= 0 ? '+' : '') + s.expectancyR.toFixed(2) + 'R', tone: s.expectancyR >= 0 ? 'up' : 'down' }] : [],
  });

  // ---------- check yourself ----------
  const quiz = quizFor(sid, { long, X: o.trailN || 10, N: sid === 'donchian55' ? 55 : 20 }).concat([{
    q: 'An account of $50,000 risks 1% per trade. The stop is $5 away per share. How many shares?',
    options: ['1,000 shares', '100 shares', '500 shares'], a: 1,
    why: '1% of $50,000 is $500 of risk. $500 ÷ $5 per share = 100 shares. If the stop is hit, the loss is $500: that is 1R.',
  }]);
  stepOf.quiz = steps.length;
  steps.push({ title: 'Check yourself', text: 'Three quick questions on this trade\'s rules. Pick an answer to see if it is right and why.', view: nearView, quiz });

  return { title: strat.name + ' on ' + symbol + ' ' + tf, side: long ? 'buy' : 'sell', steps, checks, stepOf };
}

// Two questions per strategy about its own rules (answers are spread over the positions).
function quizFor(sid, o) {
  const Q = {
    rsi2: [
      { q: 'RSI(2) reads 6, but price is below its 200-bar average. Does the rule buy?', options: ['Yes: RSI(2) is under 10', 'No: the uptrend filter is off', 'Yes, but with half the size'], a: 1, why: 'Both conditions must hold. Below the 200-bar average a sharp dip can keep falling, so the rule sits out.' },
      { q: 'You are in the trade. When do you sell?', options: ['When it reaches +2R', 'After exactly 5 days', 'At the first close above the 5-bar average'], a: 2, why: 'The bounce is the target: the first close above the 5-bar average ends the trade, usually within a few days.' },
    ],
    ibs: [
      { q: 'A day traded from 100 to 110 and closed at 101. What is its IBS?', options: ['10%', '90%', '1%'], a: 0, why: '(101 − 100) ÷ (110 − 100) = 0.1, or 10%. It closed near its low, so the rule buys (under 20%).' },
      { q: 'When does the trade end?', options: ['When IBS goes above 80%', 'At the first close above the previous day\'s high, or after 5 days', 'At a 2R target'], a: 1, why: 'A close above the prior day\'s high shows the bounce happened. If it has not after 5 days, the idea did not work and the trade ends anyway.' },
    ],
    turn_of_month: [
      { q: 'What does this rule look at to decide?', options: ['RSI and moving averages', 'The news', 'Only the calendar'], a: 2, why: 'It is a calendar rule: the same days every month, whatever the chart looks like. Month-end money flows are the reason it works.' },
      { q: 'When is the exit?', options: ['At the close of the 3rd trading day of the new month', 'At the last close of the month', 'When price is up 1%'], a: 0, why: 'The window runs from the last trading day of the month to the 3rd trading day of the next, then the trade ends whatever the price.' },
    ],
    month_end_rebal: [
      { q: 'This month stocks are up 4% and bonds up 1%. What does the rule expect in the last 5 trading days?', options: ['Funds buy stocks, so it buys', 'Funds sell stocks to rebalance, so it sells short', 'Nothing, it needs a bigger gap'], a: 1, why: 'Stocks grew past their share of a fixed stock and bond mix, so rebalancing funds sell stocks. The rule gets in their way first.' },
      { q: 'When does the trade end?', options: ['At the last close of the month', 'On the 3rd trading day of next month', 'At a 2R target'], a: 0, why: 'The rebalancing happens before the month turns, so the trade closes at the last close of the month.' },
    ],
    tlt_month_end: [
      { q: 'Who is expected to buy long bonds in the last days of the month?', options: ['Bond index funds matching their index\'s month-end changes', 'The Federal Reserve', 'Traders covering shorts'], a: 0, why: 'The index adds newly issued bonds at month-end, so funds that track it buy them then, and long Treasuries have tended to rise over those days.' },
      { q: 'When does the trade end?', options: ['After a 2R gain', 'At the last close of the month', 'On the 3rd trading day of the next month'], a: 1, why: 'The buying happens before the month turns, so the trade closes at the last close of the month, whatever the price.' },
    ],
    turtle: [
      { q: 'Most trades with this rule are...', options: ['Small wins', 'Small losses, paid for by a few long trends', 'Big wins'], a: 1, why: 'Breakouts often fail, so it usually wins under half its trades. The few that turn into long trends make several times the risk and pay for the rest.' },
      { q: 'How does the stop move after you get in?', options: ['It stays where it started', 'It moves to break-even after one bar', 'It follows the ' + o.X + '-bar ' + (o.long ? 'low' : 'high') + ' and never moves back'], a: 2, why: 'The trailing stop locks in profit as a trend goes on, and ends the trade when the trend turns.' },
    ],
    trend_pullback: [
      { q: 'What makes it an uptrend for this rule?', options: ['Price went up today', 'The 20 EMA is above a rising 50 EMA', 'RSI(14) is above 70'], a: 1, why: 'The faster average above a rising slower one means recent prices are higher than older ones and still climbing.' },
      { q: 'How did this rule do in our long-history tests?', options: ['It failed on every market tried', 'It held up on stock indexes', 'It held up on crypto'], a: 0, why: 'It is a popular chart rule, but in 27 tests it never beat costs. Treat it as practice, not an edge.' },
    ],
    noise_momentum: [
      { q: 'When is the trade closed at the latest?', options: ['The next morning', 'At the end of the day', 'After a 2R gain'], a: 1, why: 'It is an intraday rule: everything is closed by the end of the session, with no overnight risk.' },
      { q: 'What does the noise band show?', options: ['Yesterday\'s high and low', 'The usual size of moves from the open at this time of day', 'Where the 20 EMA is'], a: 1, why: 'Moves inside the band are normal noise. Only a close outside it counts as real pressure.' },
    ],
    orb: [
      { q: 'What decides the direction?', options: ['The colour of the first 5-minute candle', 'The 200-bar average', 'The news'], a: 0, why: 'A green opening candle means a long, a red one a short: the opening burst shows which side is in a hurry.' },
      { q: 'How did opening range rules do in our tests on index futures?', options: ['They held up', 'They failed: the edge was smaller than the costs', 'They were not tested'], a: 1, why: 'The edge before costs was 0 to 2 basis points a trade, less than a micro future round trip costs.' },
    ],
    last_half_hour: [
      { q: 'How long is the trade held?', options: ['About half an hour, to the close', 'Overnight', 'Until a 2R target'], a: 0, why: 'It enters at 3:30 PM ET and exits at the close.' },
      { q: 'How did it do in our tests on index futures?', options: ['It held up', 'It failed after costs', 'It was not tested'], a: 1, why: 'The move it catches was smaller than the cost of trading it.' },
    ],
  };
  Q.donchian55 = Q.turtle;
  return (Q[sid] || []).slice(0, 2);
}

function reasonText(r) {
  return { stop: 'stop hit', 'trailing stop': 'trailing stop', target: 'target hit', 'exit rule': 'exit rule', 'close of day': 'end of day', time: 'time limit' }[r] || r || 'exit';
}

function exampleView(c, ex, n) {
  let i0 = 0; let i1 = n - 1;
  for (let k = 0; k < n; k++) { if (c.bars[k].time <= ex.entryTime) i0 = k; if (c.bars[k].time <= ex.exitTime) i1 = k; }
  const pad = Math.max(8, Math.round((i1 - i0) * 1.2));
  return { from: c.bars[Math.max(0, i0 - pad)].time, to: c.bars[Math.min(n - 1, i1 + pad)].time, ahead: 0 };
}

module.exports = { build };

}, {"./strategies":"core/strategies.js","./time":"core/time.js"}],
"core/top.js": [function (module, exports, require) {
'use strict';
// Top trades: run the advisor on every market the app covers and rank what it finds.
// Ranking is evidence first: the verdict (Worth taking above Take with care), then how strong
// the long-history evidence is (triple-checked, held up, mixed, this chart only), then whether
// the signal is live (a fresh signal above an order that may never fill), then the grade score.
// "Better to skip" ideas are kept but listed separately.

const { INSTRUMENTS, getInstrument } = require('./markets');

// Daily bars for every instrument; 4h and 1h where the research found anything at all
// (forex and crypto). Intraday futures and stock bars failed after costs in every test.
function scanList() {
  const out = [];
  for (const i of INSTRUMENTS) {
    out.push({ symbol: i.symbol, tf: '1d', market: i.market });
    if (i.market === 'forex' || i.market === 'crypto') {
      out.push({ symbol: i.symbol, tf: '4h', market: i.market });
      out.push({ symbol: i.symbol, tf: '1h', market: i.market });
    }
  }
  return out;
}

const LEVEL = { take: 2, caution: 1, skip: 0 };
const EVIDENCE = {
  4: { key: 'passed', label: 'Triple-checked' },
  3: { key: 'condition', label: 'Triple-checked: buy at the close' },
  2: { key: 'weaker', label: 'Held up, weaker on re-check' },
  1: { key: 'mixed', label: 'Mixed evidence' },
  0: { key: 'chart', label: 'This chart only' },
};
function evidenceTier(research) {
  if (!research) return 0;
  if (research.verdict === 'holds') return research.check === 'passed' ? 4 : research.check === 'condition' ? 3 : 2;
  if (research.verdict === 'mixed') return 1;
  return 0;
}

// One advisor result -> one compact row (or null when nothing is set up).
function rowOf(item, r, idea) {
  const i = idea || (r && r.idea);
  if (!i) return null;
  const tier = evidenceTier(i.research);
  const rs = i.research;
  const bt = i.backtest || {};
  return {
    symbol: item.symbol, tf: item.tf, market: item.market,
    price: r.price, generatedAt: r.generatedAt,
    side: i.side, headline: i.headline, pending: !!i.pending, entryType: i.entryType,
    entry: i.entry, stop: i.stop, target: i.target, rr: i.rr, qty: i.qty, riskUsd: i.riskUsd, notional: i.notional,
    strategy: { id: i.strategy.id, name: i.strategy.name, style: i.strategy.style },
    score: i.score, grade: i.grade, meetsProfile: i.meetsProfile,
    verdict: { level: i.verdict.level, title: i.verdict.title, line: i.verdict.line, bad: i.verdict.bad, warn: i.verdict.warn, good: i.verdict.good },
    evidence: { tier, key: EVIDENCE[tier].key, label: EVIDENCE[tier].label },
    research: rs ? { verdict: rs.verdict, check: rs.check, market: rs.market, from: rs.from, to: rs.to, trades: rs.trades, netBp: rs.netBp, tStat: rs.tStat, years: rs.pctYearsPositive } : null,
    backtest: { trades: bt.trades || 0, expectancyR: bt.expectancyR == null ? null : bt.expectancyR, winRate: bt.winRate == null ? null : bt.winRate },
    cost: i.cost || null,
    htf: r.htf ? { tf: r.htf.tf, dir: r.htf.dir } : null,
    decimals: getInstrument(item.symbol).decimals, name: getInstrument(item.symbol).name,
  };
}

function compareRows(a, b) {
  return (LEVEL[b.verdict.level] - LEVEL[a.verdict.level]) ||
    (b.evidence.tier - a.evidence.tier) ||
    ((a.pending ? 1 : 0) - (b.pending ? 1 : 0)) ||
    (b.score - a.score) ||
    (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
}

// Ranked list plus the skip ideas, each with a stable key so the scanner can tell what is new.
function rank(rows) {
  const ok = rows.filter((r) => r && r.verdict.level !== 'skip').sort(compareRows);
  const skipped = rows.filter((r) => r && r.verdict.level === 'skip').sort(compareRows);
  ok.forEach((r, k) => { r.rank = k + 1; });
  return { ranked: ok, skipped };
}
const keyOf = (r) => r.symbol + '|' + r.tf + '|' + r.strategy.id + '|' + r.side + '|' + (r.pending ? 'p' : 's');

// Run the advisor over a batch, a few at a time.
async function scanBatch(items, suggest, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const k = next++;
      const it = items[k];
      try {
        const r = await suggest(it.symbol, it.tf);
        const ideas = (r && (r.ideas || (r.idea ? [r.idea] : []))) || [];
        out[k] = { symbol: it.symbol, tf: it.tf, rows: ideas.map((idea) => rowOf(it, r, idea)), none: !ideas.length };
      } catch (e) {
        out[k] = { symbol: it.symbol, tf: it.tf, error: String((e && e.message) || e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency || 3, items.length) }, worker));
  return out;
}

module.exports = { scanList, rowOf, rank, compareRows, evidenceTier, scanBatch, keyOf, EVIDENCE, LEVEL };

}, {"./markets":"core/markets.js"}],
"core/sync.js": [function (module, exports, require) {
'use strict';
// Sync codes: carry one paper account between devices (the Windows app and the iPhone app).
//
// "Get my code" uploads this device's paper account to PaperDesk's sync service and returns a code
// such as K7QD-M2XP. Typing that code under "Enter a code" on another device loads the account
// there. From then on both devices share it: a change (a new trade, a close, a moved stop) uploads
// a few seconds later, and each device checks for the other's changes every 30 seconds. If both
// changed at once, the most recent change wins.
//
// Only the paper account is sent (cash, positions, orders, trade history and its settings). No
// names, emails or passwords. The service is the iPhone site's Worker (web/functions/sync.js).
const { requestJSON } = require('./http');

const DEFAULT_BASE = 'https://paperdesk-iphone.blakegilbert7.workers.dev/sync';
const PUSH_DELAY_MS = 2500;
const PULL_EVERY_MS = 30000;
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function normCode(s) {
  const x = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (x.length !== 8) return null;
  for (const ch of x) if (!ALPHA.includes(ch)) return null;
  return x.slice(0, 4) + '-' + x.slice(4);
}

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function validState(s) {
  return !!(s && typeof s === 'object' && s.version === 1 && Array.isArray(s.positions) && Array.isArray(s.orders) && Array.isArray(s.history) && typeof s.balance === 'number');
}

// A JSON file next to the account (desktop and dev server).
function fileStore(file) {
  const fs = require('fs');
  const path = require('path');
  return {
    read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } },
    write(v) {
      try {
        if (v == null) { fs.rmSync(file, { force: true }); return; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(v));
      } catch (e) { /* not fatal: sync just won't be remembered */ }
    },
  };
}

class Sync {
  constructor(account, opts) {
    const o = opts || {};
    this.account = account;
    this.base = String(o.base || DEFAULT_BASE).replace(/\/+$/, '');
    this.store = o.store || { read: () => null, write: () => {} };
    let cfg = null;
    try { cfg = this.store.read(); } catch (e) { cfg = null; }
    this.cfg = cfg && normCode(cfg.code) && Number(cfg.rev) > 0 ? cfg : null;
    this.busy = false;
    this.lastPull = 0;
    this.error = null;
    this.seenSig = this.sig();
    this.changedAt = Date.now();
  }

  // What counts as a change worth sending: trades, orders, stops, cash and settings. Price ticks
  // and the equity curve alone don't trigger an upload (they ride along with the next one).
  sig() {
    const s = this.account.state;
    const pos = s.positions.map((p) => [p.id, p.qty, p.stop, p.target, p.managed ? 1 : 0].join(':')).join(',');
    const ord = s.orders.map((o) => [o.id, o.price, o.qty, o.stop, o.target].join(':')).join(',');
    const last = s.history.length ? s.history[s.history.length - 1] : null;
    const ch = s.challenge ? [s.challenge.presetId, s.challenge.status, s.challenge.phase, s.challenge.attempt].join(':') : '';
    return hash([s.createdAt, s.startingCash, Math.round(s.balance * 100), s.profile, s.guard, s.sellAlerts, s.beast ? 1 : 0,
      pos, ord, s.history.length, last ? last.id + ':' + last.closedAt : '', ch].join('|'));
  }

  status() {
    return {
      available: true,
      linked: !!this.cfg,
      code: this.cfg ? this.cfg.code : null,
      lastSync: this.cfg ? this.cfg.lastOk || null : null,
      pending: !!(this.cfg && this.sig() !== this.cfg.sig),
      error: this.error,
    };
  }

  saveCfg() { try { this.store.write(this.cfg); } catch (e) { /* ignore */ } }
  ok() { this.error = null; if (this.cfg) { this.cfg.lastOk = Date.now(); this.saveCfg(); } }
  exportState() { return JSON.parse(JSON.stringify(this.account.state)); }

  async importState(state, message) {
    if (!validState(state)) throw new Error('That code holds something that is not a PaperDesk account.');
    await this.account.exclusive(async () => {
      this.account.state = state;
      this.account.saveNow();
    });
    const sig = this.sig();
    this.seenSig = sig;
    this.account.emit('event', { type: 'sync', sound: 'notify', message });
    return sig;
  }

  async guard(fn) {
    if (this.busy) throw new Error('Sync is busy for a moment. Try again.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  // "Get my code": upload this account and link this device to the new code.
  create() {
    return this.guard(async () => {
      if (this.cfg) return this.status();
      const sig = this.sig();
      const r = await requestJSON('POST', this.base + '/new', { state: this.exportState() });
      if (r.status !== 200 || !r.json || !normCode(r.json.code)) throw new Error((r.json && r.json.error) || 'Could not make a code right now (HTTP ' + r.status + ').');
      this.cfg = { code: r.json.code, rev: r.json.rev, sig };
      this.ok();
      return this.status();
    });
  }

  // "Enter a code": load the account behind a code onto this device and link it.
  join(code) {
    const c = normCode(code);
    if (!c) return Promise.reject(new Error('Codes look like K7QD-M2XP: 8 letters and numbers.'));
    return this.guard(async () => {
      const r = await requestJSON('GET', this.base + '/' + c);
      if (r.status === 404) throw new Error('No paper account uses the code ' + c + '. Check it and try again.');
      if (r.status !== 200 || !r.json || !r.json.state) throw new Error((r.json && r.json.error) || 'Could not load that code right now (HTTP ' + r.status + ').');
      const sig = await this.importState(r.json.state, 'Loaded your paper account from code ' + c + '. Trades on either device now stay in step.');
      this.cfg = { code: c, rev: r.json.rev, sig };
      this.ok();
      return this.status();
    });
  }

  unlink() {
    this.cfg = null;
    this.error = null;
    try { this.store.write(null); } catch (e) { /* ignore */ }
    return this.status();
  }

  // Called after every engine tick (and on demand). Uploads local changes once they settle,
  // otherwise checks for the other device's changes every 30 s.
  maybe(force) {
    if (!this.cfg || this.busy) return Promise.resolve();
    const sig = this.sig();
    if (sig !== this.seenSig) { this.seenSig = sig; this.changedAt = Date.now(); }
    const dirty = sig !== this.cfg.sig;
    const now = Date.now();
    let job = null;
    if (dirty && (force || now - this.changedAt >= PUSH_DELAY_MS)) job = () => this.push(sig);
    else if (!dirty && (force || now - this.lastPull >= PULL_EVERY_MS)) job = () => this.pull();
    if (!job) return Promise.resolve();
    this.busy = true;
    return job().then(() => { this.error = null; }, (e) => { this.error = String((e && e.message) || e); })
      .finally(() => { this.busy = false; });
  }
  now() { this.lastPull = 0; return this.maybe(true).then(() => this.status()); }

  async push(sig) {
    const url = this.base + '/' + this.cfg.code;
    let r = await requestJSON('PUT', url, { baseRev: this.cfg.rev, state: this.exportState() });
    if (r.status === 409 && r.json && r.json.state) {
      // Both devices changed since they last synced: keep the most recent change.
      if ((r.json.updatedAt || 0) > this.changedAt) { await this.adopt(r.json, 'Your other device changed this account more recently, so its version is loaded here.'); return; }
      r = await requestJSON('PUT', url, { baseRev: r.json.rev, state: this.exportState() });
    }
    if (r.status === 200 && r.json && r.json.rev) { this.cfg.rev = r.json.rev; this.cfg.sig = sig; this.lastPull = Date.now(); this.ok(); return; }
    if (r.status === 404) throw new Error('This sync code no longer exists. Get a new code in Settings.');
    throw new Error((r.json && r.json.error) || 'Sync upload failed (HTTP ' + r.status + ').');
  }

  async pull() {
    this.lastPull = Date.now();
    const r = await requestJSON('GET', this.base + '/' + this.cfg.code + '?since=' + this.cfg.rev);
    if (r.status === 200 && r.json && r.json.same) { this.ok(); return; }
    if (r.status === 200 && r.json && r.json.state) { await this.adopt(r.json, 'Synced: loaded the latest trades from your other device.'); return; }
    if (r.status === 404) throw new Error('This sync code no longer exists. Get a new code in Settings.');
    throw new Error((r.json && r.json.error) || 'Sync check failed (HTTP ' + r.status + ').');
  }

  async adopt(j, message) {
    // A trade placed here while the download was on its way wins; it uploads on the next tick.
    if (this.sig() !== this.cfg.sig && j.updatedAt <= this.changedAt) return;
    const sig = await this.importState(j.state, message);
    this.cfg.rev = j.rev;
    this.cfg.sig = sig;
    this.ok();
  }
}

module.exports = { Sync, fileStore, normCode, DEFAULT_BASE };

}, {"./http":"core/http.js","fs":"web/shims/fs.js","path":"web/shims/path.js"}]
};
var cache = {};
function load(id) {
  if (cache[id]) return cache[id].exports;
  var d = defs[id]; if (!d) throw new Error("Missing module " + id);
  var module = { exports: {} }; cache[id] = module;
  d[0].call(module.exports, module, module.exports, function (req) { var to = d[1][req]; if (!to) throw new Error("Unbundled require " + req + " in " + id); return load(to); });
  return module.exports;
}
load("web/engine-entry.js");
})();
