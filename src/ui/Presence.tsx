import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Exit keyframes in src/styles/motion.css are named motion-…-out; other animations inside are not waited for. */
const EXIT = /^motion-.+-out$/;
/** Longer than any exit motion: an overlay whose animation never reports its end still goes. */
const EXIT_LIMIT_MS = 500;

/**
 * Lets an overlay animate out. While `children` is set it renders them; once it turns empty, the last children stay
 * mounted, inert, under [data-leaving] until their exit animations end. The wrapper is display: contents, so the
 * overlay keeps its layout, but a selector that reaches it through its parent's `>` no longer matches.
 */
export function Presence({ children }: { children: ReactNode }) {
  const present = children !== undefined && children !== null && children !== false && children !== '';
  const kept = useRef<ReactNode>(null),
    box = useRef<HTMLDivElement>(null),
    [, refresh] = useState(0);
  if (present) kept.current = children;
  const leaving = !present && kept.current !== null;
  useLayoutEffect(() => {
    if (!leaving) return;
    let live = true;
    const end = () => {
      if (!live) return;
      live = false;
      kept.current = null;
      refresh((count) => count + 1);
    };
    const exits = (box.current?.getAnimations({ subtree: true }) || []).filter(
      (animation) => animation instanceof CSSAnimation && EXIT.test(animation.animationName),
    );
    if (!exits.length) {
      end();
      return;
    }
    const timer = setTimeout(end, EXIT_LIMIT_MS);
    void Promise.allSettled(exits.map((animation) => animation.finished)).then(end);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [leaving]);
  if (!present && !leaving) return null;
  return (
    <div ref={box} className="motion-presence" data-leaving={leaving || undefined} inert={leaving}>
      {present ? children : kept.current}
    </div>
  );
}
