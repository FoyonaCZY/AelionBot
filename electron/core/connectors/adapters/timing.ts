// Timing shared by the adapters that speak plain HTTP and WebSocket: a wait that ends early when the adapter stops,
// and a "typing…" cue kept up between the outbox's requests.

/** Resolves after `ms`, or at once when `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * A cue that lasts a few seconds on the platform (Telegram five, Discord ten). The outbox asks for it now and then
 * while a run works; this sends it again in between, and stops soon after the outbox stops asking.
 */
export class TypingCue {
  private cues = new Map<string, { until: number; timer: ReturnType<typeof setInterval> }>();
  constructor(
    private send: (chatId: string) => Promise<unknown>,
    private everyMs: number,
    private keptMs = 15_000,
  ) {}
  /** Shows the cue now and keeps it up for `keptMs`, or lets it run out. */
  async set(chatId: string, active: boolean) {
    const cue = this.cues.get(chatId);
    if (!active) {
      if (cue) clearInterval(cue.timer);
      this.cues.delete(chatId);
      return;
    }
    const until = Date.now() + this.keptMs;
    if (cue) {
      cue.until = until;
      return;
    }
    const timer = setInterval(() => {
      const current = this.cues.get(chatId);
      if (current?.timer !== timer) return clearInterval(timer);
      if (Date.now() > current.until) {
        clearInterval(timer);
        this.cues.delete(chatId);
        return;
      }
      void this.send(chatId).catch(() => {});
    }, this.everyMs);
    timer.unref?.();
    this.cues.set(chatId, { until, timer });
    await this.send(chatId);
  }
  clear() {
    for (const cue of this.cues.values()) clearInterval(cue.timer);
    this.cues.clear();
  }
}
