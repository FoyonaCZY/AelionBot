import { useState, useSyncExternalStore } from 'react';
import type { ComposerDraft } from '../chat/BotComposer';

const EMPTY: ComposerDraft = Object.freeze({ text: '', mentions: [] }) as ComposerDraft;

/**
 * Unsent composer drafts keyed by conversation id, kept while the user switches conversations. A keystroke changes a
 * draft many times a second, so drafts live outside React state: only the composer showing a draft subscribes to it
 * (useDraft), and actions such as sending read it when they run.
 */
function createDrafts() {
  let drafts: Record<string, ComposerDraft> = {};
  const listeners = new Set<() => void>();
  const update = (change: (value: Record<string, ComposerDraft>) => Record<string, ComposerDraft>) => {
    const next = change(drafts);
    if (next === drafts) return;
    drafts = next;
    for (const listener of listeners) listener();
  };
  return {
    get: (id: string): ComposerDraft => drafts[id] || EMPTY,
    set: (id: string, draft: ComposerDraft) => update((value) => ({ ...value, [id]: draft })),
    update,
    remove: (id: string) =>
      update((value) => {
        if (!(id in value)) return value;
        const next = { ...value };
        delete next[id];
        return next;
      }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function useDrafts() {
  const [drafts] = useState(createDrafts);
  return drafts;
}

/** The draft of one conversation; re-renders only when that draft changes. */
export function useDraft(drafts: Drafts, id: string) {
  return useSyncExternalStore(drafts.subscribe, () => drafts.get(id));
}

export type Drafts = ReturnType<typeof createDrafts>;
