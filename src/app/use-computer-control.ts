import { useEffect, useRef, useState } from 'react';
import type { Bot, InteractionRequest, Snapshot } from '../../shared/types/core';
import { computerDesktopReady } from '../computer/computer-setup-state';
import { ipcErrorText } from '../ui/ipc-error';

export type TakeoverRequest = Extract<InteractionRequest, { kind: 'vm_takeover' }>;

/**
 * The work computer as the selected bot sees it: which bot's desktop is shown, whether the user holds
 * manual control, and a single-flight runner for control actions so repeated clicks cannot interleave.
 */
export function useComputerControl(
  state: Snapshot | undefined,
  bot: Bot | undefined,
  onError: (message: string) => void,
) {
  const [controlPending, setControlPending] = useState(false),
    controlBusy = useRef(false);
  const [computerBotId, setComputerBotId] = useState('');
  const vmReady = state?.vm.status === 'ready' && !state.vm.operationPending,
    desktopAvailable = Boolean(state && computerDesktopReady(state.vm));
  const desktopBot = state?.bots.find((item) => item.id === computerBotId) || bot;
  const desktop = state?.computer.desktops?.[desktopBot?.id || ''];
  const controlled = desktop?.manualControl || false;
  const takeover = (state?.interactions || []).find(
    (request): request is TakeoverRequest => request.kind === 'vm_takeover' && request.botId === desktopBot?.id,
  );
  const computerAction = async (operation: () => Promise<unknown>) => {
    if (controlBusy.current) return;
    controlBusy.current = true;
    setControlPending(true);
    try {
      await operation();
    } catch (error) {
      onError(ipcErrorText(error));
    } finally {
      controlBusy.current = false;
      setControlPending(false);
    }
  };
  const toggleComputerControl = () =>
    computerAction(async () => {
      if (!desktopBot) return;
      if (takeover)
        await window.aelion.respondInteraction({
          id: takeover.id,
          action: controlled && takeover.phase === 'controlling' ? 'resume' : 'takeover',
        });
      else await window.aelion.setComputerControl({ botId: desktopBot.id, enabled: !controlled });
    });
  useEffect(() => {
    if (bot) setComputerBotId(bot.id);
  }, [bot?.id]);
  useEffect(() => {
    if (!desktopBot || desktopBot.type === 'designer' || !desktopAvailable) return;
    let active = true;
    void window.aelion.ensureComputerDesktop(desktopBot.id).catch((error) => {
      if (active) onError(ipcErrorText(error));
    });
    return () => {
      active = false;
    };
  }, [desktopBot?.id, desktopBot?.type, desktopAvailable, state?.vm.pid]);
  return {
    vmReady,
    desktopAvailable,
    desktopBot,
    desktop,
    controlled,
    takeover,
    controlPending,
    computerAction,
    toggleComputerControl,
    setComputerBotId,
  };
}
