import { useEffect, useRef, useState } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import { ipcErrorText } from '../ui/ipc-error';

/**
 * Decides whether a selection missing from the bot list should fall back to the first bot. A selection
 * made against `selectedAgainst` may name a bot that only the next snapshot will list: createBot resolves
 * before the main process sends that snapshot. So it only falls back once a newer snapshot still lacks it.
 */
export function selectionFallback(bots: Bot[], selected: string, selectedAgainst: Bot[] | undefined) {
  if (bots.some((item) => item.id === selected)) return undefined;
  if (selected && bots === selectedAgainst) return undefined;
  return bots[0]?.id || '';
}

/**
 * The main-process snapshot, kept current by its event stream, and the selected bot id. The selection
 * falls back to the first bot whenever the selected one disappears.
 */
export function useAppSnapshot(onError: (message: string) => void) {
  const [state, setState] = useState<Snapshot>(),
    [selected, setSelected] = useState('');
  const last = useRef<{ selected: string; bots?: Bot[] }>({ selected: '' });
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
    if (!state) return;
    // A changed selection is judged against the snapshot it was made on; an unchanged one against the new snapshot.
    const selectedAgainst = selected === last.current.selected ? last.current.bots : state.bots;
    last.current = { selected, bots: state.bots };
    const fallback = selectionFallback(state.bots, selected, selectedAgainst);
    if (fallback !== undefined && fallback !== selected) setSelected(fallback);
  }, [state?.bots, selected]);
  return { state, selected, setSelected };
}
