import { useRef, useState } from 'react';

type Handlers = Record<string, (...args: never[]) => unknown>;

/**
 * Functions that keep their identity across renders and call the latest of `handlers`. Passing them instead of inline
 * callbacks lets memoized children skip renders. The set of names is fixed by the first render.
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [stable] = useState(
    () =>
      Object.fromEntries(
        Object.keys(handlers).map((name) => [
          name,
          (...args: never[]) => (latest.current[name] as (...args: never[]) => unknown)(...args),
        ]),
      ) as T,
  );
  return stable;
}
