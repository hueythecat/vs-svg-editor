import type { TaxonomyGroup } from '@/lib/svg-utils';
import type { Dispatch, SetStateAction } from 'react';

// Shared prop bundles for the editor panels. These used to live in layers-panel.tsx,
// which was the single docked right-hand panel; the design splits that panel into a
// floating inspector, an ELEMENTS panel and an AI panel, so the types now live on
// their own rather than in whichever component happens to be the biggest consumer.

export type TextLayerAttrs = {
  content: string; font: string; size: number;
  weight: number; color: string; curve: number; letterSpacing: number;
};

// Document-level controls: what can be undone, what leaves the app, and what moves the
// artwork as a whole. These were the floating top toolbar; they are now the head of the
// Tools tab, so they travel as one bundle rather than a dozen separate props.
export type DocBundle = {
  isDirty: boolean;
  undoCount: number;
  onUndo: () => void;
  redoCount: number;
  onRedo: () => void;
  onReset: () => void;
  exportLabel: string;
  onExport: () => void;
  onCenter: () => void;
  onRotate90: () => void;
  transformDisabled: boolean;
  onMatchRotation: () => void;
  matchRotationDisabled: boolean;
  onTidy: () => void;
  onTidyHorizontal: () => void;
  onNewDesign: () => void;
  newDesignDisabled: boolean;
  tidyDisabled: boolean;
};

// The Customise pass, as the Tools tab needs it. The pass itself lives in the AI code;
// what the button has to know is only whether it can run and what it should say — the
// same set the floating pill carried before Export took that corner of the canvas.
export type CustomiseBundle = {
  onCustomise: () => void;
  onOpenTools: () => void;
  loading: boolean;
  done: boolean;
  toolsOpen: boolean;
  showTools: boolean;
  gated: boolean;
  ready: boolean;
  cooldown: boolean;
};

export type AiActionType = 'strip-text' | 'suggest-font' | 'remove-specific-text' | 'check-text';

// One element an AI pass took out of the artwork.
//
// The passes hide rather than delete, so every entry here is still in the document and
// still restorable — this is the record of what to offer back. It exists because the
// model's judgement about what "is text" is unreliable on ornate artwork: on a
// calligraphic logo it named the frame and every flourish, and deleting on that answer
// destroyed the design. Hiding makes a wrong call a nuisance instead of damage.
//
// `claimedBy` is the axis that matters. A pass reports both a bulk list of text elements
// and a per-row linking of which elements draw which line; an element that no row claimed
// is one nothing asserted was text, and those are exactly the ones a bad answer produces
// in bulk. Grouping on it puts the suspect elements together instead of scattering them
// among the legitimate ones.
//
// `parentId` is what makes the list usable and the preview work at all. A pass routinely
// takes a <g> AND its children — the marking walk indexes both, and the model names both —
// so on one sample 46 of 49 entries were nested inside another entry. That matters twice
// over: display:none on an ancestor cannot be overridden by a descendant, so showing a
// nested element requires showing its whole subtree, and a flat list of 49 rows for 3
// actual pieces of artwork is impossible to find anything in.
export type RemovedRecord = {
  id: string;                // synthesized onto the element so it can be addressed later
  tag: string;               // 'path', 'g', … — enough to recognise it in the list
  claimedBy: string | null;  // the text row's content, or null when no row claimed it
  box: { x: number; y: number; w: number; h: number } | null; // root-space ink, for the list
  parentId: string | null;   // nearest ancestor that is also hidden; null makes this a root
};

// Which LLM backs every AI action. Labels are what the model dropdown shows; the
// concrete model ids live server-side in the matching /api route. 'claude-opus' also
// goes to /api/claude, but swaps every call site's Sonnet id for OPUS_MODEL.
export type LlmProvider = 'claude' | 'claude-opus' | 'kimi' | 'local';

export const OPUS_MODEL = 'claude-opus-5-5';

// The 'local' provider: an Ollama model on the developer's own machine, answered by
// /api/local (and by /api/svg-text for text detection) — free, a minute or two a call,
// and well short of Sonnet on busy artwork. Must match LOCAL_MODEL in src/lib/ollama.ts,
// which can't be imported here: that module is server-only (node:http).
export const LOCAL_MODEL = 'qwen3-vl:8b';

// Kimi is off the menu for now; the 'kimi' provider and its /api/kimi route are
// still wired up, so re-adding the entry below is all it takes to bring it back.
export const LLM_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'claude', label: 'Claude — Sonnet 5' },
  { value: 'claude-opus', label: 'Claude — Opus 5.5' },
  { value: 'local', label: `Local — ${LOCAL_MODEL}` },
];

// How the Customise pass finds the text in the artwork. 'current' is the vision pass
// over the marked source (TEXT_PARSING_PROMPT). 'dom-regions' is its replacement,
// src/lib/svg-text-detect.ts — DOM-measured regions plus an annotated render, judged by
// /api/svg-text. For now Customise only runs it and logs the JSON; nothing is applied.
// 'dom-regions' is the default (svg-drop-zone.web.tsx), and so is Opus for the model.
export type TextDetectMethod = 'current' | 'dom-regions';

export const TEXT_DETECT_OPTIONS: Array<{ value: TextDetectMethod; labelKey: string }> = [
  { value: 'current', labelKey: 'ai.textDetectCurrent' },
  { value: 'dom-regions', labelKey: 'ai.textDetectDomRegions' },
];

// One region from a DOM-regions text-detection run, as fractions (0–1) of the viewBox so
// the canvas can place it on the board at any size. `replaceable` regions — the ones the
// model read as text — get a dot that swaps the artwork for an editable field.
export type RegionBox = {
  region: number; left: number; top: number; width: number; height: number; replaceable: boolean;
};

export interface AiBundle {
  loading: boolean;
  error: string | null;
  fontSuggestion: string | null;
  suggestedFontName: string | null;
  removeTextQuery: string;
  setRemoveTextQuery: Dispatch<SetStateAction<string>>;
  showRemoveTextInput: boolean;
  setShowRemoveTextInput: Dispatch<SetStateAction<boolean>>;
  textCheckResult: { heading: string; subheading: string } | null;
  setTextCheckResult: Dispatch<SetStateAction<{ heading: string; subheading: string } | null>>;
}

export interface FontBundle {
  extra: string[];
  customiseFonts: string[];
  customiseLoading: boolean;
  customiseDone: boolean;
}

export interface TaxonomyBundle {
  data: TaxonomyGroup[] | null;
  loading: boolean;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}
