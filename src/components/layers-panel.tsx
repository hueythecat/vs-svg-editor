import React, { Dispatch, RefObject, SetStateAction, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { type ActiveSvg, type SvgLayer, type SelectedTextProps, type TaxonomyGroup } from '@/lib/svg-utils';
import { EyeIcon, EyeSlashIcon, GripIcon, SparklesIcon } from './svg-icons';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TextLayerAttrs = {
  content: string; font: string; size: number;
  weight: number; color: string; curve: number; letterSpacing: number;
};

export type AiActionType = 'strip-text' | 'suggest-font' | 'remove-specific-text' | 'check-text';

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
  onReorderLayers: (fromId: string, toId: string, before: boolean) => void;
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
  onAddTextLayer: () => void;
  onCurvePointerDown: () => number | null;
  onCurvePointerUp: (startCenterY: number) => void;
  onRunAiAction: (action?: AiActionType, query?: string) => void;
  onSelectFromColor: (color: string) => void;
  onClearFromColor: () => void;
  onReplaceColor: (overrideTo?: string) => void;
  onAddGoogleFont: (fontName: string) => void;
  onSuggestFonts: () => void;
  onRunTaxonomy: () => void;
  onReset: () => void;
}

// ─── Taxonomy colours ─────────────────────────────────────────────────────────

const TAXONOMY_COLOURS: Record<string, string> = {
  text:       'text-amber-400',
  background: 'text-zinc-400',
  icon:       'text-sky-400',
  graphic:    'text-sky-400',
  decoration: 'text-purple-400',
  shape:      'text-emerald-400',
  image:      'text-rose-400',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function LayersPanel({
  activeSvg, backgroundLayerId, isDirty,
  selectedLayer, selectedLayers, selectedSubElId, hiddenLayers, subLayerMap, selectedTextProps,
  text, ai, color, fonts, taxonomy,
  onSelectOne, onSetSelectedLayers, onSetSelectedLayer, onSetSelectedSubElId,
  onToggleLayer, onReorderLayers,
  onUpdateTextLayer, onAddTextLayer, onCurvePointerDown, onCurvePointerUp,
  onRunAiAction,
  onSelectFromColor, onClearFromColor, onReplaceColor,
  onAddGoogleFont, onSuggestFonts,
  onRunTaxonomy, onReset,
}: LayersPanelProps) {
  // Layer-list drag state (panel-local, no canvas impact)
  const [dragLayerId, setDragLayerId]   = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<{ targetId: string; before: boolean } | null>(null);

  // Refs local to this panel
  const layerListRef         = useRef<HTMLDivElement>(null);
  const panelDragIdRef       = useRef<string | null>(null);
  const panelDropPositionRef = useRef<{ targetId: string; before: boolean } | null>(null);
  const panelReorderDoneRef  = useRef(false);
  const curveStartCenterYRef = useRef<number | null>(null);

  return (
    <aside className="w-52 shrink-0 flex flex-col border-l border-zinc-800 bg-zinc-900/60">

      {/* Image Actions — suggest fonts */}
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
          <div className="px-2 pb-2">
            <button
              onClick={onSuggestFonts}
              disabled={fonts.imageFonts !== null || fonts.imageFontsLoading}
              className={cn(
                'w-full flex items-center justify-center gap-1.5 rounded text-xs py-1.5 transition-colors',
                fonts.imageFonts !== null
                  ? 'bg-zinc-800/30 text-zinc-600 cursor-not-allowed'
                  : fonts.imageFontsLoading
                  ? 'bg-zinc-800/30 text-zinc-500 cursor-wait'
                  : 'bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300'
              )}
            >
              {fonts.imageFontsLoading && <div className="size-3 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin shrink-0" />}
              {fonts.imageFontsLoading ? 'Analysing…' : fonts.imageFonts !== null ? 'Fonts suggested' : 'Suggest fonts'}
            </button>
          </div>
        )}
      </div>

      {/* Layers heading */}
      <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
          Layers
        </span>
        <span className="text-[10px] text-zinc-600">
          {activeSvg.layers.length}
        </span>
      </div>

      {/* Text form */}
      <div className="border-b border-zinc-800">
        <button
          onClick={() => text.setOpen((o) => !o)}
          className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-zinc-800/40 transition-colors"
        >
          <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex-1 text-left">
            Text
          </span>
          <span className="text-zinc-600 text-[10px]">{text.open ? '▲' : '▼'}</span>
        </button>
        {text.open && (
          <div className="px-2 pb-2 flex flex-col gap-1.5">
            <input
              type="text"
              value={selectedTextProps ? selectedTextProps.content : text.form.content}
              onChange={(e) =>
                selectedTextProps
                  ? onUpdateTextLayer({ content: e.target.value })
                  : text.setForm((f) => ({ ...f, content: e.target.value }))
              }
              placeholder="Text content"
              className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500 placeholder:text-zinc-600"
            />
            <select
              value={selectedTextProps ? selectedTextProps.font : text.form.font}
              onChange={(e) =>
                selectedTextProps
                  ? onUpdateTextLayer({ font: e.target.value })
                  : text.setForm((f) => ({ ...f, font: e.target.value }))
              }
              className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500"
            >
              {['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Impact', 'Trebuchet MS'].map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
              ))}
              {fonts.extra.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f} ✦</option>
              ))}
            </select>
            <div className="flex gap-1.5">
              <input
                type="number"
                min={1}
                max={999}
                value={selectedTextProps ? selectedTextProps.size : text.form.size}
                onChange={(e) =>
                  selectedTextProps
                    ? onUpdateTextLayer({ size: Math.max(1, Number(e.target.value)) })
                    : text.setForm((f) => ({ ...f, size: Math.max(1, Number(e.target.value)) }))
                }
                className="w-full rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-2 py-1 outline-none focus:border-zinc-500"
                title="Font size"
              />
              <select
                value={selectedTextProps ? selectedTextProps.weight : text.form.weight}
                onChange={(e) =>
                  selectedTextProps
                    ? onUpdateTextLayer({ weight: Number(e.target.value) })
                    : text.setForm((f) => ({ ...f, weight: Number(e.target.value) }))
                }
                className="w-16 shrink-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs px-1 py-1 outline-none focus:border-zinc-500"
                title="Font weight"
              >
                {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-1.5 items-center">
              <input
                type="color"
                value={selectedTextProps ? selectedTextProps.color : text.form.color}
                onChange={(e) =>
                  selectedTextProps
                    ? onUpdateTextLayer({ color: e.target.value })
                    : text.setForm((f) => ({ ...f, color: e.target.value }))
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
                        ? onUpdateTextLayer({ color: result.sRGBHex })
                        : text.setForm((f) => ({ ...f, color: result.sRGBHex }));
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
                value={selectedTextProps ? selectedTextProps.letterSpacing : text.form.letterSpacing}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  selectedTextProps
                    ? onUpdateTextLayer({ letterSpacing: v })
                    : text.setForm((f) => ({ ...f, letterSpacing: v }));
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
                value={selectedTextProps ? (selectedTextProps.curve ?? 0) : text.form.curve}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  selectedTextProps
                    ? onUpdateTextLayer({ curve: v })
                    : text.setForm((f) => ({ ...f, curve: v }));
                }}
                onPointerDown={() => {
                  curveStartCenterYRef.current = onCurvePointerDown();
                }}
                onPointerUp={() => {
                  if (curveStartCenterYRef.current !== null) {
                    onCurvePointerUp(curveStartCenterYRef.current);
                    curveStartCenterYRef.current = null;
                  }
                }}
                className="flex-1 min-w-0 accent-zinc-400"
              />
              <span className="text-[10px] text-zinc-500 w-7 text-right tabular-nums shrink-0">
                {selectedTextProps ? (selectedTextProps.curve ?? 0) : text.form.curve}
              </span>
            </div>

            {!selectedTextProps && (
              <button
                onClick={onAddTextLayer}
                disabled={!text.form.content.trim()}
                className={cn(
                  'w-full rounded text-xs font-medium py-1.5 transition-colors',
                  text.form.content.trim()
                    ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
                    : 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
                )}
              >
                Add layer
              </button>
            )}
          </div>
        )}
      </div>

      {/* Layer Actions */}
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
                    onClick={() => {
                      if (selectedTextProps) {
                        onUpdateTextLayer({ font: ai.suggestedFontName! });
                      } else {
                        text.setForm((f) => ({ ...f, font: ai.suggestedFontName! }));
                      }
                    }}
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

      {/* Color Replace — non-text layers only */}
      {selectedLayer && !selectedTextProps && (
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
      )}

      {/* Layer list */}
      <div
        ref={layerListRef}
        className="flex flex-col overflow-y-auto py-1 flex-1"
        onPointerMove={(e) => {
          if (!panelDragIdRef.current) return;
          setDragLayerId(panelDragIdRef.current);
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const row = under?.closest('[data-layer-id]') as HTMLElement | null;
          if (!row || row.dataset.layerId === panelDragIdRef.current) {
            panelDropPositionRef.current = null;
            setDropPosition(null);
            return;
          }
          const rect = row.getBoundingClientRect();
          const pos = { targetId: row.dataset.layerId!, before: e.clientY < rect.top + rect.height / 2 };
          panelDropPositionRef.current = pos;
          setDropPosition(pos);
        }}
        onPointerUp={(e) => {
          if (!panelDragIdRef.current) return;
          layerListRef.current?.releasePointerCapture(e.pointerId);
          const pos = panelDropPositionRef.current;
          if (pos) {
            onReorderLayers(panelDragIdRef.current, pos.targetId, pos.before);
            panelReorderDoneRef.current = true;
          }
          panelDragIdRef.current = null;
          panelDropPositionRef.current = null;
          setDragLayerId(null);
          setDropPosition(null);
        }}
        onPointerCancel={() => {
          panelDragIdRef.current = null;
          panelDropPositionRef.current = null;
          setDragLayerId(null);
          setDropPosition(null);
        }}
      >
        {activeSvg.layers.length === 0 ? (
          <p className="text-xs text-zinc-600 px-3 py-4 text-center">No named layers found</p>
        ) : (
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
                      onSetSelectedLayers((prev) => {
                        const next = new Set(prev);
                        if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
                        return next;
                      });
                      onSetSelectedLayer(layer.id);
                    } else {
                      onSelectOne(layer.id);
                    }
                  }}
                  onClick={() => {
                    if (panelReorderDoneRef.current) panelReorderDoneRef.current = false;
                  }}
                  className={cn(
                    'relative group flex items-center gap-2 px-2 py-1.5 mx-1 rounded-md transition-colors select-none',
                    isSelected ? 'bg-zinc-700/60 ring-1 ring-inset ring-zinc-600' : 'hover:bg-zinc-800/60',
                    hidden && 'opacity-40',
                    isDragged && 'opacity-25',
                  )}
                >
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
                      onSelectOne(layer.id);
                      layerListRef.current?.setPointerCapture(e.pointerId);
                      panelDragIdRef.current = layer.id;
                      panelDropPositionRef.current = null;
                    }}
                    className="shrink-0 cursor-grab opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-300 transition-opacity"
                  >
                    <GripIcon className="size-2" />
                  </span>

                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onToggleLayer(layer.id); }}
                    title={hidden ? 'Show layer' : 'Hide layer'}
                    className="shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors"
                  >
                    {hidden ? <EyeSlashIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
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
                        onSelectOne(layer.id);
                        onSetSelectedSubElId(sub.id);
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

      {/* Revert */}
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
    </aside>
  );
}
