import React, { RefObject, useCallback, useState } from 'react';

import type { SelectedTextProps } from '@/lib/svg-utils';
import {
  BG_PALETTE, C, FONT_STACK, MONO_STACK, SHADOW, labelStyle,
} from '@/lib/design-tokens';
import type { TextLayerAttrs } from './editor-types';
import { ColorSwatchRow } from './color-swatches';
import { CloseIcon, PencilIcon } from './svg-icons';
import { TextControls } from './text-controls';

// Floating, closeable inspector pinned to the top-right (handoff §1.6). Its body is
// driven entirely by the selection:
//   text layer      → the type form (text-controls.tsx)
//   background      → "Canvas color" palette
//   any other layer → find & replace colours, one row per unique colour in the layer
//   nothing         → helper copy
// The ✕ deselects rather than unmounting the panel, exactly as specified.

// A colour edit is a *session*: the "from" colour is frozen while the native picker is
// open, so live dragging keeps replacing the same original colour (one undo entry,
// applied from one baseline) instead of chasing the colour it just wrote. The row list
// is frozen alongside it so React doesn't unmount the row — and with it the open
// picker — the instant the underlying colour changes.
function useColorEdit(colors: string[], onReplaceColor: (from: string, to: string) => void, onEndColorEdit: () => void) {
  const [session, setSession] = useState<{ from: string; to: string; frozen: string[] } | null>(null);

  const begin = useCallback((from: string) => {
    setSession({ from, to: from, frozen: colors });
  }, [colors]);

  const change = useCallback((from: string, to: string) => {
    setSession((cur) => (cur && cur.from === from ? { ...cur, to } : { from, to, frozen: colors }));
    onReplaceColor(from, to);
  }, [colors, onReplaceColor]);

  const end = useCallback(() => {
    setSession(null);
    onEndColorEdit();
  }, [onEndColorEdit]);

  const rows = session ? session.frozen : colors;
  const shown = (c: string) => (session && session.from === c ? session.to : c);

  return { rows, shown, begin, change, end };
}

function InspectorTitle(selectedTextProps: SelectedTextProps | null, isBackground: boolean, hasLayer: boolean) {
  if (selectedTextProps) return 'Editing text';
  if (isBackground) return 'Background';
  if (hasLayer) return 'Vector colours';
  return 'Nothing selected';
}

export const EditorInspector = React.memo(function EditorInspector({
  selectedLayer, isBackground, selectedTextProps, textContentRef, extraFonts, layerColors,
  onUpdateTextLayer, onCurvePointerDown, onCurvePointerUp,
  onReplaceColor, onEndColorEdit, onClose,
}: {
  selectedLayer: string | null;
  isBackground: boolean;
  selectedTextProps: SelectedTextProps | null;
  textContentRef: RefObject<HTMLInputElement | null>;
  extraFonts: string[];
  layerColors: string[];
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
  onCurvePointerDown: () => number | null;
  onCurvePointerUp: (startCenterY: number) => void;
  onReplaceColor: (from: string, to: string) => void;
  onEndColorEdit: () => void;
  onClose: () => void;
}) {
  const { rows, shown, begin, change, end } = useColorEdit(layerColors, onReplaceColor, onEndColorEdit);
  const title = InspectorTitle(selectedTextProps, isBackground, !!selectedLayer);
  const canvasColor = rows[0] ?? '';

  return (
    <div
      className="ed-scroll"
      style={{
        position: 'absolute',
        top: 76,
        right: 16,
        width: 252,
        zIndex: 15,
        background: C.surface,
        border: `1px solid ${C.borderPanel}`,
        borderRadius: 12,
        boxShadow: SHADOW.inspector,
        maxHeight: 'calc(100vh - 200px)',
        overflowY: 'auto',
        // Deliberate: removes a stray horizontal scrollbar the swatch rows could induce.
        overflowX: 'hidden',
        fontFamily: FONT_STACK,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px 10px' }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.textPrimary, flex: 1 }}>{title}</span>
        <button
          type="button"
          className="ed-ghost"
          onClick={onClose}
          title="Deselect"
          style={{
            border: 'none', background: 'transparent', color: C.textFaint,
            padding: 2, borderRadius: 6, cursor: 'pointer', display: 'flex',
          }}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      <div style={{ padding: '0 14px 14px' }}>
        {selectedTextProps ? (
          <TextControls
            selectedTextProps={selectedTextProps}
            textContentRef={textContentRef}
            extraFonts={extraFonts}
            onUpdateTextLayer={onUpdateTextLayer}
            onCurvePointerDown={onCurvePointerDown}
            onCurvePointerUp={onCurvePointerUp}
          />
        ) : isBackground ? (
          /* ── Canvas colour ─────────────────────────────────────────────── */
          <div>
            <label style={labelStyle}>Canvas color</label>
            {canvasColor ? (
              <ColorSwatchRow
                palette={BG_PALETTE}
                value={shown(canvasColor)}
                onPick={(c) => { begin(canvasColor); change(canvasColor, c); end(); }}
                onCustomInput={(c) => change(canvasColor, c)}
                onCustomPointerDown={() => begin(canvasColor)}
                onCustomBlur={end}
              />
            ) : (
              <p style={{ fontSize: 12, lineHeight: 1.6, color: C.textFaint, margin: 0 }}>
                This background has no fill colour to change.
              </p>
            )}
          </div>
        ) : selectedLayer ? (
          /* ── Find & replace colours ────────────────────────────────────── */
          <div>
            <label style={labelStyle}>Find &amp; replace colours</label>
            <p style={{ fontSize: 11, color: C.textFaint, margin: '0 0 8px', lineHeight: 1.5 }}>
              Click a colour to recolour every shape in the artwork that uses it.
            </p>
            {rows.length === 0 ? (
              <p style={{ fontSize: 12, lineHeight: 1.6, color: C.textFaint, margin: 0 }}>
                No colours detected on this layer.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map((c) => {
                  const value = shown(c);
                  return (
                    <label
                      key={c}
                      className="ed-row"
                      style={{
                        position: 'relative',
                        display: 'flex', alignItems: 'center', gap: 10,
                        border: `1px solid ${C.borderRow}`, borderRadius: 9,
                        padding: '6px 8px', cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          width: 22, height: 22, borderRadius: 6, flex: 'none', background: value,
                          border: value.toLowerCase() === '#ffffff' ? `1px solid ${C.borderInput}` : 'none',
                        }}
                      />
                      <span style={{ flex: 1, fontFamily: MONO_STACK, fontSize: 11, letterSpacing: '.3px', color: C.textSecondary }}>
                        {value.toUpperCase()}
                      </span>
                      <span style={{ color: C.textFaint, display: 'flex' }}>
                        <PencilIcon size={12} />
                      </span>
                      <input
                        type="color"
                        value={value}
                        onPointerDown={() => begin(c)}
                        onChange={(e) => change(c, e.target.value)}
                        onBlur={end}
                        style={{
                          position: 'absolute', inset: 0, width: '100%', height: '100%',
                          opacity: 0, border: 'none', padding: 0, cursor: 'pointer',
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* ── Nothing selected ──────────────────────────────────────────── */
          <p style={{ fontSize: 12, lineHeight: 1.6, color: C.textFaint, margin: 0 }}>
            Select a <strong style={{ color: C.textSecondary, fontWeight: 600 }}>text</strong> layer to edit type,
            the <strong style={{ color: C.textSecondary, fontWeight: 600 }}>artwork</strong> to swap its colours, or
            drag anything to move, resize and rotate it.
          </p>
        )}
      </div>
    </div>
  );
});
