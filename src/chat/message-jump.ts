import { useEffect, useRef } from 'react';

/** A chat a jump can land in: a Bot's main chat, one of its work sessions, or a group. */
type JumpScope = { kind: 'bot'; id: string; sessionId?: string } | { kind: 'group'; id: string };

export const jumpScopeKey = (scope: JumpScope) =>
  scope.kind === 'group' ? 'group:' + scope.id : scope.sessionId ? 'session:' + scope.sessionId : 'bot:' + scope.id;

// The message a search result asked for. The chat that shows it may not be open yet, so the request waits here
// until the chat with that scope takes it.
let pending: { scope: string; messageId: string } | undefined;
const listeners = new Set<() => void>();

/** Asks the chat `scope` to show one of its messages, now or as soon as it opens. */
export function jumpToMessage(scope: JumpScope, messageId: string) {
  pending = { scope: jumpScopeKey(scope), messageId };
  for (const listener of listeners) listener();
}

/** Gives the open chat (`scope`, from jumpScopeKey) the message it was asked to show; `show` gets its ID once. */
export function useMessageJump(scope: string, show: (messageId: string) => void) {
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => {
    const take = () => {
      if (pending?.scope !== scope) return;
      const { messageId } = pending;
      pending = undefined;
      latest.current(messageId);
    };
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, [scope]);
}
