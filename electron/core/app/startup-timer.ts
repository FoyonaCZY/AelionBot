/**
 * Milestones of one launch, for the diagnostic log: how long after the process started each phase ended, so a slow
 * or stuck start can be located from a user's report. Times include Electron's own boot (process.uptime()).
 */
export class StartupTimer {
  private marks: Array<[string, number]> = [];
  constructor(private readonly now: () => number = () => process.uptime() * 1000) {}
  mark(phase: string) {
    if (!this.marks.some(([name]) => name === phase)) this.marks.push([phase, Math.round(this.now())]);
  }
  /** "state 0.9s, services 1.2s, …" in the order the phases ended. */
  report() {
    return this.marks.map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(', ');
  }
}
