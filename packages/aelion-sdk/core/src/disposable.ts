export interface Disposable {
  readonly disposed: boolean;
  dispose(): void | Promise<void>;
}

export class DisposableStack implements Disposable {
  readonly #entries: (() => void | Promise<void>)[] = [];
  #disposed = false;
  #disposeTask: Promise<void> | undefined;

  public get disposed(): boolean {
    return this.#disposed;
  }

  public use<T extends Disposable>(value: T): T {
    if (this.#disposed) {
      throw new ReferenceError('Cannot add a resource to a disposed stack');
    }
    this.#entries.push(() => value.dispose());
    return value;
  }

  public defer(callback: () => void | Promise<void>): void {
    if (this.#disposed) {
      throw new ReferenceError('Cannot add a callback to a disposed stack');
    }
    this.#entries.push(callback);
  }

  public dispose(): Promise<void> {
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    const errors: unknown[] = [];

    for (const entry of this.#entries.reverse()) {
      try {
        await entry();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#entries.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more resources failed to dispose');
    }
  }
}
