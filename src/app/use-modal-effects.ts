import { useEffect } from 'react';
import { ipcErrorText } from '../ui/ipc-error';
import type { Modal } from './AppModals';

/**
 * Window-level effects of the open dialog: the work-computer view makes the window fullscreen, and Escape
 * closes the dialog except while the user holds manual control of the computer.
 */
export function useModalEffects(input: {
  modal: Modal;
  controlled: boolean;
  onEscape: () => void;
  onError: (message: string) => void;
}) {
  const { modal, controlled, onEscape, onError } = input;
  useEffect(() => {
    if (!window.aelion) return;
    void window.aelion.setComputerFullscreen(modal === 'computer').catch((error) => onError(ipcErrorText(error)));
    return () => {
      void window.aelion.setComputerFullscreen(false).catch(() => {});
    };
  }, [modal]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && modal && !(modal === 'computer' && controlled)) onEscape();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [modal, controlled]);
}
