import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type ActiveSvg,
  type SvgLayer,
  type TaxonomyGroup,
  type TextRow,
  appendTextRowLayers,
  applyTranslateDelta,
  bboxInRootSpace,
  collectLayerGradientIds,
  computeArcPath,
  measureTextAdvance,
  detectBackgroundLayerId,
  extractLayerColors,
  filterOutBackgroundIds,
  hashString,
  isFullCanvasLayer,
  isPlainWhiteLayer,
  isSyntheticLayerId,
  measureRemovedTextBoxes,
  normalizeColor,
  parseSvg,
  parseViewBox,
  pruneMissingLayers,
  resolveGradient,
  stripScripts,
  svgToBase64Png,
  backgroundFillColor,
  declaresOwnFill,
  effectiveFill,
  PAINTABLE_TAGS,
  canExpandLayer,
  expansionTarget,
  collapsibleParent,
  withOffscreenSvg
} from '@/lib/svg-utils';
import { C, EDITOR_CSS, FONT_STACK, SHADOW } from '@/lib/design-tokens';
import { FONT_SUGGESTION_LIMIT, SHOW_DEV_UI } from '@/lib/env';
import { readAiCache, writeAiCache } from '@/lib/ai-cache';
import { isIgnoreCanCustomise, isIgnoreCooldownPrompt, isIgnoreHasCustomised } from '@/lib/dev-flags';
import type { AiActionType, LlmProvider, RemovedRecord } from './editor-types';
import { LLM_OPTIONS } from './editor-types';
import { LayersPanel } from './editor-layers-panel';
import { EditorInspector } from './editor-inspector';
import { AiPanel, AiPill } from './editor-ai-panel';
import { DevRail, SAMPLE_DRAG_MIME } from './dev-rail';
import { DevRemovedPanel } from './dev-removed-panel';
import type { OpenedSample } from './dev-rail';
import { UpsellModal, CooldownModal, RatingModal, AbortReasonModal, ConfirmModal } from './editor-modals';
import { EditorToolbar } from './editor-toolbar';
import { CanvasStage } from './editor-canvas';
import { FontSuggestions } from './editor-font-suggestions';

// ─── Samples ─────────────────────────────────────────────────────────────────

const SAMPLES = [
  { label: 'Lighthouse',   name: 'vectorstock_956069.svg',    src: '/samples/vectorstock_956069.svg' },
  { label: 'Sandwich',     name: 'vectorstock_51876595.svg',  src: '/samples/vectorstock_51876595.svg' },
  { label: 'Logo',         name: 'vectorstock_20086499.svg',  src: '/samples/vectorstock_20086499.svg' },
  { label: 'Emblem',       name: 'vectorstock_23333135.svg',  src: '/samples/vectorstock_23333135.svg' },
  { label: 'Gradient Art', name: 'vectorstock_23517236.svg',  src: '/samples/vectorstock_23517236.svg' },
  { label: 'Illustration', name: 'vectorstock_33133625.svg',  src: '/samples/vectorstock_33133625.svg' },
  { label: 'Badge',        name: 'vectorstock_14306497.svg',  src: '/samples/vectorstock_14306497.svg' },
  { label: 'Candle',       name: 'vectorstock_19973486.svg',  src: '/samples/vectorstock_19973486.svg' },
] as const;

type SampleName = (typeof SAMPLES)[number]['name'];

// Text fields the user manages — added via the text tool (data-text-layer="1")
// or re-added by an AI pass (id starting "_text_"). These are already real,
// editable SVG text, so the AI strip/customise passes must leave them alone:
// they are not artwork text to detect or remove.
const isEditableTextField = (el: Element) =>
  el.getAttribute('data-text-layer') === '1' || el.id.startsWith('_text_');

// Reasons offered when a one-star rating leads the user to abandon the export
// (handoff §4). Multi-select — any number can apply.
const ABORT_REASONS = [
  'Colours or fonts came out wrong',
  'File looks different from the canvas',
  'Wrong file type for what I need',
  'Text got cut off or moved',
  'Took too long to export',
  'Made a mistake — starting over',
];

// The smallest root-space box containing every one of `ids`. It frames a multi-layer
// selection and supplies the shared pivot that multi-layer rotate/scale turn about, so
// the selection transforms as one rigid group. Null when nothing measurable is left.
const unionBoxInRootSpace = (svgEl: SVGSVGElement, ids: string[]): DOMRect | null => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  ids.forEach((id) => {
    const el = svgEl.querySelector(`#${CSS.escape(id)}`) as SVGGraphicsElement | null;
    const b = el ? bboxInRootSpace(svgEl, el) : null;
    if (!b) return;
    x0 = Math.min(x0, b.x);              y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);    y1 = Math.max(y1, b.y + b.height);
  });
  return Number.isFinite(x0) ? new DOMRect(x0, y0, x1 - x0, y1 - y0) : null;
};

// Rewrites a cloned element's id and every descendant id to a fresh namespace, and fixes
// intra-subtree references (href / xlink:href / url(#…)) so a duplicated layer doesn't
// collide with, or point back at, the original — e.g. curved text's arc path referenced
// by its <textPath>. References to shared <defs> (gradients, filters) are left untouched.
const remapClonedIds = (el: Element, newBaseId: string, origId: string) => {
  const idMap = new Map<string, string>();
  const collect = (node: Element) => {
    if (node.id) {
      const nid = node.id === origId ? newBaseId : `${newBaseId}__${node.id}`;
      idMap.set(node.id, nid);
      node.id = nid;
    }
    Array.from(node.children).forEach((c) => collect(c));
  };
  collect(el);
  const fixRefs = (node: Element) => {
    for (const attr of ['href', 'xlink:href']) {
      const v = node.getAttribute(attr);
      if (v && v.startsWith('#') && idMap.has(v.slice(1))) node.setAttribute(attr, `#${idMap.get(v.slice(1))}`);
    }
    for (const attr of ['fill', 'stroke', 'clip-path', 'mask', 'filter', 'style']) {
      const v = node.getAttribute(attr);
      if (v && v.includes('url(#')) {
        node.setAttribute(attr, v.replace(/url\(#([^)]+)\)/g, (m, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m)));
      }
    }
    Array.from(node.children).forEach((c) => fixRefs(c));
  };
  fixRefs(el);
};

// The wrappers an element is drawn inside, from just below the root <svg> down to its own
// parent. Cloning a layer out of its group and into a paste group at the root would drop
// every transform, clip and inherited paint those wrappers contribute, which is what this
// is read for.
const ancestorChain = (el: Element, root: Element): Element[] => {
  const chain: Element[] = [];
  for (let n = el.parentElement; n && n !== root; n = n.parentElement) chain.unshift(n);
  return chain;
};

// Re-creates that chain around a clone as shallow copies of the wrappers, so the clone
// still renders exactly where the original does. Ids are stripped: they name the original
// elements and duplicating one would give the document two nodes answering to it.
const wrapInAncestorChain = (clone: Element, chain: Element[]): Element =>
  chain.reduceRight((inner, anc) => {
    const w = anc.cloneNode(false) as Element;
    w.removeAttribute('id');
    w.appendChild(inner);
    return w;
  }, clone);

// Shared text-detection + element-identification instructions used by BOTH the
// strip-text pass and the customise pass, so the two never drift apart. Callers
// wrap this with their own intro line, any extra tasks (e.g. font suggestions),
// the marked SVG source, and the JSON output schema.
// Both passes also share one model, so an A/B model swap flips strip-text and
// customise together and they can't drift apart.
const TEXT_PARSE_MODEL = 'claude-sonnet-4-6';
const TEXT_PARSING_PROMPT = `TASK 1 — Text detection: Examine the image carefully. Detect ALL text present, including text rendered as outlined or filled path shapes (not just SVG <text> elements). For each distinct line or row of text, estimate:
- yFraction: vertical center as a fraction of image height (0.0 = top edge, 1.0 = bottom edge)
- xFraction: horizontal center as a fraction of image width (0.0 = left, 1.0 = right)
- font: the Google Font that most closely matches THIS row's own lettering. Judge each row separately — one design routinely mixes families, and picking a single family for the whole image is a wrong answer for every row that does not use it. Match the letterforms actually visible in this row: script or handwritten lettering needs a script face (Dancing Script, Great Vibes, Pacifico, Sacramento), a serif needs a serif (Playfair Display, Cormorant Garamond, Cinzel), condensed lettering needs a condensed face (Barlow Condensed, Oswald), geometric sans needs a geometric sans (Montserrat, Poppins). Only give two rows the same family when their letterforms really are the same
- sizeFraction: font cap-height as a fraction of image height (e.g. 0.08 if text height ≈ 8% of image)
- weight: CSS font-weight integer (100, 200, 300, 400, 500, 600, 700, 800, or 900)
- color: dominant text fill color as CSS hex (e.g. "#ffffff")
- content: the exact text string if legible, else ""
- letterSpacing: CSS letter-spacing in em units. Default to 0.0 (normal) if you are not certain — only use a non-zero value when you can clearly see unusually wide or condensed tracking (e.g. 0.1 slightly wide, 0.3 very wide, -0.05 condensed)

IMPORTANT: If a single horizontal line contains multiple words in different colors, fonts, sizes, or styles, return a SEPARATE row for each such word — same yFraction, but its own xFraction, color and font. Do NOT merge differently-styled words on one line into a single row.

TASK 2 — Text element identification: Most SVG elements in the source have a data-ai-idx attribute. Identify which elements visually render as text — including <text>/<tspan> elements AND <path>/<g> elements whose shapes form letter or word outlines. IMPORTANT: if a <g> group contains child paths that together form a word, return the group's data-ai-idx (not the individual letter path indices). Return every text element's data-ai-idx in "removeIds". NOTE: already-editable text fields have deliberately NOT been given a data-ai-idx — never invent indices for them; only return indices that actually appear in the source below.

TASK 3 — Row ↔ element linking: Each row from TASK 1 also carries its own "removeIds" array: the TASK 2 indices whose shapes draw THAT row's text. This linking is what lets the replacement field be positioned from the original's real geometry instead of your estimate, so it matters more than the fraction estimates do — leave a row's array empty only when you genuinely cannot tell which elements draw it.

CRITICAL: the rows are exactly the distinct lines of text you saw in TASK 1, and linking NEVER adds a row. Many indices can point at one row; a row is never split to give an index a home. Artwork often draws one word several times over — a shadow copy, an outline copy and a fill copy stacked on the same spot — and every one of those indices belongs to the SINGLE row for that word. If you are about to emit two rows with the same content in the same place, emit one row listing both indices instead.`;

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
const extractJson = (raw: string): string => {
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
// Bounded and individually caught: a font that never arrives must not strand the edit, and
// a family that has no such weight must not stop the others loading.
const FONT_SETTLE_TIMEOUT_MS = 4000;
const ensureRowFontsReady = async (rows: TextRow[]): Promise<void> => {
  if (typeof document === 'undefined' || !document.fonts) return;
  const faces = rowFontFaces(rows);
  if (faces.length === 0) return;
  try {
    await Promise.race([
      Promise.all(faces.map((f) =>
        document.fonts.load(`${f.weight} 16px "${f.family}"`).catch(() => undefined),
      )),
      new Promise((resolve) => setTimeout(resolve, FONT_SETTLE_TIMEOUT_MS)),
    ]);
    const missing = faces.filter((f) => !document.fonts.check(`${f.weight} 16px "${f.family}"`));
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
const normaliseRowRemoveIds = (row: TextRow): void => {
  row.removeIds = Array.isArray(row.removeIds) ? row.removeIds.map(String) : [];
};

// An unparseable answer reaches the user as "AI returned an unreadable response" and
// nothing else — the payload is dropped on the floor, which makes the one failure that
// most needs evidence the only one that leaves none. Log enough to tell the two causes
// apart: a truncated answer (hit the token ceiling — ends mid-token, no closing brace)
// versus a malformed one (prose, an apology, a stray fence).
const logUnreadable = (tag: string, raw: string, err: unknown): void => {
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
const allRemoveIds = (parsed: { removeIds: unknown[]; rows?: TextRow[] }): string[] =>
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
const svgWithoutHidden = (svg: string, hidden: Set<string>): string => {
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
const hideRemovedElements = (
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

// Stable identity, so passing "no preview" to the memoised canvas isn't a new object
// on every render.
const EMPTY_PREVIEW: Set<string> = new Set();

// A record and everything hidden beneath it.
//
// Showing or restoring one entry always means the whole subtree. A hidden <g> draws
// nothing itself — all its ink is in children that carry their own hide rules — so
// un-hiding just the group shows an empty box, and un-hiding just a child shows nothing
// at all while the group above it is still display:none.
const removedSubtree = (records: RemovedRecord[], rootId: string): Set<string> => {
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

// How many rows will be placed from measured geometry rather than the model's estimate.
// Logged per pass: a low count is the signal that the row↔element linking has regressed,
// which is otherwise invisible — placement silently falls back and merely looks worse.
const countAnchoredRows = (rows: TextRow[], anchors: Map<string, DOMRect>): number =>
  rows.filter((r) => (r.removeIds ?? []).some((sid) => anchors.has(sid))).length;

// ─── Customise cooldown ──────────────────────────────────────────────────────

// review/check answers with customise_next — when the asset may be customised again —
// for anything already carrying has_customised. The upstream hasn't pinned a format
// down, so accept the three plausible ones: an ISO date string, a seconds epoch, or a
// milliseconds epoch. Returns that moment in ms, or null when it can't be read.
const parseCustomiseNext = (value: unknown): number | null => {
  const fromNumber = (n: number) => (n < 1e11 ? n * 1000 : n); // seconds vs ms epoch
  if (typeof value === 'number' && Number.isFinite(value)) return fromNumber(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return fromNumber(n);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

// Inside the cooldown when that moment is still ahead of us and no further away than
// API_COOLDOWN hours — the lockout the upstream started when the asset was customised.
// Returns the milliseconds left, or null when the asset is free to customise.
const cooldownRemaining = (nextMs: number | null, cooldownHours: number): number | null => {
  if (nextMs === null) return null;
  const ms = nextMs - Date.now();
  if (ms <= 0) return null;
  return ms <= cooldownHours * 3_600_000 ? ms : null;
};

// What /api/review/check/<uuid> answers with — the fields this file reads, plus the
// cooldown_hours the proxy derives from API_COOLDOWN.
type ReviewCheck = {
  message?: string;
  id?: number;
  can_edit?: number;
  has_customised?: number;
  customise_next?: string | number;
  cooldown_hours?: number;
  error?: { message?: string };
};

const formatRemaining = (ms: number): string => {
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
};

// ─── Component ───────────────────────────────────────────────────────────────

export function SvgDropZone({ reviewUuid }: { reviewUuid?: string } = {}) {
  const [activeSvg, setActiveSvg]       = useState<ActiveSvg | null>(null);
  // string (not SampleName) because openSample now also loads fetched downloads,
  // whose names aren't in the static SAMPLES union.
  const [activeSample, setActiveSample] = useState<string | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  // What `hiddenLayers` starts as for this document (the canvas layer) — the baseline
  // the dirty check and Revert compare against.
  const [defaultHiddenLayers, setDefaultHiddenLayers] = useState<Set<string>>(new Set());
  // What the AI passes took out of the artwork this session. They hide rather than
  // delete, so each of these is still in the document with its id in `hiddenLayers`, and
  // the dev panel offers it back. Not persisted: it describes this editing session, and
  // a reload starts from the stored artwork anyway.
  // How many groups deep the element list has been drilled. Tracked rather than inferred:
  // whether a row's element sits inside a <g> says nothing about whether YOU opened it.
  // parseSvg unwraps degenerate wrappers at load, so on a file whose drawing is wrapped in
  // a group — most of them — every top-level row already has a group for a parent, and
  // back-out was offered before anything had been opened. Taking it folded the list the
  // file opened with into a single row.
  const [expandDepth, setExpandDepth] = useState(0);
  const [removedRecords, setRemovedRecords] = useState<RemovedRecord[]>([]);
  // Same ids as `removedRecords`, readable synchronously — see dropSelectionOutside.
  const removedIdsRef = useRef<Set<string>>(new Set());
  // The record the dev panel is hovering. Excluded from the canvas hide rule so the
  // element reappears where it always was, without committing anything.
  const [previewRemovedId, setPreviewRemovedId] = useState<string | null>(null);
  const [selectedLayer, setSelectedLayer]   = useState<string | null>(null);
  const [selectedLayers, setSelectedLayers] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading]       = useState(false);
  const [isDragging, setIsDragging]     = useState(false);
  const [, setDragCounter]   = useState(0);
  const [canvasDrag, setCanvasDrag] = useState<{
    layerIds: string[];
    startClientX: number; startClientY: number;
    startSvgX: number;   startSvgY: number;
    baseTransforms: Record<string, string>;
  } | null>(null);
  const [canvasRotate, setCanvasRotate] = useState<{
    layerIds: string[];
    cx: number; cy: number;              // rotation centre in SVG root space, shared by every layer
    startClientX: number; startClientY: number;
    startAngle: number;                  // pointer angle at grab, degrees
    baseTransforms: Record<string, string>;
  } | null>(null);
  const [canvasScale, setCanvasScale] = useState<{
    layerIds: string[];
    cx: number; cy: number;              // scale centre in SVG root space, shared by every layer
    startClientX: number; startClientY: number;
    startDist: number;                   // pointer distance from centre at grab (root units)
    baseTransforms: Record<string, string>;
  } | null>(null);
  const [ratingOpen, setRatingOpen]   = useState(false);   // export satisfaction prompt
  const [rating, setRating]           = useState(0);        // chosen star count (1–5)
  const [ratingHover, setRatingHover] = useState(0);        // hovered star for preview
  const [abortReasonOpen, setAbortReasonOpen] = useState(false); // secondary abandon-reason overlay
  const [abortReasons, setAbortReasons] = useState<string[]>([]); // multi-select (§4)
  const [abortNote, setAbortNote]       = useState('');           // optional free-text note
  const [textForm, setTextForm] = useState({ content: 'Text', font: 'Arial', size: 48, weight: 400, color: '#000000', curve: 0, letterSpacing: 0 });
  const [aiLoading, setAiLoading]         = useState(false);
  const [aiError, setAiError]             = useState<string | null>(null);
  const [aiStatusMsg, setAiStatusMsg]     = useState<string>('Thinking…');
  const [fontSuggestion, setFontSuggestion]   = useState<string | null>(null);
  const [suggestedFontName, setSuggestedFontName] = useState<string | null>(null);
  // Fonts the AI offered, split by how much they've earned their place. `usedFonts` are
  // the faces actually applied to text this session re-created — the ones you are most
  // likely to want again — while `extraFonts` are image-level suggestions nothing has
  // used yet. The Font dropdown lists them in that order, ahead of the built-in stack.
  const [usedFonts, setUsedFonts]             = useState<string[]>([]);
  const [extraFonts, setExtraFonts]           = useState<string[]>([]);
  const [imageFonts, setImageFonts]           = useState<Array<{ font: string; reason: string }> | null>(null);
  const [imageFontsLoading, setImageFontsLoading] = useState(false);
  const [showImageFonts, setShowImageFonts]   = useState(false);
  const [selectedImageFont, setSelectedImageFont] = useState<string | null>(null);
  const [customiseFonts, setCustomiseFonts]   = useState<string[]>([]);
  const [customiseLoading, setCustomiseLoading] = useState(false);
  const [customiseDone, setCustomiseDone] = useState(false);
  const [taxonomy, setTaxonomy]           = useState<TaxonomyGroup[] | null>(null);
  const [taxonomyLoading, setTaxonomyLoading] = useState(false);
  const [taxonomyOpen, setTaxonomyOpen]       = useState(false);
  const [removeTextQuery, setRemoveTextQuery] = useState('');
  const [showRemoveTextInput, setShowRemoveTextInput] = useState(false);
  const [textCheckResult, setTextCheckResult] = useState<{ heading: string; subheading: string } | null>(null);
  const [aiPanelOpen, setAiPanelOpen]         = useState(false);   // opened by the AI pill
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false); // "Revert changes?" overlay
  const [devRailOpen, setDevRailOpen]           = useState(false); // dev rail expanded
  const [removedPanelOpen, setRemovedPanelOpen] = useState(false); // dev hidden-by-AI ledger
  // Which LLM every AI action calls. Picking 'kimi' diverts each request to
  // /api/kimi, which re-shapes the same Anthropic-style body for Moonshot. Mirrored
  // into a ref so the AI callbacks below read the live choice, never a stale closure.
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('claude');
  const llmProviderRef = useRef<LlmProvider>('claude');
  const selectLlmProvider = (p: LlmProvider) => { llmProviderRef.current = p; setLlmProvider(p); };
  const llmEndpoint = () => (llmProviderRef.current === 'kimi' ? '/api/kimi' : '/api/claude');
  // Log label. /api/kimi discards the model id we send and pins its own, so naming a
  // Claude model while Kimi is running would be a lie — say who actually answered.
  const llmLabel = (claudeModel: string) =>
    llmProviderRef.current === 'kimi' ? 'kimi (model pinned in /api/kimi)' : `claude ${claudeModel}`;

  // Single image+text turn to the active LLM. Every AI action shared this exact
  // fetch/error/parse skeleton; extracting it here keeps the seven call sites to just
  // their model, token budget, and prompt. Returns the assistant's text with any
  // ```json fence stripped — callers JSON.parse whatever shape they expect. Throws on a
  // non-ok response, surfacing the server's error message when it sends one.
  const callLlmVision = async (opts: {
    model: string; maxTokens: number; pngBase64: string; prompt: string; tag: string;
  }): Promise<string> => {
    console.log(`[${opts.tag}] invoking LLM:`, llmLabel(opts.model));
    const res = await fetch(llmEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: opts.pngBase64 } },
            { type: 'text', text: opts.prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(e.error?.message ?? `API error ${res.status}`);
    }
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return extractJson(data.content?.[0]?.text ?? '');
  };
  const dragMovedRef            = useRef(false);
  // An open colour-picker session: the colour being replaced and the document as it
  // was when the picker opened. Live dragging replays from that baseline, so the whole
  // pick is one undo entry rather than one per intermediate colour.
  const colorEditRef            = useRef<{ from: string; baseline: string } | null>(null);
  // Visibility is part of a history entry, not just the document. An AI pass now takes
  // artwork out by hiding it, so a snapshot of content and layers alone would record a
  // run as having changed nothing and undo would have nothing to give back.
  type HistoryEntry = {
    content: string;
    layers: SvgLayer[];
    hidden: Set<string>;
    removed: RemovedRecord[];
    depth: number;
  };
  const undoStackRef             = useRef<HistoryEntry[]>([]);
  const redoStackRef             = useRef<HistoryEntry[]>([]);
  // The layer ids Ctrl/Cmd+C captured, in document order. A multi-layer copy pastes as
  // one nested group, so the whole selection travels together rather than one id.
  const layerClipboardRef        = useRef<string[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const textEditSnappedRef = useRef(false);
  const fileInputRef       = useRef<HTMLInputElement>(null);
  const svgCanvasRef    = useRef<HTMLDivElement>(null);
  const textContentRef  = useRef<HTMLInputElement>(null);
  const overlayRef      = useRef<HTMLDivElement>(null);
  const sizeBadgeRef    = useRef<HTMLSpanElement>(null);
  // Whether a move is in progress — the badge only carries x/y while one is. Held in a
  // ref, not state, because the overlay is positioned by direct DOM writes and must not
  // trigger a re-render per mousemove.
  const repositioningRef   = useRef(false);
  const repositionTimerRef = useRef<number | null>(null);
  // Shown when an AI action is invoked on a gated asset (edit === 0).
  const [showUpsell, setShowUpsell] = useState(false);
  // Shown once a /<uuid> asset has loaded and turns out to be inside the customise
  // cooldown. `cooldownUntil` is the formatted "again in …" string for the copy.
  // `cooldownActive` outlives the modal — dismissing the message doesn't lift the
  // lockout, so it, not showCooldown, is what diverts a later Customise click back to
  // the message rather than the API call.
  const [showCooldown, setShowCooldown] = useState(false);
  const [cooldownActive, setCooldownActive] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<string | undefined>(undefined);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const revokePrev = useCallback((svg: ActiveSvg | null) => {
    if (svg?.objectUrl) URL.revokeObjectURL(svg.objectUrl);
  }, []);

  // Visibility and the removed-record list as they stand right now, readable from the
  // history callbacks without making every one of snapshotForUndo's ~20 call sites pass
  // them. Snapshots are always taken BEFORE the change they guard, so the values the
  // last render settled on are exactly the ones to record.
  const hiddenLayersRef   = useRef(hiddenLayers);
  const removedRecordsRef = useRef(removedRecords);
  const expandDepthRef    = useRef(expandDepth);
  useEffect(() => {
    hiddenLayersRef.current = hiddenLayers;
    removedRecordsRef.current = removedRecords;
    expandDepthRef.current = expandDepth;
  });

  const restoreHistory = useCallback((entry: HistoryEntry) => {
    setActiveSvg((p) => p ? { ...p, content: entry.content, layers: entry.layers } : null);
    setHiddenLayers(new Set(entry.hidden));
    setRemovedRecords(entry.removed);
    removedIdsRef.current = new Set(entry.removed.map((r) => r.id));
    // Undoing an expand puts the rows back; the depth has to come back with them or
    // back-out stays offered at a level that no longer exists.
    setExpandDepth(entry.depth);
    setPreviewRemovedId(null);
  }, []);

  // Any committing action pushes the current document and clears the redo stack.
  const snapshotForUndo = useCallback((content: string, layers: SvgLayer[]) => {
    const entry: HistoryEntry = {
      content, layers,
      hidden: new Set(hiddenLayersRef.current),
      removed: removedRecordsRef.current,
      depth: expandDepthRef.current,
    };
    undoStackRef.current = [...undoStackRef.current.slice(-9), entry];
    redoStackRef.current = [];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
  }, []);

  const currentHistoryEntry = useCallback((): HistoryEntry => ({
    content: activeSvg!.content,
    layers: activeSvg!.layers,
    hidden: new Set(hiddenLayersRef.current),
    removed: removedRecordsRef.current,
    depth: expandDepthRef.current,
  }), [activeSvg]);

  const undo = useCallback(() => {
    if (!activeSvg) return;
    const prev = undoStackRef.current.pop();
    if (!prev) { setUndoCount(0); return; }
    redoStackRef.current = [...redoStackRef.current.slice(-9), currentHistoryEntry()];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    restoreHistory(prev);
  }, [activeSvg, currentHistoryEntry, restoreHistory]);

  const redo = useCallback(() => {
    if (!activeSvg) return;
    const next = redoStackRef.current.pop();
    if (!next) { setRedoCount(0); return; }
    undoStackRef.current = [...undoStackRef.current.slice(-9), currentHistoryEntry()];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    restoreHistory(next);
  }, [activeSvg, currentHistoryEntry, restoreHistory]);

  const applyParsed = useCallback(
    (raw: string, name: string, src: string, objectUrl?: string, edit?: 0 | 1) => {
      const cleaned = stripScripts(raw);
      const { content, layers } = parseSvg(cleaned);
      setActiveSvg((prev) => { revokePrev(prev); return { name, src, content, originalContent: content, layers, objectUrl, edit }; });
      // A plain white canvas layer starts hidden, so artwork opens on the transparency
      // checkerboard and exports transparent unless it's switched on. A coloured or
      // patterned background is part of the design, so it stays visible.
      // Kept as the baseline too, so starting this way doesn't read as "unsaved
      // changes" and Revert restores it rather than revealing the canvas.
      // Artwork is on the canvas now — collapse the dev rail so it isn't sitting over
      // the thing you just opened. Covers every load path, not just the rail's own.
      setDevRailOpen(false);
      const bgId = detectBackgroundLayerId(content, layers);
      const hideCanvas = !!bgId && isPlainWhiteLayer(content, bgId);
      const defaultHidden = new Set(hideCanvas ? [bgId] : []);
      setDefaultHiddenLayers(defaultHidden);
      setHiddenLayers(new Set(defaultHidden));
      setSelectedLayer(null);
      setSelectedLayers(new Set());
      // What a previous document's passes hid says nothing about this one.
      setRemovedRecords([]);
      removedIdsRef.current = new Set();
      setExpandDepth(0);
      setPreviewRemovedId(null);
      setIsLoading(false);
      setCustomiseDone(false);
      // A cooldown belongs to the artwork that was open, not to the editor. The review
      // flow re-raises it after this runs, so clearing here can't stomp the new asset's.
      setCooldownActive(false);
      setShowCooldown(false);
      // Same reasoning for which review asset is open: every load funnels through here,
      // so a file drop or a bundled sample clears it, and openReviewUuid sets it again
      // straight after. Without this a later customise would be reported against
      // whichever review asset happened to be open before.
      openReviewUuidRef.current = null;
      undoStackRef.current = [];
      redoStackRef.current = [];
      setUndoCount(0);
      setRedoCount(0);
      // Default font size = ~8% of the smallest viewBox dimension
      const svgEl = new DOMParser().parseFromString(content, 'image/svg+xml').documentElement;
      const vb = svgEl.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      const w = vb?.length === 4 ? vb[2] : Number(svgEl.getAttribute('width') || 0);
      const h = vb?.length === 4 ? vb[3] : Number(svgEl.getAttribute('height') || 0);
      const dim = Math.min(w || h, h || w) || 200;
      setTextForm((f) => ({ ...f, size: Math.max(8, Math.round(dim * 0.08)) }));
    },
    [revokePrev]
  );

  // ── Open sample ────────────────────────────────────────────────────────────

  const openSample = useCallback(
    // Widened from a SAMPLES member so fetched-download previews (whose src is a
    // data: URI) can be opened through the same path. edit carries the download's
    // gate (0 = AI features behind an upsell); static samples omit it → allowed.
    async (sample: { label: string; name: string; src: string; edit?: 0 | 1 }) => {
      setIsLoading(true);
      setActiveSample(sample.name);
      try {
        const text = await fetch(sample.src).then((r) => r.text());
        applyParsed(text, sample.name, sample.src, undefined, sample.edit);
      } catch (err) {
        console.error('Failed to load sample', sample.name, err);
        setIsLoading(false);
      }
    },
    [applyParsed]
  );

  // ── Open review asset (/<uuid> deep link) ──────────────────────────────────

  // A uuid identifies a review asset. The check endpoint says what it resolves to —
  // { message: 'success', id, can_edit } — and on a successful answer the numeric id
  // goes through /api/review/<id>, the same download the dev rail's id box uses, and
  // opens like any other sample.
  // can_edit only decides whether the AI/customise pass is allowed: it becomes the
  // asset's `edit` gate, so can_edit: 0 still opens the artwork on the canvas and
  // sends the customise click to the upsell instead.
  // Both responses are logged under [review…] so a load can be traced without reaching
  // for the network tab.
  //
  // A callback rather than effect-only code because two things open a uuid: the
  // /<uuid> path (the effect below) and the dev rail's list dropdown. Both must take
  // this exact route, cooldown and edit gate included — a second implementation would
  // be a second set of rules to keep in sync.
  //
  // Returns the sample it opened so the dev rail can add a preview card for it, the
  // same way its own fetches do — or null when nothing was opened, so a failed
  // selection doesn't leave a card pointing at artwork that never loaded.
  //
  // Reopening a uuid this session replays what was already resolved instead of asking
  // again — the same artwork the preview card shows, so the two can't disagree. The
  // check response is kept rather than the conclusions drawn from it, so the cooldown
  // is re-derived on each replay and the dev toggles still apply. A successful
  // customise drops the entry: the host rewrites the SVG, so the copy held here stops
  // being the artwork.
  const reviewCacheRef = useRef(new Map<string, { sample: OpenedSample; check: ReviewCheck }>());

  // Which review asset is on the canvas, if any. Not derivable from `reviewUuid`, which
  // only knows about the /<uuid> path — an asset opened from the dev rail's dropdown
  // has no uuid in the URL at all.
  const openReviewUuidRef = useRef<string | null>(null);

  // The asset's AI gate. Anything other than can_edit: 1 sends the Customise click to
  // the upsell; the dev toggle opens it as editable instead. Derived rather than stored
  // — asked at call time on both paths — so flipping the toggle changes the next open,
  // including a reopen served from the cache.
  const resolveEdit = useCallback((check: ReviewCheck): 0 | 1 => {
    if (check.can_edit === 1) return 1;
    if (isIgnoreCanCustomise()) {
      console.log(`[review] ${check.id} can_edit=${check.can_edit} — ignored (dev toggle), opening editable`);
      return 1;
    }
    return 0;
  }, []);

  // The cooldown basis remembered from the asset list: the most recent customised_at
  // that wasn't cancelled. Customising one asset puts them all on cooldown, so this is
  // a single account-level moment rather than anything per asset. Null until the list
  // has loaded — a /<uuid> deep link may never load it, and there's no list at all in
  // a production build, so the check response stays the fallback.
  const [listCooldown, setListCooldown] =
    useState<{ lastCustomised: number | null; cooldownHours: number } | null>(null);

  const onReviewListLoaded = useCallback(
    (info: { lastCustomised: number | null; cooldownHours: number }) => {
      console.log(
        '[review/list] cooldown basis:',
        info.lastCustomised ? new Date(info.lastCustomised).toISOString() : 'none',
        `(${info.cooldownHours}h)`,
      );
      setListCooldown(info);
    },
    [],
  );

  // Applied on both paths (fresh check and cache replay), so an asset's cooldown reads
  // the same however it was opened.
  const applyCooldown = useCallback((check: ReviewCheck) => {
    // Asked at call time, not captured in a dep: flipping the toggle applies to the
    // next asset opened without this callback having to be rebuilt.
    if (isIgnoreHasCustomised()) {
      console.log(`[review] ${check.id} cooldown ignored (dev toggle)`);
      return;
    }

    // Prefer the list's account-level moment. It's the more reliable of the two: the
    // host's own customise_next doesn't move when an already-customised asset is
    // customised again, so it can report a window that has long expired.
    if (listCooldown) {
      // cooldownRemaining measures against the moment it unlocks, so turn the moment it
      // was customised into that: last customise + the cooldown window.
      const { lastCustomised, cooldownHours } = listCooldown;
      const unlocksAt =
        lastCustomised === null ? null : lastCustomised + cooldownHours * 3_600_000;
      const left = cooldownRemaining(unlocksAt, cooldownHours);
      console.log(
        `[review] ${check.id} last customise (any asset) ${
          lastCustomised ? new Date(lastCustomised).toISOString() : 'none'
        } ->`,
        left === null ? 'no cooldown' : `${Math.round(left / 60_000)} min left`,
      );
      if (left !== null) {
        setCooldownUntil(formatRemaining(left));
        setCooldownActive(true);
      }
      return;
    }

    if (check.has_customised !== 1) return;
    const left = cooldownRemaining(
      parseCustomiseNext(check.customise_next),
      check.cooldown_hours ?? 24,
    );
    console.log(
      `[review] ${check.id} has_customised=1 customise_next=${check.customise_next} ->`,
      left === null ? 'cooldown expired' : `${Math.round(left / 60_000)} min left`,
    );
    if (left !== null) {
      setCooldownUntil(formatRemaining(left));
      setCooldownActive(true);
    }
  }, [listCooldown]);

  const openReviewUuid = useCallback(async (uuid: string): Promise<OpenedSample | null> => {
    // Already resolved this session — reopen from what's held rather than repeating the
    // check and download. applyParsed clears the cooldown as part of loading, so the
    // cooldown is re-applied after, exactly as the fresh path does.
    const cached = reviewCacheRef.current.get(uuid);
    if (cached) {
      console.log(`[review] ${uuid} — reopening from cache, no requests made`);
      setIsLoading(true);
      // Re-derive the gate rather than replaying the stored one, so flipping the dev
      // toggle takes effect on a cached asset too.
      const sample = { ...cached.sample, edit: resolveEdit(cached.check) };
      await openSample(sample);
      openReviewUuidRef.current = uuid;
      applyCooldown(cached.check);
      return sample;
    }

    // Hold the loading state across both requests so the drop zone doesn't flash up
    // in between — opening an asset should look like it's opening artwork from the start.
    setIsLoading(true);
    try {
      const res = await fetch(`/api/review/check/${uuid}`, { method: 'POST' });
      const check = (await res.json()) as ReviewCheck;
      console.log(`[review/check] ${uuid} -> ${res.status}`, check);

      if (!res.ok || check.message !== 'success' || !check.id) {
        console.log('[review] check unsuccessful — nothing to load');
        setIsLoading(false);
        return null;
      }
      // An asset that has been customised has had its SVG rewritten upstream, so a
      // cached copy is the wrong artwork rather than merely a stale one. `fresh=1`
      // makes the proxy bypass its caches, and cache: 'reload' does the same for this
      // request, so re-selecting a customised asset always shows what's there now.
      // The dev toggle only suppresses the cooldown, never this: whatever the host
      // holds is still the artwork to open.
      const customised = check.has_customised === 1;
      const dl = await fetch(
        `/api/review/${check.id}${customised ? '?fresh=1' : ''}`,
        customised ? { cache: 'reload' } : undefined,
      );
      const data = (await dl.json()) as { svg?: string | null; error?: { message?: string } };
      console.log(
        `[review/download] ${check.id}${customised ? ' (fresh)' : ''} -> ${dl.status}`,
        data.svg ? `${data.svg.length} chars of SVG` : data,
      );

      if (!dl.ok || !data.svg) {
        setIsLoading(false);
        return null;
      }

      // Same hand-off as the dev rail: inline the SVG as a data: URI so openSample
      // can re-read it with fetch().text(), exactly like a static sample src.
      const edit = resolveEdit(check);
      console.log(`[review] ${check.id} opening with edit=${edit} (can_edit=${check.can_edit})`);
      const sample: OpenedSample = {
        label: `Review ${check.id}`,
        name: `vectorstock_${check.id}.svg`,
        src: `data:image/svg+xml,${encodeURIComponent(data.svg)}`,
        edit,
      };
      await openSample(sample);
      openReviewUuidRef.current = uuid;
      reviewCacheRef.current.set(uuid, { sample, check });

      // Record the cooldown, don't announce it. Opening an asset isn't the moment to
      // interrupt with a restriction on an action nobody has asked for yet — the
      // message belongs to the Customise click, which is where runCustomise raises it.
      applyCooldown(check);
      return sample;
    } catch (err) {
      console.log(`[review] ${uuid} failed:`, err);
      setIsLoading(false);
      return null;
    }
  }, [openSample, applyCooldown, resolveEdit]);

  const reviewLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    // The ref makes this once-per-uuid: an effect re-run (StrictMode's double mount,
    // a re-render changing openReviewUuid) must not fire the requests again.
    if (!reviewUuid || reviewLoadedRef.current === reviewUuid) return;
    reviewLoadedRef.current = reviewUuid;
    void openReviewUuid(reviewUuid);
  }, [reviewUuid, openReviewUuid]);

  // ── Open dropped / browsed file ────────────────────────────────────────────

  const openFile = useCallback(
    (file: File) => {
      if (file.type !== 'image/svg+xml' && !file.name.toLowerCase().endsWith('.svg')) return;
      setIsLoading(true);
      setActiveSample(null);
      const objectUrl = URL.createObjectURL(file);
      const reader = new FileReader();
      reader.onload = (e) => applyParsed(e.target?.result as string, file.name, objectUrl, objectUrl);
      reader.onerror = () => { setIsLoading(false); URL.revokeObjectURL(objectUrl); };
      reader.readAsText(file);
    },
    [applyParsed]
  );

  // ── Clear ──────────────────────────────────────────────────────────────────

  const selectOne = useCallback((id: string | null) => {
    setSelectedLayer(id);
    setSelectedLayers(id ? new Set([id]) : new Set());
  }, []);

  const clear = useCallback(() => {
    setActiveSvg((prev) => { revokePrev(prev); return null; });
    setActiveSample(null);
    setHiddenLayers(new Set());
    setDefaultHiddenLayers(new Set());
    setSelectedLayer(null);
    setSelectedLayers(new Set());
    setRemovedRecords([]);
    removedIdsRef.current = new Set();
    setExpandDepth(0);
    setPreviewRemovedId(null);
  }, [revokePrev]);

  // ── Layer toggle ───────────────────────────────────────────────────────────

  const toggleLayer = useCallback((id: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Switching a row the AI hid back on has to take its whole hidden subtree with
        // it. A group's ink lives in children that carry their own hide rules, so
        // clearing only the group would leave the row reading "visible" while still
        // drawing nothing — the same trap the dev panel's preview hit.
        for (const sub of removedSubtree(removedRecordsRef.current, id)) next.delete(sub);
      } else {
        next.add(id);
      }
      return next;
    });
    // Shown again, it is ordinary artwork with an ordinary row — no longer something a
    // pass is holding, so it stops being listed as removed.
    setRemovedRecords((prev) => {
      if (!prev.some((r) => r.id === id)) return prev;
      const gone = removedSubtree(prev, id);
      removedIdsRef.current = new Set([...removedIdsRef.current].filter((x) => !gone.has(x)));
      return prev.filter((r) => !gone.has(r.id));
    });
  }, []);

  // After an edit deletes layers, drop the selection/visibility state that pointed at
  // them: otherwise the overlay tracks an element that no longer exists and the export
  // count still subtracts layers that have gone.
  //
  // Visibility gets an exemption the other two don't. What an AI pass hides is usually
  // nested inside a layer rather than being a layer row itself, so filtering hidden ids
  // down to the rows would discard every one of them the instant they were set — the
  // artwork would come straight back and the pass would look like it had done nothing.
  // Those ids are tracked in a ref rather than read from `removedRecords`, because a
  // pass registers them and calls this in the same tick, before any re-render.
  const dropSelectionOutside = useCallback((...groups: SvgLayer[][]) => {
    const ids = new Set(groups.flat().map((l) => l.id));
    const filterSet = (prev: Set<string>) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    };
    setSelectedLayer((cur) => (cur && !ids.has(cur) ? null : cur));
    setSelectedLayers(filterSet);
    setHiddenLayers((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id) || removedIdsRef.current.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  // Hovering one entry has to show its whole hidden subtree, for the same reason
  // restoring does — see removedSubtree.
  const previewIds = previewRemovedId
    ? removedSubtree(removedRecords, previewRemovedId)
    : EMPTY_PREVIEW;

  // The export label counts LAYER ROWS, so it has to count only hidden ids that are rows.
  // Since the AI passes hide nested elements too, `hiddenLayers.size` is no longer the
  // number of rows switched off and would make the label read "Export (3/21)" for a
  // document with every row still showing.
  // Suggestions minus anything already in use. The customise pass proposes fonts AND
  // applies some of them, so the two lists overlap by nature — subtracting here rather
  // than trying to keep the states disjoint means it cannot depend on which setter ran
  // first, and a font never appears twice in one dropdown.
  const suggestedFonts = extraFonts.filter((f) => !usedFonts.includes(f));

  const hiddenRowCount = (activeSvg?.layers ?? []).filter((l) => hiddenLayers.has(l.id)).length;

  // Records what a pass took, in both the ref the pruning above consults and the state
  // the dev panel renders from. One entry point so the two can't drift.
  const registerRemoved = useCallback((records: RemovedRecord[]) => {
    if (records.length === 0) return;
    const ids = records.map((r) => r.id);
    removedIdsRef.current = new Set([...removedIdsRef.current, ...ids]);
    setRemovedRecords((prev) => [...prev, ...records]);
    setHiddenLayers((prev) => new Set([...prev, ...ids]));
  }, []);

  // Which layers render as text — drives the element list's type icon (§1.7).
  const textLayerIds = useMemo(() => {
    const ids = new Set<string>();
    if (!activeSvg) return ids;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    for (const layer of activeSvg.layers) {
      const el = doc.getElementById(layer.id);
      if (!el) continue;
      if (el.tagName.toLowerCase() === 'text' || el.querySelector('text')) ids.add(layer.id);
    }
    return ids;
  }, [activeSvg?.content]);

  // Per layer: how many outermost pieces of artwork an AI pass hid inside it.
  //
  // What a pass takes is usually nested — a group of letter paths inside a layer, not a
  // layer itself — so it gets no row of its own and the containing row goes on looking
  // like an ordinary visible layer while part of what it draws is switched off. This is
  // the only signal that something is in there. Counting ROOTS, not records: their
  // descendants are hidden too, but each sits inside a root and opening the layer
  // surfaces one row per root, not per element.
  const hiddenInsideCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!activeSvg || removedRecords.length === 0) return counts;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    for (const r of removedRecords) {
      if (r.parentId) continue;
      const el = doc.getElementById(r.id);
      if (!el) continue;
      // The nearest ancestor that is a row. Starting at parentElement so an element that
      // IS a row counts against the layer holding it rather than against itself.
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.id && layerIds.has(p.id)) {
          counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
          break;
        }
      }
    }
    return counts;
  }, [activeSvg, removedRecords]);

  // Which layers hold more than one part, so the element list can offer to open them.
  // Text layers are excluded: their internals are <text>/<textPath> plumbing, not parts
  // anyone would want as separate rows, and splitting one would break the text editing.
  const expandableLayerIds = useMemo(() => {
    const ids = new Set<string>();
    if (!activeSvg) return ids;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    for (const layer of activeSvg.layers) {
      if (textLayerIds.has(layer.id)) continue;
      if (canExpandLayer(doc.getElementById(layer.id))) ids.add(layer.id);
    }
    return ids;
  }, [activeSvg?.content, activeSvg?.layers, textLayerIds]);

  // The row to back out from, or null when nothing has been drilled into. The panel
  // offers one way out rather than a control per row, so this picks the DEEPEST group
  // any row currently sits in — the level most recently opened. Backing out repeatedly
  // therefore walks back up the way you came.
  const backOutLayerId = useMemo(() => {
    // Nothing has been opened, so there is nowhere to go back to — whatever the document
    // happens to be wrapped in.
    if (!activeSvg || expandDepth === 0) return null;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let deepestId: string | null = null;
    let deepest = -1;
    for (const layer of activeSvg.layers) {
      const parent = collapsibleParent(doc.getElementById(layer.id), layerIds);
      if (!parent) continue;
      let depth = 0;
      for (let n: Element | null = parent; n; n = n.parentElement) depth++;
      if (depth > deepest) { deepest = depth; deepestId = layer.id; }
    }
    return deepestId;
  }, [activeSvg?.content, activeSvg?.layers, expandDepth]);

  // Click on canvas: walk up from the clicked element to find its layer. Shift-click
  // adds/removes it from the selection, exactly like shift-clicking its row in the
  // element list, so a multi-layer selection can be built either way. A plain click
  // replaces the selection; when the clicked layer holds text it also focuses the
  // side-panel text input so keyboard input edits it immediately.
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeSvg?.layers.length) return;
    // A drag on the artwork ends with a click on whatever sits under the pointer at
    // release. That click must not re-select: a multi-layer selection dragged by one of
    // its members would collapse to that member, and a layer dragged over another would
    // hand the selection to the layer it landed on.
    if (dragMovedRef.current) { dragMovedRef.current = false; return; }
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    // Ignore clicks on the selection overlay (drag handle)
    if ((e.target as Element).closest?.('[data-sel-overlay]')) return;
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let el = e.target as Element | null;
    while (el && el !== (svgEl as Element)) {
      // Match on the layer list alone. Layer roots are not always direct children of
      // <svg> — a file that wraps its drawing in one group has its layers taken from
      // inside that wrapper, and opening a layer into parts nests them further — so
      // requiring a top-level parent here stopped canvas clicks selecting anything.
      // Walking up hits the nearest enclosing layer, which is the one that was clicked.
      if (layerIds.has(el.id)) {
        const id = el.id;
        if (e.shiftKey) {
          setSelectedLayers((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          });
          setSelectedLayer(id);
          return;   // building a selection, not editing — never steal focus to the text input
        }
        selectOne(id);
        const isText =
          el.getAttribute('data-text-layer') === '1' ||
          el.tagName.toLowerCase() === 'text' ||
          !!el.querySelector('text');
        if (isText) {
          // Focus the inspector's Words input so typing edits the text in place. Place
          // the caret at the end (rather than selecting all) so typing appends.
          requestAnimationFrame(() => {
            const input = textContentRef.current;
            if (!input) return;
            input.focus();
            const end = input.value.length;
            input.setSelectionRange(end, end);
          });
        }
        return;
      }
      el = el.parentElement;
    }
  }, [activeSvg, selectOne]);

  // Switches the x/y half of the badge on for the duration of a move. Switching it off
  // repaints rather than waiting for the next reposition: the gesture that ends it may be
  // the last thing that happens — an arrow-key nudge timing out, or a drag released
  // without moving — and the coordinate would otherwise stay on screen for good.
  const setRepositioning = useCallback((on: boolean) => {
    if (repositionTimerRef.current !== null) {
      clearTimeout(repositionTimerRef.current);
      repositionTimerRef.current = null;
    }
    repositioningRef.current = on;
    if (!on) positionOverlayRef.current();
  }, []);

  // Arrow-key nudges have no gesture end to switch the readout off, so each press keeps
  // it up a moment longer and the last one lets it go.
  const flashRepositioning = useCallback(() => {
    setRepositioning(true);
    repositionTimerRef.current = window.setTimeout(() => setRepositioning(false), 1200);
  }, [setRepositioning]);

  // Global mouse listeners while the background layer is being dragged
  useEffect(() => {
    if (!canvasDrag) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;

    const onMove = (e: MouseEvent) => {
      if (!svgEl) return;
      if (Math.abs(e.clientX - canvasDrag.startClientX) > 2 ||
          Math.abs(e.clientY - canvasDrag.startClientY) > 2) {
        dragMovedRef.current = true;
      }
      if (!dragMovedRef.current) return;
      if (!repositioningRef.current) setRepositioning(true);
      const pt = svgEl.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const cur = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
      const dx = cur.x - canvasDrag.startSvgX;
      const dy = cur.y - canvasDrag.startSvgY;
      canvasDrag.layerIds.forEach((id) => {
        const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
        if (layerEl) {
          layerEl.setAttribute('transform', `translate(${dx}, ${dy}) ${canvasDrag.baseTransforms[id]}`.trim());
        }
      });
      // Recompute the overlay from the live element so it follows the layer.
      positionOverlayRef.current();
    };

    const onUp = () => {
      if (svgEl && dragMovedRef.current) {
        const content = new XMLSerializer().serializeToString(svgEl);
        setActiveSvg((prev) => (prev ? { ...prev, content } : null));
      }
      setRepositioning(false);
      setCanvasDrag(null);
    };

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [canvasDrag, setRepositioning]);

  // Global mouse listeners while a layer is being rotated
  useEffect(() => {
    if (!canvasRotate) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;

    const onMove = (e: MouseEvent) => {
      if (!svgEl) return;
      if (Math.abs(e.clientX - canvasRotate.startClientX) > 2 ||
          Math.abs(e.clientY - canvasRotate.startClientY) > 2) {
        dragMovedRef.current = true;
      }
      if (!dragMovedRef.current) return;
      const pt = svgEl.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const cur = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
      const angle = Math.atan2(cur.y - canvasRotate.cy, cur.x - canvasRotate.cx) * 180 / Math.PI;
      let delta = angle - canvasRotate.startAngle;
      if (e.shiftKey) delta = Math.round(delta / 15) * 15;   // snap to 15° with Shift
      // Every layer rotates about the SHARED centre, so a multi-selection turns as one
      // rigid group rather than each layer spinning on its own axis.
      canvasRotate.layerIds.forEach((id) => {
        const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
        if (layerEl) {
          layerEl.setAttribute(
            'transform',
            `rotate(${delta.toFixed(2)}, ${canvasRotate.cx}, ${canvasRotate.cy}) ${canvasRotate.baseTransforms[id]}`.trim(),
          );
        }
      });
      // Recompute the overlay from the live elements so it tracks the rotation.
      positionOverlayRef.current();
    };

    const onUp = () => {
      if (svgEl && dragMovedRef.current) {
        const content = new XMLSerializer().serializeToString(svgEl);
        setActiveSvg((prev) => (prev ? { ...prev, content } : null));
      }
      setCanvasRotate(null);
    };

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [canvasRotate]);

  // Global mouse listeners while a layer is being scaled
  useEffect(() => {
    if (!canvasScale) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;

    const onMove = (e: MouseEvent) => {
      if (!svgEl) return;
      if (Math.abs(e.clientX - canvasScale.startClientX) > 2 ||
          Math.abs(e.clientY - canvasScale.startClientY) > 2) {
        dragMovedRef.current = true;
      }
      if (!dragMovedRef.current) return;
      const pt = svgEl.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const cur = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
      const dist = Math.hypot(cur.x - canvasScale.cx, cur.y - canvasScale.cy);
      const s = Math.max(dist / canvasScale.startDist, 0.05);   // uniform, guarded away from 0
      // Scale about the SHARED anchor (the selection's top-left), then apply each layer's
      // original transform: the selection grows as one block, so the gaps between layers
      // scale with them.
      canvasScale.layerIds.forEach((id) => {
        const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
        if (layerEl) {
          layerEl.setAttribute(
            'transform',
            `translate(${canvasScale.cx}, ${canvasScale.cy}) scale(${s.toFixed(4)}) translate(${-canvasScale.cx}, ${-canvasScale.cy}) ${canvasScale.baseTransforms[id]}`.trim(),
          );
        }
      });
      positionOverlayRef.current();
    };

    const onUp = () => {
      if (svgEl && dragMovedRef.current) {
        const content = new XMLSerializer().serializeToString(svgEl);
        setActiveSvg((prev) => (prev ? { ...prev, content } : null));
      }
      setCanvasScale(null);
    };

    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [canvasScale]);

  // Scroll the matching panel row into view whenever selectedLayer changes
  useEffect(() => {
    if (!selectedLayer) return;
    document
      .querySelector(`[data-layer-id="${selectedLayer}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedLayer]);

  // ── Background layer detection ────────────────────────────────────────────

  const backgroundLayerId = useMemo(
    () => (activeSvg ? detectBackgroundLayerId(activeSvg.content, activeSvg.layers) : null),
    // Per document, not per edit — the background layer doesn't change as you edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSvg?.src],
  );

  // Every layer the overlay frames and the handles act on. The background layer is
  // locked, so it's filtered out rather than dragged along with the rest.
  const selectionIds = useMemo(
    () => [...selectedLayers].filter((id) => id !== backgroundLayerId),
    [selectedLayers, backgroundLayerId],
  );
  // The primary layer — drives the single-selection overlay's rotated frame.
  const selectionLayerId = selectionIds[0] ?? null;
  const showSelectionOverlay = selectionIds.length > 0;

  // ── Selection overlay (HTML div, direct DOM manipulation) ───────────────────
  // Pure ref manipulation — no state, no re-renders. React only manages the
  // static structural properties (position, outline, zIndex). Everything else
  // (left, top, width, height, display, transform) is set directly so React
  // can never override them between layout-effect runs.

  // Positions the selection overlay so it hugs the layer even when rotated/scaled:
  // the layer's *local* bbox is mapped through its screen CTM (giving a rotated
  // rect on screen), then the overlay is placed at the top-left corner and rotated
  // to match. Called from the layout effect and live during drag/rotate so the box
  // tracks the item continuously.
  const positionSelectionOverlay = useCallback(() => {
    const overlay = overlayRef.current;

    if (overlay) overlay.style.transform = '';

    if (!showSelectionOverlay || !selectionLayerId || !overlay) return;

    const svgEl    = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    const canvasEl = svgCanvasRef.current;
    if (!svgEl || !canvasEl) return;

    const rootCtm = svgEl.getScreenCTM();
    if (!rootCtm) return;

    // The one place the badge is written, so the three branches below can't drift apart.
    //
    // Dimensions arrive as screen pixels and are reported in the SVG's own coordinate
    // space, because those are the numbers that mean something outside this window: they
    // match the file and the export, and they don't change when the browser is resized
    // and the artwork rescaled to fit. The x/y half is in the same space for the same
    // reason — a canvas-pixel origin would sit in the grey around the artwork.
    //
    // Position only appears while something is being moved: a resting selection shouldn't
    // carry a coordinate that never changes. It reads the min corner of the whole
    // selection's box, so a multi-layer move reports the corner of the group rather than
    // of whichever layer happens to be primary.
    const writeBadge = (widthPx: number, heightPx: number) => {
      const badge = sizeBadgeRef.current;
      if (!badge) return;
      const scale = Math.hypot(rootCtm.a, rootCtm.b) || 1;
      const size = `w ${Math.round(widthPx / scale)}  h ${Math.round(heightPx / scale)}`;
      const box = repositioningRef.current ? unionBoxInRootSpace(svgEl, selectionIds) : null;
      badge.textContent = box
        ? `x ${Math.round(box.x)}  y ${Math.round(box.y)}  ·  ${size}`
        : size;
    };

    const layerEl = svgEl.querySelector(`#${CSS.escape(selectionLayerId)}`) as SVGGraphicsElement | null;
    if (!layerEl) return;

    const pad = 4;

    try {
      const canvasRect = canvasEl.getBoundingClientRect();
      const offX = -canvasRect.left + canvasEl.scrollLeft;
      const offY = -canvasRect.top  + canvasEl.scrollTop;

      // Multi-selection: one axis-aligned box around the whole group. Deliberately NOT
      // rotated — once the selected layers carry different transforms there is no single
      // angle the frame could take, so it stays upright and the handles work off it.
      if (selectionIds.length > 1) {
        const box = unionBoxInRootSpace(svgEl, selectionIds);
        if (!box) return;
        const map = (rx: number, ry: number) => {
          const p = svgEl.createSVGPoint();
          p.x = rx; p.y = ry;
          const s = p.matrixTransform(rootCtm);
          return { x: s.x + offX, y: s.y + offY };
        };
        const TL = map(box.x, box.y);
        const BR = map(box.x + box.width, box.y + box.height);
        const width  = BR.x - TL.x + pad * 2;
        const height = BR.y - TL.y + pad * 2;

        overlay.style.transform = '';
        overlay.style.left   = `${TL.x - pad}px`;
        overlay.style.top    = `${TL.y - pad}px`;
        overlay.style.width  = `${width}px`;
        overlay.style.height = `${height}px`;
        // Minus the padding the frame is drawn with — that is overlay chrome, not artwork.
        writeBadge(width - pad * 2, height - pad * 2);
        return;
      }

      // Try the tight, transform-aware box first.
      const ctm = layerEl.getScreenCTM?.();
      let localBox: { x: number; y: number; w: number; h: number } | null = null;
      try {
        const bb = layerEl.getBBox();
        if (bb.width || bb.height) localBox = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
      } catch { /* getBBox unsupported/detached */ }

      if (ctm && localBox) {
        const sX = Math.hypot(ctm.a, ctm.b) || 1;   // screen px per local unit, x-axis
        const sY = Math.hypot(ctm.c, ctm.d) || 1;   // …y-axis
        const padX = pad / sX, padY = pad / sY;
        const map = (lx: number, ly: number) => {
          const p = svgEl.createSVGPoint();
          p.x = lx; p.y = ly;
          const s = p.matrixTransform(ctm);
          return { x: s.x + offX, y: s.y + offY };
        };
        const P0 = map(localBox.x - padX,             localBox.y - padY);              // top-left
        const P1 = map(localBox.x + localBox.w + padX, localBox.y - padY);             // top-right
        const P3 = map(localBox.x - padX,             localBox.y + localBox.h + padY); // bottom-left
        const theta  = Math.atan2(P1.y - P0.y, P1.x - P0.x);
        const width  = Math.hypot(P1.x - P0.x, P1.y - P0.y);
        const height = Math.hypot(P3.x - P0.x, P3.y - P0.y);

        overlay.style.left            = `${P0.x}px`;
        overlay.style.top             = `${P0.y}px`;
        overlay.style.width           = `${width}px`;
        overlay.style.height          = `${height}px`;
        overlay.style.transformOrigin = '0 0';
        overlay.style.transform       = `rotate(${theta}rad)`;
        writeBadge(width - pad * 2, height - pad * 2);

        return;
      }

      // Fallback (axis-aligned): empty text layer with no measurable geometry.
      const textEl = (layerEl.tagName.toLowerCase() === 'text'
        ? layerEl
        : layerEl.querySelector('text')) as SVGTextElement | null;
      const tctm = textEl?.getScreenCTM();
      if (!textEl || !tctm) return;
      const x  = parseFloat(textEl.getAttribute('x') ?? layerEl.getAttribute('data-cx') ?? '0');
      const y  = parseFloat(textEl.getAttribute('y') ?? layerEl.getAttribute('data-cy') ?? '0');
      const fs = parseFloat(textEl.getAttribute('font-size') ?? layerEl.getAttribute('data-fontsize') ?? '16');
      const pt = svgEl.createSVGPoint();
      pt.x = x; pt.y = y;
      const sp = pt.matrixTransform(tctm);
      const h  = Math.max(fs * tctm.a, 12);
      const w  = Math.max(h * 3, 40);
      const anchor = textEl.getAttribute('text-anchor');
      const left = anchor === 'end' ? sp.x - w : anchor === 'middle' ? sp.x - w / 2 : sp.x;

      overlay.style.transform = '';
      overlay.style.left   = `${left + offX - pad}px`;
      overlay.style.top    = `${sp.y - h / 2 + offY - pad}px`;
      overlay.style.width  = `${w + pad * 2}px`;
      overlay.style.height = `${h + pad * 2}px`;
      writeBadge(w, h);
    } catch {
      // matrixTransform / getBBox can throw if the element is detached
    }
  }, [showSelectionOverlay, selectionLayerId, selectionIds, backgroundLayerId]);

  // Keep a live ref so the drag/rotate window listeners can reposition without
  // being torn down and recreated on every render.
  const positionOverlayRef = useRef(positionSelectionOverlay);
  useEffect(() => { positionOverlayRef.current = positionSelectionOverlay; });

  useLayoutEffect(() => {
    positionSelectionOverlay();
  }, [positionSelectionOverlay, activeSvg?.content, canvasDrag, canvasRotate, canvasScale]);

  // ── Layer reorder ──────────────────────────────────────────────────────────

  const reorderLayers = useCallback((fromId: string, toId: string, panelBefore: boolean) => {
    if (!activeSvg || fromId === toId) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);

    // Work in panel order (reversed document order: panel[0] = topmost layer)
    const panelLayers = [...activeSvg.layers].reverse();
    const fromPanelIdx = panelLayers.findIndex((l) => l.id === fromId);
    const toPanelIdx   = panelLayers.findIndex((l) => l.id === toId);
    if (fromPanelIdx === -1 || toPanelIdx === -1) return;

    let insertPanelIdx = panelBefore ? toPanelIdx : toPanelIdx + 1;
    const newPanel = [...panelLayers];
    const [moved] = newPanel.splice(fromPanelIdx, 1);
    if (fromPanelIdx < insertPanelIdx) insertPanelIdx--;
    newPanel.splice(insertPanelIdx, 0, moved);

    const newDocLayers = [...newPanel].reverse();

    // Reorder the SVG DOM by moving fromEl to its new document position
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const svg = doc.documentElement;
    const fromEl = doc.getElementById(fromId);
    if (!fromEl) return;

    const newFromDocIdx = newDocLayers.findIndex((l) => l.id === fromId);
    const nextDocId = newFromDocIdx < newDocLayers.length - 1 ? newDocLayers[newFromDocIdx + 1].id : null;
    const nextEl = nextDocId ? doc.getElementById(nextDocId) : null;

    // Layers are not always direct children of <svg>: a file that wraps its drawing in
    // one group has its layers taken from inside that wrapper. Move within the element's
    // own parent, so reordering can't hoist it out of a wrapper whose class or transform
    // it is being drawn under.
    const parent = fromEl.parentNode;
    if (!parent) return;
    if (nextEl && nextEl.parentNode === parent) {
      parent.insertBefore(fromEl, nextEl);
    } else if (!nextEl && parent === svg) {
      svg.appendChild(fromEl);
    } else if (!nextEl) {
      parent.appendChild(fromEl);
    } else {
      // Different parents — there is no single position that means "between these two",
      // so the drop is ignored rather than moved somewhere arbitrary.
      console.log('[layers] reorder across different parents ignored');
      return;
    }

    const content = new XMLSerializer().serializeToString(svg);
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: newDocLayers } : null));
  }, [activeSvg, snapshotForUndo]);

  // ── Export ─────────────────────────────────────────────────────────────────

  const exportSvg = useCallback(() => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    hiddenLayers.forEach((id) => {
      const el = doc.getElementById(id);
      el?.parentNode?.removeChild(el);
    });

    // Embed @import rules for any Google Fonts actually present in the exported doc
    if (extraFonts.length > 0) {
      const interim = new XMLSerializer().serializeToString(doc.documentElement);
      const usedFonts = extraFonts.filter((font) => interim.includes(font));
      if (usedFonts.length > 0) {
        const svg = doc.documentElement;
        let defsEl = svg.querySelector('defs');
        if (!defsEl) {
          defsEl = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
          svg.insertBefore(defsEl, svg.firstChild);
        }
        const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
        styleEl.textContent = usedFonts
          .map((font) => `@import url('https://fonts.googleapis.com/css2?family=${font.replace(/\s+/g, '+')}:wght@100;200;300;400;500;600;700;800;900&display=swap');`)
          .join('\n');
        defsEl.insertBefore(styleEl, defsEl.firstChild);
      }
    }

    const serialized = new XMLSerializer().serializeToString(doc.documentElement);
    const blob = new Blob([serialized], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeSvg.name.replace(/\.svg$/i, '') + '_export.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [activeSvg, hiddenLayers, extraFonts]);

  // Export is gated behind the rating prompt (§3): the file is only written from
  // "Send rating & download". Cancelling — or abandoning — discards it.
  const cancelRating = useCallback(() => {
    setRatingOpen(false);
    setAbortReasonOpen(false);
    setAbortReasons([]);
    setAbortNote('');
    setRating(0);
    setRatingHover(0);
  }, []);

  const submitRating = useCallback(() => {
    if (rating < 1) return;
    // No backend yet — surface the rating so it can be wired to analytics later.
    console.log('[export] satisfaction rating:', rating);
    setRatingOpen(false);
    setRating(0);
    setRatingHover(0);
    exportSvg();
  }, [rating, exportSvg]);

  // A one-star rating offers "Abandon export", which opens a secondary overlay asking
  // why. Confirming sends the feedback and closes the project (returning to the drop
  // zone) — nothing downloads on this path.
  const confirmAbort = useCallback(() => {
    console.log('[export] export abandoned — rating:', rating, 'reasons:', abortReasons, 'note:', abortNote);
    setAbortReasonOpen(false);
    setRatingOpen(false);
    setAbortReasons([]);
    setAbortNote('');
    setRating(0);
    setRatingHover(0);
    clear();
  }, [abortReasons, abortNote, rating, clear]);

  const toggleAbortReason = useCallback((reason: string) => {
    setAbortReasons((prev) => (prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]));
  }, []);

  // Stable close/open handlers so the memoised modal components don't re-render on
  // unrelated state changes.
  const closeUpsell = useCallback(() => setShowUpsell(false), []);
  const closeCooldown = useCallback(() => setShowCooldown(false), []);
  const openAbortReason = useCallback(() => setAbortReasonOpen(true), []);
  const closeAbortReason = useCallback(() => setAbortReasonOpen(false), []);
  const openRating = useCallback(() => { setRating(0); setRatingHover(0); setRatingOpen(true); }, []);
  const closeImageFonts = useCallback(() => setShowImageFonts(false), []);
  const closeAiPanel = useCallback(() => setAiPanelOpen(false), []);
  // The pill's caret opens the AI tools. Gated assets (edit === 0) get the upsell
  // instead — the tools are AI features too, and runCustomise gates itself the same way.
  const onAiToolsClick = useCallback(() => {
    if (activeSvg?.edit === 0) { setShowUpsell(true); return; }
    setAiPanelOpen((o) => !o);
  }, [activeSvg?.edit]);
  // Empty-text selection overlay click: focus the inspector's Words input.
  const focusEmptyTextInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = textContentRef.current;
      if (!input) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }, []);

  // Snapshots the current transform of the layers a gesture is about to move, so it can
  // replay itself from the grab state on each mousemove instead of stacking transforms.
  // Takes the ids explicitly: a drag started on the artwork picks its layer from the
  // pointer, and that layer's selection state hasn't been committed yet at grab time.
  const captureBaseTransforms = useCallback((svgEl: SVGSVGElement, ids: string[]) => {
    const baseTransforms: Record<string, string> = {};
    ids.forEach((id) => {
      const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
      if (layerEl) baseTransforms[id] = layerEl.getAttribute('transform') ?? '';
    });
    return baseTransforms;
  }, []);

  // Arms a move gesture on `ids` from a grab at the event's position. Shared by the
  // overlay's move handle and by grabbing the artwork itself.
  const beginLayerDrag = useCallback((e: React.MouseEvent, ids: string[]) => {
    if (!ids.length || !activeSvg?.layers.length) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    dragMovedRef.current = false;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    setCanvasDrag({
      layerIds: ids,
      startClientX: e.clientX, startClientY: e.clientY,
      startSvgX: svgPt.x,     startSvgY: svgPt.y,
      baseTransforms: captureBaseTransforms(svgEl, ids),
    });
  }, [activeSvg, captureBaseTransforms, snapshotForUndo]);

  // mousedown on the overlay's move handle: drag every selected non-background layer
  const handleDragHandleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    beginLayerDrag(e, selectionIds);
  }, [beginLayerDrag, selectionIds]);

  // mousedown on the artwork: press-and-hold anywhere inside a layer drags it, so the
  // corner handle is a convenience rather than the only way to move something. The
  // layer under the pointer is found the same way a canvas click finds it.
  //   • grabbing a layer that's already part of the selection moves the whole selection
  //   • grabbing anything else selects it first, then moves just that layer
  //   • shift is the selection-building gesture, so it never starts a drag
  //   • the background layer is locked, and the overlay's own handles opt out
  // A gesture that never moved falls through to the click handler as a plain select.
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.shiftKey) return;
    if (!activeSvg?.layers.length) return;
    if ((e.target as Element).closest?.('[data-sel-overlay]')) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let hitId: string | null = null;
    for (let el = e.target as Element | null; el && el !== (svgEl as Element); el = el.parentElement) {
      if (layerIds.has(el.id)) { hitId = el.id; break; }
    }
    if (!hitId || hitId === backgroundLayerId) return;

    if (selectedLayers.has(hitId)) {
      beginLayerDrag(e, selectionIds);
    } else {
      selectOne(hitId);
      beginLayerDrag(e, [hitId]);
    }
  }, [activeSvg, backgroundLayerId, selectedLayers, selectionIds, selectOne, beginLayerDrag]);

  // mousedown on rotate handle: rotate every selected non-background layer about the
  // selection's shared centre
  const handleRotateHandleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!selectionIds.length || !activeSvg?.layers.length) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const box = unionBoxInRootSpace(svgEl, selectionIds);
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    const startAngle = Math.atan2(svgPt.y - cy, svgPt.x - cx) * 180 / Math.PI;
    dragMovedRef.current = false;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    setCanvasRotate({
      layerIds: selectionIds,
      cx, cy,
      startClientX: e.clientX, startClientY: e.clientY,
      startAngle,
      baseTransforms: captureBaseTransforms(svgEl, selectionIds),
    });
  }, [activeSvg, selectionIds, captureBaseTransforms, snapshotForUndo]);

  // mousedown on scale handle: uniformly scale every selected non-background layer,
  // anchored at the selection's top-left corner so it grows down and to the right —
  // the corner opposite the handle stays put, the way a drag on a bottom-right grip
  // reads. (Scaling about the centre instead made the artwork creep up and left as it
  // grew.)
  const handleScaleHandleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!selectionIds.length || !activeSvg?.layers.length) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const box = unionBoxInRootSpace(svgEl, selectionIds);
    if (!box) return;
    const cx = box.x;
    const cy = box.y;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    const startDist = Math.hypot(svgPt.x - cx, svgPt.y - cy);
    if (startDist < 1e-3) return;
    dragMovedRef.current = false;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    setCanvasScale({
      layerIds: selectionIds,
      cx, cy,
      startClientX: e.clientX, startClientY: e.clientY,
      startDist,
      baseTransforms: captureBaseTransforms(svgEl, selectionIds),
    });
  }, [activeSvg, selectionIds, captureBaseTransforms, snapshotForUndo]);

  // ── Selected text layer properties ────────────────────────────────────────

  const layerColors = useMemo(() => {
    if (!selectedLayer || !activeSvg) return [];
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerEl = doc.getElementById(selectedLayer);
    if (!layerEl) return [];
    return extractLayerColors(layerEl, doc);
  }, [selectedLayer, activeSvg?.content]);

  const selectedTextProps = useMemo(() => {
    if (!activeSvg) return null;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');

    if (!selectedLayer) return null;
    const el = doc.getElementById(selectedLayer);
    if (!el) return null;
    const isGroup = el.getAttribute('data-text-layer') === '1';
    const textEl = isGroup
      ? el.querySelector('text')
      : el.tagName.toLowerCase() === 'text' ? el : null;
    if (!textEl) return null;
    const textPathEl = textEl.querySelector('textPath');
    return {
      content: textPathEl ? (textPathEl.textContent ?? '') : (textEl.textContent ?? ''),
      font:    textEl.getAttribute('font-family') ?? 'Arial',
      size:    Number(textEl.getAttribute('font-size') ?? 48),
      weight:  Number(textEl.getAttribute('font-weight') ?? 400),
      color:         textEl.getAttribute('fill') ?? '#000000',
      curve:         isGroup ? Number(el.getAttribute('data-curve') ?? 0) : null as number | null,
      letterSpacing: parseFloat((textEl.getAttribute('letter-spacing') ?? '0').replace('em', '')) || 0,
    };
  }, [selectedLayer, activeSvg?.content]);

  // An empty text layer renders no geometry, so clicks inside its placeholder
  // selection box fall through to the background. Flag it so the overlay can
  // capture those clicks and keep the empty text layer selected instead.
  const selectionIsEmptyText = !!selectedTextProps && selectedTextProps.content.trim() === '';

  const updateTextLayer = useCallback((attrs: Partial<{ content: string; font: string; size: number; weight: number; color: string; curve: number; letterSpacing: number }>) => {
    if (!activeSvg) return;
    if (!textEditSnappedRef.current) {
      snapshotForUndo(activeSvg.content, activeSvg.layers);
      textEditSnappedRef.current = true;
    }
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');

    if (!selectedLayer) return;
    const el = doc.getElementById(selectedLayer);
    if (!el) return;
    const isGroup = el.getAttribute('data-text-layer') === '1';
    let textEl: Element | null = isGroup ? el.querySelector('text') : el;
    if (!textEl) return;

    // For non-group text elements that need a curve, promote to group first
    if (attrs.curve !== undefined && !isGroup && el.tagName.toLowerCase() === 'text' && attrs.curve !== 0) {
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const svgEl = doc.documentElement;
      const vb = svgEl.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      const vbW = vb && vb.length === 4 ? vb[2] : Number(svgEl.getAttribute('width') || 400);
      const cx = Number(el.getAttribute('x') ?? 0);
      const cy = Number(el.getAttribute('y') ?? 0);
      const halfW = vbW * 0.35;
      const gId = el.id;
      el.removeAttribute('id');
      const g = doc.createElementNS(SVG_NS, 'g');
      g.id = gId;
      g.setAttribute('data-name', el.textContent ?? '');
      g.setAttribute('data-text-layer', '1');
      g.setAttribute('data-curve', String(attrs.curve));
      g.setAttribute('data-cx', String(cx));
      g.setAttribute('data-cy', String(cy));
      g.setAttribute('data-halfw', String(halfW));
      g.setAttribute('data-fontsize', el.getAttribute('font-size') ?? '48');
      const arcId = `_arc_${gId}`;
      const defsEl2 = doc.createElementNS(SVG_NS, 'defs');
      const arcEl = doc.createElementNS(SVG_NS, 'path');
      arcEl.id = arcId;
      defsEl2.appendChild(arcEl);
      g.appendChild(defsEl2);
      const newText = doc.createElementNS(SVG_NS, 'text');
      ['font-family','font-size','font-weight','fill','letter-spacing'].forEach((a) => { const v = el.getAttribute(a); if (v) newText.setAttribute(a, v); });
      newText.setAttribute('dominant-baseline', 'middle');
      const tp = doc.createElementNS(SVG_NS, 'textPath');
      tp.setAttribute('href', `#${arcId}`); tp.setAttribute('startOffset', '50%'); tp.setAttribute('text-anchor', 'middle');
      tp.textContent = el.textContent ?? '';
      newText.appendChild(tp); g.appendChild(newText);
      el.parentNode?.replaceChild(g, el);
      // Written only now the group is in the document: measuring the string needs it
      // mounted, and this branch returns before the re-arc step at the end of the function.
      arcEl.setAttribute(
        'd',
        computeArcPath(cx, cy, attrs.curve, measureTextAdvance(doc.documentElement, gId), halfW),
      );
      const content = new XMLSerializer().serializeToString(doc.documentElement);
      setActiveSvg((prev) => prev ? { ...prev, content } : null);
      return;
    }

    if (attrs.curve !== undefined && isGroup) {
      const currentCurve = Number(el.getAttribute('data-curve') ?? 0);
      const newCurve = attrs.curve;
      el.setAttribute('data-curve', String(newCurve));
      const cx = Number(el.getAttribute('data-cx') ?? 0);
      const cy = Number(el.getAttribute('data-cy') ?? 0);
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const COPY_ATTRS = ['font-family', 'font-size', 'font-weight', 'fill', 'letter-spacing'];

      if (currentCurve === 0 && newCurve !== 0) {
        const content = textEl.textContent ?? '';
        el.removeChild(textEl);
        const arcId = `_arc_${el.id}`;
        const defsEl = doc.createElementNS(SVG_NS, 'defs');
        const arcEl = doc.createElementNS(SVG_NS, 'path');
        arcEl.id = arcId;
        // `d` is left for the re-arc step at the end of this function, which measures the
        // text once it is in place — the arc's size follows the string it carries.
        defsEl.appendChild(arcEl);
        el.appendChild(defsEl);
        const newText = doc.createElementNS(SVG_NS, 'text');
        COPY_ATTRS.forEach((a) => { const v = textEl!.getAttribute(a); if (v) newText.setAttribute(a, v); });
        newText.setAttribute('dominant-baseline', 'middle');
        const tp = doc.createElementNS(SVG_NS, 'textPath');
        tp.setAttribute('href', `#${arcId}`); tp.setAttribute('startOffset', '50%'); tp.setAttribute('text-anchor', 'middle');
        tp.textContent = content;
        newText.appendChild(tp); el.appendChild(newText);
        textEl = newText;
      } else if (currentCurve !== 0 && newCurve === 0) {
        const tp = textEl.querySelector('textPath');
        const content = tp?.textContent ?? textEl.textContent ?? '';
        // Remove arc — may be directly in group (legacy) or inside <defs>
        const arcEl = doc.getElementById(`_arc_${el.id}`) ?? el.querySelector('path');
        if (arcEl) {
          const arcParent = arcEl.parentNode;
          arcParent?.removeChild(arcEl);
          if (arcParent && arcParent.nodeName.toLowerCase() === 'defs' && !arcParent.firstChild) {
            arcParent.parentNode?.removeChild(arcParent);
          }
        }
        el.removeChild(textEl);
        const newText = doc.createElementNS(SVG_NS, 'text');
        newText.setAttribute('x', String(cx)); newText.setAttribute('y', String(cy));
        newText.setAttribute('text-anchor', 'middle'); newText.setAttribute('dominant-baseline', 'middle');
        COPY_ATTRS.forEach((a) => { const v = textEl!.getAttribute(a); if (v) newText.setAttribute(a, v); });
        newText.textContent = content;
        el.appendChild(newText);
        textEl = newText;
      }
      // No non-zero → non-zero case here: the arc's `d` is written once at the end of
      // this function, where the text it has to fit is in its final state.
    }

    if (attrs.content !== undefined) {
      const tp = textEl.querySelector('textPath');
      if (tp) tp.textContent = attrs.content;
      else textEl.textContent = attrs.content;
    }
    if (attrs.font   !== undefined) textEl.setAttribute('font-family', attrs.font);
    // A font pick applies to the whole selection, not just the row the inspector is
    // pointed at — with several text layers selected the dropdown reads as acting on all
    // of them. Only the font fans out; size/weight/colour/content stay single-layer.
    // Non-text layers in the selection are skipped so a shape never picks up font-family.
    if (attrs.font !== undefined && selectedLayers.size > 1) {
      for (const id of selectedLayers) {
        if (id === selectedLayer || !textLayerIds.has(id)) continue;
        const otherEl = doc.getElementById(id);
        if (!otherEl) continue;
        // Same resolution as the primary layer above, so both behave identically: the
        // inner <text> for a text group, otherwise the element itself (font-family
        // inherits to any text inside it).
        const otherText = otherEl.getAttribute('data-text-layer') === '1'
          ? otherEl.querySelector('text')
          : otherEl;
        if (otherText) otherText.setAttribute('font-family', attrs.font);
      }
    }
    if (attrs.size   !== undefined) textEl.setAttribute('font-size', String(attrs.size));
    if (attrs.weight !== undefined) textEl.setAttribute('font-weight', String(attrs.weight));
    if (attrs.color  !== undefined) textEl.setAttribute('fill', attrs.color);
    if (attrs.letterSpacing !== undefined) {
      if (attrs.letterSpacing === 0) textEl.removeAttribute('letter-spacing');
      else textEl.setAttribute('letter-spacing', `${attrs.letterSpacing}em`);
    }

    // Re-arc. The arc's placement depends on how much room the string takes along it, so
    // it has to be recomputed after every edit that changes that — not just the curve.
    // It runs here, once, rather than inside the curve branch above, because that branch
    // executes before content/font/size/letter-spacing are applied and would measure the
    // text as it was rather than as it now is.
    const curveNow = isGroup ? Number(el.getAttribute('data-curve') ?? 0) : 0;
    const reArc =
      attrs.curve !== undefined || attrs.content !== undefined || attrs.font !== undefined ||
      attrs.size !== undefined || attrs.letterSpacing !== undefined;
    if (isGroup && curveNow !== 0 && reArc) {
      const arcEl = doc.getElementById(`_arc_${el.id}`) ?? el.querySelector('path');
      if (arcEl) {
        arcEl.setAttribute('d', computeArcPath(
          Number(el.getAttribute('data-cx') ?? 0),
          Number(el.getAttribute('data-cy') ?? 0),
          curveNow,
          measureTextAdvance(doc.documentElement, el.id),
          Number(el.getAttribute('data-halfw') ?? 100),
        ));
      }
    }

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => {
      if (!prev) return null;
      const layers = attrs.content !== undefined
        ? prev.layers.map((l) => l.id === selectedLayer ? { ...l, label: attrs.content!.trim() || l.label } : l)
        : prev.layers;
      return { ...prev, content, layers };
    });
  }, [selectedLayer, selectedLayers, textLayerIds, activeSvg, snapshotForUndo]);

  // Toggle a suggested font: deselect if already selected, else apply it to the
  // selected text layer (or the pending text-form default when nothing is selected).
  // Defined after updateTextLayer/selectedTextProps so it can depend on them.
  const onSelectImageFont = useCallback((font: string) => {
    setSelectedImageFont((prev) => {
      const next = prev === font ? null : font;
      if (next) {
        if (selectedTextProps) updateTextLayer({ font: next });
        else setTextForm((f) => ({ ...f, font: next }));
      }
      return next;
    });
  }, [selectedTextProps, updateTextLayer]);

  // ── Add text layer ─────────────────────────────────────────────────────────

  const addTextLayer = useCallback(() => {
    if (!activeSvg || !textForm.content.trim()) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const svg = doc.documentElement;

    const vb = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    const cx = vb && vb.length === 4 ? vb[0] + vb[2] / 2 : Number(svg.getAttribute('width') || 200) / 2;
    const cy = vb && vb.length === 4 ? vb[1] + vb[3] / 2 : Number(svg.getAttribute('height') || 200) / 2;
    const vbW = vb && vb.length === 4 ? vb[2] : Number(svg.getAttribute('width') || 400);

    const id = `_text_${Date.now()}`;
    const textContent = textForm.content.trim();

    if (textForm.curve !== 0) {
      // Curved text: <g> wrapping an invisible arc path + <text><textPath>
      // Both share the group transform so dragging keeps them in sync
      const halfW = vbW * 0.35;
      const arcId = `_arc_${id}`;
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.id = id;
      g.setAttribute('data-name', textContent);
      g.setAttribute('data-text-layer', '1');
      g.setAttribute('data-curve', String(textForm.curve));
      g.setAttribute('data-cx', String(cx));
      g.setAttribute('data-cy', String(cy));
      g.setAttribute('data-halfw', String(halfW));
      g.setAttribute('data-fontsize', String(textForm.size));

      const defsEl = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const arcEl = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      arcEl.id = arcId;
      defsEl.appendChild(arcEl);
      g.appendChild(defsEl);

      const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      textEl.setAttribute('font-family', textForm.font);
      textEl.setAttribute('font-size', String(textForm.size));
      textEl.setAttribute('font-weight', String(textForm.weight));
      textEl.setAttribute('fill', textForm.color);
      textEl.setAttribute('dominant-baseline', 'middle');
      if (textForm.letterSpacing) textEl.setAttribute('letter-spacing', `${textForm.letterSpacing}em`);
      const textPathEl = doc.createElementNS('http://www.w3.org/2000/svg', 'textPath');
      textPathEl.setAttribute('href', `#${arcId}`);
      textPathEl.setAttribute('startOffset', '50%');
      textPathEl.setAttribute('text-anchor', 'middle');
      textPathEl.textContent = textContent;
      textEl.appendChild(textPathEl);
      g.appendChild(textEl);
      svg.appendChild(g);
      // Same as the promotion branch: the string can only be measured once the group is
      // in the document, so the arc is placed after it lands.
      arcEl.setAttribute(
        'd',
        computeArcPath(cx, cy, textForm.curve, measureTextAdvance(doc.documentElement, id), halfW),
      );
    } else {
      const halfW = vbW * 0.35;
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.id = id;
      g.setAttribute('data-name', textContent);
      g.setAttribute('data-text-layer', '1');
      g.setAttribute('data-curve', '0');
      g.setAttribute('data-cx', String(cx));
      g.setAttribute('data-cy', String(cy));
      g.setAttribute('data-halfw', String(halfW));
      g.setAttribute('data-fontsize', String(textForm.size));
      const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      textEl.setAttribute('x', String(cx));
      textEl.setAttribute('y', String(cy));
      textEl.setAttribute('text-anchor', 'middle');
      textEl.setAttribute('dominant-baseline', 'middle');
      textEl.setAttribute('font-family', textForm.font);
      textEl.setAttribute('font-size', String(textForm.size));
      textEl.setAttribute('font-weight', String(textForm.weight));
      textEl.setAttribute('fill', textForm.color);
      if (textForm.letterSpacing) textEl.setAttribute('letter-spacing', `${textForm.letterSpacing}em`);
      textEl.textContent = textContent;
      g.appendChild(textEl);
      svg.appendChild(g);
    }

    const content = new XMLSerializer().serializeToString(svg);
    const newLayer = { id, label: textContent };
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: [...prev.layers, newLayer] } : null));
    // Select it outright — the inspector switches to the type form for the new layer.
    setSelectedLayer(id); setSelectedLayers(new Set([id]));
  }, [activeSvg, textForm, snapshotForUndo]);

  // ── Center to canvas horizontal midpoint ─────────────────────────────────

  const centerLayersToCanvas = useCallback(() => {
    if (!activeSvg) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const screenCTM = svgEl.getScreenCTM();
    if (!screenCTM) return;
    const inv = screenCTM.inverse();

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const vb = (doc.documentElement.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if (vb.length < 4) return;
    const canvasCenterX = vb[0] + vb[2] / 2;

    // Which layers move, and by how far.
    const shifts: { id: string; dx: number }[] = [];
    if (selectionIds.length > 0) {
      // With a selection, Center acts on it and nothing else. Several layers move as
      // one block: the union box's midpoint goes to the canvas midpoint and every
      // selected layer shifts by that SAME delta, so the spacing between them survives
      // — centring each one individually would stack them all on the midline. For a
      // single layer the union is just its own box, so it centres itself.
      const box = unionBoxInRootSpace(svgEl, selectionIds);
      if (!box) return;
      const dx = canvasCenterX - (box.x + box.width / 2);
      selectionIds.forEach((id) => shifts.push({ id, dx }));
    } else {
      // Nothing selected: every layer is centred on its own.
      activeSvg.layers.forEach(({ id }) => {
        if (id === backgroundLayerId) return;
        const liveEl = svgEl.getElementById(id);
        if (!liveEl) return;
        const r = liveEl.getBoundingClientRect();
        const pt = svgEl.createSVGPoint();
        pt.x = r.left + r.width / 2;
        pt.y = r.top + r.height / 2;
        const center = pt.matrixTransform(inv);
        shifts.push({ id, dx: canvasCenterX - center.x });
      });
    }

    let changed = false;
    shifts.forEach(({ id, dx }) => {
      if (Math.abs(dx) < 0.5) return;
      const docEl = doc.getElementById(id);
      if (!docEl) return;
      const existing = docEl.getAttribute('transform') ?? '';
      docEl.setAttribute('transform', `translate(${dx.toFixed(2)},0) ${existing}`.trim());
      changed = true;
    });

    if (!changed) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectionIds, backgroundLayerId, snapshotForUndo]);

  // ── Match every layer's rotation to the selected layer ────────────────────
  // Reads the selected layer's rotation (relative to the SVG root) and rotates
  // each other non-background layer about its own centre so its final rotation
  // matches. Requires exactly one selected layer as the reference.

  const matchRotationToSelected = useCallback(() => {
    if (!activeSvg || selectedLayers.size !== 1) return;
    const selId = [...selectedLayers][0];
    if (selId === backgroundLayerId) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const rootCtm = svgEl.getScreenCTM();
    const selEl = svgEl.getElementById(selId) as SVGGraphicsElement | null;
    const selCtm = selEl?.getScreenCTM();
    if (!rootCtm || !selEl || !selCtm) return;

    // Rotation of an element relative to root = angle of (root⁻¹ · elementCTM).
    const rootInv = rootCtm.inverse();
    const angleOf = (m: DOMMatrix) => Math.atan2(m.b, m.a) * 180 / Math.PI;
    const targetAngle = angleOf(rootInv.multiply(selCtm));

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    let changed = false;
    activeSvg.layers.forEach(({ id }) => {
      if (id === backgroundLayerId || id === selId) return;
      const liveEl = svgEl.getElementById(id) as SVGGraphicsElement | null;
      const docEl = doc.getElementById(id);
      const ctm = liveEl?.getScreenCTM();
      if (!liveEl || !docEl || !ctm) return;
      const delta = targetAngle - angleOf(rootInv.multiply(ctm));
      if (Math.abs(delta) < 0.01) return;
      const box = bboxInRootSpace(svgEl, liveEl);
      if (!box) return;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const existing = docEl.getAttribute('transform') ?? '';
      docEl.setAttribute(
        'transform',
        `rotate(${delta.toFixed(2)}, ${cx.toFixed(2)}, ${cy.toFixed(2)}) ${existing}`.trim(),
      );
      changed = true;
    });

    if (!changed) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayers, backgroundLayerId, snapshotForUndo]);

  // ── Rotate the selection 90° (handoff §"Toolbar actions") ─────────────────
  // Quarter-turn about each selected layer's own centre. No-op for the background.

  const rotateSelected90 = useCallback(() => {
    if (!activeSvg || !selectedLayers.size) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    let changed = false;
    [...selectedLayers].forEach((id) => {
      if (id === backgroundLayerId) return;
      const liveEl = svgEl.getElementById(id) as SVGGraphicsElement | null;
      const docEl = doc.getElementById(id);
      if (!liveEl || !docEl) return;
      const box = bboxInRootSpace(svgEl, liveEl);
      if (!box) return;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const existing = docEl.getAttribute('transform') ?? '';
      docEl.setAttribute('transform', `rotate(90, ${cx.toFixed(2)}, ${cy.toFixed(2)}) ${existing}`.trim());
      changed = true;
    });

    if (!changed) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayers, backgroundLayerId, snapshotForUndo]);

  // ── Load + register a Google Font ─────────────────────────────────────────

  const loadGoogleFontLink = useCallback((fontName: string, weight?: number) => {
    const family = fontName.replace(/\s+/g, '+');
    const slug = fontName.replace(/\s+/g, '-');
    const inject = (id: string, href: string) => {
      if (document.getElementById(id)) return;
      const link = document.createElement('link');
      link.id = id; link.rel = 'stylesheet'; link.href = href;
      document.head.appendChild(link);
    };
    inject(`gfont-${slug}`, `https://fonts.googleapis.com/css2?family=${family}:wght@400;700&display=swap`);
    // A weight outside the base pair goes in its OWN request rather than being appended to
    // it. Google's css2 endpoint rejects the whole request when any requested weight is
    // unavailable for the family, so folding an 800 into the base request would take 400
    // and 700 down with it and leave the family with no faces at all. Split, the worst a
    // missing weight costs is that one weight, and the browser synthesises it.
    if (weight && weight !== 400 && weight !== 700) {
      inject(`gfont-${slug}-${weight}`, `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&display=swap`);
    }
  }, []);

  // A suggestion: offered, not yet applied to anything.
  const addGoogleFont = useCallback((fontName: string, weight?: number) => {
    setExtraFonts((prev) => prev.includes(fontName) ? prev : [...prev, fontName]);
    loadGoogleFontLink(fontName, weight);
  }, [loadGoogleFontLink]);

  // A face a re-created text row is actually set in. Kept out of the suggestion list so
  // one can be listed ahead of the other, and so a font in use never reads as a proposal.
  const addUsedFont = useCallback((fontName: string, weight?: number) => {
    if (!fontName) return;
    setUsedFonts((prev) => prev.includes(fontName) ? prev : [...prev, fontName]);
    loadGoogleFontLink(fontName, weight);
  }, [loadGoogleFontLink]);

  // ── Image-level font suggestions ──────────────────────────────────────────

  const suggestFontsForImage = useCallback(async () => {
    if (!activeSvg) return;
    setImageFontsLoading(true);
    setShowImageFonts(true);
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const root = doc.documentElement;
      const { w: vw, h: vh } = parseViewBox(root);
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(activeSvg.content, Math.round(vw * scale), Math.round(vh * scale));

      const raw = await callLlmVision({
        model: 'claude-sonnet-5', maxTokens: 1000, pngBase64, tag: 'suggest-fonts',
        prompt: `Look at this design image. Suggest ${FONT_SUGGESTION_LIMIT} Google Fonts that would complement its visual style, mood, colour palette, and aesthetic. Consider the overall feel of the design.
Return JSON only, no markdown: {"suggestions":[{"font":"Font Name","reason":"brief reason"}]}`,
      });
      const parsed = JSON.parse(raw) as { suggestions: Array<{ font: string; reason: string }> };
      // Capped as well as asked for: the model is not bound by the number in the prompt.
      const suggestions = (parsed.suggestions ?? []).slice(0, FONT_SUGGESTION_LIMIT);
      suggestions.forEach(({ font }) => loadGoogleFontLink(font));
      setImageFonts(suggestions);
    } catch (err) {
      console.error('Font suggestion failed:', err);
      setImageFonts([]);
    } finally {
      setImageFontsLoading(false);
    }
  }, [activeSvg, loadGoogleFontLink]);


  // ── Customise (strip all text + font suggestions) ─────────────────────────

  // Tell the review host the asset has been customised, once the pass has actually
  // succeeded. Only meaningful for a /<uuid> deep link — a dropped file or a sample has
  // no uuid to report against. Fire-and-forget and self-contained: the artwork on the
  // canvas is already correct, so a failed notification must not surface as a failed
  // customise. Logged under [review/customised] like the other review calls.
  const notifyCustomised = useCallback(async () => {
    // The uuid of whatever is on the canvas, not the one in the URL: an asset opened
    // from the dev rail's dropdown has no uuid in the path, and keying off `reviewUuid`
    // meant those runs silently notified nothing.
    const uuid = openReviewUuidRef.current;
    if (!uuid) return;
    // The host rewrites the SVG for a customised asset, so the copy held for this uuid
    // is no longer the artwork — drop it and let the next open fetch it fresh.
    reviewCacheRef.current.delete(uuid);
    try {
      const res = await fetch(`/api/review/customised/${uuid}`, { method: 'POST' });
      const data = (await res.json()) as { message?: string; error?: { message?: string } };
      console.log(`[review/customised] ${uuid} -> ${res.status}`, data);
      if (!res.ok || data.message !== 'success') {
        console.log('[review/customised] upstream did not report success');
      }
    } catch (err) {
      console.log(`[review/customised] ${uuid} failed:`, err);
    }
  }, []);

  const runCustomise = useCallback(async () => {
    if (!activeSvg) return;
    // Gated assets (edit === 0) can't use the AI features — show the upsell instead.
    if (activeSvg.edit === 0) { setShowUpsell(true); return; }
    // Customised too recently for the host to accept another pass — re-raise the
    // message instead of making the call, the same way a gated asset gets the upsell.
    // The dev toggle runs the pass anyway; asked at call time so flipping it takes
    // effect on the next click without reopening the asset.
    if (cooldownActive) {
      if (isIgnoreCooldownPrompt()) {
        console.log('[customise] cooldown active — running anyway (dev toggle)');
      } else {
        setShowCooldown(true);
        return;
      }
    }
    setCustomiseLoading(true);
    setAiLoading(true);
    setAiError(null);
    setAiStatusMsg('Analysing image…');
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const root = doc.documentElement;
      const viewBox = root.getAttribute('viewBox') ?? '0 0 800 600';
      const { x: vbX, y: vbY, w: vw, h: vh } = parseViewBox(root);

      // Per-layer processing (below) rasterizes each layer on its own, so here we only
      // need the shared raster scale and the document <defs> (gradients/styles) that
      // each isolated layer must render against.
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const defsEl = doc.querySelector('defs');
      const defsXml = defsEl ? new XMLSerializer().serializeToString(defsEl) : '';

      type CustomiseResult = { hasText: boolean; rows: TextRow[]; removeIds: string[]; fonts: string[] };

      const SHAPE_TAGS = new Set(['path', 'g', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan', 'use']);

      // Send ONLY the content layers to the model in ONE call — skip full-canvas
      // backgrounds and existing editable text. Including the whole document (especially
      // the background) made the model read the artwork as a single logo and over-flag
      // graphics as text; scoping to the content, like strip-text, fixes it in a single
      // request. The raster always maps the full viewBox onto the canvas, so excluding
      // the background changes nothing about where text sits — field positions stay correct.
      let aiIdx = 0;
      const aiIdMap = new Map<string, Element>();
      const markEls = (el: Element) => {
        for (const child of Array.from(el.children)) {
          if (isEditableTextField(child)) continue;
          // Already taken by an earlier pass — offering it again would have the model
          // re-detect text that is no longer on the artwork.
          if (child.id && hiddenLayers.has(child.id)) continue;
          const tag = child.tagName.toLowerCase().replace(/.*:/, '');
          if (SHAPE_TAGS.has(tag)) {
            const sid = String(aiIdx++);
            child.setAttribute('data-ai-idx', sid);
            aiIdMap.set(sid, child);
          }
          markEls(child);
        }
      };

      // Layers are in document order, so the first eligible one is the bottom-most —
      // the only one that can be a background fill. Testing every layer for full-canvas
      // area also discarded single-group artwork (one <g> holding the whole drawing
      // spans the canvas by definition), which left nothing to analyse.
      const eligibleEls: Element[] = [];
      for (const layer of activeSvg.layers) {
        if (layer.id.startsWith('_text_')) continue;                 // already-editable text
        const layerEl = doc.getElementById(layer.id);
        if (!layerEl || isEditableTextField(layerEl)) continue;
        eligibleEls.push(layerEl);
      }
      let contentEls = eligibleEls;
      const bottomEl = eligibleEls[0];
      // The colour the skipped background was painting. The layer itself stays out of the
      // raster — including it made the model read whole artworks as one logo — but the
      // canvas is filled with its colour, so artwork that only reads against that
      // background (white lettering on black, say) is still visible in the image. Without
      // it the PNG is transparent, which flattens to white and hides exactly that artwork.
      let bgColor: string | null = null;
      if (bottomEl && isFullCanvasLayer(doc.documentElement, bottomEl.id, vw, vh)) {
        console.log('[customise] skipping full-canvas background layer:', bottomEl.id);
        contentEls = eligibleEls.slice(1);
        bgColor = backgroundFillColor(activeSvg.content, bottomEl.id);
        console.log(`[customise] rastering against background ${bgColor ?? 'none (not a flat colour)'}`);
      }
      // Dropping the background must never empty the payload — a blank raster makes the
      // model answer "no text" no matter what the artwork holds. Analyse everything instead.
      if (contentEls.length === 0 && eligibleEls.length > 0) {
        console.log('[customise] background skip emptied the content set — analysing all layers');
        contentEls = eligibleEls;
      }
      // Mark a content layer ITSELF only when it's a LEAF shape (no element children),
      // then mark its descendants. A bare leaf <path> layer (e.g. the "PREMIUM MONOGRAM"
      // outline in a monogram logo) otherwise carries no data-ai-idx, so the model can
      // never return it in removeIds and the outline is left behind under the new text.
      // A container <g> must stay UNMARKED — marking it would expose the whole artwork's
      // index and let the model wipe everything; its children (incl. nested word-groups)
      // are marked by markEls, which is what keeps grouped logos removable sub-part by
      // sub-part.
      const markContent = (el: Element) => {
        const tag = el.tagName.toLowerCase().replace(/.*:/, '');
        if (el.id && hiddenLayers.has(el.id)) return;
        if (SHAPE_TAGS.has(tag) && el.children.length === 0 && !isEditableTextField(el)) {
          const sid = String(aiIdx++);
          el.setAttribute('data-ai-idx', sid);
          aiIdMap.set(sid, el);
        }
        markEls(el);
      };
      contentEls.forEach((el) => markContent(el));
      const contentXml = contentEls.map((el) => new XMLSerializer().serializeToString(el)).join('');
      // Scoped raster: defs + content layers only (no background) at the full viewBox.
      const contentSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}">${defsXml}${contentXml}</svg>`;
      const pngBase64 = await svgToBase64Png(
        svgWithoutHidden(contentSvg, hiddenLayers), Math.round(vw * scale), Math.round(vh * scale), bgColor,
      );

      // Dev-only cache. The marked source is derived deterministically from the document,
      // so reverting and running again — or reloading mid-iteration — reproduces the
      // exact key and reuses the stored answer instead of paying for the call twice. The
      // removeIds in that answer address the data-ai-idx marks in contentXml, which is
      // why the hash is taken over contentXml rather than the raw artwork.
      //
      // The background colour is part of the key because the model sees the raster, not
      // just the source: the same contentXml against a different backdrop is a different
      // question. v2 also retires every answer cached from the era when the raster had no
      // backdrop at all — those were answered on an image with the artwork missing.
      // v3 retired the v2 answers for the same reason strip-text bumped to v7: they carry
      // no per-row removeIds, so their rows can never anchor to measured geometry. v4
      // retires v3 alongside strip-text v8, for the duplicated-rows prompt bug. v5 retires
      // v4: those answers predate the per-row font instruction and tend to name one family
      // for the whole image, which renders a script tagline as whatever the wordmark used.
      // The suggestion limit is part of the key rather than a version bump: raising it
      // asks a different question, and a cached answer would otherwise keep returning
      // the old count and make the setting look like it does nothing.
      const cacheKey = `customise-v5:${TEXT_PARSE_MODEL}:f${FONT_SUGGESTION_LIMIT}:${bgColor ?? 'none'}:${hashString(contentXml)}`;
      let parsed: CustomiseResult;
      const cachedRaw = readAiCache(cacheKey);

      if (cachedRaw) {
        console.log('[customise] cache hit — skipping the model call:', cacheKey);
        parsed = JSON.parse(cachedRaw) as CustomiseResult;
      } else {
        setAiStatusMsg('Reviewing vector…');
        const rawText = await callLlmVision({
          model: TEXT_PARSE_MODEL, maxTokens: 8192, pngBase64, tag: 'customise',
          prompt: `Analyze this SVG image and its source.

${TEXT_PARSING_PROMPT}

TASK 4 — Font suggestions: Suggest ${FONT_SUGGESTION_LIMIT} Google Font names that suit the style, mood, and colour palette of this design. Return names only.

SVG source:
${contentXml}

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation, and no preamble before the object:
{"hasText":true,"rows":[{"yFraction":0.3,"xFraction":0.5,"font":"Playfair Display","sizeFraction":0.1,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0,"removeIds":["3","9"]}],"removeIds":["3","9"],"fonts":["Playfair Display","Lato"]}`,
        });

        try {
          parsed = JSON.parse(rawText) as CustomiseResult;
          if (!Array.isArray(parsed.rows)) parsed.rows = [];
          parsed.removeIds = Array.isArray(parsed.removeIds) ? parsed.removeIds.map(String) : [];
          if (!Array.isArray(parsed.fonts)) parsed.fonts = [];
          parsed.rows.forEach(normaliseRowRemoveIds);
        } catch (err) {
          logUnreadable('customise', rawText, err);
          throw new Error('AI returned an unreadable response');
        }

        // Stored post-normalisation, so a cache hit lands on the same shape the
        // rest of the pass expects without re-running the guards.
        writeAiCache(cacheKey, JSON.stringify(parsed));
      }
      console.log('[customise] LLM returned:', { hasText: parsed.hasText, removeIds: parsed.removeIds, rows: parsed.rows.length });

      setAiStatusMsg('Applying changes…');

      // The two tasks read different inputs — TASK 1 the raster, TASK 2 the SVG source —
      // so they can disagree. hasText: false with a non-empty removeIds is that
      // disagreement: the source analysis found lettering the image analysis couldn't
      // read (white artwork rastered without its background is one way to get there).
      // Deleting on that answer strips the wordmark and re-adds nothing, which is worse
      // than doing nothing at all. Removal is only ever as trustworthy as the
      // replacement that comes with it, so the whole edit is abandoned.
      const requested = allRemoveIds(parsed);
      const contradictory = !parsed.hasText && requested.length > 0;
      if (contradictory) {
        console.log(
          `[customise] hasText=false but ${requested.length} removeIds — contradictory answer, removing nothing`,
        );
      }

      const removeIds = contradictory
        ? []
        : filterOutBackgroundIds(doc.documentElement, requested, vw, vh, 'customise');
      console.log(`[customise] taking ${removeIds.length}/${requested.length} element(s) after guard`);
      // Measured before anything is hidden. The boxes are what the replacement text is
      // placed from, and they also give the dev panel something to show per entry.
      const anchors = measureRemovedTextBoxes(doc.documentElement, removeIds);
      const hidden = hideRemovedElements(aiIdMap, removeIds, parsed.rows, anchors, hiddenLayers, 'customise');
      for (const [, el] of aiIdMap) el.removeAttribute('data-ai-idx');

      const allRows = parsed.hasText ? parsed.rows : [];
      const allFonts = parsed.fonts;

      // Re-add editable text layers — one per detected row (same placement logic as strip-text)
      // Each row's own family AND weight, so the face the model matched is the face that
      // renders — and the face that gets measured a few lines below.
      allRows.forEach(({ font, weight }) => addUsedFont(font, weight));
      await ensureRowFontsReady(allRows);
      console.log(`[customise] anchored ${countAnchoredRows(allRows, anchors)}/${allRows.length} row(s) to measured geometry`);
      const newTextLayers = appendTextRowLayers(doc, allRows, { x: vbX, y: vbY, w: vw, h: vh }, undefined, anchors);

      // Suggested fonts, deduped across all layers. Registered with addGoogleFont rather
      // than just link-loaded, so they show up in the inspector's Font list and can be
      // applied to any layer by hand.
      const validFonts = Array.from(new Set(allFonts.filter(Boolean))).slice(0, FONT_SUGGESTION_LIMIT);
      validFonts.forEach((f) => addGoogleFont(f));
      setCustomiseFonts(validFonts);

      // The first suggestion becomes the default for text layers added AFTERWARDS, and
      // nothing more.
      //
      // It used to be written over every field this run had just created, on the reasoning
      // that one typeface reads better than a per-row guess. That threw away the whole
      // per-row answer: TASK 1 identifies each line's own face — a heavy sans wordmark
      // above a script tagline — and this replaced both with a single image-level
      // suggestion, so a script line came back set in whatever the wordmark used. It also
      // silently invalidated the sizing, because appendTextRowLayers measures each field
      // in ITS font to scale it onto the artwork it replaced, and swapping the family
      // afterwards changes those widths.
      //
      // The suggestions are still registered above, so every one of them is a click away
      // in the inspector's Font list if a row's match is wrong.
      const primaryFont = validFonts[0] ?? '';
      if (primaryFont) setTextForm((f) => ({ ...f, font: primaryFont }));

      const content = new XMLSerializer().serializeToString(root);
      // Still called although the pass no longer deletes: a row can become undrawable
      // another way (an emptied container), and this is where that is caught. For the
      // elements this pass took it is now a no-op — they are hidden, not gone, so their
      // rows survive and simply display as hidden.
      const kept = pruneMissingLayers(doc, activeSvg.layers);
      setActiveSvg((prev) => {
        if (!prev) return null;
        return { ...prev, content, layers: [...kept, ...newTextLayers] };
      });
      registerRemoved(hidden);
      dropSelectionOutside(kept, newTextLayers);
      if (newTextLayers.length > 0) setSelectedLayer(newTextLayers[0].id);

      // Nothing removed and nothing added means the artwork is untouched — the font
      // suggestions above are the only thing this run produced. Telling the host it was
      // customised would start a 24h lockout for an edit that never happened, and the
      // pill would grey out as spent, so an abandoned run stays repeatable instead.
      const changed = removeIds.length > 0 || newTextLayers.length > 0;
      if (changed) {
        setCustomiseDone(true);
        // Reached only when the pass ran through — the catch below owns every failure.
        void notifyCustomised();
      } else {
        console.log('[customise] artwork unchanged — not marking customised');
        setAiError('No text was detected in this artwork — nothing was changed.');
      }

    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Customise failed');
      setCustomiseDone(true);
    } finally {
      setCustomiseLoading(false);
      setAiLoading(false);
      setAiStatusMsg('Thinking…');
    }
  }, [activeSvg, addGoogleFont, loadGoogleFontLink, snapshotForUndo, notifyCustomised, cooldownActive]);

  const applyFontGlobally = useCallback((fontName: string) => {
    if (!activeSvg) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    doc.querySelectorAll('text, tspan').forEach((el) => el.setAttribute('font-family', fontName));
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => prev ? { ...prev, content } : null);
    addGoogleFont(fontName);
  }, [activeSvg, snapshotForUndo, addGoogleFont]);

  // ── Taxonomy analysis ─────────────────────────────────────────────────────

  const runTaxonomyAnalysis = useCallback(async () => {
    if (!activeSvg) return;
    setTaxonomyLoading(true);
    setTaxonomy(null);
    setTaxonomyOpen(true);
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const root = doc.documentElement;
      const { w: vw, h: vh } = parseViewBox(root);
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(activeSvg.content, Math.round(vw * scale), Math.round(vh * scale));
      const raw = await callLlmVision({
        model: 'claude-sonnet-5', maxTokens: 512, pngBase64, tag: 'taxonomy',
        prompt: `Analyze this SVG design and classify its visual elements into taxonomy groups.

Use ONLY these type values: background, text, icon, graphic, decoration, shape, image.

Return ONLY valid JSON — no markdown, no explanation:
{"groups":[{"type":"background","elements":["solid dark fill"]},{"type":"text","elements":["curved top banner"]}]}`,
      });
      const parsed = JSON.parse(raw) as { groups: TaxonomyGroup[] };
      setTaxonomy(parsed.groups ?? []);
    } catch (err) {
      console.error('Taxonomy analysis failed:', err);
      setTaxonomy([]);
    } finally {
      setTaxonomyLoading(false);
    }
  }, [activeSvg]);

  // ── Color replace ─────────────────────────────────────────────────────────

  // Find & replace one colour across the selected layer (handoff §"Find & replace
  // colours"): every shape using `from` — attributes, inline styles, class rules and
  // referenced gradient stops — becomes `to`.
  //
  // The picker fires continuously while the user drags, so the first call of a session
  // records one undo entry and the document as its baseline; every later call replays
  // the replacement from that baseline instead of stacking edits.
  const replaceLayerColor = useCallback((from: string, to: string) => {
    if (!activeSvg || !selectedLayer || !from) return;

    let session = colorEditRef.current;
    if (!session || session.from !== from) {
      snapshotForUndo(activeSvg.content, activeSvg.layers);
      session = { from, baseline: activeSvg.content };
      colorEditRef.current = session;
    }

    const applyTo = to;
    const normalFrom = normalizeColor(from);
    const doc = new DOMParser().parseFromString(session.baseline, 'image/svg+xml');
    const layerEl = doc.getElementById(selectedLayer);
    if (!layerEl) return;

    const COLOR_ATTRS = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color'];

    // Replace color values in a CSS/style string
    const replaceInCss = (css: string): { result: string; changed: boolean } => {
      let changed = false;
      const result = css.replace(
        /(fill|stroke|color|stop-color|flood-color|lighting-color)\s*:\s*([^;{}]+)/gi,
        (_, prop: string, val: string) => {
          if (normalizeColor(val.trim()) === normalFrom) { changed = true; return `${prop}: ${applyTo}`; }
          return `${prop}: ${val}`;
        },
      );
      return { result, changed };
    };

    // Replace on a single element's attributes + inline style
    const processEl = (el: Element) => {
      COLOR_ATTRS.forEach((attr) => {
        const val = el.getAttribute(attr);
        if (val && normalizeColor(val) === normalFrom) el.setAttribute(attr, applyTo);
      });
      const style = el.getAttribute('style');
      if (style) {
        const { result, changed } = replaceInCss(style);
        if (changed) el.setAttribute('style', result);
      }
    };

    processEl(layerEl);
    layerEl.querySelectorAll('*').forEach((el) => processEl(el));

    // Shapes that never declare a fill have nothing to rewrite, yet they do paint —
    // inherited, or black by default — and that colour is offered as a swatch. Set the
    // fill on them so picking it actually recolours the shape instead of doing nothing.
    [layerEl, ...Array.from(layerEl.querySelectorAll('*'))].forEach((el) => {
      const tag = el.tagName.toLowerCase().replace(/.*:/, '');
      if (!PAINTABLE_TAGS.has(tag) || declaresOwnFill(el, doc)) return;
      const fill = effectiveFill(el, doc);
      if (fill && normalizeColor(fill) === normalFrom) el.setAttribute('fill', applyTo);
    });

    // For CSS class rules in <style> blocks: the rules are document-scoped, so rewriting
    // them would affect every layer sharing that class. Instead, add inline style overrides
    // on the specific elements within this layer — inline styles win specificity, leaving
    // all other layers untouched.
    const layerClassNames = new Set<string>();
    [layerEl, ...Array.from(layerEl.querySelectorAll('[class]'))].forEach((el) => {
      el.getAttribute('class')?.split(/\s+/).forEach((c) => c && layerClassNames.add(c));
    });

    // Build map: className → set of CSS property names that carry the "from" color
    const classProps = new Map<string, Set<string>>();
    doc.querySelectorAll('style').forEach((styleEl) => {
      const css = styleEl.textContent ?? '';
      for (const ruleMatch of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = ruleMatch[1].split(',');
        const declarations = ruleMatch[2];
        [...layerClassNames].forEach((cls) => {
          if (!selectors.some((s) => s.includes(`.${cls}`))) return;
          for (const dm of declarations.matchAll(/(fill|stroke|color|stop-color|flood-color|lighting-color)\s*:\s*([^;{}]+)/gi)) {
            if (normalizeColor(dm[2].trim()) === normalFrom) {
              if (!classProps.has(cls)) classProps.set(cls, new Set());
              classProps.get(cls)!.add(dm[1].toLowerCase());
            }
          }
        });
      }
    });

    if (classProps.size > 0) {
      [layerEl, ...Array.from(layerEl.querySelectorAll('*'))].forEach((el) => {
        const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        const propsToSet = new Set<string>();
        classes.forEach((cls) => classProps.get(cls)?.forEach((p) => propsToSet.add(p)));
        if (propsToSet.size === 0) return;
        // Merge new values into existing inline style without duplicating properties
        const styleMap = new Map<string, string>();
        (el.getAttribute('style') ?? '').split(';').forEach((decl) => {
          const idx = decl.indexOf(':');
          if (idx === -1) return;
          styleMap.set(decl.slice(0, idx).trim().toLowerCase(), decl.slice(idx + 1).trim());
        });
        propsToSet.forEach((prop) => styleMap.set(prop, applyTo));
        el.setAttribute('style', [...styleMap.entries()].map(([p, v]) => `${p}: ${v}`).join('; '));
      });
    }

    // Replace stop colors in gradients referenced by this layer
    collectLayerGradientIds(layerEl, layerClassNames, doc).forEach((id) => {
      const source = resolveGradient(id, doc);
      source?.querySelectorAll('stop').forEach((stop) => {
        const sc = stop.getAttribute('stop-color');
        if (sc && normalizeColor(sc) === normalFrom) stop.setAttribute('stop-color', applyTo);
      });
    });

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayer, snapshotForUndo]);

  // The picker closed — the next pick starts a fresh undo entry and baseline.
  const endColorEdit = useCallback(() => { colorEditRef.current = null; }, []);

  // ── AI layer actions ───────────────────────────────────────────────────────

  const runAiLayerAction = useCallback(async (action: 'strip-text' | 'suggest-font' | 'remove-specific-text' | 'check-text' = 'strip-text', query = '') => {
    if (!activeSvg || !selectedLayer) return;
    const layerId = selectedLayer;
    setAiLoading(true);
    setAiError(null);
    setAiStatusMsg('Thinking…');
    setTextCheckResult(null);
    setFontSuggestion(null);
    setSuggestedFontName(null);
    if (action === 'strip-text' || action === 'remove-specific-text') {
      snapshotForUndo(activeSvg.content, activeSvg.layers);
    }
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const layerEl = doc.getElementById(layerId);
      if (!layerEl) throw new Error('Layer not found');
      const svgString = new XMLSerializer().serializeToString(layerEl);

      // Render layer to PNG for vision
      const svgRoot = doc.documentElement;
      const viewBox = svgRoot.getAttribute('viewBox') ?? '0 0 800 600';
      const { x: vbX, y: vbY, w: vw, h: vh } = parseViewBox(svgRoot);
      const defsEl = doc.querySelector('defs');
      const defsXml = defsEl ? new XMLSerializer().serializeToString(defsEl) : '';
      const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}">${defsXml}${svgString}</svg>`;
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(
        svgWithoutHidden(previewSvg, hiddenLayers), Math.round(vw * scale), Math.round(vh * scale),
      );

      // ── Suggest font ───────────────────────────────────────────────────────
      if (action === 'suggest-font') {
        const rawText = await callLlmVision({
          model: 'claude-sonnet-5', maxTokens: 1000, pngBase64, tag: 'suggest-font',
          prompt: `Look at this SVG layer image. Does it contain any text (including text rendered as outlined paths)?
If yes, suggest a single Google Font that best matches the style, mood, and visual character of the text. Return only JSON: {"font":"Font Name","reason":"brief reason"}.
If no text is detected return: {"font":null,"reason":"No text detected"}.
Return JSON only, no markdown.`,
        });
        try {
          const parsed = JSON.parse(rawText) as { font: string | null; reason: string };
          if (parsed.font) { setSuggestedFontName(parsed.font); addGoogleFont(parsed.font); }
          setFontSuggestion(parsed.font ? `${parsed.font} — ${parsed.reason}` : parsed.reason);
        } catch {
          setFontSuggestion(rawText);
        }
        return;
      }

      // ── Check text ─────────────────────────────────────────────────────────
      if (action === 'check-text') {
        setAiStatusMsg('Reading text…');
        const rawText = await callLlmVision({
          model: 'claude-sonnet-5', maxTokens: 512, pngBase64, tag: 'check-text',
          prompt: `Look at this SVG layer image. Identify the main text content.
Return ONLY a JSON object with these two fields:
- "heading": the primary / largest text (the main title or headline). Empty string if none.
- "subheading": secondary text beneath or supporting the heading (tagline, subtitle, date, etc.). Empty string if none.

No markdown, no code fences, no explanation. Example:
{"heading":"GRAND OPENING","subheading":"Saturday June 21st"}`,
        });
        try {
          const parsed = JSON.parse(rawText) as { heading: string; subheading: string };
          setTextCheckResult(parsed);
        } catch {
          setTextCheckResult({ heading: rawText, subheading: '' });
        }
        return;
      }

      // ── Remove specific text ────────────────────────────────────────────────
      if (action === 'remove-specific-text') {
        // Annotate elements with temporary IDs so Claude can reference by index
        const RST_SHAPE_TAGS = new Set(['path','g','circle','rect','ellipse','polygon','polyline','line','text','tspan','use']);
        let rstIdx = 0;
        const rstIdMap = new Map<string, Element>();
        const rstMarkEls = (el: Element) => {
          for (const child of Array.from(el.children)) {
            if (child.id && hiddenLayers.has(child.id)) continue;
            const tag = child.tagName.toLowerCase().replace(/.*:/, '');
            if (RST_SHAPE_TAGS.has(tag)) {
              const sid = String(rstIdx++);
              child.setAttribute('data-ai-idx', sid);
              rstIdMap.set(sid, child);
            }
            rstMarkEls(child);
          }
        };
        rstMarkEls(layerEl);
        const rstMarkedSvg = new XMLSerializer().serializeToString(layerEl);

        setAiStatusMsg('Finding text…');
        const rawText = await callLlmVision({
          model: 'claude-sonnet-5', maxTokens: 1024, pngBase64, tag: 'remove-specific-text',
          prompt: `You are editing an SVG layer. Find and remove ONLY the text matching: "${query}"

Every SVG element has a data-ai-idx attribute. Identify which elements render that specific text — including <text>/<tspan> elements AND path/group elements whose shapes form those letters. If a <g> group's children together form the target word, return the group's index (not the individual child paths).

SVG source:
${rstMarkedSvg}

Respond with ONLY a valid JSON object — no markdown, no code fences:
{"removeIds":["3","9"]}`,
        });
        let removeIds: string[];
        try {
          removeIds = (JSON.parse(rawText) as { removeIds: string[] }).removeIds ?? [];
        } catch {
          throw new Error('AI returned an unreadable response');
        }
        setAiStatusMsg('Applying changes…');
        // Hidden, not deleted, for the same reason as the other passes — the user named
        // the text but the model chose the elements, and it can choose wrongly. Recorded
        // under the query, so the dev panel groups these as "what removing X took".
        const rstAnchors = measureRemovedTextBoxes(doc.documentElement, removeIds);
        const rstHidden = hideRemovedElements(
          rstIdMap, removeIds,
          [{ content: query, removeIds } as TextRow],
          rstAnchors, hiddenLayers, 'remove-specific-text',
        );
        for (const [, el] of rstIdMap) el.removeAttribute('data-ai-idx');
        const contentRST = new XMLSerializer().serializeToString(doc.documentElement);
        const keptRST = pruneMissingLayers(doc, activeSvg.layers);
        setActiveSvg((prev) => prev ? { ...prev, content: contentRST, layers: keptRST } : null);
        registerRemoved(rstHidden);
        dropSelectionOutside(keptRST, []);
        setShowRemoveTextInput(false);
        setRemoveTextQuery('');
        return;
      }

      // ── Strip text (detect + index-based removal) ─────────────────────────
      type StripResult = { hasText: boolean; rows: TextRow[]; removeIds: string[] };

      // Label every shape/group element with a temporary data-ai-idx so Claude
      // can reference them by index instead of reconstructing the full SVG.
      const SHAPE_TAGS = new Set(['path','g','circle','rect','ellipse','polygon','polyline','line','text','tspan','use']);
      let aiIdx = 0;
      const aiIdMap = new Map<string, Element>();
      const markEls = (el: Element) => {
        for (const child of Array.from(el.children)) {
          if (isEditableTextField(child)) continue;  // leave user-managed text fields alone
          // Already taken by an earlier pass. Offering it again would have the model
          // re-detect text that is no longer on the artwork.
          if (child.id && hiddenLayers.has(child.id)) continue;
          const tag = child.tagName.toLowerCase().replace(/.*:/, '');
          if (SHAPE_TAGS.has(tag)) {
            const sid = String(aiIdx++);
            child.setAttribute('data-ai-idx', sid);
            aiIdMap.set(sid, child);
          }
          markEls(child);
        }
      };
      markEls(layerEl);
      const markedSvgString = new XMLSerializer().serializeToString(layerEl);

      // v7 retired every v6 answer: those predate the per-row removeIds linking, so
      // replaying one would place its rows from the estimate and quietly look like the
      // measurement had failed. v8 retires v7 in turn — its linking instruction read as a
      // partition ("every index appears in exactly one row"), which made the model answer
      // with one row per stacked copy of a word, and those answers re-add each field
      // three times over.
      const cacheKey = `strip-text-v9:${TEXT_PARSE_MODEL}:${hashString(svgString)}`;
      let parsed: StripResult;

      const cachedRaw = readAiCache(cacheKey);
      if (cachedRaw) {
        console.log('[strip-text] cache hit — skipping the model call:', cacheKey);
        parsed = JSON.parse(cachedRaw) as StripResult;
      } else {
        setAiStatusMsg('Reviewing vector…');
        const rawText = await callLlmVision({
          model: TEXT_PARSE_MODEL, maxTokens: 8192, pngBase64, tag: 'strip-text',
          prompt: `Analyze this SVG layer image and its source code.

${TEXT_PARSING_PROMPT}

SVG source:
${markedSvgString}

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"hasText":true,"rows":[{"yFraction":0.5,"xFraction":0.5,"font":"Impact","sizeFraction":0.08,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0.05,"removeIds":["3","9"]}],"removeIds":["3","9"]}`,
        });

        try {
          parsed = JSON.parse(rawText) as StripResult;
          parsed.removeIds = Array.isArray(parsed.removeIds) ? parsed.removeIds.map(String) : [];
          if (Array.isArray(parsed.rows)) parsed.rows.forEach(normaliseRowRemoveIds);
        } catch (err) {
          logUnreadable('strip-text', rawText, err);
          throw new Error('AI returned an unreadable response');
        }

        writeAiCache(cacheKey, JSON.stringify(parsed));
      }

      // Remove identified text elements directly from the DOM
      setAiStatusMsg('Applying changes…');
      console.log('[strip-text] LLM returned:', {
        hasText: parsed.hasText,
        rows: parsed.rows?.length ?? 0,
        removeIds: parsed.removeIds,
      });
      const stripRequested = allRemoveIds(parsed);
      const stripRemoveIds = filterOutBackgroundIds(doc.documentElement, stripRequested, vw, vh, 'strip-text');
      // Ground truth for placement: the boxes are read off the live geometry, and the
      // elements stay in the document, so this is measuring rather than salvaging.
      const stripAnchors = measureRemovedTextBoxes(doc.documentElement, stripRemoveIds);
      const stripHidden = hideRemovedElements(
        aiIdMap, stripRemoveIds, parsed.rows ?? [], stripAnchors, hiddenLayers, 'strip-text',
      );
      console.log(`[strip-text] took ${stripHidden.length}/${stripRequested.length} element(s)`);
      // Clean up temporary index attributes from remaining elements
      for (const [, el] of aiIdMap) {
        el.removeAttribute('data-ai-idx');
      }

      // One editable text layer per detected row — no grouping, no sub-layers.
      const detectedRows = parsed.hasText ? parsed.rows ?? [] : [];
      detectedRows.forEach(({ font, weight }) => addUsedFont(font, weight));
      await ensureRowFontsReady(detectedRows);
      console.log(`[strip-text] anchored ${countAnchoredRows(detectedRows, stripAnchors)}/${detectedRows.length} row(s) to measured geometry`);
      const newTextLayers = appendTextRowLayers(doc, detectedRows, { x: vbX, y: vbY, w: vw, h: vh }, undefined, stripAnchors);

      const content = new XMLSerializer().serializeToString(doc.documentElement);
      // Same as the customise pass: a no-op for what this run took (hidden, not gone),
      // still the catch for a row left undrawable some other way.
      const kept = pruneMissingLayers(doc, activeSvg.layers);
      setActiveSvg((prev) => {
        if (!prev) return null;
        return { ...prev, content, layers: [...kept, ...newTextLayers] };
      });
      registerRemoved(stripHidden);
      dropSelectionOutside(kept, newTextLayers);
      if (newTextLayers.length > 0) setSelectedLayer(newTextLayers[0].id);

    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI action failed');
    } finally {
      setAiLoading(false);
      setAiStatusMsg('Thinking…');
    }
  }, [activeSvg, selectedLayer, addGoogleFont, snapshotForUndo]);

  // ── Reset ──────────────────────────────────────────────────────────────────

  // Reset is confirmed through the editor's own overlay (see ConfirmModal), never a
  // native window.confirm.
  const requestReset = useCallback(() => {
    if (!activeSvg) return;
    setResetConfirmOpen(true);
  }, [activeSvg]);

  const confirmReset = useCallback(() => {
    setResetConfirmOpen(false);
    if (!activeSvg) return;
    const { content, layers } = parseSvg(activeSvg.originalContent);
    setActiveSvg((prev) => (prev ? { ...prev, content, layers } : null));
    setHiddenLayers(new Set(defaultHiddenLayers));
    setSelectedLayer(null); setSelectedLayers(new Set());
    // The revert undoes the customise pass, so the pill has to go back to being
    // runnable — it disables itself once done, and would otherwise stay stuck on
    // "Customised" over artwork that no longer carries any of its output. The font
    // suggestions went with that run, so they go too.
    setCustomiseDone(false);
    setCustomiseFonts([]);
  }, [activeSvg, defaultHiddenLayers]);

  const cancelReset = useCallback(() => setResetConfirmOpen(false), []);

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => revokePrev(activeSvg), []);

  useEffect(() => {
    textEditSnappedRef.current = false;
    setAiError(null); setFontSuggestion(null); setSuggestedFontName(null);
    setShowRemoveTextInput(false); setRemoveTextQuery(''); setTextCheckResult(null);
    colorEditRef.current = null;
  }, [selectedLayer]);

  useEffect(() => {
    setImageFonts(null);
    setShowImageFonts(false);
    setSelectedImageFont(null);
    setCustomiseFonts([]);
    // Fonts offered for the last artwork say nothing about this one, and left in place
    // they accumulate: the dropdown grew every AI font from every image opened since the
    // tab loaded. The <link> tags stay — a loaded webface costs nothing and may be needed
    // again — but nothing is listed until this artwork's own pass proposes it.
    setUsedFonts([]);
    setExtraFonts([]);
    setTaxonomy(null);
    setTaxonomyLoading(false);
    setTaxonomyOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSvg?.src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  useEffect(() => {
    if (!selectedLayers.size) return;
    const onArrow = (e: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
      const dy = e.key === 'ArrowDown'  ? step : e.key === 'ArrowUp'   ? -step : 0;
      flashRepositioning();
      setActiveSvg((prev) => {
        if (!prev) return null;
        const doc = new DOMParser().parseFromString(prev.content, 'image/svg+xml');
        [...selectedLayers].forEach((id) => {
          const el = doc.getElementById(id);
          if (!el) return;
          el.setAttribute('transform', applyTranslateDelta(el.getAttribute('transform') ?? '', dx, dy));
        });
        return { ...prev, content: new XMLSerializer().serializeToString(doc.documentElement) };
      });
    };
    window.addEventListener('keydown', onArrow);
    return () => window.removeEventListener('keydown', onArrow);
  }, [selectedLayers, flashRepositioning]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Duplicate a layer: deep-clone it, give the clone fresh ids, nudge it so it's visibly
  // offset, insert it just above the original in paint order, and select it.
  const duplicateLayer = useCallback((layerId: string) => {
    if (!activeSvg) return;
    const srcLayer = activeSvg.layers.find((l) => l.id === layerId);
    if (!srcLayer) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const el = doc.getElementById(layerId);
    if (!el) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const clone = el.cloneNode(true) as Element;
    const newId = `_layer_copy_${Date.now()}`;
    remapClonedIds(clone, newId, layerId);
    clone.setAttribute('transform', applyTranslateDelta(clone.getAttribute('transform') ?? '', 12, 12));
    el.parentNode?.insertBefore(clone, el.nextSibling);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    const newLayer: SvgLayer = { id: newId, label: `${srcLayer.label} copy` };
    setActiveSvg((prev) => {
      if (!prev) return null;
      const idx = prev.layers.findIndex((l) => l.id === layerId);
      const layers = [...prev.layers];
      layers.splice(idx < 0 ? layers.length : idx + 1, 0, newLayer);
      return { ...prev, content, layers };
    });
    setSelectedLayer(newId);
    setSelectedLayers(new Set([newId]));
  }, [activeSvg, snapshotForUndo]);

  // Duplicate several layers at once: every selected element is cloned into ONE new <g>,
  // which becomes a single new layer row. That is what a shift-selection paste should
  // give — the pieces stay together, so they drag, rotate and scale as one thing, and the
  // panel gains one row rather than N rows the user has to re-select to move again.
  //
  // The group is appended at the end of the root <svg>: with the sources sitting anywhere
  // in the tree there is no single position that means "just above the originals", so it
  // goes on top of everything. Hoisting to the root would otherwise strip the wrappers
  // each source was drawn under, so every clone is re-wrapped in copies of its own
  // ancestor chain and lands exactly on its original, before the group's nudge.
  const duplicateLayersAsGroup = useCallback((layerIds: string[]) => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const root = doc.documentElement;
    const found = layerIds
      .map((id) => ({ id, el: doc.getElementById(id) as Element | null }))
      .filter((e): e is { id: string; el: Element } => !!e.el);
    // Ids that went stale between copy and paste — a layer deleted in between, say — just
    // drop out. With one element left there is nothing to nest, so it is a plain duplicate.
    if (found.length < 2) {
      if (found.length === 1) duplicateLayer(found[0].id);
      return;
    }
    // Paint order, not selection order: the clones have to stack the way the originals do,
    // and the selection is built in whatever order the rows were shift-clicked.
    found.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const groupId = `_layer_copy_${Date.now()}`;
    const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('id', groupId);
    group.setAttribute('transform', 'translate(12, 12)');
    found.forEach(({ id, el }, i) => {
      const clone = el.cloneNode(true) as Element;
      // A namespace per clone, so two copies of the same sublayer can't collide.
      remapClonedIds(clone, `${groupId}__${i}`, id);
      group.appendChild(wrapInAncestorChain(clone, ancestorChain(el, root)));
    });
    root.appendChild(group);

    const content = new XMLSerializer().serializeToString(root);
    const firstLabel = activeSvg.layers.find((l) => l.id === found[0].id)?.label ?? 'Layer';
    const newLayer: SvgLayer = { id: groupId, label: `${firstLabel} +${found.length - 1} copy` };
    console.log(`[layers] pasted ${found.length} layers as group ${groupId}`);
    // Last in document order is topmost, which is where the group was appended.
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: [...prev.layers, newLayer] } : null));
    selectOne(groupId);
  }, [activeSvg, duplicateLayer, snapshotForUndo, selectOne]);

  // Open a layer into its parts: the row is replaced by one row per visual child, in
  // document order. Files often deliver a whole logo as a single group, which leaves one
  // row standing for a dozen separable pieces; this drills into it on demand rather than
  // guessing at load, so a layer list that already suits an asset is never disturbed.
  //
  // The DOM is not restructured — the children stay inside their parent, so transforms,
  // classes and inherited paint go on applying. Only the layer list changes, which is
  // also why this is one-way: undo puts the single row back.
  const expandLayer = useCallback((layerId: string) => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const el = doc.getElementById(layerId);
    if (!canExpandLayer(el)) return;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    // Through any single-child wrappers, so opening a wrapped group lands on the level
    // that actually has alternatives rather than on another identical row.
    const kids = expansionTarget(el);
    const stamp = Date.now();
    // What an AI pass took, keyed by element, so opening the layer it came out of names
    // it rather than falling through to "g 8". These rows are the way hidden artwork is
    // switched back on, and a positional label gives no way to tell which is which — on
    // a diagram of eight stacked labels, eight rows reading "g 1".."g 8" are unusable.
    const removedByEl = new Map(removedRecordsRef.current.map((r) => [r.id, r]));
    const newLayers: SvgLayer[] = kids.map((kid, i) => {
      if (!kid.id) kid.id = `_sub_${stamp}_${i}`;
      const claimedBy = removedByEl.get(kid.id)?.claimedBy;
      const label =
        kid.getAttribute('data-name')?.trim() ||
        (claimedBy ? `${claimedBy} (original)` : null) ||
        (!isSyntheticLayerId(kid.id) ? kid.id : null) ||
        `${kid.tagName.toLowerCase().replace(/.*:/, '')} ${i + 1}`;
      return { id: kid.id, label };
    });

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    console.log(`[layers] expanded ${layerId} into ${newLayers.length} sublayers`);
    setExpandDepth((d) => d + 1);
    setActiveSvg((prev) => {
      if (!prev) return null;
      const idx = prev.layers.findIndex((l) => l.id === layerId);
      const layers = [...prev.layers];
      layers.splice(idx < 0 ? layers.length : idx, idx < 0 ? 0 : 1, ...newLayers);
      return { ...prev, content, layers };
    });
    // The expanded layer no longer exists as a row, so selecting it would dangle.
    selectOne(null);
  }, [activeSvg, snapshotForUndo, selectOne]);

  // The way back out of a group that was drilled into: fold this row and every sibling
  // row taken from the same group back into one row for the group itself. The inverse of
  // expandLayer, and equally a layer-list-only change — the elements never moved, so
  // there is nothing to put back.
  //
  // It steps out one level at a time, so repeatedly backing out walks up the wrappers.
  // That can land on the single wrapper an asset started as; expanding again reopens it.
  const collapseLayer = useCallback((layerId: string) => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    const parent = collapsibleParent(doc.getElementById(layerId), layerIds);
    if (!parent) return;

    // Everything currently listed that lives inside this group folds away together —
    // leaving some of its children as rows and not others would be a half-open group.
    const absorbed = activeSvg.layers.filter((l) => {
      const el = doc.getElementById(l.id);
      return !!el && parent.contains(el);
    });
    if (!absorbed.length) return;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    if (!parent.id) parent.id = `_grp_${Date.now()}`;

    // Ids this app generated are plumbing, not names — showing one turns "Layer 3" into
    // "_layer_2" on the way back out. Fall back to the same positional naming parseSvg
    // uses, which restores the name the row had before it was opened.
    const firstIdx = activeSvg.layers.findIndex((l) => l.id === absorbed[0].id);
    const synthetic = isSyntheticLayerId(parent.id);
    const label =
      parent.getAttribute('data-name')?.trim() ||
      parent.getAttribute('inkscape:label')?.trim() ||
      (!synthetic ? parent.id : null) ||
      `Layer ${(firstIdx < 0 ? activeSvg.layers.length : firstIdx) + 1}`;

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    const absorbedIds = new Set(absorbed.map((l) => l.id));

    console.log(`[layers] collapsed ${absorbed.length} row(s) into ${parent.id}`);
    // Back up one level. Floored at zero so a collapse reached some other way — a row
    // deleted out from under the list, say — cannot drive it negative and re-offer
    // back-out at the root.
    setExpandDepth((d) => Math.max(0, d - 1));
    setActiveSvg((prev) => {
      if (!prev) return null;
      const first = prev.layers.findIndex((l) => absorbedIds.has(l.id));
      const layers = prev.layers.filter((l) => !absorbedIds.has(l.id));
      layers.splice(first < 0 ? layers.length : first, 0, { id: parent.id, label });
      return { ...prev, content, layers };
    });
    selectOne(parent.id);
  }, [activeSvg, snapshotForUndo, selectOne]);

  // Delete a layer (removes its element and its layers-list entry). Undoable.
  const deleteLayer = useCallback((layerId: string) => {
    if (!activeSvg) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    doc.getElementById(layerId)?.remove();
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: prev.layers.filter((l) => l.id !== layerId) } : null));
    setSelectedLayer((cur) => (cur === layerId ? null : cur));
    setSelectedLayers((prev) => {
      if (!prev.has(layerId)) return prev;
      const next = new Set(prev); next.delete(layerId); return next;
    });
  }, [activeSvg, snapshotForUndo]);

  // Ctrl/Cmd+C copies the selection; Ctrl/Cmd+V pastes it as a duplicate. A shift-built
  // selection of several layers pastes as one nested group — see duplicateLayersAsGroup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        if (selectionIds.length) layerClipboardRef.current = selectionIds;
      } else if (key === 'v') {
        const ids = layerClipboardRef.current;
        if (!ids.length) return;
        e.preventDefault();
        if (ids.length > 1) duplicateLayersAsGroup(ids); else duplicateLayer(ids[0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectionIds, duplicateLayer, duplicateLayersAsGroup]);

  // ── File drag handlers (drop zone) ─────────────────────────────────────────

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragCounter(0); setIsDragging(false);
    // A preview dragged out of the left column carries its identity on a custom MIME
    // type (set in SamplesSidebar) — open it like a click. Falls through to OS file
    // drops, which instead arrive as dataTransfer.files.
    const sampleJson = e.dataTransfer.getData(SAMPLE_DRAG_MIME);
    if (sampleJson) {
      try {
        openSample(JSON.parse(sampleJson) as { label: string; name: string; src: string });
        return;
      } catch { /* malformed payload — ignore and try a file drop */ }
    }
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  }, [openFile, openSample]);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragCounter((c) => { if (c === 0) setIsDragging(true); return c + 1; });
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragCounter((c) => { const n = c - 1; if (n === 0) setIsDragging(false); return n; });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  // Belt-and-braces: stop the browser's default "open the dropped file as a page"
  // behaviour for any drop that lands outside React's tree (e.g. a fast release the
  // root handler misses). Without this, such a drop navigates away and unloads the app.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const showCanvas = activeSvg || isLoading;
  // Dirty = the document changed, or visibility differs from how it opened. Compared
  // against the default hidden set so the canvas starting hidden isn't itself an edit.
  const visibilityChanged =
    hiddenLayers.size !== defaultHiddenLayers.size ||
    [...hiddenLayers].some((id) => !defaultHiddenLayers.has(id));
  const isDirty = !!activeSvg && (visibilityChanged || activeSvg.content !== activeSvg.originalContent);
  const selectionIsBackground = !!selectedLayer && selectedLayer === backgroundLayerId;

  // The AI panel's "Use this font": applies to the selected text layer if there is one,
  // otherwise it becomes the default for the next text layer added.
  const useSuggestedFont = (font: string) =>
    selectedTextProps ? updateTextLayer({ font }) : setTextForm((f) => ({ ...f, font }));

  return (
    /* Full-bleed canvas with floating panels (handoff §1) — no docked columns, so the
       artwork stays the focus.
       Drag handlers live on the ROOT so the entire viewport is a drop target. A real
       Finder drag can enter over any panel; if the region under the drag doesn't
       preventDefault on dragover, the browser navigates to the file instead of dropping
       it, which reads as "drag-to-open is broken". A window-level preventDefault (see
       effect above) is the belt-and-braces backstop. */
    <div
      style={{
        position: 'relative',
        height: '100vh',
        overflow: 'hidden',
        background: C.appBg,
        color: C.textPrimary,
        fontFamily: FONT_STACK,
        WebkitFontSmoothing: 'antialiased',
      }}
      onDrop={handleDrop}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
    >
      {/* Hover/focus/scrollbar states inline styles can't express — see design-tokens.ts */}
      <style>{EDITOR_CSS}</style>

      {isDragging && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 40, pointerEvents: 'none',
            background: 'rgba(91,108,255,.08)', border: `2px solid ${C.accent}`,
          }}
        />
      )}

      {/* Modal overlays (memoised) — see editor-modals.tsx */}
      <UpsellModal open={showUpsell} onClose={closeUpsell} />
      <CooldownModal open={showCooldown} available={cooldownUntil} onClose={closeCooldown} />
      <RatingModal
        open={ratingOpen}
        rating={rating}
        hover={ratingHover}
        onHover={setRatingHover}
        onRate={setRating}
        onCancel={cancelRating}
        onSubmit={submitRating}
        onAbort={openAbortReason}
      />
      <AbortReasonModal
        open={abortReasonOpen}
        reasons={ABORT_REASONS}
        selected={abortReasons}
        note={abortNote}
        onToggle={toggleAbortReason}
        onNote={setAbortNote}
        onBack={closeAbortReason}
        onConfirm={confirmAbort}
      />
      <ConfirmModal
        open={resetConfirmOpen}
        title="Revert all changes?"
        body="This restores the file as it was imported. Everything you've edited since — including hidden layers — is discarded."
        confirmLabel="Revert changes"
        danger
        onCancel={cancelReset}
        onConfirm={confirmReset}
      />

      {showCanvas ? (
        <>
          {/* Canvas — absolutely fills the root, behind every panel */}
          <CanvasStage
            svgCanvasRef={svgCanvasRef}
            overlayRef={overlayRef}
            sizeBadgeRef={sizeBadgeRef}
            onCanvasClick={handleCanvasClick}
            onCanvasMouseDown={handleCanvasMouseDown}
            aiLoading={aiLoading}
            aiStatusMsg={aiStatusMsg}
            isLoading={isLoading}
            activeSvg={activeSvg}
            hiddenLayers={hiddenLayers}
            previewIds={previewIds}
            previewOutlineId={previewRemovedId}
            backgroundLayerId={backgroundLayerId}
            showSelectionOverlay={showSelectionOverlay}
            selectionIsEmptyText={selectionIsEmptyText}
            onEmptyTextClick={focusEmptyTextInput}
            onDragHandleMouseDown={handleDragHandleMouseDown}
            onRotateHandleMouseDown={handleRotateHandleMouseDown}
            onScaleHandleMouseDown={handleScaleHandleMouseDown}
          />

          {/* Top toolbar (§1.5) */}
          <EditorToolbar
            fileName={isLoading && !activeSvg ? 'Loading…' : (activeSvg?.name ?? '')}
            isDirty={isDirty}
            onCenter={centerLayersToCanvas}
            onRotate90={rotateSelected90}
            transformDisabled={!selectedLayers.size || selectionIsBackground}
            onMatchRotation={matchRotationToSelected}
            matchRotationDisabled={selectedLayers.size !== 1 || selectionIsBackground}
            undoCount={undoCount}
            onUndo={undo}
            redoCount={redoCount}
            onRedo={redo}
            exportLabel={activeSvg && hiddenRowCount > 0
              ? `Export (${activeSvg.layers.length - hiddenRowCount}/${activeSvg.layers.length})`
              : 'Export'}
            onExport={openRating}
            onClose={clear}
            onReset={requestReset}
          />

          {/* Font suggestions strip (memoised) — see editor-font-suggestions.tsx */}
          <FontSuggestions
            open={showImageFonts}
            onClose={closeImageFonts}
            loading={imageFontsLoading}
            fonts={imageFonts}
            selectedFont={selectedImageFont}
            onSelectFont={onSelectImageFont}
            onAddFont={addGoogleFont}
          />

          {activeSvg && (
            <>
              {/* Inspector (§1.6) */}
              <EditorInspector
                selectedLayer={selectedLayer}
                isBackground={selectionIsBackground}
                selectedTextProps={selectedTextProps}
                textContentRef={textContentRef}
                usedFonts={usedFonts}
                extraFonts={suggestedFonts}
                layerColors={layerColors}
                onUpdateTextLayer={updateTextLayer}
                onReplaceColor={replaceLayerColor}
                onEndColorEdit={endColorEdit}
                onClose={() => selectOne(null)}
              />

              {/* Elements (§1.7) */}
              <LayersPanel
                layers={activeSvg.layers}
                hiddenLayers={hiddenLayers}
                selectedLayers={selectedLayers}
                backgroundLayerId={backgroundLayerId}
                textLayerIds={textLayerIds}
                expandableLayerIds={expandableLayerIds}
                hiddenInsideCounts={hiddenInsideCounts}
                onExpandLayer={expandLayer}
                canBackOut={!!backOutLayerId}
                onBackOut={() => backOutLayerId && collapseLayer(backOutLayerId)}
                onAddTextLayer={addTextLayer}
                onReorderLayers={reorderLayers}
                onSetSelectedLayers={setSelectedLayers}
                onSetSelectedLayer={setSelectedLayer}
                onSelectOne={selectOne}
                onToggleLayer={toggleLayer}
                onDuplicateLayer={duplicateLayer}
                onDeleteLayer={deleteLayer}
              />

              {/* AI pill + panel (§1.8). The tools panel is dev-only; in production the
                  pill below is a plain Customise button with nothing behind it. */}
              {SHOW_DEV_UI && (
                <AiPanel
                  open={aiPanelOpen}
                  onClose={closeAiPanel}
                  llmProvider={llmProvider}
                  llmOptions={LLM_OPTIONS}
                  onSelectLlmProvider={selectLlmProvider}
                  ai={{
                    loading: aiLoading, error: aiError,
                    fontSuggestion, suggestedFontName,
                    removeTextQuery, setRemoveTextQuery,
                    showRemoveTextInput, setShowRemoveTextInput,
                    textCheckResult, setTextCheckResult,
                  }}
                  fonts={{
                    extra: extraFonts, imageFonts, imageFontsLoading,
                    customiseFonts, customiseLoading, customiseDone,
                  }}
                  taxonomy={{ data: taxonomy, loading: taxonomyLoading, open: taxonomyOpen, setOpen: setTaxonomyOpen }}
                  selectedLayer={selectedLayer}
                  backgroundLayerId={backgroundLayerId}
                  onRunAiAction={runAiLayerAction as (action?: AiActionType, query?: string) => void}
                  onApplyFontGlobally={applyFontGlobally}
                  onUseSuggestedFont={useSuggestedFont}
                  onRunTaxonomy={runTaxonomyAnalysis}
                />
              )}
              <AiPill
                onCustomise={runCustomise}
                onOpenTools={onAiToolsClick}
                loading={customiseLoading}
                done={customiseDone}
                toolsOpen={aiPanelOpen}
                showTools={SHOW_DEV_UI}
                // can_edit: 0 — the pill stays enabled so the click reaches the upsell.
                gated={activeSvg.edit === 0}
                // Nothing to customise until the artwork is parsed and on the canvas.
                ready={!!activeSvg.content && !isLoading}
                // Customised too recently — the pill stays live and re-opens the
                // cooldown message instead of running the pass.
                cooldown={cooldownActive}
              />
            </>
          )}
        </>
      ) : (
        /* ── Drop zone (empty state) ──────────────────────────────────────── */
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
              padding: '64px 80px', borderRadius: 16,
              border: `2px dashed ${isDragging ? C.accent : C.borderInput}`,
              background: isDragging ? C.accentTintAlt : C.surface,
              boxShadow: SHADOW.board,
              cursor: 'pointer', userSelect: 'none',
              transition: 'border-color .15s, background .15s',
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={40} height={40}
              fill="none" viewBox="0 0 24 24" strokeWidth={1.25}
              stroke={isDragging ? C.accent : C.disabled}
            >
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.338-2.32 5.75 5.75 0 0 1 1.023 9.095"
              />
            </svg>
            <div style={{ textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: isDragging ? C.accent : C.textSecondary }}>
                {isDragging ? 'Release to open' : 'Drop an SVG file'}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: C.textFaint }}>or click to browse</p>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".svg,image/svg+xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) openFile(file);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {/* Dev rail (§1.4) — internal only, sits above every panel */}
      {SHOW_DEV_UI && (
        <DevRail
          samples={SAMPLES}
          activeSample={activeSample}
          isLoading={isLoading}
          open={devRailOpen}
          onSetOpen={setDevRailOpen}
          onOpenSample={openSample}
          onOpenFetched={openSample}
          onOpenReviewUuid={openReviewUuid}
          onReviewListLoaded={onReviewListLoaded}
        />
      )}

      {/* What the AI passes took — internal only. Renders nothing until a pass has run. */}
      {SHOW_DEV_UI && activeSvg && (
        <DevRemovedPanel
          records={removedRecords}
          previewId={previewRemovedId}
          open={removedPanelOpen}
          onSetOpen={setRemovedPanelOpen}
          onPreview={setPreviewRemovedId}
        />
      )}
    </div>
  );
}

