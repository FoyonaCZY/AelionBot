import type { StreamTargetChunk } from 'mediabunny';

export interface SinkCompletionBarrier {
  readonly writable: WritableStream<StreamTargetChunk>;
  readonly completion: Promise<void>;
  abort(reason: unknown): void;
}

export function createSinkCompletionBarrier(sink: WritableStream<StreamTargetChunk>): SinkCompletionBarrier {
  const stream = new TransformStream<StreamTargetChunk, StreamTargetChunk>();
  const controller = new AbortController();
  const completion = stream.readable.pipeTo(sink, { signal: controller.signal });
  // A muxer or Worker may surface the same sink failure before its host-side
  // pipe is awaited. Keep the rejection observed until the caller handles it.
  void completion.catch(() => undefined);
  return {
    writable: stream.writable,
    completion,
    abort: (reason) => controller.abort(reason),
  };
}
