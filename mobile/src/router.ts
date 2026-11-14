// Screens are hash routes, so the relay or any static host can serve the app without server-side routing:
// #/ home, #/chat/<bot>[/<session>], #/group/<id>, #/computer/<bot>, #/files/<bot>, #/settings, #/pair.
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'chat'; botId: string; sessionId?: string }
  | { name: 'group'; id: string }
  | { name: 'computer'; botId: string }
  | { name: 'files'; botId: string }
  | { name: 'settings' }
  | { name: 'pair' };

function parseRoute(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    });
  const [name, first, second] = parts;
  if (name === 'chat' && first) return { name, botId: first, ...(second ? { sessionId: second } : {}) };
  if (name === 'group' && first) return { name, id: first };
  if (name === 'computer' && first) return { name, botId: first };
  if (name === 'files' && first) return { name, botId: first };
  if (name === 'settings' || name === 'pair') return { name };
  return { name: 'home' };
}

export const chatPath = (botId: string, sessionId?: string) =>
  '#/chat/' + encodeURIComponent(botId) + (sessionId ? '/' + encodeURIComponent(sessionId) : '');

/** Screens opened inside the app; going back past the first one (a notification opened the app on a chat) leads home. */
let depth = 0;
export function go(path: string, replace = false) {
  if (replace) location.replace(path.startsWith('#') ? path : '#' + path);
  else {
    depth++;
    location.hash = path;
  }
}

export function back() {
  if (depth > 0) {
    depth--;
    history.back();
  } else go('#/', true);
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

/**
 * Swiping right from the left edge goes back, as in native apps: a standalone web app on iOS has no browser gesture
 * for it. Returns touch handlers for the screen's root element.
 */
export function useEdgeBack(enabled = true) {
  const [offset, setOffset] = useState(0);
  const [start, setStart] = useState<{ x: number; y: number } | undefined>();
  return {
    offset,
    handlers: enabled
      ? {
          onTouchStart: (event: React.TouchEvent) => {
            const touch = event.touches[0];
            if (touch.clientX < 24) setStart({ x: touch.clientX, y: touch.clientY });
          },
          onTouchMove: (event: React.TouchEvent) => {
            if (!start) return;
            const touch = event.touches[0],
              dx = touch.clientX - start.x,
              dy = Math.abs(touch.clientY - start.y);
            if (dy > 40 && dx < 30) return setStart(undefined);
            setOffset(Math.max(0, dx));
          },
          onTouchEnd: () => {
            if (start && offset > 90) back();
            setStart(undefined);
            setOffset(0);
          },
        }
      : {},
  };
}
