import React, { RefObject, useRef } from 'react';

import type { SelectedTextProps } from '@/lib/svg-utils';
import { cn } from '@/lib/utils';
import type { TextBundle, TextLayerAttrs } from './layers-panel';

// The collapsible "Text" form in the layers panel: content / font / size / weight /
// colour / letter-spacing / curve, plus "Add layer" when nothing is selected. When a
// text layer is selected its live props drive the inputs (edits go through
// onUpdateTextLayer); otherwise the pending text-form state (text.form) is edited.
// Extracted from layers-panel.tsx and memoised.
export const TextControls = React.memo(function TextControls({
  text, selectedTextProps, textContentRef, extraFonts,
  onUpdateTextLayer, onAddTextLayer, onCurvePointerDown, onCurvePointerUp,
}: {
  text: TextBundle;
  selectedTextProps: SelectedTextProps | null;
  textContentRef: RefObject<HTMLInputElement | null>;
  extraFonts: string[];
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
  onAddTextLayer: () => void;
  onCurvePointerDown: () => number | null;
  onCurvePointerUp: (startCenterY: number) => void;
}) {
  const curveStartCenterYRef = useRef<number | null>(null);

  return (
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
            ref={textContentRef}
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
            {extraFonts.map((f) => (
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
  );
});
