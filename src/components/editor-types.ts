import type { TaxonomyGroup } from '@/lib/svg-utils';
import type { Dispatch, RefObject, SetStateAction } from 'react';

// Shared prop bundles for the editor panels. These used to live in layers-panel.tsx,
// which was the single docked right-hand panel; the design splits that panel into a
// floating inspector, an ELEMENTS panel and an AI panel, so the types now live on
// their own rather than in whichever component happens to be the biggest consumer.

export type TextLayerAttrs = {
  content: string; font: string; size: number;
  weight: number; color: string; curve: number; letterSpacing: number;
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
  containerLayerId: string | null; // the layer row it sits under, so its own row files beside it
};

// Which LLM backs every AI action. Labels are what the model dropdown shows; the
// concrete model ids live server-side in the matching /api route.
export type LlmProvider = 'claude' | 'kimi';

// Kimi is off the menu for now; the 'kimi' provider and its /api/kimi route are
// still wired up, so re-adding the entry below is all it takes to bring it back.
export const LLM_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'claude', label: 'Claude — Sonnet 5' },
];

type TextForm = {
  content: string; font: string; size: number; weight: number;
  color: string; curve: number; letterSpacing: number;
};

export interface TextBundle {
  form: TextForm;
  setForm: Dispatch<SetStateAction<TextForm>>;
}

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

export interface ColorBundle {
  from: string;
  to: string;
  setTo: Dispatch<SetStateAction<string>>;
  layerColors: string[];
  baselineRef: RefObject<string | null>;
}

export interface FontBundle {
  extra: string[];
  imageFonts: Array<{ font: string; reason: string }> | null;
  imageFontsLoading: boolean;
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
