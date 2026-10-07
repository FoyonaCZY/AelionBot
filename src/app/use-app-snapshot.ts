import { startTransition, useEffect, useRef, useState } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import { applyStateDelta, share } from '../../shared/state-sync';
import { ipcErrorText } from '../ui/ipc-error';
import { useSetStreamingReplies } from './streams';

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
 * The main-process state, kept current by its stream of deltas, and the selected bot id. The selection
 * falls back to the first bot whenever the selected one disappears.
 */
export function useAppSnapshot(onError: (message: string) => void) {
  const [state, setState] = useState<Snapshot>(),
    [selected, setSelected] = useState('');
  const setStreams = useSetStreamingReplies();
  const last = useRef<{ selected: string; bots?: Bot[] }>({ selected: '' });
  useEffect(() => {
    if (!window.aelion) return;
    // Deltas apply in order to the newest state, whatever React has rendered so far.
    let current: { seq: number; state: Snapshot } | undefined,
      loading = false,
      first = true,
      disposed = false;
    const load = () => {
      if (loading) return;
      loading = true;
      window.aelion
        .readState()
        .then((base) => {
          if (disposed) return;
          current = { seq: base.seq, state: share(current?.state, base.snapshot) };
          const next = current.state;
          startTransition(() => {
            setState(next);
            setStreams(base.streams);
          });
          if (first) setSelected(next.messages.at(-1)?.botId || next.bots[0]?.id || '');
          first = false;
        })
        .catch((error) => onError(ipcErrorText(error)))
        .finally(() => (loading = false));
    };
    load();
    const stop = window.aelion.onEvent((event) => {
      if (event.type === 'streams') {
        setStreams(event.streamingReplies);
        return;
      }
      if (!current) return;
      const { delta } = event;
      // A delta against another state (one sent while the base was being read) cannot apply: read it again.
      if (delta.from !== current.seq) return load();
      current = { seq: delta.seq, state: applyStateDelta(current.state, delta) };
      const next = current.state;
      // A delta re-renders what it changed. As a transition that render yields to typing, clicks and scrolling;
      // live replies change in the same render, so a finished reply turns into its message without a gap.
      startTransition(() => {
        setState(next);
        if (delta.streams) setStreams(delta.streams);
      });
    });
    return () => {
      disposed = true;
      stop();
    };
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
