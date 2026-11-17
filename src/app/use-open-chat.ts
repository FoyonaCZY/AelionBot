import { useEffect, useRef } from 'react';
import type { ChatTarget } from '../../shared/types/notification-types';

/** Calls the newest `open` when a system notification is clicked. */
export function useOpenChat(open: (target: ChatTarget) => void) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => window.aelion?.onOpenChat((target) => latest.current(target)), []);
}
