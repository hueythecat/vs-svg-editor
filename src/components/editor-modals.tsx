import React from 'react';
import { SparklesIcon } from './svg-icons';

// Presentational, memoised modal overlays lifted out of the SvgDropZone render.
// Each returns null when closed, so the parent can mount them unconditionally.
// Inline styles (not NativeWind) so they render regardless of the Tailwind build.

const backdropStyle = (zIndex: number): React.CSSProperties => ({
  position: 'fixed', inset: 0, zIndex,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)',
});

// ── AI upsell (gated asset) ─────────────────────────────────────────────────
export const UpsellModal = React.memo(function UpsellModal({
  open, onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ ...backdropStyle(60), background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(2px)' }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420, maxWidth: '90vw',
          background: '#18181b', border: '1px solid #3f3f46', borderRadius: 14,
          padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SparklesIcon className="size-5 text-indigo-400" />
          <span style={{ fontSize: 17, fontWeight: 600, color: '#fafafa' }}>Unlock AI editing</span>
        </div>
        <p style={{ fontSize: 13.5, lineHeight: 1.5, color: '#a1a1aa', margin: 0 }}>
          You need an active subscription or credits to use the AI features on this asset.
        </p>
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            padding: 14, borderRadius: 10,
            background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#818cf8' }}>
            AI features
          </span>
          {[
            ['Suggests fonts', 'Recommends Google Fonts that match the design’s style and mood.'],
            ['Converts text paths to editable text', 'Detects lettering baked into outlines and turns it back into real, editable text.'],
          ].map(([title, desc]) => (
            <div key={title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ marginTop: 2, flexShrink: 0, display: 'inline-flex' }}>
                <SparklesIcon className="size-4 text-indigo-400" />
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e4e4e7' }}>{title}</span>
                <span style={{ fontSize: 12, lineHeight: 1.45, color: '#a1a1aa' }}>{desc}</span>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 34, padding: '0 14px', borderRadius: 8,
              border: '1px solid #3f3f46', background: 'transparent',
              color: '#d4d4d8', fontSize: 13, cursor: 'pointer',
            }}
          >
            Maybe later
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 34, padding: '0 16px', borderRadius: 8, border: 'none',
              background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Upgrade
          </button>
        </div>
      </div>
    </div>
  );
});

// ── Export satisfaction / rating ────────────────────────────────────────────
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
  return (
    <div onClick={onCancel} style={backdropStyle(50)}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 352, maxWidth: '90vw',
          borderRadius: 12, border: '1px solid #27272a',
          background: '#18181b', padding: 24,
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        }}
      >
        <h2 style={{ textAlign: 'center', fontSize: 16, fontWeight: 600, color: '#f4f4f5', margin: 0 }}>
          How satisfied are you?
        </h2>
        <p style={{ marginTop: 4, textAlign: 'center', fontSize: 12, color: '#a1a1aa' }}>
          Rate your experience before exporting.
        </p>

        <div
          onMouseLeave={() => onHover(0)}
          style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          {[1, 2, 3, 4, 5].map((star) => {
            const active = star <= (hover || rating);
            return (
              <button
                key={star}
                type="button"
                aria-label={`${star} star${star > 1 ? 's' : ''}`}
                onMouseEnter={() => onHover(star)}
                onClick={() => onRate(star)}
                style={{
                  background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                  lineHeight: 0, transform: active ? 'scale(1.06)' : 'scale(1)',
                  transition: 'transform 0.1s',
                }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width={32} height={32}
                  viewBox="0 0 24 24"
                  fill={active ? '#fbbf24' : 'none'}
                  stroke={active ? '#fbbf24' : '#52525b'}
                  strokeWidth={1.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5a.562.562 0 0 1 1.04 0l2.125 5.11a.563.563 0 0 0 .475.346l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
                </svg>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              height: 32, borderRadius: 6, border: '1px solid #3f3f46',
              padding: '0 12px', fontSize: 12, fontWeight: 500,
              color: '#d4d4d8', background: 'transparent', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={rating === 1 ? onAbort : onSubmit}
            disabled={rating < 1}
            style={{
              height: 32, borderRadius: 6, border: 'none',
              padding: '0 12px', fontSize: 12, fontWeight: 500, color: '#fff',
              background: rating === 1 ? '#dc2626' : '#2563eb',
              opacity: rating < 1 ? 0.4 : 1,
              cursor: rating < 1 ? 'not-allowed' : 'pointer',
            }}
          >
            {rating === 1 ? 'Abort Project' : 'Submit & Export'}
          </button>
        </div>
      </div>
    </div>
  );
});

// ── Abort reason (one-star path) ────────────────────────────────────────────
export const AbortReasonModal = React.memo(function AbortReasonModal({
  open, reasons, selected, onSelect, onBack, onConfirm,
}: {
  open: boolean;
  reasons: readonly string[];
  selected: string | null;
  onSelect: (reason: string) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div onClick={onBack} style={backdropStyle(60)}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, maxWidth: '90vw',
          borderRadius: 12, border: '1px solid #27272a',
          background: '#18181b', padding: 24,
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        }}
      >
        <h2 style={{ textAlign: 'center', fontSize: 16, fontWeight: 600, color: '#f4f4f5', margin: 0 }}>
          Why are you aborting?
        </h2>
        <p style={{ marginTop: 4, textAlign: 'center', fontSize: 12, color: '#a1a1aa' }}>
          Tell us what went wrong. This closes the current project.
        </p>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {reasons.map((reason) => {
            const isSelected = selected === reason;
            return (
              <button
                key={reason}
                type="button"
                onClick={() => onSelect(reason)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  textAlign: 'left', width: '100%',
                  height: 40, padding: '0 12px', borderRadius: 8,
                  border: `1px solid ${isSelected ? '#dc2626' : '#3f3f46'}`,
                  background: isSelected ? 'rgba(220,38,38,0.12)' : 'transparent',
                  color: isSelected ? '#fca5a5' : '#d4d4d8',
                  fontSize: 13, cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${isSelected ? '#dc2626' : '#52525b'}`,
                    background: isSelected ? '#dc2626' : 'transparent',
                    boxShadow: isSelected ? 'inset 0 0 0 2px #18181b' : 'none',
                  }}
                />
                {reason}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              height: 32, borderRadius: 6, border: '1px solid #3f3f46',
              padding: '0 12px', fontSize: 12, fontWeight: 500,
              color: '#d4d4d8', background: 'transparent', cursor: 'pointer',
            }}
          >
            Back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!selected}
            style={{
              height: 32, borderRadius: 6, border: 'none',
              padding: '0 12px', fontSize: 12, fontWeight: 500, color: '#fff',
              background: '#dc2626',
              opacity: selected ? 1 : 0.4,
              cursor: selected ? 'pointer' : 'not-allowed',
            }}
          >
            Abort Project
          </button>
        </div>
      </div>
    </div>
  );
});
