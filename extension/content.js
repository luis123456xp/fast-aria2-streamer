(function () {
  // --- Utils ---
  function isLikelyMp4Url(raw) {
    try {
      const u = new URL(raw, location.href);
      if (/\.mp4(\?|$)/i.test(u.pathname)) return true;
      const f = u.searchParams.get('file');
      if (f && /\.mp4$/i.test(decodeURIComponent(f))) return true;
      return false;
    } catch { return false; }
  }
  function findPlayableVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    return vids.find(v => v.offsetWidth > 0 && v.offsetHeight > 0) || vids[0];
  }
  function fmtBytes(n){
    if (n == null) return '—';
    const u = ['B','KB','MB','GB','TB']; let i=0; let x=n;
    while (x>=1024 && i<u.length-1){ x/=1024; i++; }
    return `${x.toFixed(x>=100?0:x>=10?1:2)} ${u[i]}`;
  }
  function fmtTime(s){
    if (s == null) return '—';
    s = Math.max(0, s|0);
    const h = (s/3600)|0, m=((s%3600)/60)|0, ss=s%60;
    return h?`${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${m}:${String(ss).padStart(2,'0')}`;
  }

  // --- UI principal (botón para descargar y reemplazar) ---
  const btnDL = document.createElement('button');
  btnDL.id = 'aria2-replace';
  btnDL.textContent = '⬇ Descargar y reemplazar';
  document.documentElement.appendChild(btnDL);

  // Panel flotante
  let panel = null;
  let statusTimer = null;
  let currentJobId = null;
  let keepOnClose = false;

  // Cabeceras de la página para el servidor/aria2
  const pageHeaders = {
    'x-src-referrer': location.href,
    'x-src-cookie': document.cookie || '',
    'x-src-ua': navigator.userAgent
  };

  btnDL.addEventListener('click', async () => {
    const video = findPlayableVideo();
    if (!video) { alert('No se encontró <video>.'); return; }

    const src = video.currentSrc || video.src;
    if (!src || !isLikelyMp4Url(src)) {
      if (!confirm('No parece MP4 directo, ¿intentar de todos modos con aria2?')) return;
    }

    try {
      // 1) Arranca descarga
      const params = { url: new URL(src, location.href).href, connections: '16', split: '16' };
      const start = await chrome.runtime.sendMessage({ type: 'START_ARIA2', query: params, headers: pageHeaders });
      if (!start?.ok) throw new Error('Fallo al iniciar aria2');
      currentJobId = start.data.id;

      // 2) Crea panel flotante (no tapa al video)
      buildPanel();

      // 3) Poll de estado y ETA
      clearInterval(statusTimer);
      statusTimer = setInterval(async () => {
        try {
          const st = await chrome.runtime.sendMessage({ type: 'STATUS', id: currentJobId });
          if (!st?.ok) return;
          const d = st.data;
          updatePanel(d);
          if (d.done) {
            clearInterval(statusTimer);
            await swapToLocalFile(video, currentJobId);
            finishPanel(); // cambia a estado "listo" con acciones
          }
        } catch {}
      }, 800);
    } catch (e) {
      console.error(e);
      alert('Error: ' + e.message);
    }
  });

  async function swapToLocalFile(video, id) {
    const fileUrl = `http://127.0.0.1:7777/file?id=${encodeURIComponent(id)}`;
    try { video.pause(); } catch {}
    video.preload = 'auto';
    video.src = fileUrl;
    try { video.load(); } catch {}
  }

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'aria2-floating';
    panel.innerHTML = `
      <div class="aria2-card">
        <div class="aria2-row">
          <strong id="aria2-title">Descargando video…</strong>
          <div class="aria2-actions">
            <label class="aria2-keep"><input type="checkbox" id="aria2-keep"> Mantener al cerrar</label>
            <button id="aria2-cancel" class="aria2-btn danger">Cancelar</button>
          </div>
        </div>
        <div class="aria2-bar"><div class="aria2-bar-fill" style="width:0%"></div></div>
        <div class="aria2-stats">
          <span id="aria2-pct">0%</span>
          <span id="aria2-dl">0 / —</span>
          <span id="aria2-speed">0 MB/s</span>
          <span id="aria2-eta">ETA —</span>
        </div>
        <div class="aria2-row" id="aria2-done" style="display:none; gap:8px;">
          <button id="aria2-close" class="aria2-btn">Cerrar</button>
          <button id="aria2-delete" class="aria2-btn danger">Eliminar archivo</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector('#aria2-cancel').addEventListener('click', async () => {
      if (!currentJobId) return;
      await chrome.runtime.sendMessage({ type: 'CANCEL', id: currentJobId });
      await chrome.runtime.sendMessage({ type: 'DELETE', id: currentJobId });
      clearInterval(statusTimer);
      destroyPanel();
    });
    panel.querySelector('#aria2-keep').addEventListener('change', (e) => {
      keepOnClose = !!e.target.checked;
    });
    panel.querySelector('#aria2-close').addEventListener('click', () => destroyPanel());
    panel.querySelector('#aria2-delete').addEventListener('click', async () => {
      if (!currentJobId) return;
      await chrome.runtime.sendMessage({ type: 'DELETE', id: currentJobId });
      destroyPanel();
    });

    // Si el usuario cierra la pestaña y NO marcó "mantener", intenta borrar
    window.addEventListener('pagehide', () => {
      if (currentJobId && !keepOnClose) {
        // Intento best-effort sin bloquear el cierre
        fetch(`http://127.0.0.1:7777/delete?id=${encodeURIComponent(currentJobId)}`, {
          method: 'GET',
          keepalive: true,
          mode: 'no-cors' // ignoramos CORS en cierre
        }).catch(()=>{});
      }
    }, { once: true });
  }

  function updatePanel(d) {
    if (!panel) return;
    const pct = panel.querySelector('#aria2-pct');
    const dl  = panel.querySelector('#aria2-dl');
    const sp  = panel.querySelector('#aria2-speed');
    const eta = panel.querySelector('#aria2-eta');
    const fill = panel.querySelector('.aria2-bar-fill');

    const p = (d.pct != null) ? d.pct : Math.floor((d.downloaded || 0) / Math.max(1, (d.total || 1)) * 100);
    pct.textContent = isFinite(p) ? `${p}%` : '—';
    dl.textContent  = `${fmtBytes(d.downloaded)} / ${fmtBytes(d.total)}`;
    sp.textContent  = `${fmtBytes(d.speedBps)}/s`;
    eta.textContent = `ETA ${fmtTime(d.etaSec)}`;
    fill.style.width = isFinite(p) ? `${p}%` : '0%';
  }

  function finishPanel() {
    if (!panel) return;
    panel.querySelector('#aria2-title').textContent = 'Listo: video descargado';
    panel.querySelector('#aria2-done').style.display = 'flex';
  }

  function destroyPanel() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    currentJobId = null;
    keepOnClose = false;
  }
})();
