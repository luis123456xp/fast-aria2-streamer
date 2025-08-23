import express from 'express';
import helmet from 'helmet';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const app = express();
const PORT = 7777;

// Seguridad mínima sin romper <video src="http://127.0.0.1:7777/file?...">
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Carpeta base: %TEMP%\aria2_streamer
const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
const baseFolder = path.join(tempDir, 'aria2_streamer');
if (!fs.existsSync(baseFolder)) {
  fs.mkdirSync(baseFolder, { recursive: true });
}

// Descargas activas
// id -> { proc, file, done, lastSize, lastTs, speedBps, total, url, metaPath }
const downloads = Object.create(null);

// Utilidad: convierte valor+unidad (KiB/MiB/GiB/...) a bytes
function unitToBytes(value, unitRaw) {
  if (!Number.isFinite(value)) return 0;
  const u = (unitRaw || '').toUpperCase(); // 'K','M','G','KI','MI',...
  const map = { '': 1, 'B': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4, 'P': 1024 ** 5 };
  const key = u.replace(/IB?$/, ''); // KiB/MiB/GiB -> K/M/G
  const mul = map[key] ?? 1;
  return Math.max(0, value * mul);
}

function writeMeta(id, url, outName) {
  const meta = { id, url, outName, ts: Date.now() };
  const metaPath = path.join(baseFolder, `${id}.json`);
  try { fs.writeFileSync(metaPath, JSON.stringify(meta)); } catch {}
  return metaPath;
}

function readAllMetaForUrl(url) {
  // Busca el meta más reciente que coincida con la URL
  let best = null;
  try {
    const files = fs.readdirSync(baseFolder).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const p = path.join(baseFolder, f);
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j && j.url === url && Number.isFinite(j.ts)) {
          if (!best || j.ts > best.ts) best = j;
        }
      } catch {}
    }
  } catch {}
  return best;
}

// Lanza aria2c y registra parsers
app.get('/start', (req, res) => {
  try {
    const src = req.query.url;
    if (!src) return res.status(400).json({ ok: false, error: 'Missing url' });

    const id = crypto.randomBytes(8).toString('hex');
    const outName = `${id}.mp4`;
    const outFile = path.join(baseFolder, outName);

    const args = [
      '--allow-overwrite=true',
      '--dir', baseFolder,
      '--out', outName,
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--console-log-level=notice', // para que emita progreso
      '--summary-interval=1',
      src
    ];

    // Hereda sesión (si la extensión envía cabeceras)
    const headers = [];
    if (req.headers['x-src-cookie'])   headers.push(`Cookie: ${req.headers['x-src-cookie']}`);
    if (req.headers['x-src-referrer']) headers.push(`Referer: ${req.headers['x-src-referrer']}`);
    if (req.headers['x-src-ua'])       headers.push(`User-Agent: ${req.headers['x-src-ua']}`);
    headers.forEach(h => args.push('--header', h));

    const proc = spawn('aria2c', args, { windowsHide: true });

    const metaPath = writeMeta(id, src, outName);

    downloads[id] = {
      proc,
      file: outFile,
      done: false,
      lastSize: 0,
      lastTs: Date.now(),
      speedBps: 0,
      total: 0,
      url: src,
      metaPath
    };

    // Parseo opcional de total y velocidad desde stderr
    // Ejemplo: "... 12.3% of ~123.45MiB at 3.21MiB/s ..."
    const re = /(\d+(?:\.\d+)?)%\s+of\s+~?(\d+(?:\.\d+)?)\s*([KMGTP]i?)?B\s+at\s+(\d+(?:\.\d+)?)\s*([KMGTP]i?)?B\/s/i;
    proc.stderr.on('data', (buf) => {
      const line = buf.toString();
      const m = line.match(re);
      if (m) {
        const totalVal = parseFloat(m[2]);
        const totalUnit = (m[3] || '').toString();
        const speedVal = parseFloat(m[4]);
        const speedUnit = (m[5] || '').toString();
        if (Number.isFinite(totalVal)) downloads[id].total = unitToBytes(totalVal, totalUnit);
        if (Number.isFinite(speedVal)) downloads[id].speedBps = unitToBytes(speedVal, speedUnit);
      }
    });

    proc.on('close', (_code) => {
      if (downloads[id]) downloads[id].done = true;
    });

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Estado: calcula velocidad con delta de tamaño en disco
app.get('/status', (req, res) => {
  try {
    const id = req.query.id;
    const d = id && downloads[id];
    if (!d) return res.json({ ok: false, error: 'Unknown id' });

    let size = 0;
    try {
      const st = fs.statSync(d.file);
      size = st.size;
    } catch {
      size = 0;
    }

    const now = Date.now();
    const dt = (now - d.lastTs) / 1000; // seg
    if (dt > 0) {
      const delta = size - d.lastSize;
      const calc = delta > 0 ? (delta / dt) : 0;
      d.speedBps = Math.max(d.speedBps || 0, calc);
      d.lastSize = size;
      d.lastTs = now;
    }

    res.json({
      downloaded: size,
      total: d.total || 0,
      speedBps: Math.max(0, Math.floor(d.speedBps)),
      done: !!d.done
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Sirve el archivo
app.get('/file', (req, res) => {
  try {
    const id = req.query.id;
    const d = id && downloads[id];
    if (!d) return res.status(404).end();
    res.sendFile(d.file);
  } catch {
    res.status(500).end();
  }
});

// Elimina descarga/archivo (y mata aria2c)
app.get('/delete', (req, res) => {
  try {
    const id = req.query.id;
    const d = id && downloads[id];
    if (!d) return res.json({ ok: false });

    try { d.proc.kill('SIGKILL'); } catch {}
    try { if (fs.existsSync(d.file)) fs.unlinkSync(d.file); } catch {}
    try { if (d.metaPath && fs.existsSync(d.metaPath)) fs.unlinkSync(d.metaPath); } catch {}

    delete downloads[id];
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// NUEVO: encontrar si una URL ya existe (descarga en curso o terminada)
app.get('/find', (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });

    // 1) Busca en memoria (descarga activa)
    for (const [id, d] of Object.entries(downloads)) {
      if (d.url === url) {
        const exists = fs.existsSync(d.file);
        return res.json({ ok: true, found: true, id, done: !!d.done, exists });
      }
    }

    // 2) Busca en meta files (terminadas o previas)
    const meta = readAllMetaForUrl(url);
    if (meta) {
      const file = path.join(baseFolder, meta.outName);
      const exists = fs.existsSync(file);
      return res.json({ ok: true, found: true, id: meta.id, done: exists, exists });
    }

    // 3) No encontrada
    return res.json({ ok: true, found: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Abrir carpeta local %TEMP%\aria2_streamer en el explorador
app.get('/open-folder', (_req, res) => {
  try {
    const folder = baseFolder;
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    if (process.platform === 'win32') {
      spawn('explorer', [folder], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [folder], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [folder], { detached: true, stdio: 'ignore' }).unref();
    }

    res.json({ ok: true, folder });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://127.0.0.1:${PORT} (dir: ${baseFolder})`);
});
