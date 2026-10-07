/** Asks views that hide a message (a folded run process, the unrendered start of a long timeline) to show it. */
export const REVEAL_MESSAGE_EVENT = 'aelion-reveal-message';

/**
 * Finds a message's element, first asking hiding views to render it when it is not on the page. Showing it can take
 * a few commits (the timeline renders its earlier part, then the run process inside it unfolds), so this looks for
 * it once per frame for up to `frames` frames. Resolves undefined when it never appears.
 */
export function revealMessage(id: string, find: () => HTMLElement | null | undefined, frames = 30) {
  const present = find();
  if (present) return Promise.resolve<HTMLElement | undefined>(present);
  window.dispatchEvent(new CustomEvent(REVEAL_MESSAGE_EVENT, { detail: id }));
  return new Promise<HTMLElement | undefined>((resolve) => {
    let left = frames;
    const look = () => {
      const target = find();
      if (target || --left <= 0) resolve(target || undefined);
      else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}
