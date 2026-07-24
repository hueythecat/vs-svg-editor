import { type ActiveSvg, type SelectedTextProps, type TaxonomyGroup } from '@/lib/svg-utils';
import { Dispatch, RefObject, SetStateAction } from 'react';
import { TextControls } from './text-controls';
import { LayerList } from './layer-list';
import { ModelSelect, ImageActions, LayerActions, ColorReplace, TaxonomyPanel, RevertButton } from './layers-panel-sections';

// ─── Types ───────────────────────────────────────────────────────────────────

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
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}

export interface AiBundle {
  loading: boolean;
  error: string | null;
  actionsOpen: boolean;
  setActionsOpen: Dispatch<SetStateAction<boolean>>;
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
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  layerColors: string[];
  baselineRef: RefObject<string | null>;
}

export interface FontBundle {
  extra: string[];
  imageFonts: Array<{ font: string; reason: string }> | null;
  imageFontsLoading: boolean;
  suggestOpen: boolean;
  setSuggestOpen: Dispatch<SetStateAction<boolean>>;
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

export interface LayersPanelProps {
  activeSvg: ActiveSvg;
  backgroundLayerId: string | null;
  isDirty: boolean;
  selectedLayer: string | null;
  selectedLayers: Set<string>;
  selectedSubElId: string | null;
  hiddenLayers: Set<string>;
  subLayerMap: Map<string, Array<{ id: string; label: string }>>;
  selectedTextProps: SelectedTextProps | null;
  textContentRef: RefObject<HTMLInputElement | null>;

  text: TextBundle;
  ai: AiBundle;
  color: ColorBundle;
  fonts: FontBundle;
  taxonomy: TaxonomyBundle;

  onSelectOne: (id: string | null) => void;
  onSetSelectedLayers: Dispatch<SetStateAction<Set<string>>>;
  onSetSelectedLayer: Dispatch<SetStateAction<string | null>>;
  onSetSelectedSubElId: Dispatch<SetStateAction<string | null>>;
  onToggleLayer: (id: string) => void;
  onDuplicateLayer: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onReorderLayers: (fromId: string, toId: string, before: boolean) => void;
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
  onAddTextLayer: () => void;
  onCurvePointerDown: () => number | null;
  onCurvePointerUp: (startCenterY: number) => void;
  llmProvider: LlmProvider;
  onSelectLlmProvider: (provider: LlmProvider) => void;
  onRunAiAction: (action?: AiActionType, query?: string) => void;
  onSelectFromColor: (color: string) => void;
  onClearFromColor: () => void;
  onReplaceColor: (overrideTo?: string) => void;
  onAddGoogleFont: (fontName: string) => void;
  onSuggestFonts: () => void;
  onCustomise: () => void;
  onApplyFontGlobally: (fontName: string) => void;
  onRunTaxonomy: () => void;
  onReset: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LayersPanel({
  activeSvg, backgroundLayerId, isDirty,
  selectedLayer, selectedLayers, selectedSubElId, hiddenLayers, subLayerMap, selectedTextProps,
  textContentRef,
  text, ai, color, fonts, taxonomy,
  llmProvider, onSelectLlmProvider,
  onSelectOne, onSetSelectedLayers, onSetSelectedLayer, onSetSelectedSubElId,
  onToggleLayer, onDuplicateLayer, onDeleteLayer, onReorderLayers,
  onUpdateTextLayer, onAddTextLayer, onCurvePointerDown, onCurvePointerUp,
  onRunAiAction,
  onSelectFromColor, onClearFromColor, onReplaceColor,
  onAddGoogleFont, onSuggestFonts, onCustomise, onApplyFontGlobally,
  onRunTaxonomy, onReset,
}: LayersPanelProps) {
  return (
    <aside className="w-52 shrink-0 flex flex-col border-l border-zinc-800 bg-zinc-900/60">

      {/* Model — backs every AI action in the panel */}
      <ModelSelect
        value={llmProvider}
        disabled={ai.loading || fonts.customiseLoading || fonts.imageFontsLoading}
        options={LLM_OPTIONS}
        onChange={onSelectLlmProvider}
      />

      {/* Image Actions (extracted, memoised) — see layers-panel-sections.tsx */}
      <ImageActions fonts={fonts} onCustomise={onCustomise} onApplyFontGlobally={onApplyFontGlobally} />

      {/* Layers heading */}
      <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
          Layers
        </span>
        <span className="text-[10px] text-zinc-600">
          {activeSvg.layers.length}
        </span>
      </div>

      {/* Text form (extracted, memoised) — see text-controls.tsx */}
      <TextControls
        text={text}
        selectedTextProps={selectedTextProps}
        textContentRef={textContentRef}
        extraFonts={fonts.extra}
        onUpdateTextLayer={onUpdateTextLayer}
        onAddTextLayer={onAddTextLayer}
        onCurvePointerDown={onCurvePointerDown}
        onCurvePointerUp={onCurvePointerUp}
      />

      {/* Layer Actions (extracted, memoised) — see layers-panel-sections.tsx */}
      <LayerActions
        ai={ai}
        selectedLayer={selectedLayer}
        backgroundLayerId={backgroundLayerId}
        onRunAiAction={onRunAiAction}
        onUseSuggestedFont={(font) =>
          selectedTextProps ? onUpdateTextLayer({ font }) : text.setForm((f) => ({ ...f, font }))
        }
      />

      {/* Color Replace — non-text layers only (extracted, memoised) */}
      {selectedLayer && !selectedTextProps && (
        <ColorReplace
          color={color}
          onSelectFromColor={onSelectFromColor}
          onClearFromColor={onClearFromColor}
          onReplaceColor={onReplaceColor}
        />
      )}

      {/* Layer list (extracted, memoised) — see layer-list.tsx */}
      <LayerList
        layers={activeSvg.layers}
        hiddenLayers={hiddenLayers}
        selectedLayers={selectedLayers}
        backgroundLayerId={backgroundLayerId}
        subLayerMap={subLayerMap}
        selectedSubElId={selectedSubElId}
        onReorderLayers={onReorderLayers}
        onSetSelectedLayers={onSetSelectedLayers}
        onSetSelectedLayer={onSetSelectedLayer}
        onSelectOne={onSelectOne}
        onToggleLayer={onToggleLayer}
        onDuplicateLayer={onDuplicateLayer}
        onDeleteLayer={onDeleteLayer}
        onSetSelectedSubElId={onSetSelectedSubElId}
      />

      {/* Taxonomy (extracted, memoised) — see layers-panel-sections.tsx */}
      <TaxonomyPanel taxonomy={taxonomy} onRunTaxonomy={onRunTaxonomy} />

      {/* Revert (extracted, memoised) */}
      <RevertButton isDirty={isDirty} onReset={onReset} />
    </aside>
  );
}
