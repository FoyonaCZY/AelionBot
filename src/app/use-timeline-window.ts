import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { TimelineItem } from '../../shared/chat/activity';
import { REVEAL_MESSAGE_EVENT } from '../chat/reveal-message';

/** How many timeline items render at first, and how many more each time the reader nears the top. */
const TIMELINE_PAGE = 80;
/** Distance from the top, in pixels, at which the earlier items start rendering. */
const GROW_AT = 1200;

/**
 * Which part of a long timeline renders: the newest TIMELINE_PAGE items, and earlier ones as the reader scrolls up
 * or a search jumps to them. While the reader stays among earlier items the window keeps its first item, so new
 * items do not push the page; back at the end it returns to the newest items. Growing keeps what is on screen in
 * place.
 */
export function useTimelineWindow(input: {
  botId: string;
  timeline: TimelineItem[];
  keys: string[];
  pane: RefObject<HTMLElement | null>;
  follow: RefObject<boolean>;
}) {
  const { botId, timeline, keys, pane, follow } = input;
  const [pinned, setPinned] = useState<{ botId: string; key: string }>();
  const tail = Math.max(0, keys.length - TIMELINE_PAGE),
    pinnedAt = pinned?.botId === botId ? keys.indexOf(pinned.key) : -1,
    start = pinnedAt >= 0 && pinnedAt < tail ? pinnedAt : tail;
  const latest = useRef({ timeline, keys, start, pinned });
  latest.current = { timeline, keys, start, pinned };
  const anchor = useRef<{ element: Element; offset: number }>(undefined);
  const pin = (index: number, keepPlace: boolean) => {
    const element = pane.current;
    anchor.current = undefined;
    if (keepPlace && element) {
      const top = element.getBoundingClientRect().top;
      for (const child of element.children) {
        const box = child.getBoundingClientRect();
        if (box.bottom > top) {
          anchor.current = { element: child, offset: box.top - top };
          break;
        }
      }
    }
    setPinned({ botId, key: latest.current.keys[index] });
  };
  // Items rendered above the reader push the page down unless the browser anchored it already; either way, put the
  // item that was at the top back where it was.
  useLayoutEffect(() => {
    const saved = anchor.current,
      element = pane.current;
    anchor.current = undefined;
    if (!saved || !element || !saved.element.isConnected) return;
    element.scrollTop += saved.element.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
  }, [start]);
  const onScroll = (element: HTMLElement) => {
    const { start, pinned } = latest.current;
    if (follow.current) {
      if (pinned) setPinned(undefined);
    } else if (element.scrollTop < GROW_AT && start > 0) pin(Math.max(0, start - TIMELINE_PAGE), true);
    else if (pinned?.botId !== botId) pin(start, false);
  };
  // A search or a quote jumps to a message: render from a little above it, then ask again so a run process that
  // just rendered unfolds to it.
  const [revealed, setRevealed] = useState<string>();
  useEffect(() => {
    const onReveal = (event: Event) => {
      const id = (event as CustomEvent<string>).detail,
        { timeline, start } = latest.current;
      const index = timeline.findIndex((item) =>
        item.kind === 'message' ? item.id === id : item.messages.some((message) => message.id === id),
      );
      if (index < 0 || index >= start) return;
      follow.current = false;
      pin(Math.max(0, index - 2), false);
      setRevealed(id);
    };
    window.addEventListener(REVEAL_MESSAGE_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_MESSAGE_EVENT, onReveal);
  }, [botId]);
  useEffect(() => {
    if (!revealed) return;
    setRevealed(undefined);
    window.dispatchEvent(new CustomEvent(REVEAL_MESSAGE_EVENT, { detail: revealed }));
  }, [revealed]);
  return { start, onScroll };
}
