import type { JsonObject, JsonValue, Rational } from '@aelionsdk/core';
import type { WebGl2MaterialProgram } from '@aelionsdk/material-compiler';
import type { TimeRange } from '@aelionsdk/project-schema';

export interface IrMaterialDefinition {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly packageIntegrity: string;
  readonly materialId: string;
}

export interface IrMaterialInstance {
  readonly id: string;
  readonly definition: IrMaterialDefinition;
  readonly enabled: boolean;
  readonly previewPolicy: 'required' | 'skippable-when-degraded';
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly resourceBindings: Readonly<Record<string, JsonValue>>;
  readonly inputBindings: Readonly<Record<string, JsonValue>>;
  readonly program?: WebGl2MaterialProgram;
}

export type MaterialProgramResolver = (
  definition: IrMaterialDefinition,
  parameters: Readonly<Record<string, JsonValue>>,
) => WebGl2MaterialProgram | undefined;

export interface RenderCompileOptions {
  readonly affectedRanges?: RenderIrCompilation['stats']['affectedRanges'];
  readonly affectedEntityIds?: readonly string[];
  readonly resolveMaterialProgram?: MaterialProgramResolver;
  /** @internal Recursive compiler stack used to diagnose nested Sequence cycles. */
  readonly nestedSequenceStack?: readonly string[];
}

export interface IrLinearTimeMapping {
  readonly type: 'linear';
  readonly rate: Rational;
  readonly reverse: boolean;
}

export interface IrCurveTimeMapPoint {
  readonly itemTimeUs: number;
  /** Absolute normalized source presentation time. */
  readonly sourceTimeUs: number;
  readonly interpolation: 'linear' | 'hold' | 'cubic';
}

export interface IrCurveTimeMapping {
  readonly type: 'curve';
  readonly points: readonly IrCurveTimeMapPoint[];
}

export type IrTimeMapping = IrLinearTimeMapping | IrCurveTimeMapping;

export interface IrMediaSource {
  readonly assetId: string;
  readonly streamType: 'video' | 'audio';
  readonly streamIndex: number;
  readonly sourceRange: TimeRange;
  readonly timeMapping?: IrTimeMapping;
  /** @deprecated Compatibility projection for legacy hand-authored linear IR. */
  readonly rate?: Rational;
  /** @deprecated Compatibility projection for legacy hand-authored linear IR. */
  readonly reverse?: boolean;
  readonly boundary: 'error' | 'hold' | 'loop' | 'transparent';
  /** Immutable frame manifest compiled from an image-sequence Asset. */
  readonly imageSequence?: {
    readonly frameDurationUs: number;
    readonly frameAssetIds: readonly string[];
  };
}

export interface IrBaseClip {
  readonly id: string;
  readonly trackId: string;
  readonly range: TimeRange;
  readonly enabled: boolean;
  readonly materialInstanceIds: readonly string[];
  readonly dependencyEntityIds: readonly string[];
  readonly fingerprint: string;
}

export interface IrVisualClip extends IrBaseClip {
  readonly kind: 'visual-clip';
  readonly source: IrMediaSource;
  readonly visual: IrVisualProperties;
}

export interface IrTextBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface IrTextRun {
  readonly text: string;
  readonly style: JsonObject;
}

export interface IrTextParagraph {
  readonly style: JsonObject;
  readonly runs: readonly IrTextRun[];
}

export interface IrTextClip extends IrBaseClip {
  readonly kind: 'text-clip';
  readonly role: 'text' | 'caption';
  readonly box: IrTextBox;
  readonly overflow: 'clip' | 'ellipsis' | 'visible' | 'auto-fit';
  readonly writingMode: 'horizontal-tb' | 'vertical-rl' | 'vertical-lr';
  readonly paragraphs: readonly IrTextParagraph[];
  readonly visual: IrVisualProperties;
}

export interface IrNestedSequenceSource {
  readonly sequenceId: string;
  readonly sourceRange: TimeRange;
  readonly timeMapping: IrTimeMapping;
  readonly boundary: 'error' | 'hold' | 'loop' | 'transparent';
}

export interface IrNestedSequenceClip extends IrBaseClip {
  readonly kind: 'nested-sequence-clip';
  readonly source: IrNestedSequenceSource;
  readonly visual: IrVisualProperties;
}

export interface IrVec2 {
  readonly x: number;
  readonly y: number;
}

export interface IrVisualProperties {
  readonly fit: 'contain' | 'cover' | 'fill' | 'none';
  readonly transform: {
    readonly positionPx: IrVec2 | JsonObject;
    readonly anchor: IrVec2 | JsonObject;
    readonly scale: IrVec2 | JsonObject;
    readonly rotationDeg: number | JsonObject;
    readonly skewDeg: IrVec2 | JsonObject;
  };
  readonly crop: JsonObject;
  readonly opacity: number | JsonObject;
  readonly blendMode: string;
  readonly mask?: {
    readonly sourceItemId: string;
    readonly channel: 'alpha' | 'luma';
    readonly invert: boolean;
    readonly featherPx: number;
    readonly space: 'source' | 'canvas';
    readonly consumeSource: boolean;
  };
}

export interface IrGeneratorClip extends IrBaseClip {
  readonly kind: 'generator-clip';
  readonly generator: JsonObject;
  readonly visual: IrVisualProperties;
}

export interface IrShapeClip extends IrBaseClip {
  readonly kind: 'shape-clip';
  readonly shape: JsonObject;
  readonly visual: IrVisualProperties;
}

export interface IrMaterialContentClip extends IrBaseClip {
  readonly kind: 'material-content-clip';
  readonly materialInstanceId: string;
  readonly visual: IrVisualProperties;
}

export interface IrAdjustmentClip extends IrBaseClip {
  readonly kind: 'adjustment-clip';
  readonly visual: IrVisualProperties;
}

export interface IrAudioClip extends IrBaseClip {
  readonly kind: 'audio-clip';
  readonly source: IrMediaSource;
  readonly audio: JsonObject;
}

export type IrClip =
  | IrVisualClip
  | IrTextClip
  | IrNestedSequenceClip
  | IrGeneratorClip
  | IrShapeClip
  | IrMaterialContentClip
  | IrAdjustmentClip
  | IrAudioClip;

export interface IrTrack {
  readonly id: string;
  readonly kind: 'visual' | 'audio' | 'caption';
  readonly enabled: boolean;
  /** Track-level mixer state. Present for audio tracks compiled from Project v1. */
  readonly audio?: JsonObject;
  readonly clips: readonly IrClip[];
  readonly materialInstanceIds: readonly string[];
  readonly fingerprint: string;
}

export interface IrTransition {
  readonly id: string;
  readonly trackId: string;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly range: TimeRange;
  readonly materialInstanceId: string;
  readonly dependencyEntityIds: readonly string[];
  readonly fingerprint: string;
}

export interface RenderIr {
  readonly irVersion: '1.0.0';
  readonly projectId: string;
  readonly sequenceId: string;
  readonly revision: bigint;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly sampleRate: number;
  readonly channelLayout: string;
  readonly workingColorSpace: string;
  readonly colorPrimaries: 'bt709' | 'display-p3' | 'bt2020';
  readonly transferFunction: 'srgb' | 'gamma22' | 'pq' | 'hlg';
  readonly matrixCoefficients: 'rgb' | 'bt709' | 'bt2020-ncl';
  readonly colorRange: 'full' | 'limited';
  readonly chromaSubsampling: 'rgb' | '4:4:4' | '4:2:2' | '4:2:0';
  readonly alphaMode: 'opaque' | 'premultiplied';
  readonly toneMapping: 'none' | 'bt2390' | 'reinhard';
  readonly bitDepth: 8 | 10;
  readonly backgroundColor?: JsonObject;
  readonly durationUs: number;
  readonly tracks: readonly IrTrack[];
  readonly transitions: readonly IrTransition[];
  readonly materials: Readonly<Record<string, IrMaterialInstance>>;
  /** Compiled nested Sequence graphs; absent only in legacy hand-authored IR. */
  readonly subgraphs?: Readonly<Record<string, RenderIr>>;
}

export interface CompileStats {
  readonly compiledClips: number;
  readonly reusedClips: number;
  readonly compiledTransitions: number;
  readonly reusedTransitions: number;
  readonly affectedRanges: readonly {
    readonly sequenceId: string;
    readonly startUs: number;
    readonly durationUs: number;
  }[];
}

export interface RenderIrCompilation {
  readonly ir: RenderIr;
  readonly stats: CompileStats;
}

export interface ActiveVisualState {
  readonly timeUs: number;
  readonly clips: readonly {
    readonly clip:
      | IrVisualClip
      | IrTextClip
      | IrNestedSequenceClip
      | IrGeneratorClip
      | IrShapeClip
      | IrMaterialContentClip
      | IrAdjustmentClip;
    readonly sourceTimeUs: number | null;
    readonly materials: readonly IrMaterialInstance[];
  }[];
  readonly transition?: {
    readonly transition: IrTransition;
    readonly progress: number;
    readonly material: IrMaterialInstance;
  };
}

export interface EvaluatedMaterialInstance {
  readonly id: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly resourceBindings: Readonly<Record<string, JsonValue>>;
  readonly inputBindings: Readonly<Record<string, JsonValue>>;
}

export interface ActiveAudioState {
  readonly startUs: number;
  readonly durationUs: number;
  readonly clips: readonly {
    readonly clip: IrAudioClip;
    readonly sourceStartUs: number;
    readonly sequenceStartUs: number;
    readonly durationUs: number;
    readonly gain: number;
    readonly pan: number;
    readonly trackAudio: JsonObject;
  }[];
}
