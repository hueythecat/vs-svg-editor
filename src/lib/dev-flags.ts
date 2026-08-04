import { IS_PRODUCTION_UI } from './env';

// Dev-only overrides toggled from the dev rail, persisted so a choice survives the
// reload it is usually made in aid of. Same shape as ai-cache's enabled flag: read
// lazily (this module can be evaluated during SSR, where there is no localStorage) and
// asked at call time rather than mirrored into React state, so nothing re-renders off
// them and there's one source of truth.

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;   // access itself throws under some privacy settings
  }
};

// Ignore the review host's has_customised flag on a loaded asset — treat every asset as
// if it had never been customised, so no cooldown is ever recorded and the Customise
// pass stays reachable.
//
// Defaults ON: the cooldown is a 24h lockout, and one real customise run would
// otherwise put an asset out of reach for the rest of the day's testing. Turn it off to
// exercise the genuine cooldown behaviour.
//
// Deliberately inert in production: ignoring the host's own restriction is a dev
// convenience, not something a shipped build may decide to do.
const IGNORE_CUSTOMISED_KEY = 'svg-editor:ignore-has-customised';

let ignoreCustomised: boolean | null = null;

export const isIgnoreHasCustomised = (): boolean => {
  if (IS_PRODUCTION_UI) return false;
  if (ignoreCustomised === null) {
    ignoreCustomised = storage()?.getItem(IGNORE_CUSTOMISED_KEY) !== '0';   // absent ⇒ on
  }
  return ignoreCustomised;
};

export const setIgnoreHasCustomised = (on: boolean): void => {
  ignoreCustomised = on;
  try {
    storage()?.setItem(IGNORE_CUSTOMISED_KEY, on ? '1' : '0');
  } catch { /* preference is best-effort */ }
};

// Ignore the cooldown when Customise is clicked — run the pass instead of raising the
// "Already customised" message. The narrower sibling of the flag above: the cooldown is
// still read from the host and recorded, so the log still reports how long is left; only
// the block on the click is lifted.
//
// Defaults OFF, unlike [ignore has_customised]. That one already stops any cooldown
// being recorded, so a second flag defaulting on would be dead weight — this one is the
// escape hatch for when the first is turned off to exercise real cooldown handling and
// the pass still needs to run.
const IGNORE_COOLDOWN_KEY = 'svg-editor:ignore-cooldown-prompt';

let ignoreCooldown: boolean | null = null;

export const isIgnoreCooldownPrompt = (): boolean => {
  if (IS_PRODUCTION_UI) return false;
  if (ignoreCooldown === null) {
    ignoreCooldown = storage()?.getItem(IGNORE_COOLDOWN_KEY) === '1';   // absent ⇒ off
  }
  return ignoreCooldown;
};

export const setIgnoreCooldownPrompt = (on: boolean): void => {
  ignoreCooldown = on;
  try {
    storage()?.setItem(IGNORE_COOLDOWN_KEY, on ? '1' : '0');
  } catch { /* preference is best-effort */ }
};

// Ignore the host's entitlement flag — can_customise in the asset list, can_edit in the
// check response — and open every asset as editable, so the AI features are reachable
// on artwork that would otherwise send the Customise click to the upsell.
//
// Defaults OFF. Unlike the 24h cooldown, this gate doesn't get in the way over time:
// it's a fixed property of the asset, and it's a real product behaviour worth seeing by
// default. Turn it on to exercise the AI passes against a gated asset.
const IGNORE_CAN_CUSTOMISE_KEY = 'svg-editor:ignore-can-customise';

let ignoreCanCustomise: boolean | null = null;

export const isIgnoreCanCustomise = (): boolean => {
  if (IS_PRODUCTION_UI) return false;
  if (ignoreCanCustomise === null) {
    ignoreCanCustomise = storage()?.getItem(IGNORE_CAN_CUSTOMISE_KEY) === '1';   // absent ⇒ off
  }
  return ignoreCanCustomise;
};

export const setIgnoreCanCustomise = (on: boolean): void => {
  ignoreCanCustomise = on;
  try {
    storage()?.setItem(IGNORE_CAN_CUSTOMISE_KEY, on ? '1' : '0');
  } catch { /* preference is best-effort */ }
};
