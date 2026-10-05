// Typing straight onto the artwork: the contentEditable that stands over a text layer
// while it is being edited.
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';

import type { TextLayerAttrs } from '@/components/editor-types';

type TextProps = { content: string; font: string; weight: number; color: string; letterSpacing: number };

type Options = {
  editingTextId: string | null;
  setEditingTextId: Dispatch<SetStateAction<string | null>>;
  textEditorRef: RefObject<HTMLDivElement | null>;
  selectedLayer: string | null;
  selectedTextProps: TextProps | null;
  showSelectionOverlay: boolean;
  updateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
};

export function useInlineTextEdit({
  editingTextId, setEditingTextId, textEditorRef, selectedLayer, selectedTextProps, showSelectionOverlay, updateTextLayer,
}: Options) {
  // Double-clicking a text layer types straight onto the artwork instead of into the
  // Text tab. The editable node is an HTML overlay, not the SVG <text> itself: the
  // document lives as a string that is re-parsed and re-rendered on every edit, so a
  // contentEditable inside it would be destroyed on the first keystroke.
  //
  // Curved text is deliberately excluded — see handleCanvasClick, where editing starts.
  //
  // Push the current text in and select it, so the first keypress replaces the word —
  // which is what double-clicking a word is asking for. Runs on entry only; after that
  // the node is the user's to type in.
  //
  // The text comes from THIS render's selection, checked against the id being edited —
  // not from selectedTextPropsRef, which is only brought up to date by a passive effect
  // and so can still hold the previous field's words when this runs. And it re-runs when
  // the overlay appears: the editor lives inside it, and the canvas dot opens editing a
  // couple of frames after making the field, which on a heavy file can be before the
  // overlay has rendered. Keyed on the id alone, that early run found no node and never
  // came back, so the editor mounted empty (or, reusing the last node, showing the last
  // field's words) over glyphs it had already hidden.
  useLayoutEffect(() => {
    if (!editingTextId) return;
    const node = textEditorRef.current;
    if (!node) return;
    node.textContent = selectedLayer === editingTextId ? selectedTextProps?.content ?? '' : '';
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Deliberately not keyed on the content or selection: re-running as they change would
    // re-select everything mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTextId, showSelectionOverlay]);

  const endInlineEdit = useCallback(() => {
    setEditingTextId(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // Type styling for the editor, mirroring the layer it stands over. Font size is absent
  // on purpose — it depends on the board scale and is written onto the node by the
  // overlay positioning pass.
  const inlineEditStyle = useMemo(() => ({
    fontFamily: selectedTextProps?.font ?? 'Arial',
    fontWeight: selectedTextProps?.weight ?? 400,
    color: selectedTextProps?.color ?? '#000000',
    letterSpacing: selectedTextProps?.letterSpacing ?? 0,
  }), [selectedTextProps?.font, selectedTextProps?.weight, selectedTextProps?.color, selectedTextProps?.letterSpacing]);

  // Every keystroke goes through the same path the Text tab's Words field uses, so the
  // two are never out of step and a whole edit session is still one undo entry.
  const onInlineTextInput = useCallback(() => {
    const node = textEditorRef.current;
    if (!node) return;
    // innerText, not textContent: a contentEditable holds its line breaks as <div>/<br>
    // elements, which textContent drops silently — typing Return on the canvas would
    // then join the two lines back together on the next keystroke.
    updateTextLayer({ content: node.innerText ?? '' });
  }, [updateTextLayer]);

  // Leaving edit mode whenever the selection moves off the layer being typed into —
  // clicking another layer, deleting this one, or opening a group.
  useEffect(() => {
    if (editingTextId && selectedLayer !== editingTextId) setEditingTextId(null);
  }, [selectedLayer, editingTextId]);

  return { endInlineEdit, inlineEditStyle, onInlineTextInput };
}
