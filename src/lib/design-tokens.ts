// Design tokens for the RocketJet editor UI — the exact values from the handoff in
// assets/UI/design_handoff_vector_editor/README.md.
//
// These are plain objects consumed as inline `style={{}}` props, NOT Tailwind /
// NativeWind classes: the generated stylesheet only contains utilities that existed
// at build time, so brand-new arbitrary classes render unstyled until a full rebuild.
// Anything that inline styles genuinely can't express (:hover, :focus, ::placeholder,
// scrollbars) lives in EDITOR_CSS below and is mounted once from the editor root.

import type React from 'react';

// ─── Colours ─────────────────────────────────────────────────────────────────

export const C = {
  appBg:        '#eef0f3',
  surface:      '#ffffff',
  textPrimary:  '#1b1f24',
  textBody:     '#374151',
  textSecondary:'#4b5563',
  textMuted:    '#6b7280',
  textFaint:    '#9aa1ab',
  disabled:     '#c3c9d2',
  disabledIcon: '#d3d7dd',
  textHidden:   '#b6bcc6',

  accent:       '#5b6cff',
  accentHover:  '#4453d6',
  accentGrad:   'linear-gradient(90deg,#5b6cff,#8f6bff)',
  accentGradDiag:'linear-gradient(135deg,#5b6cff,#8f6bff)',
  accentTint:   '#eef0ff',
  accentTintAlt:'#f4f6ff',
  accentTintBorder: '#d7dcff',
  focusRing:    'rgba(91,108,255,.15)',

  borderPanel:  '#e6e8eb',
  borderInput:  '#d7dbe1',
  borderRow:    '#eceef2',
  rowHover:     '#f2f4f7',

  danger:       '#e0575b',
  dangerText:   '#c94146',
  dangerBg:     '#fff5f5',
  dangerBorder: '#f7d7d8',
  dangerOnTint: '#8a3d40',

  star:         '#f2b03e',
  starEmpty:    '#dfe3e9',

  devSurface:   '#181b20',
  devSurfaceAlt:'#22262e',
  devBorder:    'rgba(255,255,255,.08)',
  devText:      '#c8ccd4',
  devTextMuted: '#9aa0ab',
  devTextFaint: '#7c828e',
  devTextDim:   '#5b616d',
  devAccent:    '#f2b03e',

  backdropRating: 'rgba(16,19,24,.42)',
  backdropAi:     'rgba(16,19,24,.46)',
  backdropReasons:'rgba(16,19,24,.5)',
} as const;

// ─── Shadows ─────────────────────────────────────────────────────────────────

export const SHADOW = {
  board:     '0 16px 44px rgba(0,0,0,.16)',
  toolbar:   '0 10px 30px rgba(0,0,0,.12)',
  inspector: '0 16px 40px rgba(0,0,0,.15)',
  layers:    '0 10px 30px rgba(0,0,0,.14)',
  devPanel:  '0 10px 30px rgba(0,0,0,.28)',
  devPill:   '0 6px 18px rgba(0,0,0,.25)',
  modal:     '0 24px 60px rgba(0,0,0,.3)',
  modalSoft: '0 24px 60px rgba(0,0,0,.28)',
  aiPill:    '0 10px 26px rgba(91,108,255,.35)',
  handle:    '0 2px 6px rgba(0,0,0,.18)',
  handleSoft:'0 2px 6px rgba(0,0,0,.12)',
} as const;

// ─── Typography ──────────────────────────────────────────────────────────────

export const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
export const MONO_STACK = 'ui-monospace, monospace';

// ─── Palettes ────────────────────────────────────────────────────────────────

export const TEXT_PALETTE = ['#1f6fd6', '#f2802e', '#111111', '#12b76a', '#e0575b', '#8f6bff'];
export const BG_PALETTE   = ['#ffffff', '#111111', '#eef0f3', '#fff4e6', '#0b2a4a'];

// ─── Shared style objects ────────────────────────────────────────────────────

export const panelStyle: React.CSSProperties = {
  position: 'absolute',
  background: C.surface,
  border: `1px solid ${C.borderPanel}`,
  borderRadius: 12,
  fontFamily: FONT_STACK,
};

// Field label — 11px muted, sits above every input.
export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: C.textMuted,
  marginBottom: 6,
};

// Caps section label (ELEMENTS, AI FEATURES, SAMPLES …).
export const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '.5px',
  color: C.textFaint,
  textTransform: 'uppercase',
};

// Text input / select / textarea. Focus ring comes from `.ed-input:focus` in EDITOR_CSS.
export const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${C.borderInput}`,
  borderRadius: 8,
  padding: '9px 10px',
  fontSize: 13,
  fontFamily: FONT_STACK,
  color: C.textPrimary,
  background: C.surface,
  outline: 'none',
};

// Ghost text button (Maybe later, Cancel, Back). Hover from `.ed-ghost:hover`.
export const ghostButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: C.textMuted,
  fontSize: 12.5,
  fontFamily: FONT_STACK,
  padding: '9px 12px',
  borderRadius: 8,
  cursor: 'pointer',
};

export const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  background: C.accent,
  color: '#fff',
  fontSize: 12.5,
  fontWeight: 700,
  fontFamily: FONT_STACK,
  padding: '9px 17px',
  borderRadius: 8,
  cursor: 'pointer',
};

// Small toolbar / row button (Center, 90°, icon buttons). Hover from `.ed-ghost:hover`.
export const toolButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  border: 'none',
  background: 'transparent',
  color: C.textSecondary,
  fontSize: 12.5,
  fontFamily: FONT_STACK,
  padding: '6px 9px',
  borderRadius: 8,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

// Checkerboard shown on the board when the document has no opaque full-canvas
// background — i.e. the artwork is transparent, and a plain white board would be a lie
// about what exports.
export const checkerStyle = (square = 8): React.CSSProperties => ({
  backgroundColor: C.surface,
  backgroundImage: `
    linear-gradient(45deg, ${C.borderPanel} 25%, transparent 25%),
    linear-gradient(-45deg, ${C.borderPanel} 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, ${C.borderPanel} 75%),
    linear-gradient(-45deg, transparent 75%, ${C.borderPanel} 75%)`,
  backgroundSize: `${square * 2}px ${square * 2}px`,
  backgroundPosition: `0 0, 0 ${square}px, ${square}px -${square}px, -${square}px 0`,
});

// A 24×24 colour swatch used in the text / canvas palettes.
export const swatchStyle = (color: string, selected: boolean): React.CSSProperties => ({
  width: 24,
  height: 24,
  borderRadius: 6,
  background: color,
  border: color.toLowerCase() === '#ffffff' ? `1px solid ${C.borderInput}` : 'none',
  padding: 0,
  cursor: 'pointer',
  flex: 'none',
  outline: selected ? `2px solid ${C.accent}` : 'none',
  outlineOffset: 2,
});

// ─── Stateful CSS ────────────────────────────────────────────────────────────
// Mounted once from the editor root. Plain CSS (not Tailwind), so it is unaffected
// by the NativeWind build.

export const EDITOR_CSS = `
  .ed-input:focus,
  .ed-input:focus-visible {
    border-color: ${C.accent};
    box-shadow: 0 0 0 3px ${C.focusRing};
    outline: none;
  }
  .ed-input::placeholder { color: ${C.textFaint}; }
  .ed-ghost:hover:not(:disabled) { background: ${C.rowHover}; }
  .ed-ghost:disabled { cursor: default; }
  .ed-row:hover { background: ${C.rowHover}; }
  .ed-row-selected:hover { background: ${C.accentTint}; }
  .ed-link { color: ${C.accent}; }
  .ed-link:hover { color: ${C.accentHover}; }
  .ed-star { transition: color .12s, transform .12s; }
  .ed-star:hover { transform: scale(1.12); }
  .ed-dev-card:hover { border-color: ${C.devTextDim}; }
  .ed-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
  .ed-scroll::-webkit-scrollbar-thumb { background: ${C.borderInput}; border-radius: 4px; }
  .ed-scroll::-webkit-scrollbar-track { background: transparent; }
  @keyframes ed-spin { to { transform: rotate(360deg); } }
  /* The imported artwork fills the board's width — width:100% is what makes SVGs with
     no intrinsic dimensions scale at all — and its height follows the aspect ratio.
     Deliberately uncapped: the board width is already derived from the viewport height
     and the document's aspect (see editor-canvas.tsx), so nothing gets truncated. */
  .svg-canvas svg { display: block; width: 100%; height: auto; }
`;
