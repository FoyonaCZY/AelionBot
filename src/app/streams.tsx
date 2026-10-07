import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { StreamingReply } from '../../shared/types/core';
import { sameItems } from '../ui/equality';

/** Who is streaming, for avatar activity: it changes only when a reply starts or ends. */
export type StreamOwner = Pick<StreamingReply, 'botId' | 'runId'>;

// Live replies change every ~100 ms while a model streams. They are held in React state, so a delta and the live
// replies it ends land in one render, and published to subscribers right after that render commits (a layout effect,
// so before the frame is painted): a component re-renders only when the replies it selects changed.
class StreamStore {
  value: StreamingReply[] = [];
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  publish(value: StreamingReply[]) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}
const Store = createContext(new StreamStore());
const SetStreams = createContext<(streams: StreamingReply[]) => void>(() => {});

export function StreamsProvider({ children }: { children: ReactNode }) {
  const [streams, setStreams] = useState<StreamingReply[]>([]),
    [store] = useState(() => new StreamStore());
  useLayoutEffect(() => store.publish(streams), [streams]);
  return (
    <SetStreams.Provider value={setStreams}>
      <Store.Provider value={store}>{children}</Store.Provider>
    </SetStreams.Provider>
  );
}

export const useSetStreamingReplies = () => useContext(SetStreams);

/**
 * The live replies `select` keeps, re-rendering only when they change. `key` names the selection: a new key (another
 * bot, another run) selects again.
 */
export function useStreamingReplies(key: string, select: (reply: StreamingReply) => boolean) {
  const store = useContext(Store),
    cache = useRef<{ key?: string; source?: StreamingReply[]; result: StreamingReply[] }>({ result: [] });
  return useSyncExternalStore(store.subscribe, () => {
    const current = cache.current;
    if (current.key === key && current.source === store.value) return current.result;
    const next = store.value.filter(select),
      result = current.key === key && sameItems(next, current.result) ? current.result : next;
    cache.current = { key, source: store.value, result };
    return result;
  });
}

/** Who is streaming; the same array until a reply starts or ends. */
export function useStreamOwners() {
  const store = useContext(Store),
    cache = useRef<{ source?: StreamingReply[]; signature: string; owners: StreamOwner[] }>({
      signature: '',
      owners: [],
    });
  return useSyncExternalStore(store.subscribe, () => {
    const current = cache.current;
    if (current.source === store.value) return current.owners;
    const signature = store.value.map((reply) => reply.botId + '\u0000' + (reply.runId || '')).join('\u0001');
    cache.current = {
      source: store.value,
      signature,
      owners:
        signature === current.signature ? current.owners : store.value.map(({ botId, runId }) => ({ botId, runId })),
    };
    return cache.current.owners;
  });
}
