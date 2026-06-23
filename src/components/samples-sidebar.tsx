import React from 'react';
import { cn } from '@/lib/utils';

type Sample = { label: string; name: string; src: string };

interface SamplesSidebarProps<S extends Sample> {
  samples: ReadonlyArray<S>;
  activeSample: string | null;
  isLoading: boolean;
  onOpenSample: (sample: S) => void;
}

export function SamplesSidebar<S extends Sample>({ samples, activeSample, isLoading, onOpenSample }: SamplesSidebarProps<S>) {
  return (
    <aside className="w-56 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900/60">
      <div className="px-3 py-2.5 border-b border-zinc-800">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
          Samples
        </span>
      </div>
      <div className="flex flex-col gap-1.5 p-2 overflow-y-auto">
        {samples.map((sample) => {
          const isActive = activeSample === sample.name;
          return (
            <button
              key={sample.name}
              onClick={() => onOpenSample(sample)}
              disabled={isLoading}
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
        })}
      </div>
    </aside>
  );
}
