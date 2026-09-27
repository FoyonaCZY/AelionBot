import { useEffect } from 'react';

/** Closes an open popup menu on Escape or on a pointer press outside the element matching `anchor`. */
export function useDismissableMenu(open: boolean, anchor: string, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!(event.target as HTMLElement)?.closest(anchor)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);
}
