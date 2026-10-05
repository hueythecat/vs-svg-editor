import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type ActiveSvg,
  type SvgLayer,
  type TaxonomyGroup,
  type TextRow,
  appendTextRowLayers,
  applyTranslateDelta,
  unionBoxInRootSpace,
  computeArcPath,
  measureTextAdvance,
  detectBackgroundLayerId,
  filterOutBackgroundIds,
  hashString,
  isFullCanvasLayer,
  isPlainWhiteLayer,
  measureRemovedTextBoxes,
  sampleRemovedLettering,
  parseSvg,
  parseViewBox,
  extractDesign,
  pruneMissingLayers,
  stripScripts,
  svgToBase64Png,
  backgroundFillColor,
  canExpandLayer,
  expansionTarget,
  collapsibleParent,
  setTextLines,
} from '@/lib/svg-utils';
import { C, EDITOR_CSS, FONT_STACK, SHADOW } from '@/lib/design-tokens';
import { FONT_SUGGESTION_LIMIT, SHOW_DEV_UI } from '@/lib/env';
import { readAiCache, writeAiCache } from '@/lib/ai-cache';
// Two entry points into the same catalogue: `t` for the imperative side — status text,
// error messages, generated layer names, all written into state from callbacks — and
// `useT` for the JSX, so a language change actually repaints it. The provider sets the
// shared instance's locale during render, so the two never disagree.
import { t } from '@/i18n';
import { useT } from '@/i18n/provider';
import {
  isHideNonTextRegions, isIgnoreCooldownPrompt, setHideNonTextRegions,
} from '@/lib/dev-flags';
import type {
  AiActionType, CustomiseBundle, DocBundle, LlmProvider, RegionBox, RemovedRecord, TextDetectMethod,
  TextLayerAttrs,
} from './editor-types';
import { LLM_OPTIONS, OPUS_MODEL, TEXT_DETECT_OPTIONS } from './editor-types';
import { detectSvgText, type DetectedTextRegion } from '@/lib/svg-text-detect';
import { EditorControlPanel, type ControlTab } from './editor-control-panel';
import { AiPanel } from './editor-ai-panel';
import { ExportPill } from './editor-export-pill';
import { DevRail, SAMPLE_DRAG_MIME } from './dev-rail';
import { DevRemovedPanel } from './dev-removed-panel';
import { UpsellModal, CooldownModal, RatingModal, AbortReasonModal, ConfirmModal } from './editor-modals';
import { CanvasStage } from './editor-canvas';
import { useArrangeActions } from '@/hooks/use-arrange-actions';
import { useColorReplace } from '@/hooks/use-color-replace';
import { useGoogleFonts } from '@/hooks/use-google-fonts';
import { groupLabelFor } from '@/lib/layer-dom';
import { useLayerReorder } from '@/hooks/use-layer-reorder';
import { useLayerStructure } from '@/hooks/use-layer-structure';
import { useInlineTextEdit } from '@/hooks/use-inline-text-edit';
import { useReviewAsset } from '@/hooks/use-review-asset';
import { layerLabel, useTextLayer } from '@/hooks/use-text-layer';
import {
  TEXT_PARSE_MODEL, TEXT_DETECT_MODEL, TEXT_DETECT_EFFORT, TEXT_PARSING_PROMPT, extractJson,
  ensureRowFontsReady, normaliseRowRemoveIds, logUnreadable, allRemoveIds, svgWithoutHidden,
  hideRemovedElements, removedSubtree, annotateRenderedPaint, countTaggedRows,
} from '@/lib/ai-text-pass';

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

// Text fields the user manages — added via the text tool (data-text-layer="1")
// or re-added by an AI pass (id starting "_text_"). These are already real,
// editable SVG text, so the AI strip/customise passes must leave them alone:
// they are not artwork text to detect or remove.
const isEditableTextField = (el: Element) =>
  el.getAttribute('data-text-layer') === '1' || el.id.startsWith('_text_');

// The panel tab a layer picked ON THE CANVAS brings up: the type form for text, the
// Layers list (with its row highlighted) for anything else. Same test selectedTextProps
// uses to decide the Text tab has something to edit, so the two can't disagree.
const canvasTabFor = (el: Element): ControlTab =>
  el.getAttribute('data-text-layer') === '1' || el.tagName.toLowerCase() === 'text' ? 'text' : 'layers';

// Reasons offered when a one-star rating leads the user to abandon the export
// (handoff §4). Multi-select — any number can apply.
//
// Stable keys, not sentences: the selection is what gets reported back, and it has to
// mean the same thing whichever language the editor was opened in. The modal translates
// them for display — see abort.reasons.* in the locale files.
const ABORT_REASONS = [
  'colours',
  'different',
  'fileType',
  'textMoved',
  'tooSlow',
  'mistake',
];

// How a row relates to the group the list is drilled into: part of it, or part of the
// level above it. Rows that are neither — the parts of some OTHER group opened at the
// same level — carry no mark; see the drillContext memo.
type DrillMark = 'inside' | 'outer';

// Stable empty map for "nothing is drilled into", so the memoised panel isn't re-rendered
// by a fresh identity on every render of this component.
const NO_MARKS: ReadonlyMap<string, DrillMark> = new Map<string, DrillMark>();

// How far the pointer may travel between press and release and still count as a click
// rather than a drag. This is the line between "type into this text" and "move it", so
// it is deliberately looser than a pixel or two: at 2px an ordinary slightly-shaky click
// on a text layer nudged it a fraction instead of opening the editor, which reads as the
// click having done nothing except damage the artwork.
const CLICK_SLOP_PX = 4;

// Stable identity, so passing "no preview" to the memoised canvas isn't a new object
// on every render.
const EMPTY_PREVIEW: Set<string> = new Set();
const NO_REGION_BOXES: RegionBox[] = [];

// ─── Component ───────────────────────────────────────────────────────────────

export function SvgDropZone({ reviewUuid }: { reviewUuid?: string } = {}) {
  // Named `tr` rather than `t` so it doesn't shadow the module-level translate this file
  // also uses — the callbacks below want the unbound one, which needs no dependency.
  const tr = useT();
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
  // True for a design made with New Design. Its layers are whatever was selected, so
  // none of them is the canvas — even a panel that happens to fill the crop — and the
  // board shows the transparency pattern rather than locking that panel as a background.
  const [noCanvasLayer, setNoCanvasLayer] = useState(false);
  const [removedRecords, setRemovedRecords] = useState<RemovedRecord[]>([]);
  // Same ids as `removedRecords`, readable synchronously — see dropSelectionOutside.
  const removedIdsRef = useRef<Set<string>>(new Set());
  // The record the dev panel is hovering. Excluded from the canvas hide rule so the
  // element reappears where it always was, without committing anything.
  const [previewRemovedId, setPreviewRemovedId] = useState<string | null>(null);
  // The switched-off row the pointer is resting on in the layers list, shown on the canvas
  // for as long as it stays there. Separate from previewRemovedId — that one belongs to
  // the dev removed-panel and its entries are not layer rows — but both feed the same
  // canvas mechanism, which is what already knows how to un-hide something temporarily.
  const [peekedLayerId, setPeekedLayerId] = useState<string | null>(null);
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
  // The layer under the pointer — drives the hover readout, nothing else.
  const [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null);
  const [ratingOpen, setRatingOpen]   = useState(false);   // export satisfaction prompt
  const [rating, setRating]           = useState(0);        // chosen star count (1–5)
  const [ratingHover, setRatingHover] = useState(0);        // hovered star for preview
  const [abortReasonOpen, setAbortReasonOpen] = useState(false); // secondary abandon-reason overlay
  const [abortReasons, setAbortReasons] = useState<string[]>([]); // multi-select (§4)
  const [abortNote, setAbortNote]       = useState('');           // optional free-text note
  const [textForm, setTextForm] = useState({ content: t('text.defaultContent'), font: 'Arial', size: 48, weight: 400, color: '#000000', curve: 0, letterSpacing: 0 });
  const [aiLoading, setAiLoading]         = useState(false);
  const [aiError, setAiError]             = useState<string | null>(null);
  const [aiStatusMsg, setAiStatusMsg]     = useState<string>(t('status.thinking'));
  const [fontSuggestion, setFontSuggestion]   = useState<string | null>(null);
  const [suggestedFontName, setSuggestedFontName] = useState<string | null>(null);
  // The Font dropdown's lists and the stylesheet loader (use-google-fonts.ts).
  const { usedFonts, extraFonts, loadGoogleFontLink, addGoogleFont, addUsedFont, resetFonts } = useGoogleFonts();
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
  // Which tab of the one control panel is showing. Panel state, deliberately separate
  // from document state — the tab choice never enters the undo stack.
  const [controlTab, setControlTab]           = useState<ControlTab>('tools');
  // The text layer being typed into directly on the canvas, if any. Only ever the
  // selected layer — inline editing is a mode the selection is in, not a second
  // selection of its own.
  const [editingTextId, setEditingTextId]     = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false); // "Revert changes?" overlay
  const [devRailOpen, setDevRailOpen]           = useState(false); // dev rail expanded
  const [removedPanelOpen, setRemovedPanelOpen] = useState(false); // dev hidden-by-AI ledger
  // Which LLM every AI action calls. Picking 'kimi' diverts each request to
  // /api/kimi, which re-shapes the same Anthropic-style body for Moonshot. Mirrored
  // into a ref so the AI callbacks below read the live choice, never a stale closure.
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('claude-opus');
  const llmProviderRef = useRef<LlmProvider>('claude-opus');
  const selectLlmProvider = (p: LlmProvider) => { llmProviderRef.current = p; setLlmProvider(p); };
  // Which text-detection call Customise makes. Ref-mirrored like the provider, so
  // runCustomise reads the live choice without taking it as a dependency.
  const [textDetectMethod, setTextDetectMethod] = useState<TextDetectMethod>('dom-regions');
  const textDetectMethodRef = useRef<TextDetectMethod>('dom-regions');
  const selectTextDetectMethod = (m: TextDetectMethod) => { textDetectMethodRef.current = m; setTextDetectMethod(m); };
  // The regions the last DOM-regions run returned, boxed and numbered on the canvas like
  // the annotated render the model saw. Debug only: cleared on the next run or a new file.
  const [textDetectBoxes, setTextDetectBoxes] = useState<RegionBox[]>(NO_REGION_BOXES);
  // The last detection run's regions, for the canvas dots that replace one with text.
  const detectedRegionsRef = useRef<{ regions: DetectedTextRegion[]; hidden: Set<string> } | null>(null);
  // Dev rail flag: box only the regions the model read as text. Persisted in dev-flags;
  // mirrored here because it changes what the canvas draws.
  const [hideNonTextRegions, setHideNonTextRegionsState] = useState(() => isHideNonTextRegions());
  const onSetHideNonTextRegions = useCallback((on: boolean) => {
    setHideNonTextRegions(on);
    setHideNonTextRegionsState(on);
  }, []);
  const visibleRegionBoxes = useMemo(
    () => (hideNonTextRegions ? textDetectBoxes.filter((b) => b.replaceable) : textDetectBoxes),
    [textDetectBoxes, hideNonTextRegions],
  );
  const llmEndpoint = () => (llmProviderRef.current === 'kimi' ? '/api/kimi' : '/api/claude');
  // Log label. /api/kimi discards the model id we send and pins its own, so naming a
  // Claude model while Kimi is running would be a lie — say who actually answered.
  const llmLabel = (claudeModel: string) =>
    llmProviderRef.current === 'kimi' ? 'kimi (model pinned in /api/kimi)' : `claude ${llmModel(claudeModel)}`;
  // The model id actually sent. Call sites name the Sonnet they were tuned on; picking
  // Opus overrides all of them. Also part of the AI cache keys, so switching model
  // doesn't just replay the other model's cached answer.
  const llmModel = (model: string) => (llmProviderRef.current === 'claude-opus' ? OPUS_MODEL : model);

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
        model: llmModel(opts.model),
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
      throw new Error(e.error?.message ?? t('errors.api', { status: res.status }));
    }
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return extractJson(data.content?.[0]?.text ?? '');
  };
  const dragMovedRef            = useRef(false);
  // An open colour-picker session: the colour being replaced and the document as it
  // was when the picker opened. Live dragging replays from that baseline, so the whole
  // pick is one undo entry rather than one per intermediate colour.
  // Visibility is part of a history entry, not just the document. An AI pass now takes
  // artwork out by hiding it, so a snapshot of content and layers alone would record a
  // run as having changed nothing and undo would have nothing to give back.
  type HistoryEntry = {
    content: string;
    layers: SvgLayer[];
    hidden: Set<string>;
    removed: RemovedRecord[];
    depth: number;
    noCanvas: boolean;
  };
  // The name each row had when it was opened into its parts, keyed by the id of every
  // element that opening it could later fold back into — the row's own element and any
  // wrapper between it and the children. Expanding drops the row from the list, so
  // without this the name is simply gone: collapsing re-derives one from the element,
  // which for an unnamed group means "Layer 5" where "old effect" used to be.
  const expandedLabelsRef        = useRef<Map<string, string>>(new Map());
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
  // The contentEditable that sits over the artwork during inline editing. Deliberately
  // uncontrolled: the document round-trips through a string on every keystroke, and
  // rewriting the node's text from that would fight the caret.
  const textEditorRef   = useRef<HTMLDivElement>(null);
  const sizeBadgeRef    = useRef<HTMLSpanElement>(null);
  const hoverBadgeRef   = useRef<HTMLSpanElement>(null);
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
  const noCanvasLayerRef  = useRef(noCanvasLayer);
  useEffect(() => {
    hiddenLayersRef.current = hiddenLayers;
    removedRecordsRef.current = removedRecords;
    expandDepthRef.current = expandDepth;
    noCanvasLayerRef.current = noCanvasLayer;
  });

  const restoreHistory = useCallback((entry: HistoryEntry) => {
    setActiveSvg((p) => p ? { ...p, content: entry.content, layers: entry.layers } : null);
    setHiddenLayers(new Set(entry.hidden));
    setRemovedRecords(entry.removed);
    removedIdsRef.current = new Set(entry.removed.map((r) => r.id));
    // Undoing an expand puts the rows back; the depth has to come back with them or
    // back-out stays offered at a level that no longer exists.
    setExpandDepth(entry.depth);
    setNoCanvasLayer(entry.noCanvas);
    setPreviewRemovedId(null);
  }, []);

  // Any committing action pushes the current document and clears the redo stack.
  const snapshotForUndo = useCallback((content: string, layers: SvgLayer[]) => {
    const entry: HistoryEntry = {
      content, layers,
      hidden: new Set(hiddenLayersRef.current),
      removed: removedRecordsRef.current,
      depth: expandDepthRef.current,
      noCanvas: noCanvasLayerRef.current,
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
    noCanvas: noCanvasLayerRef.current,
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
      setTextDetectBoxes(NO_REGION_BOXES);
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
      setNoCanvasLayer(false);
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

  // Which review asset is on the canvas, if any. Not derivable from `reviewUuid`, which
  // only knows about the /<uuid> path — an asset opened from the dev rail's dropdown
  // has no uuid in the URL at all.
  const openReviewUuidRef = useRef<string | null>(null);

  // Review assets: the uuid deep link, the dev rail's dropdown, cooldown and AI gate.
  const { openReviewUuid, onReviewListLoaded, notifyCustomised } = useReviewAsset({
    reviewUuid, openReviewUuidRef, openSample, setIsLoading, setCooldownActive, setCooldownUntil,
  });

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
    setTextDetectBoxes(NO_REGION_BOXES);
    setHiddenLayers(new Set());
    setDefaultHiddenLayers(new Set());
    setSelectedLayer(null);
    setSelectedLayers(new Set());
    setRemovedRecords([]);
    removedIdsRef.current = new Set();
    expandedLabelsRef.current = new Map();
    setExpandDepth(0);
    setNoCanvasLayer(false);
    setPreviewRemovedId(null);
  }, [revokePrev]);

  // ── Layer toggle ───────────────────────────────────────────────────────────

  // The eye acts on the whole selection when the row it was clicked on belongs to one —
  // the same rule a canvas drag follows, so a shift-built selection behaves as one thing
  // wherever it is acted on. Clicking the eye of a row OUTSIDE the selection still acts
  // on that row alone, and leaves the selection as it was.
  //
  // Every affected row is driven to the SAME state, the opposite of the clicked row's,
  // rather than each flipping its own: flipping individually turns a part-hidden
  // selection inside out and leaves it just as mixed, which is never what the click
  // meant. The clicked row is the one that decides the direction because it is the one
  // whose icon the eye was showing.
  const toggleLayer = useCallback((id: string) => {
    const ids = selectedLayers.size > 1 && selectedLayers.has(id) ? [...selectedLayers] : [id];
    const hide = !hiddenLayers.has(id);
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      for (const layerId of ids) {
        if (hide) { next.add(layerId); continue; }
        next.delete(layerId);
        // Switching a row the AI hid back on has to take its whole hidden subtree with
        // it. A group's ink lives in children that carry their own hide rules, so
        // clearing only the group would leave the row reading "visible" while still
        // drawing nothing — the same trap the dev panel's preview hit.
        for (const sub of removedSubtree(removedRecordsRef.current, layerId)) next.delete(sub);
      }
      return next;
    });
    // Shown again, it is ordinary artwork with an ordinary row — no longer something a
    // pass is holding, so it stops being listed as removed. Only on the way back on: a
    // row being hidden here is not one of those to begin with.
    if (hide) return;
    setRemovedRecords((prev) => {
      if (!prev.some((r) => ids.includes(r.id))) return prev;
      const gone = new Set(ids.flatMap((layerId) => [...removedSubtree(prev, layerId)]));
      removedIdsRef.current = new Set([...removedIdsRef.current].filter((x) => !gone.has(x)));
      return prev.filter((r) => !gone.has(r.id));
    });
  }, [selectedLayers, hiddenLayers]);

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
  //
  // A peeked ROW carries its own id as well as that subtree: a row switched off by the eye
  // has no removed-record behind it, so its subtree is empty and the id itself is the only
  // thing holding it off the canvas. A row an AI pass hid into needs both — the id to put
  // the group back, the subtree so it does not come back empty.
  const previewIds = useMemo(() => {
    if (!previewRemovedId && !peekedLayerId) return EMPTY_PREVIEW;
    const ids = new Set<string>();
    if (previewRemovedId) {
      for (const id of removedSubtree(removedRecords, previewRemovedId)) ids.add(id);
    }
    if (peekedLayerId) {
      ids.add(peekedLayerId);
      for (const id of removedSubtree(removedRecords, peekedLayerId)) ids.add(id);
    }
    return ids;
  }, [previewRemovedId, peekedLayerId, removedRecords]);

  // Nothing to peek at once the row is showing again — the eye can be clicked without
  // moving the pointer, and the outline would otherwise sit on it until the pointer left.
  useEffect(() => {
    if (peekedLayerId && !hiddenLayers.has(peekedLayerId)) setPeekedLayerId(null);
  }, [peekedLayerId, hiddenLayers]);

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

  // What the list is currently drilled into, or null at the top level: the group itself,
  // the rows that came out of it, and the row to back out from.
  //
  // One context for the whole panel rather than a marker per row, because the list is
  // only ever inside one group at a time — being inside is a property of the view. It
  // takes the DEEPEST group any row sits in, the level most recently opened, so backing
  // out repeatedly walks back up the way you came.
  const drillContext = useMemo(() => {
    // Nothing has been opened, so there is nowhere to go back to — whatever the document
    // happens to be wrapped in.
    if (!activeSvg || expandDepth === 0) return null;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    // Resolved once per row and reused below — collapsibleParent walks the tree, and the
    // marking pass needs the same answer the deepest-group search does.
    const rows = activeSvg.layers.map((l) => {
      const el = doc.getElementById(l.id);
      return { id: l.id, el, parent: collapsibleParent(el, layerIds) };
    });

    let deepestGroup: Element | null = null;
    let backOutId: string | null = null;
    let deepest = -1;
    for (const row of rows) {
      if (!row.parent) continue;
      let depth = 0;
      for (let n: Element | null = row.parent; n; n = n.parentElement) depth++;
      if (depth > deepest) { deepest = depth; deepestGroup = row.parent; backOutId = row.id; }
    }
    const group = deepestGroup;
    if (!group || !backOutId) return null;

    // Which rows came out of that group, and which are the level above it. The panel sets
    // the two apart rather than showing one flat list in which the pieces of the opened
    // group are indistinguishable from the layers that were always there.
    //
    // A row that is inside SOME OTHER group opened at the same level is left unmarked:
    // this breadcrumb is not about it, but receding it as the level above would be a
    // plain lie about where it sits.
    const marks = new Map<string, DrillMark>();
    for (const { id, el, parent } of rows) {
      if (el && group.contains(el)) marks.set(id, 'inside');
      else if (!parent) marks.set(id, 'outer');
    }
    const firstIdx = activeSvg.layers.findIndex((l) => marks.get(l.id) === 'inside');
    return {
      backOutId,
      marks,
      label: groupLabelFor(group, firstIdx < 0 ? activeSvg.layers.length : firstIdx, expandedLabelsRef.current),
    };
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
        // A canvas click always shows the tab for what was clicked, even from Layers —
        // the same click must not do different things depending on a tab you can't see
        // from the artwork. Re-clicking the current selection counts too.
        setControlTab(canvasTabFor(el));
        // Clicking a text layer used to pull focus into the panel's Words field, so that
        // typing went somewhere. Inline editing is that, done properly — and the focus
        // grab actively broke it, landing on the rAF after this click and blurring the
        // editable node the second click had just opened. Selecting is all a single
        // click does now.
        //
        // A plain click on text starts editing it. This handler only ever sees clicks
        // that did NOT move — a gesture that travelled set dragMovedRef and returned at
        // the top — so press-and-hold-drag still moves the layer and never drops a caret
        // into it. That is the whole split: click to type, hold to move.
        const isText =
          el.getAttribute('data-text-layer') === '1' ||
          el.tagName.toLowerCase() === 'text' ||
          !!el.querySelector('text');
        // Curved layers have no flat box to type in — the editable node is a rectangle
        // and the glyphs run along an arc, so what you typed would sit visibly off the
        // artwork it replaces. The Text tab still edits those.
        const curved = Number(el.getAttribute('data-curve') ?? '0') !== 0;
        if (isText && !curved) setEditingTextId(id);
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
      if (Math.abs(e.clientX - canvasDrag.startClientX) > CLICK_SLOP_PX ||
          Math.abs(e.clientY - canvasDrag.startClientY) > CLICK_SLOP_PX) {
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
      if (Math.abs(e.clientX - canvasRotate.startClientX) > CLICK_SLOP_PX ||
          Math.abs(e.clientY - canvasRotate.startClientY) > CLICK_SLOP_PX) {
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
      if (Math.abs(e.clientX - canvasScale.startClientX) > CLICK_SLOP_PX ||
          Math.abs(e.clientY - canvasScale.startClientY) > CLICK_SLOP_PX) {
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
    () => (activeSvg && !noCanvasLayer ? detectBackgroundLayerId(activeSvg.content, activeSvg.layers) : null),
    // Per document, not per edit — the background layer doesn't change as you edit.
    // New Design swaps the document without changing src, so it keys this too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSvg?.src, noCanvasLayer],
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
  // The x/y + w/h badge is a readout for a gesture in progress, not a property of the
  // selection: it is on while a mouse button is held on the artwork or on one of the
  // overlay's handles, and gone the moment it is released. Standing numbers over a
  // merely-selected layer are noise — they only tell you something while they change.
  const gestureActive = !!(canvasDrag || canvasRotate || canvasScale);

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
    // Two lines — position above size — rendered from one string, which is why the span
    // is styled `white-space: pre`.
    //
    // Dimensions arrive as screen pixels and are reported in the SVG's own coordinate
    // space, because those are the numbers that mean something outside this window: they
    // match the file and the export, and they don't change when the browser is resized
    // and the artwork rescaled to fit. Position is in the same space for the same reason —
    // a canvas-pixel origin would sit in the grey around the artwork.
    //
    // The whole badge lives and dies with the selection overlay, so it is on screen
    // exactly when something has been clicked or is being dragged, and nowhere else.
    // Position reads the min corner of the WHOLE selection's box, so a multi-layer move
    // reports the corner of the group rather than of whichever layer happens to be primary.
    const writeBadge = (widthPx: number, heightPx: number) => {
      const badge = sizeBadgeRef.current;
      if (!badge) return;
      const scale = Math.hypot(rootCtm.a, rootCtm.b) || 1;
      const size = `w ${Math.round(widthPx / scale)}  h ${Math.round(heightPx / scale)}`;
      // Null only when nothing in the selection can be measured — the size line still
      // says something, so it is shown on its own rather than blanking the badge.
      const box = unionBoxInRootSpace(svgEl, selectionIds);
      badge.textContent = box
        ? `x ${Math.round(box.x)}  y ${Math.round(box.y)}\n${size}`
        : size;
    };

    const layerEl = svgEl.querySelector(`#${CSS.escape(selectionLayerId)}`) as SVGGraphicsElement | null;
    if (!layerEl) return;

    // Inline editor: match the artwork's type size, converted to screen pixels, so the
    // words being typed are the size of the words they replace. Written here rather than
    // in JSX because the scale only exists once the layer is measured — and it changes
    // whenever the board is resized, which this function already tracks.
    const editor = textEditorRef.current;
    if (editor) {
      const tEl = (layerEl.tagName.toLowerCase() === 'text'
        ? layerEl
        : layerEl.querySelector('text')) as SVGTextElement | null;
      const tCtm = tEl?.getScreenCTM();
      if (tEl && tCtm) {
        const fs = parseFloat(tEl.getAttribute('font-size') ?? '16');
        editor.style.fontSize = `${fs * (Math.hypot(tCtm.a, tCtm.b) || 1)}px`;
      }
    }

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

  // The hover readout. Deliberately not part of the selection overlay's pass: that one
  // is a rotated frame with padding and handles, this is two lines of text under an
  // untransformed screen rect, and it tracks a different layer.
  //
  // x/y/w/h come straight out of root space rather than being converted back from screen
  // pixels — the same numbers the selection badge reports, by the shorter route, and the
  // ones that mean something outside this window: they match the file and the export.
  useLayoutEffect(() => {
    const badge = hoverBadgeRef.current;
    if (!badge) return;

    const hide = () => { badge.style.display = 'none'; };
    const canvasEl = svgCanvasRef.current;
    const svgEl = canvasEl?.querySelector('svg') as SVGSVGElement | null;
    // A gesture in progress owns the readout — see handleCanvasMouseMove.
    if (!hoveredLayerId || gestureActive || !canvasEl || !svgEl) { hide(); return; }

    const layerEl = svgEl.querySelector(`#${CSS.escape(hoveredLayerId)}`) as SVGGraphicsElement | null;
    const box = layerEl ? unionBoxInRootSpace(svgEl, [hoveredLayerId]) : null;
    if (!layerEl || !box) { hide(); return; }

    // Screen rect for placement only: the badge sits under the layer's ink wherever it
    // lands on screen, whatever transform put it there.
    const rect = layerEl.getBoundingClientRect();
    const canvasRect = canvasEl.getBoundingClientRect();
    badge.textContent =
      `x ${Math.round(box.x)}  y ${Math.round(box.y)}\n`
      + `w ${Math.round(box.width)}  h ${Math.round(box.height)}`;
    badge.style.left = `${rect.left - canvasRect.left + canvasEl.scrollLeft}px`;
    badge.style.top = `${rect.bottom - canvasRect.top + canvasEl.scrollTop + 8}px`;
    badge.style.display = 'block';
  }, [hoveredLayerId, gestureActive, activeSvg?.content, hiddenLayers]);

  // Keep a live ref so the drag/rotate window listeners can reposition without
  // being torn down and recreated on every render.
  const positionOverlayRef = useRef(positionSelectionOverlay);
  useEffect(() => { positionOverlayRef.current = positionSelectionOverlay; });

  useLayoutEffect(() => {
    positionSelectionOverlay();
    // editingTextId is in here so the editor gets sized the moment it mounts, not on
    // whatever unrelated change happens to reposition the overlay next.
  }, [positionSelectionOverlay, activeSvg?.content, canvasDrag, canvasRotate, canvasScale, editingTextId]);

  // ── Layer reorder (use-layer-reorder.ts) ───────────────────────────────────

  const reorderLayers = useLayerReorder({ activeSvg, setActiveSvg, snapshotForUndo });

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
  const closeAiPanel = useCallback(() => setAiPanelOpen(false), []);
  // The pill's caret opens the AI tools. Gated assets (edit === 0) get the upsell
  // instead — the tools are AI features too, and runCustomise gates itself the same way.
  const onAiToolsClick = useCallback(() => {
    if (activeSvg?.edit === 0) { setShowUpsell(true); return; }
    setAiPanelOpen((o) => !o);
  }, [activeSvg?.edit]);
  // An empty text layer draws no glyphs, so there is nothing on the canvas to
  // double-click. Its placeholder box is the target instead: one click on it opens the
  // same inline editor, which is the only way to type the first word into a layer that
  // has none.
  const editEmptyText = useCallback(() => {
    if (selectedLayer) setEditingTextId(selectedLayer);
  }, [selectedLayer]);

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
    let hitEl: Element | null = null;
    for (let el = e.target as Element | null; el && el !== (svgEl as Element); el = el.parentElement) {
      if (layerIds.has(el.id)) { hitId = el.id; hitEl = el; break; }
    }
    if (!hitId || hitId === backgroundLayerId) return;

    if (selectedLayers.has(hitId)) {
      beginLayerDrag(e, selectionIds);
    } else {
      selectOne(hitId);
      setControlTab(canvasTabFor(hitEl!));
      beginLayerDrag(e, [hitId]);
    }
  }, [activeSvg, backgroundLayerId, selectedLayers, selectionIds, selectOne, beginLayerDrag]);

  // Hover: the layer under the pointer, or null off the artwork. The same upward walk
  // handleCanvasMouseDown uses to decide what a press grabbed — one readout and one
  // gesture should never disagree about which layer the pointer is on.
  //
  // Set through a comparison so a mousemove that stays inside the same layer is not a
  // re-render: this fires continuously while the pointer crosses the canvas.
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // A gesture owns the readout while it runs — the selection badge is showing the
    // numbers that are actually changing, and they are the ones that matter.
    if (canvasDrag || canvasRotate || canvasScale) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl || !activeSvg?.layers.length) return;

    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let hitId: string | null = null;
    for (let el = e.target as Element | null; el && el !== (svgEl as Element); el = el.parentElement) {
      if (layerIds.has(el.id)) { hitId = el.id; break; }
    }
    // The background is the whole board and is locked — reporting its box on every pass
    // over empty space would mean the badge is essentially always up.
    if (hitId === backgroundLayerId) hitId = null;
    setHoveredLayerId((prev) => (prev === hitId ? prev : hitId));
  }, [activeSvg, backgroundLayerId, canvasDrag, canvasRotate, canvasScale]);

  const handleCanvasMouseLeave = useCallback(() => setHoveredLayerId(null), []);

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

  // ── Selected text layer (use-text-layer.ts) ────────────────────────────────

  const { selectedTextProps, selectionIsText, selectionIsEmptyText, updateTextLayer } = useTextLayer({
    activeSvg, setActiveSvg, selectedLayer, selectedLayers, textLayerIds, snapshotForUndo, textEditSnappedRef,
  });

  // Selections made anywhere but the canvas — a row in the Layers list, a duplicate, an
  // AI pass handing back new text — follow the selection too, except that Layers stays
  // put: it is a list you work down, and having it flip away under you on every row you
  // select would make it unusable. Canvas clicks set the tab themselves (canvasTabFor) and
  // always win, which is why this rule can't trap a canvas click on Layers.
  // Read as a functional update so the current tab is not itself a dependency; otherwise
  // the effect would re-fire (and fight the user) on every manual tab change.
  useEffect(() => {
    if (!selectedLayer) return;
    setControlTab((cur) => (cur === 'layers' ? cur : selectionIsText ? 'text' : 'layers'));
  }, [selectedLayer, selectionIsText]);

  // ── Inline text editing (use-inline-text-edit.ts) ──────────────────────────

  const { endInlineEdit, inlineEditStyle, onInlineTextInput } = useInlineTextEdit({
    editingTextId, setEditingTextId, textEditorRef, selectedLayer, selectedTextProps, showSelectionOverlay,
    updateTextLayer,
  });

  // The Text tab is always live — it has no empty state, so the controls need something
  // to read and write whether or not a text layer is selected. Selected: the layer's own
  // attributes, edited in place. Nothing selected: `textForm`, the draft Add text layer
  // already builds from, so the fields set up the next layer instead of going blank.
  const textProps = selectedTextProps ?? textForm;
  const updateTextLayerOrDraft = useCallback((attrs: Partial<TextLayerAttrs>) => {
    if (selectionIsText) updateTextLayer(attrs);
    else setTextForm((f) => ({ ...f, ...attrs }));
  }, [selectionIsText, updateTextLayer]);

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
      textPathEl.textContent = textContent.replace(/\s*\n\s*/g, ' ');
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
      textEl.setAttribute('y', String(cy));
      textEl.setAttribute('text-anchor', 'middle');
      textEl.setAttribute('dominant-baseline', 'middle');
      textEl.setAttribute('font-family', textForm.font);
      textEl.setAttribute('font-size', String(textForm.size));
      textEl.setAttribute('font-weight', String(textForm.weight));
      textEl.setAttribute('fill', textForm.color);
      if (textForm.letterSpacing) textEl.setAttribute('letter-spacing', `${textForm.letterSpacing}em`);
      setTextLines(textEl, textContent, cx);
      g.appendChild(textEl);
      svg.appendChild(g);
    }

    const content = new XMLSerializer().serializeToString(svg);
    const newLayer = { id, label: layerLabel(textContent) };
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: [...prev.layers, newLayer] } : null));
    // Select it outright, and show the type form for it. The tab is set here rather
    // than left to the follow-the-selection effect because Add can be pressed from the
    // Layers tab, which that effect deliberately never moves off.
    setSelectedLayer(id); setSelectedLayers(new Set([id]));
    setControlTab('text');
  }, [activeSvg, textForm, snapshotForUndo]);

  // ── Arrange: centre, tidy, match rotation, rotate 90° (use-arrange-actions.ts) ──

  const {
    centerLayersToCanvas, tidySelection, tidySelectionHorizontal, matchRotationToSelected, rotateSelected90,
  } = useArrangeActions({
    activeSvg, setActiveSvg, svgCanvasRef, selectionIds, selectedLayers, backgroundLayerId, snapshotForUndo,
  });

  // ── New design: open the selection as a document of its own ───────────────

  // Replaces the open document with just the selected layers, cropped to them and scaled
  // up to the size of the design they came from (see extractDesign). It is one undo step,
  // not a fresh load: undo brings the whole design back with its hidden layers intact.
  // The imported file stays the Revert target, and the open review asset stays attached,
  // so the crop cannot be used to sidestep the customise cooldown.
  const newDesignFromSelection = useCallback(() => {
    if (!activeSvg || selectionIds.length === 0) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const box = unionBoxInRootSpace(svgEl, selectionIds);
    if (!box) return;
    const extracted = extractDesign(activeSvg.content, selectionIds, hiddenLayers, box);
    if (!extracted) return;
    const { content, layers } = parseSvg(extracted);

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    if (__DEV__) console.log(`[new-design] ${selectionIds.length} layer(s) → ${layers.length} layer(s), ${Math.round(box.width)}×${Math.round(box.height)}`);
    setActiveSvg((prev) => (prev ? { ...prev, content, layers } : null));
    // Hidden elements were left out of the new document, so nothing is hidden in it and
    // nothing is on the removed list.
    setHiddenLayers(new Set());
    setRemovedRecords([]);
    removedIdsRef.current = new Set();
    setExpandDepth(0);
    setNoCanvasLayer(true);
    setPreviewRemovedId(null);
    selectOne(null);
  }, [activeSvg, selectionIds, hiddenLayers, snapshotForUndo, selectOne]);

  // ── Customise (strip all text + font suggestions) ─────────────────────────

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
    // The pass works on the whole artwork, not the selection, and rewrites layers under
    // it — so drop the selection (and any inline edit, which follows it) rather than leave
    // handles framing something that may be about to be hidden or replaced.
    selectOne(null);
    // The new detection call (src/lib/svg-text-detect.ts). Debug-only for now: it runs
    // the call and logs the merged result, and applies nothing — so no undo snapshot.
    if (textDetectMethodRef.current === 'dom-regions') {
      setCustomiseLoading(true);
      setAiLoading(true);
      setAiError(null);
      setAiStatusMsg(t('status.analysingImage'));
      setTextDetectBoxes(NO_REGION_BOXES);
      try {
        console.log('[text-detect] invoking /api/svg-text:', TEXT_DETECT_MODEL, `effort ${TEXT_DETECT_EFFORT}`);
        const { regions, fonts } = await detectSvgText(svgWithoutHidden(activeSvg.content, hiddenLayers), {
          model: TEXT_DETECT_MODEL, effort: TEXT_DETECT_EFFORT, layers: activeSvg.layers,
          fontSuggestions: FONT_SUGGESTION_LIMIT,
        });
        console.log('[text-detect] result:\n' + JSON.stringify(regions, null, 2));
        console.log(`[text-detect] ${fonts.length} font suggestion(s): ${fonts.join(', ')}`);
        // Image-level suggestions, handled as the customise pass handles its own: listed
        // in the inspector's Font list and the AI panel, and the first becomes the default
        // for text added afterwards — never written onto fields that already exist.
        fonts.forEach((f) => addGoogleFont(f));
        setCustomiseFonts(fonts);
        if (fonts[0]) setTextForm((f) => ({ ...f, font: fonts[0] }));
        // Kept with the hidden set the detection ran against: region xpaths address the
        // document with those elements removed (svgWithoutHidden above).
        detectedRegionsRef.current = { regions, hidden: new Set(hiddenLayers) };
        // Fetched now so a dot click can measure in the matched face without waiting.
        for (const r of regions) {
          if (r.is_text === true && typeof r.google_font === 'string' && r.google_font) {
            loadGoogleFontLink(r.google_font, Number(r.google_font_weight) || undefined);
          }
        }
        // bbox is in the SVG's user units; the board is the viewBox stretched to fit, so
        // fractions of the viewBox place each box on it at any zoom.
        const vb = parseViewBox(new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml').documentElement);
        setTextDetectBoxes(regions.map((r) => {
          const [x0, y0, x1, y1] = r.bbox;
          return {
            region: r.region,
            left: (x0 - vb.x) / vb.w, top: (y0 - vb.y) / vb.h,
            width: (x1 - x0) / vb.w, height: (y1 - y0) / vb.h,
            replaceable: r.is_text === true && typeof r.text_content === 'string' && r.text_content.trim() !== '',
          };
        }));
      } catch (err) {
        console.error('[text-detect] failed:', err);
        setAiError(err instanceof Error ? err.message : t('errors.customiseFailed'));
      } finally {
        setCustomiseLoading(false);
        setAiLoading(false);
        setAiStatusMsg(t('status.thinking'));
      }
      return;
    }
    setCustomiseLoading(true);
    setAiLoading(true);
    setAiError(null);
    setAiStatusMsg(t('status.analysingImage'));
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
      // Before serialising: the colours have to be on the elements the model is shown.
      await annotateRenderedPaint(doc.documentElement, aiIdMap, { x: vbX, y: vbY, w: vw, h: vh }, 'customise');
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
      const cacheKey = `customise-v14:${llmModel(TEXT_PARSE_MODEL)}:f${FONT_SUGGESTION_LIMIT}:${bgColor ?? 'none'}:${hashString(contentXml)}`;
      let parsed: CustomiseResult;
      const cachedRaw = readAiCache(cacheKey);

      if (cachedRaw) {
        console.log('[customise] cache hit — skipping the model call:', cacheKey);
        parsed = JSON.parse(cachedRaw) as CustomiseResult;
      } else {
        setAiStatusMsg(t('status.reviewingVector'));
        const rawText = await callLlmVision({
          model: TEXT_PARSE_MODEL, maxTokens: 8192, pngBase64, tag: 'customise',
          prompt: `Analyze this SVG image and its source.

${TEXT_PARSING_PROMPT}

TASK 4 — Font suggestions: Suggest ${FONT_SUGGESTION_LIMIT} Google Font names that suit the style, mood, and colour palette of this design. Return names only.

SVG source:
${contentXml}

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation, and no preamble before the object:
{"hasText":true,"rows":[{"yFraction":0.3,"xFraction":0.5,"leftFraction":0.32,"rightFraction":0.68,"font":"Playfair Display","sizeFraction":0.1,"weight":400,"color":"#cccccc","content":"HELLO THERE","spans":[{"text":"HELLO","color":"#cccccc","weight":400},{"text":"THERE","color":"#ffffff","weight":700}],"letterSpacing":0,"removeIds":["3","9"]}],"removeIds":["3","9"],"fonts":["Playfair Display","Lato"]}`,
        });

        try {
          parsed = JSON.parse(rawText) as CustomiseResult;
          if (!Array.isArray(parsed.rows)) parsed.rows = [];
          parsed.removeIds = Array.isArray(parsed.removeIds) ? parsed.removeIds.map(String) : [];
          if (!Array.isArray(parsed.fonts)) parsed.fonts = [];
          parsed.rows.forEach(normaliseRowRemoveIds);
        } catch (err) {
          logUnreadable('customise', rawText, err);
          throw new Error(t('errors.unreadableResponse'));
        }

        // Stored post-normalisation, so a cache hit lands on the same shape the
        // rest of the pass expects without re-running the guards.
        writeAiCache(cacheKey, JSON.stringify(parsed));
      }
      console.log('[customise] LLM returned:', { hasText: parsed.hasText, removeIds: parsed.removeIds, rows: parsed.rows.length });
      // The rows' own numbers, not just how many there were. When placement goes wrong the
      // first question is whether the estimates were bad or the placement was, and without
      // this the answer is not in the log.
      //
      // console.log of one string, not console.table: the dev server mirrors the browser
      // console into the terminal, and only log/warn/error survive that trip — a table
      // renders in devtools and leaves nothing in the log anyone is actually reading.
      if (__DEV__) console.log('[customise] rows returned:\n' + parsed.rows.map((r, i) =>
        `  ${String(i).padStart(2)} y=${Number(r.yFraction).toFixed(3)}` +
        ` x=${Number(r.xFraction).toFixed(3)}` +
        ` l=${r.leftFraction === undefined ? '  -  ' : r.leftFraction.toFixed(3)}` +
        ` r=${r.rightFraction === undefined ? '  -  ' : r.rightFraction.toFixed(3)}` +
        ` size=${Number(r.sizeFraction).toFixed(4)} (${Math.round(Number(r.sizeFraction) * vh)}px)` +
        ` ${String(r.color).padEnd(7)} w${String(r.weight).padEnd(3)}` +
        ` ids=${(r.removeIds ?? []).length}` +
        (r.spans ? ` spans=${r.spans.map((sp) => sp.color).join('/')}` : '') +
        (r.curve ? ` curve=${r.curve}` : '') +
        ` "${r.content}"`,
      ).join('\n'));

      setAiStatusMsg(t('status.applyingChanges'));

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
        : filterOutBackgroundIds(doc.documentElement, requested, vw, vh, 'customise', parsed.rows);
      console.log(`[customise] taking ${removeIds.length}/${requested.length} element(s) after guard`);
      // Measured before anything is hidden. The boxes are what the replacement text is
      // placed from, and they also give the dev panel something to show per entry.
      const anchors = measureRemovedTextBoxes(doc.documentElement, removeIds);
      const outlines = sampleRemovedLettering(doc.documentElement, removeIds);
      const hidden = hideRemovedElements(aiIdMap, removeIds, parsed.rows, anchors, hiddenLayers, 'customise');
      for (const [, el] of aiIdMap) { el.removeAttribute('data-ai-idx'); el.removeAttribute('data-fill'); }

      const allRows = parsed.hasText ? parsed.rows : [];
      const allFonts = parsed.fonts;

      // Re-add editable text layers — one per detected row (same placement logic as strip-text)
      // Each row's own family AND weight, so the face the model matched is the face that
      // renders — and the face that gets measured a few lines below.
      allRows.forEach(({ font, weight }) => addUsedFont(font, weight));
      await ensureRowFontsReady(allRows);
      console.log(`[customise] ${countTaggedRows(allRows, anchors)}/${allRows.length} row(s) tagged with measured outlines`);
      const newTextLayers = appendTextRowLayers(doc, allRows, { x: vbX, y: vbY, w: vw, h: vh }, undefined, anchors, outlines);

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
        setAiError(t('errors.noTextDetected'));
      }

    } catch (err) {
      setAiError(err instanceof Error ? err.message : t('errors.customiseFailed'));
      setCustomiseDone(true);
    } finally {
      setCustomiseLoading(false);
      setAiLoading(false);
      setAiStatusMsg(t('status.thinking'));
    }
  }, [activeSvg, addGoogleFont, loadGoogleFontLink, snapshotForUndo, notifyCustomised, cooldownActive, selectOne]);

  // ── Replace one detected region with editable text (canvas dot) ───────────
  //
  // The same take-and-replace the customise pass does, for one region the DOM-regions
  // run found: its shapes are measured, then hidden (recoverable from the dev panel, and
  // undoable), and a <text> set in the region's nearest Google Font is placed on the
  // measured geometry and opened for typing.
  const replaceDetectedRegion = useCallback(async (regionNum: number) => {
    const run = detectedRegionsRef.current;
    const region = run?.regions.find((r) => r.region === regionNum);
    if (!activeSvg || !run || !region || typeof region.text_content !== 'string') return;

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const root = doc.documentElement;
    // Region xpaths address the document the detection saw, which had the then-hidden
    // elements removed, so each step counts only the children that were still there.
    const resolve = (xpath: string): Element | null => {
      let el: Element | null = root;
      for (const m of xpath.replace(/^\/\*/, '').matchAll(/\/\*\[(\d+)\]/g)) {
        const kids: Element[] = Array.from(el!.children).filter((c) => !(c.id && run.hidden.has(c.id)));
        el = kids[Number(m[1]) - 1] ?? null;
        if (!el) return null;
      }
      return el;
    };
    const idMap = new Map<string, Element>();
    region.xpaths.forEach((xp, i) => {
      const el = resolve(xp);
      if (el && !(el.id && hiddenLayers.has(el.id))) {
        el.setAttribute('data-ai-idx', `td${i}`);
        idMap.set(`td${i}`, el);
      }
    });
    if (idMap.size === 0) {
      console.warn(`[text-detect] region ${regionNum}: none of its shapes are in the document any more`);
      return;
    }
    const sids = [...idMap.keys()];

    // The model's nearest Google Font, in the weight it named. A family Google does not
    // serve falls back to a Google Font of the same category, so the field never renders
    // in the browser's default face.
    const WEIGHTS: Record<string, number> = { light: 300, regular: 400, medium: 500, bold: 700, black: 900 };
    const FALLBACK: Record<string, string> = {
      sans: 'Inter', serif: 'Lora', script: 'Dancing Script', display: 'Bebas Neue', mono: 'Roboto Mono', handwritten: 'Caveat',
    };
    const weight = Number(region.google_font_weight) || WEIGHTS[String(region.font_weight)] || 400;
    const fallback = FALLBACK[String(region.font_category)] ?? 'Inter';
    let font = typeof region.google_font === 'string' && region.google_font ? region.google_font : fallback;
    const color = typeof region.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(region.color)
      ? region.color
      : /^#[0-9a-f]{3,8}$/i.test(region.fill) ? region.fill : '#000000';

    const vb = parseViewBox(root);
    const [x0, y0, x1, y1] = region.bbox;
    const row: TextRow = {
      // Estimates only: the measured anchors below replace them.
      yFraction: ((y0 + y1) / 2 - vb.y) / vb.h, xFraction: ((x0 + x1) / 2 - vb.x) / vb.w,
      leftFraction: (x0 - vb.x) / vb.w, rightFraction: (x1 - vb.x) / vb.w,
      sizeFraction: (y1 - y0) / vb.h,
      font, weight, color, content: region.text_content, letterSpacing: 0, removeIds: sids,
    };
    addUsedFont(font, weight);
    await ensureRowFontsReady([row]);
    if (font !== fallback && !document.fonts.check(`${weight} 16px "${font}"`)) {
      console.log(`[text-detect] region ${regionNum}: "${font}" is not a Google Font it could load — using ${fallback}`);
      font = fallback;
      row.font = fallback;
      addUsedFont(fallback, weight);
      await ensureRowFontsReady([row]);
    }

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    // Measured before anything is hidden: this is the geometry the field is placed from.
    const anchors = measureRemovedTextBoxes(root, sids);
    const outlines = sampleRemovedLettering(root, sids);
    const hidden = hideRemovedElements(idMap, sids, [row], anchors, hiddenLayers, 'text-detect');
    for (const el of idMap.values()) el.removeAttribute('data-ai-idx');
    const newTextLayers = appendTextRowLayers(doc, [row], vb, undefined, anchors, outlines);
    console.log(`[text-detect] region ${regionNum} → "${row.content}" in ${font} ${weight}, ${sids.length} shape(s) hidden`);

    const content = new XMLSerializer().serializeToString(root);
    const kept = pruneMissingLayers(doc, activeSvg.layers);
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: [...kept, ...newTextLayers] } : null));
    registerRemoved(hidden);
    setTextDetectBoxes((prev) => prev.filter((b) => b.region !== regionNum));
    const added = newTextLayers[0];
    if (added) {
      // selectOne, not setSelectedLayer: the overlay (and the editor inside it) is driven
      // by the selection set, which setSelectedLayer alone leaves empty.
      selectOne(added.id);
      // Straight into typing, unless the field came out curved — those have no flat box
      // to type in, and the Text tab edits them instead (same rule as a canvas click).
      // A frame later, not with the selection: the editor lives inside the selection
      // overlay, which only exists once the new layer has rendered selected, and the
      // effect that focuses it runs once per edit — too early and it finds no node,
      // leaving the glyphs hidden with nothing standing in for them.
      const curved = Number(doc.getElementById(added.id)?.getAttribute('data-curve') ?? '0') !== 0;
      if (!curved) requestAnimationFrame(() => requestAnimationFrame(() => setEditingTextId(added.id)));
    }
  }, [activeSvg, hiddenLayers, addUsedFont, snapshotForUndo, registerRemoved, selectOne]);

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

  // ── Colour replace (use-color-replace.ts) ──────────────────────────────────

  const { layerColors, replaceLayerColor, endColorEdit, resetColorEdit } = useColorReplace({
    activeSvg, setActiveSvg, selectedLayer, snapshotForUndo,
  });

  // ── AI layer actions ───────────────────────────────────────────────────────

  const runAiLayerAction = useCallback(async (action: 'strip-text' | 'suggest-font' | 'remove-specific-text' | 'check-text' = 'strip-text', query = '') => {
    if (!activeSvg || !selectedLayer) return;
    const layerId = selectedLayer;
    setAiLoading(true);
    setAiError(null);
    setAiStatusMsg(t('status.thinking'));
    setTextCheckResult(null);
    setFontSuggestion(null);
    setSuggestedFontName(null);
    if (action === 'strip-text' || action === 'remove-specific-text') {
      snapshotForUndo(activeSvg.content, activeSvg.layers);
    }
    try {
      const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
      const layerEl = doc.getElementById(layerId);
      if (!layerEl) throw new Error(t('errors.layerNotFound'));
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
        setAiStatusMsg(t('status.readingText'));
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

        setAiStatusMsg(t('status.findingText'));
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
          throw new Error(t('errors.unreadableResponse'));
        }
        setAiStatusMsg(t('status.applyingChanges'));
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
      // Before serialising, as in customise: the prompt reads colour off data-fill.
      await annotateRenderedPaint(doc.documentElement, aiIdMap, { x: vbX, y: vbY, w: vw, h: vh }, 'strip-text');
      const markedSvgString = new XMLSerializer().serializeToString(layerEl);

      // v7 retired every v6 answer: those predate the per-row removeIds linking, so
      // replaying one would place its rows from the estimate and quietly look like the
      // measurement had failed. v8 retires v7 in turn — its linking instruction read as a
      // partition ("every index appears in exactly one row"), which made the model answer
      // with one row per stacked copy of a word, and those answers re-add each field
      // three times over.
      const cacheKey = `strip-text-v17:${llmModel(TEXT_PARSE_MODEL)}:${hashString(svgString)}`;
      let parsed: StripResult;

      const cachedRaw = readAiCache(cacheKey);
      if (cachedRaw) {
        console.log('[strip-text] cache hit — skipping the model call:', cacheKey);
        parsed = JSON.parse(cachedRaw) as StripResult;
      } else {
        setAiStatusMsg(t('status.reviewingVector'));
        const rawText = await callLlmVision({
          model: TEXT_PARSE_MODEL, maxTokens: 8192, pngBase64, tag: 'strip-text',
          prompt: `Analyze this SVG layer image and its source code.

${TEXT_PARSING_PROMPT}

SVG source:
${markedSvgString}

Respond with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"hasText":true,"rows":[{"yFraction":0.5,"xFraction":0.5,"leftFraction":0.31,"rightFraction":0.69,"font":"Impact","sizeFraction":0.08,"weight":700,"color":"#ffffff","content":"HELLO","letterSpacing":0.05,"removeIds":["3","9"]}],"removeIds":["3","9"]}`,
        });

        try {
          parsed = JSON.parse(rawText) as StripResult;
          parsed.removeIds = Array.isArray(parsed.removeIds) ? parsed.removeIds.map(String) : [];
          if (Array.isArray(parsed.rows)) parsed.rows.forEach(normaliseRowRemoveIds);
        } catch (err) {
          logUnreadable('strip-text', rawText, err);
          throw new Error(t('errors.unreadableResponse'));
        }

        writeAiCache(cacheKey, JSON.stringify(parsed));
      }

      // Remove identified text elements directly from the DOM
      setAiStatusMsg(t('status.applyingChanges'));
      console.log('[strip-text] LLM returned:', {
        hasText: parsed.hasText,
        rows: parsed.rows?.length ?? 0,
        removeIds: parsed.removeIds,
      });
      const stripRequested = allRemoveIds(parsed);
      const stripRemoveIds = filterOutBackgroundIds(doc.documentElement, stripRequested, vw, vh, 'strip-text', parsed.hasText ? parsed.rows ?? [] : []);
      // Ground truth for placement: the boxes are read off the live geometry, and the
      // elements stay in the document, so this is measuring rather than salvaging.
      const stripAnchors = measureRemovedTextBoxes(doc.documentElement, stripRemoveIds);
      const stripOutlines = sampleRemovedLettering(doc.documentElement, stripRemoveIds);
      const stripHidden = hideRemovedElements(
        aiIdMap, stripRemoveIds, parsed.rows ?? [], stripAnchors, hiddenLayers, 'strip-text',
      );
      console.log(`[strip-text] took ${stripHidden.length}/${stripRequested.length} element(s)`);
      // Clean up temporary index attributes from remaining elements
      for (const [, el] of aiIdMap) {
        el.removeAttribute('data-ai-idx');
        el.removeAttribute('data-fill');
      }

      // One editable text layer per detected row — no grouping, no sub-layers.
      const detectedRows = parsed.hasText ? parsed.rows ?? [] : [];
      detectedRows.forEach(({ font, weight }) => addUsedFont(font, weight));
      await ensureRowFontsReady(detectedRows);
      console.log(`[strip-text] ${countTaggedRows(detectedRows, stripAnchors)}/${detectedRows.length} row(s) tagged with measured outlines`);
      const newTextLayers = appendTextRowLayers(doc, detectedRows, { x: vbX, y: vbY, w: vw, h: vh }, undefined, stripAnchors, stripOutlines);

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
      setAiError(err instanceof Error ? err.message : t('errors.actionFailed'));
    } finally {
      setAiLoading(false);
      setAiStatusMsg(t('status.thinking'));
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
    // The original file has its own canvas again, whatever New Design did since.
    setNoCanvasLayer(false);
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
    resetColorEdit();
  }, [selectedLayer]);

  useEffect(() => {
    setCustomiseFonts([]);
    // Fonts offered for the last artwork say nothing about this one, and left in place
    // they accumulate: the dropdown grew every AI font from every image opened since the
    // tab loaded. The <link> tags stay — a loaded webface costs nothing and may be needed
    // again — but nothing is listed until this artwork's own pass proposes it.
    resetFonts();
    setTaxonomy(null);
    setTaxonomyLoading(false);
    setTaxonomyOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSvg?.src]);

  useEffect(() => {
    if (!selectedLayers.size) return;
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
  }, [selectedLayers]);

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

  // ── Layer structure: duplicate, open a group, fold back, delete (use-layer-structure.ts) ──

  const { duplicateLayer, duplicateLayersAsGroup, expandLayer, collapseLayer, deleteLayers, deleteLayer } =
    useLayerStructure({
      activeSvg, setActiveSvg, backgroundLayerId, selectedLayers, snapshotForUndo, selectOne,
      setSelectedLayer, setSelectedLayers, setExpandDepth, setHiddenLayers, setRemovedRecords,
      expandedLabelsRef, removedIdsRef, removedRecordsRef,
    });

  // Double-click on the canvas: go to the Layers tab and open the layer under the pointer
  // into its parts, selecting the part that was clicked — so repeated double-clicks walk
  // down into a group the way they do in a design tool. A layer with no parts still
  // brings up the Layers tab, with its row already selected by the first click.
  //
  // Text never gets here: its first click opens the inline editor, which stops the
  // double-click from propagating, so double-click-to-type is unaffected.
  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeSvg?.layers.length) return;
    if ((e.target as Element).closest?.('[data-sel-overlay]')) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    let hit: Element | null = null;
    for (let el = e.target as Element | null; el && el !== (svgEl as Element); el = el.parentElement) {
      if (layerIds.has(el.id)) { hit = el; break; }
    }
    if (!hit || hit.id === backgroundLayerId) return;

    setControlTab('layers');
    if (!expandableLayerIds.has(hit.id)) return;
    // The live element has the same structure as the parsed one expandLayer walks, so the
    // index of the child holding the pointer is the index of its new row.
    const target = e.target as Node;
    const focus = expansionTarget(hit).findIndex((kid) => kid.contains(target));
    expandLayer(hit.id, focus >= 0 ? focus : undefined);
  }, [activeSvg, backgroundLayerId, expandableLayerIds, expandLayer]);

  // The Layers tab's breadcrumb. Stable for the memoised control panel; a no-op at the
  // top level, where the breadcrumb isn't rendered at all.
  const onBackOutOfDrill = useCallback(() => {
    if (drillContext) collapseLayer(drillContext.backOutId);
  }, [drillContext, collapseLayer]);

  // Delete/Backspace removes whatever is selected on the canvas, so a selection made by
  // clicking artwork can be deleted without hunting for its row in the panel.
  //
  // selectionIds rather than selectedLayers: it already excludes the locked background,
  // so the key does nothing when the background is all that's selected instead of
  // silently deleting the artwork's backdrop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // Modified presses belong to other bindings, and a caret in a field — the layer
      // rename box, the AI prompt — must keep deleting characters rather than artwork.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      if (!selectionIds.length) return;
      // Backspace is Back in some browsers, which would drop the unsaved document.
      e.preventDefault();
      deleteLayers(selectionIds);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectionIds, deleteLayers]);

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

  // The document controls that used to be the floating top toolbar, now the head of the
  // Tools tab. Memoised because the panel is memoised — a fresh object every render
  // would defeat that.
  const docBundle: DocBundle = useMemo(() => ({
    isDirty,
    undoCount, onUndo: undo,
    redoCount, onRedo: redo,
    onReset: requestReset,
    exportLabel: activeSvg && hiddenRowCount > 0
      ? tr('toolbar.exportPartial', {
          shown: activeSvg.layers.length - hiddenRowCount,
          total: activeSvg.layers.length,
        })
      : tr('toolbar.export'),
    onExport: openRating,
    onCenter: centerLayersToCanvas,
    onRotate90: rotateSelected90,
    transformDisabled: !selectedLayers.size || selectionIsBackground,
    onMatchRotation: matchRotationToSelected,
    matchRotationDisabled: selectedLayers.size !== 1 || selectionIsBackground,
    onTidy: tidySelection,
    onTidyHorizontal: tidySelectionHorizontal,
    onNewDesign: newDesignFromSelection,
    newDesignDisabled: selectionIds.length === 0,
    // Three is the smallest selection the idea means anything for: with two there is one
    // gap and nothing to even it against.
    tidyDisabled: selectionIds.length < 3,
  }), [
    activeSvg, isDirty, undoCount, undo, redoCount, redo, requestReset,
    hiddenRowCount, openRating, centerLayersToCanvas, rotateSelected90,
    selectedLayers.size, selectionIsBackground, matchRotationToSelected, tidySelection,
    tidySelectionHorizontal, newDesignFromSelection,
    selectionIds.length, tr,
  ]);

  // Customise, as the Tools tab needs it. Memoised for the same reason docBundle is: the
  // control panel is memoised, and a fresh object every render would defeat that.
  const customiseBundle: CustomiseBundle = useMemo(() => ({
    onCustomise: runCustomise,
    onOpenTools: onAiToolsClick,
    loading: customiseLoading,
    done: customiseDone,
    toolsOpen: aiPanelOpen,
    showTools: SHOW_DEV_UI,
    // can_edit: 0 — the button stays enabled so the click reaches the upsell.
    gated: activeSvg?.edit === 0,
    // Nothing to customise until the artwork is parsed and on the canvas.
    ready: !!activeSvg?.content && !isLoading,
    // Customised too recently — the button stays live and re-opens the cooldown
    // message instead of running the pass.
    cooldown: cooldownActive,
  }), [
    runCustomise, onAiToolsClick, customiseLoading, customiseDone, aiPanelOpen,
    activeSvg, isLoading, cooldownActive,
  ]);

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
        title={tr('confirm.resetTitle')}
        body={tr('confirm.resetBody')}
        confirmLabel={tr('confirm.resetConfirm')}
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
            hoverBadgeRef={hoverBadgeRef}
            onCanvasClick={handleCanvasClick}
            onCanvasMouseDown={handleCanvasMouseDown}
            onCanvasDoubleClick={handleCanvasDoubleClick}
            onCanvasMouseMove={handleCanvasMouseMove}
            onCanvasMouseLeave={handleCanvasMouseLeave}
            aiLoading={aiLoading}
            aiStatusMsg={aiStatusMsg}
            isLoading={isLoading}
            activeSvg={activeSvg}
            hiddenLayers={hiddenLayers}
            previewIds={previewIds}
            previewOutlineId={previewRemovedId ?? peekedLayerId}
            regionBoxes={visibleRegionBoxes}
            onRegionDotClick={replaceDetectedRegion}
            backgroundLayerId={backgroundLayerId}
            showSelectionOverlay={showSelectionOverlay}
            showSizeBadge={gestureActive}
            selectionIsEmptyText={selectionIsEmptyText}
            onEmptyTextClick={editEmptyText}
            editingTextId={editingTextId}
            textEditorRef={textEditorRef}
            editingStyle={inlineEditStyle}
            onInlineTextInput={onInlineTextInput}
            onEndInlineEdit={endInlineEdit}
            onDragHandleMouseDown={handleDragHandleMouseDown}
            onRotateHandleMouseDown={handleRotateHandleMouseDown}
            onScaleHandleMouseDown={handleScaleHandleMouseDown}
          />

          {activeSvg && (
            <>
              {/* The one control panel — inspector and elements list behind three tabs
                  (assets/UI/design_handoff_tabbed_panel) */}
              <EditorControlPanel
                tab={controlTab}
                onSelectTab={setControlTab}
                doc={docBundle}
                customise={customiseBundle}
                selectedLayer={selectedLayer}
                isBackground={selectionIsBackground}
                layerColors={layerColors}
                onReplaceColor={replaceLayerColor}
                onEndColorEdit={endColorEdit}
                textProps={textProps}
                textContentRef={textContentRef}
                usedFonts={usedFonts}
                extraFonts={suggestedFonts}
                onUpdateTextLayer={updateTextLayerOrDraft}
                onAddTextLayer={addTextLayer}
                layers={activeSvg.layers}
                hiddenLayers={hiddenLayers}
                selectedLayers={selectedLayers}
                backgroundLayerId={backgroundLayerId}
                textLayerIds={textLayerIds}
                expandableLayerIds={expandableLayerIds}
                hiddenInsideCounts={hiddenInsideCounts}
                onExpandLayer={expandLayer}
                drillLabel={drillContext?.label ?? null}
                drillMarks={drillContext?.marks ?? NO_MARKS}
                onBackOut={onBackOutOfDrill}
                onReorderLayers={reorderLayers}
                onSetSelectedLayers={setSelectedLayers}
                onSetSelectedLayer={setSelectedLayer}
                onSelectOne={selectOne}
                onToggleLayer={toggleLayer}
                onDuplicateLayer={duplicateLayer}
                onDeleteLayer={deleteLayer}
                onPeekLayer={setPeekedLayerId}
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
                  textDetectMethod={textDetectMethod}
                  textDetectOptions={TEXT_DETECT_OPTIONS}
                  onSelectTextDetectMethod={selectTextDetectMethod}
                  ai={{
                    loading: aiLoading, error: aiError,
                    fontSuggestion, suggestedFontName,
                    removeTextQuery, setRemoveTextQuery,
                    showRemoveTextInput, setShowRemoveTextInput,
                    textCheckResult, setTextCheckResult,
                  }}
                  fonts={{
                    extra: extraFonts,
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
              {/* Export, in the corner the Customise pill used to hold. */}
              <ExportPill label={docBundle.exportLabel} onExport={docBundle.onExport} />
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
                {tr(isDragging ? 'dropzone.release' : 'dropzone.prompt')}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: C.textFaint }}>{tr('dropzone.browse')}</p>
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
          hideNonTextRegions={hideNonTextRegions}
          onSetHideNonTextRegions={onSetHideNonTextRegions}
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

