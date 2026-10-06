// Which font families Google Fonts actually serves — server-side, for checking the
// families a model suggests before they are offered in the Font list.
//
// The models are told to name Google Fonts and mostly do, but not always: the local
// model in particular answers with Avenir Next, Gotham, Helvetica Neue and Arial. Offered
// as-is, those sit in the Font dropdown looking like any other suggestion and render in a
// fallback face when picked.
//
// The catalogue is the test, not the stylesheet endpoint. css2?family=… looks like the
// obvious probe and is wrong: it answers 200 for "Helvetica Neue" and "Garamond" with a
// metric-compatible stand-in, so asking it whether a family exists says yes to exactly
// the names this is here to remove.

const CATALOGUE_URL = 'https://fonts.google.com/metadata/fonts';
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
// A failed fetch is retried sooner than a good catalogue is refreshed, but not on every
// request — an offline dev machine shouldn't add a timeout to each pass.
const RETRY_AFTER_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// Lower-cased family → the name as Google lists it.
let catalogue: Map<string, string> | null = null;
let fetchedAt = 0;
let failedAt = 0;
let inFlight: Promise<Map<string, string> | null> | null = null;

const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

async function loadCatalogue(): Promise<Map<string, string> | null> {
  const now = Date.now();
  if (catalogue && now - fetchedAt < CATALOGUE_TTL_MS) return catalogue;
  if (!catalogue && now - failedAt < RETRY_AFTER_MS) return null;
  inFlight ??= (async () => {
    try {
      const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Served with an anti-JSON-hijacking prefix some of the time; start at the object.
      const text = await res.text();
      const data = JSON.parse(text.slice(text.indexOf('{'))) as { familyMetadataList?: Array<{ family?: unknown }> };
      const families = (data.familyMetadataList ?? []).flatMap((f) => (typeof f.family === 'string' ? [f.family] : []));
      if (families.length === 0) throw new Error('empty catalogue');
      catalogue = new Map(families.map((f) => [key(f), f]));
      fetchedAt = Date.now();
      console.log(`[google-fonts] catalogue loaded: ${families.length} families`);
    } catch (err) {
      failedAt = Date.now();
      console.log('[google-fonts] catalogue unavailable:', err instanceof Error ? err.message : err);
    } finally {
      inFlight = null;
    }
    // A stale catalogue beats none: families are added far more often than removed.
    return catalogue;
  })();
  return inFlight;
}

// The names Google serves, in the order given and spelled the way Google spells them
// ("open sans" comes back as "Open Sans"), without duplicates.
//
// Fails open. If the catalogue can't be fetched, every name is kept: dropping a font we
// could not check would turn a network blip into an empty Font list, and an unverified
// suggestion is what the editor shipped with before this existed.
export async function onlyGoogleFonts(names: string[]): Promise<string[]> {
  const known = await loadCatalogue();
  if (!known) return names;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const name of names) {
    const family = known.get(key(name));
    if (!family) dropped.push(name);
    else if (!kept.includes(family)) kept.push(family);
  }
  if (dropped.length) console.log(`[google-fonts] not Google Fonts, dropped: ${dropped.join(', ')}`);
  return kept;
}
