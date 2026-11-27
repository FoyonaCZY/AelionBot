import type { JsonValue } from './json.js';

export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface TimeRange {
  readonly startUs: number;
  readonly durationUs: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly entityId?: string;
  readonly rangeUs?: TimeRange;
  readonly recoverable: boolean;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly cause?: unknown;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export function ok<T>(value: T, diagnostics: readonly Diagnostic[] = []): Result<T> {
  return { ok: true, value, diagnostics };
}

export function err<T = never>(...diagnostics: readonly Diagnostic[]): Result<T> {
  if (diagnostics.length === 0) {
    throw new TypeError('err() requires at least one diagnostic');
  }
  return { ok: false, diagnostics };
}

export class AelionError extends Error {
  public readonly diagnostics: readonly Diagnostic[];

  public constructor(diagnostics: readonly Diagnostic[]) {
    const first = diagnostics[0];
    super(first?.message ?? 'Aelion operation failed', { cause: first?.cause });
    this.name = 'AelionError';
    this.diagnostics = diagnostics;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  throw new AelionError([
    {
      code: 'OPERATION_ABORTED',
      severity: 'error',
      message: `${operation} was aborted`,
      recoverable: true,
      cause: reason,
    },
  ]);
}
