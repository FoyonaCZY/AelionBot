import { useLayoutEffect, useRef } from 'react';
import { readScrollAnchor, restoreScrollAnchor, type ScrollAnchor } from './scroll-anchor';
import type { GroupSummary } from '../../shared/types/group-types';
import type { ChatMessage } from '../../shared/types/core';

/**
 * Keeps a bot conversation pinned to its newest message while the reader stays within 100px of the end.
 * Growth that arrives during a programmatic scroll is absorbed by `stickLock`, so it cannot unpin the view.
 */
export function useMessageFollow(input: {
  botId?: string;
  group?: GroupSummary;
  messages: ChatMessage[];
  artifactCount?: number;
}) {
  const { botId, group, messages, artifactCount } = input;
  const messagesPane = useRef<HTMLElement>(null),
    follow = useRef(true),
    stickLock = useRef(0),
    paneHeight = useRef(0),
    anchor = useRef<ScrollAnchor | undefined>(undefined);
  const stickToBottom = () => {
    const pane = messagesPane.current;
    if (!pane) return;
    stickLock.current++;
    pane.scrollTop = pane.scrollHeight;
    paneHeight.current = pane.scrollHeight;
    requestAnimationFrame(() => {
      const live = messagesPane.current;
      if (live && follow.current) {
        live.scrollTop = live.scrollHeight;
        paneHeight.current = live.scrollHeight;
      }
      requestAnimationFrame(() => {
        stickLock.current = Math.max(0, stickLock.current - 1);
      });
    });
  };
  const onMessagesScroll = (pane: HTMLElement) => {
    if (stickLock.current) return;
    // A width change clamps scrollTop before the resize observer runs; the observer restores the reader's place.
    if (anchor.current && pane.clientWidth !== anchor.current.width) return;
    const gap = pane.scrollHeight - pane.scrollTop - pane.clientHeight,
      grew = pane.scrollHeight > paneHeight.current + 1;
    paneHeight.current = pane.scrollHeight;
    if (grew && follow.current) {
      stickToBottom();
      return;
    }
    follow.current = gap < 100;
    anchor.current = readScrollAnchor(pane);
  };
  useLayoutEffect(() => {
    if (group) return;
    follow.current = true;
    stickToBottom();
  }, [botId, group?.id]);
  useLayoutEffect(() => {
    if (!group && follow.current) stickToBottom();
  }, [group, messages.length, messages.at(-1)?.content, artifactCount]);
  useLayoutEffect(() => {
    const pane = messagesPane.current;
    if (!pane || group) return;
    const onResize = () => {
      if (follow.current) stickToBottom();
      else if (anchor.current && pane.clientWidth !== anchor.current.width) {
        stickLock.current++;
        restoreScrollAnchor(pane, anchor.current);
        requestAnimationFrame(() => (stickLock.current = Math.max(0, stickLock.current - 1)));
      }
      anchor.current = follow.current ? undefined : readScrollAnchor(pane);
      paneHeight.current = pane.scrollHeight;
    };
    anchor.current = undefined;
    const observer = new ResizeObserver(onResize);
    observer.observe(pane);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [botId, group?.id]);
  /** Keeps a pinned view at the end as live replies grow; called by the component that shows them. */
  const followLive = () => {
    if (!group && follow.current) stickToBottom();
  };
  return { messagesPane, follow, onMessagesScroll, followLive };
}
