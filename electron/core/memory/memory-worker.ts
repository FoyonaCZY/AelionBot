import type { RunRecord } from '../../../shared/types/core';
import type { CognitiveStore } from './cognitive-store';
import type { Conversation, MemoryCapture } from './memory-capture';
import type { MemoryConsolidator } from './memory-consolidate';
import type { MemoryVectors } from './memory-embedder';
import type { MemoryService } from './memory-service';

export interface MemoryWorkerOptions {
  /** How long a conversation stays quiet before its new part is read. */
  idleMs?: number;
  /** How long nothing has run before memory is consolidated. */
  consolidateIdleMs?: number;
}
/** After this long a busy computer no longer holds capture back; a request of its own still preempts it. */
const MAX_WAIT_MS = 10 * 60000;
const ENOUGH_MESSAGES = 30;

/** Schedules the background work on memory, one piece at a time, always yielding to work in the foreground. */
export class MemoryWorker {
  private waiting = new Map<string, { conversation: Conversation; firstAt: number; lastAt: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;
  private controller?: AbortController;
  private working?: Promise<void>;
  private closing = false;
  private lastForegroundAt = Date.now();
  private idleMs: number;
  private consolidateIdleMs: number;
  vectors?: MemoryVectors;
  constructor(
    private storage: CognitiveStore,
    private memory: MemoryService,
    private capture: MemoryCapture,
    private consolidator: MemoryConsolidator,
    private enabled: () => boolean,
    private foregroundBusy: () => boolean,
    private changed: () => void,
    /** A conversation was read: skill reviews held for it go ahead or are dropped. */
    private settled: (botId: string, skillWorthy: boolean) => void,
    options: MemoryWorkerOptions = {},
  ) {
    this.idleMs = options.idleMs ?? 90000;
    this.consolidateIdleMs = options.consolidateIdleMs ?? 5 * 60000;
  }
  start() {
    for (const conversation of this.capture.unfinished()) this.mark(conversation, Date.now() - this.idleMs);
    this.schedule(5000);
  }
  /** A run ended. Its conversation is read once it has been quiet for a while. */
  note(run: RunRecord) {
    const conversation = this.capture.conversationOf(run);
    if (conversation) this.mark(conversation, Date.now());
    this.lastForegroundAt = Date.now();
    this.schedule(this.idleMs);
  }
  mark(conversation: Conversation, at = Date.now()) {
    const entry = this.waiting.get(conversation.key);
    if (entry) entry.lastAt = at;
    else this.waiting.set(conversation.key, { conversation, firstAt: at, lastAt: at });
  }
  preempt() {
    this.lastForegroundAt = Date.now();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.controller?.abort();
    for (const entry of this.waiting.values()) entry.lastAt = Date.now();
    // Not every preemption ends in a run that reports back: a model change or an update does not.
    this.schedule(60000);
  }
  schedule(delay = this.idleMs) {
    if (this.closing || this.working || !this.enabled()) return;
    // A long wait with nothing to do gives way to work that has just appeared.
    if (this.timer) {
      if (this.timerAt <= Date.now() + delay) return;
      clearTimeout(this.timer);
    }
    this.timerAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.working = this.drain().finally(() => {
        this.working = undefined;
      });
    }, delay);
    this.timer.unref?.();
  }
  get busy() {
    return Boolean(this.controller);
  }
  get queued() {
    return this.waiting.size;
  }
  /** Does one piece of the work that is due, then arranges for the next. */
  async drain() {
    if (this.closing || !this.enabled() || this.controller) return;
    const now = Date.now(),
      controller = (this.controller = new AbortController());
    let next = 60000;
    try {
      const entry = this.dueConversation(now);
      if (entry) next = await this.readConversation(entry, controller.signal);
      else if (this.foregroundBusy()) next = 30000;
      else if (!(await this.idleWork(now, controller.signal))) next = this.waiting.size ? 15000 : 10 * 60000;
      else next = 1000;
    } catch {
      next = controller.signal.aborted ? 15000 : 30000;
    } finally {
      this.controller = undefined;
      this.changed();
      if (!this.closing) {
        // Reschedules from inside the job that is still finishing.
        queueMicrotask(() => {
          this.working = undefined;
          this.schedule(next);
        });
      }
    }
  }
  private dueConversation(now: number) {
    for (const entry of this.waiting.values()) {
      const quiet = now - entry.lastAt >= this.idleMs,
        waitedLong = now - entry.firstAt >= MAX_WAIT_MS,
        cursor = this.storage.items.cursor(entry.conversation.key);
      if (cursor?.retry_at && Date.parse(cursor.retry_at) > now) continue;
      if (this.foregroundBusy() && !waitedLong) continue;
      if (quiet || waitedLong || this.capture.stretch(entry.conversation).entries.length >= ENOUGH_MESSAGES)
        return entry;
    }
    return undefined;
  }
  private async readConversation(
    entry: { conversation: Conversation; firstAt: number; lastAt: number },
    signal: AbortSignal,
  ) {
    const { conversation } = entry;
    // Not learning from a conversation means its stretch is passed over for good, not saved for later.
    if (this.memory.mode(conversation.botId, conversation.key) !== 'on') {
      const stretch = this.capture.stretch(conversation);
      if (stretch.through)
        this.storage.items.setCursor(conversation.key, conversation.botId, stretch.through.time, stretch.through.id);
      this.waiting.delete(conversation.key);
      this.settled(conversation.botId, false);
      return 1000;
    }
    const result = await this.capture.run(conversation, signal);
    if (!result.more) {
      this.waiting.delete(conversation.key);
      this.settled(conversation.botId, result.skillWorthy);
    } else if (result.skillWorthy) this.settled(conversation.botId, true);
    return result.more ? 3000 : 1000;
  }
  /** What can wait until nothing is running: tidying up, then filling in vectors. */
  private async idleWork(now: number, signal: AbortSignal) {
    if (now - this.lastForegroundAt < this.consolidateIdleMs) return false;
    this.consolidator.maintain(now);
    const scope = this.consolidator.due(now);
    if (scope) {
      await this.consolidator.run(scope, signal);
      return true;
    }
    return Boolean(await this.vectors?.indexBatch(signal));
  }
  /** Reads a conversation from its beginning, for the 「look back over past conversations」 request. */
  readPast(conversations: Conversation[]) {
    for (const conversation of conversations) {
      this.storage.items.setCursor(conversation.key, conversation.botId, '');
      this.mark(conversation, 0);
    }
    this.schedule(1000);
  }
  async close() {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.working;
  }
}
