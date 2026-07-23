import { cn } from '@/lib/utils';
import React, { useState } from 'react';

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

// Inline style (not Tailwind) so NativeWind doesn't have to have seen these classes
// at build time — a newly-introduced control renders reliably this way.
const devSelectStyle: React.CSSProperties = {
  width: '100%',
  background: '#18181b',
  color: '#d4d4d8',
  border: '1px solid #3f3f46',
  borderRadius: 6,
  fontSize: 11,
  padding: '4px 6px',
  outline: 'none',
};

interface SamplesSidebarProps<S extends Sample> {
  samples: ReadonlyArray<S>;
  activeSample: string | null;
  isLoading: boolean;
  onOpenSample: (sample: S) => void;
  // Opens a download that was fetched and extracted at runtime (src is a data: URI).
  onOpenFetched?: (sample: Sample) => void;
}

export function SamplesSidebar<S extends Sample>({ samples, activeSample, isLoading, onOpenSample, onOpenFetched }: SamplesSidebarProps<S>) {
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
      // Prepend so the newest extraction sits at the top of the previews. De-dupe by
      // name so re-selecting the same id refreshes rather than stacking duplicates.
      setFetchedSamples((prev) => [{ label: title, name, src, edit }, ...prev.filter((s) => s.name !== name)]);
      setFetchStatus(null);
    } catch (err) {
      setFetchStatus(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setFetching(false);
    }
  };

  const renderPreview = (sample: Sample, onOpen: () => void) => {
    const isActive = activeSample === sample.name;
    return (
      <button
        key={sample.name}
        onClick={onOpen}
        disabled={isLoading}
        // Dragging the preview onto the canvas opens it. draggable sits on the button
        // so the whole tile is the drag handle; the payload is read back in handleDrop.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SAMPLE_DRAG_MIME, JSON.stringify(sample));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        className={cn(
          'flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-all duration-100 outline-none',
          isActive ? 'bg-zinc-700/80 ring-1 ring-inset ring-zinc-500' : 'hover:bg-zinc-800/70',
          isLoading && 'opacity-50 cursor-wait'
        )}
      >
        <div className="w-full aspect-square rounded-md overflow-hidden bg-zinc-950/60 relative">
          <div className="absolute inset-0 bg-zinc-800 animate-pulse rounded-md" />
          <img
            src={sample.src}
            alt={sample.label}
            // Suppress the native image drag so only the button's drag fires (carrying
            // our custom payload rather than the image URL).
            draggable={false}
            className="relative w-full h-full object-contain p-1.5"
            onLoad={(e) => {
              const placeholder = (e.currentTarget.previousSibling as HTMLElement | null);
              if (placeholder) placeholder.style.display = 'none';
            }}
          />
        </div>
        <span className={cn(
          'text-[11px] truncate w-full leading-tight transition-colors',
          isActive ? 'text-zinc-200' : 'text-zinc-500'
        )}>
          {sample.label}
        </span>
      </button>
    );
  };

  return (
    <aside className="w-56 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900/60">
      {/* Full-viewport "Fetching asset" overlay shown while a download is being pulled.
          Inline styles + a scoped keyframe so it renders regardless of the Tailwind build. */}
      {fetching && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
            background: 'rgba(9,9,11,0.72)', backdropFilter: 'blur(2px)',
          }}
        >
          <style>{'@keyframes svgspin{to{transform:rotate(360deg)}}'}</style>
          <div
            style={{
              width: 34, height: 34, borderRadius: '50%',
              border: '3px solid #3f3f46', borderTopColor: '#818cf8',
              animation: 'svgspin 0.8s linear infinite',
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 500, color: '#d4d4d8' }}>Fetching asset…</span>
        </div>
      )}
      <div className="px-3 py-2.5 border-b border-zinc-800 flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
          Dev — Downloads
        </span>
        <select
          value={selectedDownload}
          style={devSelectStyle}
          onChange={(e) => {
            const id = e.target.value;
            setSelectedDownload(id);
            const picked = DOWNLOADS.find((d) => d.id === id);
            if (picked) fetchDownload(picked.id, picked.name, picked.edit);
          }}
        >
          <option value="">Select a vector…</option>
          {DOWNLOADS.map((d) => (
            <option key={d.id} value={d.id}>{d.id} — {d.name}</option>
          ))}
        </select>
        {fetchStatus && (
          <span className="text-[11px] text-zinc-400 leading-tight">{fetchStatus}</span>
        )}
      </div>
      <div className="px-3 py-2.5 border-b border-zinc-800">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
          Samples
        </span>
      </div>
      <div className="flex flex-col gap-1.5 p-2 overflow-y-auto">
        {fetchedSamples.map((sample) => renderPreview(sample, () => onOpenFetched?.(sample)))}
        {samples.map((sample) => renderPreview(sample, () => onOpenSample(sample)))}
      </div>
    </aside>
  );
}
