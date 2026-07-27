import React from 'react';

import {
  C, FONT_STACK, SHADOW, ghostButtonStyle, inputStyle, primaryButtonStyle, sectionLabelStyle,
} from '@/lib/design-tokens';
import { CheckIcon, CloseIcon, SparklesIcon } from './svg-icons';

// The three modal overlays (handoff §2–§4). Each returns null when closed, so the
// parent can mount them unconditionally. Presentational and memoised: all state lives
// in the parent.

const backdrop = (zIndex: number, background: string): React.CSSProperties => ({
  position: 'fixed', inset: 0, zIndex,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background,
  fontFamily: FONT_STACK,
});

const card = (width: number): React.CSSProperties => ({
  width, maxWidth: '90vw',
  background: C.surface,
  borderRadius: 14,
  boxShadow: SHADOW.modal,
});

const titleStyle: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: C.textPrimary, margin: 0 };
const subCopyStyle: React.CSSProperties = { fontSize: 12.5, color: C.textMuted, lineHeight: 1.55, margin: '6px 0 0' };
const footerStyle: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 };

const AI_FEATURES: Array<[string, string]> = [
  ['Suggests fonts', 'Recommends Google Fonts that match the design’s style and mood.'],
  ['Converts text paths to editable text', 'Detects lettering baked into outlines and turns it back into real, editable text.'],
];

// ── Unlock AI editing (§2) ───────────────────────────────────────────────────
export const UpsellModal = React.memo(function UpsellModal({
  open, onClose, onUpgrade,
}: {
  open: boolean;
  onClose: () => void;
  onUpgrade?: () => void;
}) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={backdrop(80, C.backdropAi)}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card(376), overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 20px 0' }}>
          <span
            style={{
              width: 26, height: 26, borderRadius: 8, flex: 'none',
              background: C.accentGradDiag, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <SparklesIcon size={14} />
          </span>
          <h2 style={{ ...titleStyle, flex: 1 }}>Unlock AI editing</h2>
          <button
            type="button"
            className="ed-ghost"
            onClick={onClose}
            title="Close"
            style={{ border: 'none', background: 'transparent', color: C.textFaint, padding: 2, borderRadius: 6, cursor: 'pointer', display: 'flex' }}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <div style={{ padding: '0 20px 18px' }}>
          <p style={{ ...subCopyStyle, margin: '10px 0 0' }}>
            You need an active subscription or credits to use the AI features on this asset.
          </p>

          <span style={{ ...sectionLabelStyle, display: 'block', margin: '16px 0 8px' }}>AI features</span>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {AI_FEATURES.map(([title, desc]) => (
              <div
                key={title}
                style={{
                  display: 'flex', gap: 11, alignItems: 'flex-start',
                  border: `1px solid ${C.borderRow}`, borderRadius: 10, padding: 12,
                }}
              >
                <span style={{ color: C.accent, flex: 'none', display: 'flex', marginTop: 1 }}>
                  <SparklesIcon size={14} />
                </span>
                <div>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.textPrimary }}>{title}</span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>{desc}</span>
                </div>
              </div>
            ))}
          </div>

          <div style={{ ...footerStyle, marginTop: 16 }}>
            <button type="button" className="ed-ghost" onClick={onClose} style={ghostButtonStyle}>
              Maybe later
            </button>
            <button
              type="button"
              onClick={onUpgrade ?? onClose}
              style={{ ...primaryButtonStyle, background: C.accentGrad }}
            >
              Upgrade to unlock
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

// ── Confirmation ─────────────────────────────────────────────────────────────
// In-app confirm, styled like the overlays above. Not window.confirm(): a native
// dialog blocks the page, can't be styled, and reads as a browser error rather than
// part of the editor.
export const ConfirmModal = React.memo(function ConfirmModal({
  open, title, body, confirmLabel, danger, onCancel, onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div onClick={onCancel} style={backdrop(65, C.backdropRating)}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card(330), boxShadow: SHADOW.modalSoft, padding: '22px 22px 18px' }}
      >
        <h2 style={titleStyle}>{title}</h2>
        <p style={subCopyStyle}>{body}</p>
        <div style={{ ...footerStyle, marginTop: 18 }}>
          <button type="button" className="ed-ghost" onClick={onCancel} style={ghostButtonStyle}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            style={{
              ...primaryButtonStyle,
              background: danger ? C.danger : C.accent,
              padding: '8px 16px',
              fontWeight: 600,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
});

// ── Export rating (§3) ───────────────────────────────────────────────────────
// The SVG is generated but NOT downloaded when this opens — this modal gates the
// download, which only fires from "Send rating & download".
export const RatingModal = React.memo(function RatingModal({
  open, rating, hover, onHover, onRate, onCancel, onSubmit, onAbort,
}: {
  open: boolean;
  rating: number;
  hover: number;
  onHover: (n: number) => void;
  onRate: (n: number) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onAbort: () => void;
}) {
  if (!open) return null;
  const filledTo = Math.max(hover, rating);
  return (
    <div onClick={onCancel} style={backdrop(60, C.backdropRating)}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card(330), boxShadow: SHADOW.modalSoft, padding: '22px 22px 18px' }}
      >
        <h2 style={titleStyle}>How did that export go?</h2>
        <p style={subCopyStyle}>Rate it and we&rsquo;ll start your download.</p>

        <div
          onMouseLeave={() => onHover(0)}
          style={{ display: 'flex', justifyContent: 'center', gap: 6, margin: '18px 0 4px' }}
        >
          {[1, 2, 3, 4, 5].map((star) => (
            <span
              key={star}
              className="ed-star"
              title={`${star} of 5`}
              onMouseEnter={() => onHover(star)}
              onClick={() => onRate(star)}
              style={{
                fontSize: 29,
                lineHeight: 1,
                cursor: 'pointer',
                color: star <= filledTo ? C.star : C.starEmpty,
              }}
            >
              ★
            </span>
          ))}
        </div>

        {/* One star opens the abandon path before anything downloads */}
        {rating === 1 && (
          <div
            style={{
              marginTop: 14, padding: '11px 12px', borderRadius: 10,
              background: C.dangerBg, border: `1px solid ${C.dangerBorder}`,
            }}
          >
            <p style={{ margin: 0, fontSize: 12.5, color: C.dangerOnTint, lineHeight: 1.5 }}>
              Sorry that missed the mark. You can abandon this export before it downloads and tell us why.
            </p>
            <button
              type="button"
              onClick={onAbort}
              style={{
                marginTop: 10,
                background: C.surface, border: `1px solid ${C.danger}`, color: C.dangerText,
                fontSize: 12.5, fontWeight: 600, fontFamily: FONT_STACK,
                padding: '8px 13px', borderRadius: 8, cursor: 'pointer',
              }}
            >
              Abandon export
            </button>
          </div>
        )}

        <div style={{ ...footerStyle, marginTop: 18 }}>
          <button type="button" className="ed-ghost" onClick={onCancel} style={ghostButtonStyle}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { if (rating >= 1) onSubmit(); }}
            style={{
              ...primaryButtonStyle,
              background: rating >= 1 ? C.accent : C.disabled,
              cursor: rating >= 1 ? 'pointer' : 'default',
            }}
          >
            Send rating &amp; download
          </button>
        </div>
      </div>
    </div>
  );
});

// ── Reasons for cancelling (§4) ──────────────────────────────────────────────
// Multi-select. Sending discards the pending file — no download happens on this path.
export const AbortReasonModal = React.memo(function AbortReasonModal({
  open, reasons, selected, note, onToggle, onNote, onBack, onConfirm,
}: {
  open: boolean;
  reasons: readonly string[];
  selected: readonly string[];
  note: string;
  onToggle: (reason: string) => void;
  onNote: (note: string) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div onClick={onBack} style={backdrop(70, C.backdropReasons)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="ed-scroll"
        style={{ ...card(352), padding: '22px 22px 18px', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <h2 style={titleStyle}>Why are you abandoning this export?</h2>
        <p style={subCopyStyle}>Pick anything that applies. It goes straight to the team.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
          {reasons.map((reason) => {
            const isSelected = selected.includes(reason);
            return (
              <label
                key={reason}
                className={isSelected ? 'ed-row-selected' : 'ed-row'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 9px', borderRadius: 9, cursor: 'pointer',
                  border: `1px solid ${isSelected ? C.accentTintBorder : C.borderRow}`,
                  background: isSelected ? C.accentTintAlt : 'transparent',
                }}
              >
                <span
                  style={{
                    width: 17, height: 17, borderRadius: 5, flex: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: isSelected ? C.accent : C.surface,
                    border: isSelected ? 'none' : '1px solid #cdd3db',
                    color: '#fff',
                  }}
                >
                  {isSelected && <CheckIcon size={11} />}
                </span>
                <span style={{ fontSize: 13, color: C.textBody }}>{reason}</span>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(reason)}
                  style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }}
                />
              </label>
            );
          })}
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: 'block', fontSize: 11, color: C.textMuted, marginBottom: 6 }}>
            Anything else? (optional)
          </label>
          <textarea
            className="ed-input"
            value={note}
            onChange={(e) => onNote(e.target.value)}
            placeholder="Tell us what happened…"
            style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }}
          />
        </div>

        <div style={{ ...footerStyle, marginTop: 16 }}>
          <button type="button" className="ed-ghost" onClick={onBack} style={ghostButtonStyle}>
            Back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ ...primaryButtonStyle, background: C.danger, padding: '8px 16px', fontWeight: 600 }}
          >
            Abandon &amp; send
          </button>
        </div>
      </div>
    </div>
  );
});
