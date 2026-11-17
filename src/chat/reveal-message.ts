/** Asks views that hide a message (a folded run process, the unrendered start of a long timeline) to show it. */
export const REVEAL_MESSAGE_EVENT = 'aelion-reveal-message';

const HIT_CLASS = 'is-search-hit';
let fading: ReturnType<typeof setTimeout> | undefined;

/** Takes the highlight off the message a search last showed. */
export function clearMessageHit() {
  clearTimeout(fading);
  document.querySelectorAll('.' + HIT_CLASS).forEach((node) => node.classList.remove(HIT_CLASS));
}

/**
 * Scrolls a message of the open chat (a Bot's or a group's) into view and highlights it, first asking a folded run
 * process or the timeline to render it. With `brief` the highlight goes away by itself; a search that stays open
 * keeps it until its next match. Resolves to whether the message was found.
 */
export async function showMessageHit(id: string, brief = false) {
  clearMessageHit();
  const key = CSS.escape(id);
  const target = await revealMessage(id, () =>
    document.querySelector<HTMLElement>(
      `.messages [data-message-id="${key}"], .messages [data-group-message-id="${key}"]`,
    ),
  );
  if (!target) return false;
  target.classList.add(HIT_CLASS);
  target.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  if (brief) fading = setTimeout(clearMessageHit, 2400);
  return true;
}

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
