// DLNA/UPnP (Port 9197): Lautstärke, Stummschaltung und Medienwiedergabe per URL
import { AppError } from './errors.js';

const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const tag = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

export class Dlna {
  constructor(host) {
    this.base = `http://${host}:9197`;
  }

  async #soap(path, service, action, args = {}) {
    const body = Object.entries({ InstanceID: 0, ...args }).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
    const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${body}</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"` },
      body: envelope,
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = tag(text, 'errorDescription') || res.status;
      throw new AppError('dlna_failed', `DLNA ${action} failed: ${detail}`, { vars: { action, detail } });
    }
    return text;
  }

  #rc(action, args) { return this.#soap('/upnp/control/RenderingControl1', RC, action, args); }
  #avt(action, args) { return this.#soap('/upnp/control/AVTransport1', AVT, action, args); }

  async getVolume() {
    return Number(tag(await this.#rc('GetVolume', { Channel: 'Master' }), 'CurrentVolume'));
  }

  setVolume(level) {
    return this.#rc('SetVolume', { Channel: 'Master', DesiredVolume: Math.max(0, Math.min(100, Math.round(level))) });
  }

  async getMute() {
    return tag(await this.#rc('GetMute', { Channel: 'Master' }), 'CurrentMute') === '1';
  }

  setMute(mute) {
    return this.#rc('SetMute', { Channel: 'Master', DesiredMute: mute ? 1 : 0 });
  }

  async cast(url, title = 'Web Remote') {
    const mime = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url) ? 'image/*'
      : /\.(mp3|flac|aac|m4a|wav|ogg)(\?|$)/i.test(url) ? 'audio/*' : 'video/*';
    const cls = mime.startsWith('image') ? 'object.item.imageItem' : mime.startsWith('audio') ? 'object.item.audioItem' : 'object.item.videoItem';
    const meta = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${esc(title)}</dc:title><upnp:class>${cls}</upnp:class><res protocolInfo="http-get:*:${mime}:*">${esc(url)}</res></item></DIDL-Lite>`;
    await this.#avt('SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: meta });
    await this.#avt('Play', { Speed: 1 });
  }

  transport(action) {
    if (action === 'play') return this.#avt('Play', { Speed: 1 });
    if (action === 'pause') return this.#avt('Pause');
    if (action === 'stop') return this.#avt('Stop');
    throw new AppError('unknown_action', `Unknown action: ${action}`, { status: 400, vars: { action } });
  }

  async transportInfo() {
    const [t, p] = await Promise.all([this.#avt('GetTransportInfo'), this.#avt('GetPositionInfo')]);
    return {
      state: tag(t, 'CurrentTransportState'),
      uri: tag(p, 'TrackURI') || null,
      position: tag(p, 'RelTime'),
      duration: tag(p, 'TrackDuration'),
    };
  }
}
