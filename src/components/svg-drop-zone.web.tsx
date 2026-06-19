import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SvgLayer {
  id: string;
  label: string;
}

interface ActiveSvg {
  name: string;
  src: string;           // thumbnail / blob URL
  content: string;       // serialized SVG string (layer IDs injected)
  originalContent: string; // content as first parsed — used for reset
  layers: SvgLayer[];    // top-level <g> children, in document order
  objectUrl?: string;
}

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

// ─── SVG processing ───────────────────────────────────────────────────────────

function stripScripts(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
}

// Tags that are metadata/definitions, not visual layers
const SKIP_TAGS = new Set([
  'defs', 'style', 'title', 'desc', 'metadata',
  'lineargradient', 'radialgradient', 'pattern',
  'clippath', 'mask', 'filter', 'marker',
]);

function parseSvg(raw: string): { content: string; layers: SvgLayer[] } {
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

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex2 = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex2(f(0))}${hex2(f(8))}${hex2(f(4))}`;
}

// Returns the element's bounding box in SVG root coordinate space,
// correctly accounting for the element's own transform attribute.
function bboxInRootSpace(svgEl: SVGSVGElement, el: SVGGraphicsElement): DOMRect | null {
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
function findClickedSubText(layerEl: Element, clickTarget: EventTarget | null): Element | null {
  if (!(clickTarget instanceof Element)) return null;
  for (const child of Array.from(layerEl.children)) {
    if (child.tagName.toLowerCase() === 'text' && child.id &&
        (child === clickTarget || child.contains(clickTarget))) {
      return child;
    }
  }
  return null;
}

function applyTranslateDelta(existing: string, dx: number, dy: number): string {
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
function computeArcPath(cx: number, cy: number, halfW: number, curve: number): string {
  const h = halfW * Math.abs(curve) / 100;
  const r = (halfW * halfW + h * h) / (2 * h);
  const sweep = curve > 0 ? 1 : 0;
  const chordY = curve > 0 ? cy - h : cy + h;
  return `M ${cx - halfW} ${chordY} A ${r} ${r} 0 0 ${sweep} ${cx + halfW} ${chordY}`;
}

function normalizeColor(color: string): string {
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

const COLOR_PAINT_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color'];

// Returns the gradient element that actually owns <stop> children, following xlink:href / href chains.
function resolveGradient(id: string, doc: Document): Element | null {
  const el = doc.getElementById(id);
  if (!el) return null;
  const href = el.getAttribute('xlink:href') ?? el.getAttribute('href') ?? '';
  if (href.startsWith('#')) return doc.getElementById(href.slice(1)) ?? el;
  return el;
}

// Collects IDs of all gradients (linearGradient / radialGradient) referenced by a layer via
// direct fill/stroke attrs, inline styles, and CSS class rules.
function collectLayerGradientIds(layerEl: Element, layerClasses: Set<string>, doc: Document): Set<string> {
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

function extractLayerColors(layerEl: Element, doc: Document): string[] {
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

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; }
  return h.toString(36);
}

function svgToBase64Png(svgString: string, width: number, height: number): Promise<string> {
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

// ─── Icons ───────────────────────────────────────────────────────────────────

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
      stroke="currentColor" strokeWidth={1.75} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

function EyeSlashIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
      stroke="currentColor" strokeWidth={1.75} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}


function GripIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 14" fill="currentColor" className={className}>
      <circle cx="1.5" cy="1.5"  r="1.5" />
      <circle cx="6.5" cy="1.5"  r="1.5" />
      <circle cx="1.5" cy="7"    r="1.5" />
      <circle cx="6.5" cy="7"    r="1.5" />
      <circle cx="1.5" cy="12.5" r="1.5" />
      <circle cx="6.5" cy="12.5" r="1.5" />
    </svg>
  );
}


function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
      stroke="currentColor" strokeWidth={1.75} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg>
  );
}

const TAXONOMY_COLOURS: Record<string, string> = {
  text:       'text-amber-400',
  background: 'text-zinc-400',
  icon:       'text-sky-400',
  graphic:    'text-sky-400',
  decoration: 'text-purple-400',
  shape:      'text-emerald-400',
  image:      'text-rose-400',
};

type TaxonomyGroup = { type: string; elements: string[] }; // elements are human-readable descriptions

// ─── Component ───────────────────────────────────────────────────────────────

export function SvgDropZone() {
  const [activeSvg, setActiveSvg]       = useState<ActiveSvg | null>(null);
  const [activeSample, setActiveSample] = useState<SampleName | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [selectedLayer, setSelectedLayer]   = useState<string | null>(null);
  const [selectedLayers, setSelectedLayers] = useState<Set<string>>(new Set());
  const [dragLayerId, setDragLayerId]   = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<{ targetId: string; before: boolean } | null>(null);
  const [isLoading, setIsLoading]       = useState(false);
  const [isDragging, setIsDragging]     = useState(false);
  const [, setDragCounter]   = useState(0);
  const [canvasDrag, setCanvasDrag] = useState<{
    layerIds: string[];
    startClientX: number; startClientY: number;
    startSvgX: number;   startSvgY: number;
    baseTransforms: Record<string, string>;
  } | null>(null);
  const [textForm, setTextForm] = useState({ content: 'Text', font: 'Arial', size: 48, weight: 400, color: '#000000', curve: 0, letterSpacing: 0 });
  const [aiLoading, setAiLoading]         = useState(false);
  const [aiError, setAiError]             = useState<string | null>(null);
  const [aiStatusMsg, setAiStatusMsg]     = useState<string>('Thinking…');
  const [colorReplaceFrom, setColorReplaceFrom] = useState<string>('');
  const [colorReplaceTo, setColorReplaceTo]     = useState<string>('#000000');
  const [fontSuggestion, setFontSuggestion]   = useState<string | null>(null);
  const [suggestedFontName, setSuggestedFontName] = useState<string | null>(null);
  const [extraFonts, setExtraFonts]           = useState<string[]>([]);
  const [imageFonts, setImageFonts]           = useState<Array<{ font: string; reason: string }> | null>(null);
  const [imageFontsLoading, setImageFontsLoading] = useState(false);
  const [showImageFonts, setShowImageFonts]   = useState(false);
  const [taxonomy, setTaxonomy]           = useState<TaxonomyGroup[] | null>(null);
  const [taxonomyLoading, setTaxonomyLoading] = useState(false);
  const [taxonomyOpen, setTaxonomyOpen]       = useState(false);
  const [textFormOpen, setTextFormOpen]       = useState(true);
  const [aiActionsOpen, setAiActionsOpen]     = useState(true);
  const [suggestFontsOpen, setSuggestFontsOpen] = useState(true);
  const [removeTextQuery, setRemoveTextQuery] = useState('');
  const [showRemoveTextInput, setShowRemoveTextInput] = useState(false);
  const [textCheckResult, setTextCheckResult] = useState<{ heading: string; subheading: string } | null>(null);
  const [colorReplaceOpen, setColorReplaceOpen] = useState(true);
  const [inlineEdit, setInlineEdit] = useState<{
    layerId: string;
    left: number; top: number; width: number; height: number;
    fontSize: number; fontFamily: string; fontWeight: number; color: string;
  } | null>(null);
  const [selectedSubElId, setSelectedSubElId] = useState<string | null>(null);
  const dragMovedRef            = useRef(false);
  const aiCacheRef              = useRef<Map<string, string>>(new Map());
  const colorBaselineRef        = useRef<string | null>(null);
  const undoStackRef             = useRef<Array<{ content: string; layers: SvgLayer[] }>>([]);
  const [undoCount, setUndoCount] = useState(0);
  // Panel drag — use refs so onPointerMove/Up handlers always see current values
  const panelDragIdRef          = useRef<string | null>(null);
  const panelDropPositionRef    = useRef<{ targetId: string; before: boolean } | null>(null);
  const panelReorderDoneRef     = useRef(false); // suppresses the post-drag click
  const layerListRef            = useRef<HTMLDivElement>(null);
  const fileInputRef            = useRef<HTMLInputElement>(null);
  const svgCanvasRef            = useRef<HTMLDivElement>(null);
  const curveStartCenterYRef    = useRef<number | null>(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const revokePrev = useCallback((svg: ActiveSvg | null) => {
    if (svg?.objectUrl) URL.revokeObjectURL(svg.objectUrl);
  }, []);

  const snapshotForUndo = useCallback((content: string, layers: SvgLayer[]) => {
    undoStackRef.current = [...undoStackRef.current.slice(-9), { content, layers }];
    setUndoCount(undoStackRef.current.length);
  }, []);

  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    setUndoCount(undoStackRef.current.length);
    if (!prev) return;
    setActiveSvg((p) => p ? { ...p, content: prev.content, layers: prev.layers } : null);
  }, []);

  const applyParsed = useCallback(
    (raw: string, name: string, src: string, objectUrl?: string) => {
      const cleaned = stripScripts(raw);
      const { content, layers } = parseSvg(cleaned);
      setActiveSvg((prev) => { revokePrev(prev); return { name, src, content, originalContent: content, layers, objectUrl }; });
      setHiddenLayers(new Set());
      setSelectedLayer(null);
      setSelectedLayers(new Set());
      setIsLoading(false);
      undoStackRef.current = [];
      setUndoCount(0);
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
    async (sample: (typeof SAMPLES)[number]) => {
      setIsLoading(true);
      setActiveSample(sample.name);
      try {
        const text = await fetch(sample.src).then((r) => r.text());
        applyParsed(text, sample.name, sample.src);
      } catch (err) {
        console.error('Failed to load sample', sample.name, err);
        setIsLoading(false);
      }
    },
    [applyParsed]
  );

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
    setSelectedSubElId(null);
  }, []);

  const clear = useCallback(() => {
    setActiveSvg((prev) => { revokePrev(prev); return null; });
    setActiveSample(null);
    setHiddenLayers(new Set());
    setSelectedLayer(null);
    setSelectedLayers(new Set());
    setSelectedSubElId(null);
  }, [revokePrev]);

  // ── Layer toggle ───────────────────────────────────────────────────────────

  const toggleLayer = useCallback((id: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Click on canvas: walk up from the clicked element to find its layer
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragMovedRef.current) { dragMovedRef.current = false; return; }
    if (!activeSvg?.layers.length) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let el = e.target as Element | null;
    while (el && el !== (svgEl as Element)) {
      if (el.parentElement === (svgEl as Element) && layerIds.has(el.id)) {
        const clickedId = el.id;
        const subElId = findClickedSubText(el, e.target)?.id ?? null;
        if (e.shiftKey) {
          setSelectedLayers((prev) => {
            const next = new Set(prev);
            if (next.has(clickedId)) next.delete(clickedId); else next.add(clickedId);
            return next;
          });
          setSelectedLayer(clickedId);
          setSelectedSubElId(null);
        } else if (subElId) {
          setSelectedLayer(clickedId);
          setSelectedLayers(new Set([clickedId]));
          setSelectedSubElId(subElId);
        } else {
          const next = selectedLayer === clickedId ? null : clickedId;
          setSelectedLayer(next);
          setSelectedLayers(next ? new Set([next]) : new Set());
          setSelectedSubElId(null);
        }
        return;
      }
      el = el.parentElement;
    }
    selectOne(null);
  }, [activeSvg, selectedLayer, selectOne]);

  // mousedown on canvas: begin drag if the pointer is over any selected layer
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedLayers.size || !activeSvg?.layers.length) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const selectedEls = [...selectedLayers]
      .map((id) => svgEl.querySelector(`#${CSS.escape(id)}`))
      .filter(Boolean) as Element[];
    if (!selectedEls.length) return;

    // Only start drag if the pointer is inside one of the selected layer elements
    let el = e.target as Element | null;
    let hit = false;
    while (el && el !== svgEl) {
      if (selectedEls.includes(el)) { hit = true; break; }
      el = el.parentElement;
    }
    if (!hit) return;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    dragMovedRef.current = false;

    const baseTransforms: Record<string, string> = {};
    [...selectedLayers].forEach((id) => {
      const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
      if (layerEl) baseTransforms[id] = layerEl.getAttribute('transform') ?? '';
    });

    snapshotForUndo(activeSvg!.content, activeSvg!.layers);
    setCanvasDrag({
      layerIds: [...selectedLayers],
      startClientX: e.clientX, startClientY: e.clientY,
      startSvgX: svgPt.x,      startSvgY: svgPt.y,
      baseTransforms,
    });
  }, [selectedLayers, activeSvg, snapshotForUndo]);

  const handleCanvasDblClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeSvg?.layers.length) return;
    const canvasEl = svgCanvasRef.current;
    const svgEl = canvasEl?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl || !canvasEl) return;
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let target = e.target as Element | null;
    while (target && target !== (svgEl as Element)) {
      if (target.parentElement === (svgEl as Element) && layerIds.has(target.id)) {
        const isTextLayer =
          target.getAttribute('data-text-layer') === '1' ||
          target.tagName.toLowerCase() === 'text' ||
          !!target.querySelector('text');
        if (!isTextLayer) return;
        selectOne(target.id);
        // For plain groups with multiple <text> children, find which one was clicked
        let textEl: SVGTextElement | null = null;
        let subElId: string | null = null;
        if (target.tagName.toLowerCase() === 'text') {
          textEl = target as SVGTextElement;
        } else if (target.getAttribute('data-text-layer') === '1') {
          textEl = target.querySelector('text') as SVGTextElement | null;
        } else {
          const found = findClickedSubText(target, e.target);
          if (found) { textEl = found as SVGTextElement; subElId = found.id || null; }
        }
        if (!textEl) return;
        if (subElId) setSelectedSubElId(subElId);
        const textRect = textEl.getBoundingClientRect();
        const canvasRect = canvasEl.getBoundingClientRect();
        const ctm = svgEl.getScreenCTM();
        const svgFontSize = parseFloat(textEl.getAttribute('font-size') ?? '16');
        const fontSize = ctm ? svgFontSize * ctm.a : svgFontSize;
        setInlineEdit({
          layerId: subElId ?? target.id,
          left:   textRect.left - canvasRect.left + canvasEl.scrollLeft,
          top:    textRect.top  - canvasRect.top  + canvasEl.scrollTop,
          width:  Math.max(textRect.width,  80),
          height: Math.max(textRect.height, fontSize * 1.4),
          fontSize,
          fontFamily: textEl.getAttribute('font-family') ?? 'Arial',
          fontWeight: parseFloat(textEl.getAttribute('font-weight') ?? '400'),
          color: textEl.getAttribute('fill') ?? '#000000',
        });
        return;
      }
      target = target.parentElement;
    }
  }, [activeSvg, selectOne]);

  // Global mouse listeners while a canvas drag is active
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
      const pt = svgEl.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const cur = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
      const dx = cur.x - canvasDrag.startSvgX;
      const dy = cur.y - canvasDrag.startSvgY;
      canvasDrag.layerIds.forEach((id) => {
        const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
        if (layerEl) {
          layerEl.setAttribute(
            'transform',
            `translate(${dx}, ${dy}) ${canvasDrag.baseTransforms[id]}`.trim(),
          );
        }
      });
      svgEl.querySelector('#__svghl__')?.remove();
    };

    const onUp = () => {
      if (svgEl && dragMovedRef.current) {
        svgEl.querySelector('#__svghl__')?.remove();
        const content = new XMLSerializer().serializeToString(svgEl);
        setActiveSvg((prev) => (prev ? { ...prev, content } : null));
      }
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
  }, [canvasDrag]);

  // Scroll the matching panel row into view whenever selectedLayer changes
  useEffect(() => {
    if (!selectedLayer) return;
    document
      .querySelector(`[data-layer-id="${selectedLayer}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedLayer]);

  // ── SVG selection highlight (perforated rect injected into SVG DOM) ─────────

  useLayoutEffect(() => {
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    svgEl?.querySelector('#__svghl__')?.remove();
    if (!selectedLayers.size || !svgEl || canvasDrag) return;
    const ns = 'http://www.w3.org/2000/svg';
    const pad = 4;
    const container = document.createElementNS(ns, 'g');
    container.id = '__svghl__';
    container.setAttribute('pointer-events', 'none');

    const addRect = (id: string, color: string, dashArray: string) => {
      const targetEl = svgEl.querySelector(`#${CSS.escape(id)}`);
      if (!targetEl) return;
      const bbox = bboxInRootSpace(svgEl, targetEl as SVGGraphicsElement);
      if (!bbox || (!bbox.width && !bbox.height)) return;
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(bbox.x - pad));
      rect.setAttribute('y', String(bbox.y - pad));
      rect.setAttribute('width',  String(bbox.width  + pad * 2));
      rect.setAttribute('height', String(bbox.height + pad * 2));
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-width', '2');
      rect.setAttribute('stroke-dasharray', dashArray);
      rect.setAttribute('vector-effect', 'non-scaling-stroke');
      container.appendChild(rect);
    };

    [...selectedLayers].forEach((id) => addRect(id, '#3b82f6', '6 4'));
    if (selectedSubElId) addRect(selectedSubElId, '#f59e0b', '4 3');

    if (container.children.length) svgEl.appendChild(container);
  }, [selectedLayers, selectedSubElId, activeSvg?.content, canvasDrag]);

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
    if (nextEl) svg.insertBefore(fromEl, nextEl);
    else svg.appendChild(fromEl);

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
    const serialized = new XMLSerializer().serializeToString(doc.documentElement);
    const blob = new Blob([serialized], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeSvg.name.replace(/\.svg$/i, '') + '_export.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [activeSvg, hiddenLayers]);

  // ── Background layer detection ────────────────────────────────────────────

  const backgroundLayerId = useMemo(() => {
    if (!activeSvg || activeSvg.layers.length === 0) return null;
    const candidate = activeSvg.layers[0];
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const svgRoot = doc.documentElement;
    const vb = (svgRoot.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if (vb.length < 4) return null;
    const [, , vw, vh] = vb;
    const viewBoxArea = vw * vh;
    const el = doc.getElementById(candidate.id);
    if (!el) return null;

    const coversCanvas = (node: Element): boolean => {
      const tag = node.localName.toLowerCase();
      if (tag === 'rect') {
        const w = parseFloat(node.getAttribute('width') ?? '0');
        const h = parseFloat(node.getAttribute('height') ?? '0');
        return w * h >= viewBoxArea * 0.75;
      }
      if (tag === 'circle') {
        const r = parseFloat(node.getAttribute('r') ?? '0');
        return Math.PI * r * r >= viewBoxArea * 0.75;
      }
      if (tag === 'ellipse') {
        const rx = parseFloat(node.getAttribute('rx') ?? '0');
        const ry = parseFloat(node.getAttribute('ry') ?? '0');
        return Math.PI * rx * ry >= viewBoxArea * 0.75;
      }
      return false;
    };

    // Case 1: the layer element itself is a background shape
    if (coversCanvas(el)) return candidate.id;

    // Case 2: the layer is a group whose first few children include a background shape
    const children = Array.from(el.children).filter(
      (c) => !['defs', 'title', 'desc'].includes(c.localName.toLowerCase())
    );
    if (children.length > 0 && children.length <= 6) {
      if (children.some(coversCanvas)) return candidate.id;
    }

    return null;
  }, [activeSvg?.src]);

  // ── Selected text layer properties ────────────────────────────────────────

  const layerColors = useMemo(() => {
    if (!selectedLayer || !activeSvg) return [];
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerEl = doc.getElementById(selectedLayer);
    if (!layerEl) return [];
    return extractLayerColors(layerEl, doc);
  }, [selectedLayer, activeSvg?.content]);

  // Map from layer id → sub-text children, for groups that contain multiple <text id="…"> elements
  const subLayerMap = useMemo(() => {
    const map = new Map<string, { id: string; label: string }[]>();
    if (!activeSvg) return map;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    for (const layer of activeSvg.layers) {
      const el = doc.getElementById(layer.id);
      if (!el || el.tagName.toLowerCase() !== 'g') continue;
      const texts = Array.from(el.children).filter(
        (c) => c.tagName.toLowerCase() === 'text' && c.id
      );
      if (texts.length > 1) {
        map.set(layer.id, texts.map((c) => ({
          id: c.id,
          label: c.textContent?.trim() || c.id,
        })));
      }
    }
    return map;
  }, [activeSvg?.content]);

  const selectedTextProps = useMemo(() => {
    if (!activeSvg) return null;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');

    if (selectedSubElId) {
      const textEl = doc.getElementById(selectedSubElId);
      if (!textEl || textEl.tagName.toLowerCase() !== 'text') return null;
      return {
        content: textEl.textContent ?? '',
        font:    textEl.getAttribute('font-family') ?? 'Arial',
        size:    Number(textEl.getAttribute('font-size') ?? 48),
        weight:  Number(textEl.getAttribute('font-weight') ?? 400),
        color:   textEl.getAttribute('fill') ?? '#000000',
        curve:   null as number | null,
        letterSpacing: parseFloat((textEl.getAttribute('letter-spacing') ?? '0').replace('em', '')) || 0,
      };
    }

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
  }, [selectedLayer, selectedSubElId, activeSvg?.content]);

  const updateTextLayer = useCallback((attrs: Partial<{ content: string; font: string; size: number; weight: number; color: string; curve: number; letterSpacing: number }>) => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');

    if (selectedSubElId) {
      const textEl = doc.getElementById(selectedSubElId);
      if (!textEl) return;
      if (attrs.content !== undefined) textEl.textContent = attrs.content;
      if (attrs.font    !== undefined) textEl.setAttribute('font-family', attrs.font);
      if (attrs.size    !== undefined) textEl.setAttribute('font-size', String(attrs.size));
      if (attrs.weight  !== undefined) textEl.setAttribute('font-weight', String(attrs.weight));
      if (attrs.color   !== undefined) textEl.setAttribute('fill', attrs.color);
      if (attrs.letterSpacing !== undefined) {
        if (attrs.letterSpacing === 0) textEl.removeAttribute('letter-spacing');
        else textEl.setAttribute('letter-spacing', `${attrs.letterSpacing}em`);
      }
      const content = new XMLSerializer().serializeToString(doc.documentElement);
      setActiveSvg((prev) => prev ? { ...prev, content } : null);
      return;
    }

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
      arcEl.setAttribute('d', computeArcPath(cx, cy, halfW, attrs.curve));
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
      const halfW = Number(el.getAttribute('data-halfw') ?? 100);
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const COPY_ATTRS = ['font-family', 'font-size', 'font-weight', 'fill', 'letter-spacing'];

      if (currentCurve === 0 && newCurve !== 0) {
        const content = textEl.textContent ?? '';
        el.removeChild(textEl);
        const arcId = `_arc_${el.id}`;
        const defsEl = doc.createElementNS(SVG_NS, 'defs');
        const arcEl = doc.createElementNS(SVG_NS, 'path');
        arcEl.id = arcId;
        arcEl.setAttribute('d', computeArcPath(cx, cy, halfW, newCurve));
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
      } else if (newCurve !== 0) {
        const arcEl = doc.getElementById(`_arc_${el.id}`) ?? el.querySelector('path');
        if (arcEl) arcEl.setAttribute('d', computeArcPath(cx, cy, halfW, newCurve));
      }
    }

    if (attrs.content !== undefined) {
      const tp = textEl.querySelector('textPath');
      if (tp) tp.textContent = attrs.content;
      else textEl.textContent = attrs.content;
    }
    if (attrs.font   !== undefined) textEl.setAttribute('font-family', attrs.font);
    if (attrs.size   !== undefined) textEl.setAttribute('font-size', String(attrs.size));
    if (attrs.weight !== undefined) textEl.setAttribute('font-weight', String(attrs.weight));
    if (attrs.color  !== undefined) textEl.setAttribute('fill', attrs.color);
    if (attrs.letterSpacing !== undefined) {
      if (attrs.letterSpacing === 0) textEl.removeAttribute('letter-spacing');
      else textEl.setAttribute('letter-spacing', `${attrs.letterSpacing}em`);
    }
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => {
      if (!prev) return null;
      const layers = attrs.content !== undefined
        ? prev.layers.map((l) => l.id === selectedLayer ? { ...l, label: attrs.content!.trim() || l.label } : l)
        : prev.layers;
      return { ...prev, content, layers };
    });
  }, [selectedLayer, selectedSubElId, activeSvg]);

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
      arcEl.setAttribute('d', computeArcPath(cx, cy, halfW, textForm.curve));
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
    setSelectedLayer(id);
  }, [activeSvg, textForm, snapshotForUndo]);

  // ── Center layers to selected ─────────────────────────────────────────────

  const centerLayersToSelected = useCallback(() => {
    if (!activeSvg || !selectedLayer) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const screenCTM = svgEl.getScreenCTM();
    if (!screenCTM) return;
    const inv = screenCTM.inverse();

    const toSvgPoint = (el: Element) => {
      const r = el.getBoundingClientRect();
      const pt = svgEl.createSVGPoint();
      pt.x = r.left + r.width / 2;
      pt.y = r.top + r.height / 2;
      return pt.matrixTransform(inv);
    };

    const selectedLiveEl = svgEl.getElementById(selectedLayer);
    if (!selectedLiveEl) return;
    const target = toSvgPoint(selectedLiveEl);

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    let changed = false;

    activeSvg.layers.forEach(({ id }) => {
      if (id === selectedLayer || id === backgroundLayerId) return;
      const liveEl = svgEl.getElementById(id);
      if (!liveEl) return;
      const center = toSvgPoint(liveEl);
      const dx = target.x - center.x;
      if (Math.abs(dx) < 0.5) return;
      const docEl = doc.getElementById(id);
      if (!docEl) return;
      const existing = docEl.getAttribute('transform') ?? '';
      docEl.setAttribute('transform', `translate(${dx.toFixed(2)},0) ${existing}`.trim());
      changed = true;
    });

    if (!changed) return;
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayer]);

  // ── Load + register a Google Font ─────────────────────────────────────────

  const addGoogleFont = useCallback((fontName: string) => {
    setExtraFonts((prev) => prev.includes(fontName) ? prev : [...prev, fontName]);
    const linkId = `gfont-${fontName.replace(/\s+/g, '-')}`;
    if (!document.getElementById(linkId)) {
      const link = document.createElement('link');
      link.id = linkId; link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, '+')}:wght@400;700&display=swap`;
      document.head.appendChild(link);
    }
  }, []);

  // ── Image-level font suggestions ──────────────────────────────────────────

  const suggestFontsForImage = useCallback(async () => {
    if (!activeSvg) return;
    setImageFontsLoading(true);
    setShowImageFonts(true);
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const root = doc.documentElement;
      const vb = (root.getAttribute('viewBox') ?? '0 0 800 600').trim().split(/[\s,]+/).map(Number);
      const vw = vb[2] ?? 800;
      const vh = vb[3] ?? 600;
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(activeSvg.content, Math.round(vw * scale), Math.round(vh * scale));

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.EXPO_PUBLIC_CLAUDE_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
              { type: 'text', text: `Look at this design image. Suggest 5 Google Fonts that would complement its visual style, mood, colour palette, and aesthetic. Consider the overall feel of the design.
Return JSON only, no markdown: {"suggestions":[{"font":"Font Name","reason":"brief reason"}]}` },
            ],
          }],
        }),
      });

      const data = await res.json() as { content?: Array<{ text?: string }> };
      const raw = data.content?.[0]?.text ?? '';
      const parsed = JSON.parse(raw) as { suggestions: Array<{ font: string; reason: string }> };
      const suggestions = parsed.suggestions ?? [];
      suggestions.forEach(({ font }) => {
        const linkId = `gfont-${font.replace(/\s+/g, '-')}`;
        if (!document.getElementById(linkId)) {
          const link = document.createElement('link');
          link.id = linkId; link.rel = 'stylesheet';
          link.href = `https://fonts.googleapis.com/css2?family=${font.replace(/\s+/g, '+')}:wght@400;700&display=swap`;
          document.head.appendChild(link);
        }
      });
      setImageFonts(suggestions);
    } catch (err) {
      console.error('Font suggestion failed:', err);
      setImageFonts([]);
    } finally {
      setImageFontsLoading(false);
    }
  }, [activeSvg]);


  // ── Taxonomy analysis ─────────────────────────────────────────────────────

  const runTaxonomyAnalysis = useCallback(async () => {
    if (!activeSvg) return;
    setTaxonomyLoading(true);
    setTaxonomy(null);
    setTaxonomyOpen(true);
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const root = doc.documentElement;
      const vb = (root.getAttribute('viewBox') ?? '0 0 800 600').trim().split(/[\s,]+/).map(Number);
      const vw = vb[2] ?? 800;
      const vh = vb[3] ?? 600;
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(activeSvg.content, Math.round(vw * scale), Math.round(vh * scale));
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.EXPO_PUBLIC_CLAUDE_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
              { type: 'text', text: `Analyze this SVG design and classify its visual elements into taxonomy groups.

Use ONLY these type values: background, text, icon, graphic, decoration, shape, image.

Return ONLY valid JSON — no markdown, no explanation:
{"groups":[{"type":"background","elements":["solid dark fill"]},{"type":"text","elements":["curved top banner"]}]}` },
            ],
          }],
        }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json() as { content?: Array<{ text?: string }> };
      const raw = (data.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim();
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

  const replaceColorInLayer = useCallback((overrideTo?: string) => {
    if (!activeSvg || !selectedLayer || !colorReplaceFrom) return;
    const applyTo = overrideTo ?? colorReplaceTo;
    const normalFrom = normalizeColor(colorReplaceFrom);
    const doc = new DOMParser().parseFromString(colorBaselineRef.current ?? activeSvg.content, 'image/svg+xml');
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
  }, [activeSvg, selectedLayer, colorReplaceFrom, colorReplaceTo]);

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
      const vbParts = viewBox.trim().split(/[\s,]+/).map(Number);
      const vbX = vbParts[0] ?? 0;
      const vbY = vbParts[1] ?? 0;
      const vw  = vbParts[2] ?? 800;
      const vh  = vbParts[3] ?? 600;
      const defsEl = doc.querySelector('defs');
      const defsXml = defsEl ? new XMLSerializer().serializeToString(defsEl) : '';
      const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}">${defsXml}${svgString}</svg>`;
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(previewSvg, Math.round(vw * scale), Math.round(vh * scale));

      const apiHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': process.env.EXPO_PUBLIC_CLAUDE_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };

      // ── Suggest font ───────────────────────────────────────────────────────
      if (action === 'suggest-font') {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
                { type: 'text', text: `Look at this SVG layer image. Does it contain any text (including text rendered as outlined paths)?
If yes, suggest a single Google Font that best matches the style, mood, and visual character of the text. Return only JSON: {"font":"Font Name","reason":"brief reason"}.
If no text is detected return: {"font":null,"reason":"No text detected"}.
Return JSON only, no markdown.` },
              ],
            }],
          }),
        });
        if (!response.ok) {
          const e = await response.json().catch(() => ({})) as { error?: { message?: string } };
          throw new Error(e.error?.message ?? `API error ${response.status}`);
        }
        const data = await response.json() as { content: Array<{ type: string; text: string }> };
        const rawText = data.content?.[0]?.text ?? '';
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
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 512,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
                { type: 'text', text: `Look at this SVG layer image. Identify the main text content.
Return ONLY a JSON object with these two fields:
- "heading": the primary / largest text (the main title or headline). Empty string if none.
- "subheading": secondary text beneath or supporting the heading (tagline, subtitle, date, etc.). Empty string if none.

No markdown, no code fences, no explanation. Example:
{"heading":"GRAND OPENING","subheading":"Saturday June 21st"}` },
              ],
            }],
          }),
        });
        if (!response.ok) {
          const e = await response.json().catch(() => ({})) as { error?: { message?: string } };
          throw new Error(e.error?.message ?? `API error ${response.status}`);
        }
        const data = await response.json() as { content: Array<{ type: string; text: string }> };
        const rawText = (data.content?.[0]?.text ?? '')
          .replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim();
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
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
                { type: 'text', text: `You are editing an SVG layer. Find and remove ONLY the text matching: "${query}"

Every SVG element has a data-ai-idx attribute. Identify which elements render that specific text — including <text>/<tspan> elements AND path/group elements whose shapes form those letters. If a <g> group's children together form the target word, return the group's index (not the individual child paths).

SVG source:
${rstMarkedSvg}

Respond with ONLY a valid JSON object — no markdown, no code fences:
{"removeIds":["3","9"]}` },
              ],
            }],
          }),
        });
        if (!response.ok) {
          const e = await response.json().catch(() => ({})) as { error?: { message?: string } };
          throw new Error(e.error?.message ?? `API error ${response.status}`);
        }
        const data = await response.json() as { content: Array<{ type: string; text: string }> };
        const rawText = (data.content?.[0]?.text ?? '')
          .replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim();
        let removeIds: string[];
        try {
          removeIds = (JSON.parse(rawText) as { removeIds: string[] }).removeIds ?? [];
        } catch {
          throw new Error('AI returned an unreadable response');
        }
        setAiStatusMsg('Applying changes…');
        for (const sid of removeIds) rstIdMap.get(sid)?.parentNode?.removeChild(rstIdMap.get(sid)!);
        for (const [, el] of rstIdMap) el.removeAttribute('data-ai-idx');
        const contentRST = new XMLSerializer().serializeToString(doc.documentElement);
        setActiveSvg((prev) => prev ? { ...prev, content: contentRST } : null);
        setShowRemoveTextInput(false);
        setRemoveTextQuery('');
        return;
      }

      // ── Strip text (detect + index-based removal) ─────────────────────────
      type TextRow = {
        yFraction: number; xFraction: number;
        font: string; sizeFraction: number;
        weight: number; color: string; content: string;
        letterSpacing: number;
      };
      type StripResult = { hasText: boolean; rows: TextRow[]; removeIds: string[] };

      // Label every shape/group element with a temporary data-ai-idx so Claude
      // can reference them by index instead of reconstructing the full SVG.
      const SHAPE_TAGS = new Set(['path','g','circle','rect','ellipse','polygon','polyline','line','text','tspan','use']);
      let aiIdx = 0;
      const aiIdMap = new Map<string, Element>();
      const markEls = (el: Element) => {
        for (const child of Array.from(el.children)) {
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

      const cacheKey = `strip-text-v5:${hashString(svgString)}`;
      let parsed: StripResult;

      const cachedRaw = aiCacheRef.current.get(cacheKey);
      if (cachedRaw) {
        parsed = JSON.parse(cachedRaw) as StripResult;
      } else {
        setAiStatusMsg('Detecting text…');
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
                { type: 'text', text: `Analyze this SVG layer image and its source code.

TASK 1 — Text detection: Examine the image carefully. Detect ALL text present, including text rendered as outlined or filled path shapes (not just SVG <text> elements). For each distinct line or row of text, estimate:
- yFraction: vertical center as a fraction of image height (0.0 = top edge, 1.0 = bottom edge)
- xFraction: horizontal center as a fraction of image width (0.0 = left, 1.0 = right)
- font: name of the closest matching Google Font
- sizeFraction: font cap-height as a fraction of image height (e.g. 0.08 if text height ≈ 8% of image)
- weight: CSS font-weight integer (100, 200, 300, 400, 500, 600, 700, 800, or 900)
- color: dominant text fill color as CSS hex (e.g. "#ffffff")
- content: the exact text string if legible, else ""
- letterSpacing: CSS letter-spacing in em units. Default to 0.0 (normal) if you are not certain — only use a non-zero value when you can clearly see unusually wide or condensed tracking (e.g. 0.1 slightly wide, 0.3 very wide, -0.05 condensed)

TASK 2 — Text element identification: Every SVG element in the source has a data-ai-idx attribute. Identify which elements visually render as text — including <text>/<tspan> elements AND <path>/<g> elements whose shapes form letter or word outlines. IMPORTANT: if a <g> group contains child paths that together form a word, return the group's data-ai-idx (not the individual letter path indices). Return every text element's data-ai-idx in "removeIds".

SVG source:
${markedSvgString}

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"hasText":true,"rows":[{"yFraction":0.5,"xFraction":0.5,"font":"Impact","sizeFraction":0.08,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0.05}],"removeIds":["3","9"]}` },
              ],
            }],
          }),
        });

        if (!response.ok) {
          const e = await response.json().catch(() => ({})) as { error?: { message?: string } };
          throw new Error(e.error?.message ?? `API error ${response.status}`);
        }

        const data = await response.json() as { content: Array<{ type: string; text: string }> };
        const rawText = (data.content?.[0]?.text ?? '')
          .replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim();

        try {
          parsed = JSON.parse(rawText) as StripResult;
          if (!Array.isArray(parsed.removeIds)) parsed.removeIds = [];
        } catch {
          throw new Error('AI returned an unreadable response');
        }

        aiCacheRef.current.set(cacheKey, JSON.stringify(parsed));
      }

      // Remove identified text elements directly from the DOM
      setAiStatusMsg('Applying changes…');
      for (const sid of parsed.removeIds) {
        const el = aiIdMap.get(sid);
        el?.parentNode?.removeChild(el);
      }
      // Clean up temporary index attributes from remaining elements
      for (const [, el] of aiIdMap) {
        el.removeAttribute('data-ai-idx');
      }

      // Group rows that share the same horizontal band (yFraction within 3%) into one layer
      const newTextLayers: SvgLayer[] = [];
      if (parsed.hasText && parsed.rows.length > 0) {
        const Y_THRESHOLD = 0.03;
        const groups: (typeof parsed.rows)[] = [];
        const sorted = [...parsed.rows].sort((a, b) => a.yFraction - b.yFraction);
        for (const row of sorted) {
          const last = groups[groups.length - 1];
          if (last && Math.abs(row.yFraction - last[0].yFraction) <= Y_THRESHOLD) {
            last.push(row);
          } else {
            groups.push([row]);
          }
        }

        const LS_OPTIONS = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3];
        const snapLS = (v: number) => LS_OPTIONS.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);

        groups.forEach((group, gi) => {
          const newId = `_text_${Date.now()}_${gi}`;
          const label = group.map((r) => r.content.trim()).filter(Boolean).join(' ') || 'Text';
          group.forEach(({ font }) => addGoogleFont(font));

          if (group.length === 1) {
            const row = group[0];
            const cx = vbX + row.xFraction * vw;
            const cy = vbY + row.yFraction * vh;
            const fontSize = Math.max(8, Math.round(row.sizeFraction * vh));
            const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
            textEl.id = newId;
            textEl.setAttribute('x', String(cx));
            textEl.setAttribute('y', String(cy));
            textEl.setAttribute('text-anchor', 'middle');
            textEl.setAttribute('dominant-baseline', 'middle');
            textEl.setAttribute('font-family', row.font || 'Arial');
            textEl.setAttribute('font-size', String(fontSize));
            textEl.setAttribute('font-weight', String(row.weight || 400));
            textEl.setAttribute('fill', row.color || '#000000');
            const ls = snapLS(row.letterSpacing ?? 0); if (ls !== 0) textEl.setAttribute('letter-spacing', `${ls}em`);
            textEl.textContent = label;
            doc.documentElement.appendChild(textEl);
          } else {
            const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.id = newId;
            g.setAttribute('data-name', label);
            group.forEach((row, si) => {
              const cx = vbX + row.xFraction * vw;
              const cy = vbY + row.yFraction * vh;
              const fontSize = Math.max(8, Math.round(row.sizeFraction * vh));
              const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
              textEl.id = `${newId}_${si}`;
              textEl.setAttribute('x', String(cx));
              textEl.setAttribute('y', String(cy));
              textEl.setAttribute('text-anchor', 'middle');
              textEl.setAttribute('dominant-baseline', 'middle');
              textEl.setAttribute('font-family', row.font || 'Arial');
              textEl.setAttribute('font-size', String(fontSize));
              textEl.setAttribute('font-weight', String(row.weight || 400));
              textEl.setAttribute('fill', row.color || '#000000');
              const ls = snapLS(row.letterSpacing ?? 0); if (ls !== 0) textEl.setAttribute('letter-spacing', `${ls}em`);
              textEl.textContent = row.content.trim() || 'Text';
              g.appendChild(textEl);
            });
            doc.documentElement.appendChild(g);
          }

          newTextLayers.push({ id: newId, label });
        });
      }

      const content = new XMLSerializer().serializeToString(doc.documentElement);
      setActiveSvg((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          content,
          layers: newTextLayers.length > 0 ? [...prev.layers, ...newTextLayers] : prev.layers,
        };
      });
      if (newTextLayers.length > 0) setSelectedLayer(newTextLayers[0].id);

    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI action failed');
    } finally {
      setAiLoading(false);
      setAiStatusMsg('Thinking…');
    }
  }, [activeSvg, selectedLayer, addGoogleFont, snapshotForUndo]);

  // ── Reset ──────────────────────────────────────────────────────────────────

  const resetSvg = useCallback(() => {
    if (!activeSvg) return;
    if (!window.confirm('Reset to the original SVG? All changes will be lost.')) return;
    const { content, layers } = parseSvg(activeSvg.originalContent);
    setActiveSvg((prev) => (prev ? { ...prev, content, layers } : null));
    setHiddenLayers(new Set());
    setSelectedLayer(null);
  }, [activeSvg]);

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => revokePrev(activeSvg), []);

  useEffect(() => {
    setAiError(null); setFontSuggestion(null); setSuggestedFontName(null);
    setColorReplaceFrom(''); setSelectedSubElId(null);
    setShowRemoveTextInput(false); setRemoveTextQuery(''); setTextCheckResult(null);
    colorBaselineRef.current = null;
  }, [selectedLayer]);

  useEffect(() => {
    setImageFonts(null);
    setShowImageFonts(false);
    setTaxonomy(null);
    setTaxonomyLoading(false);
    setTaxonomyOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSvg?.src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clear(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  useEffect(() => {
    if (!selectedLayers.size && !selectedSubElId) return;
    const onArrow = (e: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
      const dy = e.key === 'ArrowDown'  ? step : e.key === 'ArrowUp'   ? -step : 0;
      setActiveSvg((prev) => {
        if (!prev) return null;
        const doc = new DOMParser().parseFromString(prev.content, 'image/svg+xml');
        const ids = selectedSubElId ? [selectedSubElId] : [...selectedLayers];
        ids.forEach((id) => {
          const el = doc.getElementById(id);
          if (!el) return;
          el.setAttribute('transform', applyTranslateDelta(el.getAttribute('transform') ?? '', dx, dy));
        });
        return { ...prev, content: new XMLSerializer().serializeToString(doc.documentElement) };
      });
    };
    window.addEventListener('keydown', onArrow);
    return () => window.removeEventListener('keydown', onArrow);
  }, [selectedLayers, selectedSubElId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'z' || e.shiftKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // ── File drag handlers (drop zone) ─────────────────────────────────────────

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragCounter(0); setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  }, [openFile]);

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

  // ── Render ─────────────────────────────────────────────────────────────────

  const showCanvas = activeSvg || isLoading;
  const isDirty = !!activeSvg && (
    hiddenLayers.size > 0 || activeSvg.content !== activeSvg.originalContent
  );

  return (
    <div className="flex h-screen bg-zinc-950 overflow-hidden">

      {/* ── Left sidebar ─────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900/60">
        <div className="px-3 py-2.5 border-b border-zinc-800">
          <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
            Samples
          </span>
        </div>
        <div className="flex flex-col gap-1.5 p-2 overflow-y-auto">
          {SAMPLES.map((sample) => {
            const isActive = activeSample === sample.name;
            return (
              <button
                key={sample.name}
                onClick={() => openSample(sample)}
                disabled={isLoading}
                className={cn(
                  'flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-all duration-100 outline-none',
                  isActive ? 'bg-zinc-700/80 ring-1 ring-inset ring-zinc-500' : 'hover:bg-zinc-800/70',
                  isLoading && 'opacity-50 cursor-wait'
                )}
              >
                <div className="w-full aspect-square rounded-md overflow-hidden bg-zinc-950/60 relative">
                  <div className="absolute inset-0 bg-zinc-800 animate-pulse rounded-md" />
                  <img
                    src={sample.src}
                    alt={sample.label}
                    className="relative w-full h-full object-contain p-1.5"
                    onLoad={(e) => {
                      const placeholder = (e.currentTarget.previousSibling as HTMLElement | null);
                      if (placeholder) placeholder.style.display = 'none';
                    }}
                  />
                </div>
                <span className={cn(
                  'text-[11px] truncate w-full leading-tight transition-colors',
                  isActive ? 'text-zinc-200' : 'text-zinc-500'
                )}>
                  {sample.label}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0">
        {showCanvas ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 h-11 border-b border-zinc-800 shrink-0">
              {/* Filename + dirty dot */}
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <span className="text-zinc-400 text-sm font-mono truncate">
                  {isLoading && !activeSvg ? 'Loading…' : activeSvg?.name}
                </span>
                {isDirty && (
                  <span className="size-1.5 rounded-full bg-amber-400 shrink-0 inline-block" title="Unsaved changes" />
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {/* Center layers — icon button */}
                {selectedLayer && (
                  <button
                    onClick={centerLayersToSelected}
                    title="Center all layers to selected"
                    className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <circle cx="12" cy="12" r="3" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M3 12h2m14 0h2" />
                    </svg>
                  </button>
                )}

                {/* Undo */}
                {undoCount > 0 && (
                  <button
                    onClick={undo}
                    title="Undo (⌘Z)"
                    className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
                    </svg>
                  </button>
                )}

                {/* Export */}
                <button
                  onClick={exportSvg}
                  className="h-7 flex items-center gap-1.5 px-2.5 rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 text-xs font-medium transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  {activeSvg && hiddenLayers.size > 0
                    ? `Export (${activeSvg.layers.length - hiddenLayers.size}/${activeSvg.layers.length})`
                    : 'Export'}
                </button>

                {/* Close */}
                <button
                  onClick={clear}
                  title="Close file (ESC)"
                  className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Font suggestions panel */}
            {showImageFonts && (
              <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <SparklesIcon className="size-3 text-indigo-400" />
                    <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Font suggestions</span>
                  </div>
                  <button onClick={() => setShowImageFonts(false)} className="text-zinc-600 hover:text-zinc-300 text-xs transition-colors">✕</button>
                </div>
                {imageFontsLoading && (
                  <div className="flex items-center gap-2 py-1">
                    <div className="size-3 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin shrink-0" />
                    <span className="text-xs text-zinc-500">Analysing design…</span>
                  </div>
                )}
                {imageFonts && imageFonts.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {imageFonts.map(({ font }) => (
                      <div key={font} className="flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-1">
                        <span className="text-xs text-zinc-200" style={{ fontFamily: font }}>{font}</span>
                        <button
                          onClick={() => addGoogleFont(font)}
                          title="Add to font list"
                          className="text-zinc-500 hover:text-zinc-200 transition-colors text-xs ml-1"
                        >
                          +
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Canvas row: SVG + layers panel */}
            <div className="flex flex-1 min-h-0">

              {/* Canvas */}
              <div
                ref={svgCanvasRef}
                onClick={handleCanvasClick}
                onMouseDown={handleCanvasMouseDown}
                onDoubleClick={handleCanvasDblClick}
                className="relative flex-1 overflow-auto flex items-center justify-center min-w-0"
                style={{
                  backgroundImage: 'radial-gradient(circle, #3f3f46 1px, transparent 1px)',
                  backgroundSize: '20px 20px',
                }}
              >
                {aiLoading && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/60 backdrop-blur-[2px]">
                    <SparklesIcon className="size-10 text-indigo-400 animate-pulse" />
                    <span className="mt-3 text-sm text-zinc-300 tracking-wide">{aiStatusMsg}</span>
                  </div>
                )}

                {isLoading && !activeSvg ? (
                  <div className="w-8 h-8 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />
                ) : activeSvg ? (
                  <>
                    {hiddenLayers.size > 0 && (
                      <style>{
                        [...hiddenLayers]
                          .map((id) => `.svg-canvas #${CSS.escape(id)}{display:none!important}`)
                          .join('')
                      }</style>
                    )}
                    {selectedLayer && (
                      <style>{[...selectedLayers].map((id) => `.svg-canvas #${CSS.escape(id)}{cursor:grab}`).join('')}</style>
                    )}
                    <div
                      className="svg-canvas"
                      style={{ width: '80%' }}
                      dangerouslySetInnerHTML={{ __html: activeSvg.content }}
                    />
                  </>
                ) : null}

                {inlineEdit && selectedTextProps && (
                  <input
                    autoFocus
                    type="text"
                    value={selectedTextProps.content}
                    onChange={(e) => updateTextLayer({ content: e.target.value })}
                    onBlur={() => setInlineEdit(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' || e.key === 'Enter') {
                        setInlineEdit(null);
                        e.preventDefault();
                      }
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute',
                      left:      inlineEdit.left,
                      top:       inlineEdit.top,
                      minWidth:  inlineEdit.width,
                      height:    inlineEdit.height,
                      fontSize:  inlineEdit.fontSize,
                      fontFamily: inlineEdit.fontFamily,
                      fontWeight: inlineEdit.fontWeight,
                      color:     inlineEdit.color,
                      background: 'rgba(0,0,0,0.55)',
                      border:    '1.5px solid #3b82f6',
                      borderRadius: 3,
                      outline:   'none',
                      padding:   '0 6px',
                      zIndex:    20,
                      textAlign: 'center',
                      lineHeight: 1,
                    }}
                  />
                )}
              </div>

              {/* ── Layers panel ─────────────────────────────────────── */}
              {activeSvg && (
                <aside className="w-52 shrink-0 flex flex-col border-l border-zinc-800 bg-zinc-900/60">

                  {/* Suggest fonts — collapsible, above layers heading */}
                  <div className="border-b border-zinc-800 shrink-0">
                    <button
                      onClick={() => setSuggestFontsOpen((o) => !o)}
                      className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
                    >
                      <SparklesIcon className="size-3 text-indigo-400" />
                      <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest flex-1 text-left">
                        Image Actions
                      </span>
                      <span className="text-zinc-600 text-[10px]">{suggestFontsOpen ? '▲' : '▼'}</span>
                    </button>
                    {suggestFontsOpen && (
                      <div className="px-2 pb-2">
                        <button
                          onClick={suggestFontsForImage}
                          disabled={imageFonts !== null || imageFontsLoading}
                          className={cn(
                            'w-full flex items-center justify-center gap-1.5 rounded text-xs py-1.5 transition-colors',
                            imageFonts !== null
                              ? 'bg-zinc-800/30 text-zinc-600 cursor-not-allowed'
                              : imageFontsLoading
                              ? 'bg-zinc-800/30 text-zinc-500 cursor-wait'
                              : 'bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300'
                          )}
                        >
                          {imageFontsLoading && <div className="size-3 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin shrink-0" />}
                          {imageFontsLoading ? 'Analysing…' : imageFonts !== null ? 'Fonts suggested' : 'Suggest fonts'}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
                      Layers
                    </span>
                    <span className="text-[10px] text-zinc-600">
                      {activeSvg.layers.length}
                    </span>
                  </div>

                  {/* Text layer form — add when nothing selected, edit when a text layer is selected */}
                  <div className="border-b border-zinc-800">
                    <button
                      onClick={() => setTextFormOpen((o) => !o)}
                      className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
                    >
                      <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex-1 text-left">
                        Text
                      </span>
                      <span className="text-zinc-600 text-[10px]">{textFormOpen ? '▲' : '▼'}</span>
                    </button>
                  {textFormOpen && <div className="px-2 pb-2 flex flex-col gap-1.5">
                    <input
                      type="text"
                      value={selectedTextProps ? selectedTextProps.content : textForm.content}
                      onChange={(e) =>
                        selectedTextProps
                          ? updateTextLayer({ content: e.target.value })
                          : setTextForm((f) => ({ ...f, content: e.target.value }))
                      }
                      placeholder="Text content"
                      className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500 placeholder:text-zinc-600"
                    />
                    <select
                      value={selectedTextProps ? selectedTextProps.font : textForm.font}
                      onChange={(e) =>
                        selectedTextProps
                          ? updateTextLayer({ font: e.target.value })
                          : setTextForm((f) => ({ ...f, font: e.target.value }))
                      }
                      className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500"
                    >
                      {['Arial','Helvetica','Georgia','Times New Roman','Courier New','Verdana','Impact','Trebuchet MS'].map((f) => (
                        <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                      ))}
                      {extraFonts.map((f) => (
                        <option key={f} value={f} style={{ fontFamily: f }}>{f} ✦</option>
                      ))}
                    </select>
                    <div className="flex gap-1.5">
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={selectedTextProps ? selectedTextProps.size : textForm.size}
                        onChange={(e) =>
                          selectedTextProps
                            ? updateTextLayer({ size: Math.max(1, Number(e.target.value)) })
                            : setTextForm((f) => ({ ...f, size: Math.max(1, Number(e.target.value)) }))
                        }
                        className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500"
                        title="Font size"
                      />
                      <select
                        value={selectedTextProps ? selectedTextProps.weight : textForm.weight}
                        onChange={(e) =>
                          selectedTextProps
                            ? updateTextLayer({ weight: Number(e.target.value) })
                            : setTextForm((f) => ({ ...f, weight: Number(e.target.value) }))
                        }
                        className="w-16 shrink-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-1 py-1 outline-none focus:border-zinc-500"
                        title="Font weight"
                      >
                        {[100,200,300,400,500,600,700,800,900].map((w) => (
                          <option key={w} value={w}>{w}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-1.5 items-center">
                      <input
                        type="color"
                        value={selectedTextProps ? selectedTextProps.color : textForm.color}
                        onChange={(e) =>
                          selectedTextProps
                            ? updateTextLayer({ color: e.target.value })
                            : setTextForm((f) => ({ ...f, color: e.target.value }))
                        }
                        className="h-6 w-6 shrink-0 rounded border border-zinc-700 bg-zinc-800 cursor-pointer p-0.5"
                        title="Text color"
                      />
                      {'EyeDropper' in window && (
                        <button
                          title="Pick color from canvas"
                          onClick={async () => {
                            try {
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              const dropper = new (window as any).EyeDropper();
                              const result = await dropper.open() as { sRGBHex: string };
                              selectedTextProps
                                ? updateTextLayer({ color: result.sRGBHex })
                                : setTextForm((f) => ({ ...f, color: result.sRGBHex }));
                            } catch { /* cancelled */ }
                          }}
                          className="h-6 w-6 shrink-0 flex items-center justify-center rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 1 1 3.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                      )}
                      <span className="text-[10px] text-zinc-500 shrink-0">Space</span>
                      <select
                        value={selectedTextProps ? selectedTextProps.letterSpacing : textForm.letterSpacing}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          selectedTextProps
                            ? updateTextLayer({ letterSpacing: v })
                            : setTextForm((f) => ({ ...f, letterSpacing: v }));
                        }}
                        className="flex-1 min-w-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500"
                      >
                        {([-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3] as const).map((v) => (
                          <option key={v} value={v}>
                            {v === 0 ? 'Normal' : v < 0 ? `Tight (${v}em)` : `+${v}em`}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Curve slider */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] text-zinc-500 w-8 shrink-0">Curve</span>
                      <input
                        type="range"
                        min={-100}
                        max={100}
                        step={5}
                        value={selectedTextProps ? (selectedTextProps.curve ?? 0) : textForm.curve}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          selectedTextProps
                            ? updateTextLayer({ curve: v })
                            : setTextForm((f) => ({ ...f, curve: v }));
                        }}
                        onPointerDown={() => {
                          if (!selectedTextProps || !selectedLayer) return;
                          const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
                          const el = svgEl?.getElementById(selectedLayer) as SVGGraphicsElement | null;
                          if (el && svgEl) {
                            const bbox = bboxInRootSpace(svgEl, el);
                            curveStartCenterYRef.current = bbox ? bbox.y + bbox.height / 2 : null;
                          }
                        }}
                        onPointerUp={() => {
                          if (curveStartCenterYRef.current === null || !selectedLayer || !activeSvg) return;
                          const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
                          const el = svgEl?.getElementById(selectedLayer) as SVGGraphicsElement | null;
                          if (!el || !svgEl) { curveStartCenterYRef.current = null; return; }
                          const bbox = bboxInRootSpace(svgEl, el as SVGGraphicsElement);
                          if (!bbox) { curveStartCenterYRef.current = null; return; }
                          const delta = curveStartCenterYRef.current - (bbox.y + bbox.height / 2);
                          curveStartCenterYRef.current = null;
                          if (Math.abs(delta) < 0.5) return;
                          const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
                          const groupEl = doc.getElementById(selectedLayer);
                          if (!groupEl) return;
                          const cur = groupEl.getAttribute('transform') ?? '';
                          const m = cur.match(/translate\(\s*([^,\s)]+)[\s,]+([^,\s)]+)\s*\)/);
                          const tx = m ? parseFloat(m[1]) : 0;
                          const ty = m ? parseFloat(m[2]) : 0;
                          groupEl.setAttribute('transform', `translate(${tx}, ${ty + delta})`);
                          const content = new XMLSerializer().serializeToString(doc.documentElement);
                          setActiveSvg((prev) => prev ? { ...prev, content } : null);
                        }}
                        className="flex-1 min-w-0 accent-zinc-400"
                      />
                      <span className="text-[10px] text-zinc-500 w-7 text-right tabular-nums shrink-0">
                        {selectedTextProps ? (selectedTextProps.curve ?? 0) : textForm.curve}
                      </span>
                    </div>
                    {!selectedTextProps && (
                      <button
                        onClick={addTextLayer}
                        disabled={!textForm.content.trim()}
                        className={cn(
                          'w-full rounded text-xs font-medium py-1.5 transition-colors',
                          textForm.content.trim()
                            ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
                            : 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
                        )}
                      >
                        Add layer
                      </button>
                    )}
                  </div>}
                  </div>

                  {/* Layer Actions */}
                  <div className="border-b border-zinc-800 shrink-0">
                    <button
                      onClick={() => setAiActionsOpen((o) => !o)}
                      className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
                    >
                      <SparklesIcon className="size-3 text-indigo-400" />
                      <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest flex-1 text-left">
                        Layer Actions
                      </span>
                      <span className="text-zinc-600 text-[10px]">{aiActionsOpen ? '▲' : '▼'}</span>
                    </button>
                    {aiActionsOpen && <div className="px-2 pb-2 flex flex-col gap-1.5">
                      <select
                        value=""
                        disabled={aiLoading || selectedLayer === backgroundLayerId}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'strip-text') runAiLayerAction('strip-text');
                          else if (v === 'suggest-font') runAiLayerAction('suggest-font');
                          else if (v === 'remove-specific-text') { setShowRemoveTextInput(true); setRemoveTextQuery(''); }
                          else if (v === 'check-text') { setTextCheckResult(null); runAiLayerAction('check-text'); }
                        }}
                        className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs px-2 py-1.5 outline-none focus:border-zinc-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <option value="" disabled hidden>
                          {aiLoading ? 'Processing…' : selectedLayer === backgroundLayerId ? 'Not available for canvas layer' : 'Choose an action…'}
                        </option>
                        {selectedLayer && <option value="strip-text">Strip text — layer (AI)</option>}
                        {selectedLayer && <option value="suggest-font">Suggest font — layer (AI)</option>}
                        {selectedLayer && <option value="remove-specific-text">Remove specific text — layer (AI)</option>}
                        {selectedLayer && <option value="check-text">Check text — layer (AI)</option>}
                      </select>

                      {showRemoveTextInput && selectedLayer && (
                        <div className="flex gap-1">
                          <input
                            type="text"
                            placeholder="Text to remove…"
                            value={removeTextQuery}
                            onChange={(e) => setRemoveTextQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && removeTextQuery.trim() && !aiLoading)
                                runAiLayerAction('remove-specific-text', removeTextQuery.trim());
                            }}
                            disabled={aiLoading}
                            autoFocus
                            className="flex-1 min-w-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs px-2 py-1 outline-none focus:border-zinc-500 disabled:opacity-50"
                          />
                          <button
                            onClick={() => {
                              if (removeTextQuery.trim() && !aiLoading)
                                runAiLayerAction('remove-specific-text', removeTextQuery.trim());
                            }}
                            disabled={!removeTextQuery.trim() || aiLoading}
                            className="shrink-0 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-2 py-1 transition-colors"
                          >
                            Remove
                          </button>
                        </div>
                      )}

                      {textCheckResult && (
                        <div className="rounded bg-zinc-800/60 border border-zinc-700 px-2 py-1.5 flex flex-col gap-0.5">
                          {textCheckResult.heading ? (
                            <p className="text-[11px] font-semibold text-zinc-200 leading-snug">{textCheckResult.heading}</p>
                          ) : (
                            <p className="text-[10px] text-zinc-500 italic leading-snug">No heading detected</p>
                          )}
                          {textCheckResult.subheading ? (
                            <p className="text-[10px] text-zinc-400 leading-snug">{textCheckResult.subheading}</p>
                          ) : null}
                        </div>
                      )}

                      {aiError && (
                        <p className="text-[10px] text-red-400 px-1 break-all leading-tight">{aiError}</p>
                      )}
                      {fontSuggestion && (
                        <div className="flex flex-col gap-1">
                          <p className="text-[10px] text-zinc-300 px-1 leading-snug">{fontSuggestion}</p>
                          {suggestedFontName && (
                            <button
                              onClick={() => {
                                if (selectedTextProps) {
                                  updateTextLayer({ font: suggestedFontName });
                                } else {
                                  setTextForm((f) => ({ ...f, font: suggestedFontName! }));
                                }
                              }}
                              className="w-full rounded text-xs font-medium py-1 text-zinc-300 bg-zinc-700/60 hover:bg-zinc-600/60 transition-colors"
                            >
                              Use "{suggestedFontName}"
                            </button>
                          )}
                        </div>
                      )}
                    </div>}
                  </div>

                  {/* Color Replace — visible for non-text layers only */}
                  {selectedLayer && !selectedTextProps && (
                    <div className="border-b border-zinc-800 shrink-0">
                      <button
                        onClick={() => setColorReplaceOpen((o) => !o)}
                        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
                      >
                        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex-1 text-left">
                          Color Replace
                        </span>
                        <span className="text-zinc-600 text-[10px]">{colorReplaceOpen ? '▲' : '▼'}</span>
                      </button>
                    {colorReplaceOpen && <div className="px-2 pb-2 flex flex-col gap-1.5">

                      {/* From — row of swatches extracted from the layer */}
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between px-1">
                          <span className="text-[10px] text-zinc-500">From</span>
                          {colorReplaceFrom && (
                            <button
                              onClick={() => { setColorReplaceFrom(''); colorBaselineRef.current = null; }}
                              title="Clear selection"
                              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors leading-none"
                            >✕</button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5 px-1 items-start">
                          {layerColors.length > 0 ? layerColors.map((color) => (
                            <button
                              key={color}
                              title={color}
                              onClick={() => { snapshotForUndo(activeSvg!.content, activeSvg!.layers); setColorReplaceFrom(color); colorBaselineRef.current = activeSvg?.content ?? null; }}
                              style={{
                                backgroundColor: color,
                                width: '2rem',
                                height: '2rem',
                                flexShrink: 0,
                                borderRadius: '3px',
                                border: colorReplaceFrom === color ? '2px solid #60a5fa' : '2px solid #52525b',
                                cursor: 'pointer',
                                transition: 'transform 0.1s, border-color 0.1s',
                                transform: colorReplaceFrom === color ? 'scale(1.1)' : 'scale(1)',
                              }}
                            />
                          )) : (
                            <span className="text-[9px] text-zinc-600">no colors detected</span>
                          )}
                        </div>
                      </div>

                      {/* To — colour picker only */}
                      <div className="flex items-center gap-2 px-1">
                        <span className="text-[10px] text-zinc-500 shrink-0">
                          To {!colorReplaceFrom && <span className="text-zinc-600">(pick From first)</span>}
                        </span>
                        <input
                          type="color"
                          value={colorReplaceTo}
                          disabled={!colorReplaceFrom}
                          onChange={(e) => {
                            const c = e.target.value;
                            setColorReplaceTo(c);
                            replaceColorInLayer(c);
                          }}
                          onBlur={() => {
                            if (colorReplaceFrom && !layerColors.includes(colorReplaceFrom)) {
                              setColorReplaceFrom('');
                              colorBaselineRef.current = null;
                            }
                          }}
                          title="Pick replacement colour"
                          className="h-8 w-12 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ padding: '1px 2px', background: 'transparent', border: '2px solid #52525b' }}
                        />
                      </div>
                    </div>}
                    </div>
                  )}

                  <div
                    ref={layerListRef}
                    className="flex flex-col overflow-y-auto py-1 flex-1"
                    onPointerMove={(e) => {
                      if (!panelDragIdRef.current) return;
                      // Reveal the dragged row as faded (state update, fine to call repeatedly)
                      setDragLayerId(panelDragIdRef.current);
                      // Hit-test the element visually under the pointer
                      const under = document.elementFromPoint(e.clientX, e.clientY);
                      const row   = under?.closest('[data-layer-id]') as HTMLElement | null;
                      if (!row || row.dataset.layerId === panelDragIdRef.current) {
                        panelDropPositionRef.current = null;
                        setDropPosition(null);
                        return;
                      }
                      const rect = row.getBoundingClientRect();
                      const pos  = { targetId: row.dataset.layerId!, before: e.clientY < rect.top + rect.height / 2 };
                      panelDropPositionRef.current = pos;
                      setDropPosition(pos);
                    }}
                    onPointerUp={(e) => {
                      if (!panelDragIdRef.current) return;
                      layerListRef.current?.releasePointerCapture(e.pointerId);
                      const pos = panelDropPositionRef.current;
                      if (pos) {
                        reorderLayers(panelDragIdRef.current, pos.targetId, pos.before);
                        panelReorderDoneRef.current = true;
                      }
                      panelDragIdRef.current       = null;
                      panelDropPositionRef.current = null;
                      setDragLayerId(null);
                      setDropPosition(null);
                    }}
                    onPointerCancel={() => {
                      panelDragIdRef.current       = null;
                      panelDropPositionRef.current = null;
                      setDragLayerId(null);
                      setDropPosition(null);
                    }}
                  >
                    {activeSvg.layers.length === 0 ? (
                      <p className="text-xs text-zinc-600 px-3 py-4 text-center">
                        No named layers found
                      </p>
                    ) : (
                      // Reverse: last SVG element is visually on top
                      [...activeSvg.layers].reverse().map((layer) => {
                        const hidden     = hiddenLayers.has(layer.id);
                        const isSelected = selectedLayers.has(layer.id);
                        const isDragged  = dragLayerId === layer.id;
                        const isCanvas   = layer.id === backgroundLayerId;
                        const dropBefore = dropPosition?.targetId === layer.id && dropPosition.before;
                        const dropAfter  = dropPosition?.targetId === layer.id && !dropPosition.before;
                        return (
                          <React.Fragment key={layer.id}>
                          <div
                            data-layer-id={layer.id}
                            onPointerDown={(e) => {
                              if (e.button !== 0) return;
                              if (e.shiftKey) {
                                setSelectedLayers((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
                                  return next;
                                });
                                setSelectedLayer(layer.id);
                              } else {
                                selectOne(layer.id);
                              }
                            }}
                            onClick={() => {
                              if (panelReorderDoneRef.current) {
                                panelReorderDoneRef.current = false;
                              }
                            }}
                            className={cn(
                              'relative group flex items-center gap-2 px-2 py-1.5 mx-1 rounded-md transition-colors select-none',
                              isSelected ? 'bg-zinc-700/60 ring-1 ring-inset ring-zinc-600' : 'hover:bg-zinc-800/60',
                              hidden && 'opacity-40',
                              isDragged && 'opacity-25',
                            )}
                          >
                            {/* Drop-position indicator lines */}
                            {dropBefore && (
                              <div className="pointer-events-none absolute top-0 left-1 right-1 h-0.5 -translate-y-1/2 rounded-full bg-blue-500 z-10" />
                            )}
                            {dropAfter && (
                              <div className="pointer-events-none absolute bottom-0 left-1 right-1 h-0.5 translate-y-1/2 rounded-full bg-blue-500 z-10" />
                            )}

                            {/* Drag handle */}
                            <span
                              onPointerDown={(e) => {
                                if (e.button !== 0) return;
                                e.stopPropagation();
                                selectOne(layer.id);
                                layerListRef.current?.setPointerCapture(e.pointerId);
                                panelDragIdRef.current       = layer.id;
                                panelDropPositionRef.current = null;
                              }}
                              className="shrink-0 cursor-grab opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-300 transition-opacity"
                            >
                              <GripIcon className="size-2" />
                            </span>

                            <button
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); toggleLayer(layer.id); }}
                              title={hidden ? 'Show layer' : 'Hide layer'}
                              className="shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors"
                            >
                              {hidden
                                ? <EyeSlashIcon className="size-3.5" />
                                : <EyeIcon className="size-3.5" />
                              }
                            </button>
                            <span className="text-xs text-zinc-300 truncate leading-snug flex-1 min-w-0">
                              {isCanvas ? 'Canvas' : layer.label}
                            </span>
                            {isCanvas && (
                              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded">
                                bg
                              </span>
                            )}
                          </div>
                          {/* Sub-layer rows for multi-text groups */}
                          {subLayerMap.get(layer.id)?.map((sub) => {
                            const isSubSelected = selectedSubElId === sub.id;
                            return (
                              <button
                                key={sub.id}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  selectOne(layer.id);
                                  setSelectedSubElId(sub.id);
                                }}
                                className={cn(
                                  'w-full flex items-center gap-1.5 pl-8 pr-2 py-1 rounded-md text-left transition-colors',
                                  isSubSelected
                                    ? 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/40'
                                    : 'hover:bg-zinc-800/60'
                                )}
                              >
                                <span className="shrink-0 size-1.5 rounded-full bg-zinc-600" />
                                <span className={cn(
                                  'text-[11px] truncate leading-snug flex-1 min-w-0',
                                  isSubSelected ? 'text-amber-300' : 'text-zinc-500'
                                )}>
                                  {sub.label}
                                </span>
                              </button>
                            );
                          })}
                          </React.Fragment>
                        );
                      })
                    )}
                  </div>

                  {/* Taxonomy */}
                  <div className="border-t border-zinc-800 shrink-0">
                    <button
                      onClick={() => setTaxonomyOpen((o) => !o)}
                      className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
                    >
                      <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex-1 text-left">Taxonomy</span>
                      {taxonomyLoading
                        ? <div className="size-2.5 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin" />
                        : <span className="text-zinc-600 text-[10px]">{taxonomyOpen ? '▲' : '▼'}</span>
                      }
                    </button>
                    {taxonomyOpen && (
                      <div className="px-2 pb-2 flex flex-col gap-0.5 max-h-44 overflow-y-auto">
                        {taxonomyLoading && (
                          <div className="flex items-center gap-2 py-1">
                            <div className="size-3 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin shrink-0" />
                            <span className="text-[10px] text-zinc-500">Analysing…</span>
                          </div>
                        )}
                        {!taxonomyLoading && taxonomy === null && (
                          <button
                            onClick={runTaxonomyAnalysis}
                            className="text-left text-[10px] text-zinc-500 hover:text-zinc-300 py-1 transition-colors"
                          >
                            Analyse structure →
                          </button>
                        )}
                        {taxonomy && taxonomy.length === 0 && (
                          <p className="text-[10px] text-zinc-600 italic py-1">Could not analyse structure</p>
                        )}
                        {taxonomy && taxonomy.length > 0 && taxonomy.map((group, i) => (
                          <div key={`${group.type}-${i}`} className="rounded px-1.5 py-1">
                            <span className={cn(
                              'text-[9px] font-bold uppercase tracking-wider',
                              TAXONOMY_COLOURS[group.type.toLowerCase()] ?? 'text-zinc-400'
                            )}>
                              {group.type}
                            </span>
                            <div className="flex flex-col gap-0.5 mt-0.5">
                              {group.elements.map((desc, j) => (
                                <span key={j} className="text-[10px] text-zinc-400 leading-snug">
                                  {desc}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Revert */}
                  <div className="px-2 py-2 border-t border-zinc-800 shrink-0">
                    <button
                      onClick={resetSvg}
                      disabled={!isDirty}
                      className={cn(
                        'w-full flex items-center justify-center gap-1.5 rounded-md text-xs font-medium py-1.5 transition-colors',
                        isDirty
                          ? 'bg-zinc-800/60 hover:bg-red-900/40 text-zinc-400 hover:text-red-300 cursor-pointer'
                          : 'bg-zinc-800/30 text-zinc-600 cursor-not-allowed'
                      )}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                      </svg>
                      Revert changes
                    </button>
                  </div>
                </aside>
              )}
            </div>
          </>
        ) : (
          /* ── Drop zone ─────────────────────────────────────────────── */
          <div
            className="flex-1 flex items-center justify-center"
            onDrop={handleDrop}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
          >
            {isDragging && (
              <div className="pointer-events-none fixed inset-0 bg-blue-500/10 border-2 border-blue-500/40 z-10" />
            )}
            <div
              className={cn(
                'flex flex-col items-center gap-5 rounded-2xl border-2 border-dashed px-20 py-16 transition-all duration-150 cursor-pointer select-none',
                isDragging
                  ? 'border-blue-500 bg-blue-500/5 scale-[1.02]'
                  : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-900/40'
              )}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={cn('size-10 transition-colors', isDragging ? 'text-blue-400' : 'text-zinc-600')}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}
              >
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.338-2.32 5.75 5.75 0 0 1 1.023 9.095"
                />
              </svg>
              <div className="text-center">
                <p className={cn('text-sm font-medium', isDragging ? 'text-blue-300' : 'text-zinc-400')}>
                  {isDragging ? 'Release to open' : 'Drop an SVG file'}
                </p>
                <p className="text-xs text-zinc-600 mt-1">or click to browse</p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".svg,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) openFile(file);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </div>

      {/* Global SVG canvas sizing — width:100% fixes SVGs with no intrinsic dimensions */}
      <style>{`
        .svg-canvas {
          max-height: calc(80vh - 3rem);
        }
        .svg-canvas svg {
          display: block;
          width: 100%;
          height: auto;
          max-height: calc(80vh - 3rem);
        }
      `}</style>
    </div>
  );
}
