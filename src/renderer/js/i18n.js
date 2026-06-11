import { CATALOG, LANGUAGES, CONDITIONS, ALLERGIES } from '../i18n/strings.js';

let lang = 'en';

export function setLang(code) {
  lang = CATALOG[code] ? code : 'en';
  document.documentElement.lang = lang;
}
export function getLang() {
  return lang;
}

// Translate a dotted path, e.g. t('intake.firstName'). Falls back to English,
// then to the raw key if nothing is found.
export function t(path) {
  const lookup = (obj) =>
    path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const val = lookup(CATALOG[lang]);
  if (val != null) return val;
  const fallback = lookup(CATALOG.en);
  return fallback != null ? fallback : path;
}

export function conditions() {
  return CONDITIONS.map((c) => ({ key: c.key, flag: c.flag, label: c[lang] || c.en }));
}
export function allergies() {
  return ALLERGIES.map((a) => ({ key: a.key, label: a[lang] || a.en }));
}
export function languageList() {
  return LANGUAGES;
}

// Read-aloud using the browser speech engine (offline, built into Chromium).
let speaking = false;
export function speak(text, onEnd) {
  if (!('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'es' ? 'es-ES' : 'en-US';
  u.rate = 0.95;
  u.onend = () => { speaking = false; if (onEnd) onEnd(); };
  speaking = true;
  window.speechSynthesis.speak(u);
  return true;
}
export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  speaking = false;
}
export function isSpeaking() {
  return speaking;
}
