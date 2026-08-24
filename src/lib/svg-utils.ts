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

export function stripScripts(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
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
  font: string; sizeFraction: number;
  weight: number; color: string; content: string;
  letterSpacing: number;
  removeIds?: string[];
};

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

// How far a row's estimated centre may sit from an unclaimed box before the two stop
// being plausibly the same line, as a fraction of the larger viewBox dimension. Only
// used for rows the model didn't tag with removeIds.
const ANCHOR_MATCH_RADIUS = 0.25;
// Ceiling on a snapped font size, as a fraction of the viewBox height. A sanity bound on
// the OUTPUT, deliberately not a bound on how far the measurement may drag the model's
// estimate: the estimate is the untrusted input here, and a wordmark the model sized at
// 5% of the canvas when it really fills 18% needs a 3.6x correction to land — exactly the
// case worth fixing. Only a result larger than the canvas itself is self-evidently wrong.
const MAX_SNAPPED_SIZE = 1.0;

// How much closer another row's estimate must be before a link is judged mis-assigned.
// A margin rather than a plain comparison because rows sharing a line sit near each
// other's estimates by nature, and a near-tie is not evidence of anything.
const MISMATCH_MARGIN = 0.8;

// Discards anchors that belong to a different row than the one claiming them.
//
// The linking is the model's, and on artwork where each label is a pile of letter paths
// it can come back shuffled — a diagram whose eight labels were linked to the eight label
// ids in almost reverse order, so every label anchored onto a different label's geometry
// and the whole stack landed scrambled. Nothing downstream can detect that: the boxes are
// real, the measurement is exact, only the pairing is wrong.
//
// The estimates are the independent second opinion. They are imprecise — that is why
// anchoring exists — but they are never shuffled, because they are read straight off the
// raster. So require the two to at least agree on WHICH row is which: a row's anchor must
// sit nearer that row's own estimate than any other row's. When it doesn't, the link is
// not trustworthy and the row falls back to the estimate, which is exactly where it sat
// before any of this existed.
function dropMismatchedAnchors(
  rows: TextRow[],
  targets: (DOMRect | null)[],
  vb: { x: number; y: number; w: number; h: number },
  // Hands the row's ids back to the pool, so the boxes a rejected link was holding are
  // available to whichever row actually belongs on them.
  release: (row: number) => void,
): void {
  if (rows.length < 2) return;
  const estimates = rows.map((r) => ({ x: vb.x + r.xFraction * vb.w, y: vb.y + r.yFraction * vb.h }));
  const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  rows.forEach((row, i) => {
    const t = targets[i];
    if (!t) return;
    const centre = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    const own = dist2(centre, estimates[i]);
    const stolen = estimates.findIndex((e, j) => j !== i && dist2(centre, e) < own * MISMATCH_MARGIN ** 2);
    if (stolen === -1) return;
    console.log(
      `[text-rows] dropping anchor for "${row.content}" — its geometry sits nearer the row for "${rows[stolen].content}", so the model's row↔element linking is unreliable here; falling back to the estimate`,
    );
    targets[i] = null;
    release(i);
  });
}

// Pairs each row with the box its original lettering occupied, parallel to `rows`.
//
// Rows naming removeIds claim those boxes outright — the model tagged them, and it is the
// only party that knows which outlines spell which word. Untagged rows then take the
// nearest unclaimed box, which is a guess and is fenced as one: no box within
// ANCHOR_MATCH_RADIUS means no anchor, and the row keeps the model's estimate.
function resolveAnchors(
  rows: TextRow[],
  vb: { x: number; y: number; w: number; h: number },
  anchors: Map<string, DOMRect>,
): (DOMRect | null)[] {
  const targets: (DOMRect | null)[] = rows.map(() => null);
  const claimed = new Set<string>();
  // Which ids each row took, so a rejected link can hand them back. Without that the
  // boxes stay locked to the row that was just told it may not have them, and the repair
  // below finds nothing free — every row falls back to its estimate and the measured
  // geometry goes unused even though it is sitting right there.
  const claimedBy: string[][] = rows.map(() => []);

  rows.forEach((row, i) => {
    const ids = (row.removeIds ?? []).filter((sid) => anchors.has(sid) && !claimed.has(sid));
    const box = unionBox(ids.map((sid) => anchors.get(sid)!));
    if (!box) return;
    ids.forEach((sid) => claimed.add(sid));
    claimedBy[i] = ids;
    targets[i] = box;
  });

  dropMismatchedAnchors(rows, targets, vb, (i) => {
    claimedBy[i].forEach((sid) => claimed.delete(sid));
    claimedBy[i] = [];
  });

  // Whatever is still unanchored — never linked, or linked and rejected — takes the
  // nearest box nobody has claimed. `rows` is in reading order, so walking it in order
  // consumes the boxes in reading order too, which is what repairs a shuffled linking:
  // the rows and the boxes describe the same lines top to bottom even when the model
  // paired them up wrongly.
  //
  // Resolving the globally closest pairs first was tried instead and is worse. The
  // estimates are not just noisy but systematically compressed against the real
  // geometry — on the diagram above they spanned 60 units where the artwork spanned 134
  // — so "closest" stops tracking "corresponding" partway down the list, and greedy
  // matching cross-assigns rows that sequential matching gets right.
  const limit = ANCHOR_MATCH_RADIUS * Math.max(vb.w, vb.h);
  rows.forEach((row, i) => {
    if (targets[i]) return;
    const cx = vb.x + row.xFraction * vb.w;
    const cy = vb.y + row.yFraction * vb.h;
    let best: { sid: string; box: DOMRect; d: number } | null = null;
    for (const [sid, box] of anchors) {
      if (claimed.has(sid)) continue;
      const d = Math.hypot(box.x + box.width / 2 - cx, box.y + box.height / 2 - cy);
      if (d <= limit && (!best || d < best.d)) best = { sid, box, d };
    }
    if (!best) return;
    claimed.add(best.sid);
    targets[i] = best.box;
  });

  return targets;
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
  const keptRows: TextRow[] = [];
  const keptTargets: (DOMRect | null)[] = [];
  const keptExtents: RowExtent[] = [];
  let merged = 0;

  rows.forEach((row, i) => {
    const target = targets[i];
    const extent = rowExtent(row, target, vb);
    const at = keptExtents.findIndex((k) => sameVisibleLine(k, extent));
    if (at === -1) {
      keptRows.push(row);
      keptTargets.push(target);
      keptExtents.push(extent);
      return;
    }
    merged++;
    keptRows[at] = {
      ...keptRows[at],
      removeIds: [...new Set([...(keptRows[at].removeIds ?? []), ...(row.removeIds ?? [])])],
    };
    const combined = unionBox([keptTargets[at], target].filter((b): b is DOMRect => !!b));
    keptTargets[at] = combined;
    keptExtents[at] = rowExtent(keptRows[at], combined, vb);
  });

  if (merged > 0) {
    console.log(`[text-rows] merged ${merged} duplicate row(s) — same content, same place`);
  }
  return { rows: keptRows, targets: keptTargets };
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
  const sorted = [...rows].sort((a, b) => a.yFraction - b.yFraction || a.xFraction - b.xFraction);
  // Anchor first, then de-duplicate: measured geometry is what makes two rows provably
  // the same line, so the estimates are only ever the fallback comparison.
  const anchored = resolveAnchors(sorted, vb, anchors);
  const { rows: deduped, targets } = mergeDuplicateRows(sorted, anchored, vb);

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
    el.setAttribute('x', String(cx));
    el.setAttribute('y', String(cy));
    el.setAttribute('text-anchor', 'middle');
    el.setAttribute('dominant-baseline', 'middle');
    el.setAttribute('font-family', row.font || 'Arial');
    el.setAttribute('font-size', String(fontSize));
    el.setAttribute('font-weight', String(row.weight || 400));
    el.setAttribute('fill', row.color || '#000000');
    const ls = snapLetterSpacing(row.letterSpacing ?? 0);
    if (ls !== 0) el.setAttribute('letter-spacing', `${ls}em`);
    el.textContent = label;
    root.appendChild(el);
    return { id, label, row, fontSize, el, cx, cy, target };
  });

  snapAnchoredRows(root, placed, vb);

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
      item.el.setAttribute('x', String(item.cx));
      cursor += width + gap;
    }
  }

  return placed.map(({ id, label }) => ({ id, label }));
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
  placed: { id: string; fontSize: number; el: Element; cx: number; cy: number; target: DOMRect | null }[],
  vb: { x: number; y: number; w: number; h: number },
): void {
  const anchored = placed.filter((p) => p.target);
  if (anchored.length === 0) return;
  const selectors = () => new Map(anchored.map((p) => [p.id, `[id="${p.id}"]`]));

  // Pass 1 — size.
  const sized = measureBoxPairs(root, selectors());
  for (const p of anchored) {
    const measured = sized.get(p.id);
    if (!measured) continue;
    const scaled = p.fontSize * (p.target!.width / measured.box.width);
    if (!Number.isFinite(scaled)) continue;
    p.fontSize = Math.round(Math.min(Math.max(scaled, 8), MAX_SNAPPED_SIZE * vb.h));
    p.el.setAttribute('font-size', String(p.fontSize));
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
    p.el.setAttribute('x', String(p.cx));
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
