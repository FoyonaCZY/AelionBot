// Answers phones' direct connections in a hidden window (see remote-direct-preload.ts), made on the first offer.
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import type { DirectCandidate, DirectHandlers, DirectPeers } from '../core/remote/direct';

const ANSWER_MS = 15_000;

export class DirectWindow implements DirectPeers {
  private window?: BrowserWindow;
  private ready?: Promise<BrowserWindow>;
  private readonly handlers = new Map<string, DirectHandlers>();
  private readonly answers = new Map<string, (result: { sdp?: string; error?: string }) => void>();

  constructor(private readonly preload: string) {
    const from = (event: IpcMainEvent) => event.sender === this.window?.webContents;
    ipcMain.on('remote-direct:answered', (event, input: { id: string; sdp?: string; error?: string }) => {
      if (from(event)) this.answers.get(input.id)?.(input);
    });
    ipcMain.on('remote-direct:candidate', (event, input: { id: string; candidate: DirectCandidate }) => {
      if (from(event)) this.handlers.get(input.id)?.candidate(input.candidate);
    });
    ipcMain.on('remote-direct:open', (event, input: { id: string }) => {
      if (from(event)) this.handlers.get(input.id)?.open();
    });
    ipcMain.on('remote-direct:frame', (event, input: { id: string; data: Uint8Array }) => {
      if (from(event) && input.data instanceof Uint8Array) this.handlers.get(input.id)?.frame(input.data);
    });
    ipcMain.on('remote-direct:close', (event, input: { id: string }) => {
      if (!from(event)) return;
      const handlers = this.handlers.get(input.id);
      this.handlers.delete(input.id);
      handlers?.close();
    });
  }

  private open() {
    return (this.ready ??= (async () => {
      const window = new BrowserWindow({
        show: false,
        width: 200,
        height: 200,
        webPreferences: {
          preload: this.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          partition: 'aelion-remote-direct',
        },
      });
      window.on('closed', () => {
        this.window = undefined;
        this.ready = undefined;
        for (const [id, handlers] of this.handlers) {
          this.handlers.delete(id);
          handlers.close();
        }
      });
      this.window = window;
      await window.loadURL('about:blank');
      return window;
    })());
  }

  async answer(id: string, sdp: string, iceServers: Array<{ urls: string }>, handlers: DirectHandlers) {
    const window = await this.open();
    this.handlers.set(id, handlers);
    const result = await new Promise<{ sdp?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ error: '直连没有建立' }), ANSWER_MS);
      this.answers.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      window.webContents.send('remote-direct:answer', { id, sdp, iceServers });
    });
    this.answers.delete(id);
    if (!result.sdp) {
      this.close(id);
      throw new Error(result.error || '直连没有建立');
    }
    return result.sdp;
  }

  candidate(id: string, candidate: DirectCandidate) {
    this.window?.webContents.send('remote-direct:candidate', { id, candidate });
  }
  send(id: string, data: Uint8Array) {
    this.window?.webContents.send('remote-direct:send', { id, data });
  }
  close(id: string) {
    if (!this.handlers.delete(id)) return;
    this.window?.webContents.send('remote-direct:close', { id });
  }
  dispose() {
    this.handlers.clear();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}
