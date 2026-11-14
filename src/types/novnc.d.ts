declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    /** A WebSocket URL, or a WebSocket-like channel (the phone app tunnels the connection). */
    constructor(target: HTMLElement, url: string | WebSocket, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    background: string;
    disconnect(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
  }
}
