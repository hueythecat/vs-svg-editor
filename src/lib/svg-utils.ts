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

// Return the direct <text id="..."> child of layerEl that contains the click target,
// or null if the click didn't land inside any identified text child.
export function findClickedSubText(layerEl: Element, clickTarget: EventTarget | null): Element | null {
  if (!(clickTarget instanceof Element)) return null;
  for (const child of Array.from(layerEl.children)) {
    if (child.tagName.toLowerCase() === 'text' && child.id &&
        (child === clickTarget || child.contains(clickTarget))) {
      return child;
    }
  }
  return null;
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
