import React, { RefObject, useRef } from 'react';

import type { SelectedTextProps } from '@/lib/svg-utils';
import { C, TEXT_PALETTE, inputStyle, labelStyle } from '@/lib/design-tokens';
import type { TextLayerAttrs } from './editor-types';
import { ColorSwatchRow } from './color-swatches';

// Inspector body for a selected text layer (handoff §1.6, "Text selected"): Words /
// Font / Size + Weight / Colour, plus this editor's two extra type controls
// (letter-spacing and curve) laid out in the same two-column row.
//
// Edits go straight to the document through onUpdateTextLayer — the "Words" field is
// live and deliberately does not push an undo entry per keystroke.

const FONTS = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Impact', 'Trebuchet MS'];

const WEIGHTS: Array<[number, string]> = [
  [400, '400 Regular'],
  [500, '500 Medium'],
  [700, '700 Bold'],
  [800, '800 Black'],
];

const LETTER_SPACING = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3] as const;

const fieldRow: React.CSSProperties = { display: 'flex', gap: 10, marginBottom: 12 };

export const TextControls = React.memo(function TextControls({
  selectedTextProps, textContentRef, extraFonts,
  onUpdateTextLayer, onCurvePointerDown, onCurvePointerUp,
}: {
  selectedTextProps: SelectedTextProps;
  textContentRef: RefObject<HTMLInputElement | null>;
  extraFonts: string[];
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
  onCurvePointerDown: () => number | null;
  onCurvePointerUp: (startCenterY: number) => void;
}) {
  const curveStartCenterYRef = useRef<number | null>(null);
  const curve = selectedTextProps.curve ?? 0;

  return (
    <div>
      {/* Words */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Words</label>
        <input
          ref={textContentRef}
          className="ed-input"
          type="text"
          value={selectedTextProps.content}
          onChange={(e) => onUpdateTextLayer({ content: e.target.value })}
          placeholder="Type something…"
          style={inputStyle}
        />
      </div>

      {/* Font */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Font</label>
        <select
          className="ed-input"
          value={selectedTextProps.font}
          onChange={(e) => onUpdateTextLayer({ font: e.target.value })}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
          ))}
          {extraFonts.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>{f} ✦</option>
          ))}
        </select>
      </div>

      {/* Size + Weight */}
      <div style={fieldRow}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>Size</label>
          <input
            className="ed-input"
            type="number"
            min={1}
            max={999}
            value={selectedTextProps.size}
            onChange={(e) => onUpdateTextLayer({ size: Math.max(1, Number(e.target.value)) })}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>Weight</label>
          <select
            className="ed-input"
            value={selectedTextProps.weight}
            onChange={(e) => onUpdateTextLayer({ weight: Number(e.target.value) })}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {WEIGHTS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
            {/* Keep whatever the file already uses selectable even if it isn't a preset */}
            {!WEIGHTS.some(([w]) => w === selectedTextProps.weight) && (
              <option value={selectedTextProps.weight}>{selectedTextProps.weight}</option>
            )}
          </select>
        </div>
      </div>

      {/* Colour */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Color</label>
        <ColorSwatchRow
          palette={TEXT_PALETTE}
          value={selectedTextProps.color}
          onPick={(color) => onUpdateTextLayer({ color })}
          onCustomInput={(color) => onUpdateTextLayer({ color })}
        />
      </div>

      {/* Spacing + Curve — this editor's extras, in the same two-column rhythm */}
      <div style={fieldRow}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>Spacing</label>
          <select
            className="ed-input"
            value={selectedTextProps.letterSpacing}
            onChange={(e) => onUpdateTextLayer({ letterSpacing: Number(e.target.value) })}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {LETTER_SPACING.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? 'Normal' : v < 0 ? `Tight (${v}em)` : `+${v}em`}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>Curve <span style={{ color: C.textFaint }}>{curve}</span></label>
          <input
            type="range"
            min={-100}
            max={100}
            step={5}
            value={curve}
            onChange={(e) => onUpdateTextLayer({ curve: Number(e.target.value) })}
            onPointerDown={() => { curveStartCenterYRef.current = onCurvePointerDown(); }}
            onPointerUp={() => {
              if (curveStartCenterYRef.current !== null) {
                onCurvePointerUp(curveStartCenterYRef.current);
                curveStartCenterYRef.current = null;
              }
            }}
            style={{ width: '100%', accentColor: C.accent, marginTop: 9 }}
          />
        </div>
      </div>
    </div>
  );
});
