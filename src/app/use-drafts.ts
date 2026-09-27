import { useState } from 'react';
import type { ComposerDraft } from '../chat/BotComposer';

/** Unsent composer drafts keyed by conversation id, kept while the user switches conversations. */
export function useDrafts() {
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const get = (id: string): ComposerDraft => drafts[id] || { text: '', mentions: [] };
  const set = (id: string, draft: ComposerDraft) => setDrafts((value) => ({ ...value, [id]: draft }));
  const remove = (id: string) =>
    setDrafts((value) => {
      const next = { ...value };
      delete next[id];
      return next;
    });
  return { get, set, update: setDrafts, remove };
}

export type Drafts = ReturnType<typeof useDrafts>;
