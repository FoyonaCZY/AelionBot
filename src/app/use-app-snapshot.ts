import { useEffect, useState } from 'react';
import type { Snapshot } from '../../shared/types/core';
import { ipcErrorText } from '../ui/ipc-error';

/**
 * The main-process snapshot, kept current by its event stream, and the selected bot id. The selection
 * falls back to the first bot whenever the selected one disappears.
 */
export function useAppSnapshot(onError: (message: string) => void) {
  const [state, setState] = useState<Snapshot>(),
    [selected, setSelected] = useState('');
  useEffect(() => {
    if (!window.aelion) return;
    window.aelion
      .snapshot()
      .then((value) => {
        setState(value);
        setSelected(value.messages.at(-1)?.botId || value.bots[0]?.id || '');
      })
      .catch((error) => onError(ipcErrorText(error)));
    return window.aelion.onEvent((event) =>
      setState((previous) =>
        event.type === 'streams'
          ? previous && { ...previous, streamingReplies: event.streamingReplies }
          : event.snapshot,
      ),
    );
  }, []);
  useEffect(() => {
    if (!state || state.bots.some((item) => item.id === selected)) return;
    setSelected(state.bots[0]?.id || '');
  }, [state?.bots, selected]);
  return { state, selected, setSelected };
}
