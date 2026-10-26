import { initI18n, t, has, languages, language, setLanguage } from './i18n/i18n.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let state = {};
let toastTimer;

function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), error ? 4000 : 1800);
}

async function api(path, body, { silent = false } = {}) {
  try {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // the server sends a stable error code; translate it, otherwise show the original message
      const code = data.code && `errors.${data.code}`;
      throw new Error(code && has(code) ? t(code, data.vars) : data.error || res.statusText);
    }
    return data;
  } catch (err) {
    if (!silent) toast(err.message, true);
    throw err;
  }
}

const key = (k, cmd) => api('/api/key', { key: k, cmd }).catch(() => {});

// ---------- Keys, repeating while held ----------
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-key]');
  if (!btn || e.button > 0) return;
  e.preventDefault();
  key(btn.dataset.key);
  navigator.vibrate?.(8);
  if (!('repeat' in btn.dataset)) return;
  let interval;
  const delay = setTimeout(() => { interval = setInterval(() => key(btn.dataset.key), 160); }, 450);
  const stop = () => { clearTimeout(delay); clearInterval(interval); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
});
// keyboard activation of buttons (Enter/Space on a focused button)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-key]');
  if (btn && e.detail === 0) key(btn.dataset.key);
});

// ---------- Tabs ----------
const tabLoaders = {};
function showTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  try { localStorage.setItem('tab', name); } catch {}
  tabLoaders[name]?.();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Status (Server-Sent Events) ----------
let volDragging = false;
let serverLost = false;

function setChip(el, cls, text) {
  el.className = `chip ${cls}`;
  $('span', el).textContent = text;
}

function render(s) {
  const prev = state;
  state = s;
  serverLost = false;
  if (s.device) {
    $('#tv-name').textContent = s.device.name;
    $('#tv-model').textContent = `${s.device.model} · ${s.device.ip}`;
  }
  setChip($('#chip-power'), s.power === 'on' ? 'ok' : s.power === 'standby' ? 'warn' : 'bad', t(`status.power.${s.power}`));
  const remoteState = s.power === 'on' ? s.remote : 'disconnected';
  setChip($('#chip-remote'), remoteState === 'connected' ? 'ok' : remoteState === 'denied' ? 'bad' : remoteState === 'disconnected' ? '' : 'warn',
    t('status.control', { state: t(`status.remote.${remoteState}`) }));
  $('#power-btn').classList.toggle('on', s.power === 'on');

  const banner = $('#banner');
  if (s.power === 'on' && s.remote === 'pairing') {
    banner.hidden = false;
    banner.textContent = t('banner.pairing');
  } else if (s.power === 'on' && s.remote === 'denied') {
    banner.hidden = false;
    banner.textContent = t('banner.denied');
  } else {
    banner.hidden = true;
  }

  if (!volDragging && s.volume != null) setVolumeUi(s.volume);
  const mute = $('#mute-btn');
  mute.classList.toggle('active', Boolean(s.mute));
  $('use', mute).setAttribute('href', s.mute ? '#i-mute' : '#i-vol');
  $('span', mute).textContent = t(s.mute ? 'mute.on' : 'mute.off');

  $('#ime-hint').textContent = t(s.ime ? 'input.hintActive' : 'input.hintIdle');
  $('#ime-hint').classList.toggle('muted', !s.ime);

  if (s.remote === 'connected' && prev.remote !== 'connected' && !appsLoaded) loadApps();
  if (s.smartthings && !prev.smartthings) loadSmartThings();
}

function setVolumeUi(v) {
  const slider = $('#vol-slider');
  slider.value = v;
  slider.style.setProperty('--p', `${v}%`);
  $('#vol-value').textContent = v;
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    serverLost = true;
    setChip($('#chip-power'), 'bad', t('status.serverLost'));
  };
}

// ---------- Power, volume ----------
async function togglePower() {
  const action = state.power === 'on' ? 'off' : 'on';
  const r = await api('/api/power', { action }).catch(() => null);
  if (r) toast(t(action === 'off' ? 'power.turningOff' : r.via === 'wol' ? 'power.wolSent' : 'power.turningOn'));
}
$('#power-btn').addEventListener('click', togglePower);

let volTimer;
const slider = $('#vol-slider');
slider.addEventListener('input', () => {
  volDragging = true;
  setVolumeUi(Number(slider.value));
  clearTimeout(volTimer);
  volTimer = setTimeout(() => api('/api/volume', { level: Number(slider.value) }).catch(() => {}), 120);
});
slider.addEventListener('change', () => { setTimeout(() => { volDragging = false; }, 600); });
$('#mute-btn').addEventListener('click', () => api('/api/volume', { mute: !state.mute }).catch(() => {}));

// ---------- Apps ----------
let apps = [];
let appsLoaded = false;
const BRANDS = {
  Netflix: ['#e50914', 'N'], YouTube: ['#ff0000', '▶'], 'Prime Video': ['#00a8e1', 'prime'], 'Disney+': ['#0e2a8f', 'D+'],
  'Apple TV': ['#111', 'tv'], Spotify: ['#1db954', 'S'], Plex: ['#1f1f1f', 'P'], 'Rakuten TV': ['#bf0000', 'R'],
  DAZN: ['#0c161c', 'DAZN'], Joyn: ['#000', 'J'], 'RTL+': ['#0d2f74', 'RTL+'], 'Apple Music': ['#fa243c', '♪'],
};
const brand = (name) => Object.entries(BRANDS).find(([k]) => name.startsWith(k))?.[1];
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function showGridMessage(text) {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  $('#app-grid').replaceChildren(p);
}

async function loadApps(refresh = false) {
  const grid = $('#app-grid');
  if (!apps.length) showGridMessage(t('apps.loading'));
  try {
    apps = await api(`/api/apps${refresh ? '?refresh=1' : ''}`, undefined, { silent: true });
    appsLoaded = true;
    renderApps();
    loadRunning();
  } catch (err) {
    showGridMessage(t('apps.unavailable', { error: err.message }));
  }
}

function renderApps() {
  const q = $('#app-search').value.trim().toLowerCase();
  const grid = $('#app-grid');
  grid.replaceChildren();
  for (const app of apps.filter((a) => a.name.toLowerCase().includes(q))) {
    const el = document.createElement('button');
    el.className = 'app';
    el.dataset.id = app.id;
    el.title = t('apps.launch', { name: app.name });
    el.innerHTML = `<span class="dot" hidden></span>
      <span class="close" role="button"><svg><use href="#i-exit"/></svg></span>
      <span class="app-icon"></span>
      <span class="app-name"></span>`;
    $('.app-name', el).textContent = app.name;
    $('.close', el).title = t('apps.close');
    const b = brand(app.name);
    const icon = $('.app-icon', el);
    icon.style.setProperty('--h', hue(app.name));
    if (b) icon.style.setProperty('--bg-brand', b[0]);
    icon.textContent = b?.[1] || app.name.trim()[0]?.toUpperCase() || '?';
    if (icon.textContent.length > 2) icon.style.fontSize = '15px';
    if (app.icon) {
      const img = new Image();
      img.alt = '';
      img.loading = 'lazy';
      img.onload = () => $('.app-icon', el).replaceChildren(img);
      img.src = `/api/apps/${encodeURIComponent(app.id)}/icon`;
    }
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.close')) {
        await api('/api/apps/close', { id: app.id }).catch(() => {});
        toast(t('apps.closed', { name: app.name }));
        setTimeout(loadRunning, 800);
        return;
      }
      await api('/api/apps/launch', { id: app.id }).then(() => toast(t('apps.starting', { name: app.name }))).catch(() => {});
      setTimeout(loadRunning, 2500);
    });
    grid.append(el);
  }
  if (!grid.children.length) showGridMessage(t('apps.none'));
}

async function loadRunning() {
  const running = await api('/api/apps/running', undefined, { silent: true }).catch(() => []);
  const ids = new Map(running.map((r) => [r.id, r]));
  $$('.app').forEach((el) => {
    const r = ids.get(el.dataset.id);
    el.classList.toggle('running', Boolean(r));
    $('.dot', el).hidden = !r?.visible;
  });
}

$('#app-search').addEventListener('input', renderApps);
$('#apps-refresh').addEventListener('click', () => loadApps(true));
tabLoaders.apps = () => (appsLoaded ? loadRunning() : loadApps());

// ---------- Channels ----------
$('#channel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const num = $('#channel-input').value.replace(/\D/g, '');
  if (!num) return;
  if (stState?.capabilities?.includes('tvChannel')) {
    await api('/api/st/command', { capability: 'tvChannel', command: 'setTvChannel', args: [num] }).catch(() => {});
  } else {
    for (const d of num) await key(`KEY_${d}`);
    await key('KEY_ENTER');
  }
  toast(t('channels.switched', { number: num }));
  $('#channel-input').value = '';
});

// ---------- Input ----------
async function sendText(submit) {
  const text = $('#text-input').value;
  if (!text) return;
  await api('/api/text', { text, submit }).then(() => toast(t('input.textSent'))).catch(() => {});
  if (submit) $('#text-input').value = '';
}
$('#text-form').addEventListener('submit', (e) => { e.preventDefault(); sendText(true); });
$('#text-send').addEventListener('click', () => sendText(false));

$('#browser-form').addEventListener('submit', (e) => {
  e.preventDefault();
  api('/api/browser', { url: $('#browser-url').value }).then(() => toast(t('input.browserOpening'))).catch(() => {});
});

(() => {
  const pad = $('#touchpad');
  let last = null, moved = 0, acc = { x: 0, y: 0 }, flushing = false;
  const flush = async () => {
    if (flushing || (!acc.x && !acc.y)) return;
    flushing = true;
    const { x, y } = acc; acc = { x: 0, y: 0 };
    await api('/api/mouse', { dx: x * 2, dy: y * 2 }, { silent: true }).catch(() => {});
    flushing = false;
    if (acc.x || acc.y) flush();
  };
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); last = { x: e.clientX, y: e.clientY }; moved = 0; pad.classList.add('active'); });
  pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    moved += Math.abs(dx) + Math.abs(dy);
    acc.x += dx; acc.y += dy;
    flush();
  });
  const end = () => {
    if (last && moved < 6) api('/api/mouse', { click: true }, { silent: true }).catch(() => {});
    last = null; pad.classList.remove('active');
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', () => { last = null; pad.classList.remove('active'); });
})();

// ---------- Media ----------
$('#cast-form').addEventListener('submit', (e) => {
  e.preventDefault();
  api('/api/cast', { url: $('#cast-url').value, title: $('#cast-title').value || undefined })
    .then(() => { toast(t('media.started')); setTimeout(loadCastInfo, 1500); }).catch(() => {});
});
$$('[data-cast]').forEach((b) => b.addEventListener('click', () => {
  api('/api/cast/control', { action: b.dataset.cast }).then(() => setTimeout(loadCastInfo, 600)).catch(() => {});
}));
let castInfo = null;
async function loadCastInfo() {
  castInfo = await api('/api/cast/info', undefined, { silent: true }).catch(() => null);
  renderCastInfo();
}
function renderCastInfo() {
  const info = castInfo;
  const stateText = info?.state && has(`media.state.${info.state}`) ? t(`media.state.${info.state}`) : info?.state || '';
  $('#cast-info').textContent = info ? `${stateText}${info.position && info.duration && info.duration !== '0:00:00' ? ` · ${info.position} / ${info.duration}` : ''}` : '';
}
tabLoaders.media = loadCastInfo;

// ---------- SmartThings: picture, sound, inputs ----------
let stState = null;
function segments(container, modes, current, capability, command) {
  container.replaceChildren(...modes.map((m) => {
    const b = document.createElement('button');
    b.textContent = m;
    b.classList.toggle('active', m === current);
    b.addEventListener('click', async () => {
      await api('/api/st/command', { capability, command, args: [m] }).catch(() => {});
      toast(m);
      setTimeout(loadSmartThings, 800);
    });
    return b;
  }));
}

async function loadSmartThings() {
  if (!state.smartthings) return;
  const s = await api('/api/st/status', undefined, { silent: true }).catch((err) => ({ error: err.message }));
  stState = s;
  if (s.error) { $('#st-off-text').textContent = t('picture.stError', { error: s.error }); return; }
  $('#st-off').hidden = true;
  $('#st-on').hidden = false;
  segments($('#picture-modes'), s.pictureModes, s.pictureMode, 'custom.picturemode', 'setPictureMode');
  segments($('#sound-modes'), s.soundModes, s.soundMode, 'custom.soundmode', 'setSoundMode');
  $('#st-channel').textContent = s.channel ? t('channels.current', { channel: `${s.channel}${s.channelName ? ` – ${s.channelName}` : ''}` }) : '';
  if (s.inputs?.length) {
    $('#st-inputs-wrap').hidden = false;
    $('#st-inputs').replaceChildren(...s.inputs.map((i) => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.classList.toggle('active', i.id === s.input);
      b.innerHTML = '<strong></strong><span></span>';
      $('strong', b).textContent = i.name;
      $('span', b).textContent = i.id === s.input ? t('sources.active') : i.id;
      b.addEventListener('click', async () => {
        await api('/api/st/command', { capability: i.cap, command: 'setInputSource', args: [i.id] }).catch(() => {});
        setTimeout(loadSmartThings, 1000);
      });
      return b;
    }));
  }
}
tabLoaders.picture = loadSmartThings;
tabLoaders.sources = loadSmartThings;
tabLoaders.channels = loadSmartThings;

// ---------- All keys ----------
const KEY_GROUPS = {
  navigation: ['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_RETURN', 'KEY_EXIT', 'KEY_HOME', 'KEY_MENU', 'KEY_TOOLS', 'KEY_INFO'],
  sound: ['KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE'],
  tv: ['KEY_CHUP', 'KEY_CHDOWN', 'KEY_CH_LIST', 'KEY_PRECH', 'KEY_GUIDE', 'KEY_TTX_MIX', 'KEY_TV', 'KEY_CAPTION'],
  sources: ['KEY_SOURCE', 'KEY_HDMI1', 'KEY_HDMI2', 'KEY_HDMI3', 'KEY_HDMI4', 'KEY_HDMI'],
  playback: ['KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_REWIND', 'KEY_FF', 'KEY_REC'],
  colors: ['KEY_RED', 'KEY_GREEN', 'KEY_YELLOW', 'KEY_CYAN'],
  extras: ['KEY_PICTURE_SIZE', 'KEY_PMODE', 'KEY_AD', 'KEY_MULTI_VIEW', 'KEY_AMBIENT', 'KEY_SLEEP', 'KEY_3D', 'KEY_CONTENTS', 'KEY_POWER'],
};
function renderKeyGroups() {
  $('#key-groups').replaceChildren(...Object.entries(KEY_GROUPS).map(([group, codes]) => {
    const el = document.createElement('div');
    el.className = 'key-group';
    el.innerHTML = '<h3></h3><div class="key-grid"></div>';
    $('h3', el).textContent = t(`keys.group.${group}`);
    $('.key-grid', el).replaceChildren(...codes.map((code) => {
      const b = document.createElement('button');
      b.dataset.key = code;
      b.innerHTML = '<span></span><small></small>';
      $('span', b).textContent = t(`keys.${code}`);
      $('small', b).textContent = code;
      return b;
    }));
    return el;
  }));
}
$('#custom-key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#custom-key').value.trim().toUpperCase();
  key(code.startsWith('KEY_') ? code : `KEY_${code}`, $('#custom-cmd').value);
});

// ---------- Info ----------
const INFO_FIELDS = ['name', 'modelName', 'model', 'resolution', 'ip', 'wifiMac', 'networkType', 'OS', 'Language', 'countryCode', 'PowerState', 'tokenStored'];
async function loadInfo() {
  const info = await api('/api/info', undefined, { silent: true }).catch(() => null);
  const list = $('#info-list');
  const rows = info
    ? INFO_FIELDS.filter((k) => info[k] != null).map((k) => [t(`info.field.${k}`), typeof info[k] === 'boolean' ? t(info[k] ? 'info.yes' : 'info.no') : info[k]])
    : [[t('info.field.PowerState'), t('info.unreachable')]];
  list.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    return [dt, dd];
  }));
}
tabLoaders.info = loadInfo;
$('#reconnect').addEventListener('click', () => {
  toast(t('info.reconnecting'));
  api('/api/remote/reconnect', {}).then(() => toast(t('info.connected'))).catch(() => {});
});
$('#forget').addEventListener('click', async () => {
  if (!confirm(t('info.forgetConfirm'))) return;
  await api('/api/remote/forget', {}).catch(() => {});
  toast(t('info.forgotten'));
  loadInfo();
});

// ---------- Keyboard shortcuts ----------
const SHORTCUTS = {
  ArrowUp: 'KEY_UP', ArrowDown: 'KEY_DOWN', ArrowLeft: 'KEY_LEFT', ArrowRight: 'KEY_RIGHT', Enter: 'KEY_ENTER',
  Backspace: 'KEY_RETURN', Escape: 'KEY_EXIT', h: 'KEY_HOME', '+': 'KEY_VOLUP', '-': 'KEY_VOLDOWN', m: 'KEY_MUTE',
  PageUp: 'KEY_CHUP', PageDown: 'KEY_CHDOWN', ' ': 'KEY_PLAY', s: 'KEY_SOURCE', i: 'KEY_INFO', g: 'KEY_GUIDE',
};
let playing = false;
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Enter' && e.target.closest('button')) return;
  if (e.key === 'p') { togglePower(); return; }
  if (/^[0-9]$/.test(e.key)) { key(`KEY_${e.key}`); return; }
  let code = SHORTCUTS[e.key];
  if (!code) return;
  e.preventDefault();
  if (e.key === ' ') { code = playing ? 'KEY_PAUSE' : 'KEY_PLAY'; playing = !playing; }
  key(code);
});

// ---------- Language ----------
function renderLanguageParts() {
  if (state.power) render(state);
  if (serverLost) setChip($('#chip-power'), 'bad', t('status.serverLost'));
  $$('[data-hdmi]').forEach((el) => {
    el.textContent = t('arc' in el.dataset ? 'sources.hdmiArcSub' : 'sources.hdmiSub', { n: el.dataset.hdmi });
  });
  renderKeyGroups();
  if (appsLoaded) renderApps(); else if (!$('#app-grid').children.length) showGridMessage(t('apps.loading'));
  renderCastInfo();
  if (stState && !stState.error) loadSmartThings();
  if ($('[data-pane="info"]').classList.contains('active')) loadInfo();
}

const langSelect = $('#lang-select');
langSelect.replaceChildren(...languages.map(({ code, name }) => new Option(name, code)));
langSelect.addEventListener('change', () => setLanguage(langSelect.value));
window.addEventListener('languagechange', () => { langSelect.value = language(); renderLanguageParts(); });

// ---------- Start ----------
await initI18n();
connectEvents();
let startTab = 'apps';
try { startTab = localStorage.getItem('tab') || 'apps'; } catch {}
showTab($(`.tabs [data-tab="${startTab}"]`) ? startTab : 'apps');
