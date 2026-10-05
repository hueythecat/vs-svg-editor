// DOM helpers for restructuring layers: cloning one with fresh ids, naming a group, and
// keeping a clone inside the wrappers that position and paint it.
import { t } from '@/i18n';
import { isSyntheticLayerId } from '@/lib/svg-utils';

// Rewrites a cloned element's id and every descendant id to a fresh namespace, and fixes
// intra-subtree references (href / xlink:href / url(#…)) so a duplicated layer doesn't
// collide with, or point back at, the original — e.g. curved text's arc path referenced
// by its <textPath>. References to shared <defs> (gradients, filters) are left untouched.
export const remapClonedIds = (el: Element, newBaseId: string, origId: string) => {
  const idMap = new Map<string, string>();
  const collect = (node: Element) => {
    if (node.id) {
      const nid = node.id === origId ? newBaseId : `${newBaseId}__${node.id}`;
      idMap.set(node.id, nid);
      node.id = nid;
    }
    Array.from(node.children).forEach((c) => collect(c));
  };
  collect(el);
  const fixRefs = (node: Element) => {
    for (const attr of ['href', 'xlink:href']) {
      const v = node.getAttribute(attr);
      if (v && v.startsWith('#') && idMap.has(v.slice(1))) node.setAttribute(attr, `#${idMap.get(v.slice(1))}`);
    }
    for (const attr of ['fill', 'stroke', 'clip-path', 'mask', 'filter', 'style']) {
      const v = node.getAttribute(attr);
      if (v && v.includes('url(#')) {
        node.setAttribute(attr, v.replace(/url\(#([^)]+)\)/g, (m, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m)));
      }
    }
    Array.from(node.children).forEach((c) => fixRefs(c));
  };
  fixRefs(el);
};

// The name a group goes by: the name the row had when it was opened if we still hold it,
// else whatever the file called it, else its own id when that isn't one this app minted,
// else the positional name parseSvg would have given the row. Shared by the drill-in
// breadcrumb and by collapseLayer, so the group the panel says you are inside is named
// the same as the row you get back when you leave it.
//
// `remembered` comes first because it is the name the user last saw on that row, and
// re-derivation cannot reproduce it: a row named by parseSvg from a `<title>`, or one
// whose group is reached through an unnamed wrapper, has nothing on the element itself to
// recover the name from and would come back as a bare "Layer 5".
export const groupLabelFor = (
  group: Element,
  firstRowIndex: number,
  remembered: ReadonlyMap<string, string>,
): string =>
  remembered.get(group.id) ||
  group.getAttribute('data-name')?.trim() ||
  group.getAttribute('inkscape:label')?.trim() ||
  (!isSyntheticLayerId(group.id) ? group.id : '') ||
  t('layers.numberedLabel', { index: firstRowIndex + 1 });

// The wrappers an element is drawn inside, from just below the root <svg> down to its own
// parent. Cloning a layer out of its group and into a paste group at the root would drop
// every transform, clip and inherited paint those wrappers contribute, which is what this
// is read for.
export const ancestorChain = (el: Element, root: Element): Element[] => {
  const chain: Element[] = [];
  for (let n = el.parentElement; n && n !== root; n = n.parentElement) chain.unshift(n);
  return chain;
};

// Re-creates that chain around a clone as shallow copies of the wrappers, so the clone
// still renders exactly where the original does. Ids are stripped: they name the original
// elements and duplicating one would give the document two nodes answering to it.
export const wrapInAncestorChain = (clone: Element, chain: Element[]): Element =>
  chain.reduceRight((inner, anc) => {
    const w = anc.cloneNode(false) as Element;
    w.removeAttribute('id');
    w.appendChild(inner);
    return w;
  }, clone);
