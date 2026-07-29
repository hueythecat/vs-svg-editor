import { IS_PRODUCTION_UI } from './env';

// Dev-only response cache for the vision passes.
//
// A customise or strip-text run costs ~10s and a paid API call, and iterating on the
// code that CONSUMES the response means making the identical call against the identical
// artwork over and over — revert, run again, edit, reload, run again. Keyed by a hash of
// the exact marked SVG that goes to the model plus the model name, so any real change to
// the input (or swapping models) misses and re-requests.
//
// Backed by localStorage as well as memory, because the reloads that fast refresh causes
// are exactly what would otherwise throw the cache away.
//
// Deliberately inert in production: serving a real user a stale AI response for artwork
// that merely hashes the same would be a bug, not a saving.

const PREFIX = 'svg-editor:ai-cache:';

// Whether the cache is live, toggled from the dev rail. Persisted so the choice
// survives the reload it is usually made in aid of. Defaults ON — the whole point is
// not paying for the same call twice while iterating; turn it off when you want a run
// to genuinely hit the model, e.g. after editing a prompt (prompts aren't part of the
// key, so an edited prompt over unchanged artwork would otherwise keep hitting).
const ENABLED_KEY = 'svg-editor:ai-cache-enabled';

// localStorage is per-origin and shared with everything else on it; a few dozen vision
// responses is plenty of history for iterating, and bounds what we can hog.
const MAX_ENTRIES = 40;

// Memory tier: avoids a JSON round-trip through localStorage on repeat hits within a
// session, and keeps working if storage is unavailable (private mode, quota, SSR).
const memory = new Map<string, string>();

// `output: "server"` means this module can be evaluated during SSR, where there is no
// localStorage at all.
const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;   // access itself throws under some privacy settings
  }
};

// Read lazily rather than at module scope: this file can be imported during SSR, where
// there is no storage to read the preference from.
let enabled: boolean | null = null;

// Off also means "don't write". A toggle labelled "cache AI responses" that quietly kept
// recording would hand back a surprise entry the moment it was switched back on.
export const isAiCacheEnabled = (): boolean => {
  if (IS_PRODUCTION_UI) return false;
  if (enabled === null) enabled = storage()?.getItem(ENABLED_KEY) !== '0';   // absent ⇒ on
  return enabled;
};

export const setAiCacheEnabled = (on: boolean): void => {
  enabled = on;
  try { storage()?.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* preference is best-effort */ }
};

export const readAiCache = (key: string): string | null => {
  if (!isAiCacheEnabled()) return null;
  const hit = memory.get(key);
  if (hit !== undefined) return hit;
  const stored = storage()?.getItem(PREFIX + key) ?? null;
  if (stored !== null) memory.set(key, stored);
  return stored;
};

export const writeAiCache = (key: string, value: string): void => {
  if (!isAiCacheEnabled()) return;
  memory.set(key, value);
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PREFIX + key, value);
    evict(store);
  } catch {
    // Out of quota (ours or someone else's on this origin). Drop our entries and keep
    // the one we just tried to write — the memory tier still serves this session.
    clearAiCache();
    try { store.setItem(PREFIX + key, value); } catch { /* give up; memory tier stands */ }
  }
};

// Trims oldest-first. Insertion order of localStorage keys isn't guaranteed, so entries
// carry no timestamps and this is approximate — it exists to bound the footprint, not to
// implement a precise LRU.
const evict = (store: Storage): void => {
  const keys = Object.keys(store).filter((k) => k.startsWith(PREFIX));
  for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) store.removeItem(k);
};

// Exported for the console: `clearAiCache()` after changing a prompt, when you want the
// next run to actually hit the model even though the artwork hasn't changed.
export const clearAiCache = (): void => {
  memory.clear();
  const store = storage();
  if (!store) return;
  for (const k of Object.keys(store)) {
    if (k.startsWith(PREFIX)) store.removeItem(k);
  }
};
