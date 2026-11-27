import type { Diagnostic } from '@aelionsdk/core';

import type { RenderIr } from './types.js';

export type IrTransferFunction = 'srgb' | 'gamma22' | 'pq' | 'hlg';
export type IrOutputBitDepth = 8 | 10;

export interface ColorPipelineCapability {
  readonly workingColorSpaces: ReadonlySet<string>;
  readonly colorPrimaries: ReadonlySet<RenderIr['colorPrimaries']>;
  readonly transferFunctions: ReadonlySet<IrTransferFunction>;
  readonly matrixCoefficients: ReadonlySet<RenderIr['matrixCoefficients']>;
  readonly colorRanges: ReadonlySet<RenderIr['colorRange']>;
  readonly chromaSubsamplings: ReadonlySet<RenderIr['chromaSubsampling']>;
  readonly alphaModes: ReadonlySet<RenderIr['alphaMode']>;
  readonly toneMappings: ReadonlySet<RenderIr['toneMapping']>;
  readonly bitDepths: ReadonlySet<IrOutputBitDepth>;
  readonly hdrPresentation: boolean;
}

export interface ColorPipelineReport {
  readonly ok: boolean;
  readonly issues: readonly Diagnostic[];
}

export function validateColorPipelineContract(ir: RenderIr): void {
  const transfer = ir.transferFunction;
  const bitDepth = ir.bitDepth;
  const expectedPrimaries =
    ir.workingColorSpace === 'display-p3-linear'
      ? 'display-p3'
      : ir.workingColorSpace === 'rec2020-linear'
        ? 'bt2020'
        : 'bt709';
  if (ir.colorPrimaries !== expectedPrimaries) {
    throw new TypeError('COLOR_PRIMARIES_WORKING_SPACE_MISMATCH');
  }
  if ((transfer === 'pq' || transfer === 'hlg') && ir.workingColorSpace !== 'rec2020-linear') {
    throw new TypeError('COLOR_HDR_REQUIRES_REC2020');
  }
  if ((transfer === 'pq' || transfer === 'hlg') && bitDepth !== 10) {
    throw new TypeError('COLOR_HDR_REQUIRES_10_BIT');
  }
  if (ir.toneMapping !== 'none' && transfer !== 'pq' && transfer !== 'hlg') {
    throw new TypeError('COLOR_TONE_MAPPING_REQUIRES_HDR_INPUT');
  }
  if (ir.chromaSubsampling === 'rgb' && ir.matrixCoefficients !== 'rgb') {
    throw new TypeError('COLOR_RGB_REQUIRES_RGB_MATRIX');
  }
}

export function preflightColorPipeline(ir: RenderIr, capability: ColorPipelineCapability): ColorPipelineReport {
  validateColorPipelineContract(ir);
  const issues: Diagnostic[] = [];
  const transfer = ir.transferFunction;
  const bitDepth = ir.bitDepth;
  if (!capability.workingColorSpaces.has(ir.workingColorSpace)) {
    issues.push({
      code: 'COLOR_WORKING_SPACE_UNSUPPORTED',
      severity: 'error',
      message: `Working color space ${ir.workingColorSpace} is unavailable`,
      recoverable: true,
    });
  }
  if (!capability.transferFunctions.has(transfer)) {
    issues.push({
      code: 'COLOR_TRANSFER_FUNCTION_UNSUPPORTED',
      severity: 'error',
      message: `Transfer function ${transfer} is unavailable`,
      recoverable: true,
    });
  }
  const requireDimension = <TValue extends string>(
    code: string,
    label: string,
    value: TValue,
    supportedValues: ReadonlySet<TValue>,
  ): void => {
    if (supportedValues.has(value)) return;
    issues.push({
      code,
      severity: 'error',
      message: `${label} ${value} is unavailable`,
      recoverable: true,
    });
  };
  requireDimension('COLOR_PRIMARIES_UNSUPPORTED', 'color primaries', ir.colorPrimaries, capability.colorPrimaries);
  requireDimension(
    'COLOR_MATRIX_UNSUPPORTED',
    'matrix coefficients',
    ir.matrixCoefficients,
    capability.matrixCoefficients,
  );
  requireDimension('COLOR_RANGE_UNSUPPORTED', 'color range', ir.colorRange, capability.colorRanges);
  requireDimension(
    'COLOR_CHROMA_UNSUPPORTED',
    'chroma subsampling',
    ir.chromaSubsampling,
    capability.chromaSubsamplings,
  );
  requireDimension('COLOR_ALPHA_UNSUPPORTED', 'alpha mode', ir.alphaMode, capability.alphaModes);
  requireDimension('COLOR_TONE_MAPPING_UNSUPPORTED', 'tone mapping', ir.toneMapping, capability.toneMappings);
  if (!capability.bitDepths.has(bitDepth)) {
    issues.push({
      code: 'COLOR_BIT_DEPTH_UNSUPPORTED',
      severity: 'error',
      message: `${bitDepth.toString()}-bit output is unavailable`,
      recoverable: true,
    });
  }
  if ((transfer === 'pq' || transfer === 'hlg') && !capability.hdrPresentation) {
    issues.push({
      code: 'COLOR_HDR_PRESENTATION_UNSUPPORTED',
      severity: 'error',
      message: 'The active output surface cannot present HDR',
      recoverable: true,
    });
  }
  return { ok: issues.length === 0, issues };
}

export const LOCAL_RGBA8_COLOR_CAPABILITY: ColorPipelineCapability = {
  workingColorSpaces: new Set(['srgb-linear']),
  colorPrimaries: new Set(['bt709']),
  transferFunctions: new Set(['srgb']),
  matrixCoefficients: new Set(['rgb']),
  colorRanges: new Set(['full']),
  chromaSubsamplings: new Set(['rgb', '4:4:4']),
  alphaModes: new Set(['opaque', 'premultiplied']),
  toneMappings: new Set(['none']),
  bitDepths: new Set([8]),
  hdrPresentation: false,
};
