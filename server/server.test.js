import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { app, downloads, getContiguousAvailableBytes, getVisibleStatus, inspectMp4Layout } from './server.js';

const require = createRequire(import.meta.url);
const { getRule34QualitySources } = require('../extension/source-selection.js');

function mp4Box(type, payloadSize = 0) {
  const box = Buffer.alloc(8 + payloadSize);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  return box;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aria2-streamer-test-'));
}

test('detecta MP4 fast-start y MP4 con moov al final', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fastStart = path.join(dir, 'fast-start.mp4');
  const lateMoov = path.join(dir, 'late-moov.mp4');
  fs.writeFileSync(fastStart, Buffer.concat([mp4Box('ftyp'), mp4Box('moov'), mp4Box('mdat')]));
  fs.writeFileSync(lateMoov, Buffer.concat([mp4Box('ftyp'), mp4Box('mdat'), mp4Box('moov')]));

  assert.deepEqual(inspectMp4Layout(fastStart, fs.statSync(fastStart).size, false), {
    metadataReady: true,
    moovAtEnd: false,
    reason: 'mp4-metadata-ready'
  });
  assert.deepEqual(inspectMp4Layout(lateMoov, fs.statSync(lateMoov).size, false), {
    metadataReady: false,
    moovAtEnd: true,
    reason: 'moov-at-end'
  });
});

test('elige 2160p entre las cinco calidades publicadas y descarta hosts externos', () => {
  const entries = [360, 1080, 480, 2160, 720].map((height) => ({
    text: `MP4 ${height}p`,
    href: `https://rule34video.com/get_file/video_${height}p.mp4/?token=test`
  }));
  entries.push({ text: 'MP4 4320p', href: 'https://example.com/not-allowed.mp4' });

  const sources = getRule34QualitySources(
    entries,
    'rule34video.com',
    'https://rule34video.com/video/example/'
  );

  assert.deepEqual(sources.map((item) => item.height), [2160, 1080, 720, 480, 360]);
});

test('status publica bytes continuos y habilita streaming con buffer suficiente', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'growing.mp4');
  const prefix = Buffer.concat([mp4Box('ftyp'), mp4Box('moov'), mp4Box('free', 9 * 1024 * 1024)]);
  fs.writeFileSync(file, prefix);

  const status = getVisibleStatus({
    file,
    done: false,
    downloaded: prefix.length,
    total: 20 * 1024 * 1024,
    speedBps: 1024 * 1024,
    percent: 45
  });

  assert.equal(status.contiguousAvailableBytes, prefix.length);
  assert.equal(status.mp4MetadataReady, true);
  assert.equal(status.streamReady, true);
  assert.equal(status.bufferTargetBytes, 8 * 1024 * 1024);
});

test('bitfield limita el prefijo continuo aunque existan piezas posteriores', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'segmented.mp4');
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024));
  const download = {
    file,
    done: false,
    configuredConnections: 16,
    downloaded: 6 * 1024 * 1024,
    total: 8 * 1024 * 1024,
    pieceLength: 1024 * 1024,
    numPieces: 8,
    bitfield: 'af'
  };

  // 0xa = 1010: solo la primera pieza es parte del prefijo consecutivo.
  assert.equal(getContiguousAvailableBytes(download), 1024 * 1024);
  download.bitfield = 'f0';
  assert.equal(getContiguousAvailableBytes(download), 4 * 1024 * 1024);
});

test('Range espera a que crezca el archivo y entrega el intervalo completo', async (t) => {
  const dir = makeTempDir();
  const file = path.join(dir, 'range.mp4');
  const id = `test-${Date.now()}`;
  fs.writeFileSync(file, 'abcd');
  downloads[id] = {
    id,
    file,
    done: false,
    downloaded: 4,
    total: 8,
    speedBps: 1,
    percent: 50,
    proc: { kill() {} }
  };

  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  t.after(async () => {
    delete downloads[id];
    await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = listener.address().port;
  const responsePromise = fetch(`http://127.0.0.1:${port}/file?id=${encodeURIComponent(id)}`, {
    headers: { Range: 'bytes=0-7' }
  });

  setTimeout(() => {
    fs.appendFileSync(file, 'efgh');
    downloads[id].downloaded = 8;
  }, 100);

  const response = await responsePromise;
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-7/8');
  assert.equal(await response.text(), 'abcdefgh');
});
