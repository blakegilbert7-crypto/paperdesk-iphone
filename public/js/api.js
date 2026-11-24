/* Bridge to the trading engine: Electron IPC in the desktop app, the in-page engine in the
   iPhone/web build (window.Engine), HTTP in dev. */
(function () {
  const isDesktop = !!(window.desk && window.desk.invoke);
  const local = !isDesktop && !!(window.Engine && window.Engine.call);

  async function call(method, params) {
    let res;
    if (isDesktop) {
      res = await window.desk.invoke(method, params || {});
    } else if (local) {
      res = await window.Engine.call(method, params || {});
    } else {
      const r = await fetch('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}) });
      res = await r.json();
    }
    if (!res || !res.ok) throw new Error((res && res.error) || 'Something went wrong');
    return res.result;
  }

  function onEvent(cb) {
    if (isDesktop) {
      window.desk.onEvent(cb);
    } else if (local) {
      window.Engine.onEvent(cb);
    } else {
      const es = new EventSource('/api/events');
      es.onmessage = (m) => { try { cb(JSON.parse(m.data)); } catch (e) { /* ignore */ } };
    }
  }

  function notify(title, body) {
    if (isDesktop && window.desk.notify) window.desk.notify(title, body);
  }

  window.Api = { call, onEvent, notify, isDesktop, isWeb: local };
})();
