import React from 'react';

import { cn } from '@/lib/utils';
import { SparklesIcon } from './svg-icons';

// The "Font suggestions" strip below the toolbar (vision-model font picks). Memoised;
// returns null when closed. The toggle/apply logic stays in the parent behind
// onSelectFont, so this component is purely presentational.
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
  if (!open) return null;
  return (
    <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <SparklesIcon className="size-3 text-indigo-400" />
          <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Font suggestions</span>
        </div>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 text-xs transition-colors">✕</button>
      </div>
      {loading && (
        <div className="flex items-center gap-2 py-1">
          <div className="size-3 rounded-full border border-zinc-600 border-t-zinc-400 animate-spin shrink-0" />
          <span className="text-xs text-zinc-500">Analysing design…</span>
        </div>
      )}
      {fonts && fonts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {fonts.map(({ font, reason }) => {
            const isSelected = selectedFont === font;
            return (
              <div
                key={font}
                title={reason}
                onClick={() => onSelectFont(font)}
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-1 cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-indigo-600/30 ring-1 ring-indigo-500 text-indigo-200'
                    : 'bg-zinc-800 hover:bg-zinc-700/80 text-zinc-200'
                )}
              >
                <span className="text-xs" style={{ fontFamily: font }}>{font}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddFont(font); }}
                  title="Add to font list"
                  className={cn(
                    'transition-colors text-xs ml-1',
                    isSelected ? 'text-indigo-400 hover:text-indigo-200' : 'text-zinc-500 hover:text-zinc-200'
                  )}
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
