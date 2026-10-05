// Find & replace colours on the selected layer: the swatches it offers, the replacement
// itself, and the drag session that keeps a whole picker drag to one undo entry.
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef } from 'react';

import {
  type ActiveSvg, type SvgLayer, PAINTABLE_TAGS, collectLayerGradientIds, declaresOwnFill, effectiveFill,
  extractLayerColors, normalizeColor, resolveGradient,
} from '@/lib/svg-utils';

type Options = {
  activeSvg: ActiveSvg | null;
  setActiveSvg: Dispatch<SetStateAction<ActiveSvg | null>>;
  selectedLayer: string | null;
  snapshotForUndo: (content: string, layers: SvgLayer[]) => void;
};

export function useColorReplace({ activeSvg, setActiveSvg, selectedLayer, snapshotForUndo }: Options) {
  const colorEditRef = useRef<{ from: string; baseline: string } | null>(null);

  // The colours the selected layer paints with — the swatches offered to replace.
  const layerColors = useMemo(() => {
    if (!selectedLayer || !activeSvg) return [];
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerEl = doc.getElementById(selectedLayer);
    if (!layerEl) return [];
    return extractLayerColors(layerEl, doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayer, activeSvg?.content]);

  // Find & replace one colour across the selected layer (handoff §"Find & replace
  // colours"): every shape using `from` — attributes, inline styles, class rules and
  // referenced gradient stops — becomes `to`.
  //
  // The picker fires continuously while the user drags, so the first call of a session
  // records one undo entry and the document as its baseline; every later call replays
  // the replacement from that baseline instead of stacking edits.
  const replaceLayerColor = useCallback((from: string, to: string) => {
    if (!activeSvg || !selectedLayer || !from) return;

    let session = colorEditRef.current;
    if (!session || session.from !== from) {
      snapshotForUndo(activeSvg.content, activeSvg.layers);
      session = { from, baseline: activeSvg.content };
      colorEditRef.current = session;
    }

    const applyTo = to;
    const normalFrom = normalizeColor(from);
    const doc = new DOMParser().parseFromString(session.baseline, 'image/svg+xml');
    const layerEl = doc.getElementById(selectedLayer);
    if (!layerEl) return;

    const COLOR_ATTRS = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color'];

    // Replace color values in a CSS/style string
    const replaceInCss = (css: string): { result: string; changed: boolean } => {
      let changed = false;
      const result = css.replace(
        /(fill|stroke|color|stop-color|flood-color|lighting-color)\s*:\s*([^;{}]+)/gi,
        (_, prop: string, val: string) => {
          if (normalizeColor(val.trim()) === normalFrom) { changed = true; return `${prop}: ${applyTo}`; }
          return `${prop}: ${val}`;
        },
      );
      return { result, changed };
    };

    // Replace on a single element's attributes + inline style
    const processEl = (el: Element) => {
      COLOR_ATTRS.forEach((attr) => {
        const val = el.getAttribute(attr);
        if (val && normalizeColor(val) === normalFrom) el.setAttribute(attr, applyTo);
      });
      const style = el.getAttribute('style');
      if (style) {
        const { result, changed } = replaceInCss(style);
        if (changed) el.setAttribute('style', result);
      }
    };

    processEl(layerEl);
    layerEl.querySelectorAll('*').forEach((el) => processEl(el));

    // Shapes that never declare a fill have nothing to rewrite, yet they do paint —
    // inherited, or black by default — and that colour is offered as a swatch. Set the
    // fill on them so picking it actually recolours the shape instead of doing nothing.
    [layerEl, ...Array.from(layerEl.querySelectorAll('*'))].forEach((el) => {
      const tag = el.tagName.toLowerCase().replace(/.*:/, '');
      if (!PAINTABLE_TAGS.has(tag) || declaresOwnFill(el, doc)) return;
      const fill = effectiveFill(el, doc);
      if (fill && normalizeColor(fill) === normalFrom) el.setAttribute('fill', applyTo);
    });

    // For CSS class rules in <style> blocks: the rules are document-scoped, so rewriting
    // them would affect every layer sharing that class. Instead, add inline style overrides
    // on the specific elements within this layer — inline styles win specificity, leaving
    // all other layers untouched.
    const layerClassNames = new Set<string>();
    [layerEl, ...Array.from(layerEl.querySelectorAll('[class]'))].forEach((el) => {
      el.getAttribute('class')?.split(/\s+/).forEach((c) => c && layerClassNames.add(c));
    });

    // Build map: className → set of CSS property names that carry the "from" color
    const classProps = new Map<string, Set<string>>();
    doc.querySelectorAll('style').forEach((styleEl) => {
      const css = styleEl.textContent ?? '';
      for (const ruleMatch of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = ruleMatch[1].split(',');
        const declarations = ruleMatch[2];
        [...layerClassNames].forEach((cls) => {
          if (!selectors.some((s) => s.includes(`.${cls}`))) return;
          for (const dm of declarations.matchAll(/(fill|stroke|color|stop-color|flood-color|lighting-color)\s*:\s*([^;{}]+)/gi)) {
            if (normalizeColor(dm[2].trim()) === normalFrom) {
              if (!classProps.has(cls)) classProps.set(cls, new Set());
              classProps.get(cls)!.add(dm[1].toLowerCase());
            }
          }
        });
      }
    });

    if (classProps.size > 0) {
      [layerEl, ...Array.from(layerEl.querySelectorAll('*'))].forEach((el) => {
        const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        const propsToSet = new Set<string>();
        classes.forEach((cls) => classProps.get(cls)?.forEach((p) => propsToSet.add(p)));
        if (propsToSet.size === 0) return;
        // Merge new values into existing inline style without duplicating properties
        const styleMap = new Map<string, string>();
        (el.getAttribute('style') ?? '').split(';').forEach((decl) => {
          const idx = decl.indexOf(':');
          if (idx === -1) return;
          styleMap.set(decl.slice(0, idx).trim().toLowerCase(), decl.slice(idx + 1).trim());
        });
        propsToSet.forEach((prop) => styleMap.set(prop, applyTo));
        el.setAttribute('style', [...styleMap.entries()].map(([p, v]) => `${p}: ${v}`).join('; '));
      });
    }

    // Replace stop colors in gradients referenced by this layer
    collectLayerGradientIds(layerEl, layerClassNames, doc).forEach((id) => {
      const source = resolveGradient(id, doc);
      source?.querySelectorAll('stop').forEach((stop) => {
        const sc = stop.getAttribute('stop-color');
        if (sc && normalizeColor(sc) === normalFrom) stop.setAttribute('stop-color', applyTo);
      });
    });

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayer, snapshotForUndo]);

  // The picker closed — the next pick starts a fresh undo entry and baseline.
  const endColorEdit = useCallback(() => { colorEditRef.current = null; }, []);

  // A new document has no colour edit in progress.
  const resetColorEdit = useCallback(() => { colorEditRef.current = null; }, []);

  return { layerColors, replaceLayerColor, endColorEdit, resetColorEdit };
}
