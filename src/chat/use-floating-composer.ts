import { useLayoutEffect, useRef } from 'react';
import './floating-composer.css';

/**
 * The composer floats over the end of the message list. Its height changes with the draft, work items, live work
 * and permission prompts, so it is measured and published on the conversation as `--composer-inset`; the message
 * list keeps that much room at the bottom and its last message always ends above the composer.
 */
export function useFloatingComposer() {
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = wrap.current,
      conversation = node?.parentElement;
    if (!node || !conversation) return;
    const measure = () => conversation.style.setProperty('--composer-inset', `${Math.ceil(node.offsetHeight)}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => {
      observer.disconnect();
      conversation.style.removeProperty('--composer-inset');
    };
  }, []);
  return wrap;
}
