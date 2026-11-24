/* "Walk me through it": plays a trade idea's lesson (built in core/lesson.js) over the chart, one
   step at a time. Each step zooms the chart, draws what the rule looked at and explains it. */
(function () {
  const L = { lesson: null, k: 0, card: null, wrap: null, onEnd: null, symbol: '', quiz: null };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // **bold** and paragraphs only
  const md = (s, used) => esc(s).split(/\n\n+/).map((p) => '<p>' + (window.Gloss ? Gloss.wrap(p, used) : p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>') + '</p>').join('');

  // "Check yourself": one question at a time; an answer shows right or wrong and why.
  function quizHtml(qs) {
    const Q = L.quiz; const q = qs[Q.i];
    const ans = Q.ans[Q.i];
    const right = Q.ans.filter((a, k) => a === qs[k].a).length;
    if (Q.i >= qs.length) {
      return '<div class="ls-quiz done"><div class="qz-score num">' + right + ' / ' + qs.length + '</div><p>' + (right === qs.length ? 'All right. You know how this trade works.' : right ? 'Nearly. Go back through the steps for the one you missed.' : 'Worth another look: step back through the lesson.') + '</p><button class="ghost-btn qz-again" data-sound="none">Try again</button></div>';
    }
    return '<div class="ls-quiz"><div class="qz-n">Question ' + (Q.i + 1) + ' of ' + qs.length + '</div><div class="qz-q">' + esc(q.q) + '</div><div class="qz-opts">' +
      q.options.map((o, k) => '<button class="qz-o' + (ans != null ? (k === q.a ? ' right' : k === ans ? ' wrong' : ' dim') : '') + '" data-k="' + k + '" data-sound="none"' + (ans != null ? ' disabled' : '') + '><i>' + 'ABC'[k] + '</i><span>' + esc(o) + '</span></button>').join('') + '</div>' +
      (ans != null ? '<div class="qz-why ' + (ans === q.a ? 'right' : 'wrong') + '"><b>' + (ans === q.a ? 'Right.' : 'Not quite.') + '</b> ' + (window.Gloss ? Gloss.wrap(esc(q.why)) : esc(q.why)) + '</div><button class="ls-next qz-next" data-sound="none">' + (Q.i === qs.length - 1 ? 'See score' : 'Next question') + '</button>' : '') + '</div>';
  }
  function bindQuiz(c, qs) {
    const box = c.querySelector('.ls-quiz'); if (!box) return;
    box.querySelectorAll('.qz-o').forEach((b) => b.addEventListener('click', () => {
      const k = Number(b.dataset.k); L.quiz.ans[L.quiz.i] = k;
      if (window.Sound) Sound.play(k === qs[L.quiz.i].a ? 'right' : 'wrong');
      redrawQuiz(c, qs);
    }));
    const nx = box.querySelector('.qz-next'); if (nx) nx.addEventListener('click', () => { L.quiz.i++; if (window.Sound) Sound.play(L.quiz.i >= qs.length ? 'win' : 'tab'); redrawQuiz(c, qs); });
    const ag = box.querySelector('.qz-again'); if (ag) ag.addEventListener('click', () => { L.quiz = { i: 0, ans: [] }; if (window.Sound) Sound.play('click'); redrawQuiz(c, qs); });
  }
  function redrawQuiz(c, qs) {
    const old = c.querySelector('.ls-quiz'); if (!old) return;
    const tmp = document.createElement('div'); tmp.innerHTML = quizHtml(qs);
    old.replaceWith(tmp.firstChild);
    bindQuiz(c, qs);
  }

  function gaugeHtml(g) {
    const span = (g.max - g.min) || 1;
    const v = Math.max(0, Math.min(1, (g.value - g.min) / span));
    const th = Math.max(0, Math.min(1, (g.threshold - g.min) / span));
    const hit = g.rule === 'below' ? g.value < g.threshold : g.value > g.threshold;
    const zoneL = g.rule === 'below' ? 0 : th; const zoneW = g.rule === 'below' ? th : 1 - th;
    return '<div class="ls-gauge' + (hit ? ' hit' : '') + '">' +
      '<div class="ls-g-top"><span>' + esc(g.label) + '</span><b class="num">' + esc(g.text) + '</b></div>' +
      '<div class="ls-g-track"><i class="ls-g-zone" style="left:' + (zoneL * 100).toFixed(1) + '%;width:' + (zoneW * 100).toFixed(1) + '%"></i>' +
      '<i class="ls-g-th" style="left:' + (th * 100).toFixed(1) + '%"></i>' +
      '<i class="ls-g-dot" style="--v:' + (v * 100).toFixed(1) + '%"></i></div>' +
      '<div class="ls-g-scale num"><span>' + g.min + '</span><span style="left:' + (th * 100).toFixed(1) + '%">' + g.threshold + '</span><span>' + g.max + '</span></div>' +
      '</div>';
  }

  function factsHtml(f) {
    return '<div class="ls-facts">' + f.map((x) => '<div class="ls-fact"><span>' + esc(x.k) + '</span><b class="num' + (x.tone ? ' ' + x.tone + '-t' : '') + '">' + esc(x.v) + '</b></div>').join('') + '</div>';
  }

  function render(dir) {
    const steps = L.lesson.steps; const s = steps[L.k]; const n = steps.length; const last = L.k === n - 1;
    const c = L.card;
    c.innerHTML =
      '<div class="ls-head"><span class="ls-kicker"><span class="ico" data-icon="book"></span>Step ' + (L.k + 1) + ' of ' + n + '</span>' +
      '<span class="ls-sub">' + esc(L.lesson.title) + '</span>' +
      '<button class="icon-btn sm ls-x" title="Close (Esc)" data-sound="none"><span class="ico" data-icon="x"></span></button></div>' +
      '<div class="ls-prog"><i style="width:' + ((L.k + 1) / n * 100).toFixed(1) + '%"></i></div>' +
      '<div class="ls-body ' + (dir < 0 ? 'back' : 'fwd') + '">' +
      '<h4>' + esc(s.title) + '</h4>' +
      (s.facts && s.facts.length ? factsHtml(s.facts) : '') +
      (s.gauge ? gaugeHtml(s.gauge) : '') +
      '<div class="ls-text">' + md(s.text, new Set()) + '</div>' +
      (s.quiz && s.quiz.length ? quizHtml(s.quiz) : '') +
      '</div>' +
      '<div class="ls-nav">' +
      '<button class="ghost-btn ls-back" data-sound="none"' + (L.k === 0 ? ' disabled' : '') + '>Back</button>' +
      '<div class="ls-dots">' + steps.map((x, k) => '<button class="ls-dot' + (k === L.k ? ' on' : k < L.k ? ' done' : '') + '" data-k="' + k + '" title="' + esc(x.title) + '" data-sound="none"></button>').join('') + '</div>' +
      '<button class="ls-next' + (last ? ' finish' : '') + '" data-sound="none">' + (last ? 'Finish' : 'Next') + '</button>' +
      '</div>' +
      '<div class="ls-keys">← → to move · Esc to close</div>';
    if (window.Icons) Icons.hydrate(c);
    c.querySelector('.ls-x').addEventListener('click', () => close());
    c.querySelector('.ls-back').addEventListener('click', () => go(L.k - 1));
    c.querySelector('.ls-next').addEventListener('click', () => (last ? close(false, true) : go(L.k + 1)));
    c.querySelectorAll('.ls-dot').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.k))));
    if (s.quiz && s.quiz.length) bindQuiz(c, s.quiz);
    requestAnimationFrame(() => { const d = c.querySelector('.ls-g-dot'); if (d) d.classList.add('in'); });
    PriceChart.lessonStep(s, { leftPad: c.offsetWidth + 24 });
  }

  function go(k) {
    if (!L.lesson) return;
    const n = L.lesson.steps.length;
    if (k < 0 || k >= n || k === L.k) return;
    const dir = k > L.k ? 1 : -1;
    L.k = k;
    if (window.Sound) Sound.play(dir > 0 ? 'tab' : 'click');
    render(dir);
  }

  function open(lesson, opts) {
    if (!lesson || !lesson.steps || !lesson.steps.length) return;
    if (L.lesson) close(true);
    const o = opts || {};
    L.lesson = lesson; L.onEnd = o.onEnd || null; L.quiz = { i: 0, ans: [] };
    L.k = Math.max(0, Math.min(lesson.steps.length - 1, Number(o.step) || 0));
    L.wrap = document.querySelector('.chart-wrap');
    L.wrap.classList.add('lesson-on');
    L.card = document.createElement('div');
    L.card.className = 'lesson-card';
    L.card.setAttribute('role', 'dialog');
    L.card.setAttribute('aria-label', 'Trade walkthrough');
    L.wrap.appendChild(L.card);
    if (window.Sound) Sound.play('open');
    render(1);
  }

  function close(silent, finished) {
    if (!L.lesson) return;
    const card = L.card; const wrap = L.wrap; const cb = L.onEnd;
    L.lesson = null; L.card = null; L.onEnd = null;
    if (wrap) wrap.classList.remove('lesson-on');
    if (card) { card.classList.add('out'); setTimeout(() => card.remove(), 260); }
    PriceChart.lessonEnd();
    if (!silent && window.Sound) Sound.play(finished ? 'select' : 'close');
    if (cb) cb();
  }

  // the lesson's keys win over the app's shortcuts while it is open
  addEventListener('keydown', (e) => {
    if (!L.lesson) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    if (window.Confirm && Confirm.isOpen()) return;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    let used = true;
    if (e.key === 'ArrowRight' || e.key === 'Enter' && !(document.activeElement && document.activeElement.tagName === 'BUTTON')) {
      if (L.k === L.lesson.steps.length - 1) close(false, true); else go(L.k + 1);
    } else if (e.key === 'ArrowLeft') go(L.k - 1);
    else if (e.key === 'Escape') close();
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  window.Lesson = { open, close, go, isOpen: () => !!L.lesson, step: () => L.k };
})();
