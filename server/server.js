import express from 'express';
import helmet from 'helmet';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { URL as NodeURL } from 'url';

const app = express();

// Seguridad sin romper consumo cross-origin por <video src="http://127.0.0.1:7777/...">
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'unsafe-none' }
}));

// CORS permisivo
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, *');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = 7777;
// Guarda en carpeta temporal del sistema
const downloadsDir = path.join(os.tmpdir(), 'aria2_streamer');
fs.mkdirSync(downloadsDir, { recursive: true });

// TTL para autolimpieza (ms)
const TTL_MS = 30 * 60 * 1000; // 30 min

/** id -> { outPath, totalSize, contentType, pid, done, size, startedAt, lastBytes, lastAt, speedEMA, lastAccess } */
const jobs = new Map();

// Helpers
function waitFor(ms){ return new Promise(r => setTimeout(r, ms)); }
async function waitForFile(fp){ for(;;){ try{ fs.statSync(fp); return; } catch{ await waitFor(50); } } }
function statSize(fp){ try { return fs.statSync(fp).size; } catch { return 0; } }
function safeUnlink(fp){ try { fs.unlinkSync(fp); } catch {} }
function touchAccess(st){ st.lastAccess = Date.now(); }

// Obtiene tamaño final real y content-type del recurso remoto (HEAD o GET Range:0-0)
function fetchRemoteMeta(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new NodeURL(url);
      const client = u.protocol === 'https:' ? https : http;

      const headReq = client.request(url, { method: 'HEAD', headers }, (resp) => {
        const ct = resp.headers['content-type'] || '';
        const len = Number(resp.headers['content-length'] || NaN);
        const ar  = (resp.headers['accept-ranges'] || '').toLowerCase().includes('bytes');
        if (Number.isFinite(len) && len > 0) {
          resolve({ totalSize: len, contentType: ct || 'video/mp4', acceptRanges: ar, source: 'HEAD' });
        } else {
          const getReq = client.request(
            url,
            { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } },
            (r2) => {
              const cr = r2.headers['content-range'] || '';
              const m = /bytes \d+-\d+\/(\d+)/i.exec(cr);
              const len2 = m ? Number(m[1]) : undefined;
              const ct2 = r2.headers['content-type'] || ct || 'video/mp4';
              const ar2 = (r2.headers['accept-ranges'] || '').toLowerCase().includes('bytes') || ar;
              resolve({ totalSize: len2, contentType: ct2, acceptRanges: ar2, source: 'RANGE' });
              r2.resume();
            }
          );
          getReq.on('error', () => resolve({}));
          getReq.end();
        }
      });
      headReq.on('error', () => resolve({}));
      headReq.end();
    } catch {
      resolve({});
    }
  });
}

// --- Inicia aria2c y guarda meta del recurso ---
app.get('/start', async (req, res) => {
  const { url, connections, split } = req.query;
  if (!url) return res.status(400).send('Falta ?url=');

  const id = crypto.randomBytes(8).toString('hex');
  const outName = `${id}.mp4`;
  const outPath = path.join(downloadsDir, outName);

  const x = Math.max(1, Math.min(32, Number(connections ?? 16)));
  const s = Math.max(1, Math.min(32, Number(split ?? 16)));

  // Cabeceras de la página (enviadas por la extensión)
  const xRef = req.headers['x-src-referrer'];
  const xCookie = req.headers['x-src-cookie'];
  const xUA = req.headers['x-src-ua'];

  const passHeaders = {};
  if (xRef)    passHeaders['Referer'] = xRef;
  if (xCookie) passHeaders['Cookie'] = xCookie;
  if (xUA)     passHeaders['User-Agent'] = xUA;

  // Meta del origen: tamaño final y tipo
  const meta = await fetchRemoteMeta(url, passHeaders);
  const isVideoCT = (ct) => typeof ct === 'string' && /^video\/.+/i.test(ct);
  const remoteCT  = isVideoCT(meta.contentType) ? meta.contentType : 'video/mp4';
  const totalSize = meta.totalSize;

  // Lanza aria2c
  const args = [
    '--console-log-level=warn',
    '--summary-interval=1',
    '--file-allocation=none',
    `-x${x}`,
    `-s${s}`,
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--continue=true',
    '--check-certificate=false',
    ...(xRef    ? [`--header=Referer: ${xRef}`]   : []),
    ...(xCookie ? [`--header=Cookie: ${xCookie}`] : []),
    ...(xUA     ? [`--user-agent=${xUA}`]         : []),
    '--out', outName,
    '--dir', downloadsDir,
    url
  ];
  const child = spawn('aria2c', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const now = Date.now();
  const state = {
    id, url, outPath, outName, pid: child.pid,
    done: false, size: 0, error: null,
    totalSize: totalSize, contentType: remoteCT,
    startedAt: now, lastBytes: 0, lastAt: now, speedEMA: 0, lastAccess: now
  };
  jobs.set(id, state);

  child.on('close', () => {
    state.done = true;
    try { state.size = fs.statSync(outPath).size; } catch {}
    touchAccess(state);
  });

  res.json({ id, out: outName, totalSize: totalSize ?? null, contentType: remoteCT });
});

// --- Estado actual: bytes, velocidad y ETA ---
app.get('/status', (req, res) => {
  const { id } = req.query;
  if (!id || !jobs.has(id)) return res.status(404).json({ error: 'id inválido' });

  const st = jobs.get(id);
  const sizeNow = statSize(st.outPath);
  const now = Date.now();
  const dt = Math.max(0.001, (now - st.lastAt) / 1000);
  const dB = Math.max(0, sizeNow - st.lastBytes);
  const inst = dB / dt; // B/s instantáneo
  st.speedEMA = st.speedEMA ? (st.speedEMA * 0.7 + inst * 0.3) : inst;
  st.lastBytes = sizeNow;
  st.lastAt = now;
  touchAccess(st);

  const total = st.totalSize || null;
  const pct = total ? Math.max(0, Math.min(100, Math.floor(sizeNow * 100 / total))) : null;
  const remain = total ? Math.max(0, total - sizeNow) : null;
  const etaSec = (remain !== null && st.speedEMA > 1) ? Math.round(remain / st.speedEMA) : null;
  const done = total ? (sizeNow >= total - 1) : st.done;

  res.json({
    id: st.id,
    downloaded: sizeNow,
    total,
    pct,
    speedBps: Math.round(st.speedEMA),
    etaSec,
    done
  });
});

// --- Cancelar descarga ---
app.get('/cancel', (req, res) => {
  const { id } = req.query;
  if (!id || !jobs.has(id)) return res.status(404).json({ error: 'id inválido' });
  const st = jobs.get(id);
  try { if (st.pid) process.kill(st.pid); } catch {}
  st.done = true;
  touchAccess(st);
  return res.json({ ok: true });
});

// --- Borrar archivo y job (para usar al cerrar pestaña si no quieres conservar) ---
app.get('/delete', (req, res) => {
  const { id } = req.query;
  if (!id || !jobs.has(id)) return res.status(404).json({ error: 'id inválido' });
  const st = jobs.get(id);
  try { if (st.pid) process.kill(st.pid); } catch {}
  safeUnlink(st.outPath);
  jobs.delete(id);
  return res.json({ ok: true });
});

// --- HEAD /file: informa tamaño final (si se conoce) ---
app.head('/file', (req, res) => {
  const { id } = req.query;
  if (!id || !jobs.has(id)) return res.sendStatus(404);
  const st = jobs.get(id);
  const total = Number.isFinite(st.totalSize) ? st.totalSize : statSize(st.outPath);
  touchAccess(st);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Length', String(total));
  res.status(200).end();
});

// --- GET /file: sirve el archivo COMPLETO (cuando termine) ---
app.get('/file', async (req, res) => {
  const { id } = req.query;
  if (!id || !jobs.has(id)) return res.status(404).send('id inválido');
  const st = jobs.get(id);
  const fp = st.outPath;

  await waitForFile(fp);

  // Espera hasta que la descarga termine (o alcance totalSize conocido)
  while (true) {
    const sizeNow = statSize(fp);
    if ((st.totalSize && sizeNow >= st.totalSize - 1) || st.done) break;
    await waitFor(200);
  }

  const total = Number.isFinite(st.totalSize) ? st.totalSize : statSize(fp);
  touchAccess(st);

  // Soporte Range
  const rangeHdr = req.headers.range || '';
  let start = 0, end = total - 1;
  if (/bytes=\d+-\d*/i.test(rangeHdr)) {
    const m = /bytes=(\d+)-(\d+)?/i.exec(rangeHdr);
    if (m) {
      start = parseInt(m[1], 10);
      end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    }
  }
  if (start >= total) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }

  const chunk = end - start + 1;
  res.status(rangeHdr ? 206 : 200);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (rangeHdr) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', String(chunk));

  const rs = fs.createReadStream(fp, { start, end });
  rs.on('error', () => { try { res.end(); } catch {} });
  rs.pipe(res);
});

// --- (Opcional) /probe para depurar cabeceras del origen ---
app.get('/probe', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Falta ?url=');
  const xRef = req.headers['x-src-referrer'];
  const xCookie = req.headers['x-src-cookie'];
  const xUA = req.headers['x-src-ua'];
  const headers = {};
  if (xRef)    headers['Referer'] = xRef;
  if (xCookie) headers['Cookie']  = xCookie;
  if (xUA)     headers['User-Agent'] = xUA;
  const meta = await fetchRemoteMeta(url, headers);
  res.json(meta);
});

// --- GC: borra jobs terminados sin uso tras TTL ---
setInterval(() => {
  const now = Date.now();
  for (const [id, st] of jobs) {
    if ((st.done || (st.totalSize && statSize(st.outPath) >= st.totalSize - 1)) && (now - (st.lastAccess || st.startedAt)) > TTL_MS) {
      try { if (st.pid) process.kill(st.pid); } catch {}
      safeUnlink(st.outPath);
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000); // cada 5 min

// Limpieza al salir
function cleanupAll() {
  for (const [id, st] of jobs) {
    try { if (st.pid) process.kill(st.pid); } catch {}
    // no borramos forzosamente aquí para no perder descargas en curso
  }
}
process.on('SIGINT', () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });

http.createServer(app).listen(PORT, () => {
  console.log(`Aria2 streamer en http://127.0.0.1:${PORT} (dir: ${downloadsDir})`);
});
