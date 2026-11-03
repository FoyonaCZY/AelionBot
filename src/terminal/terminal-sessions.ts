import { useSyncExternalStore } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import { workspaceKey } from '../../shared/types/work-types';
import { translate } from '../i18n';

const FONT_FAMILY = "'JetBrains Mono Variable', 'Noto Sans SC Variable', Consolas, monospace",
  FONT_SIZE = 13;

interface Session {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  started: boolean;
}
/** One xterm per conversation, kept here rather than in React so its scrollback survives hiding the panel. */
const sessions = new Map<string, Session>(),
  shown = new Set<string>(),
  running = new Set<string>(),
  directories = new Map<string, string>(),
  listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener()),
  subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
function createSession(id: string) {
  const term = new Terminal({
      cursorBlink: true,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      scrollback: 5000,
      theme: { background: '#1c1c1f', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#4a4a52' },
    }),
    fit = new FitAddon(),
    element = document.createElement('div');
  element.className = 'floating-terminal-screen';
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey) || event.altKey) return true;
    const key = event.key.toLowerCase();
    // Without a selection Ctrl+C stays an interrupt. Returning false for paste leaves it to the browser's paste event.
    if (key === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    return key !== 'v';
  });
  term.onData((text) => void window.aelion.writeTerminal({ id, text }));
  term.onResize(({ cols, rows }) => void window.aelion.resizeTerminal({ id, cols, rows }));
  const session: Session = { term, fit, element, started: false };
  sessions.set(id, session);
  return session;
}
function forget(id: string) {
  const session = sessions.get(id);
  sessions.delete(id);
  shown.delete(id);
  running.delete(id);
  directories.delete(id);
  session?.term.dispose();
  session?.element.remove();
  emit();
}
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.aelion.onTerminalEvent((event) => {
    if (event.type === 'data') sessions.get(event.id)?.term.write(event.data);
    else forget(event.id);
  });
}
/** Shows the conversation's terminal in `container`, starting its shell the first time. */
export async function attachTerminal(scope: AttachmentScope, container: HTMLElement) {
  listen();
  const id = workspaceKey(scope);
  // xterm measures its cell once, so a font still loading would leave the columns misaligned.
  await document.fonts.load(`${FONT_SIZE}px 'JetBrains Mono Variable'`, 'M').catch(() => {});
  if (!container.isConnected || !shown.has(id)) return;
  const session = sessions.get(id) || createSession(id);
  container.append(session.element);
  if (!session.term.element) session.term.open(session.element);
  session.fit.fit();
  session.term.focus();
  if (session.started) return;
  session.started = true;
  try {
    const { cwd } = await window.aelion.openTerminal({ scope, cols: session.term.cols, rows: session.term.rows });
    // Ended while the shell was starting: the close request followed this one, so nothing is left running.
    if (sessions.get(id) !== session) return;
    directories.set(id, cwd);
    running.add(id);
    emit();
  } catch (error) {
    session.started = false;
    const message = (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    session.term.writeln(`\x1b[31m${translate(message)}\x1b[0m`);
  }
}
export const fitTerminal = (id: string) => sessions.get(id)?.fit.fit();
export function showTerminal(id: string, next: boolean) {
  if (next) shown.add(id);
  else shown.delete(id);
  emit();
}
export function endTerminal(id: string) {
  void window.aelion.closeTerminal(id);
  forget(id);
}
export function useTerminalState(id: string) {
  return {
    shown: useSyncExternalStore(subscribe, () => shown.has(id)),
    running: useSyncExternalStore(subscribe, () => running.has(id)),
    cwd: useSyncExternalStore(subscribe, () => directories.get(id)),
  };
}
