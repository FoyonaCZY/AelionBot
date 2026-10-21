import { createContext, useCallback, useContext, useRef, useState, useMemo, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { nextPinNumber } from '../../shared/preview/preview-annotations';
import type { PreviewAnnotation } from '../../shared/types/preview-editor-types';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import type { ArtifactPreview } from '../../shared/types/core';
import { FilePreview } from './FilePreview';
import {
  WorkbenchContext,
  type PreviewWorkbenchInfo,
  type PreviewChatInput,
  type PreviewAnnotationControls,
} from './PreviewWorkbench';
export interface PreviewItem {
  designSessionId?: string;
  deviceFrame?: 'phone' | 'slide' | 'page';
  id: string;
  name: string;
  size: number;
  workspace?: { botId: string; path: string };
  directoryBotId?: string;
  load: () => Promise<ArtifactPreview>;
  save?: () => Promise<unknown>;
  openInComputer?: () => Promise<unknown>;
  editor?: {
    read: () => Promise<import('../../shared/chat/editable-text').EditableText>;
    write?: (
      edit: import('../../shared/chat/editable-text').TextEdit,
    ) => Promise<import('../../shared/chat/editable-text').EditableText>;
  };
}
export type PreviewGuard = (proceed: () => void) => void;
export type RegisterPreviewGuard = (guard: PreviewGuard) => () => void;
interface PreviewOptions {
  expanded?: boolean;
  scope?: AttachmentScope | null;
  /** Pins a Bot placed with preview_mark on the item being opened. */
  marks?: PreviewAnnotation[];
}
type PinCache = Record<string, PreviewAnnotation[]>;
/**
 * Adds a Bot's pins to an item's cached pins, numbered after those already there. A web page reads them as its own;
 * a file preview takes them from the pending list when their page is shown.
 */
function withBotPins(cache: PinCache = {}, itemId: string, marks: PreviewAnnotation[]): PinCache {
  const web = 'web:' + itemId,
    pending = 'pending:' + itemId,
    existing = Object.entries(cache)
      .filter(([key]) => key === web || key === pending || key.startsWith(itemId + ':'))
      .flatMap(([, value]) => value);
  let next = nextPinNumber(existing);
  const numbered = marks.map((mark) => ({ ...mark, n: next++ }));
  return { ...cache, [web]: [...(cache[web] || []), ...numbered], [pending]: [...(cache[pending] || []), ...numbered] };
}
interface Session {
  closed?: boolean;
  annotationCache?: PinCache;
  items: PreviewItem[];
  index: number;
  expanded?: boolean;
  scope?: AttachmentScope;
  generation: number;
}
const scopeKey = (scope?: AttachmentScope) => (scope ? scope.kind + ':' + scope.id : '');
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};
const Context = createContext<((items: PreviewItem[], index?: number, options?: PreviewOptions) => void) | undefined>(
  undefined,
);
const ScopeContext = createContext<AttachmentScope | undefined>(undefined);
export const usePreviewScope = () => useContext(ScopeContext);
export function PreviewScopeProvider({ scope, children }: { scope?: AttachmentScope; children: ReactNode }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}
export function useFilePreview() {
  const open = useContext(Context),
    scope = usePreviewScope();
  return useMemo(
    () =>
      open
        ? (items: PreviewItem[], index = 0, options?: PreviewOptions) =>
            open(items, index, { ...options, scope: options && 'scope' in options ? options.scope : scope })
        : undefined,
    [open, scope],
  );
}
export function FilePreviewProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(),
    [info, setInfo] = useState<PreviewWorkbenchInfo>();
  const generation = useRef(0),
    guard = useRef<PreviewGuard | undefined>(undefined),
    current = useRef<Session | undefined>(undefined),
    activeScope = useRef(''),
    cache = useRef(new Map<string, Session>()),
    sender = useRef<((input: PreviewChatInput) => Promise<unknown>) | undefined>(undefined),
    marks = useRef<PreviewAnnotationControls | undefined>(undefined);
  current.current = session;
  const show = (next?: Session) => {
    const apply = () => {
      setInfo(undefined);
      setSession(next ? { ...next, generation: ++generation.current } : undefined);
    };
    const transition = (document as ViewTransitionDocument).startViewTransition;
    if (!transition || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      apply();
      return;
    }
    transition.call(document, () => flushSync(apply));
  };
  const navigate = useCallback((action: () => void) => {
    if (guard.current) guard.current(action);
    else action();
  }, []);
  const activate = useCallback((scope?: AttachmentScope) => {
    const key = scopeKey(scope);
    if (key === activeScope.current) return;
    if (current.current) cache.current.set(scopeKey(current.current.scope), current.current);
    activeScope.current = key;
    const saved = key ? cache.current.get(key) : undefined;
    show(saved?.closed ? undefined : saved);
  }, []);
  const close = useCallback(() => {
    if (current.current) cache.current.set(scopeKey(current.current.scope), { ...current.current, closed: true });
    show();
  }, []);
  const registerGuard = useCallback<RegisterPreviewGuard>((value) => {
    guard.current = value;
    return () => {
      if (guard.current === value) guard.current = undefined;
    };
  }, []);
  const registerSender = useCallback((value: (input: PreviewChatInput) => Promise<unknown>) => {
    sender.current = value;
    return () => {
      if (sender.current === value) sender.current = undefined;
    };
  }, []);
  const registerAnnotations = useCallback((value: PreviewAnnotationControls) => {
    marks.current = value;
    return () => {
      if (marks.current === value) marks.current = undefined;
    };
  }, []);
  const annotations = useMemo<PreviewAnnotationControls>(
    () => ({
      remove: (id) => marks.current?.remove(id),
      select: (id) => marks.current?.select(id),
      status: (updates) => marks.current?.status(updates),
    }),
    [],
  );
  const infoRef = useRef(info);
  infoRef.current = info;
  const send = useCallback(async (scope: AttachmentScope, input: PreviewChatInput) => {
    const view = infoRef.current;
    if (!input.text.trim() || !view?.docked || scopeKey(view.scope) !== scopeKey(scope) || !sender.current)
      return false;
    await sender.current({ ...input, scope });
    return true;
  }, []);
  const update = useCallback(
    (value: PreviewWorkbenchInfo) =>
      setInfo((previous) => (JSON.stringify(previous) === JSON.stringify(value) ? previous : value)),
    [],
  );
  const remember = useCallback(
    (value: {
      annotationCache?: Record<string, import('../../shared/types/preview-editor-types').PreviewAnnotation[]>;
      items: PreviewItem[];
      index: number;
      expanded: boolean;
    }) => {
      if (current.current) {
        Object.assign(current.current, value);
        cache.current.set(scopeKey(current.current.scope), current.current);
      }
    },
    [],
  );
  return (
    <WorkbenchContext.Provider
      value={{ info, activate, navigate, close, update, registerSender, send, registerAnnotations, annotations }}
    >
      <Context.Provider
        value={(items, index = 0, options) =>
          navigate(() => {
            const saved = cache.current.get(scopeKey(options?.scope || undefined))?.annotationCache,
              next: Session = {
                annotationCache:
                  options?.marks?.length && items[index] ? withBotPins(saved, items[index].id, options.marks) : saved,
                closed: false,
                items,
                index,
                expanded: options?.expanded,
                scope: options?.scope || undefined,
                generation: ++generation.current,
              };
            cache.current.set(scopeKey(next.scope), next);
            show(next);
          })
        }
      >
        {children}
        {session && (
          <ScopeContext.Provider value={session.scope}>
            <FilePreview
              key={session.generation}
              initialExpanded={session.expanded}
              feedbackScope={session.scope}
              initialAnnotations={session.annotationCache}
              items={session.items}
              initialIndex={session.index}
              registerGuard={registerGuard}
              onClose={close}
              onSessionChange={remember}
            />
          </ScopeContext.Provider>
        )}
      </Context.Provider>
    </WorkbenchContext.Provider>
  );
}
