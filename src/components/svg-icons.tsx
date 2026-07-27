import React from 'react';

// `size` (px) lets these be used from inline-styled UI that has no Tailwind sizing
// class; `className` still works for the Tailwind-styled callers.
export function TrashIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width={size} height={size}
      stroke="currentColor" strokeWidth={1.75} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
    </svg>
  );
}

export function DuplicateIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width={size} height={size}
      stroke="currentColor" strokeWidth={1.75} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m11.25 5.5H16.5a1.125 1.125 0 0 1-1.125-1.125V5.75" />
    </svg>
  );
}

export function EyeIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width={size} height={size}
      stroke="currentColor" strokeWidth={1.75} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

export function EyeSlashIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width={size} height={size}
      stroke="currentColor" strokeWidth={1.75} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}

export function GripIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 14" fill="currentColor" className={className}
      width={size ? size * (8 / 14) : undefined} height={size}>
      <circle cx="1.5" cy="1.5"  r="1.5" />
      <circle cx="6.5" cy="1.5"  r="1.5" />
      <circle cx="1.5" cy="7"    r="1.5" />
      <circle cx="6.5" cy="7"    r="1.5" />
      <circle cx="1.5" cy="12.5" r="1.5" />
      <circle cx="6.5" cy="12.5" r="1.5" />
    </svg>
  );
}

// ─── Editor chrome icons ─────────────────────────────────────────────────────
// The handoff uses Unicode glyphs as stand-ins and names the Lucide equivalents;
// these are the matching shapes drawn in the same stroked style as the icons above.
// `size` is in px so they can be used from inline-styled (non-Tailwind) UI.

type IconProps = { className?: string; size?: number; strokeWidth?: number };

const stroked = (size: number | undefined, className: string | undefined, strokeWidth = 1.75) => ({
  xmlns: 'http://www.w3.org/2000/svg',
  fill: 'none',
  viewBox: '0 0 24 24',
  stroke: 'currentColor',
  strokeWidth,
  className,
  width: size,
  height: size,
  style: { display: 'block', flex: 'none' } as React.CSSProperties,
});

export function UndoIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
    </svg>
  );
}

export function RedoIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" />
    </svg>
  );
}

export function CenterIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M3 12h2m14 0h2" />
    </svg>
  );
}

export function RotateIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.4 3.6v3.1h-3.1" />
    </svg>
  );
}

export function DownloadIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className, 2)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

export function CloseIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}

export function PlusIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function RevertIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}

export function PencilIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 1 1 3.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  );
}

export function TypeIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />
    </svg>
  );
}

export function ShapeIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m12 3 8.5 9-8.5 9-8.5-9L12 3Z" />
    </svg>
  );
}

export function ImageIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m3.5 16 4.5-4.5 3.5 3.5 3-3 6 6" />
    </svg>
  );
}

export function ChevronIcon({ className, size, direction = 'right' }: IconProps & { direction?: 'left' | 'right' | 'up' | 'down' }) {
  const d = {
    right: 'm9 5 7 7-7 7',
    left:  'm15 5-7 7 7 7',
    up:    'm5 15 7-7 7 7',
    down:  'm5 9 7 7 7-7',
  }[direction];
  return (
    <svg {...stroked(size, className, 2)}>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

export function SettingsIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function MoveIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className, 2)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />
    </svg>
  );
}

export function ResizeIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className, 2)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 10V4h-6M4 14v6h6M20 4l-7 7M4 20l7-7" />
    </svg>
  );
}

export function StarIcon({ className, size, filled }: IconProps & { filled?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
      style={{ display: 'block' }}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5a.562.562 0 0 1 1.04 0l2.125 5.11a.563.563 0 0 0 .475.346l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
    </svg>
  );
}

export function CheckIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className, 3)}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4.5 4.5L19 7" />
    </svg>
  );
}

export function SparklesIcon({ className, size }: IconProps) {
  return (
    <svg {...stroked(size, className)}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg>
  );
}
