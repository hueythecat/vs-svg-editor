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
  { label: 'Vector 33133625', name: 'vectorstock_33133625.svg',  src: '/samples/vectorstock_33133625.svg' },
  { label: 'Vector 51876595', name: 'vectorstock_51876595.svg',  src: '/samples/vectorstock_51876595.svg' },
  { label: 'Vector 956069',   name: 'vectorstock_956069.svg',    src: '/samples/vectorstock_956069.svg' },
  { label: 'Element 15',      name: 'element_15.svg',           src: '/samples/element_15.svg' },
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

// Arc path for curved text: sweep=1→arch up, sweep=0→arch down
function computeArcPath(cx: number, cy: number, halfW: number, curve: number): string {
  const h = halfW * Math.abs(curve) / 100;
  const r = (halfW * halfW) / (2 * h) + h / 2;
  const sweep = curve > 0 ? 1 : 0;
  return `M ${cx - halfW} ${cy} A ${r} ${r} 0 0 ${sweep} ${cx + halfW} ${cy}`;
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
  const [taxonomyOpen, setTaxonomyOpen]   = useState(false);
  const [textFormOpen, setTextFormOpen]   = useState(true);
  const [aiActionsOpen, setAiActionsOpen] = useState(true);
  const [colorReplaceOpen, setColorReplaceOpen] = useState(true);
  const dragMovedRef            = useRef(false);
  const aiCacheRef              = useRef<Map<string, string>>(new Map());
  // Panel drag — use refs so onPointerMove/Up handlers always see current values
  const panelDragIdRef          = useRef<string | null>(null);
  const panelDropPositionRef    = useRef<{ targetId: string; before: boolean } | null>(null);
  const panelReorderDoneRef     = useRef(false); // suppresses the post-drag click
  const layerListRef            = useRef<HTMLDivElement>(null);
  const fileInputRef            = useRef<HTMLInputElement>(null);
  const svgCanvasRef            = useRef<HTMLDivElement>(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const revokePrev = useCallback((svg: ActiveSvg | null) => {
    if (svg?.objectUrl) URL.revokeObjectURL(svg.objectUrl);
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
  }, []);

  const clear = useCallback(() => {
    setActiveSvg((prev) => { revokePrev(prev); return null; });
    setActiveSample(null);
    setHiddenLayers(new Set());
    setSelectedLayer(null);
    setSelectedLayers(new Set());
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
        if (e.shiftKey) {
          setSelectedLayers((prev) => {
            const next = new Set(prev);
            if (next.has(clickedId)) next.delete(clickedId); else next.add(clickedId);
            return next;
          });
          setSelectedLayer(clickedId);
        } else {
          const next = selectedLayer === clickedId ? null : clickedId;
          setSelectedLayer(next);
          setSelectedLayers(next ? new Set([next]) : new Set());
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

    e.preventDefault();
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    dragMovedRef.current = false;

    const baseTransforms: Record<string, string> = {};
    [...selectedLayers].forEach((id) => {
      const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
      if (layerEl) baseTransforms[id] = layerEl.getAttribute('transform') ?? '';
    });

    setCanvasDrag({
      layerIds: [...selectedLayers],
      startClientX: e.clientX, startClientY: e.clientY,
      startSvgX: svgPt.x,      startSvgY: svgPt.y,
      baseTransforms,
    });
  }, [selectedLayers, activeSvg]);

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
    [...selectedLayers].forEach((id) => {
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
      rect.setAttribute('stroke', '#3b82f6');
      rect.setAttribute('stroke-width', '2');
      rect.setAttribute('stroke-dasharray', '6 4');
      rect.setAttribute('vector-effect', 'non-scaling-stroke');
      container.appendChild(rect);
    });
    if (container.children.length) svgEl.appendChild(container);
  }, [selectedLayers, activeSvg?.content, canvasDrag]);

  // ── Layer reorder ──────────────────────────────────────────────────────────

  const reorderLayers = useCallback((fromId: string, toId: string, panelBefore: boolean) => {
    if (!activeSvg || fromId === toId) return;

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
  }, [activeSvg]);

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

  const selectedTextProps = useMemo(() => {
    if (!selectedLayer || !activeSvg) return null;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
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

  const updateTextLayer = useCallback((attrs: Partial<{ content: string; font: string; size: number; weight: number; color: string; curve: number; letterSpacing: number }>) => {
    if (!selectedLayer || !activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const el = doc.getElementById(selectedLayer);
    if (!el) return;
    const isGroup = el.getAttribute('data-text-layer') === '1';
    const textEl = isGroup ? el.querySelector('text') : el;
    if (!textEl) return;
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
    if (attrs.curve !== undefined && isGroup) {
      el.setAttribute('data-curve', String(attrs.curve));
      const arcEl = el.querySelector('path');
      if (arcEl) {
        const cx = Number(el.getAttribute('data-cx') ?? 0);
        const cy = Number(el.getAttribute('data-cy') ?? 0);
        const halfW = Number(el.getAttribute('data-halfw') ?? 100);
        arcEl.setAttribute('d', computeArcPath(cx, cy, halfW, attrs.curve));
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
  }, [selectedLayer, activeSvg]);

  // ── Add text layer ─────────────────────────────────────────────────────────

  const addTextLayer = useCallback(() => {
    if (!activeSvg || !textForm.content.trim()) return;
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

      const arcEl = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      arcEl.id = arcId;
      arcEl.setAttribute('d', computeArcPath(cx, cy, halfW, textForm.curve));
      arcEl.setAttribute('fill', 'none');
      arcEl.setAttribute('stroke', 'none');
      g.appendChild(arcEl);

      const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      textEl.setAttribute('font-family', textForm.font);
      textEl.setAttribute('font-size', String(textForm.size));
      textEl.setAttribute('font-weight', String(textForm.weight));
      textEl.setAttribute('fill', textForm.color);
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
      const el = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      el.id = id;
      el.setAttribute('x', String(cx));
      el.setAttribute('y', String(cy));
      el.setAttribute('text-anchor', 'middle');
      el.setAttribute('dominant-baseline', 'middle');
      el.setAttribute('font-family', textForm.font);
      el.setAttribute('font-size', String(textForm.size));
      el.setAttribute('font-weight', String(textForm.weight));
      el.setAttribute('fill', textForm.color);
      if (textForm.letterSpacing) el.setAttribute('letter-spacing', `${textForm.letterSpacing}em`);
      el.textContent = textContent;
      svg.appendChild(el);
    }

    const content = new XMLSerializer().serializeToString(svg);
    const newLayer = { id, label: textContent };
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: [...prev.layers, newLayer] } : null));
    setSelectedLayer(id);
  }, [activeSvg, textForm]);

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
      console.log('Image font suggestions:', parsed.suggestions);
      setImageFonts(parsed.suggestions ?? []);
    } catch (err) {
      console.error('Font suggestion failed:', err);
      setImageFonts([]);
    } finally {
      setImageFontsLoading(false);
    }
  }, [activeSvg]);


  // ── Color replace ─────────────────────────────────────────────────────────

  const replaceColorInLayer = useCallback(() => {
    if (!activeSvg || !selectedLayer || !colorReplaceFrom) return;
    const normalFrom = normalizeColor(colorReplaceFrom);
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerEl = doc.getElementById(selectedLayer);
    if (!layerEl) return;

    const COLOR_ATTRS = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color'];

    // Replace color values in a CSS/style string
    const replaceInCss = (css: string): { result: string; changed: boolean } => {
      let changed = false;
      const result = css.replace(
        /(fill|stroke|color|stop-color|flood-color|lighting-color)\s*:\s*([^;{}]+)/gi,
        (_, prop: string, val: string) => {
          if (normalizeColor(val.trim()) === normalFrom) { changed = true; return `${prop}: ${colorReplaceTo}`; }
          return `${prop}: ${val}`;
        },
      );
      return { result, changed };
    };

    // Replace on a single element's attributes + inline style
    const processEl = (el: Element) => {
      COLOR_ATTRS.forEach((attr) => {
        const val = el.getAttribute(attr);
        if (val && normalizeColor(val) === normalFrom) el.setAttribute(attr, colorReplaceTo);
      });
      const style = el.getAttribute('style');
      if (style) {
        const { result, changed } = replaceInCss(style);
        if (changed) el.setAttribute('style', result);
      }
    };

    processEl(layerEl);
    layerEl.querySelectorAll('*').forEach((el) => processEl(el));

    // Also replace inside <style> blocks — these define CSS classes used by elements in the layer.
    // SVG CSS is document-scoped so we search the whole document's style elements.
    // We only replace class rules whose selectors are actually used within the selected layer.
    const layerClassNames = new Set<string>();
    [layerEl, ...Array.from(layerEl.querySelectorAll('[class]'))].forEach((el) => {
      el.getAttribute('class')?.split(/\s+/).forEach((c) => c && layerClassNames.add(c));
    });

    doc.querySelectorAll('style').forEach((styleEl) => {
      const css = styleEl.textContent;
      if (!css) return;
      // Only process rules whose selector matches a class used in the layer
      const newCss = css.replace(
        /([^{}]+)\{([^{}]*)\}/g,
        (block, selector: string, declarations: string) => {
          const selectorUsed = selector.split(',').some((s) =>
            [...layerClassNames].some((cls) => s.includes(`.${cls}`))
          );
          if (!selectorUsed) return block;
          const { result, changed } = replaceInCss(declarations);
          return changed ? `${selector}{${result}}` : block;
        },
      );
      if (newCss !== css) styleEl.textContent = newCss;
    });

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayer, colorReplaceFrom, colorReplaceTo]);

  // ── AI layer actions ───────────────────────────────────────────────────────

  const runAiLayerAction = useCallback(async (action: 'strip-text' | 'suggest-font' = 'strip-text') => {
    if (!activeSvg || !selectedLayer) return;
    const layerId = selectedLayer;
    setAiLoading(true);
    setAiError(null);
    setAiStatusMsg('Thinking…');
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

      // ── Strip text (combined detect + strip + replace) ─────────────────────
      type TextRow = {
        yFraction: number; xFraction: number;
        font: string; sizeFraction: number;
        weight: number; color: string; content: string;
        letterSpacing: number;
      };
      type StripResult = { hasText: boolean; rows: TextRow[]; strippedSvg: string };

      const cacheKey = `strip-text-v2:${hashString(svgString)}`;
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
- letterSpacing: estimated CSS letter-spacing in em units (e.g. 0.0 for normal, 0.1 for slightly wide, 0.3 for very wide/spaced-out, negative values for condensed)

TASK 2 — SVG stripping: Return the SVG source code below with ALL text-related content removed: <text>, <tspan>, <flowRoot> elements AND any path or shape groups that visually render as outlined or filled text characters. Preserve every non-text graphic, decorative, and structural element unchanged.

SVG source:
${svgString}

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"hasText":true,"rows":[{"yFraction":0.5,"xFraction":0.5,"font":"Impact","sizeFraction":0.08,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0.05}],"strippedSvg":"<g id=\\"layer_1\\">...</g>"}` },
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
        } catch {
          const svgMatch = rawText.match(/<(?:g|svg)[\s\S]*?<\/(?:g|svg)>/);
          if (svgMatch) {
            parsed = { hasText: false, rows: [], strippedSvg: svgMatch[0] };
          } else {
            throw new Error('AI returned an unreadable response');
          }
        }

        aiCacheRef.current.set(cacheKey, JSON.stringify(parsed));
      }

      // Apply stripped SVG
      setAiStatusMsg('Applying changes…');
      const strippedStr = parsed.strippedSvg
        .replace(/^```(?:xml|svg)?\s*/im, '').replace(/```\s*$/m, '').trim();
      const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${strippedStr}</svg>`;
      const wrapperDoc = new DOMParser().parseFromString(wrapper, 'image/svg+xml');
      if (wrapperDoc.querySelector('parsererror')) throw new Error('AI returned invalid SVG');
      const newLayerEl = wrapperDoc.documentElement.firstElementChild;
      if (!newLayerEl) throw new Error('AI returned an empty SVG');

      const imported = doc.importNode(newLayerEl, true);
      layerEl.parentNode?.replaceChild(imported, layerEl);

      // For each detected text row, create a replacement text layer at the same visual position
      const newTextLayers: SvgLayer[] = [];
      if (parsed.hasText && parsed.rows.length > 0) {
        parsed.rows.forEach((row, i) => {
          const cx = vbX + row.xFraction * vw;
          const cy = vbY + row.yFraction * vh;
          const fontSize = Math.max(8, Math.round(row.sizeFraction * vh));
          const label = row.content.trim() || 'Text';
          const newId = `_text_${Date.now()}_${i}`;

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
          if (row.letterSpacing) textEl.setAttribute('letter-spacing', `${row.letterSpacing}em`);
          textEl.textContent = label;
          doc.documentElement.appendChild(textEl);
          newTextLayers.push({ id: newId, label });
          addGoogleFont(row.font);
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
  }, [activeSvg, selectedLayer, addGoogleFont]);

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
    setColorReplaceFrom('');
  }, [selectedLayer]);

  useEffect(() => {
    setImageFonts(null);
    setShowImageFonts(false);
    if (!activeSvg) { setTaxonomy(null); return; }
    setTaxonomy([
      { type: 'background', elements: ['solid dark circular background'] },
      { type: 'icon',       elements: ['central star or emblem motif', 'geometric ring border'] },
      { type: 'decoration', elements: ['radiating line pattern', 'outer decorative ring'] },
      { type: 'text',       elements: ['curved banner text', 'label underneath emblem'] },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSvg?.src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clear(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

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
      <aside className="w-44 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900/60">
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
                <div className="w-full aspect-square rounded-md overflow-hidden bg-zinc-950/60">
                  <img src={sample.src} alt={sample.label} className="w-full h-full object-contain p-1.5" />
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
            <div className="flex items-center gap-3 px-4 h-11 border-b border-zinc-800 shrink-0">
              <span className="text-zinc-400 text-sm font-mono truncate min-w-0 flex-1">
                {isLoading && !activeSvg ? 'Loading…' : activeSvg?.name}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {selectedLayer && (
                  <button
                    onClick={centerLayersToSelected}
                    title="Center all layers to the selected layer"
                    className="text-xs px-2 py-1 rounded font-mono border border-zinc-600 transition-colors"
                    style={{ backgroundColor: '#075985', color: '#fff' }}
                  >
                    center layers
                  </button>
                )}
                <button
                  onClick={suggestFontsForImage}
                  disabled={imageFontsLoading || imageFonts !== null}
                  className="flex items-center gap-1.5 text-xs text-zinc-300 px-2 py-1 rounded border border-zinc-600 transition-colors hover:bg-zinc-800"
                  style={imageFontsLoading ? { opacity: 0.5 } : undefined}
                >
                  <SparklesIcon className="size-3" />
                  {imageFontsLoading ? 'Thinking…' : 'Suggest fonts'}
                </button>
                <button
                  onClick={clear}
                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
                >
                  Open new file
                  <kbd className="text-zinc-700 text-[10px] font-mono">ESC</kbd>
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
                    {imageFonts.map(({ font, reason }) => (
                      <div key={font} className="flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-1">
                        <span className="text-xs text-zinc-200" style={{ fontFamily: font }}>{font}</span>
                        <span className="text-[10px] text-zinc-500 hidden sm:inline">— {reason}</span>
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
              </div>

              {/* ── Layers panel ─────────────────────────────────────── */}
              {activeSvg && (
                <aside className="w-52 shrink-0 flex flex-col border-l border-zinc-800 bg-zinc-900/60">
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
                        {selectedTextProps ? 'Edit Text' : 'Add Text'}
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
                        className="h-[26px] flex-1 rounded border border-zinc-700 bg-zinc-800 cursor-pointer p-0.5"
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
                          className="h-[26px] w-7 shrink-0 flex items-center justify-center rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 1 1 3.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                      )}
                    </div>
                    {/* Letter spacing */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 w-8 shrink-0">Space</span>
                      <select
                        value={selectedTextProps ? selectedTextProps.letterSpacing : textForm.letterSpacing}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          selectedTextProps
                            ? updateTextLayer({ letterSpacing: v })
                            : setTextForm((f) => ({ ...f, letterSpacing: v }));
                        }}
                        className="flex-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500"
                      >
                        {([-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3] as const).map((v) => (
                          <option key={v} value={v}>
                            {v === 0 ? 'Normal' : v < 0 ? `Tight (${v}em)` : `+${v}em`}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Curve slider — always in add mode; in edit mode only for curved layers */}
                    {(!selectedTextProps || selectedTextProps.curve !== null) && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-zinc-500 w-8 shrink-0">Curve</span>
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          step={5}
                          value={selectedTextProps ? (selectedTextProps.curve as number) : textForm.curve}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            selectedTextProps
                              ? updateTextLayer({ curve: v })
                              : setTextForm((f) => ({ ...f, curve: v }));
                          }}
                          className="flex-1 accent-zinc-400"
                        />
                        <span className="text-[10px] text-zinc-500 w-7 text-right tabular-nums">
                          {selectedTextProps ? (selectedTextProps.curve as number) : textForm.curve}
                        </span>
                      </div>
                    )}
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

                  {/* AI Actions — visible only when a layer is selected */}
                  {selectedLayer && (
                    <div className="border-b border-zinc-800 shrink-0">
                      <button
                        onClick={() => setAiActionsOpen((o) => !o)}
                        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
                      >
                        <SparklesIcon className="size-3 text-indigo-400" />
                        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest flex-1 text-left">
                          AI Actions
                        </span>
                        <span className="text-zinc-600 text-[10px]">{aiActionsOpen ? '▲' : '▼'}</span>
                      </button>
                    {aiActionsOpen && <div className="px-2 pb-2 flex flex-col gap-1.5">
                      {aiError && (
                        <p className="text-[10px] text-red-400 px-1 break-all leading-tight">{aiError}</p>
                      )}

                      <button
                        onClick={() => runAiLayerAction('strip-text')}
                        disabled={aiLoading}
                        className={cn(
                          'w-full rounded text-xs font-medium py-1.5 transition-colors',
                          aiLoading
                            ? 'bg-zinc-800/40 text-zinc-600 cursor-wait'
                            : 'bg-indigo-900/60 hover:bg-indigo-800/60 text-indigo-300'
                        )}
                      >
                        {aiLoading ? 'AI processing…' : 'Strip text (AI)'}
                      </button>

                      <button
                        onClick={() => runAiLayerAction('suggest-font')}
                        disabled={aiLoading}
                        className={cn(
                          'w-full rounded text-xs font-medium py-1.5 transition-colors',
                          aiLoading
                            ? 'bg-zinc-800/40 text-zinc-600 cursor-wait'
                            : 'bg-zinc-700/60 hover:bg-zinc-600/60 text-zinc-300'
                        )}
                      >
                        {aiLoading ? 'AI processing…' : 'Suggest font (AI)'}
                      </button>

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
                  )}

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
                        <span className="text-[10px] text-zinc-500 px-1">From</span>
                        <div className="flex flex-wrap gap-1.5 px-1 items-start">
                          {layerColors.length > 0 ? layerColors.map((color) => (
                            <button
                              key={color}
                              title={color}
                              onClick={() => setColorReplaceFrom(color)}
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

                      {/* To row */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-zinc-500 w-7 shrink-0">To</span>
                        <input
                          type="color"
                          value={colorReplaceTo}
                          onChange={(e) => setColorReplaceTo(e.target.value)}
                          className="h-[26px] flex-1 rounded border border-zinc-700 bg-zinc-800 cursor-pointer p-0.5"
                          title="Replacement color"
                        />
                        {'EyeDropper' in window && (
                          <button
                            title="Sample 'to' color from canvas"
                            onClick={async () => {
                              try {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const dropper = new (window as any).EyeDropper();
                                const result = await dropper.open() as { sRGBHex: string };
                                setColorReplaceTo(result.sRGBHex);
                              } catch { /* cancelled */ }
                            }}
                            className="h-[26px] w-7 shrink-0 flex items-center justify-center rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 1 1 3.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                          </button>
                        )}
                      </div>

                      <button
                        onClick={replaceColorInLayer}
                        disabled={!colorReplaceFrom}
                        className={cn(
                          'w-full rounded text-xs font-medium py-1.5 transition-colors',
                          colorReplaceFrom
                            ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
                            : 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
                        )}
                      >
                        Replace in layer
                      </button>
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
                          <div
                            key={layer.id}
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
                        );
                      })
                    )}
                  </div>

                  {/* Taxonomy */}
                  {(taxonomyLoading || taxonomy) && (
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
                      {taxonomyOpen && taxonomy && (
                        <div className="px-2 pb-2 flex flex-col gap-0.5 max-h-44 overflow-y-auto">
                          {taxonomy.map((group, i) => (
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
                  )}

                  {/* Reset + Export buttons */}
                  <div className="p-2 border-t border-zinc-800 shrink-0 flex flex-col gap-1.5">
                    <button
                      onClick={resetSvg}
                      disabled={!isDirty}
                      className={cn(
                        'w-full flex items-center justify-center gap-1.5 rounded-md text-xs font-medium py-2 transition-colors',
                        isDirty
                          ? 'bg-zinc-800/60 hover:bg-red-900/40 text-zinc-400 hover:text-red-300 cursor-pointer'
                          : 'bg-zinc-800/30 text-zinc-600 cursor-not-allowed'
                      )}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                      </svg>
                      Reset
                    </button>
                    <button
                      onClick={exportSvg}
                      className="w-full flex items-center justify-center gap-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 text-xs font-medium py-2 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                      {hiddenLayers.size > 0
                        ? `Export (${activeSvg.layers.length - hiddenLayers.size} layers)`
                        : 'Export SVG'}
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
