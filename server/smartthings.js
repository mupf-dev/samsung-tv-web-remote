// Optional: SmartThings-Cloud für Bildmodus, Tonmodus, Quelle und Sender (nicht lokal steuerbar)
import { AppError } from './errors.js';

const API = 'https://api.smartthings.com/v1';

export class SmartThings {
  constructor({ token, deviceId }) {
    this.token = token;
    this.deviceId = deviceId || null;
  }

  get enabled() {
    return Boolean(this.token);
  }

  async #call(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (res.status === 401) throw new AppError('smartthings_unauthorized', 'SmartThings: token invalid or expired');
      throw new AppError('smartthings_http', `SmartThings error ${res.status}`, { vars: { status: res.status } });
    }
    return res.json();
  }

  async #device() {
    if (this.deviceId) return this.deviceId;
    const { items = [] } = await this.#call('/devices');
    const tv = items.find((d) => /tv/i.test(d.ocf?.ocfDeviceType || '') || /tv/i.test(d.deviceTypeName || ''))
      || items.find((d) => /QN900|TV/i.test(`${d.name} ${d.label}`));
    if (!tv) throw new AppError('smartthings_no_tv', 'No TV found in SmartThings');
    this.deviceId = tv.deviceId;
    return this.deviceId;
  }

  async status() {
    const id = await this.#device();
    const { components } = await this.#call(`/devices/${id}/status`);
    const main = components?.main || {};
    const v = (cap, attr) => main[cap]?.[attr]?.value ?? null;
    const modes = (map, list) => (map?.length ? map.map((m) => m.name) : list || []);

    const inputMap = v('samsungvd.mediaInputSource', 'supportedInputSourcesMap');
    return {
      deviceId: id,
      power: v('switch', 'switch'),
      pictureMode: v('custom.picturemode', 'pictureMode'),
      pictureModes: modes(v('custom.picturemode', 'supportedPictureModesMap'), v('custom.picturemode', 'supportedPictureModes')),
      soundMode: v('custom.soundmode', 'soundMode'),
      soundModes: modes(v('custom.soundmode', 'supportedSoundModesMap'), v('custom.soundmode', 'supportedSoundModes')),
      input: v('samsungvd.mediaInputSource', 'inputSource') ?? v('mediaInputSource', 'inputSource'),
      inputs: inputMap?.length
        ? inputMap.map((i) => ({ id: i.id, name: i.name || i.id, cap: 'samsungvd.mediaInputSource' }))
        : (v('mediaInputSource', 'supportedInputSources') || []).map((i) => ({ id: i, name: i, cap: 'mediaInputSource' })),
      channel: v('tvChannel', 'tvChannel'),
      channelName: v('tvChannel', 'tvChannelName'),
      capabilities: Object.keys(main),
    };
  }

  async command(capability, command, args = []) {
    const id = await this.#device();
    return this.#call(`/devices/${id}/commands`, {
      method: 'POST',
      body: JSON.stringify({ commands: [{ component: 'main', capability, command, arguments: args }] }),
    });
  }
}
