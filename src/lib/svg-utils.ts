import DOMPurify from 'dompurify';

import { t } from '@/i18n';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SvgLayer {
  id: string;
  label: string;
}

export interface ActiveSvg {
  name: string;
  src: string;           // thumbnail / blob URL
  content: string;       // serialized SVG string (layer IDs injected)
  originalContent: string; // content as first parsed — used for reset
  layers: SvgLayer[];    // top-level <g> children, in document order
  objectUrl?: string;
  edit?: 0 | 1;          // 0 = AI features gated behind an upsell; undefined/1 = allowed
}

// ─── SVG processing ───────────────────────────────────────────────────────────

// Imported SVG is rendered through dangerouslySetInnerHTML in editor-canvas.tsx, so this
// is the only thing between an artwork file and script execution on our origin.
//
// It used to be two regexes — strip <script>…</script>, strip on*="…". Both are trivially
// evaded: an unquoted or single-quoted handler (`onload=alert(1)`, `onload='…'`) doesn't
// match the second pattern at all, and neither touches `<a xlink:href="javascript:…">`,
// `<use href="data:…">`, `<foreignObject>` with arbitrary HTML in it, `<animate
// attributeName="href" to="javascript:…">`, or an `<iframe>` smuggled through
// foreignObject. A regex cannot do this job: it is parsing HTML with a pattern, and the
// browser that renders the result parses it very differently.
//
// DOMPurify parses it the way the browser will and rebuilds a document from what it
// allows. Configured for the SVG profile — SVG, SVG filters and MathML, no HTML — which
// also removes foreignObject's escape hatch into arbitrary markup.
//
// The name is kept: every call site means "make this safe to inject", and renaming it
// would churn them to say the same thing.

// <use> is not in DOMPurify's SVG profile, and that omission is deliberate on their part:
// `<use href="https://elsewhere/x.svg#y">` pulls in another document, and `<use
// href="data:…">` injects one, so the element is a genuine injection and SSRF vector.
//
// It cannot simply be left out here, though. Stock vector artwork uses <use> constantly
// to repeat a symbol, and DOMPurify does not neuter it — it deletes the element, so parts
// of the drawing silently vanish with nothing to indicate why. That was measured against
// real files, not assumed.
//
// So it is allowed back with only the safe half: a reference to an id in this same
// document. That is the only form artwork needs and the only one that cannot reach off
// origin. Anything else — an absolute URL, a data: URI, a protocol-relative reference —
// takes the element with it, because a <use> that resolves to nothing renders nothing
// anyway and keeping an inert one would only make the result harder to read.
//
// Registered once, at module scope: DOMPurify hooks live on the instance, so adding one
// per call would stack up a new copy on every import.
let useHookInstalled = false;

const installUseHook = (): void => {
  if (useHookInstalled) return;
  useHookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName?.toLowerCase() !== 'use') return;
    const el = node as unknown as Element;
    // Both spellings: SVG 2 uses `href`, and the great majority of real files still
    // carry SVG 1.1's namespaced `xlink:href`. Reading only one would let the other
    // through unchecked.
    const ref =
      el.getAttribute('href') ??
      el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      el.getAttribute('xlink:href') ??
      '';
    if (!ref.startsWith('#')) el.remove();
  });
};

// `output: "server"` means this module can be evaluated during SSR, where DOMPurify has
// no `window` to bind to and its `sanitize` is a no-op that returns the input unchanged.
// Failing loudly there is better than silently passing artwork through unsanitised — but
// this is only ever reached from a user gesture in the browser, so it should not happen.
export function stripScripts(raw: string): string {
  if (typeof window === 'undefined') {
    throw new Error('stripScripts requires a DOM — it must not run during SSR');
  }
  installUseHook();
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // See the hook above — allowed back, then narrowed to same-document references.
    ADD_TAGS: ['use'],
    // The layer machinery addresses elements by id and rewrites them by id, so ids must
    // survive sanitising verbatim. DOMPurify namespaces them by default to stop one
    // fragment clobbering another's, which would break every layer lookup in this file —
    // and would break <use href="#id"> along with them, since the reference and the id
    // would be rewritten inconsistently.
    SANITIZE_NAMED_PROPS: false,
    // Return the markup, not a DOM node — callers hold SVG as a string throughout.
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    // foreignObject is the one SVG element that reintroduces arbitrary HTML, and no
    // artwork this editor handles uses it.
    FORBID_TAGS: ['foreignObject'],
  });
}

// Tags that are metadata/definitions, not visual layers
export const SKIP_TAGS = new Set([
  'defs', 'style', 'title', 'desc', 'metadata',
  'lineargradient', 'radialgradient', 'pattern',
  'clippath', 'mask', 'filter', 'marker',
]);

// Visual children of an element, in document order.
export const layerChildren = (el: Element): Element[] =>
  Array.from(el.children).filter((c) => !SKIP_TAGS.has(c.tagName.toLowerCase()));

// The rows a layer should open into: its visual children, but seen THROUGH any chain of
// single-child wrapper groups.
//
// Stopping at the first level was right about the symptom and wrong about the cure —
// opening a one-child group does swap a row for an identical-looking row, so it was
// refused outright. But a `<g>` wrapping a `<g>` of twelve paths is then a dead end you
// can never open, even though one level down is exactly the list you want. Descending
// costs nothing and lands on the first level that actually has something to choose
// between. Same reasoning as expandWrappedLayers above, which already unwraps degenerate
// wrappers when the top-level layer list would otherwise be useless.
//
// A wrapper around a single LEAF is still not expandable: descending reaches a childless
// element, so this returns nothing and the caller correctly refuses.
const MAX_WRAPPER_DEPTH = 16; // guard against a pathological or cyclic document
export function expansionTarget(el: Element | null): Element[] {
  let cur = el;
  for (let depth = 0; cur && depth < MAX_WRAPPER_DEPTH; depth++) {
    const kids = layerChildren(cur);
    if (kids.length !== 1) return kids;
    cur = kids[0];
  }
  return [];
}

// Whether a layer can usefully be opened into sublayers: somewhere at or below it there
// has to be a level holding more than one visual child.
export const canExpandLayer = (el: Element | null): boolean =>
  expansionTarget(el).length > 1;

// The group a layer sits inside and could be folded back into — the way out of a group
// that was drilled into. Null at the top of the document, and null when the parent is
// itself a layer, since that parent is already its own row and folding into it would
// produce two rows for the same element.
export function collapsibleParent(el: Element | null, layerIds: Set<string>): Element | null {
  const parent = el?.parentElement ?? null;
  if (!parent || parent.tagName.toLowerCase() === 'svg') return null;
  if (parent.id && layerIds.has(parent.id)) return null;
  return parent;
}

// Some files wrap the whole drawing in a single <g>, occasionally several deep. Taking
// only the SVG's direct children then yields ONE layer, which spans the canvas by
// definition, so it is classified as the background and nothing in the artwork can be
// selected, moved or recoloured — the elements panel just reads "Canvas".
//
// So when the top level is that degenerate, keep opening the group that holds the most
// content until the list stops being useless. Opening a single-child wrapper costs
// nothing (the count is unchanged, so the loop simply continues inward); opening a real
// group ends it. The threshold is on the RESULTING count rather than on a group's own
// child count — a wrapper chain of 2-child groups would otherwise unwrap forever.
//
// Nothing is restructured: this only chooses which existing elements the layer list
// points at, so wrapper classes, transforms and inherited styles keep applying exactly
// as before.
const EXPAND_WHILE_AT_MOST = 4;

function expandWrappedLayers(roots: Element[]): Element[] {
  let level = roots;
  for (let guard = 0; guard < 16 && level.length <= EXPAND_WHILE_AT_MOST; guard++) {
    let biggest: Element | null = null;
    let biggestSize = 0;
    for (const el of level) {
      if (el.tagName.toLowerCase().replace(/.*:/, '') !== 'g') continue;
      if (layerChildren(el).length === 0) continue;
      const size = el.getElementsByTagName('*').length;
      if (size > biggestSize) { biggest = el; biggestSize = size; }
    }
    if (!biggest) break;
    const opened = biggest;
    const kids = layerChildren(opened);
    level = level.flatMap((el) => (el === opened ? kids : [el]));
  }
  return level;
}

export function parseSvg(raw: string): { content: string; layers: SvgLayer[] } {
  try {
    const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return { content: raw, layers: [] };

    const svg = doc.documentElement;
    const layers: SvgLayer[] = [];

    // Only rescue the degenerate case. A file that already offers more than one layer is
    // left exactly as it is — re-splitting artwork that currently works would be a
    // regression, not a fix.
    let roots = layerChildren(svg);
    if (roots.length <= 1) roots = expandWrappedLayers(roots);

    roots.forEach((child, i) => {
      if (!child.id) child.id = `_layer_${i}`;

      const label =
        child.getAttribute('data-name')?.trim() ||
        child.getAttribute('inkscape:label')?.trim() ||
        (!isSyntheticLayerId(child.id) ? child.id : null) ||
        // The only string this module invents. Everything above it comes out of the file
        // and is left exactly as the author wrote it — a layer called "Hintergrund" stays
        // that in an English UI, and an English one stays English in a German UI.
        t('layers.numberedLabel', { index: layers.length + 1 });

      layers.push({ id: child.id, label });
    });

    // Serialize the SVG element only (no XML declaration)
    const content = new XMLSerializer().serializeToString(svg);
    return { content, layers };
  } catch {
    return { content: raw, layers: [] };
  }
}

// Ids this app generated are plumbing, not names. Showing one turns a layer row into
// "_layer_2" or "_hidden_1785900720076_3" instead of something you can recognise, so
// every place that derives a label from an element has to be able to tell them apart.
//
// One predicate rather than a check per call site, because they drifted: the three that
// existed tested different prefixes, and adding `_hidden_` ids — which now stay in the
// document because the AI passes hide rather than delete — meant a group opened into its
// parts listed eight raw ids. The prefixes are the ones minted by parseSvg (`_layer_`),
// expandLayer (`_sub_`), collapseLayer (`_grp_`), appendTextRowLayers (`_text_`),
// hideRemovedElements (`_hidden_`) and duplicateLayer (`_layer_copy_`).
export const isSyntheticLayerId = (id: string | null | undefined): boolean =>
  !!id && /^_(layer|sub|grp|text|hidden|layer_copy)_/.test(id);

// Returns the element's bounding box in SVG root coordinate space,
// correctly accounting for the element's own transform attribute.
export function bboxInRootSpace(
  svgEl: SVGSVGElement,
  el: SVGGraphicsElement,
  // The element's box in its OWN coordinate space. Defaults to its geometric bbox;
  // callers override it to map a box they derived themselves (an ink box narrowed from
  // the line box getBBox reports for <text>) through the same transform chain.
  localBox?: DOMRect,
): DOMRect | null {
  try {
    const local = localBox ?? el.getBBox();
    const m = svgEl.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!);
    const corners = [
      [local.x,               local.y],
      [local.x + local.width, local.y],
      [local.x + local.width, local.y + local.height],
      [local.x,               local.y + local.height],
    ].map(([x, y]) => {
      const pt = svgEl.createSVGPoint();
      pt.x = x; pt.y = y;
      return pt.matrixTransform(m);
    });
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return new DOMRect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
  } catch {
    return null;
  }
}

export function applyTranslateDelta(existing: string, dx: number, dy: number): string {
  const m = existing.match(/^translate\(\s*([-\d.]+)(?:[,\s]+([-\d.]+))?\s*\)/);
  if (m) {
    const x = parseFloat(m[1]) + dx;
    const y = parseFloat(m[2] ?? '0') + dy;
    return `translate(${x}, ${y})${existing.slice(m[0].length)}`;
  }
  return `translate(${dx}, ${dy}) ${existing}`.trim();
}

// Arc path for curved text: an arc exactly as long as the text that rides it, centred
// on cy, bending by however much the curve slider asks for.
//
// The arc is built from the TEXT, not from the canvas. `textLen` — the advance width of
// the rendered string — becomes the arc's length, and `curve` sets how far that length
// is wrapped: ±100 bends it through a half-circle, 0 leaves it straight. So the text
// always fills its own arc, whatever its length, font or size.
//
//   alpha = |curve|/100 · π/2     half-angle: how much of a semicircle to wrap
//   r     = L / 2alpha            radius that gives an arc of length L at that angle
//   halfW = r·sin alpha           resulting chord half-width
//   h     = r·(1 − cos alpha)     sagitta — how deep the bend is
//
// This replaces a fixed `halfW = 0.35·vbW`, under which the arc had the same size for
// every string: short text barely bent while long text overflowed the path and its
// glyphs fell off the end.
//
// Placing it: sweep=1 draws clockwise in SVG's y-down frame, and clockwise from the left
// chord endpoint runs 9 → 12 → 3 o'clock — over the top. So curve>0 is the ARCH (∩,
// bulging above its chord) and curve<0 the bowl (∪), and the chord goes on the far side
// of cy from the bulge. Offsetting it by h/2 leaves the arc spanning [cy−h/2, cy+h/2] —
// centred on cy, so bending the text does not move it up or down the canvas.
//
// How much longer than the text the path is built. Big enough to absorb the gap between
// an off-screen measurement and the live render, small enough not to loosen the curve.
const ARC_SLACK = 0.08;

// `fallbackLen` stands in when the text cannot be measured (empty string, no live DOM).
export function computeArcPath(
  cx: number, cy: number, curve: number, textLen: number, fallbackLen: number,
): string {
  const L = textLen > 0 ? textLen : Math.max(1, fallbackLen);

  // Build the path a little longer than the text rather than to an exact fit. The length
  // is measured off-screen and the artwork is drawn live, and the two need not agree to
  // the unit — webfont substitution, hinting and rounding all move it. Fit the arc
  // exactly and any shortfall pushes glyphs off the ends of the path, where they simply
  // are not drawn; because the run is centred, that eats the first AND last characters.
  // Slack is invisible (the text just stops short of the ends) and can only fail safe.
  const arcLen = L * (1 + ARC_SLACK);

  const alpha = (Math.min(100, Math.abs(curve)) / 100) * (Math.PI / 2);
  const r = arcLen / (2 * alpha);
  const halfW = r * Math.sin(alpha);
  const h = r * (1 - Math.cos(alpha));

  // The text now covers only part of the arc, so centre it on what it actually covers.
  const s = r * (1 - Math.cos(Math.min(L, arcLen) / (2 * r)));
  const sweep = curve > 0 ? 1 : 0;
  const chordY = curve > 0 ? cy + h - s / 2 : cy - h + s / 2;
  // alpha never exceeds π/2, so the arc is never more than a semicircle: large-arc is 0.
  return `M ${cx - halfW} ${chordY} A ${r} ${r} 0 0 ${sweep} ${cx + halfW} ${chordY}`;
}

export function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase();
  if (!c || c === 'none' || c === 'transparent' || c === 'inherit' || c === 'currentcolor') return c;
  if (c.startsWith('url(')) return c;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    return ctx.fillStyle; // '#rrggbb' or 'rgba(r, g, b, a)'
  } catch {
    return c;
  }
}

export const COLOR_PAINT_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color'];

// Returns the gradient element that actually owns <stop> children, following xlink:href / href chains.
export function resolveGradient(id: string, doc: Document): Element | null {
  const el = doc.getElementById(id);
  if (!el) return null;
  const href = el.getAttribute('xlink:href') ?? el.getAttribute('href') ?? '';
  if (href.startsWith('#')) return doc.getElementById(href.slice(1)) ?? el;
  return el;
}

// Collects IDs of all gradients (linearGradient / radialGradient) referenced by a layer via
// direct fill/stroke attrs, inline styles, and CSS class rules.
export function collectLayerGradientIds(layerEl: Element, layerClasses: Set<string>, doc: Document): Set<string> {
  const ids = new Set<string>();
  const addRef = (val: string) => {
    const m = val.trim().match(/^url\(#(.+)\)$/);
    if (m) ids.add(m[1]);
  };
  [layerEl, ...Array.from(layerEl.querySelectorAll('*'))].forEach((el) => {
    ['fill', 'stroke'].forEach((a) => { const v = el.getAttribute(a); if (v) addRef(v); });
    const style = el.getAttribute('style') ?? '';
    for (const m of style.matchAll(/(fill|stroke)\s*:\s*(url\(#[^)]+\))/gi)) addRef(m[2]);
  });
  doc.querySelectorAll('style').forEach((styleEl) => {
    const css = styleEl.textContent ?? '';
    for (const rm of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const used = rm[1].split(',').some((s) => [...layerClasses].some((cls) => s.includes(`.${cls}`)));
      if (!used) continue;
      for (const dm of rm[2].matchAll(/(fill|stroke)\s*:\s*(url\(#[^)]+\))/gi)) addRef(dm[2]);
    }
  });
  return ids;
}

// Elements that actually paint something, as opposed to grouping/among defs.
export const PAINTABLE_TAGS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan', 'use',
]);

// class → declared fill, read once per document from its <style> blocks.
const cssFillCache = new WeakMap<Document, Map<string, string>>();

function cssFillByClass(doc: Document): Map<string, string> {
  const cached = cssFillCache.get(doc);
  if (cached) return cached;
  const map = new Map<string, string>();
  doc.querySelectorAll('style').forEach((styleEl) => {
    for (const m of (styleEl.textContent ?? '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const fill = [...m[2].matchAll(/(?:^|;)\s*fill\s*:\s*([^;{}]+)/gi)].pop()?.[1]?.trim();
      if (!fill) continue;
      for (const sel of m[1].split(',')) {
        const cls = sel.trim().match(/^\.([\w-]+)$/)?.[1];
        if (cls) map.set(cls, fill);
      }
    }
  });
  cssFillCache.set(doc, map);
  return map;
}

// The fill an element actually renders with, resolved the way the renderer does it:
// the element's own attribute / inline style / class rule, then inherited from its
// ancestors, and failing all of that SVG's initial value — black.
//
// Without this, a shape that never declares a fill reports no colour at all, so it can't
// be listed or recoloured even though it is plainly painted on the canvas. Inheritance
// matters more now that a layer root can sit inside wrapper groups, since the declaration
// may live on an ancestor above the layer.
// Whether the element sets its own fill, by attribute, inline style or class rule. False
// means it is painting with an inherited or default colour, which is the case
// effectiveFill exists to resolve — and the case a recolour has to write rather than
// rewrite. Shared so detection and replacement can't drift apart.
export function declaresOwnFill(el: Element, doc: Document): boolean {
  if (el.getAttribute('fill')) return true;
  if (/(?:^|;)\s*fill\s*:/i.test(el.getAttribute('style') ?? '')) return true;
  const byClass = cssFillByClass(doc);
  return (el.getAttribute('class')?.split(/\s+/) ?? []).some((c) => !!c && byClass.has(c));
}

export function effectiveFill(el: Element, doc: Document): string | null {
  const byClass = cssFillByClass(doc);
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    const own = node.getAttribute('fill');
    if (own) return own;
    const inline = node.getAttribute('style')?.match(/(?:^|;)\s*fill\s*:\s*([^;{}]+)/i)?.[1]?.trim();
    if (inline) return inline;
    for (const cls of node.getAttribute('class')?.split(/\s+/) ?? []) {
      const fromCss = cls && byClass.get(cls);
      if (fromCss) return fromCss;
    }
    if (node.tagName.toLowerCase() === 'svg') break;
    node = node.parentElement;
  }
  return '#000000';   // SVG's initial fill
}

export function extractLayerColors(layerEl: Element, doc: Document): string[] {
  const seen = new Set<string>();

  const addColor = (raw: string) => {
    const n = normalizeColor(raw);
    if (n && n !== 'none' && n !== 'transparent' && n !== 'inherit' && n !== 'currentcolor' && !n.startsWith('url(')) {
      seen.add(n);
    }
  };

  // Direct attributes + inline styles on every element in the layer
  [layerEl, ...Array.from(layerEl.querySelectorAll('*'))].forEach((el) => {
    COLOR_PAINT_ATTRS.forEach((attr) => {
      const v = el.getAttribute(attr);
      if (v) addColor(v);
    });
    const style = el.getAttribute('style');
    if (style) {
      for (const m of style.matchAll(/(fill|stroke|stop-color|flood-color|lighting-color)\s*:\s*([^;{}]+)/gi)) {
        addColor(m[2].trim());
      }
    }
  });

  // CSS class rules whose selectors reference a class used in the layer
  const layerClasses = new Set<string>();
  [layerEl, ...Array.from(layerEl.querySelectorAll('[class]'))].forEach((el) => {
    el.getAttribute('class')?.split(/\s+/).forEach((c) => c && layerClasses.add(c));
  });

  doc.querySelectorAll('style').forEach((styleEl) => {
    const css = styleEl.textContent ?? '';
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1];
      const declarations = m[2];
      const used = selector.split(',').some((s) => [...layerClasses].some((cls) => s.includes(`.${cls}`)));
      if (!used) continue;
      for (const dm of declarations.matchAll(/(fill|stroke|stop-color|flood-color|lighting-color)\s*:\s*([^;{}]+)/gi)) {
        addColor(dm[2].trim());
      }
    }
  });

  // Extract stop colors from any gradients referenced by the layer
  collectLayerGradientIds(layerEl, layerClasses, doc).forEach((id) => {
    const source = resolveGradient(id, doc);
    source?.querySelectorAll('stop').forEach((stop) => {
      const sc = stop.getAttribute('stop-color');
      if (sc) addColor(sc);
    });
  });

  // Shapes that declare no fill anywhere still paint — inherited, or SVG's default black.
  // Resolve those too, so a layer whose artwork simply never sets a fill (label text and
  // leader lines, typically) offers its colour instead of reporting none at all.
  [layerEl, ...Array.from(layerEl.querySelectorAll('*'))].forEach((el) => {
    const tag = el.tagName.toLowerCase().replace(/.*:/, '');
    if (!PAINTABLE_TAGS.has(tag) || declaresOwnFill(el, doc)) return;
    const fill = effectiveFill(el, doc);
    if (fill) addColor(fill);
  });

  return [...seen];
}

export type TaxonomyGroup = { type: string; elements: string[] };

export type SelectedTextProps = {
  content: string;
  font: string;
  size: number;
  weight: number;
  color: string;
  curve: number | null;
  letterSpacing: number;
};

export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; }
  return h.toString(36);
}

// Parses an SVG viewBox into numbers, falling back to a sane default so callers can
// destructure without guarding. Replaces the split(/[\s,]+/).map(Number) boilerplate
// that was repeated across every AI/raster path.
export function parseViewBox(svgRoot: Element, fallback = '0 0 800 600'): { x: number; y: number; w: number; h: number } {
  const parts = (svgRoot.getAttribute('viewBox') ?? fallback).trim().split(/[\s,]+/).map(Number);
  const [fx, fy, fw, fh] = fallback.split(/[\s,]+/).map(Number);
  return {
    x: parts[0] ?? fx,
    y: parts[1] ?? fy,
    w: parts[2] ?? fw,
    h: parts[3] ?? fh,
  };
}

// Mounts a hidden clone of svgRoot (carrying its data-* marks) so getBBox works on a
// detached/parsed SVG document, runs fn against it, and always unmounts.
export const withOffscreenSvg = <T,>(svgRoot: Element, fn: (mounted: SVGSVGElement) => T): T => {
  const measureSvg = svgRoot.cloneNode(true) as SVGSVGElement;

  // The clone has to be laid out at its natural size. Mounted into the 1x1 holder this
  // used to use, Chrome scales the viewBox down so far that TEXT measurement degrades —
  // measured against the same clone in a correctly sized holder, getBBox on a <text> came
  // back 5% narrow and returned an ink-ish height instead of the font's line box. Path
  // geometry is resolution-independent and was unaffected, which is why this stayed
  // invisible: it only ever corrupted the text this helper is used to measure.
  //
  // Only an SVG with a viewBox needs its size pinned. Without one there is no scaling to
  // get wrong — one user unit is one pixel — so the clone keeps its own width/height and
  // only the holder is opened up.
  const vb = measureSvg.getAttribute('viewBox');
  const { w, h } = parseViewBox(measureSvg);
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  if (vb) {
    measureSvg.setAttribute('width', String(width));
    measureSvg.setAttribute('height', String(height));
  }

  const holder = document.createElement('div');
  holder.setAttribute(
    'style',
    `position:absolute;left:-99999px;top:0;width:${width}px;height:${height}px;overflow:hidden`,
  );
  holder.appendChild(measureSvg);
  document.body.appendChild(holder);
  try {
    return fn(measureSvg);
  } finally {
    document.body.removeChild(holder);
  }
};

// Advance width of a text layer's string — the length it occupies ALONG its arc, which
// is what computeArcPath needs to centre the visible band.
//
// getComputedTextLength() is the right measure (it's the advance, not a bounding box, so
// it's unaffected by the curve the text is already sitting on), but it only works on
// mounted geometry — updateTextLayer edits a detached DOMParser doc — hence the offscreen
// mount. A clone may render before webfonts load, so this is approximate either way;
// the fallback matches the estimate measureTextWidths already uses, plus tracking.
export function measureTextAdvance(root: Element, groupId: string): number {
  const groupEl = root.querySelector(`[id="${groupId}"]`);
  const textEl = groupEl?.querySelector('text') ?? null;

  const estimate = () => {
    const len = (textEl?.textContent ?? '').length;
    if (!len) return 0;
    const fs = Number(textEl?.getAttribute('font-size') ?? 16);
    const ls = parseFloat(textEl?.getAttribute('letter-spacing') ?? '0') || 0;
    return Math.max(1, len * fs * 0.55 + ls * fs * (len - 1));
  };

  try {
    return withOffscreenSvg(root, (measureSvg) => {
      const el = measureSvg.querySelector(`[id="${groupId}"] text`) as SVGTextContentElement | null;
      if (!el) return estimate();
      // Measure the string laid out flat. On a <textPath>, glyphs that run past the end
      // of the path are not rendered and so are not measured either — which would report
      // a length short enough to rebuild the same too-short arc, and the text could never
      // recover. Replacing the textPath with its own characters takes the path out of it.
      const tp = el.querySelector('textPath');
      if (tp) el.textContent = tp.textContent;
      let w = 0;
      try { w = el.getComputedTextLength?.() ?? 0; } catch { /* unrenderable — estimate below */ }
      return w > 0 ? w : estimate();
    });
  } catch {
    return estimate();
  }
}

// ─── AI text rows → editable text layers ─────────────────────────────────────

// One line of text the vision pass found, in canvas-relative fractions.
//
// The fractions are the model's *estimate* of where the line sits — read off a raster,
// independently per row, and routinely out by several percent of the canvas. removeIds
// is the correction: the indices of the source elements that actually render this line,
// whose measured geometry replaces the estimate entirely (see appendTextRowLayers).
// Optional because a row can legitimately have no source element behind it — a line the
// raster shows but the source analysis never matched.
export type TextRow = {
  yFraction: number; xFraction: number;
  // The row's own left and right edges, when the pass reported them. Optional because a
  // centre is all it used to be asked for, so cached answers carry none — and because a
  // centre cannot express alignment: lines sharing an edge have different centres, so the
  // one number we had could never say that three contact lines were flush left.
  leftFraction?: number; rightFraction?: number;
  font: string; sizeFraction: number;
  weight: number; color: string; content: string;
  // A line that is not all one style, broken into consecutive runs in reading order.
  //
  // "MICHAEL DOE" with DOE bolder is ONE row with two spans, not two rows. Two rows was
  // what the pass used to be asked for, and it is unplaceable: two sibling fields each
  // carrying their own estimated position, which the pass then disagreed with itself
  // about — it returned the line whole AND split, 24 units apart, and both got drawn. A
  // span has no position at all. The runs sit side by side because they are in one
  // <text>, and the only thing that has to be placed is the line.
  spans?: TextSpan[];
  letterSpacing: number;
  removeIds?: string[];
};

export type TextSpan = { text: string; color?: string; weight?: number; font?: string };

// ─── Multi-line text ─────────────────────────────────────────────────────────

// SVG does no line breaking. A newline inside a <text> is just whitespace, so a
// multi-line string is collapsed onto ONE line: "FIRST\nSECOND" renders as
// "FIRST SECOND" and runs off the canvas at the row's own font size. The vision pass
// returns one row per line, so this normally never comes up — but a row whose content
// is itself several lines (an address block, a two-line tagline) has no other way to be
// drawn, and the same goes for anything typed into the Text tab with Return in it.
//
// Lines are emitted as <tspan>s. Each carries its own `x`, without which a tspan simply
// continues along the current line rather than starting a new one, and every line after
// the first is pushed down by `dy`. The offsets are in `em` so they follow font-size:
// snapAnchoredRows rewrites that attribute after measuring, and the block has to stay
// spaced correctly when it does.
export const TEXT_LINE_HEIGHT_EM = 1.2;

export const splitTextLines = (content: string): string[] => content.split(/\r\n|\r|\n/);

// The content of a <text>, with the line structure back in it. Reading .textContent
// directly would run the tspans together ("FIRSTSECOND"), which is what the inspector
// and the curve conversions would then write back as the string.
export function textLines(textEl: Element): string {
  const tspans = Array.from(textEl.children).filter(
    (c) => c.tagName.toLowerCase().replace(/.*:/, '') === 'tspan',
  );
  if (tspans.length === 0) return textEl.textContent ?? '';
  // Spans are runs within one line and join with nothing — the separating space is already
  // inside each run. Lines join with a newline. A <text> holds one kind or the other.
  if (tspans.every((t) => t.getAttribute('data-span') === '1')) {
    return tspans.map((t) => t.textContent ?? '').join('');
  }
  return tspans.map((t) => t.textContent ?? '').join('\n');
}

// Writes `content` into `textEl`, one line per <tspan>, centred vertically on the
// element's own `y` so that a field keeps the position it was placed at however many
// lines it holds — the first line is lifted by half the block's height rather than the
// block growing downwards from the original baseline.
//
// A single line is written as plain text with no tspan at all: that is the overwhelmingly
// common case, and leaving it as a bare string keeps the markup, the measurements and the
// exported file byte-identical to what they were before any of this existed.
export function setTextLines(textEl: Element, content: string, x: number, spans?: TextSpan[]): void {
  const lines = splitTextLines(content);
  while (textEl.firstChild) textEl.removeChild(textEl.firstChild);

  // Styled runs on one line. Marked data-span so the line handling above can tell them
  // apart: a line tspan starts a new line and carries `x` and `dy`, a span tspan flows on
  // from the one before it and carries neither. Reading the text back joins lines with a
  // newline and spans with nothing, which is the difference between them.
  if (lines.length <= 1 && spans && spans.length > 1) {
    const doc = textEl.ownerDocument!;
    const own = {
      fill: textEl.getAttribute('fill'),
      weight: textEl.getAttribute('font-weight'),
      family: textEl.getAttribute('font-family'),
    };
    spans.forEach((span, i) => {
      const el = doc.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      el.setAttribute('data-span', '1');
      // Only what actually differs from the row: an override that repeats the parent's
      // value is noise in the file and one more thing to keep in step when the row is
      // restyled from the inspector.
      if (span.color && span.color !== own.fill) el.setAttribute('fill', span.color);
      if (span.weight && String(span.weight) !== own.weight) el.setAttribute('font-weight', String(span.weight));
      if (span.font && span.font !== own.family) el.setAttribute('font-family', span.font);
      // The space between runs belongs to the run that follows it, so that a colour change
      // does not repaint the gap and the joined text reproduces the row's content.
      el.textContent = (i > 0 ? ' ' : '') + span.text;
      textEl.appendChild(el);
    });
    textEl.setAttribute('x', String(x));
    return;
  }

  if (lines.length <= 1) {
    textEl.textContent = content;
    textEl.setAttribute('x', String(x));
    return;
  }
  const doc = textEl.ownerDocument!;
  const firstDy = -((lines.length - 1) / 2) * TEXT_LINE_HEIGHT_EM;
  lines.forEach((line, i) => {
    const span = doc.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    span.setAttribute('x', String(x));
    span.setAttribute('dy', `${i === 0 ? firstDy : TEXT_LINE_HEIGHT_EM}em`);
    // An empty line still has to occupy its dy, and a tspan with no content is not
    // rendered at all — so it carries a space to keep the blank line in the block.
    span.textContent = line === '' ? ' ' : line;
    textEl.appendChild(span);
  });
  textEl.setAttribute('x', String(x));
}

// Moves a <text> horizontally. The per-line `x` on each tspan overrides the one on the
// <text>, so setting only the parent would move a single-line field and leave a
// multi-line one exactly where it was.
export function setTextX(textEl: Element, x: number): void {
  textEl.setAttribute('x', String(x));
  for (const child of Array.from(textEl.children)) {
    if (child.tagName.toLowerCase().replace(/.*:/, '') !== 'tspan') continue;
    // Line tspans each start a line and need their own x. Span tspans must NOT have one —
    // they flow on from the run before them, and giving them an x would stack every run
    // of the line on the same point.
    if (child.getAttribute('data-span') === '1') continue;
    child.setAttribute('x', String(x));
  }
}

// Letter-spacing steps the inspector's slider offers. AI estimates are snapped onto
// them so a re-created field can still be adjusted by hand afterwards.
const LS_OPTIONS = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3];
const snapLetterSpacing = (v: number) =>
  LS_OPTIONS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// How close two rows' vertical centres must be to count as the same line of text — the
// only rows that can collide with each other — as a fraction of the smaller row's font
// size. Measured against the TEXT, not the canvas: words sharing a line share a baseline,
// so their centres differ by almost nothing whatever size the canvas is, while separate
// lines are a line-height apart by definition.
//
// This was a flat 0.03 of canvas height, which is not a property of the rows at all. On a
// diagram whose eight stacked labels sat 0.02 of the canvas apart, every one of them fell
// inside that window, so the whole vertical list was read as a single horizontal band and
// re-laid left to right — turning a column of labels into an overlapping row of them.
const BAND_SAME_LINE_EM = 0.5;
// Space kept between two fields in the same band, as a fraction of the larger font size.
const BAND_GAP_EM = 0.25;
// How close two rows' sizeFractions must be before the model is taken to be saying they
// are the same size, so a measured one can lend its size to an estimated one.
const SAME_SIZE_TOLERANCE = 0.1;

// Two views of one element's geometry, both in root space. `box` is what getBBox reports;
// `ink` is the box the element's visible marks actually fill. They differ only for
// <text>, where getBBox returns the font's LINE box — ascender to descender, the same
// height whatever the string — and are the same object for everything else.
type BoxPair = { box: DOMRect; ink: DOMRect };

const TEXTISH_TAGS = new Set(['text', 'tspan']);

// Ink bounds of a rendered <text>, in the element's OWN coordinate space, or null for
// anything that isn't text. Canvas is the only source of per-string ink extents, and its
// actualBoundingBox* values were checked against a pixel scan of the same string (agreed
// within ~1px). getBBox gives the line box, whose top is fontBoundingBoxAscent above the
// baseline — so the baseline is recoverable, and the ink follows from it.
function textInkBounds(el: Element, localBox: DOMRect): { top: number; bottom: number } | null {
  try {
    if (!TEXTISH_TAGS.has(el.tagName.toLowerCase().replace(/.*:/, ''))) return null;
    const size = Number(el.getAttribute('font-size'));
    if (!Number.isFinite(size) || size <= 0) return null;
    const raw = el.getAttribute('font-family') || 'Arial';
    // A bare multi-word family name is legal in the CSS font shorthand, but quoting is
    // safer; one that is already a list or already quoted is passed through as-is.
    const family = /[",]/.test(raw) ? raw : `"${raw}"`;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.font = `${el.getAttribute('font-weight') || '400'} ${size}px ${family}`;
    const m = ctx.measureText(el.textContent ?? '');
    const { fontBoundingBoxAscent: asc, actualBoundingBoxAscent: ia, actualBoundingBoxDescent: id } = m;
    if (![asc, ia, id].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    const baseline = localBox.y + asc;
    return { top: baseline - ia, bottom: baseline + id };
  } catch {
    return null;
  }
}

// Root-space geometry for a set of elements, keyed by a caller-chosen name and located by
// a caller-supplied selector. One offscreen mount serves the whole set: cloning and
// mounting the document is the expensive part, measuring within it is not.
//
// Root space (not raw getBBox) because the interesting elements are usually nested under
// transformed groups, and the only coordinates worth comparing are the ones the root
// <svg> writes its own children in. The ink box is narrowed in LOCAL space and mapped
// through the same transform chain, so a wordmark inside a scale(1.5) group is handled
// like any other.
function measureBoxPairs(root: Element, selectors: Map<string, string>): Map<string, BoxPair> {
  const pairs = new Map<string, BoxPair>();
  if (selectors.size === 0) return pairs;
  try {
    withOffscreenSvg(root, (measureSvg) => {
      for (const [key, selector] of selectors) {
        const el = measureSvg.querySelector(selector) as SVGGraphicsElement | null;
        if (!el) continue;
        const box = bboxInRootSpace(measureSvg, el);
        // A zero-area box is a measurement failure, not a measurement — an unrenderable
        // or empty element. Leaving it out lets callers fall back rather than snap to it.
        if (!box || box.width <= 0 || box.height <= 0) continue;
        const local = el.getBBox();
        const bounds = textInkBounds(el, local);
        const ink = bounds
          ? bboxInRootSpace(measureSvg, el, new DOMRect(local.x, bounds.top, local.width, bounds.bottom - bounds.top)) ?? box
          : box;
        pairs.set(key, { box, ink });
      }
    });
  } catch { /* no live DOM (tests, SSR) — callers fall back to the model's estimate */ }
  return pairs;
}

export function measureBoxes(root: Element, selectors: Map<string, string>): Map<string, DOMRect> {
  return new Map([...measureBoxPairs(root, selectors)].map(([key, p]) => [key, p.box]));
}

// Root-space INK boxes of the elements a vision pass is about to delete, keyed by the
// data-ai-idx the model addressed them by.
//
// MUST be called before the removal loop: once the paths are gone their geometry is
// unrecoverable, and it is the only ground truth about where the original lettering
// actually sat. Feeds appendTextRowLayers's `anchors`.
//
// Ink rather than plain boxes so the anchor means the same thing whichever way the source
// drew its lettering — outlines, where the two are identical, or a live <text>, where the
// plain box would be the line box and would drag the replacement off by up to 0.1em.
export const measureRemovedTextBoxes = (svgRoot: Element, removeIds: string[]): Map<string, DOMRect> =>
  new Map(
    [...measureBoxPairs(svgRoot, new Map(removeIds.map((sid) => [sid, `[data-ai-idx="${sid}"]`])))]
      .map(([key, p]) => [key, p.ink]),
  );

const unionBox = (boxes: DOMRect[]): DOMRect | null => {
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right  = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return new DOMRect(x, y, right - x, bottom - y);
};

// Rendered width of each id, measured off-screen. Falls back to a glyph-count estimate
// for anything unmeasurable (detached geometry, no live DOM under test).
function measureTextWidths(root: Element, ids: string[]): Map<string, number> {
  const estimate = (el: Element | null) => {
    const len = (el?.textContent ?? '').length;
    const fs = Number(el?.getAttribute('font-size') ?? 16);
    return Math.max(1, len * fs * 0.55);
  };
  const boxes = measureBoxes(root, new Map(ids.map((id) => [id, `[id="${id}"]`])));
  return new Map(ids.map((id) => [
    id,
    boxes.get(id)?.width ?? estimate(root.querySelector(`[id="${id}"]`)),
  ]));
}

// Bounds on what counts as one line of lettering when resolveAnchors grows a row's anchor
// out from a single box. Glyphs on one line vary in height (cap height against an
// x-height — 6.2 to 9.4 on this artwork, a ratio of 1.5); whole shapes that merely cross
// the line do not, which is what the ratio excludes.
const SAME_LINE_HEIGHT_RATIO = 2.0;
// How much of the shorter box's height must overlap the line's span to join it.
const SAME_LINE_OVERLAP = 0.5;
const SAME_LINE_GROWTH_PASSES = 2;
// How far apart, in multiples of the line's own height, two boxes may sit horizontally
// and still belong to the same run of lettering. Coarse on purpose — see the comment on
// clusterAnchorsIntoLines.
const SAME_LINE_MAX_GAP = 4.0;

// What it costs to leave a band or a line unpaired, as a fraction of canvas height. Two
// skips cost 2x this, so a pairing is taken when the row's estimate and the line sit
// closer together than that.
//
// Distance is the loose test here and ALIGN_MAX_SIZE_RATIO is the strict one. 0.3 was
// wrong — the bar was over half the canvas, and a back-card row reached the front-card
// logo — but 0.06 was wrong in the other direction: 22 units on a 368 canvas, inside the
// error the estimates carry by nature, so real matches were refused and rows that had
// perfectly good geometry fell through to their estimates. What keeps a row off a logo is
// that a logo is the wrong SIZE for it, which is a property of the thing rather than of
// how far the guess landed from it.
const ALIGN_SKIP_COST = 0.15;

// How far apart in size a band and a line may be and still be the same lettering.
const ALIGN_MAX_SIZE_RATIO = 3.0;

// Detecting the edge a block of lines was set against. It takes at least this many lines
// to be a block at all; the winning edge must agree to within this fraction of a line
// height, and must beat the next best by this margin before anything is claimed.
const BLOCK_MIN_LINES = 3;

// Collapsing a row that is part of another row on the same line: how much of the shorter
// row's width must overlap the longer, and the shortest string worth treating as a piece
// of something rather than as a row of its own.
const FRAGMENT_MIN_OVERLAP = 0.5;
const FRAGMENT_MIN_CHARS = 2;
// How far apart two rows' edges may sit and still be the same column, and how tightly a
// column must agree before an edge is claimed — both as fractions of a line height.
const COLUMN_TOLERANCE = 1.0;
const COLUMN_AGREEMENT = 0.5;

// Telling a leading ornament (an icon in front of a contact line) from a first word. Both
// ratios must hold; see textExtent.
const ORNAMENT_MIN_LINE_BOXES = 4;
const ORNAMENT_MAX_BOXES = 2;
const ORNAMENT_REST_RATIO = 3;
const ORNAMENT_GAP_RATIO = 3;
// Ceiling on a snapped font size, as a fraction of the viewBox height. A sanity bound on
// the OUTPUT, deliberately not a bound on how far the measurement may drag the model's
// estimate: the estimate is the untrusted input here, and a wordmark the model sized at
// 5% of the canvas when it really fills 18% needs a 3.6x correction to land — exactly the
// case worth fixing. Only a result larger than the canvas itself is self-evidently wrong.
const MAX_SNAPPED_SIZE = 1.0;
// The smallest font a snapped row may be given. Below this the target is not believed.
const MIN_SNAPPED_SIZE = 8;
// How far above its own estimate measuring may push a row before the target is not
// believed either. Generous — the estimate is what needs correcting — but not unbounded.
const SNAP_MAX_GROWTH = 3.0;

// ─── Anchor boxes → lines of lettering ───────────────────────────────────────

type AnchorLine = { ids: string[]; box: DOMRect };

// Groups the anchor boxes into the lines of lettering they actually form.
//
// Every anchor box is one LEAF shape. In artwork whose type has been converted to
// outlines that is one glyph — "MICHAEL DOE" is ten separate paths on this card — so a
// box on its own is never a unit a row can be anchored to. The line is.
//
// Seeded shortest-box-first, which is what keeps this a clustering of lettering rather
// than of the canvas: glyphs are the small shapes, so they find each other before
// anything large is considered, and a big shape is left to form its own cluster. Seeding
// topmost-first instead starts on the back card's background rect, and since that rect
// overlaps every line in the stack the whole card comes back as one "line".
//
// Growth is by vertical OVERLAP, not by distance between centres: a line mixes x-height
// with cap height and descenders, so "o" and "l" on one line have centres well apart
// while their spans overlap almost completely.
//
// Two bounds keep a line from becoming a region:
//   - height, because a shape that merely crosses the line is not on it. The back card's
//     background rect is 144 units tall against a 9-unit glyph and overlaps every line it
//     contains. It also passes filterOutBackgroundIds — 27% of the canvas, under that
//     guard's 50% limit — so this is the only thing that rejects it.
//   - horizontal gap, so two separate blocks that happen to share a y do not merge. It is
//     deliberately coarse (multiples of the line's own height): it only has to tell a run
//     of words from a block half a canvas away, never a word space from the gap to an
//     adjacent icon, which is a judgement the measurements would not support.
function clusterAnchorsIntoLines(anchors: Map<string, DOMRect>): AnchorLine[] {
  const remaining = new Map(anchors);
  const lines: AnchorLine[] = [];

  while (remaining.size > 0) {
    let seed: [string, DOMRect] | null = null;
    for (const entry of remaining) {
      if (!seed || entry[1].height < seed[1].height) seed = entry;
    }
    const [seedId, seedBox] = seed!;
    remaining.delete(seedId);

    const ids = [seedId];
    let box = seedBox;
    for (let pass = 0; pass < SAME_LINE_GROWTH_PASSES; pass++) {
      let grew = false;
      for (const [sid, candidate] of [...remaining]) {
        if (candidate.height > box.height * SAME_LINE_HEIGHT_RATIO) continue;
        const overlap = Math.min(candidate.y + candidate.height, box.y + box.height) -
                        Math.max(candidate.y, box.y);
        if (overlap < SAME_LINE_OVERLAP * Math.min(candidate.height, box.height)) continue;
        const gap = Math.max(candidate.x - (box.x + box.width), box.x - (candidate.x + candidate.width));
        if (gap > SAME_LINE_MAX_GAP * box.height) continue;
        remaining.delete(sid);
        ids.push(sid);
        box = unionBox([box, candidate])!;
        grew = true;
      }
      if (!grew) break;
    }
    lines.push({ ids, box });
  }

  return lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

// The rows that share one visible line, in reading order, as index runs into `rows`.
// Same test the de-overlap pass uses: rows on a line share a baseline, so their estimated
// centres differ by almost nothing, while separate lines are a line-height apart.
function groupRowsIntoBands(
  rows: TextRow[],
  vb: { x: number; y: number; w: number; h: number },
): { rows: number[]; y: number; size: number }[] {
  const bands: { rows: number[]; y: number; size: number }[] = [];
  rows.forEach((row, i) => {
    const y = vb.y + row.yFraction * vb.h;
    const size = Math.max(MIN_SNAPPED_SIZE, row.sizeFraction * vb.h);
    const last = bands[bands.length - 1];
    if (last && Math.abs(y - last.y) <= BAND_SAME_LINE_EM * size) {
      last.rows.push(i);
      last.size = Math.max(last.size, size);
    } else {
      bands.push({ rows: [i], y, size });
    }
  });
  return bands;
}

// Aligns the bands of rows to the lines of lettering, in order, allowing either side to
// skip. Returns the line index for each band, or null.
//
// This is the linking. The model is asked which outlines spell which row and routinely
// gets it shifted — on this artwork every row came back tagged with the NEXT line's
// outlines, so "DOE" carried MICHAEL's paths and "1234-5678" carried the web address's.
// Nothing downstream can detect that from the boxes alone: they are real, the measurement
// is exact, only the pairing is wrong. But both sequences are in reading order, and that
// is a property the model cannot get wrong, because it never chose it — so the pairing is
// recovered from order instead of taken from the answer.
//
// Positions are compared as fractions of the CANVAS, not rescaled over each sequence's
// own span. Rescaling looks like the right way to cancel the compression in the estimates
// — they are not merely noisy but systematically squeezed against the real geometry — and
// it would, if the two sequences covered the same ground. They do not: the lines include
// every shape the pass flagged, logo and card panels among them, so on this artwork 4
// bands confined to the back card were stretched across 12 lines spanning both cards and
// the first row was matched to the front card's logo.
//
// Order carries the correspondence here, and the distances only have to be good enough to
// reject a bad pairing, which canvas-relative ones are.
//
// Skips are what make it robust to the two sequences not being the same length: artwork
// holds lettering the vision pass never reported (an icon, a rule, a stray shape that got
// flagged for removal), and the pass reports rows whose lettering it could not point at.
// A pairing worse than SKIP_COST is taken to be no pairing at all.
function alignBandsToLines(
  bands: { rows: number[]; y: number; size: number }[],
  lines: AnchorLine[],
  vb: { x: number; y: number; w: number; h: number },
): (number | null)[] {
  const result: (number | null)[] = bands.map(() => null);
  if (bands.length === 0 || lines.length === 0) return result;

  const B = bands.map((b) => (b.y - vb.y) / vb.h);
  const L = lines.map((l) => (l.box.y + l.box.height / 2 - vb.y) / vb.h);

  // A line can only hold a band if the two are the same ORDER OF SIZE. The vision pass
  // reports sizeFraction off a raster and is imprecise, but it is never wrong by a
  // factor of six — so a row estimating an 11-unit font has no business anchoring to a
  // 120-unit-tall cluster, whatever the reading order says.
  //
  // This is what stops a logo from being treated as a line of type. On this card the
  // pass named the M logo as lettering, which is a fair reading — it IS a letter — and
  // the alignment then put "DOE" and "MICHAEL" on the front card at 60px. The removal is
  // the model's call to make; anchoring a contact line to it is not.
  const fits = (i: number, j: number): boolean => {
    const size = Math.max(MIN_SNAPPED_SIZE, bands[i].size);
    const ratio = lines[j].box.height / size;
    return ratio <= ALIGN_MAX_SIZE_RATIO && ratio >= 1 / ALIGN_MAX_SIZE_RATIO;
  };

  const n = bands.length;
  const m = lines.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i][j];
      if (!Number.isFinite(here)) continue;
      if (i < n && j < m && fits(i, j)) {
        const c = here + Math.abs(B[i] - L[j]);
        if (c < cost[i + 1][j + 1]) cost[i + 1][j + 1] = c;
      }
      if (i < n && here + ALIGN_SKIP_COST < cost[i + 1][j]) cost[i + 1][j] = here + ALIGN_SKIP_COST;
      if (j < m && here + ALIGN_SKIP_COST < cost[i][j + 1]) cost[i][j + 1] = here + ALIGN_SKIP_COST;
    }
  }

  // Walk the table back to recover which step was taken at each cell.
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = cost[i][j];
    if (i > 0 && j > 0 && fits(i - 1, j - 1) &&
        Math.abs(cost[i - 1][j - 1] + Math.abs(B[i - 1] - L[j - 1]) - here) < 1e-9) {
      result[i - 1] = j - 1;
      i--; j--;
    } else if (i > 0 && Math.abs(cost[i - 1][j] + ALIGN_SKIP_COST - here) < 1e-9) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

// Divides one line's boxes between the rows that share it.
//
// A line holding several rows is a line the model split by styling — "MICHAEL" light and
// "DOE" bold is two rows on one line, which the prompt asks for explicitly. The split
// falls at the widest gaps in the line: for k rows, the k-1 widest. That is a RELATIVE
// judgement and needs no threshold, which matters because the absolute one is not
// supportable — a word space measures 0.60 of glyph height on this artwork against 0.89
// for the gap to an adjacent icon, and nothing says that margin holds elsewhere.
//
// It returns ONE BOX PER ROW, always. Handing the whole line back to each row instead is
// what put text on top of text: rows sharing a band were centred on the identical
// rectangle, and neither reflow pass corrects that, because both leave anchored rows
// alone on the reasoning that measured geometry does not overlap itself. That stopped
// being true the moment several rows could be given one line's geometry.
function splitLineAmongRows(line: AnchorLine, contents: string[], anchors: Map<string, DOMRect>): DOMRect[] {
  const count = contents.length;
  if (count <= 1) return [line.box];

  const boxes = line.ids
    .map((sid) => anchors.get(sid)!)
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);

  // Enough elements to cut between: split at the k-1 widest gaps.
  if (boxes.length > count) {
    const gaps = boxes.slice(0, -1).map((box, i) => ({
      at: i + 1,
      size: boxes[i + 1].x - (box.x + box.width),
    }));
    const cuts = gaps
      .sort((a, b) => b.size - a.size)
      .slice(0, count - 1)
      .map((g) => g.at)
      .sort((a, b) => a - b);

    const runs: DOMRect[] = [];
    let from = 0;
    for (const cut of [...cuts, boxes.length]) {
      const run = boxes.slice(from, cut);
      if (run.length > 0) runs.push(unionBox(run)!);
      from = cut;
    }
    if (runs.length === count) return runs;
  }

  // Too few elements to cut between — a line that is a single element, either because the
  // artwork's type is real <text> or because the pass named one outline for the whole
  // line. The box is divided geometrically instead, in proportion to what each row says.
  const weights = contents.map((c) => Math.max(1, c.trim().length));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const parts: DOMRect[] = [];
  let x = line.box.x;
  for (const weight of weights) {
    const w = (line.box.width * weight) / total;
    parts.push(new DOMRect(x, line.box.y, w, line.box.height));
    x += w;
  }
  return parts;
}

// Pairs each row with the box its original lettering occupied, parallel to `rows`.
//
// The model's removeIds are NOT used for this. They say which outlines spell which row
// and are the thing that comes back shifted; see alignBandsToLines. They still drive what
// gets removed from the artwork — that is a separate question, and a wrong answer there
// leaves a stray outline rather than putting a row in the wrong place.
function resolveAnchors(
  rows: TextRow[],
  vb: { x: number; y: number; w: number; h: number },
  anchors: Map<string, DOMRect>,
): { targets: (DOMRect | null)[]; lines: (AnchorLine | null)[] } {
  const targets: (DOMRect | null)[] = rows.map(() => null);
  // The whole line a row was linked to, as opposed to the slice of it the row was given.
  // Kept separately because it survives the target being given up in snapAnchoredRows:
  // an anchor can be the wrong SIZE for a row and still be the right line, and the line
  // is what says where the block's edge is.
  const rowLines: (AnchorLine | null)[] = rows.map(() => null);
  if (anchors.size === 0) return { targets, lines: rowLines };

  const lines = clusterAnchorsIntoLines(anchors);
  const bands = groupRowsIntoBands(rows, vb);
  const pairing = alignBandsToLines(bands, lines, vb);

  let matched = 0;
  bands.forEach((band, b) => {
    const at = pairing[b];
    if (at === null) return;
    const line = lines[at];
    const parts = splitLineAmongRows(line, band.rows.map((i) => rows[i].content ?? ''), anchors);
    band.rows.forEach((rowIdx, k) => {
      targets[rowIdx] = parts[k] ?? line.box;
      rowLines[rowIdx] = line;
      matched++;
    });
  });

  console.log(
    `[text-rows] linked ${matched}/${rows.length} row(s) to ${lines.length} line(s) of lettering ` +
    `by reading order (${bands.length} band(s))`,
  );
  return { targets, lines: rowLines };
}

// Where a row will sit and roughly how big it will be, in root space — enough to tell
// whether two rows describe the same visible line. Measured geometry when the row has an
// anchor, the model's estimate when it doesn't.
type RowExtent = { content: string; cx: number; cy: number; w: number; h: number };

function rowExtent(row: TextRow, target: DOMRect | null, vb: { x: number; y: number; w: number; h: number }): RowExtent {
  const content = row.content.trim();
  if (target) {
    return { content, cx: target.x + target.width / 2, cy: target.y + target.height / 2, w: target.width, h: target.height };
  }
  const fontSize = Math.max(8, row.sizeFraction * vb.h);
  return {
    content,
    cx: vb.x + row.xFraction * vb.w,
    cy: vb.y + row.yFraction * vb.h,
    w: Math.max(1, content.length * fontSize * 0.55),
    h: fontSize,
  };
}

// Two rows are the same visible line when they say the same thing in the same place.
// Compared against the SMALLER of the two extents so that stacked copies — a shadow
// offset by a pixel or two — still read as one line, while the same word repeated in two
// corners of the canvas stays two lines.
const sameVisibleLine = (a: RowExtent, b: RowExtent): boolean =>
  a.content === b.content &&
  Math.abs(a.cx - b.cx) <= 0.5 * Math.min(a.w, b.w) &&
  Math.abs(a.cy - b.cy) <= 0.5 * Math.min(a.h, b.h);

// Do two extents sit on one line and overlap along it?
const overlapsOnOneLine = (a: RowExtent, b: RowExtent): boolean => {
  if (Math.abs(a.cy - b.cy) > 0.5 * Math.min(a.h, b.h)) return false;
  const overlap = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  return overlap >= FRAGMENT_MIN_OVERLAP * Math.min(a.w, b.w);
};

const asWords = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// Is `part` one row's worth of `whole` — "MICHAEL" against "MICHAEL DOE"?
//
// Matched on word boundaries so a row is never swallowed for sharing a few letters with
// its neighbour, and only from two characters up: a single character is as likely to be a
// genuine standalone row (a monogram, a bullet) as a fragment of one.
const isFragmentOf = (part: string, whole: string): boolean => {
  const p = asWords(part);
  const w = asWords(whole);
  if (p.length < FRAGMENT_MIN_CHARS || p.length >= w.length) return false;
  return new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(w);
};

// Drops a band of rows that says the same thing as another band, wherever the pass put it.
//
// The heading on this card came back twice in one answer: rows 0 and 1 as "MICHAEL" and
// "DOE" at y=0.555 and 14px, and row 5 as "MICHAEL DOE" at y=0.490 and 8px — one line of
// text read twice, 24 units and three line-heights apart, so both were drawn. The
// same-line tests below cannot see it, because the two readings are not on the same line;
// that disagreement IS the duplication.
//
// Matched on the exact joined string, normalised for case and spacing, so it fires only
// when two bands spell out precisely the same text. Artwork that genuinely repeats a line
// keeps both, because both bands would then carry the elements that draw them — which is
// also the tiebreak: the band naming more removeIds is the one pointing at real lettering,
// and the other is the loose reading of it.
function dropRepeatedBands(
  rows: TextRow[],
  targets: (DOMRect | null)[],
  vb: { x: number; y: number; w: number; h: number },
): { rows: TextRow[]; targets: (DOMRect | null)[] } {
  const bands = groupRowsIntoBands(rows, vb);
  if (bands.length < 2) return { rows, targets };

  const said = bands.map((b) => asWords(b.rows.map((i) => rows[i].content ?? '').join(' ')));
  const idCount = bands.map((b) => b.rows.reduce((n, i) => n + (rows[i].removeIds?.length ?? 0), 0));

  const dropped = new Set<number>();
  bands.forEach((_band, a) => {
    if (dropped.has(a) || !said[a]) return;
    bands.forEach((_other, b) => {
      if (b <= a || dropped.has(b) || said[b] !== said[a]) return;
      const loser = idCount[b] > idCount[a] ? a : b;
      dropped.add(loser);
      console.log(
        `[text-rows] dropping a repeated reading of "${rows[bands[loser].rows[0]].content}" — ` +
        `the same text came back as ${bands[a].rows.length} row(s) at y=${bands[a].y.toFixed(0)} ` +
        `and ${bands[b].rows.length} row(s) at y=${bands[b].y.toFixed(0)}; keeping the one ` +
        `naming ${Math.max(idCount[a], idCount[b])} element(s)`,
      );
    });
  });
  if (dropped.size === 0) return { rows, targets };

  const keep = new Set<number>();
  bands.forEach((band, i) => { if (!dropped.has(i)) band.rows.forEach((r) => keep.add(r)); });
  return {
    rows: rows.filter((_, i) => keep.has(i)),
    targets: targets.filter((_, i) => keep.has(i)),
  };
}

// Collapses rows the model returned more than once for the same line of text.
//
// Artwork routinely draws a wordmark as several stacked copies (a shadow, an outline, a
// fill), so the source legitimately holds three elements for one visible word. Asking the
// model to link rows to those elements invites it to answer with one row per COPY instead
// of one row per line, which lands as three identical fields on the same spot. The prompt
// asks for the right shape; this makes the wrong shape harmless, because a duplicate here
// is not a cosmetic flaw — it is three stacked text layers the user has to find and
// delete by hand.
//
// Merging unions the removeIds and the anchor boxes, which is precisely what would have
// happened had the model returned the one row it should have.
function mergeDuplicateRows(
  rows: TextRow[],
  targets: (DOMRect | null)[],
  vb: { x: number; y: number; w: number; h: number },
): { rows: TextRow[]; targets: (DOMRect | null)[] } {
  // First the coarsest duplication — one line of text read twice in two different places.
  // It has to go before the same-line tests, which by construction cannot see it.
  ({ rows, targets } = dropRepeatedBands(rows, targets, vb));

  const keptRows: TextRow[] = [];
  const keptTargets: (DOMRect | null)[] = [];
  const keptExtents: RowExtent[] = [];
  let merged = 0;
  let fragments = 0;

  rows.forEach((row, i) => {
    const target = targets[i];
    const extent = rowExtent(row, target, vb);

    let at = keptExtents.findIndex((k) => sameVisibleLine(k, extent));
    // Then the weaker relation: not the same string, but one string INSIDE the other on
    // the same line. The pass returns "MICHAEL DOE" and "MICHAEL" as two rows and both get
    // drawn, one over the other. Its prompt already forbids this and it does it anyway —
    // across 21 runs on one card it returned more rows than the card has lines 17 times —
    // so the answer is filtered here rather than asked for more nicely.
    if (at === -1) {
      at = keptExtents.findIndex((k) =>
        overlapsOnOneLine(k, extent) &&
        (isFragmentOf(extent.content, k.content) || isFragmentOf(k.content, extent.content)));
      if (at !== -1) fragments++;
    } else {
      merged++;
    }

    if (at === -1) {
      keptRows.push(row);
      keptTargets.push(target);
      keptExtents.push(extent);
      return;
    }

    // The longer string is the line; the shorter is a piece of it. Whichever that is, the
    // ids both rows named are kept — they all draw the same lettering.
    const keepIncoming = asWords(extent.content).length > asWords(keptExtents[at].content).length;
    keptRows[at] = {
      ...(keepIncoming ? row : keptRows[at]),
      removeIds: [...new Set([...(keptRows[at].removeIds ?? []), ...(row.removeIds ?? [])])],
    };
    const combined = unionBox([keptTargets[at], target].filter((b): b is DOMRect => !!b));
    keptTargets[at] = combined;
    keptExtents[at] = rowExtent(keptRows[at], combined, vb);
  });

  if (merged > 0) {
    console.log(`[text-rows] merged ${merged} duplicate row(s) — same content, same place`);
  }
  if (fragments > 0) {
    console.log(`[text-rows] merged ${fragments} row(s) that were part of another row on the same line`);
  }
  return { rows: keptRows, targets: keptTargets };
}

// The placed rows grouped by the line they sit on, same test as groupRowsIntoBands.
function bandsOf<T extends { row: TextRow; fontSize: number }>(
  placed: T[],
  vb: { x: number; y: number; w: number; h: number },
): T[][] {
  const bands: T[][] = [];
  for (const p of placed) {
    const y = vb.y + p.row.yFraction * vb.h;
    const last = bands[bands.length - 1];
    const lastY = last ? vb.y + last[0].row.yFraction * vb.h : 0;
    const size = Math.max(MIN_SNAPPED_SIZE, p.row.sizeFraction * vb.h);
    if (last && Math.abs(y - lastY) <= BAND_SAME_LINE_EM * size) last.push(p);
    else bands.push([p]);
  }
  return bands;
}

// Brings rows placed from the model's estimate onto the scale the measured rows proved.
//
// The model reads sizeFraction off a raster, independently per row, and is far better at
// RELATIVE size than absolute: it sees that a heading is twice its contact block, while
// being uniformly out on both. So the anchored rows — whose size came from measuring the
// ink they replace — give the correction factor, and applying that one factor to the
// estimated rows fixes the absolute error without flattening the hierarchy the model got
// right. A flat "use the anchored size" would make a heading and its address block the
// same size, which no card ever is.
//
// On top of that, a row the model sized the SAME as an anchored row is snapped to that
// row's measured size exactly. That is the case this pass exists for: a contact block
// where one line kept its anchor and the rest lost theirs has no business rendering at
// four different sizes.
function calibrateEstimatedSizes(
  placed: { row: TextRow; fontSize: number; el: Element; target: DOMRect | null }[],
  vb: { x: number; y: number; w: number; h: number },
): void {
  const estimate = (row: TextRow) => Math.max(MIN_SNAPPED_SIZE, Math.round(row.sizeFraction * vb.h));
  const anchored = placed.filter((p) => p.target);
  const estimated = placed.filter((p) => !p.target);
  if (estimated.length === 0) return;

  // Nothing measured anywhere in the document — every anchor was rejected, or the pass
  // named no outlines this run. There is no correction factor to be had, but the rows
  // sharing a LINE can still be made consistent with each other: the model reports each
  // row separately and routinely gives two halves of one heading different sizes, which
  // is visibly wrong in a way its absolute error is not. Each band is levelled to its own
  // median.
  //
  // Only within a band. Two rows on one line are the same lettering by construction;
  // two lines of a contact block only look like they should match, and deciding they do
  // would be this pass overruling the one reading it still has.
  if (anchored.length === 0) {
    let levelled = 0;
    for (const band of bandsOf(placed, vb)) {
      if (band.length < 2) continue;
      const sizes = band.map((p) => p.fontSize).sort((a, b) => a - b);
      // Lower-middle, not upper. Most bands are two rows — a heading split by weight —
      // and taking the larger inflates the whole heading whenever the model overestimated
      // the bolder half, which is the direction it errs in. Levelling down only ever
      // makes a line smaller than one of its estimates, never bigger than both.
      const median = sizes[Math.floor((sizes.length - 1) / 2)];
      for (const p of band) {
        if (p.fontSize === median) continue;
        p.fontSize = median;
        p.el.setAttribute('font-size', String(median));
        levelled++;
      }
    }
    if (levelled > 0) {
      console.log(`[text-rows] no measured row to calibrate against — levelled ${levelled} row(s) to their line's size`);
    }
    return;
  }

  const factors = anchored
    .map((p) => p.fontSize / estimate(p.row))
    .filter((f) => Number.isFinite(f) && f > 0)
    .sort((a, b) => a - b);
  if (factors.length === 0) return;
  const k = factors[Math.floor(factors.length / 2)];

  for (const p of estimated) {
    const twin = anchored.find(
      (a) => Math.abs(a.row.sizeFraction - p.row.sizeFraction) <=
        SAME_SIZE_TOLERANCE * Math.max(a.row.sizeFraction, p.row.sizeFraction),
    );
    const size = twin ? twin.fontSize : estimate(p.row) * k;
    const next = Math.round(Math.min(Math.max(size, 8), MAX_SNAPPED_SIZE * vb.h));
    if (next === p.fontSize) continue;
    p.fontSize = next;
    p.el.setAttribute('font-size', String(next));
  }
  console.log(
    `[text-rows] rescaled ${estimated.length} estimated row(s) by ${k.toFixed(2)}x, ` +
    `from ${anchored.length} measured row(s)`,
  );
}

// Sets the rows against the columns the artwork was laid out on.
//
// Every field is written text-anchor:middle at a centre, because a centre is the one thing
// the vision pass reports — xFraction is defined as the row's horizontal centre. A centre
// cannot express alignment: lines of different lengths sharing an edge have different
// centres. So the flush edge dissolves as soon as a replacement is a different width from
// what it replaced, which it always is, being a different font at a corrected size.
//
// The alignment is not in the model's answer but it is in the geometry already measured.
// Which edge — left, centre or right — is decided by whichever agrees best once the rows
// are grouped into COLUMNS. A card is rarely one column: this one has two, the heading at
// 89.9 and the contact block at 105.4, and forcing every row onto a single edge laid the
// contact strings straight over the icons at 90. Columns are what "aligned" means here.
function alignRowsToColumns(
  placed: { id: string; row: TextRow; el: Element; cx: number; cy: number; fontSize: number;
            target: DOMRect | null; line: AnchorLine | null }[],
  anchors: Map<string, DOMRect>,
  vb: { x: number; y: number; w: number; h: number },
): void {
  // Where a row's edges come from: the measured geometry when it has any, otherwise the
  // pass's own leftFraction/rightFraction.
  //
  // Reported edges are what let this work at all on a run where nothing anchored — which
  // is the run that needs it most, since those rows are placed from estimates and have
  // nothing else keeping them in line with each other. Measured still wins where both
  // exist: it is the artwork rather than a reading of it.
  // A row sharing its line with another is a heading split by styling — "MICHAEL" light
  // and "DOE" bold — positioned against its neighbour by the band pass. A column rule
  // fights that: given the two of them it reads two columns and snaps each to one, which
  // on this card put DOE to the LEFT of MICHAEL.
  //
  // Membership is decided on the band, not on whether two rows were linked to the same
  // measured line. Those are the same question only when there is geometry to link to;
  // with edges the pass reported and nothing anchored, every row's `line` is null and a
  // line-identity test silently lets the whole heading through.
  const shared = new Set<typeof placed[number]>();
  for (const band of bandsOf(placed, vb)) {
    if (band.length > 1) band.forEach((p) => shared.add(p));
  }

  const extentOf = (p: typeof placed[number]) => {
    if (shared.has(p)) return null;
    if (p.line) return textExtent(p.line, anchors);
    const { leftFraction: lf, rightFraction: rf } = p.row;
    if (lf === undefined || rf === undefined) return null;
    return { left: vb.x + lf * vb.w, right: vb.x + rf * vb.w, height: p.fontSize };
  };

  const withExtent = placed
    .map((p) => ({ p, e: extentOf(p) }))
    .filter((x): x is { p: typeof placed[number]; e: { left: number; right: number; height: number } } => !!x.e);
  if (withExtent.length < BLOCK_MIN_LINES) return;

  const rows = withExtent.map((x) => x.p);
  const extents = withExtent.map((x) => x.e);
  const lineHeight = median(extents.map((e) => e.height));
  const tolerance = COLUMN_TOLERANCE * lineHeight;

  // Group one edge's values into columns, and score the grouping by its worst column.
  const columnsOf = (values: number[]) => {
    const cols: number[][] = [];
    for (const v of [...values].sort((a, b) => a - b)) {
      const last = cols[cols.length - 1];
      if (last && v - last[0] <= tolerance) last.push(v);
      else cols.push([v]);
    }
    return cols;
  };
  const byEdge = {
    start:  extents.map((e) => e.left),
    middle: extents.map((e) => (e.left + e.right) / 2),
    end:    extents.map((e) => e.right),
  };

  // Ranked on how FEW columns the edge needs first, and only then on how tightly they
  // agree. Tightness alone is not a measure of anything: every edge can be made to agree
  // perfectly by splitting it into one column per row, so on this card the right edges
  // scored 0.9 across three columns against the left's 0.4 across two, and a spread-only
  // comparison came within a rounding error of picking them. The edge that explains the
  // layout is the one that accounts for the same rows with fewer columns.
  const ranked = (Object.keys(byEdge) as (keyof typeof byEdge)[])
    .map((edge) => {
      const cols = columnsOf(byEdge[edge]);
      return {
        edge,
        values: byEdge[edge],
        cols,
        spread: Math.max(...cols.map((c) => c[c.length - 1] - c[0])),
      };
    })
    .sort((a, b) => a.cols.length - b.cols.length || a.spread - b.spread);

  const best = ranked[0];
  // Lines of similar length agree on every edge; nothing is being claimed there, and the
  // centring every row already has is as good an answer as any.
  if (best.spread > COLUMN_AGREEMENT * lineHeight) return;
  if (best.edge === 'middle') return;

  const cols = best.cols;
  const columnFor = (v: number) => cols.find((c) => v >= c[0] - 1e-6 && v <= c[c.length - 1] + 1e-6);

  let moved = 0;
  rows.forEach((p, i) => {
    const col = columnFor(best.values[i]);
    if (!col) return;
    p.el.setAttribute('text-anchor', best.edge);
    p.cx = median(col);
    setTextX(p.el, p.cx);
    moved++;
  });
  if (moved > 0) {
    const measured = withExtent.filter((x) => x.p.line).length;
    console.log(
      `[text-rows] ${best.edge === 'start' ? 'left' : 'right'}-aligned ${moved} row(s) onto ` +
      `${cols.length} column(s) at ${cols.map((c) => median(c).toFixed(1)).join(', ')} ` +
      `(agree to ${best.spread.toFixed(1)}; ${measured} edge(s) measured, ` +
      `${withExtent.length - measured} reported)`,
    );
  }
}

const median = (vals: number[]): number =>
  [...vals].sort((a, b) => a - b)[Math.floor((vals.length - 1) / 2)];

// A line's extent WITHOUT a leading ornament.
//
// The line clusters take in whatever sits on the line, and on a contact block that is the
// icon in front of the text. Its box then becomes the line's left edge, so aligning to it
// puts the replacement string on top of the icon rather than where the text was.
//
// An ornament is told from a first word by two ratios, no absolute sizes: it is one or two
// shapes where the rest of the line is many, and the gap after it dwarfs the gaps within
// the text. On this artwork the contact lines read 1 box against 9 with a gap 10x the
// median, while the heading's widest gap — the space in "MICHAEL DOE" — has 7 boxes before
// it and 3 after, so it is never mistaken for one. Both tests must hold.
function textExtent(line: AnchorLine, anchors: Map<string, DOMRect>): { left: number; right: number; height: number } {
  const boxes = line.ids.map((sid) => anchors.get(sid)!).filter(Boolean).sort((a, b) => a.x - b.x);
  const whole = { left: line.box.x, right: line.box.x + line.box.width, height: line.box.height };
  if (boxes.length < ORNAMENT_MIN_LINE_BOXES) return whole;

  const gaps = boxes.slice(0, -1).map((b, i) => boxes[i + 1].x - (b.x + b.width));
  let at = 0;
  for (let i = 1; i < gaps.length; i++) if (gaps[i] > gaps[at]) at = i;
  const leading = at + 1;
  const rest = boxes.length - leading;
  const typical = median(gaps.filter((_, i) => i !== at)) || 0;

  if (leading > ORNAMENT_MAX_BOXES) return whole;
  if (rest < leading * ORNAMENT_REST_RATIO) return whole;
  if (typical > 0 && gaps[at] < typical * ORNAMENT_GAP_RATIO) return whole;

  const text = boxes.slice(leading);
  return {
    left: Math.min(...text.map((b) => b.x)),
    right: Math.max(...text.map((b) => b.x + b.width)),
    height: Math.max(...text.map((b) => b.height)),
  };
}

// Pushes apart rows whose lines overlap vertically.
//
// The band pass above resolves collisions ALONG a line and only ever rewrites x; nothing
// has ever adjusted y, so a stack of rows placed from estimates could and did land on top
// of one another. Two lines of a contact block sit ~13 units apart on this artwork while
// the estimate routinely gives them a 20-unit line box, and the band pass does not fire
// because they are correctly judged to be different lines.
//
// Collisions are measured on the font's LINE box — getBBox's own height for a <text> —
// rather than on the ink, because line box is what line spacing is defined against: two
// lines whose ink clears by a hair but whose line boxes interleave are set too tight.
//
// Anchored rows never move: their position is measured from the artwork and is the one
// thing known good. They still act as obstacles, so an estimated row is pushed clear of
// them as it would be of anything else.
function deOverlapRowsVertically(
  root: Element,
  placed: { id: string; el: Element; cy: number; target: DOMRect | null }[],
  vb: { x: number; y: number; w: number; h: number },
): void {
  if (placed.length < 2) return;
  const boxes = measureBoxPairs(root, new Map(placed.map((p) => [p.id, `[id="${p.id}"]`])));

  // Overlap is judged in BOTH axes. Two fields sharing a line — which the band pass above
  // has just laid out side by side on purpose — overlap vertically by definition, and
  // pushing one of them down would undo that work and turn a line back into a column.
  // A collision is only a collision when the boxes also overlap horizontally.
  const laid: { x0: number; x1: number; bottom: number }[] = [];
  const order = [...placed].sort((a, b) => a.cy - b.cy);

  let moved = 0;
  for (const item of order) {
    const box = boxes.get(item.id)?.box;
    if (!box) continue;
    const half = box.height / 2;
    const x0 = box.x;
    const x1 = box.x + box.width;
    const clears = () => laid
      .filter((r) => r.x1 > x0 && r.x0 < x1)
      .reduce((lowest, r) => Math.max(lowest, r.bottom), -Infinity);

    if (!item.target && item.cy - half < clears()) {
      // Clamped so a run that has nowhere left to go stops at the bottom edge rather
      // than marching off the canvas.
      const shifted = Math.min(clears() + half, vb.y + vb.h - half);
      if (shifted > item.cy) {
        item.cy = shifted;
        item.el.setAttribute('y', String(item.cy));
        moved++;
      }
    }
    laid.push({ x0, x1, bottom: item.cy + half });
  }
  if (moved > 0) console.log(`[text-rows] pushed ${moved} overlapping row(s) apart vertically`);
}

// Appends one top-level <text> element per detected row and returns the matching layer
// entries, in document order. Deliberately flat: every row is its own layer, so the
// element list has no sub-rows and each field is selected, moved and styled on its own.
//
// `anchors` are the measured boxes of the source elements being deleted in the same pass
// (see measureRemovedTextBoxes). A row matched to one is placed and sized from that
// geometry rather than from the model's fractions, which is the difference between a
// replacement field landing on the wordmark it replaces and landing near it.
//
// Rows with no anchor fall back to the estimate, and those are then de-overlapped: the
// model estimates each field's centre independently, so two words on one line routinely
// come back with centres closer together than their rendered widths allow. When a band
// collides, its fields are re-laid out left to right around the band's own centre,
// preserving reading order, and clamped inside the viewBox. Anchored rows sit this out —
// real geometry doesn't overlap, and reflowing them would undo the measurement.
export function appendTextRowLayers(
  doc: Document,
  rows: TextRow[],
  vb: { x: number; y: number; w: number; h: number },
  idPrefix = `_text_${Date.now()}`,
  anchors: Map<string, DOMRect> = new Map(),
): SvgLayer[] {
  if (rows.length === 0) return [];
  const root = doc.documentElement;
  // Reading order: down the page, then left to right ALONG each line.
  //
  // Sorting on y with x as a tiebreak does not give that, because the tiebreak only fires
  // on exact equality. The pass reports each row's own centre, so two halves of one
  // heading come back a fraction of a unit apart in y and whichever is smaller leads —
  // which is how "MICHAEL DOE" got drawn as "DOE MICHAEL". Everything downstream depends
  // on this order: the band reflow lays a line out in it, and alignBandsToLines matches
  // rows to lettering by it.
  const byY = [...rows].sort((a, b) => a.yFraction - b.yFraction || a.xFraction - b.xFraction);
  const sorted = groupRowsIntoBands(byY, vb).flatMap((band) =>
    band.rows.map((i) => byY[i]).sort((a, b) => a.xFraction - b.xFraction));
  // Anchor first, then de-duplicate: measured geometry is what makes two rows provably
  // the same line, so the estimates are only ever the fallback comparison.
  const { targets: anchored, lines: rowLines } = resolveAnchors(sorted, vb, anchors);
  const { rows: deduped, targets } = mergeDuplicateRows(sorted, anchored, vb);
  // mergeDuplicateRows can drop rows; the lines follow the rows that survive.
  const keptLines = deduped.map((row) => rowLines[sorted.indexOf(row)] ?? null);

  const placed = deduped.map((row, i) => {
    const id = `${idPrefix}_${i}`;
    const label = row.content.trim() || t('text.defaultContent');
    const target = targets[i];
    const fontSize = Math.max(8, Math.round(row.sizeFraction * vb.h));
    // An anchored row is centred on the ink it replaces; an unanchored one on the model's
    // guess. Both are refined below — the first by measurement, the second by de-overlap.
    const cx = target ? target.x + target.width / 2 : vb.x + row.xFraction * vb.w;
    const cy = target ? target.y + target.height / 2 : vb.y + row.yFraction * vb.h;
    const el = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
    el.id = id;
    el.setAttribute('y', String(cy));
    el.setAttribute('text-anchor', 'middle');
    el.setAttribute('dominant-baseline', 'middle');
    el.setAttribute('font-family', row.font || 'Arial');
    el.setAttribute('font-size', String(fontSize));
    el.setAttribute('font-weight', String(row.weight || 400));
    el.setAttribute('fill', row.color || '#000000');
    const ls = snapLetterSpacing(row.letterSpacing ?? 0);
    if (ls !== 0) el.setAttribute('letter-spacing', `${ls}em`);
    // Sets `x` too, on the element and on every line it emits.
    setTextLines(el, label, cx, row.spans);
    root.appendChild(el);
    return { id, label, row, fontSize, el, cx, cy, target, line: keptLines[i] };
  });

  snapAnchoredRows(root, placed, vb);
  // Before the band pass: it measures widths, and those follow font-size.
  calibrateEstimatedSizes(placed, vb);
  alignRowsToColumns(placed, anchors, vb);

  // Bands of rows sharing a y position, each already in left-to-right order. Anchored
  // rows are excluded outright rather than merely skipped: they must not influence a
  // neighbour's reflow either, since their position is the one thing already known good.
  const bands: (typeof placed)[] = [];
  for (const item of placed) {
    if (item.target) continue;
    const last = bands[bands.length - 1];
    const sameLine = last &&
      Math.abs(item.cy - last[0].cy) <= BAND_SAME_LINE_EM * Math.min(item.fontSize, last[0].fontSize);
    if (sameLine) last.push(item);
    else bands.push([item]);
  }

  const widths = measureTextWidths(root, placed.filter((p) => !p.target).map((p) => p.id));
  for (const band of bands) {
    if (band.length < 2) continue;
    const gap = BAND_GAP_EM * Math.max(...band.map((b) => b.fontSize));
    const w = (id: string) => widths.get(id) ?? 0;

    const collides = band.some((item, i) => {
      const next = band[i + 1];
      return !!next && item.cx + w(item.id) / 2 + gap > next.cx - w(next.id) / 2;
    });
    if (!collides) continue;

    const total = band.reduce((sum, b) => sum + w(b.id), 0) + gap * (band.length - 1);
    const bandLeft  = Math.min(...band.map((b) => b.cx - w(b.id) / 2));
    const bandRight = Math.max(...band.map((b) => b.cx + w(b.id) / 2));
    let cursor = (bandLeft + bandRight) / 2 - total / 2;
    // Keep the run on canvas when it fits; centre the overflow when it doesn't.
    cursor = total <= vb.w
      ? Math.max(vb.x, Math.min(cursor, vb.x + vb.w - total))
      : vb.x + (vb.w - total) / 2;

    for (const item of band) {
      const width = w(item.id);
      item.cx = cursor + width / 2;
      setTextX(item.el, item.cx);
      cursor += width + gap;
    }
  }

  // Last, once every size and x is settled: the line boxes it compares depend on both.
  deOverlapRowsVertically(root, placed, vb);

  // The drawn field keeps its line breaks; the panel row is given the flattened string,
  // since a layer row is one line high.
  return placed.map(({ id, label }) => ({ id, label: label.replace(/\s*\n\s*/g, ' ') }));
}

// Re-sizes and re-centres every anchored row onto the box it replaces, by measuring what
// was actually rendered rather than by deriving a font size from the box.
//
// Deriving would need the box height, and box height is not a font size: the same
// font-size gives a wildly different ink height for "HELLO" and for "gypsy". Measuring
// the replacement and scaling by the width ratio is glyph-, font- and tracking-agnostic,
// and self-corrects — whatever the string, the second measurement is of the real thing.
//
// The two axes use different boxes, because getBBox on a <text> reports a different kind
// of thing on each. Its width is the advance width — measured equal to the canvas advance
// to three decimal places, and within a side bearing of the ink width — so the plain box
// drives the horizontal directly, letter-spacing included. Its height is the font's line
// box, identical for "HELLO" and "gypsy", so the vertical goes through the ink box: the
// targets are ink boxes too, and centring ink on ink is the only comparison that means
// the same thing for both strings.
function snapAnchoredRows(
  root: Element,
  placed: { row: TextRow; id: string; fontSize: number; el: Element; cx: number; cy: number; target: DOMRect | null }[],
  vb: { x: number; y: number; w: number; h: number },
): void {
  let anchored = placed.filter((p) => p.target);
  if (anchored.length === 0) return;
  const selectors = () => new Map(anchored.map((p) => [p.id, `[id="${p.id}"]`]));

  // Pass 1 — size.
  const sized = measureBoxPairs(root, selectors());
  const released: typeof placed = [];
  for (const p of anchored) {
    const measured = sized.get(p.id);
    if (!measured) continue;
    const scaled = p.fontSize * (p.target!.width / measured.box.width);
    if (!Number.isFinite(scaled)) continue;
    // A target the string cannot be shrunk far enough to fit is not this row's extent.
    // It happens when the vision pass names ONE outline for a line instead of all of
    // them: the box is a single glyph, and scaling a whole address onto it bottoms out
    // at the floor. Every such row then renders at 8px, which is how a line of type
    // disappears under its neighbour. The estimate is the better answer — imprecise, but
    // about the right size — so the anchor is given up and the row rejoins the rows that
    // are placed, calibrated and de-overlapped from the model's own numbers.
    // Too small to fit, or so much bigger than the row was estimated that the target
    // cannot be this row's lettering. The second case is the M logo: a contact line
    // anchored to it measures a scale of six or more, and the row renders across the
    // whole card. Both are the same judgement — the box is not this row's extent — and
    // both are better served by the estimate.
    const estimated = Math.max(MIN_SNAPPED_SIZE, p.row.sizeFraction * vb.h);
    if (scaled < MIN_SNAPPED_SIZE || scaled > estimated * SNAP_MAX_GROWTH) {
      p.target = null;
      p.cx = vb.x + p.row.xFraction * vb.w;
      p.cy = vb.y + p.row.yFraction * vb.h;
      p.el.setAttribute('y', String(p.cy));
      setTextX(p.el, p.cx);
      released.push(p);
      continue;
    }
    p.fontSize = Math.round(Math.min(scaled, MAX_SNAPPED_SIZE * vb.h));
    p.el.setAttribute('font-size', String(p.fontSize));
  }
  if (released.length > 0) {
    console.log(
      `[text-rows] gave up ${released.length} anchor(s) that did not fit their text ` +
      `(${released.map((p) => `"${p.row.content}"`).join(', ')}) — placing from the estimate`,
    );
    anchored = anchored.filter((p) => p.target);
    if (anchored.length === 0) return;
  }

  // Pass 2 — position, re-measured so the centring accounts for the new size and for
  // whatever text-anchor and dominant-baseline actually resolved to.
  const resized = measureBoxPairs(root, selectors());
  for (const p of anchored) {
    const measured = resized.get(p.id);
    if (!measured) continue;
    const target = p.target!;
    p.cx += target.x + target.width / 2 - (measured.box.x + measured.box.width / 2);
    p.cy += target.y + target.height / 2 - (measured.ink.y + measured.ink.height / 2);
    setTextX(p.el, p.cx);
    p.el.setAttribute('y', String(p.cy));
  }
}

// Drops removeIds whose element covers ≥ BACKGROUND_AREA_LIMIT of the canvas — a
// background or decoration the vision model mislabeled as text. Shared by the
// strip-text and customise passes so both guard identically. svgRoot must already
// carry the data-ai-idx marks.
const BACKGROUND_AREA_LIMIT = 0.5; // ≥50% of the canvas ⇒ background, never a text run
export const filterOutBackgroundIds = (
  svgRoot: Element,
  removeIds: string[],
  canvasW: number,
  canvasH: number,
  logTag: string,
): string[] => {
  const canvasArea = Math.max(1, canvasW * canvasH);
  // Ink boxes, in root space. The question this asks is how much of the canvas the
  // element's visible mark covers, so a <text> has to be judged on its ink and not on the
  // font's line box — that box runs ascender to descender and is about 1.5x taller than
  // an all-caps string's letters, which is enough on its own to carry a wide wordmark
  // over the limit and have it thrown away as a background. Root space for the matching
  // reason: an element inside a scaled group does not cover the area its own bbox claims.
  const boxes = measureBoxPairs(svgRoot, new Map(removeIds.map((sid) => [sid, `[data-ai-idx="${sid}"]`])));
  return removeIds.filter((sid) => {
    const ink = boxes.get(sid)?.ink;
    if (!ink) return true; // can't measure → trust the model
    const frac = (ink.width * ink.height) / canvasArea;
    if (frac >= BACKGROUND_AREA_LIMIT) {
      console.log(`[${logTag}] skipping removeId ${sid} — ink covers ${(frac * 100).toFixed(0)}% of canvas (background, not text)`);
      return false;
    }
    return true;
  });
};

// True when the element (by id) spans essentially the whole canvas in BOTH dimensions
// — i.e. a background/canvas fill, not foreground artwork. Gates whether the bottom
// layer is excluded from the customise vision image.
const FULL_CANVAS_MIN = 0.9; // ≥90% of both canvas dimensions ⇒ a background layer
export const isFullCanvasLayer = (
  svgRoot: Element,
  elementId: string,
  canvasW: number,
  canvasH: number,
): boolean =>
  withOffscreenSvg(svgRoot, (measureSvg) => {
    const el = measureSvg.querySelector(`[id="${elementId}"]`) as SVGGraphicsElement | null;
    if (!el || typeof el.getBBox !== 'function') return false;
    try {
      const b = el.getBBox();
      return b.width >= FULL_CANVAS_MIN * canvasW && b.height >= FULL_CANVAS_MIN * canvasH;
    } catch {
      return false;
    }
  });

// Which top-level layer, if any, is the document's background: the bottom layer, when
// it either is or contains a shape covering most of the viewBox. Drives the "Canvas"
// row in the element list, locks that layer from dragging, seeds the default hidden
// set, and decides whether the board shows a transparency checkerboard.
//
// Deliberately attribute-based (no layout): it runs on a parsed string before anything
// is in the DOM, unlike isFullCanvasLayer above which measures a live bbox.
const BACKGROUND_MIN_AREA = 0.75; // ≥75% of the viewBox area ⇒ a background shape
export function detectBackgroundLayerId(content: string, layers: SvgLayer[]): string | null {
  if (layers.length === 0) return null;
  const candidate = layers[0];
  const doc = new DOMParser().parseFromString(content, 'image/svg+xml');
  const root = doc.documentElement;
  const canvas = canvasSize(root);
  if (!canvas) return null;
  const [canvasW, canvasH] = canvas;
  const viewBoxArea = canvasW * canvasH;
  const el = doc.getElementById(candidate.id);
  if (!el) return null;

  const coversCanvas = (node: Element): boolean => {
    const tag = node.localName.toLowerCase();
    if (tag === 'rect') {
      const w = parseFloat(node.getAttribute('width') ?? '0');
      const h = parseFloat(node.getAttribute('height') ?? '0');
      return w * h >= viewBoxArea * BACKGROUND_MIN_AREA;
    }
    if (tag === 'circle') {
      const r = parseFloat(node.getAttribute('r') ?? '0');
      return Math.PI * r * r >= viewBoxArea * BACKGROUND_MIN_AREA;
    }
    if (tag === 'ellipse') {
      const rx = parseFloat(node.getAttribute('rx') ?? '0');
      const ry = parseFloat(node.getAttribute('ry') ?? '0');
      return Math.PI * rx * ry >= viewBoxArea * BACKGROUND_MIN_AREA;
    }
    return false;
  };

  // Case 1: the layer element itself is a background shape
  if (coversCanvas(el)) return candidate.id;

  // Case 2: the layer is a group whose first few children include a background shape
  const children = Array.from(el.children).filter(
    (c) => !['defs', 'title', 'desc'].includes(c.localName.toLowerCase())
  );
  if (children.length > 0 && children.length <= 6 && children.some(coversCanvas)) return candidate.id;

  // Case 3: measure it. Real-world assets (the vectorstock downloads especially) draw
  // their backdrop as a <path> or <polygon>, whose coverage can't be read off plain
  // attributes — so fall back to a bbox measurement of the bottom layer.
  try {
    if (isFullCanvasLayer(root, candidate.id, canvasW, canvasH)) return candidate.id;
  } catch {
    /* measurement needs a live DOM; fall through when there isn't one */
  }

  return null;
}

// Canvas dimensions from the root <svg>: viewBox first, then width/height attributes
// (unit suffixes tolerated). Null when neither gives usable numbers.
function canvasSize(root: Element): [number, number] | null {
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return [vb[2], vb[3]];
  const w = parseFloat(root.getAttribute('width') ?? '');
  const h = parseFloat(root.getAttribute('height') ?? '');
  if (w > 0 && h > 0) return [w, h];
  return null;
}

// Tags that actually paint something.
const DRAWABLE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'image', 'use']);
const DRAWABLE_SELECTOR = [...DRAWABLE_TAGS].join(',');

// Drops layer entries whose element an edit has deleted — or left as an empty
// container — so the element list can't keep rows pointing at nothing. The AI passes
// remove elements wholesale (stripped text, removed artwork), and a <g> whose only
// child was removed no longer draws anything even though the group itself survives.
//
// An empty <text> is deliberately still drawable: the editor supports a text layer with
// no words yet, and that layer must stay selectable.
export function pruneMissingLayers(doc: Document, layers: SvgLayer[]): SvgLayer[] {
  return layers.filter((layer) => {
    const el = doc.getElementById(layer.id);
    if (!el) return false;
    if (DRAWABLE_TAGS.has(el.localName.toLowerCase())) return true;
    return !!el.querySelector(DRAWABLE_SELECTOR);
  });
}

// True when a layer paints nothing but white — a plain white backdrop, as opposed to a
// background that is part of the design (a brand colour, a gradient, a photo). Only the
// former is hidden by default, since hiding a coloured background would change how the
// artwork reads.
export function isPlainWhiteLayer(content: string, layerId: string): boolean {
  const doc = new DOMParser().parseFromString(content, 'image/svg+xml');
  const el = doc.getElementById(layerId);
  if (!el) return false;
  const colors = extractLayerColors(el, doc);
  // No detectable paint at all isn't "white" — leave it alone.
  if (colors.length === 0) return false;
  const white = normalizeColor('#ffffff');
  return colors.every((c) => normalizeColor(c) === white);
}

// The colour a background layer paints, for compositing a raster against it. Returns
// null when the layer has no single flat colour — a gradient or a photo has no one
// colour to stand in for it, and guessing would be worse than leaving it transparent.
export function backgroundFillColor(content: string, layerId: string | null): string | null {
  if (!layerId) return null;
  const doc = new DOMParser().parseFromString(content, 'image/svg+xml');
  const el = doc.getElementById(layerId);
  if (!el) return null;
  const colors = extractLayerColors(el, doc);
  return colors.length === 1 ? colors[0] : null;
}

// `background` fills the canvas before the artwork is drawn. It matters when the raster
// is going to a vision model: a PNG with an alpha channel gets flattened onto white
// somewhere downstream, so white artwork on a transparent canvas arrives invisible. That
// is exactly what the customise pass produces, since it deliberately leaves the
// background layer out of the image — pass the colour that layer was painting and the
// artwork stays legible against it. Omit it to keep the transparent canvas.
// The colour each element ACTUALLY APPEARS as in the image, sampled per element.
//
// Not its declared fill. These glyphs declare #6d6e71 inside a mix-blend-mode:multiply
// group, and over the #7d7fbd panel that composites to #353754 — the arithmetic is exact
// (0x6d*0x7d/255 = 0x35, and so on for the other two channels). Reporting #6d6e71 would
// describe the file rather than the artwork, and painting replacement text with it gives
// flat grey where the original reads near-navy.
//
// The backdrop is taken from a ring just OUTSIDE each element's box, not from the box
// itself. A tight glyph box is mostly glyph, so "the commonest colour is the background"
// — which holds for a whole line — is exactly backwards for one letter.
export async function sampleElementInkColors(
  svgString: string,
  boxes: (DOMRect | null)[],
  vb: { x: number; y: number; w: number; h: number },
): Promise<(string | null)[]> {
  const out: (string | null)[] = boxes.map(() => null);
  if (!boxes.some(Boolean)) return out;

  const scale = Math.min(SAMPLE_MAX_PX / Math.max(vb.w, vb.h, 1), SAMPLE_MAX_SCALE);
  const w = Math.max(1, Math.round(vb.w * scale));
  const h = Math.max(1, Math.round(vb.h * scale));

  const ctx = await new Promise<CanvasRenderingContext2D | null>((resolve) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const c = canvas.getContext('2d', { willReadFrequently: true });
      if (c) c.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
  if (!ctx) return out;

  const histogram = (x0: number, y0: number, bw: number, bh: number) => {
    const map = new Map<number, { n: number; r: number; g: number; b: number }>();
    if (bw < 1 || bh < 1) return map;
    let data: Uint8ClampedArray;
    try { data = ctx.getImageData(x0, y0, bw, bh).data; } catch { return map; }
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 128) continue;
      const [r, g, b] = [data[p], data[p + 1], data[p + 2]];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const cur = map.get(key);
      if (cur) { cur.n++; cur.r += r; cur.g += g; cur.b += b; }
      else map.set(key, { n: 1, r, g, b });
    }
    return map;
  };
  const mean = (c: { n: number; r: number; g: number; b: number }) =>
    [c.r / c.n, c.g / c.n, c.b / c.n] as [number, number, number];
  const hex = (p: [number, number, number]) =>
    '#' + p.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  boxes.forEach((box, i) => {
    if (!box) return;
    const bx = Math.round((box.x - vb.x) * scale);
    const by = Math.round((box.y - vb.y) * scale);
    const bw = Math.max(1, Math.round(box.width * scale));
    const bh = Math.max(1, Math.round(box.height * scale));
    const pad = Math.max(2, Math.round(Math.min(bw, bh) * 0.5));

    // Backdrop: the ring around the element, as the commonest colour of the padded box
    // minus the element's own box. Sampled as the padded box's histogram less the inner
    // one, which is the same thing without a second readback.
    const outer = histogram(Math.max(0, bx - pad), Math.max(0, by - pad),
      Math.min(w - Math.max(0, bx - pad), bw + pad * 2),
      Math.min(h - Math.max(0, by - pad), bh + pad * 2));
    const inner = histogram(Math.max(0, bx), Math.max(0, by),
      Math.min(w - Math.max(0, bx), bw), Math.min(h - Math.max(0, by), bh));
    if (inner.size === 0 || outer.size === 0) return;

    for (const [key, c] of inner) {
      const o = outer.get(key);
      if (!o) continue;
      o.n -= c.n; o.r -= c.r; o.g -= c.g; o.b -= c.b;
      if (o.n <= 0) outer.delete(key);
    }
    const ring = [...outer.values()].sort((a, b) => b.n - a.n)[0];
    if (!ring) return;
    const backRgb = mean(ring);

    // Ink: the commonest colour inside that is not the backdrop. Commonest, not furthest —
    // the extreme pixel of a small glyph is as likely to be an artefact as the letter.
    let ink: [number, number, number] | null = null;
    let bestN = 0;
    for (const c of inner.values()) {
      const rgb = mean(c);
      const d = Math.hypot(rgb[0] - backRgb[0], rgb[1] - backRgb[1], rgb[2] - backRgb[2]);
      if (d < SAMPLE_MIN_DISTANCE) continue;
      if (c.n > bestN) { bestN = c.n; ink = rgb; }
    }
    if (ink) out[i] = hex(ink);
  });

  return out;
}

// The colour each row's lettering actually renders as, sampled from the artwork.
//
// Asking the vision pass for it does not work: on this card it returned #ffffff for all
// four rows, when the heading is white and the three contact lines composite to #3a3b5a.
// It got the heading right and generalised the rest — and no prompt makes it measure.
//
// Reading the declared fill is not enough either. Those glyphs declare #6d6e71, a mid
// grey, inside a group with mix-blend-mode:multiply; over the purple card that composites
// to the near-navy you see. Neither the answer nor the source says what the colour IS,
// so it is taken from pixels, where the blend has already happened.
//
// The ink is found by contrast, not by position: the most common colour in a row's box is
// its backdrop, and the ink is whatever sits furthest from that while covering enough of
// the box to be lettering rather than an antialiasing fringe.
export async function sampleRowInkColors(
  svgString: string,
  boxes: (DOMRect | null)[],
  vb: { x: number; y: number; w: number; h: number },
): Promise<(string | null)[]> {
  const out: (string | null)[] = boxes.map(() => null);
  if (!boxes.some(Boolean)) return out;

  const scale = Math.min(SAMPLE_MAX_PX / Math.max(vb.w, vb.h, 1), SAMPLE_MAX_SCALE);
  const w = Math.max(1, Math.round(vb.w * scale));
  const h = Math.max(1, Math.round(vb.h * scale));

  const ctx = await new Promise<CanvasRenderingContext2D | null>((resolve) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const c = canvas.getContext('2d', { willReadFrequently: true });
      if (c) c.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
  if (!ctx) return out;

  const hex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  boxes.forEach((box, i) => {
    if (!box) return;
    const x0 = Math.max(0, Math.floor((box.x - vb.x) * scale));
    const y0 = Math.max(0, Math.floor((box.y - vb.y) * scale));
    const bw = Math.min(w - x0, Math.ceil(box.width * scale));
    const bh = Math.min(h - y0, Math.ceil(box.height * scale));
    if (bw < 1 || bh < 1) return;

    let data: Uint8ClampedArray;
    try { data = ctx.getImageData(x0, y0, bw, bh).data; } catch { return; }

    // Quantised histogram — exact colours never repeat once antialiasing is involved.
    const bucket = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 128) continue;
      const [r, g, b] = [data[p], data[p + 1], data[p + 2]];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = bucket.get(key);
      if (cur) { cur.n++; cur.r += r; cur.g += g; cur.b += b; }
      else bucket.set(key, { n: 1, r, g, b });
    }
    if (bucket.size === 0) return;

    const all = [...bucket.values()].sort((a, b) => b.n - a.n);
    const total = all.reduce((n, c) => n + c.n, 0);
    const back = all[0];
    const backRgb = [back.r / back.n, back.g / back.n, back.b / back.n];

    let ink: typeof back | null = null;
    let best = -1;
    for (const c of all) {
      if (c === back) continue;
      // Enough of the box to be a stroke rather than the soft edge of one.
      if (c.n / total < SAMPLE_MIN_COVERAGE) continue;
      const rgb = [c.r / c.n, c.g / c.n, c.b / c.n];
      const d = Math.hypot(rgb[0] - backRgb[0], rgb[1] - backRgb[1], rgb[2] - backRgb[2]);
      if (d > best) { best = d; ink = c; }
    }
    if (!ink || best < SAMPLE_MIN_DISTANCE) return;
    out[i] = hex(ink.r / ink.n, ink.g / ink.n, ink.b / ink.n);
  });

  return out;
}

// Sampling a row's ink. The raster is capped rather than rendered 1:1 so a large canvas
// does not cost a full-size readback, and floored at 1x so small artwork is not blown up
// into its own antialiasing.
const SAMPLE_MAX_PX = 1400;
const SAMPLE_MAX_SCALE = 3;
// How much of a row's box a colour must cover to be its lettering, and how far it must sit
// from the backdrop before the difference means anything.
const SAMPLE_MIN_COVERAGE = 0.02;
const SAMPLE_MIN_DISTANCE = 24;

export function svgToBase64Png(
  svgString: string, width: number, height: number, background?: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('Canvas unavailable')); return; }
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png').replace('data:image/png;base64,', ''));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed')); };
    img.src = url;
  });
}
