import { useEffect, useSyncExternalStore } from 'react';
import {
  WIDGET_MAX_STATE_BYTES,
  isPlainObject,
  widgetScopeKey,
  type PinnedWidget,
  type WidgetScope,
} from '../../shared/types/widget-types';

const PANEL_KEY = 'aelion-pinned-widgets-panel';
const INLINE_KEY = 'aelion-inline-widget-states';
const MAX_INLINE_ENTRIES = 60;
const MAX_PANEL_ENTRIES = 200;

interface PanelScopeState {
  hidden?: boolean;
  activeId?: string;
  seenIds?: string[];
}

const listeners = new Set<() => void>();
const inlineListeners = new Set<() => void>();

const readStorage = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeStorage = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors cleanly.
  }
};

let panels: Record<string, PanelScopeState> = readStorage(PANEL_KEY, {});
let inlineStates: Record<string, { state: Record<string, unknown>; updatedAt: number }> = readStorage(INLINE_KEY, {});

const emitPanels = () => {
  for (const listener of listeners) listener();
};
const subscribePanels = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const emitInline = () => {
  for (const listener of inlineListeners) listener();
};
const subscribeInline = (listener: () => void) => {
  inlineListeners.add(listener);
  return () => inlineListeners.delete(listener);
};

function updatePanel(key: string, next: PanelScopeState) {
  const updated = { ...panels, [key]: next };
  const keys = Object.keys(updated);
  if (keys.length > MAX_PANEL_ENTRIES) {
    for (const old of keys.slice(0, keys.length - MAX_PANEL_ENTRIES)) delete updated[old];
  }
  panels = updated;
  writeStorage(PANEL_KEY, panels);
  emitPanels();
}

export function openPinnedWidget(scope: WidgetScope, widgetId?: string, knownIds?: string[]) {
  const key = widgetScopeKey(scope);
  const current = panels[key];
  const seen = new Set(current?.seenIds || []);
  if (widgetId) seen.add(widgetId);
  for (const id of knownIds || []) seen.add(id);
  updatePanel(key, {
    hidden: false,
    activeId: widgetId ?? current?.activeId,
    seenIds: [...seen],
  });
}

export function selectPinnedWidget(scope: WidgetScope, widgetId: string) {
  const key = widgetScopeKey(scope);
  const current = panels[key];
  const seen = new Set(current?.seenIds || []);
  seen.add(widgetId);
  updatePanel(key, {
    ...current,
    hidden: false,
    activeId: widgetId,
    seenIds: [...seen],
  });
}

export function closePinnedWidgetsCard(scope: WidgetScope, widgets: PinnedWidget[]) {
  const key = widgetScopeKey(scope);
  const current = panels[key];
  updatePanel(key, {
    ...current,
    hidden: true,
    seenIds: widgets.map((widget) => widget.id),
  });
}

export function usePinnedWidgetsState(scope: WidgetScope | undefined, widgets: PinnedWidget[]) {
  const key = scope ? widgetScopeKey(scope) : '';
  const entry = useSyncExternalStore(
    subscribePanels,
    () => (key ? panels[key] : undefined),
    () => undefined,
  );

  // When a new pinned widget arrives (e.g. Bot called `widget_save`), bring the card into view and focus it.
  const widgetIdsKey = widgets.map((widget) => widget.id).join(',');
  useEffect(() => {
    if (!key || !widgets.length) return;
    const current = panels[key];
    const seen = new Set(current?.seenIds || []);
    const unseen = widgets.filter((widget) => !seen.has(widget.id));
    if (unseen.length) {
      const latest = unseen.at(-1)!;
      updatePanel(key, {
        hidden: false,
        activeId: latest.id,
        seenIds: widgets.map((widget) => widget.id),
      });
    } else if (current?.activeId && !widgets.some((widget) => widget.id === current.activeId)) {
      updatePanel(key, {
        ...current,
        activeId: widgets.at(-1)?.id,
        seenIds: widgets.map((widget) => widget.id),
      });
    }
  }, [key, widgetIdsKey]);

  const activeWidget = widgets.find((widget) => widget.id === entry?.activeId) || widgets.at(-1) || undefined;
  const open = Boolean(widgets.length && !entry?.hidden);
  return { open, activeWidget };
}

export function inlineWidgetKey(scope: WidgetScope, messageId: string, index: number) {
  return `${widgetScopeKey(scope)}:${messageId}:${index}`;
}

export function useInlineWidgetState(key: string | undefined): Record<string, unknown> | undefined {
  return useSyncExternalStore(
    subscribeInline,
    () => (key ? inlineStates[key]?.state : undefined),
    () => undefined,
  );
}

export function setInlineWidgetState(key: string, state: Record<string, unknown>) {
  if (!isPlainObject(state)) return;
  try {
    const serialized = JSON.stringify(state);
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > WIDGET_MAX_STATE_BYTES) return;
    const clean = JSON.parse(serialized) as Record<string, unknown>;
    const updated = { ...inlineStates, [key]: { state: clean, updatedAt: Date.now() } };
    const entries = Object.entries(updated);
    if (entries.length > MAX_INLINE_ENTRIES) {
      entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [oldKey] of entries.slice(0, entries.length - MAX_INLINE_ENTRIES)) delete updated[oldKey];
    }
    inlineStates = updated;
    writeStorage(INLINE_KEY, inlineStates);
    emitInline();
  } catch {
    // Ignore non-serializable state.
  }
}
