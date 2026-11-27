export interface ResourceSnapshot {
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
}

export class ResourceTracker {
  readonly #counts = new Map<string, number>();

  public acquire(kind: string): () => void {
    if (kind.length === 0) throw new TypeError('Resource kind must not be empty');
    this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#counts.get(kind) ?? 0;
      if (current <= 1) this.#counts.delete(kind);
      else this.#counts.set(kind, current - 1);
    };
  }

  public snapshot(): ResourceSnapshot {
    const counts = Object.fromEntries([...this.#counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    return {
      counts,
      total: Object.values(counts).reduce((total, count) => total + count, 0),
    };
  }

  public assertReleased(): void {
    const snapshot = this.snapshot();
    if (snapshot.total !== 0) {
      throw new Error(`Aelion resource leak detected: ${JSON.stringify(snapshot.counts)}`);
    }
  }
}
