// The AI text passes' pure helpers: the shared prompt and models, reading the model's
// answer, getting fonts ready to measure, and hiding what a pass took out. Nothing here
// touches React state — the editor component calls in with the document and gets values
// back — which is the whole reason it lives apart from svg-drop-zone.

import type { RemovedRecord } from '@/components/editor-types';
import { type TextRow, measureRemovedTextBoxes, sampleElementInkColors } from '@/lib/svg-utils';

// Shared text-detection + element-identification instructions used by BOTH the
// strip-text pass and the customise pass, so the two never drift apart. Callers
// wrap this with their own intro line, any extra tasks (e.g. font suggestions),
// the marked SVG source, and the JSON output schema.
// Both passes also share one model, so an A/B model swap flips strip-text and
// customise together and they can't drift apart.
export const TEXT_PARSE_MODEL = 'claude-sonnet-4-6';
// The DOM-regions text detection (/api/svg-text) runs on its own model, not the dropdown's:
// Sonnet 5 at low effort matched Opus 5.5 on the reference file (36/36 fields, words
// split right) at about half the cost and a little faster. Haiku 4.5 misread regions.
export const TEXT_DETECT_MODEL = 'claude-sonnet-5';
export const TEXT_DETECT_EFFORT = 'low';
export const TEXT_PARSING_PROMPT = `TASK 1 — Text detection: Examine the image carefully. Detect ALL text present, including text rendered as outlined or filled path shapes (not just SVG <text> elements). A ROW is one LINE of text. "MICHAEL DOE" is one row, even when "DOE" is a different colour or weight from "MICHAEL" — a line is never returned as two rows, and a row never holds two lines. For each row, estimate:
- yFraction: vertical center as a fraction of image height (0.0 = top edge, 1.0 = bottom edge)
- xFraction: horizontal center as a fraction of image width (0.0 = left, 1.0 = right)
- leftFraction: the LEFT edge of this row's lettering, as a fraction of image width — where its first glyph begins, NOT counting any icon, bullet or ornament sitting beside it
- rightFraction: the RIGHT edge of this row's lettering, same scale — where its last glyph ends
  Report leftFraction and rightFraction as what you can actually see, per row. Do NOT copy one row's value onto another to tidy them up: rows that share an edge will come back with the same number by themselves, and that agreement is the signal. Forcing it destroys it.
- font: the Google Font that most closely matches THIS row's own lettering. Judge each row separately — one design routinely mixes families, and picking a single family for the whole image is a wrong answer for every row that does not use it. Match the letterforms actually visible in this row: script or handwritten lettering needs a script face (Dancing Script, Great Vibes, Pacifico, Sacramento), a serif needs a serif (Playfair Display, Cormorant Garamond, Cinzel), condensed lettering needs a condensed face (Barlow Condensed, Oswald), geometric sans needs a geometric sans (Montserrat, Poppins). Only give two rows the same family when their letterforms really are the same
- sizeFraction: font cap-height as a fraction of image height (e.g. 0.08 if text height ≈ 8% of image)
- weight: CSS font-weight integer (100, 200, 300, 400, 500, 600, 700, 800, or 900)
- color: THIS row's own colour as CSS hex, as it appears in the image — composited over whatever sits behind it, not the colour it would be on white. Where an element in the SVG below carries data-fill, that is the colour it renders as, already composited (blend modes and opacity included): read the data-fill of the elements you name in this row's removeIds and report that value, and only judge colour by eye for a row whose elements you cannot identify. Judge each row on its own — a card routinely sets a heading in one colour and its body text in another, and a light heading over a mid-tone panel can sit directly above dark body text on the same panel. Do NOT give every row the same colour unless every row really is that colour, and do NOT assume text is white because other text on the image is.
- content: the exact text string if legible, else ""
- curve: how far THIS row's baseline bends, as a signed whole number from -100 to 100. 0 means the letters sit on a straight line — including a straight line that is rotated. The size is the baseline's total change of direction from its first letter to its last, as a share of a half-circle: if the first and last letters lean 45° apart it is 25, 90° apart is 50, a full semicircle is 100. The sign is the shape: POSITIVE when the row arches like the top of a circle (its middle higher than its ends, ∩), NEGATIVE when it sags like a smile (its middle lower than its ends, ∪). Judge it from the tilt of the letters at each end, not from the ornament around the text.
- letterSpacing: CSS letter-spacing in em units. Default to 0.0 (normal) if you are not certain — only use a non-zero value when you can clearly see unusually wide or condensed tracking (e.g. 0.1 slightly wide, 0.3 very wide, -0.05 condensed)

- spans: OPTIONAL. Only when the line is not all one style. The line broken into consecutive runs, in reading order, each { "text": "...", "color": "#hex", "weight": 400 }. Joining every span's text, with a single space between runs that are separated by one in the image, must reproduce "content" exactly. A line in one style has no spans — leave the field out.
  Example: "MICHAEL DOE" set with DOE bolder and whiter is ONE row, content "MICHAEL DOE", spans [{"text":"MICHAEL","color":"#cfcfe8","weight":300},{"text":"DOE","color":"#ffffff","weight":700}].
  The row's own color, weight and font describe its dominant run; spans override them for the runs that differ. Do NOT give a span its own position — the runs sit side by side on the line and are laid out in the order you give them.

TASK 2 — Text element identification: Most SVG elements in the source have a data-ai-idx attribute. Identify which elements visually render as text — including <text>/<tspan> elements AND <path>/<g> elements whose shapes form letter or word outlines. IMPORTANT: if a <g> group contains child paths that together form a word, return the group's data-ai-idx (not the individual letter path indices). Return every text element's data-ai-idx in "removeIds". NOTE: already-editable text fields have deliberately NOT been given a data-ai-idx — never invent indices for them; only return indices that actually appear in the source below.

TASK 3 — Row ↔ element linking: Each row from TASK 1 also carries its own "removeIds" array: the TASK 2 indices whose shapes draw THAT row's text. This linking is what lets the replacement field be positioned from the original's real geometry instead of your estimate, so it matters more than the fraction estimates do — leave a row's array empty only when you genuinely cannot tell which elements draw it.

CRITICAL: check EVERY row for a curved baseline before answering, and give "curve" on every row. Logos, badges, seals and banners very often set a name or tagline along an arc — around a circle, or along a ribbon under an emblem — and that lettering is curved even when it is short or small. Look at the letters at each end of the row: if they lean away from each other (tops spreading apart) the row sags and curve is negative; if they lean toward each other (tops closing in) the row arches and curve is positive. Only a row whose letters all stand upright on one straight line is 0.

CRITICAL: a differently-styled word is a SPAN, never a row of its own. Returning "MICHAEL DOE" and also "MICHAEL" and "DOE" is one line of text read three times, and all three get drawn on top of each other. Each piece of lettering in the image belongs to exactly ONE row.

CRITICAL: linking NEVER adds a row. Many indices can point at one row; a row is never split to give an index a home. Artwork often draws one word several times over — a shadow copy, an outline copy and a fill copy stacked on the same spot — and every one of those indices belongs to the SINGLE row for that word. If you are about to emit two rows with the same content, emit one row listing both indices instead — wherever on the image you think they sit.`;

// Every AI prompt below demands bare JSON, and both providers ignore that often enough to
// matter: a ```json fence around the object, or — seen once the text prompt grew a third
// task — a paragraph of reasoning before it ("Looking at the image, I can identify two
// lines of text: ..."). Either one makes JSON.parse throw on a reply whose JSON was
// perfectly good, and the failure surfaces to the user as "AI returned an unreadable
// response" with the whole answer discarded.
//
// So don't demand that the reply BE json — find the json in it. The first balanced
// {...} is the object every one of these prompts asks for. Braces inside strings are not
// structure (a `d="M0 0h4z"` payload is full of them, and one stray brace in a path or a
// font name would otherwise end the scan early), and a backslash-escaped quote does not
// close a string.
export const extractJson = (raw: string): string => {
  const unfenced = raw.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim();
  if (unfenced.startsWith('{')) return unfenced;
  const start = unfenced.indexOf('{');
  if (start === -1) return unfenced; // no object at all — let the caller's parse report it
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const c = unfenced[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return unfenced.slice(start, i + 1);
  }
  return unfenced; // unbalanced — truncated mid-answer, and logUnreadable will say so
};

// The distinct faces a set of detected rows needs — one per (family, weight) pair.
//
// Keyed on the pair, not the family, because the weight is part of what the model matched:
// a wordmark answered as Montserrat 800 is not rendered by Montserrat 400, and a field
// sized against the wrong weight is measured too narrow and comes out too large.
const rowFontFaces = (rows: TextRow[]): { family: string; weight: number }[] => {
  const faces = new Map<string, { family: string; weight: number }>();
  for (const row of rows) {
    const family = (row.font ?? '').trim();
    if (!family) continue;
    const weight = Number(row.weight) || 400;
    faces.set(`${family}@${weight}`, { family, weight });
  }
  return [...faces.values()];
};

// Waits until each row's own face is actually usable, so the widths appendTextRowLayers
// measures are the real face's and not a fallback's — the two can differ by a fifth, and
// that error goes straight into the font size it derives from them.
//
// document.fonts.ready is NOT enough on its own, which is what this used to await. It
// settles the loads already PENDING, and a <link> injected moments earlier has only
// declared @font-face rules — the files are not fetched until something lays out text in
// them. It therefore resolves happily while every face is still absent. document.fonts.load
// is the primitive that actually requests a face and resolves when it can be used.
//
// But document.fonts.load only knows the faces its @font-face rules declare, and those
// arrive with the Google Fonts stylesheet — a <link> injected a moment earlier whose CSS
// has not loaded yet. Until it has, load() finds no matching face and resolves at once
// with nothing, and check() reports true, because a family with no declared faces counts
// as "nothing to wait for". Every row was then measured in a fallback face: on a crest
// logo both curved rows measured an identical 208 units against real widths of 207 and
// 251, and "restaurant" was sized up to fill the gap. So the stylesheets are awaited
// first, and a face only counts as ready when load() actually returned one.
//
// Bounded and individually caught: a font that never arrives must not strand the edit, and
// a family that has no such weight must not stop the others loading.
const FONT_SETTLE_TIMEOUT_MS = 4000;
const fontStylesheetsLoaded = (): Promise<unknown> =>
  Promise.all(
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[id^="gfont-"]')).map((link) =>
      link.sheet
        ? undefined
        : new Promise((resolve) => {
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', resolve, { once: true });
          })),
  );
export const ensureRowFontsReady = async (rows: TextRow[]): Promise<void> => {
  if (typeof document === 'undefined' || !document.fonts) return;
  const faces = rowFontFaces(rows);
  if (faces.length === 0) return;
  const found = new Set<string>();
  try {
    await Promise.race([
      fontStylesheetsLoaded().then(() => Promise.all(faces.map((f) =>
        document.fonts.load(`${f.weight} 16px "${f.family}"`)
          .then((loaded) => { if (loaded.length > 0) found.add(`${f.family}@${f.weight}`); })
          .catch(() => undefined),
      ))),
      new Promise((resolve) => setTimeout(resolve, FONT_SETTLE_TIMEOUT_MS)),
    ]);
    const missing = faces.filter((f) => !found.has(`${f.family}@${f.weight}`));
    if (missing.length) {
      console.log(
        `[text-rows] ${missing.length}/${faces.length} face(s) unavailable, falling back for: ` +
        missing.map((f) => `${f.family} ${f.weight}`).join(', '),
      );
    }
  } catch { /* font loading is best-effort — measure with whatever is available */ }
};

// Coerces a row's removeIds to the string array the anchoring expects. The model is asked
// for strings and mostly obliges, but a JSON number index would silently miss every
// data-ai-idx lookup, and an absent array is legitimate — it means "couldn't tell".
export const normaliseRowRemoveIds = (row: TextRow): void => {
  row.removeIds = Array.isArray(row.removeIds) ? row.removeIds.map(String) : [];

  // The edges are optional and stay optional: a cached answer from before they were asked
  // for has none, and a model is free to omit them. Anything that is not a sane fraction
  // with left before right is dropped rather than half-trusted — downstream treats absent
  // as "no opinion" and falls back to geometry, which is the behaviour that existed
  // before, so a bad value is strictly worse than none.
  const frac = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
  };
  // Spans must reproduce the row's own content, or they are not a breakdown of it — a
  // model that drops or invents a word would otherwise silently change what gets drawn.
  // Checked on the joined text, and thrown away whole if it does not match, because a
  // partial breakdown is worse than none: the row still renders, just in one style.
  const spans = Array.isArray(row.spans) ? row.spans : null;
  if (spans && spans.length > 1) {
    const clean = spans
      .filter((sp) => sp && typeof sp.text === 'string' && sp.text.trim() !== '')
      .map((sp) => ({
        text: String(sp.text),
        color: typeof sp.color === 'string' ? sp.color : undefined,
        weight: Number.isFinite(Number(sp.weight)) ? Number(sp.weight) : undefined,
        font: typeof sp.font === 'string' ? sp.font : undefined,
      }));
    const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
    row.spans = clean.length > 1 && norm(clean.map((sp) => sp.text).join(' ')) === norm(row.content ?? '')
      ? clean
      : undefined;
  } else {
    row.spans = undefined;
  }

  // Curve on the Curve slider's own scale. Anything unusable is no curve at all — a bad
  // value would bend a straight row, and straight is what every row was before this.
  const curve = Number(row.curve);
  row.curve = Number.isFinite(curve) ? Math.round(Math.max(-100, Math.min(100, curve))) : undefined;

  const left = frac(row.leftFraction);
  const right = frac(row.rightFraction);
  row.leftFraction = left !== undefined && right !== undefined && right > left ? left : undefined;
  row.rightFraction = row.leftFraction === undefined ? undefined : right;
};

// An unparseable answer reaches the user as "AI returned an unreadable response" and
// nothing else — the payload is dropped on the floor, which makes the one failure that
// most needs evidence the only one that leaves none. Log enough to tell the two causes
// apart: a truncated answer (hit the token ceiling — ends mid-token, no closing brace)
// versus a malformed one (prose, an apology, a stray fence).
export const logUnreadable = (tag: string, raw: string, err: unknown): void => {
  const text = raw ?? '';
  const closed = text.trimEnd().endsWith('}');
  console.log(
    `[${tag}] unreadable response: ${text.length} chars, ${closed ? 'ends with "}" (malformed, not truncated)' : 'does NOT end with "}" — looks TRUNCATED'}`,
    `\n  parse error: ${err instanceof Error ? err.message : String(err)}`,
    `\n  head: ${text.slice(0, 200)}`,
    `\n  tail: ${text.slice(-200)}`,
  );
};

// Every index the answer names anywhere, top-level or inside a row.
//
// The model is asked for a document-wide removeIds AND a per-row linking, and it does not
// reliably keep the two in step — an index named only by a row is otherwise never
// deleted, which leaves the original artwork sitting underneath the field that replaced
// it. The union is always safe: a row naming an index is the model asserting that element
// draws that row's text, which is the same claim the top-level list makes.
// Coerced to strings, not merely collected. The model is asked for string indices and
// returns them for most artwork, but on some it answers with JSON numbers — [184, 202]
// rather than ["184", "202"] — and the two are not interchangeable downstream. The
// removal looks elements up in a Map keyed by string, so map.get(184) misses and the
// element is never deleted; the measuring path interpolates into `[data-ai-idx="${sid}"]`,
// where a number stringifies and works fine. The result is the worst possible split: the
// replacement text is measured and placed perfectly, on top of artwork that was never
// removed. Normalising here covers both passes, since both route through this.
export const allRemoveIds = (parsed: { removeIds: unknown[]; rows?: TextRow[] }): string[] =>
  [...new Set([
    ...parsed.removeIds.map(String),
    ...(parsed.rows ?? []).flatMap((r) => (r.removeIds ?? []).map(String)),
  ])];

// The same SVG with hidden elements dropped — what the artwork actually looks like now.
//
// Every AI pass rasterises the document to see it, and hidden elements are still in that
// document. Without this a second run sees the lettering the first run took, detects it
// again, and hides a duplicate set behind the text fields already standing there. Mirrors
// what `exportSvg` does for the same reason: hidden means gone from every rendering of
// the artwork, and only the editor knows otherwise.
export const svgWithoutHidden = (svg: string, hidden: Set<string>): string => {
  if (hidden.size === 0) return svg;
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return svg;
    hidden.forEach((id) => doc.getElementById(id)?.parentNode?.removeChild(doc.getElementById(id)!));
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return svg; // never let the raster fail over this — a stale view beats no view
  }
};

// Takes the elements an AI pass identified as text OUT OF THE ARTWORK without deleting
// them: each gets a stable id, and the caller hides that id. Returns the record of what
// was taken so it can be offered back.
//
// Hiding rather than deleting because the classification is not reliable enough to be
// destructive. On an ornate calligraphic logo the model named the decorative frame and
// every flourish as text — they are the same colour and the same hand as the lettering —
// and deleting on that answer destroyed the design with no way back short of reverting
// the whole document. Hidden elements are excluded from the export (see `exportSvg`), so
// the deliverable is identical either way; the only thing that changes is that a wrong
// call is now recoverable.
//
// The id is synthesized only when the element has none, following the same convention as
// parseSvg's `_layer_N` and expandLayer's `_sub_N`. An element that already has an id
// keeps it — overwriting could break a `url(#…)` reference elsewhere in the document.
export const hideRemovedElements = (
  idMap: Map<string, Element>,
  removeIds: string[],
  rows: TextRow[],
  anchors: Map<string, DOMRect>,
  alreadyHidden: Set<string>,
  logTag: string,
): RemovedRecord[] => {
  // Which text row, if any, claimed each element. A row naming an index is the model
  // asserting that element draws that row's text; an index no row names was called text
  // by the bulk pass and then vouched for by nothing.
  const claimant = new Map<string, string>();
  for (const row of rows) {
    for (const sid of row.removeIds ?? []) {
      if (!claimant.has(sid)) claimant.set(sid, (row.content ?? '').trim());
    }
  }

  const stamp = Date.now();
  // Ids assigned first, for every element in the batch, because the parent lookup below
  // needs them all to exist — a group and its own children are routinely both in here,
  // and the child is often reached before the parent.
  const taken: { sid: string; el: Element }[] = [];
  removeIds.forEach((sid, i) => {
    const el = idMap.get(sid);
    if (!el) {
      console.log(`[${logTag}] removeId has no matching element: ${sid}`);
      return;
    }
    if (!el.id) el.id = `_hidden_${stamp}_${i}`;
    taken.push({ sid, el });
  });

  const hiddenNow = new Set([...alreadyHidden, ...taken.map((t) => t.el.id)]);
  const records: RemovedRecord[] = taken.map(({ sid, el }) => {
    // Nearest ancestor that is also hidden. Everything below such an ancestor is
    // invisible regardless of its own rule, so this is what the panel groups on and what
    // preview has to walk.
    let parentId: string | null = null;
    for (let p = el.parentElement; p && !parentId; p = p.parentElement) {
      if (p.id && hiddenNow.has(p.id)) parentId = p.id;
    }
    const b = anchors.get(sid);
    return {
      id: el.id,
      tag: el.tagName.toLowerCase().replace(/.*:/, ''),
      claimedBy: claimant.get(sid) ?? null,
      box: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
      parentId,
    };
  });

  // Logged every run, including when it's healthy, because the unclaimed share is the
  // signal that predicts a bad answer and it is otherwise invisible. Across the review
  // corpus 91% of removal ids are claimed by a row; the calligraphic logo that fails runs
  // at 6%. Nothing gates on it — nothing is destroyed, so there is nothing to veto — but
  // a run that reports mostly-unclaimed is one to look at in the dev panel.
  const unclaimed = records.filter((r) => r.claimedBy === null).length;
  if (records.length) {
    console.log(
      `[${logTag}] hid ${records.length} element(s); ${unclaimed} claimed by no row ` +
      `(${Math.round((unclaimed / records.length) * 100)}%)`,
    );
  }
  return records;
};

// A record and everything hidden beneath it.
//
// Showing or restoring one entry always means the whole subtree. A hidden <g> draws
// nothing itself — all its ink is in children that carry their own hide rules — so
// un-hiding just the group shows an empty box, and un-hiding just a child shows nothing
// at all while the group above it is still display:none.
export const removedSubtree = (records: RemovedRecord[], rootId: string): Set<string> => {
  const childrenOf = new Map<string, string[]>();
  for (const r of records) {
    if (!r.parentId) continue;
    const list = childrenOf.get(r.parentId);
    if (list) list.push(r.id); else childrenOf.set(r.parentId, [r.id]);
  }
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    (childrenOf.get(id) ?? []).forEach(walk);
  };
  walk(rootId);
  return out;
};

// Writes onto every marked element the colour it APPEARS as in the image, so the source
// the model reads states the answer instead of hiding it.
//
// The model is sent the content elements alone. The <style> block their classes resolve
// against lives in defs, which goes into the RASTER but not the text, so a class-styled
// element gives no colour in the source at all — and judging small lettering by eye off a
// raster mostly reads antialiasing, or the panel behind it.
//
// Sampled rather than read off the fill, because the fill is not what you see: a glyph
// declaring a mid grey under mix-blend-mode:multiply composites to something much darker
// over a coloured panel. data-fill carries the composited value, so the model reports the
// colour of the text in the image and it can be applied as-is.
export const annotateRenderedPaint = async (
  svgRoot: Element,
  marked: Map<string, Element>,
  vb: { x: number; y: number; w: number; h: number },
  tag: string,
): Promise<void> => {
  const ids = [...marked.keys()];
  if (ids.length === 0) return;
  try {
    const boxes = measureRemovedTextBoxes(svgRoot, ids);
    const inks = await sampleElementInkColors(
      new XMLSerializer().serializeToString(svgRoot),
      ids.map((id) => boxes.get(id) ?? null),
      vb,
    );
    let n = 0;
    ids.forEach((id, i) => {
      const ink = inks[i];
      if (!ink) return;
      marked.get(id)!.setAttribute('data-fill', ink);
      n++;
    });
    if (__DEV__) console.log(`[${tag}] annotated ${n}/${ids.length} element(s) with the colour they render as`);
  } catch (err) {
    // The pass still works without it — the model falls back to reading the image — but a
    // silent failure here looks exactly like the model ignoring data-fill, so it says so.
    console.warn(`[${tag}] could not sample rendered colours:`, err);
  }
};


// How many rows the model tagged with outlines that were actually measured.
//
// This no longer says anything about where a row will be PLACED: appendTextRowLayers
// links rows to lettering by reading order over the measured geometry and does not use
// removeIds at all, precisely because the model returns them shifted. It stays as a
// read on the vision answer itself — a low count means the pass stopped pointing at the
// artwork it was describing, which is worth seeing even though placement now survives it.
// `[text-rows] linked …` is the line to read for placement.
export const countTaggedRows = (rows: TextRow[], anchors: Map<string, DOMRect>): number =>
  rows.filter((r) => (r.removeIds ?? []).some((sid) => anchors.has(sid))).length;
