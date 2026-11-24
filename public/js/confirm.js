/* "Are you sure?" screen for trades the app does not recommend. The safe choice is the default
   button; placing the trade anyway needs the button held down until its ring fills. */
(function () {
  const HOLD_MS = 1600;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  let open = null;

  function ask(o) {
    if (open) open.finish('cancel', true);
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'cf-back ' + (o.tone || 'bad');
      const reasons = (o.reasons || []).map((r, k) => '<li class="' + (r.tone || 'bad') + '" style="--d:' + (180 + k * 90) + 'ms"><span class="cf-ri">' + Icons.svg(r.tone === 'warn' ? 'alert' : 'x') + '</span><span>' + (window.Gloss ? Gloss.wrap(esc(r.text)) : esc(r.text)) + '</span></li>').join('');
      const stats = (o.stats || []).map((s) => '<div class="cf-stat"><span>' + esc(s.k) + '</span><b class="num ' + (s.tone ? s.tone + '-t' : '') + '">' + esc(s.v) + '</b></div>').join('');
      back.innerHTML =
        '<div class="cf-card" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle">' +
        '<div class="cf-glow"></div>' +
        '<div class="cf-top"><div class="cf-badge"><i></i><i></i>' + Icons.svg(o.icon || 'shield') + '</div>' +
        '<div><div class="cf-kicker">' + esc(o.kicker || 'Not recommended') + '</div><h2 id="cfTitle">' + esc(o.title) + '</h2>' +
        (o.trade ? '<div class="cf-trade num"><span class="side-tag ' + (o.side === 'sell' ? 'short' : 'long') + '">' + (o.side === 'sell' ? 'SELL' : 'BUY') + '</span>' + esc(o.trade) + '</div>' : '') + '</div></div>' +
        (stats ? '<div class="cf-stats">' + stats + '</div>' : '') +
        '<div class="cf-why">Why the app says no</div><ul class="cf-reasons">' + reasons + '</ul>' +
        (o.note ? '<div class="cf-note">' + esc(o.note) + '</div>' : '') +
        '<div class="cf-actions">' +
        '<button class="cf-safe" data-sound="none"><span class="ico">' + Icons.svg('shield') + '</span><span>' + esc(o.safeLabel || 'Don\'t place it') + '</span></button>' +
        '<button class="cf-hold" data-sound="none" aria-label="Hold to place anyway"><span class="cf-fill"></span><svg class="cf-ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15"/><circle class="p" cx="18" cy="18" r="15"/></svg><span class="cf-hl">' + esc(o.holdLabel || 'Hold to place anyway') + '</span></button>' +
        '</div>' +
        (o.lesson ? '<button class="cf-learn" data-sound="none">' + Icons.svg('book') + '<span>Walk me through why first</span></button>' : '') +
        '<div class="cf-keys">Esc or Enter to back out · hold the right button (or Space on it) to place</div>' +
        '</div>';
      document.body.appendChild(back);
      const card = back.querySelector('.cf-card');
      const safe = back.querySelector('.cf-safe');
      const hold = back.querySelector('.cf-hold');
      const ring = back.querySelector('.cf-ring .p');
      const RING = 2 * Math.PI * 15;
      ring.style.strokeDasharray = RING; ring.style.strokeDashoffset = RING;
      let t0 = 0; let raf = 0; let charge = null; let done = false;

      function setP(p) {
        hold.style.setProperty('--p', p.toFixed(3));
        ring.style.strokeDashoffset = RING * (1 - p);
        card.style.setProperty('--shake', p > 0.55 ? ((p - 0.55) * 2.2).toFixed(2) : '0');
      }
      function frame() {
        const p = Math.min(1, (performance.now() - t0) / HOLD_MS);
        setP(p);
        if (p >= 1) { complete(); return; }
        raf = requestAnimationFrame(frame);
      }
      function start(e) {
        if (done || t0) return;
        if (e) e.preventDefault();
        t0 = performance.now();
        hold.classList.add('holding'); card.classList.add('charging');
        if (window.Sound && Sound.charge) charge = Sound.charge(HOLD_MS);
        raf = requestAnimationFrame(frame);
      }
      function stop() {
        if (done || !t0) return;
        cancelAnimationFrame(raf); t0 = 0;
        if (charge) { charge.stop(); charge = null; }
        hold.classList.remove('holding'); card.classList.remove('charging');
        hold.classList.add('let-go'); setTimeout(() => hold.classList.remove('let-go'), 500);
        const from = Number(hold.style.getPropertyValue('--p')) || 0; const s0 = performance.now();
        const ease = () => { const p = Math.max(0, from * (1 - (performance.now() - s0) / 260)); setP(p); if (p > 0 && !done) requestAnimationFrame(ease); };
        requestAnimationFrame(ease);
        const tip = card.querySelector('.cf-keys'); tip.classList.remove('nudge'); void tip.offsetWidth; tip.classList.add('nudge');
      }
      function complete() {
        done = true; if (charge) { charge.stop(true); charge = null; }
        hold.classList.remove('holding'); hold.classList.add('done'); card.classList.add('placed');
        setTimeout(() => finish('place'), 380);
      }
      function finish(result, silent) {
        if (!back.isConnected) return;
        done = true; cancelAnimationFrame(raf); if (charge) { charge.stop(); charge = null; }
        removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKeyUp, true);
        back.classList.add('out');
        setTimeout(() => back.remove(), 280);
        if (!silent && window.Sound) Sound.play(result === 'place' ? 'select' : result === 'lesson' ? 'open' : 'close');
        open = null;
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape' || (e.key === 'Enter' && document.activeElement !== hold)) { e.preventDefault(); e.stopImmediatePropagation(); finish('cancel'); return; }
        if ((e.key === ' ' || e.key === 'Enter') && document.activeElement === hold) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) start(); return; }
        if (e.key === 'Tab') return;
        e.stopImmediatePropagation();
      }
      function onKeyUp(e) { if ((e.key === ' ' || e.key === 'Enter') && document.activeElement === hold) { e.preventDefault(); stop(); } }

      safe.addEventListener('click', () => finish('cancel'));
      hold.addEventListener('pointerdown', start);
      hold.addEventListener('pointerup', stop);
      hold.addEventListener('pointerleave', stop);
      hold.addEventListener('pointercancel', stop);
      hold.addEventListener('click', (e) => e.preventDefault());
      const learn = back.querySelector('.cf-learn');
      if (learn) learn.addEventListener('click', () => finish('lesson'));
      back.addEventListener('pointerdown', (e) => { if (e.target === back) finish('cancel'); });
      addEventListener('keydown', onKey, true); addEventListener('keyup', onKeyUp, true);
      open = { finish };
      if (window.Sound) Sound.play('warn');
      requestAnimationFrame(() => safe.focus());
    });
  }

  window.Confirm = { ask, isOpen: () => !!open };
})();
