import { useSyncExternalStore } from 'react';

/**
 * The work computer and scheduled tasks float in a card over the conversation. Closing it is a layout choice the
 * user makes once, so it is remembered; the header shows a button to bring it back.
 */
const KEY = 'aelion-computer-card';
const listeners = new Set<() => void>();
let open = read(),
  online = false;
function read() {
  try {
    return localStorage.getItem(KEY) !== 'closed';
  } catch {
    return true;
  }
}
function emit() {
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function setComputerCardOpen(next: boolean) {
  if (next === open) return;
  open = next;
  try {
    localStorage.setItem(KEY, next ? 'open' : 'closed');
  } catch {}
  emit();
}
/** Set by the card itself so the header button can show that the desktop is live. */
export function setComputerCardOnline(next: boolean) {
  if (next === online) return;
  online = next;
  emit();
}
export function useComputerCard() {
  return {
    open: useSyncExternalStore(
      subscribe,
      () => open,
      () => true,
    ),
    online: useSyncExternalStore(
      subscribe,
      () => online,
      () => false,
    ),
  };
}
