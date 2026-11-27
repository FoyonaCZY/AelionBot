import type { StreamTargetChunk } from 'mediabunny';

export interface MemorySinkSnapshot {
  readonly writes: number;
  readonly bytesWritten: number;
  readonly finalSize: number;
  readonly maxInFlightWrites: number;
  readonly closed: boolean;
  readonly aborted: boolean;
}

export class SeekableMemorySink {
  readonly #chunks: StreamTargetChunk[] = [];
  #writes = 0;
  #bytesWritten = 0;
  #inFlightWrites = 0;
  #maxInFlightWrites = 0;
  #closed = false;
  #aborted = false;

  public readonly writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => {
      if (this.#closed) throw new Error('SeekableMemorySink is closed');
      this.#inFlightWrites += 1;
      this.#maxInFlightWrites = Math.max(this.#maxInFlightWrites, this.#inFlightWrites);
      try {
        this.#chunks.push({
          type: 'write',
          data: chunk.data.slice(),
          position: chunk.position,
        });
        this.#writes += 1;
        this.#bytesWritten += chunk.data.byteLength;
      } finally {
        this.#inFlightWrites -= 1;
      }
    },
    close: () => {
      this.#closed = true;
    },
    abort: () => {
      this.cleanup();
    },
  });

  public finalize(): Uint8Array {
    if (!this.#closed) throw new Error('SeekableMemorySink is not finalized');
    const finalSize = this.#chunks.reduce((size, chunk) => Math.max(size, chunk.position + chunk.data.byteLength), 0);
    const result = new Uint8Array(finalSize);
    for (const chunk of this.#chunks) result.set(chunk.data, chunk.position);
    return result;
  }

  public cleanup(): void {
    this.#closed = true;
    this.#aborted = true;
    this.#chunks.length = 0;
  }

  public snapshot(): MemorySinkSnapshot {
    const finalSize = this.#chunks.reduce((size, chunk) => Math.max(size, chunk.position + chunk.data.byteLength), 0);
    return {
      writes: this.#writes,
      bytesWritten: this.#bytesWritten,
      finalSize,
      maxInFlightWrites: this.#maxInFlightWrites,
      closed: this.#closed,
      aborted: this.#aborted,
    };
  }
}
