import type { CapabilityProbe, CapabilityReport } from '@aelionsdk/capability';
import type { Diagnostic, JsonObject, JsonValue } from '@aelionsdk/core';

import type {
  AelionDiagnosticReport,
  AelionDiagnosticReportOptions,
  AelionSessionState,
  AelionSessionStats,
} from './types.js';

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object') {
    const result: JsonObject = {};
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined || typeof member === 'function' || typeof member === 'symbol') {
        continue;
      }
      result[key] = jsonValue(member);
    }
    return result;
  }
  if (typeof value === 'symbol') return value.description ?? '';
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  return null;
}

function safeDiagnostic(value: Diagnostic, full: boolean): JsonObject {
  return {
    code: value.code,
    severity: value.severity,
    recoverable: value.recoverable,
    ...(value.path === undefined ? {} : { path: jsonValue(value.path) }),
    ...(value.rangeUs === undefined ? {} : { rangeUs: jsonValue(value.rangeUs) }),
    ...(full
      ? {
          message: value.message,
          ...(value.entityId === undefined ? {} : { entityId: value.entityId }),
          ...(value.details === undefined ? {} : { details: jsonValue(value.details) }),
        }
      : {}),
  };
}

function safeProbe(value: CapabilityProbe): JsonObject {
  return {
    status: value.status,
    available: value.available,
  };
}

function capability(value: CapabilityReport | null, full: boolean): JsonObject | null {
  if (value === null) return null;
  if (full) return jsonValue(value) as JsonObject;
  return jsonValue({
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    tier: value.tier,
    codecs: value.codecs.map((codec) => ({
      id: codec.id,
      kind: codec.kind,
      codec: codec.codec,
      supported: codec.supported,
    })),
    gpu: {
      webgpu: safeProbe(value.gpu.webgpu),
      webgl2: safeProbe(value.gpu.webgl2),
      offscreenCanvas: safeProbe(value.gpu.offscreenCanvas),
      worker: safeProbe(value.gpu.worker),
    },
    audio: {
      audioContext: safeProbe(value.audio.audioContext),
      audioWorklet: safeProbe(value.audio.audioWorklet),
      sharedArrayBuffer: safeProbe(value.audio.sharedArrayBuffer),
    },
    storage: {
      opfs: safeProbe(value.storage.opfs),
      fileSystemAccess: safeProbe(value.storage.fileSystemAccess),
      transferableStreams: safeProbe(value.storage.transferableStreams),
    },
    color: {
      displayP3Gamut: safeProbe(value.color.displayP3Gamut),
      highDynamicRange: safeProbe(value.color.highDynamicRange),
      localExecution: value.color.localExecution,
    },
    wasm: { available: safeProbe(value.wasm.available) },
    environment: {
      secureContext: value.environment.secureContext,
      crossOriginIsolated: value.environment.crossOriginIsolated,
    },
  }) as JsonObject;
}

export function createAelionDiagnosticReport(input: {
  readonly state: AelionSessionState;
  readonly revision: bigint | null;
  readonly capability: CapabilityReport | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: AelionSessionStats;
  readonly media: JsonObject | null;
  readonly options?: AelionDiagnosticReportOptions;
}): AelionDiagnosticReport {
  const privacy = input.options?.privacy ?? 'safe';
  const full = privacy === 'full';
  return Object.freeze({
    schemaVersion: '1.0.0' as const,
    generatedAt: new Date().toISOString(),
    privacy,
    session: Object.freeze({
      state: input.state,
      revision: input.revision?.toString() ?? null,
    }),
    capability: capability(input.capability, full),
    diagnostics: Object.freeze(input.diagnostics.map((value) => safeDiagnostic(value, full))),
    stats: jsonValue(input.stats) as JsonObject,
    media: input.media === null ? null : (jsonValue(input.media) as JsonObject),
  });
}
