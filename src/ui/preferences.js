// Small, non-essential menu preferences.
//
// Safari private windows, Firefox privacy settings, embedded browsers and
// storage-blocking extensions may expose `localStorage` but throw as soon as it
// is touched. A preference must never be allowed to stop the game starting, so
// these helpers keep a page-lifetime copy and treat persistent storage as an
// optional upgrade.

const memory = new Map();

export function readPreference(key, fallback = '') {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) {
      memory.set(key, value);
      return value;
    }
  } catch { /* storage is unavailable; use this page's in-memory value */ }
  return memory.has(key) ? memory.get(key) : fallback;
}

export function writePreference(key, value) {
  const saved = String(value);
  memory.set(key, saved);
  try { localStorage.setItem(key, saved); }
  catch { /* private/privacy mode: the preference lasts for this page only */ }
  return saved;
}
