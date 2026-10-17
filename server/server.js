import express from 'express';
import helmet from 'helmet';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

const app = express();
const PORT = Number(process.env.PORT || 7777);
const STREAM_MIN_BUFFER = 8 * 1024 * 1024;
const MP4_PROBE_BYTES = 4 * 1024 * 1024;
const STREAM_WAIT_MS = 350;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
const baseFolder = path.join(tempDir, 'aria2_streamer');
fs.mkdirSync(baseFolder, { recursive: true });

const downloads = Object.create(null);

function unitToBytes(value, unitRaw) {
  if (!Number.isFinite(value)) return 0;
  const unit = String(unitRaw || '').toUpperCase().replace(/IB?$/, '');
  const map = { '': 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return Math.max(0, Math.floor(value * (map[unit] || 1)));
}

function safeStatSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function inspectMp4Layout(file, availableBytes, done = false) {
  const readableBytes = Math.min(Math.max(0, availableBytes || 0), MP4_PROBE_BYTES);
  if (readableBytes < 8 || !fs.existsSync(file)) {
    return { metadataReady: false, moovAtEnd: false, reason: 'waiting-for-mp4-header' };
  }

  let buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buffer = Buffer.alloc(readableBytes);
      const read = fs.readSync(fd, buffer, 0, readableBytes, 0);
      buffer = buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { metadataReady: false, moovAtEnd: false, reason: 'waiting-for-mp4-header' };
  }

  let offset = 0;
  while (offset + 8 <= buffer.length) {
    let boxSize = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;

    if (boxSize === 1) {
      if (offset + 16 > buffer.length) break;
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      boxSize = Number(extendedSize);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = Math.max(headerSize, availableBytes - offset);
    }

    if (boxSize < headerSize) break;

    if (boxType === 'moov') {
      const complete = done || offset + boxSize <= availableBytes;
      return {
        metadataReady: complete,
        moovAtEnd: false,
        reason: complete ? 'mp4-metadata-ready' : 'waiting-for-complete-moov'
      };
    }

    if (boxType === 'mdat') {
      return {
        metadataReady: !!done,
        moovAtEnd: true,
        reason: done ? 'download-complete' : 'moov-at-end'
      };
    }

    if (offset + boxSize > buffer.length) break;
    offset += boxSize;
  }

  return {
    metadataReady: !!done,
    moovAtEnd: false,
    reason: done ? 'download-complete' : 'waiting-for-mp4-metadata'
  };
}

function normalizeUrlKey(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    url.hash = '';
    return url.toString();
  } catch {
    return String(value).trim() || null;
  }
}

function uniqAliases(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = normalizeUrlKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function getUrlFingerprintKeys(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (!value) continue;
    try {
      const url = new URL(String(value));
      url.hash = '';

      const noHash = url.toString();
      if (!seen.has(noHash)) {
        seen.add(noHash);
        result.push(noHash);
      }

      url.search = '';
      const noQuery = url.toString();
      if (!seen.has(noQuery)) {
        seen.add(noQuery);
        result.push(noQuery);
      }

      const pathOnly = `${url.origin}${url.pathname}`;
      if (!seen.has(pathOnly)) {
        seen.add(pathOnly);
        result.push(pathOnly);
      }
    } catch {
      const text = String(value).trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        result.push(text);
      }
    }
  }
  return result;
}

function buildMeta(id, url, outName, aliases = [], extra = {}) {
  const aliasList = uniqAliases([url, ...aliases]);
  return {
    id,
    url: normalizeUrlKey(url) || url,
    aliases: aliasList,
    fingerprints: getUrlFingerprintKeys(aliasList),
    outName,
    ts: Date.now(),
    ...extra
  };
}

function writeMeta(id, url, outName, aliases = [], extra = {}) {
  const meta = buildMeta(id, url, outName, aliases, extra);
  const metaPath = path.join(baseFolder, `${id}.json`);
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch {}
  return metaPath;
}

function updateMetaFile(d, extra = {}) {
  if (!d || !d.metaPath) return;
  try {
    const previous = fs.existsSync(d.metaPath) ? JSON.parse(fs.readFileSync(d.metaPath, 'utf8')) : {};
    const aliases = uniqAliases([d.url, ...(Array.isArray(d.aliases) ? d.aliases : []), ...(Array.isArray(previous.aliases) ? previous.aliases : [])]);
    const meta = {
      ...previous,
      id: previous.id || d.id,
      url: previous.url || d.url,
      aliases,
      fingerprints: getUrlFingerprintKeys([...(Array.isArray(previous.fingerprints) ? previous.fingerprints : []), ...aliases]),
      outName: previous.outName || path.basename(d.file),
      ts: Date.now(),
      ...extra
    };
    fs.writeFileSync(d.metaPath, JSON.stringify(meta, null, 2));
  } catch {}
}

function metaMatches(meta, keys, fingerprints) {
  if (!meta) return false;
  const metaKeys = uniqAliases([meta.url, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]);
  if (keys && keys.length && metaKeys.some((item) => keys.includes(item))) return true;

  const metaFingerprints = getUrlFingerprintKeys([
    meta.url,
    ...(Array.isArray(meta.aliases) ? meta.aliases : []),
    ...(Array.isArray(meta.fingerprints) ? meta.fingerprints : [])
  ]);
  return !!(fingerprints && fingerprints.length && metaFingerprints.some((item) => fingerprints.includes(item)));
}

function readAllMetaForUrls(urls) {
  const keys = uniqAliases(urls);
  const fingerprints = getUrlFingerprintKeys(keys);
  let best = null;
  try {
    const files = fs.readdirSync(baseFolder).filter((name) => name.endsWith('.json'));
    for (const name of files) {
      const file = path.join(baseFolder, name);
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (metaMatches(meta, keys, fingerprints) && Number.isFinite(meta.ts)) {
          if (!best || meta.ts > best.ts) best = meta;
        }
      } catch {}
    }
  } catch {}
  return best;
}

function hashFileMd5(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function hydrateCompletedDownload(meta) {
  if (!meta || !meta.id || !meta.outName) return null;
  const file = path.join(baseFolder, meta.outName);
  const exists = fs.existsSync(file);
  if (!exists) return { exists: false, id: meta.id, done: false };

  const size = safeStatSize(file);
  downloads[meta.id] = {
    id: meta.id,
    proc: { kill() {} },
    rpcPort: null,
    rpcClosed: true,
    file,
    done: true,
    downloaded: size,
    total: size,
    percent: 100,
    speedBps: 0,
    etaText: '0s',
    etaSeconds: 0,
    lastProgressTs: Date.now(),
    url: normalizeUrlKey(meta.url) || meta.url,
    aliases: uniqAliases([meta.url, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]),
    metaPath: path.join(baseFolder, `${meta.id}.json`),
    md5: meta.md5 || null,
    error: null,
    logs: []
  };
  return { exists: true, id: meta.id, done: true, md5: meta.md5 || null, size };
}

function findExistingDownloadForUrls(urls) {
  const keys = uniqAliases(urls);
  const fingerprints = getUrlFingerprintKeys(keys);

  for (const [id, d] of Object.entries(downloads)) {
    const downloadKeys = uniqAliases([d.url, ...(Array.isArray(d.aliases) ? d.aliases : [])]);
    const downloadFingerprints = getUrlFingerprintKeys(downloadKeys);
    const keyMatch = downloadKeys.some((item) => keys.includes(item));
    const fingerprintMatch = downloadFingerprints.some((item) => fingerprints.includes(item));
    if (keyMatch || fingerprintMatch) {
      const exists = fs.existsSync(d.file);
      return { found: true, id, done: !!d.done, exists, md5: d.md5 || null, size: safeStatSize(d.file) };
    }
  }

  const meta = readAllMetaForUrls(keys);
  if (!meta) return { found: false };
  const hydrated = hydrateCompletedDownload(meta);
  if (!hydrated || !hydrated.exists) return { found: true, id: meta.id, done: false, exists: false };
  return { found: true, id: hydrated.id, done: true, exists: true, md5: hydrated.md5 || null, size: hydrated.size };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pushLog(d, text) {
  if (!d || !text) return;
  const clean = String(text).replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return;
  d.logs = d.logs || [];
  d.logs.push(clean.slice(-1000));
  if (d.logs.length > 10) d.logs.shift();
}

function getRecentLog(d) {
  return Array.isArray(d.logs) && d.logs.length ? d.logs[d.logs.length - 1] : null;
}

function randomRpcPort() {
  return 6800 + Math.floor(Math.random() * 1000);
}

async function rpcCall(port, method, params = []) {
  const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'RPC error');
  return payload.result;
}

function applyAria2Status(d, item) {
  if (!d || !item) return;
  const completed = Number.parseInt(item.completedLength || '0', 10);
  const total = Number.parseInt(item.totalLength || '0', 10);
  const speed = Number.parseInt(item.downloadSpeed || '0', 10);
  const pieceLength = Number.parseInt(item.pieceLength || '0', 10);
  const numPieces = Number.parseInt(item.numPieces || '0', 10);
  const activeConnections = Number.parseInt(item.connections || '0', 10);

  if (Number.isFinite(completed)) d.downloaded = completed;
  if (Number.isFinite(total) && total > 0) d.total = total;
  if (Number.isFinite(speed)) d.speedBps = speed;
  if (Number.isFinite(pieceLength) && pieceLength > 0) d.pieceLength = pieceLength;
  if (Number.isFinite(numPieces) && numPieces > 0) d.numPieces = numPieces;
  if (Number.isFinite(activeConnections)) d.activeConnections = activeConnections;
  if (typeof item.bitfield === 'string') d.bitfield = item.bitfield;

  d.ariaStatus = item.status || d.ariaStatus || null;
  d.gid = item.gid || d.gid || null;

  if (d.total > 0) d.percent = Math.max(0, Math.min(100, Math.floor((d.downloaded / d.total) * 100)));
  if (item.errorMessage) d.error = item.errorMessage;
  if (item.status === 'complete') {
    d.done = true;
    d.percent = 100;
    if (!d.total) d.total = safeStatSize(d.file);
    if (!d.downloaded) d.downloaded = d.total || safeStatSize(d.file);
  }
  if (item.status === 'error' || item.status === 'removed') {
    d.done = false;
    d.error = item.errorMessage || `aria2 status: ${item.status}`;
  }
  d.lastProgressTs = Date.now();
}

async function refreshProgressFromRpc(d) {
  if (!d || !d.rpcPort || d.rpcClosed) return;
  try {
    if (d.gid) {
      try {
        const item = await rpcCall(d.rpcPort, 'aria2.tellStatus', [d.gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorMessage', 'bitfield', 'pieceLength', 'numPieces', 'connections']]);
        applyAria2Status(d, item);
        return;
      } catch {}
    }

    const fields = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorMessage', 'bitfield', 'pieceLength', 'numPieces', 'connections'];
    const active = await rpcCall(d.rpcPort, 'aria2.tellActive', [fields]);
    if (Array.isArray(active) && active.length) {
      applyAria2Status(d, active[0]);
      return;
    }

    const waiting = await rpcCall(d.rpcPort, 'aria2.tellWaiting', [0, 1, fields]);
    if (Array.isArray(waiting) && waiting.length) {
      applyAria2Status(d, waiting[0]);
      return;
    }

    const stopped = await rpcCall(d.rpcPort, 'aria2.tellStopped', [0, 1, fields]);
    if (Array.isArray(stopped) && stopped.length) applyAria2Status(d, stopped[0]);
  } catch (e) {
    d.rpcError = String(e && e.message ? e.message : e);
  }
}

function getContiguousAvailableBytes(d) {
  const diskSize = safeStatSize(d.file);
  if (d.done) return diskSize;

  const pieceLength = Number.isFinite(d.pieceLength) ? d.pieceLength : 0;
  const numPieces = Number.isFinite(d.numPieces) ? d.numPieces : 0;
  const bitfield = typeof d.bitfield === 'string' ? d.bitfield.trim() : '';

  if (pieceLength > 0 && numPieces > 0 && /^[0-9a-f]+$/i.test(bitfield)) {
    let completedPrefixPieces = 0;
    for (let index = 0; index < numPieces; index += 1) {
      const nibbleIndex = Math.floor(index / 4);
      if (nibbleIndex >= bitfield.length) break;
      const nibble = Number.parseInt(bitfield[nibbleIndex], 16);
      const mask = 1 << (3 - (index % 4));
      if ((nibble & mask) === 0) break;
      completedPrefixPieces += 1;
    }

    const prefixBytes = completedPrefixPieces * pieceLength;
    const total = Number.isFinite(d.total) && d.total > 0 ? d.total : prefixBytes;
    return Math.min(diskSize, total, prefixBytes);
  }

  // With one connection aria2 writes from the beginning, so this fallback is
  // safe while RPC is starting. It is intentionally disabled for segmented jobs.
  if ((d.configuredConnections || 1) <= 1) {
    const downloaded = Number.isFinite(d.downloaded) && d.downloaded > 0 ? d.downloaded : diskSize;
    return Math.min(diskSize, downloaded);
  }

  return 0;
}

function parseEtaToSeconds(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

function updateProgressFromText(d, text) {
  if (!d) return;
  try {
    pushLog(d, text);
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const gidMatch = line.match(/\[#([0-9a-f]+)\b/i);
    if (gidMatch) d.gid = gidMatch[1];
    const bracket = line.match(/\[#\w+\s+([\d.]+)\s*([KMGTP]?i?)?B\/(~?)([\d.]+)\s*([KMGTP]?i?)?B\((\d+)%\).*?(?:DL:([\d.]+)\s*([KMGTP]?i?)?B)?(?:.*?ETA:([^\]\s]+))?/i);
    if (bracket) {
      d.downloaded = unitToBytes(Number.parseFloat(bracket[1]), bracket[2]);
      d.total = unitToBytes(Number.parseFloat(bracket[4]), bracket[5]);
      d.percent = clampInt(bracket[6], 0, 100, d.percent || 0);
      if (bracket[7]) d.speedBps = unitToBytes(Number.parseFloat(bracket[7]), bracket[8]);
      if (bracket[9]) {
        d.etaText = bracket[9];
        d.etaSeconds = parseEtaToSeconds(bracket[9]);
      }
      d.lastProgressTs = Date.now();
      continue;
    }

    const ofMatch = line.match(/([\d.]+)%\s+of\s+~?([\d.]+)\s*([KMGTP]?i?)?B\s+at\s+([\d.]+)\s*([KMGTP]?i?)?B\/s/i);
    if (ofMatch) {
      d.percent = clampInt(ofMatch[1], 0, 100, d.percent || 0);
      d.total = unitToBytes(Number.parseFloat(ofMatch[2]), ofMatch[3]);
      d.speedBps = unitToBytes(Number.parseFloat(ofMatch[4]), ofMatch[5]);
      d.downloaded = Math.floor((d.total * d.percent) / 100);
      d.lastProgressTs = Date.now();
    }
  }
  } catch (e) {
    try {
      if (d) {
        d.parserError = String(e && e.message ? e.message : e);
        pushLog(d, `progress parser error: ${d.parserError}`);
      }
    } catch {}
  }
}

function getVisibleStatus(d) {
  const diskSize = safeStatSize(d.file);
  const parsedDownloaded = Number.isFinite(d.downloaded) ? d.downloaded : 0;
  const total = Number.isFinite(d.total) ? d.total : 0;
  let downloaded = parsedDownloaded;

  if (!downloaded && diskSize && (!total || diskSize <= total) && (d.done || (d.configuredConnections || 1) <= 1)) {
    downloaded = diskSize;
  }

  if (d.done) {
    downloaded = Math.max(downloaded, diskSize);
    if (!total && diskSize) d.total = diskSize;
  }

  const finalTotal = d.total || total || 0;
  const percent = finalTotal > 0 ? Math.min(100, Math.floor((downloaded / finalTotal) * 100)) : d.percent || 0;
  const speedBps = Math.max(0, Math.floor(d.speedBps || 0));
  const etaSeconds = !d.done && finalTotal > 0 && speedBps > 0 ? Math.ceil((finalTotal - downloaded) / speedBps) : null;
  const contiguousAvailableBytes = getContiguousAvailableBytes(d);
  const bufferTargetBytes = finalTotal > 0
    ? Math.min(finalTotal, Math.min(Math.max(STREAM_MIN_BUFFER, Math.floor(finalTotal * 0.02)), 64 * 1024 * 1024))
    : STREAM_MIN_BUFFER;
  let mp4 = d.mp4Layout;
  const mustRefreshMp4 = !mp4
    || (!mp4.metadataReady && !mp4.moovAtEnd)
    || (!!d.done && !mp4.metadataReady);
  if (mustRefreshMp4) {
    mp4 = inspectMp4Layout(d.file, contiguousAvailableBytes, d.done);
    if (mp4.metadataReady || mp4.moovAtEnd) d.mp4Layout = mp4;
  }
  const enoughBuffer = contiguousAvailableBytes >= bufferTargetBytes;

  return {
    downloaded,
    total: finalTotal,
    speedBps,
    etaSeconds,
    etaText: d.done ? '0s' : d.etaText || null,
    percent,
    done: !!d.done,
    configuredConnections: d.configuredConnections || 1,
    activeConnections: d.activeConnections || 0,
    contiguousAvailableBytes,
    bufferTargetBytes,
    mp4MetadataReady: mp4.metadataReady,
    moovAtEnd: mp4.moovAtEnd,
    streamReadyReason: mp4.reason,
    streamReady: (!!d.done && diskSize > 0) || (finalTotal > 0 && enoughBuffer && mp4.metadataReady)
  };
}

app.get('/start', (req, res) => {
  try {
    const src = req.query.url;
    if (!src) return res.status(400).json({ ok: false, error: 'Missing url' });

    const aliases = uniqAliases([
      src,
      req.query.pageUrl,
      req.query.canonicalUrl,
      ...String(req.query.aliases || '').split(/\r?\n/)
    ]);

    const id = crypto.randomBytes(8).toString('hex');
    const outName = `${id}.mp4`;
    const outFile = path.join(baseFolder, outName);
    const connections = clampInt(req.query.connections, 1, 16, 16);
    const split = clampInt(req.query.split, 1, 16, connections);
    const rpcPort = randomRpcPort();

    const args = [
      '--allow-overwrite=true',
      '--auto-file-renaming=false',
      '--continue=true',
      '--file-allocation=none',
      '--stream-piece-selector=inorder',
      '--piece-length=1M',
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${rpcPort}`,
      '--dir', baseFolder,
      '--out', outName,
      `--max-connection-per-server=${connections}`,
      `--split=${split}`,
      '--min-split-size=1M',
      '--console-log-level=notice',
      '--summary-interval=1',
      '--max-tries=3',
      '--retry-wait=2',
      src
    ];

    const headers = [];
    if (req.headers['x-src-cookie']) headers.push(`Cookie: ${req.headers['x-src-cookie']}`);
    if (req.headers['x-src-referrer']) headers.push(`Referer: ${req.headers['x-src-referrer']}`);
    if (req.headers['x-src-origin']) headers.push(`Origin: ${req.headers['x-src-origin']}`);
    if (req.headers['x-src-ua']) headers.push(`User-Agent: ${req.headers['x-src-ua']}`);
    if (req.headers['x-src-accept']) headers.push(`Accept: ${req.headers['x-src-accept']}`);
    if (req.headers['x-src-accept-language']) headers.push(`Accept-Language: ${req.headers['x-src-accept-language']}`);
    headers.push('Connection: keep-alive');
    for (const header of headers) args.push('--header', header);

    const proc = spawn('aria2c', args, { windowsHide: true });
    const metaPath = writeMeta(id, src, outName, aliases);

    downloads[id] = {
      id,
      proc,
      rpcPort,
      rpcClosed: false,
      configuredConnections: connections,
      file: outFile,
      done: false,
      downloaded: 0,
      total: 0,
      percent: 0,
      speedBps: 0,
      etaText: null,
      etaSeconds: null,
      lastProgressTs: Date.now(),
      url: normalizeUrlKey(src) || src,
      aliases,
      metaPath,
      error: null,
      parserError: null,
      logs: []
    };

    const currentDownload = downloads[id];
    proc.stdout.on('data', (buf) => updateProgressFromText(currentDownload, buf.toString()));
    proc.stderr.on('data', (buf) => updateProgressFromText(currentDownload, buf.toString()));
    proc.on('error', (err) => {
      if (downloads[id]) downloads[id].error = String(err && err.message ? err.message : err);
    });
    proc.on('close', (code) => {
      if (!downloads[id]) return;
      downloads[id].rpcClosed = true;
      downloads[id].exitCode = code;
      if (code === 0) {
        downloads[id].done = true;
        downloads[id].percent = 100;
        const size = safeStatSize(downloads[id].file);
        if (!downloads[id].total && size) downloads[id].total = size;
        if (!downloads[id].downloaded && size) downloads[id].downloaded = size;
        updateMetaFile(downloads[id], { size, done: true });
        hashFileMd5(downloads[id].file)
          .then((md5) => {
            if (!downloads[id]) return;
            downloads[id].md5 = md5;
            updateMetaFile(downloads[id], { size: safeStatSize(downloads[id].file), md5, done: true });
          })
          .catch(() => {});
      } else {
        downloads[id].done = false;
        downloads[id].error = downloads[id].error || getRecentLog(downloads[id]) || `aria2 exited with code ${code}`;
      }
    });

    res.json({ ok: true, id, streamingMode: true, connections, split });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/status', async (req, res) => {
  try {
    const id = req.query.id;
    const d = id && downloads[id];
    if (!d) return res.json({ ok: false, error: 'Unknown id' });
    await refreshProgressFromRpc(d);
    const status = getVisibleStatus(d);
    if (d.error) status.error = d.error;
    if (d.rpcError && !d.done && !status.error) status.rpcError = d.rpcError;
    status.ariaStatus = d.ariaStatus || null;
    status.exitCode = d.exitCode;
    status.lastLog = getRecentLog(d);
    res.json(status);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function parseRangeHeader(rangeHeader) {
  if (!rangeHeader) return null;
  const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  return {
    start: m[1] === '' ? null : Number.parseInt(m[1], 10),
    end: m[2] === '' ? null : Number.parseInt(m[2], 10)
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamGrowingFile(req, res, d, start, end, totalForHeaders) {
  let pos = start;
  let closed = false;
  req.on('close', () => { closed = true; });

  while (!closed && pos <= end) {
    const available = getContiguousAvailableBytes(d);
    const availableEnd = Math.min(end, available - 1);

    if (availableEnd >= pos) {
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(d.file, { start: pos, end: availableEnd });
        stream.on('data', (chunk) => { pos += chunk.length; });
        stream.on('end', resolve);
        stream.on('error', reject);
        stream.pipe(res, { end: false });
      }).catch(() => { closed = true; });
      continue;
    }

    if (d.done || d.error) break;
    await wait(STREAM_WAIT_MS);
  }

  if (!res.destroyed && !closed) res.end();
}

app.get('/file', async (req, res) => {
  try {
    const id = req.query.id;
    const d = id && downloads[id];
    if (!d) return res.status(404).end();

    const range = parseRangeHeader(req.headers.range);
    const status = getVisibleStatus(d);
    const total = status.total || safeStatSize(d.file);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');

    if (!range) {
      if (total > 0) res.setHeader('Content-Length', total);
      return streamGrowingFile(req, res, d, 0, Math.max(total - 1, 0), total);
    }

    let start = range.start;
    let end = range.end;

    if (start === null && end !== null && total > 0) start = Math.max(0, total - end);
    if (start === null) start = 0;
    if (end === null) end = total > 0 ? total - 1 : Math.max(safeStatSize(d.file) - 1, start);
    if (total > 0) end = Math.min(end, total - 1);

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      res.status(416).setHeader('Content-Range', `bytes */${total || '*'}`);
      return res.end();
    }

    const contentLength = total > 0 ? (end - start + 1) : undefined;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total || '*'}`);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    return streamGrowingFile(req, res, d, start, end, total);
  } catch {
    if (!res.headersSent) res.status(500);
    res.end();
  }
});

app.get('/delete', (req, res) => {
  try {
    const id = req.query.id;
    const d = id && downloads[id];
    if (!d) return res.json({ ok: false });

    d.error = 'Download deleted';
    try { d.proc.kill('SIGKILL'); } catch {}
    try { if (fs.existsSync(d.file)) fs.unlinkSync(d.file); } catch {}
    try { if (d.metaPath && fs.existsSync(d.metaPath)) fs.unlinkSync(d.metaPath); } catch {}

    delete downloads[id];
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/find', (req, res) => {
  try {
    const rawUrls = Array.isArray(req.query.url) ? req.query.url : [req.query.url];
    const urls = rawUrls.filter(Boolean);
    if (!urls.length) return res.status(400).json({ ok: false, error: 'Missing url' });

    const existing = findExistingDownloadForUrls(urls);
    if (existing.found) {
      return res.json({
        ok: true,
        found: true,
        id: existing.id,
        done: !!existing.done,
        exists: !!existing.exists,
        md5: existing.md5 || null,
        size: existing.size || 0
      });
    }

    return res.json({ ok: true, found: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/open-folder', (_req, res) => {
  try {
    fs.mkdirSync(baseFolder, { recursive: true });

    if (process.platform === 'win32') {
      spawn('explorer', [baseFolder], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [baseFolder], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [baseFolder], { detached: true, stdio: 'ignore' }).unref();
    }

    res.json({ ok: true, folder: baseFolder });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://127.0.0.1:${PORT} (dir: ${baseFolder})`);
  });
}

export { app, downloads, getContiguousAvailableBytes, getVisibleStatus, inspectMp4Layout, streamGrowingFile };
