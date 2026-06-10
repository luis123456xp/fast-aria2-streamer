(function () {
  function findPlayableVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.find((v) => v.offsetWidth > 0 && v.offsetHeight > 0) || videos[0];
  }

  function getCanonicalPageUrl() {
    const canonical = document.querySelector('link[rel=\"canonical\"]')?.href;
    const ogUrl = document.querySelector('meta[property=\"og:url\"]')?.content;
    return canonical || ogUrl || location.href;
  }

  function normalizeCandidateUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  function getLookupCandidates(video) {
    const values = [
      video?.currentSrc,
      video?.src,
      video?.querySelector?.('source')?.src,
      getCanonicalPageUrl(),
      location.href
    ];

    const seen = new Set();
    return values
      .map(normalizeCandidateUrl)
      .filter((item) => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '-';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let x = n;
    while (x >= k && i < units.length - 1) {
      x /= k;
      i += 1;
    }
    return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${units[i]}`;
  }

  function fmtEta(seconds, etaText) {
    if (Number.isFinite(seconds) && seconds >= 0) {
      const s = Math.ceil(seconds);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      if (h > 0) return `${h}h ${m}m ${r}s`;
      if (m > 0) return `${m}m ${r}s`;
      return `${r}s`;
    }
    return etaText || '-';
  }

  function once(fn) {
    let done = false;
    return (...args) => {
      if (done) return;
      done = true;
      try { fn(...args); } catch (e) { console.error(e); }
    };
  }

  function el(tag, attrs = {}, html) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  const DEFAULT_CONNECTIONS = 16;
  const CONNECTION_STORAGE_KEY = 'aria2_connections_default';

  function getSavedConnections() {
    const saved = Number.parseInt(localStorage.getItem(CONNECTION_STORAGE_KEY) || '', 10);
    if (Number.isFinite(saved) && saved >= 1 && saved <= 16) return saved;
    return DEFAULT_CONNECTIONS;
  }

  function setSavedConnections(value) {
    const parsed = Number.parseInt(value, 10);
    const safe = Number.isFinite(parsed) ? Math.max(1, Math.min(16, parsed)) : DEFAULT_CONNECTIONS;
    localStorage.setItem(CONNECTION_STORAGE_KEY, String(safe));
    return safe;
  }

  if (!document.getElementById('aria2-launcher')) {
    const launcher = document.createElement('div');
    launcher.id = 'aria2-launcher';
    launcher.innerHTML = `
      <button id="aria2-replace" title="Descargar con aria2">aria2</button>
      <div id="aria2-launcher-panel" class="aria2-launcher-panel" style="display:none;">
        <label class="aria2-field">
          <span>Conexiones</span>
          <input id="aria2-connections" type="number" min="1" max="16" step="1">
        </label>
        <button id="aria2-start" class="aria2-start-btn">Descargar con aria2</button>
      </div>
    `;
    document.documentElement.appendChild(launcher);
  }

  const btnDL = document.getElementById('aria2-start');
  const btnToggleLauncher = document.getElementById('aria2-replace');
  const launcherPanel = document.getElementById('aria2-launcher-panel');
  const connectionsInput = document.getElementById('aria2-connections');

  if (connectionsInput) connectionsInput.value = String(getSavedConnections());

  btnToggleLauncher?.addEventListener('click', () => {
    if (!launcherPanel) return;
    launcherPanel.style.display = launcherPanel.style.display === 'none' ? 'block' : 'none';
  });

  connectionsInput?.addEventListener('change', () => {
    connectionsInput.value = String(setSavedConnections(connectionsInput.value));
  });

  let dot = document.getElementById('aria2-dot');
  if (!dot) {
    dot = el('div', {
      id: 'aria2-dot',
      style: {
        position: 'fixed', right: '18px', bottom: '76px', zIndex: '2147483647',
        width: '14px', height: '14px', borderRadius: '50%', background: '#00d4ff',
        boxShadow: '0 0 10px rgba(0,212,255,.8), 0 0 2px rgba(0,0,0,.6)',
        cursor: 'pointer', display: 'none'
      }
    });
    document.documentElement.appendChild(dot);
  }

  let panel = null;
  let statusTimer = null;
  let currentJobId = null;
  let keepOnClose = false;
  let localPlayerActive = false;
  let originalVideoUrl = null;
  let retriedLowConnection = false;

  let lastAutoAttachKey = '';
  let autoAttachTimer = null;

  async function findExistingDownload(video) {
    const candidates = getLookupCandidates(video);
    if (!candidates.length) return null;

    const found = await chrome.runtime.sendMessage({ type: 'FIND_BY_URLS', urls: candidates });
    if (found?.ok && found.data?.ok && found.data.found && found.data.id) {
      return found.data;
    }
    return null;
  }

  async function autoAttachIfExists(force = false) {
    try {
      const video = findPlayableVideo();
      if (!video) return;

      const candidates = getLookupCandidates(video);
      if (!candidates.length) return;

      const key = candidates.join('|');
      if (!force && key === lastAutoAttachKey && localPlayerActive) return;
      lastAutoAttachKey = key;

      const found = await findExistingDownload(video);
      if (!found) return;

      currentJobId = found.id;
      originalVideoUrl = video.currentSrc || video.src || candidates[0];

      if (found.done) {
        if (!localPlayerActive) await installLocalPlayer(video, currentJobId, true);
        return;
      }

      if (!panel) buildPanel();
      showState('Retomando descarga existente.');
      startPolling(video);
    } catch {}
  }

  function scheduleAutoAttach(force = false) {
    clearTimeout(autoAttachTimer);
    autoAttachTimer = setTimeout(() => autoAttachIfExists(force), 350);
  }

  scheduleAutoAttach(true);

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    scheduleAutoAttach(true);
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    scheduleAutoAttach(true);
    return result;
  };

  window.addEventListener('popstate', () => scheduleAutoAttach(true));
  window.addEventListener('hashchange', () => scheduleAutoAttach(true));

  const observer = new MutationObserver(() => scheduleAutoAttach(false));
  observer.observe(document.documentElement, { childList: true, subtree: true });

  btnDL.addEventListener('click', async () => {
    const video = findPlayableVideo();
    if (!video) { alert('No se encontro video.'); return; }
    const src = video.currentSrc || video.src;
    if (!src) { alert('No hay fuente de video.'); return; }

    originalVideoUrl = src;
    localPlayerActive = false;
    retriedLowConnection = false;

    const existing = await findExistingDownload(video);
    if (existing?.done && existing.id) {
      currentJobId = existing.id;
      buildPanel();
      showState('Este video ya estaba descargado. Insertando reproductor local.');
      await installLocalPlayer(video, currentJobId, true);
      finishPanel();
      return;
    }

    const pageHeaders = {
      'x-src-referrer': document.referrer || location.href,
      'x-src-cookie': document.cookie || '',
      'x-src-ua': navigator.userAgent
    };

    buildPanel();

    try {
      const selectedConnections = setSavedConnections(connectionsInput?.value || String(DEFAULT_CONNECTIONS));
      const lookupCandidates = getLookupCandidates(video);
      const params = {
        url: new URL(src, location.href).href,
        pageUrl: normalizeCandidateUrl(location.href) || location.href,
        canonicalUrl: normalizeCandidateUrl(getCanonicalPageUrl()) || getCanonicalPageUrl(),
        aliases: lookupCandidates.join('\n'),
        connections: String(selectedConnections),
        split: String(selectedConnections)
      };
      const start = await chrome.runtime.sendMessage({ type: 'START_ARIA2', query: params, headers: pageHeaders });
      if (!start?.ok || !start.data?.id) { showError(start?.error || 'Fallo al iniciar aria2'); return; }
      currentJobId = start.data.id;

      if (start.data.alreadyExists && start.data.done) {
        showState('Este video ya estaba descargado. Insertando reproductor local.');
        await installLocalPlayer(video, currentJobId, true);
        finishPanel();
        return;
      }

      if (start.data.alreadyExists && !start.data.done) {
        showState('Ya existia una descarga activa para este video. Retomando progreso.');
        startPolling(video);
        return;
      }

      showState(`Descarga iniciada con ${selectedConnections} conexiones. El reproductor local se activara al terminar.`);
      startPolling(video);
    } catch (e) {
      showError(e.message || 'Error inesperado');
    }
  });

  async function restartWithSingleConnection(video) {
    if (!originalVideoUrl || retriedLowConnection) return false;
    retriedLowConnection = true;

    const pageHeaders = {
      'x-src-referrer': location.href,
      'x-src-origin': location.origin,
      'x-src-cookie': document.cookie || '',
      'x-src-ua': navigator.userAgent,
      'x-src-accept': 'video/webm,video/mp4,video/*,*/*;q=0.8',
      'x-src-accept-language': navigator.languages?.join(',') || navigator.language || 'es-MX,es;q=0.9,en;q=0.8'
    };

    showState('El servidor rechazo la descarga multiple. Reintentando con una conexion.');
    const videoCandidates = getLookupCandidates(video);
    const params = {
      url: new URL(originalVideoUrl, location.href).href,
      pageUrl: normalizeCandidateUrl(location.href) || location.href,
      canonicalUrl: normalizeCandidateUrl(getCanonicalPageUrl()) || getCanonicalPageUrl(),
      aliases: videoCandidates.join('\n'),
      connections: '1',
      split: '1'
    };
    const start = await chrome.runtime.sendMessage({ type: 'START_ARIA2', query: params, headers: pageHeaders });
    if (!start?.ok || !start.data?.id) return false;
    currentJobId = start.data.id;
    localPlayerActive = false;
    if (start.data.alreadyExists && start.data.done) {
      await installLocalPlayer(video, currentJobId, true);
      finishPanel();
      return true;
    }
    startPolling(video);
    return true;
  }

  function startPolling(video) {
    clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
      try {
        const st = await chrome.runtime.sendMessage({ type: 'STATUS', id: currentJobId });
        if (!st?.ok && !st?.data) { showError(st?.error || 'STATUS no OK'); return; }
        const data = st.data || st;
        if (data.error && String(data.error).includes('status=403')) {
          clearInterval(statusTimer);
          statusTimer = null;
          const restarted = await restartWithSingleConnection(video);
          if (!restarted) updatePanel(data);
          return;
        }

        updatePanel(data);

        if (data.done) {
          clearInterval(statusTimer);
          statusTimer = null;
          if (!localPlayerActive && video && currentJobId) {
            await installLocalPlayer(video, currentJobId, true);
          }
          finishPanel();
        }
      } catch {
        showError('Excepcion en STATUS');
      }
    }, 800);
  }

  function removeLocalReturnButton(parent) {
    const existing = parent?.querySelector?.('#aria2-return-local');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function showLocalReturnButton(parent, video, id, completed) {
    if (!parent || !video || !id) return;
    removeLocalReturnButton(parent);

    const button = document.createElement('button');
    button.id = 'aria2-return-local';
    button.className = 'aria2-return-local';
    button.textContent = 'Volver a local';
    button.addEventListener('click', async () => {
      removeLocalReturnButton(parent);
      await installLocalPlayer(video, id, completed);
    });

    if (!parent.dataset.aria2OriginalPosition) {
      parent.dataset.aria2OriginalPosition = parent.style.position || '';
    }
    parent.style.position = parent.style.position || 'relative';
    parent.appendChild(button);
  }

  async function installLocalPlayer(video, id, completed) {
    const fileUrl = `http://127.0.0.1:7777/file?id=${encodeURIComponent(id)}&t=${Date.now()}`;
    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const wasPaused = video.paused;
    const originalParent = video.parentElement;

    if (!originalParent) return;

    removeLocalReturnButton(originalParent);

    const rect = video.getBoundingClientRect();
    const parentRect = originalParent.getBoundingClientRect();
    const playerWidth = Math.round(rect.width || parentRect.width || 640);
    const playerHeight = Math.round(rect.height || parentRect.height || 360);

    if (!originalParent.dataset.aria2OriginalPosition) {
      originalParent.dataset.aria2OriginalPosition = originalParent.style.position || '';
    }
    if (!originalParent.dataset.aria2OriginalMinHeight) {
      originalParent.dataset.aria2OriginalMinHeight = originalParent.style.minHeight || '';
    }
    if (!originalParent.dataset.aria2OriginalBackground) {
      originalParent.dataset.aria2OriginalBackground = originalParent.style.background || '';
    }

    originalParent.style.position = originalParent.style.position || 'relative';
    originalParent.style.minHeight = `${playerHeight}px`;
    originalParent.style.background = '#000';

    let mount = document.getElementById('aria2-local-player-zone');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'aria2-local-player-zone';
      mount.className = 'aria2-local-player-zone';
      originalParent.appendChild(mount);
    } else if (mount.parentElement !== originalParent) {
      mount.parentElement?.removeChild(mount);
      originalParent.appendChild(mount);
    }

    mount.style.width = `${playerWidth}px`;
    mount.style.height = `${playerHeight}px`;

    const hiddenNodes = [];
    Array.from(originalParent.children).forEach((child) => {
      if (child === mount || child.id === 'aria2-return-local') return;
      if (!child.dataset.aria2OriginalDisplay) child.dataset.aria2OriginalDisplay = child.style.display || '';
      child.style.display = 'none';
      hiddenNodes.push(child);
    });

    video.pause();
    video.dataset.aria2OriginalDisplay = video.dataset.aria2OriginalDisplay || video.style.display || '';
    video.style.display = 'none';

    mount.innerHTML = '';

    const localVideo = document.createElement('video');
    localVideo.id = 'aria2-local-video';
    localVideo.className = 'aria2-local-video';
    localVideo.controls = true;
    localVideo.autoplay = true;
    localVideo.loop = true;
    localVideo.preload = 'auto';
    localVideo.playsInline = true;
    localVideo.src = fileUrl;

    const topBar = document.createElement('div');
    topBar.className = 'aria2-local-topbar';

    const topLabel = document.createElement('span');
    topLabel.className = 'aria2-local-label';
    topLabel.textContent = completed ? 'Reproductor local' : 'Reproductor local con descarga activa';

    const restoreButton = document.createElement('button');
    restoreButton.className = 'aria2-local-restore';
    restoreButton.textContent = 'Restaurar original';

    topBar.appendChild(topLabel);
    topBar.appendChild(restoreButton);
    mount.appendChild(localVideo);
    mount.appendChild(topBar);

    localPlayerActive = true;

    const restoreOriginal = () => {
      try { localVideo.pause(); } catch {}
      hiddenNodes.forEach((node) => {
        node.style.display = node.dataset.aria2OriginalDisplay || '';
        delete node.dataset.aria2OriginalDisplay;
      });
      if (mount && mount.parentNode) mount.parentNode.removeChild(mount);
      video.style.display = video.dataset.aria2OriginalDisplay || '';
      originalParent.style.position = originalParent.dataset.aria2OriginalPosition || '';
      originalParent.style.minHeight = originalParent.dataset.aria2OriginalMinHeight || '';
      originalParent.style.background = originalParent.dataset.aria2OriginalBackground || '';
      delete originalParent.dataset.aria2OriginalPosition;
      delete originalParent.dataset.aria2OriginalMinHeight;
      delete originalParent.dataset.aria2OriginalBackground;
      localPlayerActive = false;
      showLocalReturnButton(originalParent, video, id, completed);
      try {
        if (currentTime > 0 && Number.isFinite(video.duration)) {
          video.currentTime = Math.min(currentTime, Math.max(0, video.duration - 1));
        }
      } catch {}
      if (!wasPaused) video.play().catch(() => {});
      showState('Se restauro el reproductor original.');
    };

    restoreButton.addEventListener('click', restoreOriginal);

    localVideo.addEventListener('loadedmetadata', () => {
      try {
        if (currentTime > 0 && Number.isFinite(localVideo.duration)) {
          localVideo.currentTime = Math.min(currentTime, Math.max(0, localVideo.duration - 1));
        }
      } catch {}
      localVideo.play().catch(() => {
        showState('El navegador bloqueo la reproduccion automatica. Presiona play en el reproductor local.');
      });
    }, { once: true });

    localVideo.addEventListener('ended', () => {
      try {
        localVideo.currentTime = 0;
        localVideo.play().catch(() => {});
      } catch {}
    });

    localVideo.addEventListener('waiting', () => {
      showState('Buffer local insuficiente. Esperando a aria2.');
    });

    localVideo.addEventListener('playing', () => {
      showState('Reproduciendo archivo local descargado.');
    });

    localVideo.addEventListener('error', () => {
      const mediaError = localVideo.error;
      const code = mediaError ? mediaError.code : 'unknown';
      showState(`El reproductor local no pudo decodificar el archivo. Codigo ${code}.`);
      if (!completed) {
        setTimeout(() => {
          if (!localPlayerActive) return;
          const retryTime = Number.isFinite(localVideo.currentTime) ? localVideo.currentTime : currentTime;
          localVideo.src = `http://127.0.0.1:7777/file?id=${encodeURIComponent(id)}&retry=${Date.now()}`;
          localVideo.load();
          localVideo.addEventListener('loadedmetadata', () => {
            try {
              if (retryTime > 0 && Number.isFinite(localVideo.duration)) {
                localVideo.currentTime = Math.min(retryTime, Math.max(0, localVideo.duration - 1));
              }
            } catch {}
            localVideo.play().catch(() => {});
          }, { once: true });
        }, 2500);
      }
    });

    localVideo.load();
    setTimeout(() => {
      localVideo.play().catch(() => {
        showState('El navegador bloqueo la reproduccion automatica. Presiona play en el reproductor local.');
      });
    }, 300);
  }

  function buildPanel() {
    destroyPanel(false);
    panel = document.createElement('div');
    panel.id = 'aria2-floating';
    panel.innerHTML = `
      <div class="aria2-card">
        <div class="aria2-row">
          <strong id="aria2-title">Descargando video...</strong>
          <div class="aria2-actions">
            <label class="aria2-keep"><input type="checkbox" id="aria2-keep"> Mantener al cerrar</label>
            <button id="aria2-min" class="aria2-btn" title="Minimizar">Minimizar</button>
          </div>
        </div>
        <div class="aria2-progress-wrap">
          <div id="aria2-progress" class="aria2-progress"></div>
        </div>
        <div class="aria2-stats">
          <span id="aria2-dl">0 / -</span>
          <span id="aria2-percent">0%</span>
          <span id="aria2-speed">0 B/s</span>
          <span id="aria2-eta">ETA -</span>
        </div>
        <div id="aria2-state" class="aria2-state">Preparando...</div>
        <div class="aria2-row" id="aria2-done" style="display:none; gap:8px;">
          <button id="aria2-open" class="aria2-btn">Abrir carpeta local</button>
          <button id="aria2-delete" class="aria2-btn danger">Eliminar archivo</button>
          <button id="aria2-close" class="aria2-btn">Cerrar</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector('#aria2-min').addEventListener('click', () => {
      panel.style.display = 'none';
      dot.style.display = 'block';
    });

    dot.onclick = () => {
      dot.style.display = 'none';
      if (panel) panel.style.display = 'block';
    };

    panel.querySelector('#aria2-keep').addEventListener('change', (event) => {
      keepOnClose = !!event.target.checked;
    });

    setTimeout(() => {
      if (!panel) return;
      panel.style.display = 'none';
      dot.style.display = 'block';
    }, 250);

    panel.querySelector('#aria2-open').addEventListener('click', async () => {
      try {
        const result = await chrome.runtime.sendMessage({ type: 'OPEN_FOLDER' });
        if (!result?.ok) alert(result?.error || 'No se pudo abrir la carpeta.');
      } catch {
        alert('No se pudo abrir la carpeta.');
      }
    });

    panel.querySelector('#aria2-delete').addEventListener('click', async () => {
      if (!currentJobId) return;
      await chrome.runtime.sendMessage({ type: 'DELETE', id: currentJobId });
      destroyPanel(true);
    });

    panel.querySelector('#aria2-close').addEventListener('click', () => destroyPanel(false));

    window.addEventListener('pagehide', () => {
      if (currentJobId && !keepOnClose) {
        fetch(`http://127.0.0.1:7777/delete?id=${encodeURIComponent(currentJobId)}`, {
          method: 'GET', keepalive: true, mode: 'no-cors'
        }).catch(() => {});
      }
    }, { once: true });
  }

  function updatePanel(data) {
    if (!panel) return;
    const dl = panel.querySelector('#aria2-dl');
    const sp = panel.querySelector('#aria2-speed');
    const eta = panel.querySelector('#aria2-eta');
    const pct = panel.querySelector('#aria2-percent');
    const progress = panel.querySelector('#aria2-progress');

    const downloaded = Number.isFinite(data.downloaded) ? data.downloaded : 0;
    const total = Number.isFinite(data.total) && data.total > 0 ? data.total : -1;
    const percent = Number.isFinite(data.percent) ? Math.max(0, Math.min(100, data.percent)) : (total > 0 ? Math.floor((downloaded / total) * 100) : 0);
    const speed = Number.isFinite(data.speedBps) ? data.speedBps : 0;

    dl.textContent = `${fmtBytes(downloaded)} / ${total > 0 ? fmtBytes(total) : '-'}`;
    sp.textContent = `${fmtBytes(speed)}/s`;
    eta.textContent = `ETA ${fmtEta(data.etaSeconds, data.etaText)}`;
    pct.textContent = `${percent}%`;
    progress.style.width = `${percent}%`;

    if (data.error) showError(data.error);
    else if (!data.done) showState('Descargando con aria2. El reproductor local se activara al finalizar.');
  }

  function showState(text) {
    const state = panel?.querySelector('#aria2-state');
    if (state) state.textContent = text;
  }

  function showError(text) {
    const state = panel?.querySelector('#aria2-state');
    if (state) state.textContent = 'Error: ' + text;
  }

  function finishPanel() {
    if (!panel) return;
    panel.querySelector('#aria2-title').textContent = 'Listo: video descargado';
    panel.querySelector('#aria2-done').style.display = 'flex';
    const progress = panel.querySelector('#aria2-progress');
    const pct = panel.querySelector('#aria2-percent');
    if (progress) progress.style.width = '100%';
    if (pct) pct.textContent = '100%';
    showState('Completado.');
  }

  function destroyPanel(resetJob) {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    keepOnClose = false;
    if (resetJob) currentJobId = null;
    if (dot) dot.style.display = 'none';
  }
})();
