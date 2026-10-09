import { useEffect, useSyncExternalStore } from 'react';
import type { RunRecord } from '../../shared/types/core';
import type { DesignSession } from '../../shared/types/designer-types';

/**
 * The design task a conversation is working on, shown on the canvas card under the computer card. Messages sent
 * while a task is active carry its id, so the Bot continues that task. Closing the canvas ends the association; a
 * later run that binds a task (the Bot called design_start or design_use) brings the canvas back.
 */
export type CanvasScope = { kind: 'bot'; id: string; sessionId?: string } | { kind: 'group'; id: string };

const ACTIVE_KEY = 'aelion-design-active';
const listeners = new Set<() => void>();
const read = <T>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
/** Per conversation: the active task and the last run whose binding was already shown (so closing sticks). */
let active: Record<string, { id?: string; seenRun?: string }> = read(ACTIVE_KEY, {});
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const scopeKey = (scope: CanvasScope) =>
  scope.kind === 'group' ? 'group:' + scope.id : 'bot:' + scope.id + (scope.sessionId ? ':' + scope.sessionId : '');

/** Design tasks that belong to this conversation: a group's own, or the Bot's private ones. */
export const sessionInScope = (session: DesignSession, scope: CanvasScope) =>
  scope.kind === 'group'
    ? session.origin.kind === 'group' && session.origin.id === scope.id
    : session.botId === scope.id && session.origin.kind === 'bot';

const runInScope = (run: RunRecord, scope: CanvasScope) =>
  scope.kind === 'group'
    ? run.groupOrigin?.groupId === scope.id
    : run.botId === scope.id &&
      !run.groupOrigin &&
      !run.peerOrigin &&
      (run.sessionId || '') === (scope.sessionId || '');

/** The most recent run of this conversation that was bound to a design task. */
function latestDesignRun(runs: RunRecord[], scope: CanvasScope) {
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    if (run.designSessionId && runInScope(run, scope)) return run;
  }
}

export function activeDesignId(scope: CanvasScope) {
  return active[scopeKey(scope)]?.id;
}
export function setActiveDesign(scope: CanvasScope, id: string | undefined, seenRun?: string) {
  const key = scopeKey(scope),
    previous = active[key];
  active = { ...active, [key]: { id, seenRun: seenRun ?? previous?.seenRun } };
  if (!id) delete active[key].id;
  // Keep the record small: conversations are few, but each run id is long.
  const keys = Object.keys(active);
  if (keys.length > 200) for (const old of keys.slice(0, keys.length - 200)) delete active[old];
  write(ACTIVE_KEY, active);
  emit();
}
export function useActiveDesignId(scope: CanvasScope | undefined) {
  const key = scope ? scopeKey(scope) : '';
  return useSyncExternalStore(
    subscribe,
    () => (key ? active[key]?.id : undefined),
    () => undefined,
  );
}

/**
 * Follows the Bot: when a run of this conversation binds a design task it has not shown yet, that task becomes the
 * active one and its canvas card appears. A task that no longer exists is dropped.
 */
export function useFollowDesignRuns(
  scope: CanvasScope | undefined,
  runs: RunRecord[] | undefined,
  sessions: DesignSession[] | undefined,
  onShown?: () => void,
) {
  const key = scope ? scopeKey(scope) : '';
  const latest = scope && runs ? latestDesignRun(runs, scope) : undefined;
  const current = useActiveDesignId(scope);
  useEffect(() => {
    if (!scope) return;
    if (current && sessions && !sessions.some((s) => s.id === current && sessionInScope(s, scope)))
      setActiveDesign(scope, undefined);
    if (!latest || active[key]?.seenRun === latest.id) return;
    if (!sessions?.some((s) => s.id === latest.designSessionId && sessionInScope(s, scope))) return;
    setActiveDesign(scope, latest.designSessionId, latest.id);
    onShown?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope is identified by its key
  }, [key, latest?.id, latest?.designSessionId, current, sessions]);
}

/** Ends the association; the latest bound run counts as shown so it does not reopen the canvas. */
export function closeActiveDesign(scope: CanvasScope, runs: RunRecord[]) {
  setActiveDesign(scope, undefined, latestDesignRun(runs, scope)?.id);
}
