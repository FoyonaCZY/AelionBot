import { useEffect, useRef } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import { computerSetupDismissalKey, shouldOfferComputerSetup } from '../computer/computer-setup-state';

/**
 * Opens the computer setup dialog once per work-computer state that needs it, but only while the user is
 * looking at a plain conversation, and never again after they dismissed it for that state.
 */
export function useComputerSetupOffer(input: {
  state?: Snapshot;
  bot?: Bot;
  page: 'chat' | 'plugins';
  modal: unknown;
  peerPanel: unknown;
  groupEditor?: string;
  taskModalOpen: boolean;
  onOffer: () => void;
}) {
  const { state, page, modal, peerPanel, groupEditor, taskModalOpen, onOffer } = input;
  const setupPrompted = useRef('');
  useEffect(() => {
    if (!state || page !== 'chat' || modal || peerPanel || groupEditor || taskModalOpen) return;
    const offer = computerSetupDismissalKey(state.dataDir, state.vm);
    if (setupPrompted.current === offer) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(offer) === 'dismissed';
    } catch {}
    if (!shouldOfferComputerSetup(state.vm, dismissed)) return;
    setupPrompted.current = offer;
    onOffer();
  }, [state?.dataDir, state?.vm.status, state?.vm.appsReady, modal, peerPanel, groupEditor, taskModalOpen, page]);
}
