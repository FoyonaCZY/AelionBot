import type { BrowserWindow, Streams } from 'electron';

/**
 * Lets the app's page hear what the computer is playing, for the conversation rail that moves with it (the
 * appearance setting is off by default). The page asks through getDisplayMedia, which must also carry a video track:
 * it gets the page itself, which it stops at once, so no screen is captured and no picker shows. Only the window's own
 * page is answered. macOS asks the person once for System Audio Recording; where the system has no loopback the
 * audio track never starts and the rail stays still.
 */
export function allowSystemAudio(window: BrowserWindow) {
  const contents = window.webContents;
  contents.session.setDisplayMediaRequestHandler((request, callback) => {
    const page = contents.isDestroyed() ? undefined : contents.mainFrame,
      frame = request.frame;
    if (
      !page ||
      !frame ||
      frame.processId !== page.processId ||
      frame.routingId !== page.routingId ||
      !request.audioRequested
    ) {
      // Null turns the request down (Electron's d.ts does not list it yet).
      (callback as (streams: Streams | null) => void)(null);
      return;
    }
    callback({ video: page, audio: 'loopback' });
  });
}
