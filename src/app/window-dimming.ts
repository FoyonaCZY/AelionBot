import { useEffect } from 'react';

// Chat text and the composer change many times a second and never paint under the caption buttons.
const UNRELATED = '.messages, [contenteditable="true"]';
const unrelated = (node: EventTarget | Node | null) =>
  Boolean((node instanceof Element ? node : node instanceof Node ? node.parentElement : null)?.closest(UNRELATED));

// Derive the native titlebar state from all mounted dialogs. A nested dialog
// closing must not restore the titlebar while its parent is still visible.
export function useWindowDimming() {
  useEffect(() => {
    let previous = '',
      frame = 0;
    const sync = () => {
      const dimmed = Boolean(document.querySelector('[aria-modal="true"]'));
      let color = [247, 247, 247];
      // Native caption buttons paint outside the DOM. Match the actual backdrop
      // at their location, including different modal opacities and nested layers.
      for (const element of document.elementsFromPoint(Math.max(0, window.innerWidth - 80), 18).reverse()) {
        const style = getComputedStyle(element),
          rgba = style.backgroundColor
            .match(/^rgba?\(([^)]+)\)$/)?.[1]
            .split(/[,\s/]+/)
            .filter(Boolean)
            .map(Number);
        if (!rgba || rgba.length < 3) continue;
        const alpha = (rgba[3] ?? 1) * Number(style.opacity);
        color = color.map((base, index) => rgba[index] * alpha + base * (1 - alpha));
      }
      const hex =
          '#' +
          color
            .map((value) =>
              Math.round(Math.max(0, Math.min(255, value)))
                .toString(16)
                .padStart(2, '0'),
            )
            .join(''),
        key = dimmed + hex;
      if (previous === key) return;
      previous = key;
      void window.aelion.setWindowDimmed?.(dimmed, hex).catch(() => {});
    };
    // Reading what paints at a point lays the page out, so look once per frame, when the frame lays it out anyway,
    // rather than in the middle of every DOM change.
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };
    const observer = new MutationObserver((records) => {
      if (!records.every((record) => unrelated(record.target))) schedule();
    });
    const onMotionEnd = (event: Event) => {
      if (!unrelated(event.target)) schedule();
    };
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'class', 'style'],
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('aelion-appearance-change', schedule);
    document.addEventListener('transitionend', onMotionEnd, true);
    document.addEventListener('animationend', onMotionEnd, true);
    sync();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('aelion-appearance-change', schedule);
      document.removeEventListener('transitionend', onMotionEnd, true);
      document.removeEventListener('animationend', onMotionEnd, true);
      void window.aelion.setWindowDimmed?.(false).catch(() => {});
    };
  }, []);
}
