import React from 'react';

import { C, FONT_STACK, SHADOW, sectionLabelStyle } from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import { CloseIcon, SparklesIcon } from './svg-icons';

// The "Font suggestions" strip (vision-model font picks). Memoised; returns null when
// closed. The toggle/apply logic stays in the parent behind onSelectFont, so this
// component is purely presentational.
//
// The design has no docked chrome, so the strip floats directly under the toolbar
// rather than sitting in a column.
export const FontSuggestions = React.memo(function FontSuggestions({
  open, onClose, loading, fonts, selectedFont, onSelectFont, onAddFont,
}: {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  fonts: { font: string; reason: string }[] | null;
  selectedFont: string | null;
  onSelectFont: (font: string) => void;
  onAddFont: (font: string) => void;
}) {
  const t = useT();
  if (!open) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 76,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 18,
        width: 360,
        maxWidth: 'calc(100vw - 32px)',
        background: C.surface,
        border: `1px solid ${C.borderPanel}`,
        borderRadius: 12,
        boxShadow: SHADOW.toolbar,
        padding: '11px 12px 12px',
        fontFamily: FONT_STACK,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ color: C.accent, display: 'flex' }}><SparklesIcon size={12} /></span>
        <span style={{ ...sectionLabelStyle, flex: 1 }}>{t('fonts.title')}</span>
        <button
          type="button"
          className="ed-ghost"
          onClick={onClose}
          title={t('fonts.close')}
          style={{ border: 'none', background: 'transparent', color: C.textFaint, padding: 2, borderRadius: 6, cursor: 'pointer', display: 'flex' }}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 12, height: 12, borderRadius: '50%', flex: 'none',
              border: `2px solid ${C.borderInput}`, borderTopColor: C.accent,
              animation: 'ed-spin .8s linear infinite',
            }}
          />
          <span style={{ fontSize: 12, color: C.textMuted }}>{t('fonts.analysing')}</span>
        </div>
      )}

      {fonts && fonts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {fonts.map(({ font, reason }) => {
            const isSelected = selectedFont === font;
            return (
              <div
                key={font}
                title={reason}
                onClick={() => onSelectFont(font)}
                className={isSelected ? 'ed-row-selected' : 'ed-row'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 9px', borderRadius: 9, cursor: 'pointer',
                  border: `1px solid ${isSelected ? C.accentTintBorder : C.borderRow}`,
                  background: isSelected ? C.accentTint : 'transparent',
                }}
              >
                <span style={{ fontSize: 12.5, color: C.textBody, fontFamily: font }}>{font}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAddFont(font); }}
                  title={t('fonts.add')}
                  style={{
                    border: 'none', background: 'transparent', cursor: 'pointer',
                    color: isSelected ? C.accent : C.textFaint, fontSize: 13, lineHeight: 1, padding: 0,
                  }}
                >
                  +
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
