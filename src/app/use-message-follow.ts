import { useLayoutEffect, useRef } from 'react';
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
  liveSignature: string;
}) {
  const { botId, group, messages, artifactCount, liveSignature } = input;
  const messagesPane = useRef<HTMLElement>(null),
    follow = useRef(true),
    stickLock = useRef(0),
    paneHeight = useRef(0);
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
    const gap = pane.scrollHeight - pane.scrollTop - pane.clientHeight,
      grew = pane.scrollHeight > paneHeight.current + 1;
    paneHeight.current = pane.scrollHeight;
    if (grew && follow.current) {
      stickToBottom();
      return;
    }
    follow.current = gap < 100;
  };
  useLayoutEffect(() => {
    if (group) return;
    follow.current = true;
    stickToBottom();
  }, [botId, group?.id]);
  useLayoutEffect(() => {
    if (!group && follow.current) stickToBottom();
  }, [group, messages.length, messages.at(-1)?.content, artifactCount, liveSignature]);
  useLayoutEffect(() => {
    const pane = messagesPane.current;
    if (!pane || group) return;
    const onResize = () => {
      if (follow.current) stickToBottom();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(pane);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [botId, group?.id]);
  return { messagesPane, follow, onMessagesScroll };
}
