import React, { RefObject } from 'react';

import type { SelectedTextProps } from '@/lib/svg-utils';
import { C, TEXT_PALETTE, inputStyle, labelStyle } from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import type { TextLayerAttrs } from './editor-types';
import { ColorSwatchRow } from './color-swatches';

// Inspector body for a selected text layer (handoff §1.6, "Text selected"): Words /
// Font / Size + Weight / Colour, plus this editor's two extra type controls
// (letter-spacing and curve) laid out in the same two-column row.
//
// Edits go straight to the document through onUpdateTextLayer — the "Words" field is
// live and deliberately does not push an undo entry per keystroke.

const FONTS = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Impact', 'Trebuchet MS'];

// Weight value → the key its name lives under. The numbers are CSS, the words are copy.
const WEIGHTS: Array<[number, string]> = [
  [400, 'text.weight400'],
  [500, 'text.weight500'],
  [700, 'text.weight700'],
  [800, 'text.weight800'],
];

const LETTER_SPACING = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3] as const;

const fieldRow: React.CSSProperties = { display: 'flex', gap: 10, marginBottom: 12 };

export const TextControls = React.memo(function TextControls({
  selectedTextProps, textContentRef, usedFonts, extraFonts,
  onUpdateTextLayer,
}: {
  selectedTextProps: SelectedTextProps;
  textContentRef: RefObject<HTMLInputElement | null>;
  // Faces this artwork's re-created text is actually set in.
  usedFonts: string[];
  // Faces the AI proposed for the artwork that nothing is using yet.
  extraFonts: string[];
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
}) {
  const t = useT();
  const curve = selectedTextProps.curve ?? 0;

  return (
    <div>
      {/* Words */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('text.words')}</label>
        <input
          ref={textContentRef}
          className="ed-input"
          type="text"
          value={selectedTextProps.content}
          onChange={(e) => onUpdateTextLayer({ content: e.target.value })}
          placeholder={t('text.wordsPlaceholder')}
          style={inputStyle}
        />
      </div>

      {/* Font */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('text.font')}</label>
        <select
          className="ed-input"
          value={selectedTextProps.font}
          onChange={(e) => onUpdateTextLayer({ font: e.target.value })}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          {/*
            Ordered by how much a face has earned its place, nearest first: what this
            artwork already uses, then what the AI proposed for it, then the standard
            stack. The built-ins were listed first for a long time, which buried the
            match the pass had just found under eight faces that had nothing to do with
            the design. Grouped as well as ordered, or the ordering communicates nothing —
            a bare list gives no way to tell a font in use from one merely offered.
          */}
          {usedFonts.length > 0 && (
            <optgroup label={t('text.groupInDesign')}>
              {usedFonts.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f} ✦</option>
              ))}
            </optgroup>
          )}
          {extraFonts.length > 0 && (
            <optgroup label={t('text.groupSuggested')}>
              {extraFonts.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f} ✦</option>
              ))}
            </optgroup>
          )}
          <optgroup label={t('text.groupStandard')}>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
            ))}
          </optgroup>
        </select>
      </div>

      {/* Size + Weight */}
      <div style={fieldRow}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>{t('text.size')}</label>
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
          <label style={labelStyle}>{t('text.weight')}</label>
          <select
            className="ed-input"
            value={selectedTextProps.weight}
            onChange={(e) => onUpdateTextLayer({ weight: Number(e.target.value) })}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {WEIGHTS.map(([value, labelKey]) => (
              <option key={value} value={value}>{t(labelKey)}</option>
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
        <label style={labelStyle}>{t('text.color')}</label>
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
          <label style={labelStyle}>{t('text.spacing')}</label>
          <select
            className="ed-input"
            value={selectedTextProps.letterSpacing}
            onChange={(e) => onUpdateTextLayer({ letterSpacing: Number(e.target.value) })}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {LETTER_SPACING.map((v) => (
              <option key={v} value={v}>
                {v === 0
                  ? t('text.spacingNormal')
                  : v < 0
                  ? t('text.spacingTight', { value: v })
                  : t('text.spacingLoose', { value: v })}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>{t('text.curve')} <span style={{ color: C.textFaint }}>{curve}</span></label>
          <input
            type="range"
            min={-100}
            max={100}
            step={5}
            value={curve}
            onChange={(e) => onUpdateTextLayer({ curve: Number(e.target.value) })}
            style={{ width: '100%', accentColor: C.accent, marginTop: 9 }}
          />
        </div>
      </div>
    </div>
  );
});
