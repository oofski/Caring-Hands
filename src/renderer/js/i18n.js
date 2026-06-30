import { CATALOG, LANGUAGES, CONDITIONS, ALLERGIES, REFERRALS } from '../i18n/strings.js';

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
export function referrals() {
  return REFERRALS.map((r) => ({ key: r.key, label: r[lang] || r.en }));
}
// Resolve a stored referral key to a localized label (passes through legacy free text).
export function referralLabel(key) {
  const r = REFERRALS.find((x) => x.key === key);
  return r ? (r[lang] || r.en) : (key || '');
}
// All known languages, or only those enabled for an event (CSV string of codes).
export function languageList(enabledCsv) {
  if (!enabledCsv) return LANGUAGES;
  const codes = String(enabledCsv).split(',').map((s) => s.trim()).filter(Boolean);
  const filtered = LANGUAGES.filter((l) => codes.includes(l.code));
  return filtered.length ? filtered : LANGUAGES.filter((l) => l.code === 'en');
}

// Read-aloud using the browser speech engine (offline, built into Chromium).
let speaking = false;
export function speak(text, onEnd) {
  if (!('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  // Map each pack to the closest available TTS voice (Kriol/Nyanja fall back to English).
  const ttsLang = { en: 'en-US', es: 'es-ES', ru: 'ru-RU', bzj: 'en-US', nya: 'en-US' };
  u.lang = ttsLang[lang] || 'en-US';
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
