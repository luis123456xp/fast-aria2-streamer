const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
function storage(values = {}) {
  return {
    values,
    async get(keys) {
      if (typeof keys === 'object' && !Array.isArray(keys)) return { ...keys, ...values };
      return structuredClone(values);
    },
    async set(update) { Object.assign(values, structuredClone(update)); }
  };
}

function background(settings = {}, sessionValues = {}) {
  let listener, onRemoved;
  const session = storage(structuredClone(sessionValues));
  const local = storage(settings);
  const requests = [];
  const tabs = new Map([1, 2].map((id) => [id, { url: 'https://example.com/watch' }]));
  vm.runInNewContext(source('background.js'), {
    URL, console,
    chrome: {
      storage: { session, local },
      tabs: { get: async (id) => { if (!tabs.has(id)) throw Error('closed'); return tabs.get(id); }, onRemoved: { addListener(fn) { onRemoved = fn; } } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } }
    },
    fetch: async (url) => { requests.push(String(url)); return { ok: true, json: async () => ({ id: 'download' }) }; }
  });
  return {
    requests, session, local, tabs,
    send: (msg, tabId = 1, documentId = `doc${tabId}`) => new Promise((resolve) => listener(msg, { tab: { id: tabId }, documentId, url: 'https://example.com/watch' }, resolve)),
    async close(id) { tabs.delete(id); onRemoved(id); await flush(); }
  };
}

test('borrar al salir espera a la ultima pestaña, incluso despues de reiniciar el worker', async () => {
  const bg = background({ keepOnClose: false });
  await bg.send({ type: 'TRACK_JOB', id: 'shared' });
  await bg.send({ type: 'TRACK_JOB', id: 'shared' }, 2);
  await bg.close(1);
  assert.equal(bg.requests.length, 0);
  const restarted = background({ keepOnClose: false }, bg.session.values);
  await restarted.close(2);
  assert.equal(restarted.requests.length, 1);
  assert.match(restarted.requests[0], /delete\?id=shared$/);
});

test('conservar usa la preferencia actual guardada y no elimina al cerrar', async () => {
  const bg = background({ keepOnClose: false });
  await bg.send({ type: 'TRACK_JOB', id: 'saved' });
  await bg.local.set({ keepOnClose: true });
  await bg.close(1);
  assert.equal(bg.requests.length, 0);
});

test('salir de la pagina cancela y limpia; un inicio tardio no revive el registro', async () => {
  const bg = background({ keepOnClose: false });
  await bg.send({ type: 'TRACK_JOB', id: 'old' });
  await bg.send({ type: 'RELEASE_JOBS' });
  assert.match(bg.requests[0], /delete\?id=old$/);
  await bg.send({ type: 'START_ARIA2', query: { url: 'https://example.com/video.mp4' } });
  assert.match(bg.requests.at(-1), /delete\?id=download$/);
  assert.deepEqual(bg.session.values.jobOwners, {});
});

test('si la pestaña se cierra antes de recibir el inicio, elimina la descarga tardia', async () => {
  const bg = background({ keepOnClose: false });
  bg.tabs.delete(1);
  await bg.send({ type: 'START_ARIA2', query: { url: 'https://example.com/video.mp4' } });
  assert.match(bg.requests.at(-1), /delete\?id=download$/);
});

function content(settings = {}) {
  const nodes = new Map();
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const n = { id, style: {}, events: {}, checked: true, children: [],
      addEventListener(type, fn) { this.events[type] = fn; },
      querySelector(selector) { return node(selector); },
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) { child.parentNode = this; this.children.push(child); },
      removeChild() {}
    };
    nodes.set(id, n);
    return n;
  }
  const video = { offsetWidth: 640, offsetHeight: 360, currentSrc: 'https://example.com/video.mp4', querySelector() { return null; } };
  const timeouts = new Map(), intervals = new Map(), events = {}, messages = [];
  let timerId = 0, changeListener;
  const local = storage(settings);
  const location = { href: 'https://example.com/watch', hostname: 'example.com', origin: 'https://example.com' };
  const document = {
    documentElement: node('root'), cookie: '',
    getElementById: node, createElement: (tag) => node(`${tag}-${Math.random()}`),
    querySelector: () => null,
    querySelectorAll: (selector) => selector.startsWith('video') ? [video] : [],
    addEventListener(type, fn) { events[type] = fn; }
  };
  vm.runInNewContext(source('content.js'), {
    URL, console, document, location, navigator: { userAgent: 'test', language: 'es' },
    window: { addEventListener(type, fn) { events[type] = fn; } },
    history: { pushState() {}, replaceState() {} },
    MutationObserver: class { observe() {} },
    setTimeout(fn, ms) { const id = ++timerId; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    chrome: {
      storage: { local, onChanged: { addListener(fn) { changeListener = fn; } } },
      runtime: { async sendMessage(msg) {
        messages.push(msg);
        if (msg.type === 'FIND_BY_URLS') return { ok: true, data: { found: false } };
        if (msg.type === 'START_ARIA2') return { ok: true, data: { id: 'job' } };
        return { ok: true };
      } }
    }
  });
  return {
    video, messages, local, nodes, events, location,
    change: (changes) => changeListener(changes, 'local'),
    async detect() {
      for (const { fn, ms } of intervals.values()) if (ms === 2000) fn();
      for (const [id, { fn, ms }] of [...timeouts]) if (ms === 350) { timeouts.delete(id); fn(); }
      await flush();
    }
  };
}

test('descarga automaticamente una sola vez y detecta una fuente que aparece tarde', async () => {
  const c = content();
  c.video.currentSrc = '';
  await c.detect();
  assert.equal(c.messages.length, 0);
  c.video.currentSrc = 'https://example.com/video.mp4';
  await c.detect();
  await c.detect();
  assert.equal(c.messages.filter((m) => m.type === 'START_ARIA2').length, 1);
  assert.equal(c.messages.find((m) => m.type === 'START_ARIA2').query.connections, '16');
});

test('descarta blob y HLS; el inicio automatico se puede activar desde preferencias', async () => {
  const c = content({ autoStart: false });
  await c.detect();
  assert.equal(c.messages.length, 0);
  c.change({ autoStart: { newValue: true } });
  c.video.currentSrc = 'blob:https://example.com/id';
  await c.detect();
  c.video.currentSrc = 'https://example.com/video.m3u8';
  await c.detect();
  assert.equal(c.messages.length, 0);
  c.video.currentSrc = 'https://example.com/video.mp4';
  await c.detect();
  assert.equal(c.messages.filter((m) => m.type === 'START_ARIA2').length, 1);
});

test('detecta el cambio de video en una SPA y conserva el inicio manual al desactivar automatico', async () => {
  const c = content();
  await c.detect();
  c.location.href = 'https://example.com/watch/second';
  c.video.currentSrc = 'https://example.com/second.mp4';
  await c.detect();
  assert.equal(c.messages.filter((m) => m.type === 'START_ARIA2').length, 2);
  const manual = content({ autoStart: false });
  await manual.detect();
  await manual.nodes.get('aria2-start').events.click();
  assert.equal(manual.messages.filter((m) => m.type === 'START_ARIA2').length, 1);
});

test('el panel respeta borrar al salir y guarda cambios para futuras sesiones', async () => {
  const c = content({ keepOnClose: false });
  await c.detect();
  const checkbox = c.nodes.get('#aria2-keep');
  assert.equal(checkbox.checked, false);
  await checkbox.events.change({ target: { checked: true } });
  assert.equal(c.local.values.keepOnClose, true);
  c.change({ keepOnClose: { newValue: false } });
  assert.equal(checkbox.checked, false);
  c.events.pagehide({ persisted: false });
  await flush();
  assert.equal(c.messages.at(-1).type, 'RELEASE_JOBS');
});

test('el popup restaura y guarda las dos preferencias', async () => {
  const auto = { addEventListener(type, fn) { this[type] = fn; } };
  const modes = ['keep', 'delete'].map((value) => ({ value, addEventListener(type, fn) { this[type] = fn; } }));
  const status = {};
  const local = storage({ autoStart: false, keepOnClose: false });
  vm.runInNewContext(source('popup.js'), {
    chrome: { storage: { local } },
    document: {
      getElementById: (id) => id === 'auto-start' ? auto : status,
      querySelectorAll: () => modes,
      querySelector: () => modes.find((mode) => mode.checked)
    }
  });
  await flush();
  assert.equal(auto.checked, false);
  assert.equal(modes[1].checked, true);
  auto.checked = true;
  modes[0].checked = true;
  modes[1].checked = false;
  await modes[0].change();
  assert.deepEqual(local.values, { autoStart: true, keepOnClose: true });
  assert.match(status.textContent, /guardadas/);
});
