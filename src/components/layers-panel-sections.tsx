import React from 'react';

import { cn } from '@/lib/utils';
import { SparklesIcon } from './svg-icons';
import type {
  AiActionType, AiBundle, ColorBundle, FontBundle, LlmProvider, TaxonomyBundle,
} from './layers-panel';

// The collapsible sub-sections of the right-hand layers panel, each extracted from
// layers-panel.tsx and memoised. Bundles are passed through as-is; toggle/apply logic
// that needs sibling state stays in the parent behind small callbacks.

// ── Model select ────────────────────────────────────────────────────────────
export const ModelSelect = React.memo(function ModelSelect({
  value, disabled, options, onChange,
}: {
  value: LlmProvider;
  disabled: boolean;
  options: ReadonlyArray<{ value: LlmProvider; label: string }>;
  onChange: (value: LlmProvider) => void;
}) {
  return (
    <div className="border-b border-zinc-800 shrink-0 px-2 py-2 flex flex-col gap-1">
      <span className="text-[9px] text-zinc-500 px-1 uppercase tracking-wider">Model</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as LlmProvider)}
        className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1.5 outline-none focus:border-zinc-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
});

// ── Image Actions (Customise + apply-font-globally) ─────────────────────────
export const ImageActions = React.memo(function ImageActions({
  fonts, onCustomise, onApplyFontGlobally,
}: {
  fonts: FontBundle;
  onCustomise: () => void;
  onApplyFontGlobally: (fontName: string) => void;
}) {
  return (
    <div className="border-b border-zinc-800 shrink-0">
      <button
        onClick={() => fonts.setSuggestOpen((o) => !o)}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
      >
        <SparklesIcon className="size-3 text-indigo-400" />
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest flex-1 text-left">
          Image Actions
        </span>
        <span className="text-zinc-600 text-[10px]">{fonts.suggestOpen ? '▲' : '▼'}</span>
      </button>
      {fonts.suggestOpen && (
        <div className="px-2 pb-2 flex flex-col gap-1.5">
          <button
            onClick={onCustomise}
            disabled={fonts.customiseLoading || fonts.imageFontsLoading || fonts.customiseDone}
            className={cn(
              'w-full flex items-center justify-center gap-1.5 rounded text-xs py-1.5 transition-colors',
              (fonts.customiseLoading || fonts.imageFontsLoading)
                ? 'bg-zinc-800/30 text-zinc-500 cursor-wait'
                : fonts.customiseDone
                ? 'bg-zinc-800/30 text-zinc-500 cursor-not-allowed'
                : 'bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300'
            )}
          >
            {fonts.customiseLoading && <div className="size-3 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin shrink-0" />}
            {fonts.customiseLoading ? 'Analysing…' : fonts.customiseDone ? 'Customised' : 'Customise'}
          </button>

          {fonts.customiseFonts.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[9px] text-zinc-500 px-1 uppercase tracking-wider">Apply font globally</span>
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    onApplyFontGlobally(e.target.value);
                    e.target.value = '';
                  }
                }}
                className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1.5 outline-none focus:border-zinc-500 cursor-pointer"
              >
                <option value="" disabled>Choose a font…</option>
                {fonts.customiseFonts.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ── Layer Actions (per-layer AI dropdown + results) ─────────────────────────
export const LayerActions = React.memo(function LayerActions({
  ai, selectedLayer, backgroundLayerId, onRunAiAction, onUseSuggestedFont,
}: {
  ai: AiBundle;
  selectedLayer: string | null;
  backgroundLayerId: string | null;
  onRunAiAction: (action?: AiActionType, query?: string) => void;
  onUseSuggestedFont: (font: string) => void;
}) {
  return (
    <div className="border-b border-zinc-800 shrink-0">
      <button
        onClick={() => ai.setActionsOpen((o) => !o)}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
      >
        <SparklesIcon className="size-3 text-indigo-400" />
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest flex-1 text-left">
          Layer Actions
        </span>
        <span className="text-zinc-600 text-[10px]">{ai.actionsOpen ? '▲' : '▼'}</span>
      </button>
      {ai.actionsOpen && (
        <div className="px-2 pb-2 flex flex-col gap-1.5">
          <select
            value=""
            disabled={ai.loading || selectedLayer === backgroundLayerId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'strip-text') onRunAiAction('strip-text');
              else if (v === 'suggest-font') onRunAiAction('suggest-font');
              else if (v === 'remove-specific-text') { ai.setShowRemoveTextInput(true); ai.setRemoveTextQuery(''); }
              else if (v === 'check-text') { ai.setTextCheckResult(null); onRunAiAction('check-text'); }
            }}
            className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs px-2 py-1.5 outline-none focus:border-zinc-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="" disabled hidden>
              {ai.loading ? 'Processing…' : selectedLayer === backgroundLayerId ? 'Not available for canvas layer' : 'Choose an action…'}
            </option>
            {selectedLayer && <option value="strip-text">Strip text — layer (AI)</option>}
            {selectedLayer && <option value="suggest-font">Suggest font — layer (AI)</option>}
            {selectedLayer && <option value="remove-specific-text">Remove specific text — layer (AI)</option>}
            {selectedLayer && <option value="check-text">Check text — layer (AI)</option>}
          </select>

          {ai.showRemoveTextInput && selectedLayer && (
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="Text to remove…"
                value={ai.removeTextQuery}
                onChange={(e) => ai.setRemoveTextQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ai.removeTextQuery.trim() && !ai.loading)
                    onRunAiAction('remove-specific-text', ai.removeTextQuery.trim());
                }}
                disabled={ai.loading}
                autoFocus
                className="flex-1 min-w-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs px-2 py-1 outline-none focus:border-zinc-500 disabled:opacity-50"
              />
              <button
                onClick={() => {
                  if (ai.removeTextQuery.trim() && !ai.loading)
                    onRunAiAction('remove-specific-text', ai.removeTextQuery.trim());
                }}
                disabled={!ai.removeTextQuery.trim() || ai.loading}
                className="shrink-0 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-2 py-1 transition-colors"
              >
                Remove
              </button>
            </div>
          )}

          {ai.textCheckResult && (
            <div className="rounded bg-zinc-800/60 border border-zinc-700 px-2 py-1.5 flex flex-col gap-0.5">
              {ai.textCheckResult.heading ? (
                <p className="text-[11px] font-semibold text-zinc-200 leading-snug">{ai.textCheckResult.heading}</p>
              ) : (
                <p className="text-[10px] text-zinc-500 italic leading-snug">No heading detected</p>
              )}
              {ai.textCheckResult.subheading && (
                <p className="text-[10px] text-zinc-400 leading-snug">{ai.textCheckResult.subheading}</p>
              )}
            </div>
          )}

          {ai.error && (
            <p className="text-[10px] text-red-400 px-1 break-all leading-tight">{ai.error}</p>
          )}

          {ai.fontSuggestion && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] text-zinc-300 px-1 leading-snug">{ai.fontSuggestion}</p>
              {ai.suggestedFontName && (
                <button
                  onClick={() => onUseSuggestedFont(ai.suggestedFontName!)}
                  className="w-full rounded text-xs font-medium py-1 text-zinc-300 bg-zinc-700/60 hover:bg-zinc-600/60 transition-colors"
                >
                  Use &ldquo;{ai.suggestedFontName}&rdquo;
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ── Color Replace (non-text layers) ─────────────────────────────────────────
export const ColorReplace = React.memo(function ColorReplace({
  color, onSelectFromColor, onClearFromColor, onReplaceColor,
}: {
  color: ColorBundle;
  onSelectFromColor: (color: string) => void;
  onClearFromColor: () => void;
  onReplaceColor: (overrideTo?: string) => void;
}) {
  return (
    <div className="border-b border-zinc-800 shrink-0">
      <button
        onClick={() => color.setOpen((o) => !o)}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex-1 text-left">
          Color Replace
        </span>
        <span className="text-zinc-600 text-[10px]">{color.open ? '▲' : '▼'}</span>
      </button>
      {color.open && (
        <div className="px-2 pb-2 flex flex-col gap-1.5">
          {/* From swatches */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] text-zinc-500">From</span>
              {color.from && (
                <button
                  onClick={onClearFromColor}
                  title="Clear selection"
                  className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors leading-none"
                >✕</button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 px-1 items-start">
              {color.layerColors.length > 0 ? color.layerColors.map((c) => (
                <button
                  key={c}
                  title={c}
                  onClick={() => onSelectFromColor(c)}
                  style={{
                    backgroundColor: c,
                    width: '2rem', height: '2rem', flexShrink: 0,
                    borderRadius: '3px',
                    border: color.from === c ? '2px solid #60a5fa' : '2px solid #52525b',
                    cursor: 'pointer',
                    transition: 'transform 0.1s, border-color 0.1s',
                    transform: color.from === c ? 'scale(1.1)' : 'scale(1)',
                  }}
                />
              )) : (
                <span className="text-[9px] text-zinc-600">no colors detected</span>
              )}
            </div>
          </div>

          {/* To picker */}
          <div className="flex items-center gap-2 px-1">
            <span className="text-[10px] text-zinc-500 shrink-0">
              To {!color.from && <span className="text-zinc-600">(pick From first)</span>}
            </span>
            <input
              type="color"
              value={color.to}
              disabled={!color.from}
              onChange={(e) => {
                const c = e.target.value;
                color.setTo(c);
                onReplaceColor(c);
              }}
              onBlur={() => {
                if (color.from && !color.layerColors.includes(color.from)) onClearFromColor();
              }}
              title="Pick replacement colour"
              className="rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ width: '2rem', height: '2rem', flexShrink: 0, padding: '1px 2px', background: 'transparent', border: '2px solid #52525b', borderRadius: '3px' }}
            />
          </div>
        </div>
      )}
    </div>
  );
});

// ── Taxonomy ────────────────────────────────────────────────────────────────
const TAXONOMY_COLOURS: Record<string, string> = {
  text:       'text-amber-400',
  background: 'text-zinc-400',
  icon:       'text-sky-400',
  graphic:    'text-sky-400',
  decoration: 'text-purple-400',
  shape:      'text-emerald-400',
  image:      'text-rose-400',
};

export const TaxonomyPanel = React.memo(function TaxonomyPanel({
  taxonomy, onRunTaxonomy,
}: {
  taxonomy: TaxonomyBundle;
  onRunTaxonomy: () => void;
}) {
  return (
    <div className="border-t border-zinc-800 shrink-0">
      <button
        onClick={() => taxonomy.setOpen((o) => !o)}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex-1 text-left">Taxonomy</span>
        {taxonomy.loading
          ? <div className="size-2.5 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin" />
          : <span className="text-zinc-600 text-[10px]">{taxonomy.open ? '▲' : '▼'}</span>
        }
      </button>
      {taxonomy.open && (
        <div className="px-2 pb-2 flex flex-col gap-0.5 max-h-44 overflow-y-auto">
          {taxonomy.loading && (
            <div className="flex items-center gap-2 py-1">
              <div className="size-3 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin shrink-0" />
              <span className="text-[10px] text-zinc-500">Analysing…</span>
            </div>
          )}
          {!taxonomy.loading && taxonomy.data === null && (
            <button
              onClick={onRunTaxonomy}
              className="text-left text-[10px] text-zinc-500 hover:text-zinc-300 py-1 transition-colors"
            >
              Analyse structure →
            </button>
          )}
          {taxonomy.data && taxonomy.data.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic py-1">Could not analyse structure</p>
          )}
          {taxonomy.data && taxonomy.data.length > 0 && taxonomy.data.map((group, i) => (
            <div key={`${group.type}-${i}`} className="rounded px-1.5 py-1">
              <span className={cn(
                'text-[9px] font-bold uppercase tracking-wider',
                TAXONOMY_COLOURS[group.type.toLowerCase()] ?? 'text-zinc-400'
              )}>
                {group.type}
              </span>
              <div className="flex flex-col gap-0.5 mt-0.5">
                {group.elements.map((desc, j) => (
                  <span key={j} className="text-[10px] text-zinc-400 leading-snug">{desc}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ── Revert button ───────────────────────────────────────────────────────────
export const RevertButton = React.memo(function RevertButton({
  isDirty, onReset,
}: {
  isDirty: boolean;
  onReset: () => void;
}) {
  return (
    <div className="px-2 py-2 border-t border-zinc-800 shrink-0">
      <button
        onClick={onReset}
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
  );
});
