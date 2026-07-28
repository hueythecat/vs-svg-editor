import React, { useState } from 'react';

import { C, FONT_STACK, SHADOW } from '@/lib/design-tokens';
import { ChevronIcon, SettingsIcon } from './svg-icons';

type Sample = { label: string; name: string; src: string; edit?: 0 | 1 };

// Custom drag MIME so a preview dragged onto the canvas can be told apart from an OS
// file drop. The drop handler in svg-drop-zone reads this same key.
export const SAMPLE_DRAG_MIME = 'application/x-svg-sample';

// Dev-only: the zip bundles sitting in assets/downloads. Each is a vectorstock asset
// (the number is the id in vectorstock_<id>.zip); names are the titles from
// vectorstock.com. Selecting one calls /api/download, which extracts the SVG from the
// archive and hands it back for preview.
// edit: 1 = editable, 0 = not — flag per item (defaults to 1 here; flip individually).
const DOWNLOADS: ReadonlyArray<{ id: string; name: string; edit: 0 | 1 }> = [
  { id: '10383776', name: 'Circular Monogram Logo Emblem',      edit: 1 },
  { id: '16303184', name: 'Abstract Logo with Circles & Letters', edit: 1 },
  { id: '21513865', name: 'Skyscraper Logo & Real Estate Symbol', edit: 1 },
  { id: '26162964', name: 'Colorful Deer Emblem Logo',           edit: 1 },
  { id: '4505328',  name: 'Elegant Restaurant Logo Pattern',     edit: 0 },
];

// The internal/dev affordance from the handoff §1.4 — deliberately dark so it never
// reads as user UI, collapsing to a small pill at the top-left of the canvas.

interface DevRailProps<S extends Sample> {
  samples: ReadonlyArray<S>;
  activeSample: string | null;
  isLoading: boolean;
  onOpenSample: (sample: S) => void;
  // Opens a download that was fetched and extracted at runtime (src is a data: URI).
  onOpenFetched?: (sample: Sample) => void;
}

export function DevRail<S extends Sample>({ samples, activeSample, isLoading, onOpenSample, onOpenFetched }: DevRailProps<S>) {
  const [open, setOpen] = useState(false);
  const [selectedDownload, setSelectedDownload] = useState<string>('');
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchedSamples, setFetchedSamples] = useState<Sample[]>([]);

  const fetchDownload = async (id: string, title: string, edit: 0 | 1) => {
    setFetchStatus(null);
    setFetching(true);
    try {
      // Placeholder API pacing: hold the "Fetching asset" overlay for at least 1s so
      // the request reads as a deliberate step rather than an instant flash. Runs the
      // real fetch and the delay together, so the overlay lasts max(1s, fetch time).
      const [res] = await Promise.all([
        fetch(`/api/download?id=${encodeURIComponent(id)}`),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
      const data = (await res.json()) as { svg?: string | null; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? `Request failed (${res.status})`);

      if (!data.svg) {
        setFetchStatus('No SVG');
        return;
      }
      // Inline the extracted SVG as a data: URI so it both previews in an <img> and
      // reloads via fetch().text() when opened, exactly like a static sample src.
      const src = `data:image/svg+xml,${encodeURIComponent(data.svg)}`;
      const name = `vectorstock_${id}.svg`;
      const sample: Sample = { label: title, name, src, edit };
      // Prepend so the newest extraction sits at the top of the previews. De-dupe by
      // name so re-selecting the same id refreshes rather than stacking duplicates.
      setFetchedSamples((prev) => [sample, ...prev.filter((s) => s.name !== name)]);
      setFetchStatus(null);
      // Picking from the select opens the asset straight away — the preview card is
      // there to come back to, not a second step before you can see it.
      onOpenFetched?.(sample);
    } catch (err) {
      setFetchStatus(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setFetching(false);
    }
  };

  const renderCard = (sample: Sample, onOpen: () => void) => {
    const isActive = activeSample === sample.name;
    return (
      <button
        key={sample.name}
        type="button"
        onClick={onOpen}
        disabled={isLoading}
        // Dragging the preview onto the canvas opens it. draggable sits on the button
        // so the whole tile is the drag handle; the payload is read back in handleDrop.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SAMPLE_DRAG_MIME, JSON.stringify(sample));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        className="ed-dev-card"
        style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          padding: 5, borderRadius: 8, textAlign: 'left',
          background: C.devSurfaceAlt,
          border: isActive ? `1.5px solid ${C.accent}` : '1.5px solid transparent',
          cursor: isLoading ? 'wait' : 'pointer',
          opacity: isLoading ? 0.5 : 1,
          fontFamily: FONT_STACK,
        }}
      >
        <span
          style={{
            height: 48, borderRadius: 5, overflow: 'hidden',
            background: 'repeating-linear-gradient(45deg, #2b3038 0 4px, #22262e 4px 8px)',
            display: 'block',
          }}
        >
          <img
            src={sample.src}
            alt={sample.label}
            // Suppress the native image drag so only the button's drag fires (carrying
            // our custom payload rather than the image URL).
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4, boxSizing: 'border-box' }}
          />
        </span>
        <span
          style={{
            fontSize: 10, lineHeight: 1.2,
            color: isActive ? '#8f9bff' : C.devTextMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {sample.label}
        </span>
      </button>
    );
  };

  return (
    <>
      {/* Full-viewport "Fetching asset" overlay shown while a download is being pulled. */}
      {fetching && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
            background: 'rgba(16,19,24,.46)', backdropFilter: 'blur(2px)',
          }}
        >
          <div
            style={{
              width: 34, height: 34, borderRadius: '50%',
              border: `3px solid ${C.borderInput}`, borderTopColor: C.accent,
              animation: 'ed-spin .8s linear infinite',
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', fontFamily: FONT_STACK }}>Fetching asset…</span>
        </div>
      )}

      {open ? (
        <div
          style={{
            position: 'absolute', top: 16, left: 16, zIndex: 30, width: 198,
            background: C.devSurface, borderRadius: 12,
            boxShadow: SHADOW.devPanel,
            fontFamily: FONT_STACK,
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '11px 12px 8px' }}>
            <span style={{ color: C.devAccent, display: 'flex' }}><SettingsIcon size={11} /></span>
            <span style={{ flex: 1, fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: C.devAccent }}>
              DEV — DOWNLOADS
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Collapse"
              style={{ border: 'none', background: 'transparent', color: C.devTextFaint, padding: 0, cursor: 'pointer', display: 'flex' }}
            >
              <ChevronIcon size={12} direction="left" />
            </button>
          </div>

          {/* Downloads select */}
          <div style={{ padding: '0 12px 10px' }}>
            <select
              value={selectedDownload}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedDownload(id);
                const picked = DOWNLOADS.find((d) => d.id === id);
                if (picked) fetchDownload(picked.id, picked.name, picked.edit);
              }}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: C.devSurfaceAlt, color: C.devText,
                border: `1px solid ${C.devBorder}`, borderRadius: 7,
                fontSize: 11, padding: '6px 7px', outline: 'none', cursor: 'pointer',
                fontFamily: FONT_STACK,
              }}
            >
              <option value="">Select a vector…</option>
              {DOWNLOADS.map((d) => (
                <option key={d.id} value={d.id}>{d.id} — {d.name}</option>
              ))}
            </select>
            {fetchStatus && (
              <span style={{ display: 'block', marginTop: 5, fontSize: 10, color: C.devTextMuted, lineHeight: 1.3 }}>
                {fetchStatus}
              </span>
            )}
          </div>

          {/* Samples */}
          <div style={{ padding: '0 12px 4px' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: C.devTextDim }}>SAMPLES</span>
          </div>
          <div
            className="ed-scroll"
            style={{
              maxHeight: 150, overflowY: 'auto', overflowX: 'hidden',
              padding: '6px 12px 12px',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}
          >
            {fetchedSamples.map((sample) => renderCard(sample, () => onOpenFetched?.(sample)))}
            {samples.map((sample) => renderCard(sample, () => onOpenSample(sample)))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Dev tools"
          style={{
            position: 'absolute', top: 16, left: 16, zIndex: 30,
            display: 'flex', alignItems: 'center', gap: 6,
            background: C.devSurface, border: 'none', borderRadius: 10,
            padding: '8px 11px', boxShadow: SHADOW.devPill, cursor: 'pointer',
            fontFamily: FONT_STACK,
          }}
        >
          <span style={{ color: C.devAccent, display: 'flex' }}><SettingsIcon size={12} /></span>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.6px', color: C.devTextMuted }}>DEV</span>
          <span style={{ color: C.devTextFaint, display: 'flex' }}><ChevronIcon size={11} direction="right" /></span>
        </button>
      )}
    </>
  );
}
