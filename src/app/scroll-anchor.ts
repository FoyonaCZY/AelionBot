/**
 * Keeps the reader's place when a message list changes width (opening a docked preview narrows it to ~340 px and
 * rewraps every message, so the same scrollTop would point far above what was on screen). The anchor is the first
 * direct child visible at the top and how far below the top edge it sat.
 */
export interface ScrollAnchor {
  index: number;
  offset: number;
  width: number;
}
export function readScrollAnchor(pane: HTMLElement): ScrollAnchor | undefined {
  const top = pane.getBoundingClientRect().top,
    children = pane.children;
  for (let index = 0; index < children.length; index++) {
    const box = children[index].getBoundingClientRect();
    if (box.bottom > top + 1) return { index, offset: box.top - top, width: pane.clientWidth };
  }
}
/** Scrolls so the anchored child sits where it was; returns false when it no longer exists. */
export function restoreScrollAnchor(pane: HTMLElement, anchor: ScrollAnchor) {
  const child = pane.children[anchor.index];
  if (!child) return false;
  pane.scrollTop += child.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset;
  return true;
}
