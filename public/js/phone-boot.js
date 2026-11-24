/* iPhone build: decide the phone layout before the first paint (loaded in <head>). */
(function () {
  var root = document.documentElement;
  var mq = window.matchMedia('(max-width: 820px), (pointer: coarse) and (max-height: 520px)');
  function apply() { root.classList.toggle('phone', mq.matches); }
  apply();
  if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply);
  var tab = 'trade';
  try { tab = sessionStorage.getItem('pd.ptab') || 'trade'; } catch (e) { /* ignore */ }
  if (!/^(markets|trade|positions)$/.test(tab)) tab = 'trade';
  root.setAttribute('data-ptab', tab);
  if (window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) root.classList.add('standalone');
})();
