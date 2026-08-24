import React from 'react';

import { C, swatchStyle } from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';

// The design's colour picker (handoff §1.6): a wrapping row of 24×24 palette swatches
// plus a dashed "+" tile wrapping a full-bleed, invisible <input type="color"> for
// anything off-palette. Deliberately the whole picker — no eyedropper, no hex field.
//
// Used by both the text colour and the canvas colour, which are the same control over
// different palettes.
export const ColorSwatchRow = React.memo(function ColorSwatchRow({
  palette, value, onPick, onCustomInput, onCustomPointerDown, onCustomBlur,
}: {
  palette: readonly string[];
  value: string;
  onPick: (color: string) => void;
  onCustomInput: (color: string) => void;
  onCustomPointerDown?: () => void;
  onCustomBlur?: () => void;
}) {
  const t = useT();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {palette.map((c) => (
        <span
          key={c}
          title={c}
          onClick={() => onPick(c)}
          style={swatchStyle(c, value.toLowerCase() === c.toLowerCase())}
        />
      ))}
      <label
        title={t('inspector.customColour')}
        style={{
          position: 'relative',
          width: 24, height: 24, borderRadius: 6, flex: 'none',
          border: `1px dashed ${C.disabled}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: C.textFaint, fontSize: 13, lineHeight: 1, cursor: 'pointer',
        }}
      >
        +
        <input
          type="color"
          value={value || '#000000'}
          onPointerDown={onCustomPointerDown}
          onChange={(e) => onCustomInput(e.target.value)}
          onBlur={onCustomBlur}
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', border: 'none', padding: 0 }}
        />
      </label>
    </div>
  );
});
