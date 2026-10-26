import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TvRemote } from './remote.js';
import { Dlna } from './dlna.js';
import { SmartThings } from './smartthings.js';
import { wake } from './wol.js';
import { APP_CATALOG } from './apps-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const tvHost = process.env.TV_HOST || config.tv.host;
const port = Number(process.env.PORT || config.port || 8097);
fs.mkdirSync(path.join(root, 'data'), { recursive: true });

const remote = new TvRemote({ host: tvHost, name: config.tv.name || 'TV Web Remote', tokenFile: path.join(root, 'data', 'token.json') });
const dlna = new Dlna(tvHost);
const st = new SmartThings({
  token: process.env.SMARTTHINGS_TOKEN || config.smartthings?.token,
  deviceId: process.env.SMARTTHINGS_DEVICE_ID || config.smartthings?.deviceId,
});

// ---------- Status-Polling + Server-Sent Events ----------
const status = { power: 'unknown', volume: null, mute: null, remote: remote.state, ime: false, device: null, smartthings: st.enabled };
const clients = new Set();
let lastAutoConnectFail = 0;

function broadcast() {
  const msg = `data: ${JSON.stringify(status)}\n\n`;
  for (const res of clients) res.write(msg);
}

function update(patch) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (JSON.stringify(status[k]) !== JSON.stringify(v)) { status[k] = v; changed = true; }
  }
  if (changed) broadcast();
}

async function deviceInfo() {
  const res = await fetch(`http://${tvHost}:8001/api/v2/`, { signal: AbortSignal.timeout(2000) });
  return (await res.json()).device;
}

async function poll() {
  let device = null;
  try { device = await deviceInfo(); } catch {}
  const power = !device ? 'off' : device.PowerState === 'on' ? 'on' : 'standby';
  const patch = { power, device: device && { name: device.name, model: device.modelName, resolution: device.resolution, ip: device.ip, network: device.networkType, os: device.OS, mac: device.wifiMac } };
  if (power === 'on') {
    try { patch.volume = await dlna.getVolume(); patch.mute = await dlna.getMute(); } catch {}
    // automatisch verbinden, nach Fehlschlag aber nicht sofort erneut (sonst Dauer-Pairing-Dialog am TV)
    if (remote.state === 'disconnected' && Date.now() - lastAutoConnectFail > 60_000) {
      remote.connect().catch(() => { lastAutoConnectFail = Date.now(); });
    }
  } else if (remote.connected) {
    remote.disconnect();
  }
  update(patch);
}

remote.on('state', (s) => update({ remote: s }));
remote.on('ime', (on) => update({ ime: on }));

let pollTimer;
function schedulePoll(ms = 3000) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => { await poll(); schedulePoll(); }, ms);
}
poll().then(() => schedulePoll());

// ---------- Hilfsfunktionen ----------
const appCache = { list: null, at: 0 };
const iconCache = new Map();

async function getApps(force = false) {
  if (!force && appCache.list && Date.now() - appCache.at < 10 * 60_000) return appCache.list;
  let list;
  try {
    list = await remote.getApps();
  } catch {
    // Fallback: bekannte IDs einzeln abfragen (aktuelle Firmware beantwortet ed.installedApp.get nicht)
    const ids = [...new Set([...APP_CATALOG, ...(config.extraApps || [])])];
    const found = await Promise.all(ids.map((id) => appState(id).catch(() => null)));
    list = found.filter(Boolean).map((a) => ({ id: a.id, name: a.name.replace(/ /g, ' '), type: /^\d+$/.test(a.id) ? 2 : 4, icon: null }));
    // dieselbe App kann unter mehreren IDs auftauchen
    list = list.filter((a, i) => list.findIndex((b) => b.name === a.name) === i);
  }
  list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  if (list.length) Object.assign(appCache, { list, at: Date.now() });
  return list;
}

async function appState(id) {
  const res = await fetch(`http://${tvHost}:8001/api/v2/applications/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(2500) });
  return res.ok ? res.json() : null;
}

async function powerOn() {
  if (status.power === 'standby') {
    try { await remote.sendKey('KEY_POWER'); return 'key'; } catch {}
  }
  if (st.enabled) {
    try { await st.command('switch', 'on'); } catch {}
  }
  await wake({ mac: config.tv.mac, host: tvHost, broadcast: config.wolBroadcast });
  return 'wol';
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ---------- API-Routen ----------
const routes = {
  'GET /api/status': () => status,

  'GET /api/info': async () => {
    const device = await deviceInfo();
    return { ...device, tokenStored: Boolean(remote.token) };
  },

  'POST /api/key': async ({ body }) => {
    if (!/^KEY_[A-Z0-9_]+$/.test(body.key || '')) throw Object.assign(new Error('Ungültiger Tastencode'), { code: 400 });
    await remote.sendKey(body.key, body.cmd || 'Click');
    if (/KEY_(VOL|MUTE)/.test(body.key)) setTimeout(poll, 400);
    return { ok: true };
  },

  'POST /api/power': async ({ body }) => {
    const action = body.action === 'toggle' ? (status.power === 'on' ? 'off' : 'on') : body.action;
    if (action === 'off') {
      if (status.power !== 'on') return { ok: true, via: 'none' };
      await remote.sendKey('KEY_POWER');
      setTimeout(poll, 1500);
      return { ok: true, via: 'key' };
    }
    const via = await powerOn();
    setTimeout(poll, 2000);
    return { ok: true, via };
  },

  'POST /api/volume': async ({ body }) => {
    if (typeof body.mute === 'boolean') await dlna.setMute(body.mute);
    if (Number.isFinite(body.level)) await dlna.setVolume(body.level);
    update({ volume: await dlna.getVolume(), mute: await dlna.getMute() });
    return { ok: true };
  },

  'GET /api/apps': async ({ query }) => getApps(query.get('refresh') === '1'),

  'GET /api/apps/running': async () => {
    const apps = await getApps();
    const states = await Promise.all(apps.map((a) => appState(a.id).catch(() => null)));
    return apps.map((a, i) => ({ id: a.id, running: Boolean(states[i]?.running), visible: Boolean(states[i]?.visible) }))
      .filter((a) => a.running);
  },

  'POST /api/apps/launch': async ({ body }) => {
    // REST-Start liefert eine Rückmeldung; WebSocket als Ausweichweg
    const res = await fetch(`http://${tvHost}:8001/api/v2/applications/${encodeURIComponent(body.id)}`, { method: 'POST', signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (res?.ok) return { ok: true, via: 'rest' };
    const app = (await getApps()).find((a) => a.id === body.id);
    await remote.launchApp(body.id, app?.type ?? 2);
    return { ok: true, via: 'ws' };
  },

  'POST /api/apps/close': async ({ body }) => {
    const res = await fetch(`http://${tvHost}:8001/api/v2/applications/${encodeURIComponent(body.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) });
    return { ok: res.ok };
  },

  'POST /api/text': async ({ body }) => {
    await remote.sendText(String(body.text ?? ''), Boolean(body.submit));
    return { ok: true };
  },

  'POST /api/mouse': async ({ body }) => {
    if (body.click) await remote.mouseClick();
    else await remote.mouseMove(Number(body.dx) || 0, Number(body.dy) || 0);
    return { ok: true };
  },

  'POST /api/browser': async ({ body }) => {
    await remote.openBrowser(String(body.url));
    return { ok: true };
  },

  'POST /api/cast': async ({ body }) => {
    await dlna.cast(String(body.url), body.title || undefined);
    return { ok: true };
  },

  'POST /api/cast/control': async ({ body }) => {
    await dlna.transport(body.action);
    return { ok: true };
  },

  'GET /api/cast/info': () => dlna.transportInfo(),

  'POST /api/remote/reconnect': async () => {
    remote.disconnect();
    await remote.connect();
    return { ok: true, state: remote.state };
  },

  'POST /api/remote/forget': async () => {
    remote.forgetToken();
    return { ok: true };
  },

  'GET /api/st/status': async () => {
    if (!st.enabled) return { enabled: false };
    return { enabled: true, ...(await st.status()) };
  },

  'POST /api/st/command': async ({ body }) => {
    if (!st.enabled) throw Object.assign(new Error('SmartThings ist nicht konfiguriert'), { code: 400 });
    await st.command(body.capability, body.command, body.args || []);
    return { ok: true };
  },
};

// ---------- HTTP-Server ----------
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const publicDir = path.join(root, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(status)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  const iconMatch = req.method === 'GET' && url.pathname.match(/^\/api\/apps\/([^/]+)\/icon$/);
  if (iconMatch) {
    try {
      const id = decodeURIComponent(iconMatch[1]);
      if (!iconCache.has(id)) {
        const app = (await getApps()).find((a) => a.id === id);
        iconCache.set(id, app?.icon ? await remote.getIcon(app.icon) : null);
      }
      const img = iconCache.get(id);
      if (!img) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(img);
    } catch {
      res.writeHead(404); return res.end();
    }
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await handler({ body, query: url.searchParams }));
    } catch (err) {
      send(res, err.code === 400 ? 400 : 502, { error: err.message });
    }
    return;
  }

  // statische Dateien
  const file = path.normalize(path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, '::', () => {
  console.log(`TV-Web-Interface läuft auf http://localhost:${port}  (TV: ${tvHost}, SmartThings: ${st.enabled ? 'an' : 'aus'})`);
});
