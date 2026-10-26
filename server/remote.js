// WebSocket-Fernbedienung (Port 8002, Token-Pairing) für Samsung Tizen TVs
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import WebSocket from 'ws';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

export class TvRemote extends EventEmitter {
  constructor({ host, name, tokenFile }) {
    super();
    this.host = host;
    this.name = name;
    this.tokenFile = tokenFile;
    this.token = this.#loadToken();
    this.ws = null;
    this.state = 'disconnected'; // disconnected | connecting | pairing | connected | denied
    this.connecting = null;
    this.pending = new Map(); // event -> [{resolve, reject, timer, match}]
    this.ime = false;
  }

  #loadToken() {
    try { return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).token || null; } catch { return null; }
  }

  #saveToken(token) {
    this.token = token;
    fs.writeFileSync(this.tokenFile, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && this.state === 'connected';
  }

  // Verbindet einmalig; beim ersten Mal erscheint auf dem TV die Freigabe-Abfrage.
  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      let url = `wss://${this.host}:8002/api/v2/channels/samsung.remote.control?name=${b64(this.name)}`;
      if (this.token) url += `&token=${this.token}`;
      this.#setState(this.token ? 'connecting' : 'pairing');

      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
      this.ws = ws;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        if (err) { ws.terminate(); reject(err); } else resolve();
      };
      // Pairing-Dialog am TV wartet ~30 s auf Bestätigung
      const timer = setTimeout(() => finish(new Error('Zeitüberschreitung beim Verbinden (Freigabe am TV bestätigt?)')), 40000);

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const { event, data } = msg;
        if (event === 'ms.channel.connect') {
          if (data?.token && data.token !== this.token) this.#saveToken(data.token);
          this.#setState('connected');
          finish();
        } else if (event === 'ms.channel.unauthorized') {
          this.#setState('denied');
          finish(new Error('Verbindung am TV abgelehnt'));
        } else if (event === 'ms.channel.timeOut') {
          this.#setState('disconnected');
          finish(new Error('Freigabe am TV nicht rechtzeitig bestätigt'));
        } else if (event === 'ms.remote.imeStart') {
          this.ime = true; this.emit('ime', true);
        } else if (event === 'ms.remote.imeEnd') {
          this.ime = false; this.emit('ime', false);
        }
        this.#resolvePending(event, data);
      });

      ws.on('error', (err) => finish(err));
      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null;
          if (this.state !== 'denied') this.#setState('disconnected');
        }
        for (const list of this.pending.values()) for (const p of list) { clearTimeout(p.timer); p.reject(new Error('Verbindung getrennt')); }
        this.pending.clear();
        finish(new Error('Verbindung zum TV getrennt'));
      });
    });
    return this.connecting;
  }

  disconnect() {
    this.ws?.close();
  }

  forgetToken() {
    this.token = null;
    try { fs.unlinkSync(this.tokenFile); } catch {}
    this.disconnect();
    this.#setState('disconnected');
  }

  #resolvePending(event, data) {
    const list = this.pending.get(event);
    if (!list) return;
    const idx = list.findIndex((p) => !p.match || p.match(data));
    if (idx < 0) return;
    const [p] = list.splice(idx, 1);
    clearTimeout(p.timer);
    p.resolve(data);
  }

  #await(event, match, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, match };
      p.timer = setTimeout(() => {
        const list = this.pending.get(event) || [];
        const i = list.indexOf(p);
        if (i >= 0) list.splice(i, 1);
        reject(new Error(`Keine Antwort vom TV (${event})`));
      }, timeout);
      if (!this.pending.has(event)) this.pending.set(event, []);
      this.pending.get(event).push(p);
    });
  }

  async #send(payload) {
    await this.connect();
    this.ws.send(JSON.stringify(payload));
  }

  #remote(params) {
    return this.#send({ method: 'ms.remote.control', params });
  }

  #emit(event, data) {
    return this.#send({ method: 'ms.channel.emit', params: { event, to: 'host', data } });
  }

  // cmd: Click | Press | Release
  sendKey(key, cmd = 'Click') {
    return this.#remote({ Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' });
  }

  async sendText(text, submit = false) {
    await this.#remote({ Cmd: b64(text), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' });
    if (submit) await this.#remote({ TypeOfRemote: 'SendInputEnd' });
  }

  mouseMove(dx, dy) {
    return this.#remote({
      Cmd: 'Move',
      Position: { x: Math.round(dx), y: Math.round(dy), Time: String(Date.now()) },
      TypeOfRemote: 'ProcessMouseDevice',
    });
  }

  mouseClick() {
    return this.#remote({ Cmd: 'LeftClick', TypeOfRemote: 'ProcessMouseDevice' });
  }

  async getApps() {
    await this.connect();
    const answer = this.#await('ed.installedApp.get', null, 2500);
    await this.#emit('ed.installedApp.get', '');
    const data = await answer;
    return (data?.data || []).map((a) => ({
      id: a.appId,
      name: a.name,
      type: a.app_type,
      icon: a.icon || null,
      locked: a.is_lock === 1,
    }));
  }

  // app_type 2 = Tizen-Web-App (DEEP_LINK), sonst NATIVE_LAUNCH
  launchApp(appId, appType, metaTag) {
    const data = { appId, action_type: appType === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH' };
    if (metaTag) data.metaTag = metaTag;
    return this.#emit('ed.apps.launch', data);
  }

  openBrowser(url) {
    return this.launchApp('org.tizen.browser', 4, url);
  }

  async getIcon(iconPath) {
    await this.connect();
    const answer = this.#await('ed.apps.icon', (d) => !d?.iconPath || d.iconPath === iconPath, 8000);
    await this.#emit('ed.apps.icon', { iconPath });
    const data = await answer;
    return data?.imageBase64 ? Buffer.from(data.imageBase64, 'base64') : null;
  }
}
