// MV3 service worker: local server proxy
// Serializar registros y salidas evita borrar un archivo que usa otra pestaña.
let jobQueue = Promise.resolve();
function queueJobs(operation) {
  const result = jobQueue.then(operation);
  jobQueue = result.catch(() => {});
  return result;
}

async function deleteUnusedJobs(ids, owners) {
  const { keepOnClose = true } = await chrome.storage.local.get('keepOnClose');
  if (keepOnClose) return;
  for (const id of new Set(ids)) {
    if (Object.values(owners).some((owner) => owner.id === id)) continue;
    const response = await fetch(`http://127.0.0.1:7777/delete?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`No se pudo borrar la descarga: HTTP ${response.status}`);
  }
}

function ownerKey(sender) {
  return `${sender.tab.id}:${sender.documentId || sender.frameId || 0}`;
}

function trackJob(sender, id) {
  if (!sender.tab || !id) return Promise.resolve();
  return queueJobs(async () => {
    const { jobOwners = {}, releasedDocuments = {} } = await chrome.storage.session.get(['jobOwners', 'releasedDocuments']);
    const key = ownerKey(sender);
    const previous = jobOwners[key]?.id;
    let tab;
    try { tab = await chrome.tabs.get(sender.tab.id); } catch {}
    if (!tab || releasedDocuments[key] || (tab.url && tab.url !== sender.url)) {
      await deleteUnusedJobs([id], jobOwners);
      return;
    }
    jobOwners[key] = { tabId: sender.tab.id, id };
    await chrome.storage.session.set({ jobOwners });
    if (previous && previous !== id) await deleteUnusedJobs([previous], jobOwners);
  });
}

function releaseJobs(matches, documentKey) {
  return queueJobs(async () => {
    const { jobOwners = {}, releasedDocuments = {} } = await chrome.storage.session.get(['jobOwners', 'releasedDocuments']);
    for (const [key, time] of Object.entries(releasedDocuments)) {
      if (Date.now() - time > 3600000) delete releasedDocuments[key];
    }
    if (documentKey) releasedDocuments[documentKey] = Date.now();
    const released = [];
    for (const [key, owner] of Object.entries(jobOwners)) {
      if (!matches(key, owner)) continue;
      released.push(owner.id);
      delete jobOwners[key];
    }
    await chrome.storage.session.set({ jobOwners, releasedDocuments });
    await deleteUnusedJobs(released, jobOwners);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  releaseJobs((_key, owner) => owner.tabId === tabId).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const base = "http://127.0.0.1:7777";

      if (msg.type === 'TRACK_JOB') {
        await trackJob(sender, msg.id);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'RELEASE_JOBS' && sender.tab) {
        await releaseJobs((key) => key === ownerKey(sender), ownerKey(sender));
        sendResponse({ ok: true });
        return;
      }

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
        const data = await r.json();
        if (data.id) await trackJob(sender, data.id);
        sendResponse({ ok: true, data });
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
