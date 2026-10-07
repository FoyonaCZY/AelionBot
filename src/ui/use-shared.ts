import { useRef } from 'react';
import { share } from '../../shared/state-sync';

/**
 * Returns `value`, or the previous render's value (and its unchanged parts) when they are deep-equal. For small
 * derived objects rebuilt on every state change, so memoized consumers keep skipping renders when nothing changed.
 */
export function useShared<T>(value: T): T {
  const previous = useRef(value);
  previous.current = share(previous.current, value);
  return previous.current;
}
