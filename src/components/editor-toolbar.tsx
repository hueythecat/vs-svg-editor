import React from 'react';

// Top toolbar of the editor (filename, center/rotate/undo/export/close). Memoised and
// fed only the values it needs, so it no longer re-renders on every unrelated state
// change in the parent (text edits, drags, AI runs, …).
export const EditorToolbar = React.memo(function EditorToolbar({
  fileName, isDirty,
  onCenter, onMatchRotation, matchRotationDisabled,
  undoCount, onUndo,
  exportLabel, onExport, onClose,
}: {
  fileName: string;
  isDirty: boolean;
  onCenter: () => void;
  onMatchRotation: () => void;
  matchRotationDisabled: boolean;
  undoCount: number;
  onUndo: () => void;
  exportLabel: string;
  onExport: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 h-11 border-b border-zinc-800 shrink-0">
      {/* Filename + dirty dot */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="text-zinc-400 text-sm font-mono truncate">{fileName}</span>
        {isDirty && (
          <span className="size-1.5 rounded-full bg-amber-400 shrink-0 inline-block" title="Unsaved changes" />
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {/* Center layers to canvas midpoint */}
        <button
          onClick={onCenter}
          title="Center all layers horizontally"
          className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <circle cx="12" cy="12" r="3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M3 12h2m14 0h2" />
          </svg>
        </button>

        {/* Match all layers to the selected layer's rotation */}
        <button
          onClick={onMatchRotation}
          disabled={matchRotationDisabled}
          title="Match all layers to the selected layer's rotation"
          className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400 disabled:cursor-not-allowed"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.4 3.6v3.1h-3.1" />
          </svg>
        </button>

        {/* Undo */}
        {undoCount > 0 && (
          <button
            onClick={onUndo}
            title="Undo (⌘Z)"
            className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
        )}

        {/* Export */}
        <button
          onClick={onExport}
          className="h-7 flex items-center gap-1.5 px-2.5 rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 text-xs font-medium transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          {exportLabel}
        </button>

        {/* Close */}
        <button
          onClick={onClose}
          title="Close file (ESC)"
          className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
});
