/* Quiz me: 10 multiple-choice trading questions a round, with explanations and a best score. */
(function () {
  const ROUND = 10;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = (k, d) => { try { const v = localStorage.getItem('pd.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem('pd.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };
  const play = (n) => { try { if (window.Sound) Sound.play(n); } catch (e) { /* ignore */ } };

  let st = null;
  const $ = (id) => document.getElementById(id);

  function shuffle(a) {
    const x = a.slice();
    for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
    return x;
  }

  // Questions not seen recently come first, so rounds don't repeat.
  function pick(topic) {
    const all = QuizData.Q.map((q, id) => Object.assign({ id }, q)).filter((q) => topic === 'all' || q.t === topic);
    const seen = new Set(load('quizSeen', []));
    const fresh = shuffle(all.filter((q) => !seen.has(q.id)));
    const old = shuffle(all.filter((q) => seen.has(q.id)));
    const out = fresh.concat(old).slice(0, Math.min(ROUND, all.length));
    const next = load('quizSeen', []).filter((id) => !out.some((q) => q.id === id)).concat(out.map((q) => q.id));
    save('quizSeen', next.slice(-Math.floor(QuizData.Q.length * 0.7)));
    return out.map((q) => {
      const order = shuffle([0, 1, 2, 3].slice(0, q.a.length));
      return Object.assign({}, q, { opts: order.map((k) => q.a[k]), right: order.indexOf(0) });
    });
  }

  function topicName(id) { const t = QuizData.TOPICS.find((x) => x.id === id); return t ? t.name : 'All topics'; }

  function open() {
    $('quizModal').hidden = false;
    play('open');
    renderStart();
  }
  function close() { $('quizModal').hidden = true; play('close'); st = null; }

  function top() { const b = $('quizBody'); if (b) b.scrollTop = 0; const m = $('quizModal'); if (m) m.scrollTop = 0; }

  function renderStart() {
    st = null; top();
    const topic = load('quizTopic', 'all');
    const best = load('quizBest', {});
    const counts = {}; QuizData.Q.forEach((q) => { counts[q.t] = (counts[q.t] || 0) + 1; });
    const chip = (id, name, n) => '<button class="qm-topic' + (topic === id ? ' on' : '') + '" data-t="' + id + '" data-sound="toggle"><b>' + esc(name) + '</b><small>' + n + ' questions' + (best[id] != null ? ' · best ' + best[id] + '/' + Math.min(ROUND, n) : '') + '</small></button>';
    $('quizBody').innerHTML =
      '<div class="qm-start"><div class="qm-hero"><span class="qm-hero-ico">' + Icons.svg('quiz') + '</span><div><b>Test what you know</b><p>' + ROUND + ' quick questions, one at a time. Every answer comes with a short why. Press 1 to 4 to answer, Enter for the next one.</p></div></div>' +
      '<div class="qm-topics">' + chip('all', 'All topics', QuizData.Q.length) + QuizData.TOPICS.map((t) => chip(t.id, t.name, counts[t.id] || 0)).join('') + '</div>' +
      '<button class="primary-btn qm-go" id="quizGo" data-sound="none"><span>Start the quiz</span></button></div>';
    $('quizBody').querySelectorAll('.qm-topic').forEach((b) => b.addEventListener('click', () => {
      save('quizTopic', b.dataset.t);
      $('quizBody').querySelectorAll('.qm-topic').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('quizGo').addEventListener('click', () => start(load('quizTopic', 'all')));
  }

  function start(topic) {
    play('execute');
    st = { topic, qs: pick(topic), i: 0, score: 0, streak: 0, bestStreak: 0, answered: false, missed: [] };
    renderQ();
  }

  function renderQ() {
    top();
    const q = st.qs[st.i];
    st.answered = false;
    const n = st.qs.length;
    $('quizBody').innerHTML =
      '<div class="qm-q"><div class="qm-top"><span class="qm-count num">Question ' + (st.i + 1) + ' of ' + n + '</span><span class="qm-tag">' + esc(topicName(q.t)) + '</span><span class="qm-score num">' + st.score + ' right' + (st.streak >= 2 ? ' · <b class="qm-streak">' + st.streak + ' in a row</b>' : '') + '</span></div>' +
      '<div class="qm-prog"><i style="width:' + (st.i / n * 100).toFixed(1) + '%"></i></div>' +
      '<h3 class="qm-text">' + esc(q.q) + '</h3>' +
      '<div class="qm-opts">' + q.opts.map((o, k) => '<button class="qm-opt" data-k="' + k + '" data-sound="none"><span class="qm-key">' + 'ABCD'[k] + '</span><span class="qm-o">' + esc(o) + '</span></button>').join('') + '</div>' +
      '<div class="qm-why" id="quizWhy" hidden></div>' +
      '<div class="qm-foot"><button class="ghost-btn" id="quizQuit" data-sound="click">End quiz</button><button class="primary-btn qm-next" id="quizNext" data-sound="none" disabled><span>' + (st.i + 1 < n ? 'Next question' : 'See my score') + '</span></button></div></div>';
    $('quizBody').querySelectorAll('.qm-opt').forEach((b) => b.addEventListener('click', () => answer(Number(b.dataset.k))));
    $('quizNext').addEventListener('click', next);
    $('quizQuit').addEventListener('click', () => (st.i > 0 || st.answered ? renderEnd() : renderStart()));
    requestAnimationFrame(() => { const bar = $('quizBody').querySelector('.qm-prog i'); if (bar) bar.style.width = ((st.i) / n * 100).toFixed(1) + '%'; });
  }

  function answer(k) {
    if (!st || st.answered) return;
    st.answered = true;
    const q = st.qs[st.i];
    const ok = k === q.right;
    if (ok) { st.score++; st.streak++; st.bestStreak = Math.max(st.bestStreak, st.streak); } else { st.streak = 0; st.missed.push(q); }
    play(ok ? 'right' : 'wrong');
    $('quizBody').querySelectorAll('.qm-opt').forEach((b) => {
      const j = Number(b.dataset.k);
      b.disabled = true;
      if (j === q.right) b.classList.add('qm-right');
      else if (j === k) b.classList.add('qm-wrong');
      else b.classList.add('qm-dim');
    });
    const why = $('quizWhy');
    why.hidden = false;
    why.className = 'qm-why ' + (ok ? 'qm-ok' : 'qm-no');
    why.innerHTML = '<b>' + (ok ? (st.streak >= 3 ? 'Right, ' + st.streak + ' in a row!' : 'Right!') : 'Not quite.') + '</b> ' + (ok ? '' : 'The answer is <b>' + esc(q.opts[q.right]) + '</b>. ') + esc(q.why);
    $('quizBody').querySelector('.qm-score').innerHTML = st.score + ' right' + (st.streak >= 2 ? ' · <b class="qm-streak">' + st.streak + ' in a row</b>' : '');
    $('quizBody').querySelector('.qm-prog i').style.width = ((st.i + 1) / st.qs.length * 100).toFixed(1) + '%';
    const nb = $('quizNext'); nb.disabled = false; nb.focus({ preventScroll: true });
    if (ok && st.streak >= 3 && window.Fx) {
      const r = nb.getBoundingClientRect(); try { Fx.confetti(r.left + r.width / 2, r.top, 24); } catch (e) { /* ignore */ }
    }
    why.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function next() {
    if (!st || !st.answered) return;
    play('click');
    st.i++;
    if (st.i >= st.qs.length) renderEnd(); else renderQ();
  }

  function renderEnd() {
    top();
    const n = st.answered ? st.i + (st.i < st.qs.length ? 1 : 0) : st.i;
    const total = Math.max(1, Math.min(n, st.qs.length));
    const pct = st.score / total;
    const best = load('quizBest', {});
    const full = total === st.qs.length;
    const isBest = full && (best[st.topic] == null || st.score > best[st.topic]);
    if (isBest) { best[st.topic] = st.score; save('quizBest', best); }
    const r = 44; const c = 2 * Math.PI * r;
    const msg = pct === 1 ? 'Perfect round. You know your stuff.' : pct >= 0.8 ? 'Strong round. A couple to review below.' : pct >= 0.5 ? 'Good start. The answers below are worth a read.' : 'Every miss is something you now know. Have a look below, then try again.';
    const col = pct >= 0.8 ? 'var(--up)' : pct >= 0.5 ? 'var(--warn)' : 'var(--down)';
    play(pct >= 0.5 ? 'win' : 'notify');
    $('quizBody').innerHTML =
      '<div class="qm-end"><div class="qm-ring"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="' + r + '"/><circle class="bar" cx="50" cy="50" r="' + r + '" style="stroke:' + col + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + c.toFixed(1) + '" data-off="' + (c * (1 - pct)).toFixed(1) + '"/></svg><div><b class="num">' + st.score + '<small>/' + total + '</small></b><span>' + esc(topicName(st.topic)) + '</span></div></div>' +
      '<h3>' + esc(msg) + '</h3>' +
      '<p class="qm-meta num">' + (isBest ? '<span class="qm-best">New best score</span> · ' : best[st.topic] != null ? 'Best: ' + best[st.topic] + '/' + st.qs.length + ' · ' : '') + 'Longest streak: ' + st.bestStreak + '</p>' +
      (st.missed.length ? '<div class="qm-review"><div class="qm-sub">Review your misses</div>' + st.missed.map((q) => '<div class="qm-rv"><b>' + esc(q.q) + '</b><span class="up-t">' + esc(q.opts[q.right]) + '</span><small>' + esc(q.why) + '</small></div>').join('') + '</div>' : '') +
      '<div class="qm-foot"><button class="ghost-btn" id="quizTopics" data-sound="click">Change topic</button><button class="primary-btn qm-next" id="quizAgain" data-sound="none"><span>Play again</span></button></div></div>';
    requestAnimationFrame(() => requestAnimationFrame(() => { const b = $('quizBody').querySelector('.qm-ring .bar'); if (b) b.style.strokeDashoffset = b.dataset.off; }));
    if (pct === 1 && window.Fx) { try { Fx.confetti(innerWidth / 2, innerHeight / 3, 90); } catch (e) { /* ignore */ } }
    $('quizAgain').addEventListener('click', () => start(st.topic));
    $('quizTopics').addEventListener('click', renderStart);
    st.done = true;
  }

  function onKey(e) {
    if ($('quizModal').hidden || !st || st.done) return;
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    const k = '1234'.indexOf(e.key);
    const ka = 'abcd'.indexOf((e.key || '').toLowerCase());
    if (!st.answered && (k >= 0 || ka >= 0)) { e.preventDefault(); e.stopPropagation(); answer(k >= 0 ? k : ka); }
    else if (st.answered && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next(); }
  }

  function init() {
    const m = $('quizModal');
    if (!m) return;
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
    m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey, true);
    const btn = $('quizBtn'); if (btn) btn.addEventListener('click', open);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.Quiz = { open, close };
})();
