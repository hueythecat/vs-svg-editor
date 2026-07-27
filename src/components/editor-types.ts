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
