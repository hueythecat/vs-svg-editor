import React from 'react';

import { C, SHADOW, FONT_STACK, toolButtonStyle } from '@/lib/design-tokens';
import {
  CenterIcon, CloseIcon, DownloadIcon, RedoIcon, RevertIcon, RotateIcon, UndoIcon,
} from './svg-icons';

// Floating top-centre toolbar (handoff §1.5): app chip · filename · undo/redo ·
// Center · 90° · Export. Memoised and fed only the values it needs, so it doesn't
// re-render on every unrelated state change in the parent (text edits, drags, AI runs).
// Styled with inline objects rather than NativeWind classes — see design-tokens.ts.

const divider = <span style={{ width: 1, height: 20, background: C.borderPanel, flex: 'none' }} />;

// 15px icon button; #4b5563 when available, #d3d7dd when its stack is empty.
function IconButton({
  onClick, disabled, title, color, children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ed-ghost"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...toolButtonStyle,
        padding: 7,
        color: disabled ? C.disabledIcon : (color ?? C.textSecondary),
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

export const EditorToolbar = React.memo(function EditorToolbar({
  fileName, isDirty,
  onCenter, onRotate90, transformDisabled, onMatchRotation, matchRotationDisabled,
  undoCount, onUndo, redoCount, onRedo,
  exportLabel, onExport, onClose, onReset,
}: {
  fileName: string;
  isDirty: boolean;
  onCenter: () => void;
  onRotate90: () => void;
  transformDisabled: boolean;
  onMatchRotation: () => void;
  matchRotationDisabled: boolean;
  undoCount: number;
  onUndo: () => void;
  redoCount: number;
  onRedo: () => void;
  exportLabel: string;
  onExport: () => void;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: 6,
        background: C.surface,
        border: `1px solid ${C.borderPanel}`,
        borderRadius: 12,
        boxShadow: SHADOW.toolbar,
        fontFamily: FONT_STACK,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {/* App chip */}
      <span
        style={{
          width: 22, height: 22, borderRadius: 6, background: C.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 11, flex: 'none',
        }}
      >
        ◆
      </span>

      {/* Filename + unsaved-changes dot */}
      <span
        title={fileName}
        style={{
          fontSize: 13, fontWeight: 600, color: C.textPrimary,
          padding: '0 4px', maxWidth: 210,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {fileName}
      </span>
      {isDirty && (
        <span
          title="Unsaved changes"
          style={{ width: 6, height: 6, borderRadius: '50%', background: C.star, flex: 'none' }}
        />
      )}

      {divider}

      <IconButton onClick={onUndo} disabled={undoCount === 0} title="Undo (⌘Z)">
        <UndoIcon size={15} />
      </IconButton>
      <IconButton onClick={onRedo} disabled={redoCount === 0} title="Redo (⇧⌘Z)">
        <RedoIcon size={15} />
      </IconButton>

      {divider}

      <button
        type="button"
        className="ed-ghost"
        onClick={onCenter}
        title="Centre every layer on the canvas"
        style={toolButtonStyle}
      >
        <CenterIcon size={14} />
        Center
      </button>
      <button
        type="button"
        className="ed-ghost"
        onClick={onRotate90}
        disabled={transformDisabled}
        title="Rotate the selection 90°"
        style={{
          ...toolButtonStyle,
          color: transformDisabled ? C.disabledIcon : C.textSecondary,
          cursor: transformDisabled ? 'default' : 'pointer',
        }}
      >
        <RotateIcon size={14} />
        90°
      </button>
      <IconButton
        onClick={onMatchRotation}
        disabled={matchRotationDisabled}
        title="Match every layer to the selected layer's rotation"
      >
        <RotateIcon size={15} />
      </IconButton>
      <IconButton onClick={onReset} disabled={!isDirty} title="Revert to the original file">
        <RevertIcon size={15} />
      </IconButton>

      {divider}

      <button
        type="button"
        onClick={onExport}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: 'none', background: C.accent, color: '#fff',
          fontSize: 12.5, fontWeight: 600, fontFamily: FONT_STACK,
          padding: '7px 14px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        <DownloadIcon size={13} />
        {exportLabel}
      </button>

      <IconButton onClick={onClose} title="Close file (ESC)" color={C.textFaint}>
        <CloseIcon size={15} />
      </IconButton>
    </div>
  );
});
