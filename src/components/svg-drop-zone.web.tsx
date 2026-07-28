import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type ActiveSvg,
  type SvgLayer,
  type TaxonomyGroup,
  applyTranslateDelta,
  bboxInRootSpace,
  collectLayerGradientIds,
  computeArcPath,
  detectBackgroundLayerId,
  extractLayerColors,
  filterOutBackgroundIds,
  findClickedSubText,
  hashString,
  isFullCanvasLayer,
  isPlainWhiteLayer,
  normalizeColor,
  parseSvg,
  parseViewBox,
  pruneMissingLayers,
  resolveGradient,
  stripScripts,
  svgToBase64Png,
  withOffscreenSvg
} from '@/lib/svg-utils';
import { C, EDITOR_CSS, FONT_STACK, SHADOW } from '@/lib/design-tokens';
import type { AiActionType, LlmProvider } from './editor-types';
import { LLM_OPTIONS } from './editor-types';
import { LayersPanel } from './editor-layers-panel';
import { EditorInspector } from './editor-inspector';
import { AiPanel, AiPill } from './editor-ai-panel';
import { DevRail, SAMPLE_DRAG_MIME } from './dev-rail';
import { UpsellModal, RatingModal, AbortReasonModal, ConfirmModal } from './editor-modals';
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

// Every AI prompt below demands bare JSON, and both providers ignore that often
// enough to matter: Claude in particular likes to wrap the object in a ```json
// fence, which makes JSON.parse throw. Strip it before parsing — always, not just
// where a fence has been observed, since which model answers is a runtime choice.
const stripJsonFence = (raw: string) =>
  raw.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim();

// ─── Component ───────────────────────────────────────────────────────────────

export function SvgDropZone() {
  const [activeSvg, setActiveSvg]       = useState<ActiveSvg | null>(null);
  // string (not SampleName) because openSample now also loads fetched downloads,
  // whose names aren't in the static SAMPLES union.
  const [activeSample, setActiveSample] = useState<string | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  // What `hiddenLayers` starts as for this document (the canvas layer) — the baseline
  // the dirty check and Revert compare against.
  const [defaultHiddenLayers, setDefaultHiddenLayers] = useState<Set<string>>(new Set());
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
    layerId: string;
    cx: number; cy: number;              // rotation centre in SVG root space
    startClientX: number; startClientY: number;
    startAngle: number;                  // pointer angle at grab, degrees
    baseTransform: string;
  } | null>(null);
  const [canvasScale, setCanvasScale] = useState<{
    layerId: string;
    cx: number; cy: number;              // scale centre in SVG root space
    startClientX: number; startClientY: number;
    startDist: number;                   // pointer distance from centre at grab (root units)
    baseTransform: string;
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
  const [selectedSubElId, setSelectedSubElId] = useState<string | null>(null);
  const [aiPanelOpen, setAiPanelOpen]         = useState(false);   // opened by the AI pill
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false); // "Revert changes?" overlay
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
    return stripJsonFence(data.content?.[0]?.text ?? '');
  };
  const aiCacheRef              = useRef<Map<string, string>>(new Map());
  const dragMovedRef            = useRef(false);
  // An open colour-picker session: the colour being replaced and the document as it
  // was when the picker opened. Live dragging replays from that baseline, so the whole
  // pick is one undo entry rather than one per intermediate colour.
  const colorEditRef            = useRef<{ from: string; baseline: string } | null>(null);
  const undoStackRef             = useRef<Array<{ content: string; layers: SvgLayer[] }>>([]);
  const redoStackRef             = useRef<Array<{ content: string; layers: SvgLayer[] }>>([]);
  const layerClipboardRef        = useRef<string | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const textEditSnappedRef = useRef(false);
  const fileInputRef       = useRef<HTMLInputElement>(null);
  const svgCanvasRef    = useRef<HTMLDivElement>(null);
  const textContentRef  = useRef<HTMLInputElement>(null);
  const overlayRef      = useRef<HTMLDivElement>(null);
  const subOverlayRef   = useRef<HTMLDivElement>(null);
  const sizeBadgeRef    = useRef<HTMLSpanElement>(null);
  // Shown when an AI action is invoked on a gated asset (edit === 0).
  const [showUpsell, setShowUpsell] = useState(false);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const revokePrev = useCallback((svg: ActiveSvg | null) => {
    if (svg?.objectUrl) URL.revokeObjectURL(svg.objectUrl);
  }, []);

  // Any committing action pushes the current document and clears the redo stack.
  const snapshotForUndo = useCallback((content: string, layers: SvgLayer[]) => {
    undoStackRef.current = [...undoStackRef.current.slice(-9), { content, layers }];
    redoStackRef.current = [];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
  }, []);

  const undo = useCallback(() => {
    if (!activeSvg) return;
    const prev = undoStackRef.current.pop();
    if (!prev) { setUndoCount(0); return; }
    redoStackRef.current = [...redoStackRef.current.slice(-9), { content: activeSvg.content, layers: activeSvg.layers }];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    setActiveSvg((p) => p ? { ...p, content: prev.content, layers: prev.layers } : null);
  }, [activeSvg]);

  const redo = useCallback(() => {
    if (!activeSvg) return;
    const next = redoStackRef.current.pop();
    if (!next) { setRedoCount(0); return; }
    undoStackRef.current = [...undoStackRef.current.slice(-9), { content: activeSvg.content, layers: activeSvg.layers }];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    setActiveSvg((p) => p ? { ...p, content: next.content, layers: next.layers } : null);
  }, [activeSvg]);

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
      const bgId = detectBackgroundLayerId(content, layers);
      const hideCanvas = !!bgId && isPlainWhiteLayer(content, bgId);
      const defaultHidden = new Set(hideCanvas ? [bgId] : []);
      setDefaultHiddenLayers(defaultHidden);
      setHiddenLayers(new Set(defaultHidden));
      setSelectedLayer(null);
      setSelectedLayers(new Set());
      setIsLoading(false);
      setCustomiseDone(false);
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
    setDefaultHiddenLayers(new Set());
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

  // After an edit deletes layers, drop the selection/visibility state that pointed at
  // them: otherwise the overlay tracks an element that no longer exists and the export
  // count still subtracts layers that have gone.
  const dropSelectionOutside = useCallback((...groups: SvgLayer[][]) => {
    const ids = new Set(groups.flat().map((l) => l.id));
    const filterSet = (prev: Set<string>) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    };
    setSelectedLayer((cur) => (cur && !ids.has(cur) ? null : cur));
    setSelectedLayers(filterSet);
    setHiddenLayers(filterSet);
    setSelectedSubElId(null);
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
      // Recompute the overlay from the live element so it follows the layer.
      positionOverlayRef.current();
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
      const layerEl = svgEl.querySelector(`#${CSS.escape(canvasRotate.layerId)}`);
      if (layerEl) {
        layerEl.setAttribute(
          'transform',
          `rotate(${delta.toFixed(2)}, ${canvasRotate.cx}, ${canvasRotate.cy}) ${canvasRotate.baseTransform}`.trim(),
        );
      }
      // Recompute the overlay from the live element so it tracks the rotation.
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
      const layerEl = svgEl.querySelector(`#${CSS.escape(canvasScale.layerId)}`);
      if (layerEl) {
        // Scale about the layer's centre, then apply the original transform.
        layerEl.setAttribute(
          'transform',
          `translate(${canvasScale.cx}, ${canvasScale.cy}) scale(${s.toFixed(4)}) translate(${-canvasScale.cx}, ${-canvasScale.cy}) ${canvasScale.baseTransform}`.trim(),
        );
      }
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

  // The selection overlay's first/primary layer drives its position. Hide the
  // overlay entirely when that layer is the locked background layer.
  const selectionLayerId = selectedLayers.size ? [...selectedLayers][0] : null;
  const showSelectionOverlay = !!selectionLayerId && selectionLayerId !== backgroundLayerId;

  // Whether the primary selected layer holds text — scaling is offered only for
  // non-text artwork (text should be resized via font-size, not a scale transform).
  const selectionIsTextLayer = useMemo(() => {
    if (!activeSvg || !selectionLayerId) return false;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const el = doc.getElementById(selectionLayerId);
    if (!el) return false;
    return el.getAttribute('data-text-layer') === '1'
      || el.tagName.toLowerCase() === 'text'
      || !!el.querySelector('text');
  }, [activeSvg?.content, selectionLayerId]);

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
    const overlay    = overlayRef.current;
    const subOverlay = subOverlayRef.current;

    if (overlay) overlay.style.transform = '';
    if (subOverlay) subOverlay.style.display = 'none';

    if (!showSelectionOverlay || !selectionLayerId || !overlay) return;

    const svgEl    = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    const canvasEl = svgCanvasRef.current;
    if (!svgEl || !canvasEl) return;

    const layerEl = svgEl.querySelector(`#${CSS.escape(selectionLayerId)}`) as SVGGraphicsElement | null;
    if (!layerEl) return;

    const pad = 4;

    try {
      const canvasRect = canvasEl.getBoundingClientRect();
      const offX = -canvasRect.left + canvasEl.scrollLeft;
      const offY = -canvasRect.top  + canvasEl.scrollTop;

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
        if (sizeBadgeRef.current) {
          sizeBadgeRef.current.textContent = `${Math.round(width)} × ${Math.round(height)}`;
        }

        // Sub-layer highlight — mapped into the overlay's rotated frame.
        if (subOverlay && selectedSubElId) {
          const subEl  = svgEl.querySelector(`#${CSS.escape(selectedSubElId)}`) as SVGGraphicsElement | null;
          const subCtm = subEl?.getScreenCTM?.();
          let subBox: { x: number; y: number; w: number; h: number } | null = null;
          try { const bb = subEl?.getBBox(); if (bb) subBox = { x: bb.x, y: bb.y, w: bb.width, h: bb.height }; } catch { /* ignore */ }
          if (subEl && subCtm && subBox) {
            const smap = (lx: number, ly: number) => {
              const p = svgEl.createSVGPoint();
              p.x = lx; p.y = ly;
              const s = p.matrixTransform(subCtm);
              return { x: s.x + offX, y: s.y + offY };
            };
            const S0 = smap(subBox.x, subBox.y);
            const S1 = smap(subBox.x + subBox.w, subBox.y);
            const S3 = smap(subBox.x, subBox.y + subBox.h);
            // Express S0 in the overlay's local (un-rotated) frame.
            const dx = S0.x - P0.x, dy = S0.y - P0.y;
            const cos = Math.cos(-theta), sin = Math.sin(-theta);
            subOverlay.style.display = 'block';
            subOverlay.style.left    = `${dx * cos - dy * sin}px`;
            subOverlay.style.top     = `${dx * sin + dy * cos}px`;
            subOverlay.style.width   = `${Math.hypot(S1.x - S0.x, S1.y - S0.y)}px`;
            subOverlay.style.height  = `${Math.hypot(S3.x - S0.x, S3.y - S0.y)}px`;
          }
        }
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
      if (sizeBadgeRef.current) {
        sizeBadgeRef.current.textContent = `${Math.round(w + pad * 2)} × ${Math.round(h + pad * 2)}`;
      }
    } catch {
      // matrixTransform / getBBox can throw if the element is detached
    }
  }, [showSelectionOverlay, selectionLayerId, selectedSubElId, backgroundLayerId]);

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

  // mousedown on rotate handle: rotate the single selected non-background layer
  const handleRotateHandleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (selectedLayers.size !== 1 || !activeSvg?.layers.length) return;
    const id = [...selectedLayers][0];
    if (id === backgroundLayerId) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`) as SVGGraphicsElement | null;
    if (!layerEl) return;

    const box = bboxInRootSpace(svgEl, layerEl);
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
      layerId: id,
      cx, cy,
      startClientX: e.clientX, startClientY: e.clientY,
      startAngle,
      baseTransform: layerEl.getAttribute('transform') ?? '',
    });
  }, [activeSvg, selectedLayers, backgroundLayerId, snapshotForUndo]);

  // mousedown on scale handle: uniformly scale the single selected non-text layer
  const handleScaleHandleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (selectedLayers.size !== 1 || !activeSvg?.layers.length) return;
    const id = [...selectedLayers][0];
    if (id === backgroundLayerId) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const layerEl = svgEl.querySelector(`#${CSS.escape(id)}`) as SVGGraphicsElement | null;
    if (!layerEl) return;

    const box = bboxInRootSpace(svgEl, layerEl);
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    const startDist = Math.hypot(svgPt.x - cx, svgPt.y - cy);
    if (startDist < 1e-3) return;
    dragMovedRef.current = false;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    setCanvasScale({
      layerId: id,
      cx, cy,
      startClientX: e.clientX, startClientY: e.clientY,
      startDist,
      baseTransform: layerEl.getAttribute('transform') ?? '',
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
    // Select it outright — the inspector switches to the type form for the new layer.
    setSelectedLayer(id); setSelectedLayers(new Set([id])); setSelectedSubElId(null);
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
      const { w: vw, h: vh } = parseViewBox(root);
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(activeSvg.content, Math.round(vw * scale), Math.round(vh * scale));

      const raw = await callLlmVision({
        model: 'claude-sonnet-5', maxTokens: 1000, pngBase64, tag: 'suggest-fonts',
        prompt: `Look at this design image. Suggest 5 Google Fonts that would complement its visual style, mood, colour palette, and aesthetic. Consider the overall feel of the design.
Return JSON only, no markdown: {"suggestions":[{"font":"Font Name","reason":"brief reason"}]}`,
      });
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
    // Gated assets (edit === 0) can't use the AI features — show the upsell instead.
    if (activeSvg.edit === 0) { setShowUpsell(true); return; }
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
      if (bottomEl && isFullCanvasLayer(doc.documentElement, bottomEl.id, vw, vh)) {
        console.log('[customise] skipping full-canvas background layer:', bottomEl.id);
        contentEls = eligibleEls.slice(1);
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
      const pngBase64 = await svgToBase64Png(contentSvg, Math.round(vw * scale), Math.round(vh * scale));

      setAiStatusMsg('Reviewing vector…');
      const rawText = await callLlmVision({
        model: TEXT_PARSE_MODEL, maxTokens: 8192, pngBase64, tag: 'customise',
        prompt: `Analyze this SVG image and its source.

${TEXT_PARSING_PROMPT}

TASK 3 — Font suggestions: Suggest 2–4 Google Font names that suit the style, mood, and colour palette of this design. Return names only.

SVG source:
${contentXml}

Return ONLY valid JSON, no markdown:
{"hasText":true,"rows":[{"yFraction":0.3,"xFraction":0.5,"font":"Playfair Display","sizeFraction":0.1,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0}],"removeIds":["3","9"],"fonts":["Playfair Display","Lato"]}`,
      });

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
      // The pass deletes elements (the outlined text it replaced); their layer rows have
      // to go with them, or the panel lists layers that no longer draw anything.
      const kept = pruneMissingLayers(doc, activeSvg.layers);
      setActiveSvg((prev) => {
        if (!prev) return null;
        return { ...prev, content, layers: [...kept, ...newTextLayers] };
      });
      dropSelectionOutside(kept, newTextLayers);
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
      const { x: vbX, y: vbY, w: vw, h: vh } = parseViewBox(svgRoot);
      const defsEl = doc.querySelector('defs');
      const defsXml = defsEl ? new XMLSerializer().serializeToString(defsEl) : '';
      const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}">${defsXml}${svgString}</svg>`;
      const scale = Math.min(1, 1024 / Math.max(vw, vh, 1));
      const pngBase64 = await svgToBase64Png(previewSvg, Math.round(vw * scale), Math.round(vh * scale));

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
        for (const sid of removeIds) rstIdMap.get(sid)?.parentNode?.removeChild(rstIdMap.get(sid)!);
        for (const [, el] of rstIdMap) el.removeAttribute('data-ai-idx');
        const contentRST = new XMLSerializer().serializeToString(doc.documentElement);
        const keptRST = pruneMissingLayers(doc, activeSvg.layers);
        setActiveSvg((prev) => prev ? { ...prev, content: contentRST, layers: keptRST } : null);
        dropSelectionOutside(keptRST, []);
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
        setAiStatusMsg('Reviewing vector…');
        const rawText = await callLlmVision({
          model: TEXT_PARSE_MODEL, maxTokens: 8192, pngBase64, tag: 'strip-text',
          prompt: `Analyze this SVG layer image and its source code.

${TEXT_PARSING_PROMPT}

SVG source:
${markedSvgString}

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"hasText":true,"rows":[{"yFraction":0.5,"xFraction":0.5,"font":"Impact","sizeFraction":0.08,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0.05}],"removeIds":["3","9"]}`,
        });

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
      // Same as the customise pass: stripped elements take their layer rows with them.
      const kept = pruneMissingLayers(doc, activeSvg.layers);
      setActiveSvg((prev) => {
        if (!prev) return null;
        return { ...prev, content, layers: [...kept, ...newTextLayers] };
      });
      dropSelectionOutside(kept, newTextLayers);
      if (newTextLayers.length > 0) { setSelectedLayer(newTextLayers[0].id); setSelectedSubElId(null); }

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
    setSelectedLayer(null); setSelectedLayers(new Set()); setSelectedSubElId(null);
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
    setSelectedSubElId(null);
  }, [activeSvg, snapshotForUndo]);

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
    setSelectedSubElId(null);
  }, [activeSvg, snapshotForUndo]);

  // Ctrl/Cmd+C copies the selected layer; Ctrl/Cmd+V pastes it as a duplicate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        if (selectedLayer) layerClipboardRef.current = selectedLayer;
      } else if (key === 'v') {
        if (layerClipboardRef.current) { e.preventDefault(); duplicateLayer(layerClipboardRef.current); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLayer, duplicateLayer]);

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
            subOverlayRef={subOverlayRef}
            sizeBadgeRef={sizeBadgeRef}
            onCanvasClick={handleCanvasClick}
            aiLoading={aiLoading}
            aiStatusMsg={aiStatusMsg}
            isLoading={isLoading}
            activeSvg={activeSvg}
            hiddenLayers={hiddenLayers}
            backgroundLayerId={backgroundLayerId}
            showSelectionOverlay={showSelectionOverlay}
            selectionIsEmptyText={selectionIsEmptyText}
            selectionIsTextLayer={selectionIsTextLayer}
            selectedLayersSize={selectedLayers.size}
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
            exportLabel={activeSvg && hiddenLayers.size > 0
              ? `Export (${activeSvg.layers.length - hiddenLayers.size}/${activeSvg.layers.length})`
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
                extraFonts={extraFonts}
                layerColors={layerColors}
                onUpdateTextLayer={updateTextLayer}
                onCurvePointerDown={onCurvePointerDown}
                onCurvePointerUp={onCurvePointerUp}
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
                subLayerMap={subLayerMap}
                selectedSubElId={selectedSubElId}
                onAddTextLayer={addTextLayer}
                onReorderLayers={reorderLayers}
                onSetSelectedLayers={setSelectedLayers}
                onSetSelectedLayer={setSelectedLayer}
                onSelectOne={selectOne}
                onToggleLayer={toggleLayer}
                onDuplicateLayer={duplicateLayer}
                onDeleteLayer={deleteLayer}
                onSetSelectedSubElId={setSelectedSubElId}
              />

              {/* AI pill + panel (§1.8) */}
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
              <AiPill
                onCustomise={runCustomise}
                onOpenTools={onAiToolsClick}
                loading={customiseLoading}
                done={customiseDone}
                toolsOpen={aiPanelOpen}
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
      <DevRail
        samples={SAMPLES}
        activeSample={activeSample}
        isLoading={isLoading}
        onOpenSample={openSample}
        onOpenFetched={openSample}
      />
    </div>
  );
}

