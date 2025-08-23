(function () {
  // === Utils ===
  function isLikelyMp4Url(raw) {
    try {
      const u = new URL(raw, location.href);
      if (/\.mp4(\?|$)/i.test(u.pathname)) return true;
      const f = u.searchParams.get('file');
      return !!(f && /\.mp4$/i.test(decodeURIComponent(f)));
    } catch { return false; }
  }
  function findPlayableVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    return vids.find(v => v.offsetWidth > 0 && v.offsetHeight > 0) || vids[0];
  }
  function fmtBytes(n){
    if (!Number.isFinite(n) || n < 0) return '—';
    const k = 1024, u = ['B','KB','MB','GB','TB']; let i=0, x=n;
    while (x>=k && i<u.length-1){ x/=k; i++; }
    return `${x.toFixed(x>=100?0:x>=10?1:2)} ${u[i]}`;
  }
  function once(fn){ let done=false; return (...a)=>{ if(done) return; done=true; try{ fn(...a);}catch(e){console.error(e);} }; }
  function el(tag, attrs={}, html){
    const n = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    }
    if (html != null) n.innerHTML = html;
    return n;
  }

  // === Botón para disparar la descarga ===
  if (!document.getElementById('aria2-replace')) {
    const btn = document.createElement('button');
    btn.id = 'aria2-replace';
    btn.textContent = 'Descargar con aria2';
    document.documentElement.appendChild(btn);
  }
  const btnDL = document.getElementById('aria2-replace');

  // Punto flotante (minimizado) con estilos inline (fallback)
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

  // === Estado ===
  let panel = null, statusTimer = null, currentJobId = null, keepOnClose = false;

  // === Precarga: al abrir, si ya existe descarga/archivo para la misma URL → swap/retoma ===
  (async function autoAttachIfExists(){
    try {
      const v = findPlayableVideo();
      if (!v) return;
      const src = v.currentSrc || v.src;
      if (!src) return;

      // Pregunta al backend si ya hay un job o archivo para esta URL
      const found = await chrome.runtime.sendMessage({ type: 'FIND_BY_URL', src });
      if (!found?.ok || !found.data?.ok) return;
      if (!found.data.found) return;

      // Si existe y está terminado, haz swap inmediato
      if (found.data.done && found.data.id) {
        await swapToLocalFile(v, found.data.id);
        return;
      }
      // Si existe y está en curso, muestra panel y retoma polling
      if (!found.data.done && found.data.id) {
        currentJobId = found.data.id;
        buildPanel();
        showState('Reanudando estado…');
        startPolling();
      }
    } catch {}
  })();

  // === Click: iniciar (sin confirm de MP4; obedecemos al usuario) ===
  btnDL.addEventListener('click', async () => {
    const video = findPlayableVideo();
    if (!video) { alert('No se encontró <video>.'); return; }
    const src = video.currentSrc || video.src;
    if (!src) { alert('No hay fuente de video.'); return; }

    // Cabeceras EXACTAS que consume tu server
    const pageHeaders = {
      'x-src-referrer': document.referrer || location.href,
      'x-src-cookie': document.cookie || '',
      'x-src-ua': navigator.userAgent
    };

    buildPanel();

    try {
      // /start (GET) — igual que tu backend
      const params = { url: new URL(src, location.href).href, connections: '16', split: '16' };
      const start = await chrome.runtime.sendMessage({ type: 'START_ARIA2', query: params, headers: pageHeaders });
      if (!start?.ok || !start.data?.id) { showError(start?.error || 'Fallo al iniciar aria2'); return; }
      currentJobId = start.data.id;
      showState('Descarga iniciada.');
      startPolling();
    } catch (e) {
      showError(e.message || 'Error inesperado');
    }
  });

  function startPolling() {
    const doSwapOnce = once(async () => {
      const v = findPlayableVideo();
      if (v) await swapToLocalFile(v, currentJobId);
    });

    clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
      try {
        const st = await chrome.runtime.sendMessage({ type: 'STATUS', id: currentJobId });
        if (!st?.ok) { showError(st?.error || 'STATUS no OK'); return; }
        const d = st.data || {};
        updatePanel(d);

        if (d.done) {
          clearInterval(statusTimer);
          await doSwapOnce();
          finishPanel();
        }
      } catch {
        showError('Excepción en STATUS');
      }
    }, 800);
  }

  // === Acciones ===
  async function swapToLocalFile(video, id) {
    const fileUrl = `http://127.0.0.1:7777/file?id=${encodeURIComponent(id)}`;
    try { video.pause(); } catch {}
    video.preload = 'auto';
    video.controls = true;
    video.src = fileUrl;
    try { video.load(); } catch {}
    setTimeout(() => { try { video.play(); } catch {} }, 200);
  }

  function buildPanel() {
    destroyPanel();
    panel = document.createElement('div');
    panel.id = 'aria2-floating';
    panel.innerHTML = `
      <div class="aria2-card">
        <div class="aria2-row">
          <strong id="aria2-title">Descargando video…</strong>
          <div class="aria2-actions">
            <label class="aria2-keep"><input type="checkbox" id="aria2-keep"> Mantener al cerrar</label>
            <button id="aria2-min" class="aria2-btn" title="Minimizar">Minimizar</button>
          </div>
        </div>
        <div class="aria2-stats">
          <span id="aria2-dl">0 / —</span>
          <span id="aria2-speed">0 B/s</span>
        </div>
        <div id="aria2-state" class="aria2-state">Preparando…</div>
        <div class="aria2-row" id="aria2-done" style="display:none; gap:8px;">
          <button id="aria2-open" class="aria2-btn">Abrir carpeta local</button>
          <button id="aria2-delete" class="aria2-btn danger">Eliminar archivo</button>
          <button id="aria2-close" class="aria2-btn">Cerrar</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    // Minimizar -> punto
    panel.querySelector('#aria2-min').addEventListener('click', () => {
      panel.style.display = 'none';
      dot.style.display = 'block';
    });
    // Punto -> restaurar
    dot.onclick = () => { dot.style.display = 'none'; panel.style.display = 'block'; };

    panel.querySelector('#aria2-keep').addEventListener('change', (e) => { keepOnClose = !!e.target.checked; });

    // Abrir carpeta local (%TEMP%\aria2_streamer) vía backend
    panel.querySelector('#aria2-open').addEventListener('click', async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'OPEN_FOLDER' });
        if (!r?.ok) alert(r?.error || 'No se pudo abrir la carpeta.');
      } catch {
        alert('No se pudo abrir la carpeta.');
      }
    });

    panel.querySelector('#aria2-delete').addEventListener('click', async () => {
      if (!currentJobId) return;
      await chrome.runtime.sendMessage({ type: 'DELETE', id: currentJobId });
      destroyPanel();
    });

    panel.querySelector('#aria2-close').addEventListener('click', () => destroyPanel());

    // Limpieza al cerrar pestaña
    window.addEventListener('pagehide', () => {
      if (currentJobId && !keepOnClose) {
        fetch(`http://127.0.0.1:7777/delete?id=${encodeURIComponent(currentJobId)}`, {
          method: 'GET', keepalive: true, mode: 'no-cors'
        }).catch(()=>{});
      }
    }, { once: true });
  }

  function updatePanel(d) {
    if (!panel) return;
    const dl  = panel.querySelector('#aria2-dl');
    const sp  = panel.querySelector('#aria2-speed');

    const downloaded = Number.isFinite(d.downloaded) ? d.downloaded : 0;
    const total = Number.isFinite(d.total) && d.total > 0 ? d.total : -1;
    dl.textContent = `${fmtBytes(downloaded)} / ${total > 0 ? fmtBytes(total) : '—'}`;

    const speed = Number.isFinite(d.speedBps) ? d.speedBps : 0;
    sp.textContent = `${fmtBytes(speed)}/s`;

    if (typeof d.done === 'boolean' && !d.done) showState('Estado: descargando…');
  }

  function showState(text){ const st = panel?.querySelector('#aria2-state'); if (st) st.textContent = text; }
  function showError(text){ const st = panel?.querySelector('#aria2-state'); if (st) st.textContent = 'Error: ' + text; }

  function finishPanel() {
    if (!panel) return;
    panel.querySelector('#aria2-title').textContent = 'Listo: video descargado';
    panel.querySelector('#aria2-done').style.display = 'flex';
    showState('Completado.');
  }

  function destroyPanel() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    currentJobId = null;
    keepOnClose = false;
    if (dot) dot.style.display = 'none';
  }
})();
