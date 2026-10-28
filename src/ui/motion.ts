import { useLayoutEffect, useRef, type RefObject } from 'react';

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The view-in and fade-in motions of src/styles/motion.css, for content that switches without a mount to start them. */
const SWITCH_IN: Record<'rise' | 'fade', Keyframe[]> = {
  rise: [
    { opacity: 0, translate: '0 6px' },
    { opacity: 1, translate: '0 0' },
  ],
  fade: [{ opacity: 0 }, { opacity: 1 }],
};
const SWITCH_TIMING: KeyframeAnimationOptions = { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };

/**
 * Plays the view-in motion each time `key` changes after the first render: on `ref`'s element, or on the elements
 * inside it that match `selector` (`:scope > …` for its own children), looked up once the switch has rendered.
 * For tabs and pages that switch in place or behind [hidden]; content that remounts can use a CSS animation.
 * `fade` keeps the content in place: a native preview surface is laid out from where its slot is measured.
 */
export function useSwitchMotion(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  selector?: string,
  motion: 'rise' | 'fade' = 'rise',
) {
  const last = useRef(key),
    running = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    if (Object.is(last.current, key)) return;
    last.current = key;
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const root = ref.current;
    if (!root || prefersReducedMotion()) return;
    for (const target of selector ? root.querySelectorAll(selector) : [root])
      running.current.push(target.animate(SWITCH_IN[motion], SWITCH_TIMING));
  }, [key]);
}
