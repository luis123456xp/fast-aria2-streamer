// MV3 service worker: local server proxy
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const base = "http://127.0.0.1:7777";

      if (msg.type === "START_ARIA2") {
        const url = new URL(base + "/start");
        for (const [k, v] of Object.entries(msg.query || {})) url.searchParams.set(k, v);

        const headers = Object.assign({}, msg.headers || {});
        const sourceUrl = msg.query?.url;

        if (sourceUrl && chrome.cookies?.getAll) {
          try {
            const cookies = await chrome.cookies.getAll({ url: sourceUrl });
            const cookieHeader = cookies
              .map((cookie) => `${cookie.name}=${cookie.value}`)
              .join('; ');
            if (cookieHeader) headers['x-src-cookie'] = cookieHeader;
          } catch {}
        }

        const r = await fetch(url.toString(), { method: "GET", headers });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      if (msg.type === "STATUS") {
        const url = new URL(base + "/status");
        url.searchParams.set("id", msg.id);
        const r = await fetch(url.toString(), { method: "GET" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      if (msg.type === "FILE_URL") {
        const url = new URL(base + "/file");
        url.searchParams.set("id", msg.id);
        sendResponse({ ok: true, data: { url: url.toString() } });
        return;
      }

      if (msg.type === "DELETE") {
        const url = new URL(base + "/delete");
        url.searchParams.set("id", msg.id);
        const r = await fetch(url.toString(), { method: "GET" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      if (msg.type === "OPEN_FOLDER") {
        const r = await fetch(base + "/open-folder", { method: "GET" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      // Find an existing download/file for the same URL
      if (msg.type === "FIND_BY_URL") {
        const url = new URL(base + "/find");
        url.searchParams.set("url", msg.src);
        const r = await fetch(url.toString(), { method: "GET" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      // Find an existing download/file using several possible aliases
      if (msg.type === "FIND_BY_URLS") {
        const url = new URL(base + "/find");
        for (const item of msg.urls || []) {
          if (item) url.searchParams.append("url", item);
        }
        const r = await fetch(url.toString(), { method: "GET" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sendResponse({ ok: true, data: await r.json() });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async response
});
