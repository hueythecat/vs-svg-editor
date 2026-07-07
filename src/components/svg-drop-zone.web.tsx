import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type ActiveSvg,
  type SvgLayer,
  type TaxonomyGroup,
  applyTranslateDelta,
  bboxInRootSpace,
  collectLayerGradientIds,
  computeArcPath,
  extractLayerColors,
  findClickedSubText,
  hashString,
  normalizeColor,
  parseSvg,
  resolveGradient,
  stripScripts,
  svgToBase64Png
} from '@/lib/svg-utils';
import { cn } from '@/lib/utils';
import type { AiActionType } from './layers-panel';
import { LayersPanel } from './layers-panel';
import { SamplesSidebar } from './samples-sidebar';
import { SparklesIcon } from './svg-icons';

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
- font: name of the closest matching Google Font
- sizeFraction: font cap-height as a fraction of image height (e.g. 0.08 if text height ≈ 8% of image)
- weight: CSS font-weight integer (100, 200, 300, 400, 500, 600, 700, 800, or 900)
- color: dominant text fill color as CSS hex (e.g. "#ffffff")
- content: the exact text string if legible, else ""
- letterSpacing: CSS letter-spacing in em units. Default to 0.0 (normal) if you are not certain — only use a non-zero value when you can clearly see unusually wide or condensed tracking (e.g. 0.1 slightly wide, 0.3 very wide, -0.05 condensed)

IMPORTANT: If a single horizontal line contains multiple words in different colors, fonts, sizes, or styles, return a SEPARATE row for each such word — same yFraction, but its own xFraction, color and font. Do NOT merge differently-styled words on one line into a single row.

TASK 2 — Text element identification: Most SVG elements in the source have a data-ai-idx attribute. Identify which elements visually render as text — including <text>/<tspan> elements AND <path>/<g> elements whose shapes form letter or word outlines. IMPORTANT: if a <g> group contains child paths that together form a word, return the group's data-ai-idx (not the individual letter path indices). Return every text element's data-ai-idx in "removeIds". NOTE: already-editable text fields have deliberately NOT been given a data-ai-idx — never invent indices for them; only return indices that actually appear in the source below.`;

// Mounts a hidden clone of svgRoot (carrying its data-* marks) so getBBox works on a
// detached/parsed SVG document, runs fn against it, and always unmounts.
const withOffscreenSvg = <T,>(svgRoot: Element, fn: (mounted: SVGSVGElement) => T): T => {
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

// Drops removeIds whose element covers ≥ BACKGROUND_AREA_LIMIT of the canvas — a
// background or decoration the vision model mislabeled as text. Shared by the
// strip-text and customise passes so both guard identically. svgRoot must already
// carry the data-ai-idx marks.
const BACKGROUND_AREA_LIMIT = 0.5; // ≥50% of the canvas ⇒ background, never a text run
const filterOutBackgroundIds = (
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
const isFullCanvasLayer = (
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

// ─── Component ───────────────────────────────────────────────────────────────

export function SvgDropZone() {
  const [activeSvg, setActiveSvg]       = useState<ActiveSvg | null>(null);
  const [activeSample, setActiveSample] = useState<SampleName | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
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
  const [selectedImageFont, setSelectedImageFont] = useState<string | null>(null);
  const [customiseFonts, setCustomiseFonts]   = useState<string[]>([]);
  const [customiseLoading, setCustomiseLoading] = useState(false);
  const [customiseDone, setCustomiseDone] = useState(false);
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
  const [selectedSubElId, setSelectedSubElId] = useState<string | null>(null);
  const aiCacheRef              = useRef<Map<string, string>>(new Map());
  const dragMovedRef            = useRef(false);
  const colorBaselineRef        = useRef<string | null>(null);
  const autoColorSelectedRef    = useRef(false);
  const undoStackRef             = useRef<Array<{ content: string; layers: SvgLayer[] }>>([]);
  const [undoCount, setUndoCount] = useState(0);
  const textEditSnappedRef = useRef(false);
  const fileInputRef       = useRef<HTMLInputElement>(null);
  const svgCanvasRef    = useRef<HTMLDivElement>(null);
  const textContentRef  = useRef<HTMLInputElement>(null);
  const overlayRef      = useRef<HTMLDivElement>(null);
  const subOverlayRef   = useRef<HTMLDivElement>(null);

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
      setCustomiseDone(false);
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

  // Map from layer id → sub-text children, for groups that contain multiple <text id="…"> elements
  const subLayerMap = useMemo(() => {
    const map = new Map<string, { id: string; label: string }[]>();
    if (!activeSvg) return map;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    for (const layer of activeSvg.layers) {
      const el = doc.getElementById(layer.id);
      if (!el || el.tagName.toLowerCase() !== 'g') continue;
      const texts = Array.from(el.querySelectorAll('text')).filter((c) => c.id);
      if (texts.length > 1) {
        map.set(layer.id, texts.map((c) => ({
          id: c.id,
          label: c.textContent?.trim() || c.id,
        })));
      }
    }
    return map;
  }, [activeSvg?.content]);

  // Click on canvas: walk up from the clicked element to find its layer. When the
  // clicked layer holds text (and the click wasn't on the drag overlay), focus the
  // side-panel text input so keyboard input edits it immediately. For a plain group
  // with several <text> children, target the specific one that was clicked.
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeSvg?.layers.length) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    // Ignore clicks on the selection overlay (drag handle)
    if ((e.target as Element).closest?.('[data-sel-overlay]')) return;
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let el = e.target as Element | null;
    while (el && el !== (svgEl as Element)) {
      if (el.parentElement === (svgEl as Element) && layerIds.has(el.id)) {
        selectOne(el.id);
        const isText =
          el.getAttribute('data-text-layer') === '1' ||
          el.tagName.toLowerCase() === 'text' ||
          !!el.querySelector('text');
        if (isText) {
          // selectOne clears any sub-element; re-target the clicked <text> child.
          if (el.getAttribute('data-text-layer') !== '1' && el.tagName.toLowerCase() !== 'text') {
            const found = findClickedSubText(el, e.target);
            if (found?.id) setSelectedSubElId(found.id);
          }
          // Open the Text panel and focus its input so typing edits the text in place.
          // Place the caret at the end (rather than selecting all) so typing appends.
          setTextFormOpen(true);
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
      // Translate the HTML overlay to follow the layer (screen-pixel delta)
      if (overlayRef.current) {
        const sdx = e.clientX - canvasDrag.startClientX;
        const sdy = e.clientY - canvasDrag.startClientY;
        overlayRef.current.style.transform = `translate(${sdx}px, ${sdy}px)`;
      }
    };

    const onUp = () => {
      if (svgEl && dragMovedRef.current) {
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

  // The selection overlay's first/primary layer drives its position. Hide the
  // overlay entirely when that layer is the locked background layer.
  const selectionLayerId = selectedLayers.size ? [...selectedLayers][0] : null;
  const showSelectionOverlay = !!selectionLayerId && selectionLayerId !== backgroundLayerId;

  // ── Selection overlay (HTML div, direct DOM manipulation) ───────────────────
  // Pure ref manipulation — no state, no re-renders. React only manages the
  // static structural properties (position, outline, zIndex). Everything else
  // (left, top, width, height, display, transform) is set directly so React
  // can never override them between layout-effect runs.

  useLayoutEffect(() => {
    const overlay    = overlayRef.current;
    const subOverlay = subOverlayRef.current;

    // Always clear any drag-time transform first
    if (overlay) overlay.style.transform = '';
    // Sub-overlay starts hidden each cycle; shown below if needed
    if (subOverlay) subOverlay.style.display = 'none';

    if (!showSelectionOverlay || !selectionLayerId || !overlay) return;

    const svgEl    = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    const canvasEl = svgCanvasRef.current;
    if (!svgEl || !canvasEl) return;

    const layerId = selectionLayerId;
    const layerEl = svgEl.querySelector(`#${CSS.escape(layerId)}`);
    if (!layerEl) return;

    try {
      const canvasRect = canvasEl.getBoundingClientRect();
      let lr: { left: number; top: number; width: number; height: number } =
        layerEl.getBoundingClientRect();
      if (!lr.width && !lr.height) {
        // An empty text layer collapses to a zero-size box, so there'd be nothing
        // to show or click. Synthesize a placeholder rect at the text anchor (using
        // the element's own screen CTM so ancestor transforms are included) so the
        // selection overlay still appears and remains a drag/click target.
        const textEl = (layerEl.tagName.toLowerCase() === 'text'
          ? layerEl
          : layerEl.querySelector('text')) as SVGTextElement | null;
        const ctm = textEl?.getScreenCTM();
        if (!textEl || !ctm) return;
        const groupEl = layerEl as Element;
        const x = parseFloat(
          textEl.getAttribute('x') ?? groupEl.getAttribute('data-cx') ?? '0');
        const y = parseFloat(
          textEl.getAttribute('y') ?? groupEl.getAttribute('data-cy') ?? '0');
        const fs = parseFloat(
          textEl.getAttribute('font-size') ?? groupEl.getAttribute('data-fontsize') ?? '16');
        const pt = (svgEl as SVGSVGElement).createSVGPoint();
        pt.x = x; pt.y = y;
        const sp = pt.matrixTransform(ctm);
        const h = Math.max(fs * ctm.a, 12);
        const w = Math.max(h * 3, 40); // generous width so the empty field is easy to click
        const anchor = textEl.getAttribute('text-anchor');
        const left = anchor === 'end' ? sp.x - w : anchor === 'middle' ? sp.x - w / 2 : sp.x;
        // dominant-baseline:middle keeps the glyph centered on y
        lr = { left, top: sp.y - h / 2, width: w, height: h };
      }
      const pad = 4;

      overlay.style.left   = `${lr.left - canvasRect.left + canvasEl.scrollLeft - pad}px`;
      overlay.style.top    = `${lr.top  - canvasRect.top  + canvasEl.scrollTop  - pad}px`;
      overlay.style.width  = `${lr.width  + pad * 2}px`;
      overlay.style.height = `${lr.height + pad * 2}px`;

      if (subOverlay && selectedSubElId) {
        const subEl = svgEl.querySelector(`#${CSS.escape(selectedSubElId)}`);
        if (subEl) {
          const sr = subEl.getBoundingClientRect();
          // Position relative to the overlay's top-left corner (lr.left-pad, lr.top-pad)
          subOverlay.style.display = 'block';
          subOverlay.style.left    = `${sr.left - lr.left}px`;
          subOverlay.style.top     = `${sr.top  - lr.top}px`;
          subOverlay.style.width   = `${sr.width  + pad * 2}px`;
          subOverlay.style.height  = `${sr.height + pad * 2}px`;
        }
      }
    } catch {
      // getBoundingClientRect can throw if the element is not in the DOM
    }
  }, [showSelectionOverlay, selectionLayerId, selectedSubElId, activeSvg?.content, canvasDrag]);

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

  // mousedown on canvas: drag any selected non-background layer
  const handleDragHandleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!selectedLayers.size || !activeSvg?.layers.length) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const draggableIds = [...selectedLayers].filter((id) => id !== backgroundLayerId);
    if (!draggableIds.length) return;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    dragMovedRef.current = false;

    const baseTransforms: Record<string, string> = {};
    draggableIds.forEach((id) => {
      const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`);
      if (layerEl) baseTransforms[id] = layerEl.getAttribute('transform') ?? '';
    });

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    setCanvasDrag({
      layerIds: draggableIds,
      startClientX: e.clientX, startClientY: e.clientY,
      startSvgX: svgPt.x,     startSvgY: svgPt.y,
      baseTransforms,
    });
  }, [activeSvg, selectedLayers, backgroundLayerId, snapshotForUndo]);

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
  }, [selectedLayer, selectedSubElId, activeSvg, snapshotForUndo]);

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
    setSelectedLayer(id); setSelectedSubElId(null);
  }, [activeSvg, textForm, snapshotForUndo]);

  // ── Center all layers to canvas horizontal midpoint ──────────────────────

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

    let changed = false;
    activeSvg.layers.forEach(({ id }) => {
      if (id === backgroundLayerId) return;
      const liveEl = svgEl.getElementById(id);
      if (!liveEl) return;
      const r = liveEl.getBoundingClientRect();
      const pt = svgEl.createSVGPoint();
      pt.x = r.left + r.width / 2;
      pt.y = r.top + r.height / 2;
      const center = pt.matrixTransform(inv);
      const dx = canvasCenterX - center.x;
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
  }, [activeSvg, backgroundLayerId, snapshotForUndo]);

  // ── Load + register a Google Font ─────────────────────────────────────────

  const loadGoogleFontLink = useCallback((fontName: string) => {
    const linkId = `gfont-${fontName.replace(/\s+/g, '-')}`;
    if (!document.getElementById(linkId)) {
      const link = document.createElement('link');
      link.id = linkId; link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, '+')}:wght@400;700&display=swap`;
      document.head.appendChild(link);
    }
  }, []);

  const addGoogleFont = useCallback((fontName: string) => {
    setExtraFonts((prev) => prev.includes(fontName) ? prev : [...prev, fontName]);
    loadGoogleFontLink(fontName);
  }, [loadGoogleFontLink]);

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

      console.log('[suggest-fonts] invoking LLM:', 'claude-sonnet-5');
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
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

  const runCustomise = useCallback(async () => {
    if (!activeSvg) return;
    setCustomiseLoading(true);
    setAiLoading(true);
    setAiError(null);
    setAiStatusMsg('Analysing image…');
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const root = doc.documentElement;
      const viewBox = root.getAttribute('viewBox') ?? '0 0 800 600';
      const vbParts = viewBox.trim().split(/[\s,]+/).map(Number);
      const vbX = vbParts[0] ?? 0;
      const vbY = vbParts[1] ?? 0;
      const vw  = vbParts[2] ?? 800;
      const vh  = vbParts[3] ?? 600;

      // Per-layer processing (below) rasterizes each layer on its own, so here we only
      // need the shared raster scale and the document <defs> (gradients/styles) that
      // each isolated layer must render against.
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const defsEl = doc.querySelector('defs');
      const defsXml = defsEl ? new XMLSerializer().serializeToString(defsEl) : '';

      type TextRow = {
        yFraction: number; xFraction: number;
        font: string; sizeFraction: number;
        weight: number; color: string; content: string;
        letterSpacing: number;
      };
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
          const tag = child.tagName.toLowerCase().replace(/.*:/, '');
          if (SHAPE_TAGS.has(tag)) {
            const sid = String(aiIdx++);
            child.setAttribute('data-ai-idx', sid);
            aiIdMap.set(sid, child);
          }
          markEls(child);
        }
      };

      const contentEls: Element[] = [];
      for (const layer of activeSvg.layers) {
        if (layer.id.startsWith('_text_')) continue;                 // already-editable text
        const layerEl = doc.getElementById(layer.id);
        if (!layerEl || isEditableTextField(layerEl)) continue;
        if (isFullCanvasLayer(doc.documentElement, layer.id, vw, vh)) {
          console.log('[customise] skipping full-canvas background layer:', layer.id);
          continue;
        }
        contentEls.push(layerEl);
      }
      contentEls.forEach((el) => markEls(el));
      const contentXml = contentEls.map((el) => new XMLSerializer().serializeToString(el)).join('');
      // Scoped raster: defs + content layers only (no background) at the full viewBox.
      const contentSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}">${defsXml}${contentXml}</svg>`;
      const pngBase64 = await svgToBase64Png(contentSvg, Math.round(vw * scale), Math.round(vh * scale));

      setAiStatusMsg('Detecting text…');
      console.log('[customise] invoking LLM:', TEXT_PARSE_MODEL);
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TEXT_PARSE_MODEL,
          max_tokens: 8192,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
              { type: 'text', text: `Analyze this SVG image and its source.

${TEXT_PARSING_PROMPT}

TASK 3 — Font suggestions: Suggest 2–4 Google Font names that suit the style, mood, and colour palette of this design. Return names only.

SVG source:
${contentXml}

Return ONLY valid JSON, no markdown:
{"hasText":true,"rows":[{"yFraction":0.3,"xFraction":0.5,"font":"Playfair Display","sizeFraction":0.1,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0}],"removeIds":["3","9"],"fonts":["Playfair Display","Lato"]}` },
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

      let parsed: CustomiseResult;
      try {
        parsed = JSON.parse(rawText) as CustomiseResult;
        if (!Array.isArray(parsed.rows)) parsed.rows = [];
        if (!Array.isArray(parsed.removeIds)) parsed.removeIds = [];
        if (!Array.isArray(parsed.fonts)) parsed.fonts = [];
      } catch {
        throw new Error('AI returned an unreadable response');
      }
      console.log('[customise] LLM returned:', { hasText: parsed.hasText, removeIds: parsed.removeIds, rows: parsed.rows.length });

      setAiStatusMsg('Applying changes…');
      const removeIds = filterOutBackgroundIds(doc.documentElement, parsed.removeIds, vw, vh, 'customise');
      console.log(`[customise] removing ${removeIds.length}/${parsed.removeIds.length} element(s) after guard`);
      for (const sid of removeIds) {
        const el = aiIdMap.get(sid);
        el?.parentNode?.removeChild(el);
      }
      for (const [, el] of aiIdMap) el.removeAttribute('data-ai-idx');

      const allRows = parsed.hasText ? parsed.rows : [];
      const allFonts = parsed.fonts;

      // Re-add editable text layers (same placement logic as strip-text)
      const newTextLayers: SvgLayer[] = [];
      if (allRows.length > 0) {
        const Y_THRESHOLD = 0.03;
        const groups: TextRow[][] = [];
        const sorted = [...allRows].sort((a, b) => a.yFraction - b.yFraction);
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
            textEl.setAttribute('x', String(cx)); textEl.setAttribute('y', String(cy));
            textEl.setAttribute('text-anchor', 'middle'); textEl.setAttribute('dominant-baseline', 'middle');
            textEl.setAttribute('font-family', row.font || 'Arial');
            textEl.setAttribute('font-size', String(fontSize));
            textEl.setAttribute('font-weight', String(row.weight || 400));
            textEl.setAttribute('fill', row.color || '#000000');
            const ls = snapLS(row.letterSpacing ?? 0); if (ls !== 0) textEl.setAttribute('letter-spacing', `${ls}em`);
            textEl.textContent = label;
            root.appendChild(textEl);
          } else {
            const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.id = newId; g.setAttribute('data-name', label);
            group.forEach((row, si) => {
              const cx = vbX + row.xFraction * vw;
              const cy = vbY + row.yFraction * vh;
              const fontSize = Math.max(8, Math.round(row.sizeFraction * vh));
              const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
              textEl.id = `${newId}_${si}`;
              textEl.setAttribute('x', String(cx)); textEl.setAttribute('y', String(cy));
              textEl.setAttribute('text-anchor', 'middle'); textEl.setAttribute('dominant-baseline', 'middle');
              textEl.setAttribute('font-family', row.font || 'Arial');
              textEl.setAttribute('font-size', String(fontSize));
              textEl.setAttribute('font-weight', String(row.weight || 400));
              textEl.setAttribute('fill', row.color || '#000000');
              const ls = snapLS(row.letterSpacing ?? 0); if (ls !== 0) textEl.setAttribute('letter-spacing', `${ls}em`);
              textEl.textContent = row.content.trim() || 'Text';
              g.appendChild(textEl);
            });
            root.appendChild(g);
          }
          newTextLayers.push({ id: newId, label });
        });
      }

      // Store suggested fonts (load them for preview) — deduped across all layers.
      const validFonts = Array.from(new Set(allFonts.filter(Boolean))).slice(0, 6);
      validFonts.forEach((f) => loadGoogleFontLink(f));
      setCustomiseFonts(validFonts);

      const content = new XMLSerializer().serializeToString(root);
      setActiveSvg((prev) => {
        if (!prev) return null;
        return { ...prev, content, layers: newTextLayers.length > 0 ? [...prev.layers, ...newTextLayers] : prev.layers };
      });
      if (newTextLayers.length > 0) { setSelectedLayer(newTextLayers[0].id); setSelectedSubElId(null); }

    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Customise failed');
    } finally {
      setCustomiseLoading(false);
      setCustomiseDone(true);
      setAiLoading(false);
      setAiStatusMsg('Thinking…');
    }
  }, [activeSvg, addGoogleFont, loadGoogleFontLink, snapshotForUndo]);

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
      const vb = (root.getAttribute('viewBox') ?? '0 0 800 600').trim().split(/[\s,]+/).map(Number);
      const vw = vb[2] ?? 800;
      const vh = vb[3] ?? 600;
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(activeSvg.content, Math.round(vw * scale), Math.round(vh * scale));
      console.log('[taxonomy] invoking LLM:', 'claude-sonnet-5');
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
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

  const onSelectFromColor = useCallback((color: string) => {
    if (!activeSvg) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    setColorReplaceFrom(color);
    colorBaselineRef.current = activeSvg.content;
  }, [activeSvg, snapshotForUndo]);

  const onClearFromColor = useCallback(() => {
    setColorReplaceFrom('');
    colorBaselineRef.current = null;
  }, []);

  const onCurvePointerDown = useCallback((): number | null => {
    if (!selectedTextProps || !selectedLayer) return null;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    const el = svgEl?.getElementById(selectedLayer) as SVGGraphicsElement | null;
    if (!el || !svgEl) return null;
    const bbox = bboxInRootSpace(svgEl, el);
    return bbox ? bbox.y + bbox.height / 2 : null;
  }, [selectedTextProps, selectedLayer]);

  const onCurvePointerUp = useCallback((startCenterY: number) => {
    if (!selectedLayer || !activeSvg) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    const el = svgEl?.getElementById(selectedLayer) as SVGGraphicsElement | null;
    if (!el || !svgEl) return;
    const bbox = bboxInRootSpace(svgEl, el as SVGGraphicsElement);
    if (!bbox) return;
    const delta = startCenterY - (bbox.y + bbox.height / 2);
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
  }, [selectedLayer, activeSvg]);

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
      };

      // ── Suggest font ───────────────────────────────────────────────────────
      if (action === 'suggest-font') {
        console.log('[suggest-font] invoking LLM:', 'claude-sonnet-5');
        const response = await fetch('/api/claude', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: 'claude-sonnet-5',
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
        console.log('[check-text] invoking LLM:', 'claude-sonnet-5');
        const response = await fetch('/api/claude', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: 'claude-sonnet-5',
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
        console.log('[remove-specific-text] invoking LLM:', 'claude-sonnet-5');
        const response = await fetch('/api/claude', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: 'claude-sonnet-5',
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
          if (isEditableTextField(child)) continue;  // leave user-managed text fields alone
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
        const stripModel = TEXT_PARSE_MODEL;
        console.log('[strip-text] invoking LLM:', stripModel);
        const response = await fetch('/api/claude', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            model: stripModel,
            max_tokens: 8192,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
                { type: 'text', text: `Analyze this SVG layer image and its source code.

${TEXT_PARSING_PROMPT}

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
      console.log('[strip-text] LLM returned:', {
        hasText: parsed.hasText,
        rows: parsed.rows?.length ?? 0,
        removeIds: parsed.removeIds,
      });
      const stripRemoveIds = filterOutBackgroundIds(doc.documentElement, parsed.removeIds, vw, vh, 'strip-text');
      let stripDeleted = 0;
      for (const sid of stripRemoveIds) {
        const el = aiIdMap.get(sid);
        if (el?.parentNode) {
          el.parentNode.removeChild(el);
          stripDeleted++;
        } else {
          console.log('[strip-text] removeId has no matching element:', sid);
        }
      }
      console.log(`[strip-text] deleted ${stripDeleted}/${parsed.removeIds.length} element(s)`);
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
      if (newTextLayers.length > 0) { setSelectedLayer(newTextLayers[0].id); setSelectedSubElId(null); }

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
    setSelectedLayer(null); setSelectedSubElId(null);
  }, [activeSvg]);

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => revokePrev(activeSvg), []);

  useEffect(() => {
    textEditSnappedRef.current = false;
    autoColorSelectedRef.current = false;
    setAiError(null); setFontSuggestion(null); setSuggestedFontName(null);
    setColorReplaceFrom('');
    setShowRemoveTextInput(false); setRemoveTextQuery(''); setTextCheckResult(null);
    colorBaselineRef.current = null;
  }, [selectedLayer]);

  useEffect(() => {
    if (autoColorSelectedRef.current || layerColors.length !== 1 || !activeSvg) return;
    autoColorSelectedRef.current = true;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    setColorReplaceFrom(layerColors[0]);
    colorBaselineRef.current = activeSvg.content;
  }, [layerColors, activeSvg, snapshotForUndo]);

  useEffect(() => {
    setImageFonts(null);
    setShowImageFonts(false);
    setSelectedImageFont(null);
    setCustomiseFonts([]);
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
      <SamplesSidebar
        samples={SAMPLES}
        activeSample={activeSample}
        isLoading={isLoading}
        onOpenSample={openSample}
      />

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
                {/* Center layers to canvas midpoint */}
                <button
                  onClick={centerLayersToCanvas}
                  title="Center all layers horizontally"
                  className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <circle cx="12" cy="12" r="3" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M3 12h2m14 0h2" />
                    </svg>
                </button>

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
                    {imageFonts.map(({ font, reason }) => {
                      const isSelected = selectedImageFont === font;
                      return (
                        <div
                          key={font}
                          title={reason}
                          onClick={() => {
                            const next = isSelected ? null : font;
                            setSelectedImageFont(next);
                            if (next) {
                              if (selectedTextProps) updateTextLayer({ font: next });
                              else setTextForm((f) => ({ ...f, font: next }));
                            }
                          }}
                          className={cn(
                            'flex items-center gap-1.5 rounded px-2 py-1 cursor-pointer transition-colors',
                            isSelected
                              ? 'bg-indigo-600/30 ring-1 ring-indigo-500 text-indigo-200'
                              : 'bg-zinc-800 hover:bg-zinc-700/80 text-zinc-200'
                          )}
                        >
                          <span className="text-xs" style={{ fontFamily: font }}>{font}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); addGoogleFont(font); }}
                            title="Add to font list"
                            className={cn(
                              'transition-colors text-xs ml-1',
                              isSelected ? 'text-indigo-400 hover:text-indigo-200' : 'text-zinc-500 hover:text-zinc-200'
                            )}
                          >
                            +
                          </button>
                        </div>
                      );
                    })}
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
                    <div
                      className="svg-canvas"
                      style={{ width: '80%' }}
                      dangerouslySetInnerHTML={{ __html: activeSvg.content }}
                    />
                    {/* Selection overlay — React controls existence, layout effect controls position.
                        No display/left/top/width/height in JSX so React never overrides them.
                        Hidden for the locked background layer. */}
                    {showSelectionOverlay && (
                      <div
                        ref={overlayRef}
                        data-sel-overlay
                        // An empty text layer has no clickable geometry, so let its
                        // placeholder box catch clicks (re-focusing the input) instead
                        // of falling through and selecting the background. Non-empty
                        // layers stay click-through so glyph/sub-text clicks still work.
                        onClick={selectionIsEmptyText ? () => {
                          setTextFormOpen(true);
                          requestAnimationFrame(() => {
                            const input = textContentRef.current;
                            if (!input) return;
                            input.focus();
                            const end = input.value.length;
                            input.setSelectionRange(end, end);
                          });
                        } : undefined}
                        style={{
                          position: 'absolute',
                          pointerEvents: selectionIsEmptyText ? 'auto' : 'none',
                          outline: '2px dashed #3b82f6',
                          boxSizing: 'border-box',
                          zIndex: 5,
                        }}
                      >
                        {/* Sub-layer highlight (amber) — display toggled by layout effect */}
                        <div
                          ref={subOverlayRef}
                          style={{
                            position: 'absolute',
                            outline: '2px dashed #f59e0b',
                            boxSizing: 'border-box',
                            pointerEvents: 'none',
                          }}
                        />
                        {/* Drag handle — single-layer selection only */}
                        {selectedLayers.size === 1 && (
                          <div
                            onMouseDown={handleDragHandleMouseDown}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              position: 'absolute',
                              right: -8,
                              top: -8,
                              width: 16,
                              height: 16,
                              borderRadius: '50%',
                              background: '#3b82f6',
                              border: '2px solid white',
                              cursor: 'grab',
                              pointerEvents: 'all',
                            }}
                          />
                        )}
                      </div>
                    )}
                  </>
                ) : null}

              </div>

              {/* ── Layers panel ─────────────────────────────────────── */}
              {activeSvg && (
                <LayersPanel
                  activeSvg={activeSvg}
                  backgroundLayerId={backgroundLayerId}
                  isDirty={isDirty}
                  selectedLayer={selectedLayer}
                  selectedLayers={selectedLayers}
                  selectedSubElId={selectedSubElId}
                  hiddenLayers={hiddenLayers}
                  subLayerMap={subLayerMap}
                  selectedTextProps={selectedTextProps}
                  textContentRef={textContentRef}
                  text={{ form: textForm, setForm: setTextForm, open: textFormOpen, setOpen: setTextFormOpen }}
                  ai={{ loading: aiLoading, error: aiError, actionsOpen: aiActionsOpen, setActionsOpen: setAiActionsOpen, fontSuggestion, suggestedFontName, removeTextQuery, setRemoveTextQuery, showRemoveTextInput, setShowRemoveTextInput, textCheckResult, setTextCheckResult }}
                  color={{ from: colorReplaceFrom, to: colorReplaceTo, setTo: setColorReplaceTo, open: colorReplaceOpen, setOpen: setColorReplaceOpen, layerColors, baselineRef: colorBaselineRef }}
                  fonts={{ extra: extraFonts, imageFonts, imageFontsLoading, suggestOpen: suggestFontsOpen, setSuggestOpen: setSuggestFontsOpen, customiseFonts, customiseLoading, customiseDone }}
                  taxonomy={{ data: taxonomy, loading: taxonomyLoading, open: taxonomyOpen, setOpen: setTaxonomyOpen }}
                  onSelectOne={selectOne}
                  onSetSelectedLayers={setSelectedLayers}
                  onSetSelectedLayer={setSelectedLayer}
                  onSetSelectedSubElId={setSelectedSubElId}
                  onToggleLayer={toggleLayer}
                  onReorderLayers={reorderLayers}
                  onUpdateTextLayer={updateTextLayer}
                  onAddTextLayer={addTextLayer}
                  onCurvePointerDown={onCurvePointerDown}
                  onCurvePointerUp={onCurvePointerUp}
                  onRunAiAction={runAiLayerAction as (action?: AiActionType, query?: string) => void}
                  onSelectFromColor={onSelectFromColor}
                  onClearFromColor={onClearFromColor}
                  onReplaceColor={replaceColorInLayer}
                  onAddGoogleFont={addGoogleFont}
                  onSuggestFonts={suggestFontsForImage}
                  onCustomise={runCustomise}
                  onApplyFontGlobally={applyFontGlobally}
                  onRunTaxonomy={runTaxonomyAnalysis}
                  onReset={resetSvg}
                />
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
