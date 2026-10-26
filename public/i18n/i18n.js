// Small i18n module: one dictionary file per language in ./locales, registered in ./locales/index.js.
// English is the fallback for any missing key.
//
// In HTML:   data-i18n="key"              → textContent
//            data-i18n-html="key"         → innerHTML (only for trusted strings from the dictionaries)
//            data-i18n-placeholder="key"  → placeholder
//            data-i18n-title="key"        → title
//            data-i18n-aria-label="key"   → aria-label
// In JS:     t('key', { name: 'Netflix' }) → "Starting Netflix"
import { LOCALES, FALLBACK } from './locales/index.js';

const STORAGE_KEY = 'lang';
let current = FALLBACK;
let dict = {};
let fallbackDict = {};

const load = async (code) => (await import(`./locales/${code}.js`)).default;

function detect() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch {}
  const candidates = [saved, ...(navigator.languages || [navigator.language])].filter(Boolean);
  for (const c of candidates) {
    const base = c.toLowerCase().split('-')[0];
    if (LOCALES.some((l) => l.code === base)) return base;
  }
  return FALLBACK;
}

export const languages = LOCALES;
export const language = () => current;

export function has(key) {
  return key in dict || key in fallbackDict;
}

export function t(key, vars = {}) {
  const text = dict[key] ?? fallbackDict[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  document.documentElement.lang = current;
  document.title = t('app.title');
}

export async function setLanguage(code) {
  if (!LOCALES.some((l) => l.code === code)) code = FALLBACK;
  dict = code === FALLBACK ? fallbackDict : await load(code);
  current = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch {}
  translateDom();
  window.dispatchEvent(new CustomEvent('languagechange', { detail: code }));
}

export async function initI18n() {
  fallbackDict = await load(FALLBACK);
  await setLanguage(detect());
}
