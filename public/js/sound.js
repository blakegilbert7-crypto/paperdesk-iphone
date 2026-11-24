/* Synthesized UI sound effects (Web Audio, no sound files). */
(function () {
  let ctx = null;
  let master = null;
  let volume = 0.6;
  let enabled = true;
  try {
    const v = localStorage.getItem('pd.volume');
    if (v != null) volume = Math.max(0, Math.min(1, Number(v)));
    enabled = localStorage.getItem('pd.sound') !== 'off';
  } catch (e) { /* storage unavailable */ }

  function ac() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = volume * 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Each theme has its own sound: same events, different voice.
  const PACKS = {
    aurora: {},
    terminal: { mult: 0.8, type: 'square', filter: 2600, decay: 0.7, gain: 0.55 },
    daylight: { mult: 1.12, type: 'sine', decay: 1.1, gain: 0.9 },
    synthwave: { mult: 0.75, type: 'sawtooth', filter: 1900, decay: 1.3, gain: 0.6 },
    carbon: { mult: 1, type: 'triangle', decay: 0.6, gain: 0.85 },
    glacier: { mult: 1.3, type: 'sine', decay: 1.5, gain: 0.8 },
  };
  let pack = PACKS.aurora;
  function setPack(id) { pack = PACKS[id] || PACKS.aurora; }

  function tone(freq, start, dur, opts) {
    const o = Object.assign({}, opts || {});
    if (pack.mult) { freq *= pack.mult; if (o.to) o.to *= pack.mult; }
    if (pack.decay) dur *= pack.decay;
    if (pack.type) o.type = pack.type;
    if (pack.filter && !o.filter) o.filter = pack.filter;
    if (pack.gain) o.gain = (o.gain || 0.2) * pack.gain;
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + (start || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    const peak = (o.gain || 0.2);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (o.filter) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.filter;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise(start, dur, opts) {
    const o = opts || {};
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + (start || 0);
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.from || 1200, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    f.Q.value = o.q || 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(o.gain || 0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
  }

  const SOUNDS = {
    click() { tone(1800, 0, 0.045, { type: 'triangle', gain: 0.07 }); noise(0, 0.025, { from: 4000, gain: 0.05, q: 0.8 }); },
    hover() { tone(2600, 0, 0.025, { type: 'sine', gain: 0.018 }); },
    toggle() { tone(880, 0, 0.06, { type: 'triangle', gain: 0.07 }); tone(1320, 0.045, 0.07, { type: 'triangle', gain: 0.06 }); },
    tab() { noise(0, 0.12, { from: 600, to: 3200, gain: 0.05, q: 0.7 }); tone(1100, 0.02, 0.05, { gain: 0.035 }); },
    select() { tone(660, 0, 0.05, { type: 'sine', gain: 0.08 }); tone(990, 0.04, 0.08, { type: 'sine', gain: 0.07 }); },
    execute() {
      noise(0, 0.35, { from: 300, to: 5000, gain: 0.09, q: 0.6 });
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.08 + i * 0.055, 0.32, { type: 'triangle', gain: 0.09 }));
      tone(130.8, 0.05, 0.3, { type: 'sine', gain: 0.12 });
    },
    placed() { tone(1046.5, 0, 0.18, { type: 'sine', gain: 0.09 }); tone(1568, 0.07, 0.25, { type: 'sine', gain: 0.06 }); },
    win() {
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => tone(f, i * 0.07, 0.35, { type: 'triangle', gain: 0.1 }));
      tone(3136, 0.3, 0.4, { type: 'sine', gain: 0.05 });
      noise(0.28, 0.3, { from: 6000, gain: 0.04, q: 2, type: 'highpass' });
    },
    loss() { tone(392, 0, 0.22, { type: 'sine', gain: 0.1 }); tone(311.1, 0.16, 0.35, { type: 'sine', gain: 0.1, filter: 1500 }); },
    error() { tone(160, 0, 0.12, { type: 'square', gain: 0.05, filter: 900 }); tone(120, 0.1, 0.16, { type: 'square', gain: 0.05, filter: 700 }); },
    notify() { tone(1318.5, 0, 0.12, { gain: 0.07 }); tone(1760, 0.1, 0.18, { gain: 0.06 }); },
    tick() { tone(3200, 0, 0.02, { gain: 0.012 }); },
    open() { noise(0, 0.18, { from: 400, to: 2400, gain: 0.05, q: 0.7 }); },
    warn() { tone(880, 0, 0.14, { type: 'triangle', gain: 0.08 }); tone(622.3, 0.13, 0.22, { type: 'triangle', gain: 0.08 }); noise(0, 0.2, { from: 900, to: 300, gain: 0.03, q: 0.8 }); },
    right() { tone(784, 0, 0.09, { type: 'triangle', gain: 0.08 }); tone(1174.7, 0.07, 0.16, { type: 'triangle', gain: 0.08 }); },
    wrong() { tone(311.1, 0, 0.12, { type: 'triangle', gain: 0.07 }); tone(233.1, 0.1, 0.2, { type: 'triangle', gain: 0.06, filter: 1600 }); },
    skip() { tone(523.25, 0, 0.12, { type: 'sine', gain: 0.08 }); tone(392, 0.09, 0.2, { type: 'sine', gain: 0.07 }); noise(0, 0.16, { from: 2400, to: 600, gain: 0.03, q: 0.7 }); },
    close() { noise(0, 0.15, { from: 2400, to: 500, gain: 0.04, q: 0.7 }); },
  };

  function play(name) {
    if (!enabled || volume <= 0 || !SOUNDS[name]) return;
    try { SOUNDS[name](); } catch (e) { /* audio unavailable */ }
  }

  // A rising tone for "hold to confirm". Returns { stop(finished) }.
  function charge(ms) {
    if (!enabled || volume <= 0) return { stop() {} };
    const c = ac(); if (!c) return { stop() {} };
    const t0 = c.currentTime; const dur = ms / 1000;
    const osc = c.createOscillator(); const g = c.createGain(); const f = c.createBiquadFilter();
    osc.type = 'sawtooth'; f.type = 'lowpass'; f.frequency.setValueAtTime(500, t0); f.frequency.exponentialRampToValueAtTime(2600, t0 + dur);
    osc.frequency.setValueAtTime(110, t0); osc.frequency.exponentialRampToValueAtTime(440, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.08); g.gain.linearRampToValueAtTime(0.07, t0 + dur);
    osc.connect(f); f.connect(g); g.connect(master); osc.start(t0);
    let stopped = false;
    return {
      stop(finished) {
        if (stopped) return; stopped = true;
        const t = c.currentTime;
        g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        osc.stop(t + 0.15);
        if (finished) play('execute'); else tone(220, 0, 0.12, { type: 'sine', gain: 0.05 });
      },
    };
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (master) master.gain.value = volume * 0.5;
    try { localStorage.setItem('pd.volume', String(volume)); } catch (e) { /* ignore */ }
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem('pd.sound', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
  }

  // Global click sounds: any element with data-sound plays it; buttons default to "click".
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-sound], button, .w-row, .sr, .wp');
    if (!el) return;
    const s = el.dataset.sound || (el.classList.contains('w-row') || el.classList.contains('sr') || el.classList.contains('wp') ? 'select' : 'click');
    if (s !== 'none') play(s);
  }, true);

  window.Sound = { play, charge, setVolume, setEnabled, setPack, get volume() { return volume; }, get enabled() { return enabled; } };
})();
