// Electron prefixes errors thrown by an IPC handler; users only need the handler's own message.
export const ipcErrorText = (error: unknown) =>
  (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '');
