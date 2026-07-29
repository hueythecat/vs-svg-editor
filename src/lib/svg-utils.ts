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

export function parseSvg(raw: string): { content: string; layers: SvgLayer[] } {
  try {
    const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return { content: raw, layers: [] };

    const svg = doc.documentElement;
    const layers: SvgLayer[] = [];

    Array.from(svg.children).forEach((child, i) => {
      if (SKIP_TAGS.has(child.tagName.toLowerCase())) return;
      if (!child.id) child.id = `_layer_${i}`;

      const label =
        child.getAttribute('data-name')?.trim() ||
        child.getAttribute('inkscape:label')?.trim() ||
        (!child.id.startsWith('_layer_') ? child.id : null) ||
        `Layer ${layers.length + 1}`;

      layers.push({ id: child.id, label });
    });

    // Serialize the SVG element only (no XML declaration)
    const content = new XMLSerializer().serializeToString(svg);
    return { content, layers };
  } catch {
    return { content: raw, layers: [] };
  }
}

// Returns the element's bounding box in SVG root coordinate space,
// correctly accounting for the element's own transform attribute.
export function bboxInRootSpace(svgEl: SVGSVGElement, el: SVGGraphicsElement): DOMRect | null {
  try {
    const local = el.getBBox();
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

// Arc path for curved text. The arc midpoint is always pinned at cy so the
// centre character never moves as the curve slider changes.
// Bowl (curve>0): chord at cy-h (endpoints above cy), arc bottom at cy.
// Arch (curve<0): chord at cy+h (endpoints below cy), arc peak at cy.
export function computeArcPath(cx: number, cy: number, halfW: number, curve: number): string {
  const h = halfW * Math.abs(curve) / 100;
  const r = (halfW * halfW + h * h) / (2 * h);
  const sweep = curve > 0 ? 1 : 0;
  const chordY = curve > 0 ? cy - h : cy + h;
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
  const holder = document.createElement('div');
  holder.setAttribute('style', 'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden');
  holder.appendChild(measureSvg);
  document.body.appendChild(holder);
  try {
    return fn(measureSvg);
  } finally {
    document.body.removeChild(holder);
  }
};

// ─── AI text rows → editable text layers ─────────────────────────────────────

// One line of text the vision pass found, in canvas-relative fractions.
export type TextRow = {
  yFraction: number; xFraction: number;
  font: string; sizeFraction: number;
  weight: number; color: string; content: string;
  letterSpacing: number;
};

// Letter-spacing steps the inspector's slider offers. AI estimates are snapped onto
// them so a re-created field can still be adjusted by hand afterwards.
const LS_OPTIONS = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3];
const snapLetterSpacing = (v: number) =>
  LS_OPTIONS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// Rows whose vertical centres are within this fraction of the canvas height read as
// one horizontal band — the only rows that can collide with each other.
const BAND_Y_THRESHOLD = 0.03;
// Space kept between two fields in the same band, as a fraction of the larger font size.
const BAND_GAP_EM = 0.25;

// Rendered width of each id, measured off-screen. Falls back to a glyph-count estimate
// for anything unmeasurable (detached geometry, no live DOM under test).
function measureTextWidths(root: Element, ids: string[]): Map<string, number> {
  const widths = new Map<string, number>();
  const estimate = (el: Element | null) => {
    const len = (el?.textContent ?? '').length;
    const fs = Number(el?.getAttribute('font-size') ?? 16);
    return Math.max(1, len * fs * 0.55);
  };
  try {
    withOffscreenSvg(root, (measureSvg) => {
      ids.forEach((id) => {
        const el = measureSvg.querySelector(`[id="${id}"]`) as SVGGraphicsElement | null;
        let w = 0;
        try { w = el?.getBBox?.().width ?? 0; } catch { /* unrenderable — estimate below */ }
        widths.set(id, w > 0 ? w : estimate(el));
      });
    });
  } catch {
    ids.forEach((id) => widths.set(id, estimate(root.querySelector(`[id="${id}"]`))));
  }
  return widths;
}

// Appends one top-level <text> element per detected row and returns the matching layer
// entries, in document order. Deliberately flat: every row is its own layer, so the
// element list has no sub-rows and each field is selected, moved and styled on its own.
//
// Rows sharing a horizontal band are then de-overlapped: the model estimates each
// field's centre independently, so two words on one line routinely come back with
// centres closer together than their rendered widths allow. When a band collides, its
// fields are re-laid out left to right around the band's own centre, preserving reading
// order, and clamped inside the viewBox.
export function appendTextRowLayers(
  doc: Document,
  rows: TextRow[],
  vb: { x: number; y: number; w: number; h: number },
  idPrefix = `_text_${Date.now()}`,
): SvgLayer[] {
  if (rows.length === 0) return [];
  const root = doc.documentElement;
  const sorted = [...rows].sort((a, b) => a.yFraction - b.yFraction || a.xFraction - b.xFraction);

  const placed = sorted.map((row, i) => {
    const id = `${idPrefix}_${i}`;
    const label = row.content.trim() || 'Text';
    const fontSize = Math.max(8, Math.round(row.sizeFraction * vb.h));
    const el = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
    el.id = id;
    el.setAttribute('x', String(vb.x + row.xFraction * vb.w));
    el.setAttribute('y', String(vb.y + row.yFraction * vb.h));
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
    return { id, label, row, fontSize, el, cx: vb.x + row.xFraction * vb.w };
  });

  // Bands of rows sharing a y position, each already in left-to-right order.
  const bands: (typeof placed)[] = [];
  for (const item of placed) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(item.row.yFraction - last[0].row.yFraction) <= BAND_Y_THRESHOLD) last.push(item);
    else bands.push([item]);
  }

  const widths = measureTextWidths(root, placed.map((p) => p.id));
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
  return withOffscreenSvg(svgRoot, (measureSvg) =>
    removeIds.filter((sid) => {
      const probe = measureSvg.querySelector(`[data-ai-idx="${sid}"]`) as SVGGraphicsElement | null;
      if (!probe || typeof probe.getBBox !== 'function') return true; // can't measure → trust the model
      try {
        const b = probe.getBBox();
        const frac = (b.width * b.height) / canvasArea;
        if (frac >= BACKGROUND_AREA_LIMIT) {
          console.log(`[${logTag}] skipping removeId ${sid} — bbox covers ${(frac * 100).toFixed(0)}% of canvas (background, not text)`);
          return false;
        }
      } catch { /* unrenderable geometry — leave the call to the model */ }
      return true;
    }),
  );
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

export function svgToBase64Png(svgString: string, width: number, height: number): Promise<string> {
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
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png').replace('data:image/png;base64,', ''));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed')); };
    img.src = url;
  });
}
