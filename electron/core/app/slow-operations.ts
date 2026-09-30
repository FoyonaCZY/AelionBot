import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Work on the main process longer than this holds up scrolling, clicks and typing noticeably. */
const SLOW_OPERATION_MS = 50;
/** Each source is recorded at most once per REPORT_INTERVAL_MS, with how many slow runs it had meanwhile. */
const REPORT_INTERVAL_MS = 10_000;

/**
 * Records main-process operations that took longer than SLOW_OPERATION_MS into the diagnostic log, rate-limited per
 * source so a slow path running every 150 ms does not flood it.
 */
export function slowOperations(record: (source: string, message: string) => void, now = () => Date.now()) {
  const last = new Map<string, { at: number; skipped: number; worst: number }>();
  return (source: string, ms: number, detail = '') => {
    if (ms < SLOW_OPERATION_MS) return;
    const time = now(),
      seen = last.get(source);
    if (seen && time - seen.at < REPORT_INTERVAL_MS) {
      seen.skipped++;
      seen.worst = Math.max(seen.worst, ms);
      return;
    }
    const earlier = seen?.skipped ? `; ${seen.skipped} more since last report, worst ${Math.round(seen.worst)} ms` : '';
    last.set(source, { at: time, skipped: 0, worst: 0 });
    record('slow.' + source, `${Math.round(ms)} ms${detail ? ' ' + detail : ''}${earlier}`);
  };
}

/** Reports the longest event-loop stall every interval, whatever caused it. Returns a stop function. */
export function watchEventLoop(report: (source: string, ms: number) => void, intervalMs = REPORT_INTERVAL_MS) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const timer = setInterval(() => {
    report('event-loop', histogram.max / 1e6);
    histogram.reset();
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
