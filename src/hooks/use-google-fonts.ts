// Google Fonts for the editor: loading a family's stylesheet, and the two lists the Font
// dropdown is built from.
import { useCallback, useState } from 'react';

export function useGoogleFonts() {
  // Fonts the AI offered, split by how much they've earned their place. `usedFonts` are
  // the faces actually applied to text this session re-created — the ones you are most
  // likely to want again — while `extraFonts` are image-level suggestions nothing has
  // used yet. The Font dropdown lists them in that order, ahead of the built-in stack.
  const [usedFonts, setUsedFonts] = useState<string[]>([]);
  const [extraFonts, setExtraFonts] = useState<string[]>([]);

  const loadGoogleFontLink = useCallback((fontName: string, weight?: number) => {
    const family = fontName.replace(/\s+/g, '+');
    const slug = fontName.replace(/\s+/g, '-');
    const inject = (id: string, href: string) => {
      if (document.getElementById(id)) return;
      const link = document.createElement('link');
      link.id = id; link.rel = 'stylesheet'; link.href = href;
      document.head.appendChild(link);
    };
    inject(`gfont-${slug}`, `https://fonts.googleapis.com/css2?family=${family}:wght@400;700&display=swap`);
    // A weight outside the base pair goes in its OWN request rather than being appended to
    // it. Google's css2 endpoint rejects the whole request when any requested weight is
    // unavailable for the family, so folding an 800 into the base request would take 400
    // and 700 down with it and leave the family with no faces at all. Split, the worst a
    // missing weight costs is that one weight, and the browser synthesises it.
    if (weight && weight !== 400 && weight !== 700) {
      inject(`gfont-${slug}-${weight}`, `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&display=swap`);
    }
  }, []);

  // A suggestion: offered, not yet applied to anything.
  const addGoogleFont = useCallback((fontName: string, weight?: number) => {
    setExtraFonts((prev) => prev.includes(fontName) ? prev : [...prev, fontName]);
    loadGoogleFontLink(fontName, weight);
  }, [loadGoogleFontLink]);

  // A face a re-created text row is actually set in. Kept out of the suggestion list so
  // one can be listed ahead of the other, and so a font in use never reads as a proposal.
  const addUsedFont = useCallback((fontName: string, weight?: number) => {
    if (!fontName) return;
    setUsedFonts((prev) => prev.includes(fontName) ? prev : [...prev, fontName]);
    loadGoogleFontLink(fontName, weight);
  }, [loadGoogleFontLink]);

  // Reset renders no font list: the <link> tags stay — a loaded webface costs nothing
  // and may be needed again — but nothing is listed until the artwork's own pass
  // proposes it.
  const resetFonts = useCallback(() => {
    setUsedFonts([]);
    setExtraFonts([]);
  }, []);

  return { usedFonts, extraFonts, loadGoogleFontLink, addGoogleFont, addUsedFont, resetFonts };
}
