// Artwork pinned from the id tag above the canvas, listed at the top of the dev rail so it
// is one click away on the next visit. Dev-only, and kept in this browser's localStorage
// like the rail's other preferences (dev-flags.ts) — nothing is sent anywhere.
//
// A pin carries whatever it takes to open the artwork again, which depends on where it
// came from:
//   review — the review host's edit_uuid, reopened through the same check / download /
//            cooldown path as the dropdown, so it is the asset as the host has it now
//   sample — a bundled file's path
//   file   — a dropped or browsed file (or a fetched download) has nothing to go back to,
//            so its SVG text is stored as it was loaded
// plus a small PNG thumbnail for the card, rendered once when it is pinned.

export type Pin = {
  name: string;          // the editor's artwork name (vectorstock_<id>.svg) — the pin's key
  label: string;
  thumb: string;         // data:image/png URL
  pinnedAt: number;
} & (
  | { kind: 'review'; uuid: string }
  | { kind: 'sample'; src: string }
  | { kind: 'file'; svg: string }
);

const KEY = 'svg-editor:pinned';
// A file pin stores the whole SVG, and localStorage holds about 5 MB per site in total.
// Past this one file would crowd out every other pin, so it is refused instead.
export const MAX_PINNED_SVG_CHARS = 1_500_000;

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;   // access itself throws under some privacy settings
  }
};

export function getPins(): Pin[] {
  try {
    const raw = storage()?.getItem(KEY);
    const pins = raw ? JSON.parse(raw) : [];
    return Array.isArray(pins) ? pins.filter((p) => p && typeof p.name === 'string' && typeof p.kind === 'string') : [];
  } catch {
    return [];
  }
}

// Null when the list could not be saved (storage full or blocked): the caller keeps what
// it had rather than showing a pin that would be gone on the next visit.
function save(pins: Pin[]): Pin[] | null {
  try {
    const s = storage();
    if (!s) return null;
    s.setItem(KEY, JSON.stringify(pins));
    return pins;
  } catch {
    return null;
  }
}

/** Pin (newest first), replacing an older pin of the same artwork. */
export const addPin = (pin: Pin): Pin[] | null =>
  save([pin, ...getPins().filter((p) => p.name !== pin.name)]);

export const removePin = (name: string): Pin[] | null =>
  save(getPins().filter((p) => p.name !== name));
