// MV3 service worker: proxy de llamadas al servidor local con cabeceras de la página.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const base = 'http://127.0.0.1:7777';

      if (msg.type === 'START_ARIA2') {
        const url = new URL(base + '/start');
        for (const [k, v] of Object.entries(msg.query)) url.searchParams.set(k, v);
        const r = await fetch(url.toString(), { method: 'GET', headers: msg.headers || {} });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      if (msg.type === 'STATUS') {
        const url = new URL(base + '/status');
        url.searchParams.set('id', msg.id);
        const r = await fetch(url.toString(), { method: 'GET' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      if (msg.type === 'CANCEL') {
        const url = new URL(base + '/cancel');
        url.searchParams.set('id', msg.id);
        const r = await fetch(url.toString(), { method: 'GET' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      if (msg.type === 'DELETE') {
        const url = new URL(base + '/delete');
        url.searchParams.set('id', msg.id);
        const r = await fetch(url.toString(), { method: 'GET' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      if (msg.type === 'PROBE') {
        const url = new URL(base + '/probe');
        url.searchParams.set('url', msg.src);
        const r = await fetch(url.toString(), { method: 'GET', headers: msg.headers || {} });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // respuesta async
});
