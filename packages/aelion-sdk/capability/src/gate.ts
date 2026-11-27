import type { Diagnostic } from '@aelionsdk/core';

import type { CapabilityReport } from './types.js';

export interface CapabilityGateRequirements {
  /** Exact capability probe ids, for example `h264-decode-1080p30`. */
  readonly codecIds?: readonly string[];
  readonly gpu?: 'webgl2' | 'webgpu';
  readonly audioWorklet?: boolean;
  readonly opfs?: boolean;
  readonly sharedArrayBuffer?: boolean;
  readonly transferableStreams?: boolean;
  readonly secureContext?: boolean;
  readonly crossOriginIsolated?: boolean;
}

export interface CapabilityGateResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

function missing(code: string, message: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    recoverable: true,
  };
}

/**
 * Evaluates product requirements only from observed capability probes.
 * User-agent and platform strings are intentionally excluded from decisions.
 */
export function evaluateCapabilityGate(
  report: CapabilityReport,
  requirements: CapabilityGateRequirements,
): CapabilityGateResult {
  const diagnostics: Diagnostic[] = [];
  const codecs = new Map(report.codecs.map((codec) => [codec.id, codec]));
  for (const id of requirements.codecIds ?? []) {
    const codec = codecs.get(id);
    if (codec?.supported !== true) {
      diagnostics.push(
        missing(
          'CAPABILITY_GATE_CODEC_UNSUPPORTED',
          codec === undefined ? `Required codec probe ${id} is absent` : `Required codec probe ${id} is unsupported`,
        ),
      );
    }
  }

  if (requirements.gpu !== undefined && !report.gpu[requirements.gpu].available) {
    diagnostics.push(missing('CAPABILITY_GATE_GPU_UNSUPPORTED', `Required ${requirements.gpu} backend is unavailable`));
  }
  const booleanRequirements = [
    ['audioWorklet', requirements.audioWorklet, report.audio.audioWorklet.available],
    ['opfs', requirements.opfs, report.storage.opfs.available],
    ['sharedArrayBuffer', requirements.sharedArrayBuffer, report.audio.sharedArrayBuffer.available],
    ['transferableStreams', requirements.transferableStreams, report.storage.transferableStreams.available],
    ['secureContext', requirements.secureContext, report.environment.secureContext],
    ['crossOriginIsolated', requirements.crossOriginIsolated, report.environment.crossOriginIsolated],
  ] as const;
  for (const [name, required, available] of booleanRequirements) {
    if (required === true && !available) {
      diagnostics.push(
        missing('CAPABILITY_GATE_REQUIREMENT_UNSUPPORTED', `Required capability ${name} is unavailable`),
      );
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    diagnostics: Object.freeze(diagnostics),
  });
}
