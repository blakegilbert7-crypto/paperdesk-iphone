/* Animation helpers: number tweens, ripples, flashes, toasts, confetti, sliders. */
(function () {
  const tweens = new WeakMap();

  function tweenNumber(el, to, fmt, ms) {
    const from = tweens.has(el) ? tweens.get(el).value : to;
    const dur = ms || 650;
    const start = performance.now();
    const state = { value: from, to };
    tweens.set(el, state);
    if (from === to || !isFinite(from)) { state.value = to; el.textContent = fmt(to); return; }
    function step(now) {
      if (tweens.get(el) !== state) return;
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      state.value = from + (to - from) * e;
      el.textContent = fmt(state.value);
      if (t < 1) requestAnimationFrame(step); else state.value = to;
    }
    requestAnimationFrame(step);
  }

  function flash(el, dir) {
    if (!el || !dir) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
    setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 60);
  }

  // Material-style ripple on any .primary-btn / .danger-btn
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.primary-btn, .danger-btn, .ghost-btn');
    if (!btn || btn.disabled) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = size + 'px';
    s.style.left = (e.clientX - r.left - size / 2) + 'px';
    s.style.top = (e.clientY - r.top - size / 2) + 'px';
    btn.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });

  // Segmented control: slide the indicator under the active button.
  function seg(root, value) {
    const btns = Array.from(root.querySelectorAll('button[data-v], button[data-tab], button[data-side]'));
    btns.forEach((b) => b.classList.toggle('active', (b.dataset.v || b.dataset.tab || b.dataset.side) === value));
    const active = btns.find((b) => b.classList.contains('active'));
    const ind = root.querySelector('.seg-ind, .tab-ind');
    if (active && ind) {
      const pr = root.getBoundingClientRect();
      const ar = active.getBoundingClientRect();
      if (ar.width) {
        ind.style.width = ar.width + 'px';
        ind.style.transform = 'translateX(' + (ar.left - pr.left - (ind.classList.contains('tab-ind') ? 0 : 0)) + 'px)';
      }
    }
    root.dataset.v = value;
  }

  // Toasts
  function toast(opts) {
    const box = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (opts.kind || '');
    const icon = opts.icon || ({ win: 'trophy', loss: 'down', error: 'alert' }[opts.kind] || 'bolt');
    t.innerHTML = '<div class="ti">' + Icons.svg(icon) + '</div><div><b></b><span></span></div>';
    t.querySelector('b').textContent = opts.title || '';
    t.querySelector('span').textContent = opts.body || '';
    const gone = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
    if (opts.tag) t.dataset.tag = opts.tag;
    if (opts.extra) { const x = document.createElement('small'); x.className = 'toast-extra'; x.textContent = opts.extra; t.lastChild.appendChild(x); }
    if (opts.actions && opts.actions.length) {
      // buttons on the toast itself (e.g. Sell now / Keep it); a click runs the action and closes it
      t.classList.add('has-actions');
      const row = document.createElement('div'); row.className = 'toast-acts';
      for (const a of opts.actions) {
        const btn = document.createElement('button'); btn.type = 'button';
        btn.className = 'toast-btn ' + (a.cls || ''); btn.textContent = a.label;
        if (a.sound) btn.dataset.sound = a.sound;
        btn.addEventListener('click', (e) => { e.stopPropagation(); try { if (a.onClick) a.onClick(btn); } catch (err) { /* ignore */ } if (a.keep !== true) gone(); });
        row.appendChild(btn);
      }
      t.lastChild.appendChild(row);
    }
    box.prepend(t);
    while (box.children.length > 5) box.lastChild.remove();
    const ttl = opts.ttl || 4800;
    setTimeout(gone, ttl);
    if (opts.onClick) t.classList.add('clickable');
    t.addEventListener('click', () => { if (opts.onClick) { try { opts.onClick(); } catch (e) { /* ignore */ } } if (!opts.actions) gone(); });
    return t;
  }

  // Confetti burst (canvas particles)
  const cv = document.getElementById('confetti');
  const cx = cv.getContext('2d');
  let parts = [];
  let running = false;
  function resize() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; }
  addEventListener('resize', resize); resize();
  function confetti(x, y, n) {
    const p = window.Theme ? Theme.pal : {}; const colors = [p.a1 || '#8b6cff', p.a2 || '#3fa2ff', p.up || '#1fae7e', p.warn || '#ffd166', '#ff7ab6', p.entry || '#ffffff'];
    const px = (x != null ? x : innerWidth / 2) * devicePixelRatio;
    const py = (y != null ? y : innerHeight / 3) * devicePixelRatio;
    for (let i = 0; i < (n || 120); i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (4 + Math.random() * 9) * devicePixelRatio;
      parts.push({ x: px, y: py, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6 * devicePixelRatio, r: (3 + Math.random() * 4) * devicePixelRatio, c: colors[i % colors.length], rot: Math.random() * 6, vr: (Math.random() - .5) * .4, life: 1 });
    }
    if (!running) { running = true; requestAnimationFrame(loop); }
  }
  function loop() {
    cx.clearRect(0, 0, cv.width, cv.height);
    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) {
      p.vy += 0.35 * devicePixelRatio; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 0.012;
      cx.save(); cx.globalAlpha = Math.max(0, p.life); cx.translate(p.x, p.y); cx.rotate(p.rot);
      cx.fillStyle = p.c; cx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); cx.restore();
    }
    if (parts.length) requestAnimationFrame(loop); else { running = false; cx.clearRect(0, 0, cv.width, cv.height); }
  }

  function sparkline(values, up) {
    if (!values || values.length < 2) return '';
    const w = 54; const h = 22;
    const min = Math.min.apply(null, values); const max = Math.max.apply(null, values);
    const span = max - min || 1;
    const pts = values.map((v, i) => (i / (values.length - 1) * w).toFixed(1) + ',' + (h - 2 - (v - min) / span * (h - 4)).toFixed(1));
    const col = up ? 'var(--up)' : 'var(--down)';
    return '<svg class="w-spark" viewBox="0 0 ' + w + ' ' + h + '"><polyline fill="none" style="stroke:' + col + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="' + pts.join(' ') + '"/></svg>';
  }

  window.Fx = { tweenNumber, flash, seg, toast, confetti, sparkline };
})();
