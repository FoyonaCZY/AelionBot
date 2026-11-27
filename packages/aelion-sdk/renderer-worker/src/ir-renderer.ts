import { AelionError, type Disposable, type JsonValue, throwIfAborted } from '@aelionsdk/core';
import type { WebGl2MaterialProgram } from '@aelionsdk/material-compiler';
import {
  evaluateMaterialInstance,
  evaluateAnimatedValue,
  evaluateVisualState,
  cssColorWithAlpha,
  inflateTextBox,
  layoutIrText,
  LOCAL_RGBA8_COLOR_CAPABILITY,
  preflightColorPipeline,
  resolveMediaSourceFrame,
  textBackgroundVisible,
  textClipPaintExtent,
  type IrLaidOutTextLine,
  type IrMaterialInstance,
  type IrShapeClip,
  type IrTextClip,
  type PortableTextStyle,
  type RenderIr,
} from '@aelionsdk/render-ir';

import { WorkerCompositor, type ComposeFrameGraphOptions, type WorkerCompositorSnapshot } from './client.js';
import type {
  ComposeSuccess,
  FrameGraphInput,
  FrameGraphNode,
  RendererWorkerDiagnostic,
  RendererWorkerResourceSnapshot,
  RendererWorkerTiming,
} from './protocol.js';

export type RenderMode = 'preview' | 'export';

export interface IrFrameRequest {
  readonly purpose: RenderMode;
  readonly maxDimension: number;
}

export interface IrFrameSource {
  frameAt(
    assetId: string,
    streamIndex: number,
    sourceTimeUs: number,
    signal?: AbortSignal,
    request?: IrFrameRequest,
  ): Promise<VideoFrame>;
}

export interface RenderIrFrameOptions {
  readonly ir: RenderIr;
  readonly timeUs: number;
  readonly source: IrFrameSource;
  readonly mode: RenderMode;
  readonly preferredBackend?: 'auto' | 'webgpu' | 'webgl2';
  readonly allowFallback?: boolean;
  /** Preview-only output scale. Export always renders at full Project resolution. */
  readonly renderScale?: number;
  readonly signal?: AbortSignal;
}

export interface RenderIrFrameResult {
  /**
   * The composed frame, owned by the caller and closed by it.
   *
   * Composition produces an `ImageBitmap`. The preview bypass, which skips
   * composition when the decoded source already matches the frame, hands back
   * the decoded `VideoFrame` instead: every consumer either closes it, draws it
   * through `drawImage`, or wraps it in a `VideoFrame`, and all three accept
   * both. Converting one to the other would reintroduce the per-frame full-frame
   * copy the bypass exists to avoid. Read `width`/`height` from this result
   * rather than off the image -- the two types spell those differently.
   */
  readonly bitmap: ImageBitmap | VideoFrame;
  readonly backend: 'webgpu' | 'webgl2';
  readonly diagnostics?: readonly RendererWorkerDiagnostic[];
  /** Measured Worker and backend-completion time for this frame. */
  readonly timing?: RendererWorkerTiming;
  /** Transient resources after composition; the returned bitmap remains caller-owned. */
  readonly resources?: RendererWorkerResourceSnapshot;
  readonly materialIds: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly renderScale: number;
}

export interface RenderIrFrameRendererOptions {
  /** Maximum full frame evaluations in flight. Defaults to 2. */
  readonly maxPendingFrames?: number;
  /** Host-resolved renderer Worker URL. */
  readonly workerUrl?: string | URL;
}

export interface RenderIrFrameRendererSnapshot {
  readonly disposed: boolean;
  readonly pendingFrames: number;
  readonly maxPendingFrames: number;
  readonly adaptiveBackend: AdaptiveBackendSnapshot;
  readonly worker: WorkerCompositorSnapshot;
}

export interface AdaptiveBackendSnapshot {
  readonly selected: 'webgpu' | 'webgl2';
  readonly webgpuSamples: number;
  readonly webgl2Samples: number;
  readonly webgpuP95Us: number | null;
  readonly webgl2P95Us: number | null;
  readonly webgpuCooldownFrames: number;
}

interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  readonly detach: () => void;
}

function linkAbortSignals(first: AbortSignal | undefined, second: AbortSignal): LinkedAbortSignal {
  if (first === undefined) return { signal: second, detach: () => undefined };
  const controller = new AbortController();
  const abortFromFirst = (): void => controller.abort(first.reason);
  const abortFromSecond = (): void => controller.abort(second.reason);
  if (first.aborted) abortFromFirst();
  else if (second.aborted) abortFromSecond();
  else {
    first.addEventListener('abort', abortFromFirst, { once: true });
    second.addEventListener('abort', abortFromSecond, { once: true });
  }
  return {
    signal: controller.signal,
    detach: () => {
      first.removeEventListener('abort', abortFromFirst);
      second.removeEventListener('abort', abortFromSecond);
    },
  };
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

class AdaptiveBackendSelector {
  readonly #samples: Record<'webgpu' | 'webgl2', number[]> = {
    webgpu: [],
    webgl2: [],
  };
  #current: 'webgpu' | 'webgl2' = 'webgl2';
  #selectionCount = 0;
  #webgpuCooldownUntil = 0;

  public select(requested: RenderIrFrameOptions['preferredBackend'] = 'auto'): 'webgpu' | 'webgl2' {
    if (requested !== 'auto') return requested;
    this.#selectionCount += 1;
    this.#current = this.#selected(this.#current);
    return this.#current;
  }

  public record(
    requested: 'webgpu' | 'webgl2',
    result: Pick<ComposeSuccess, 'backend' | 'diagnostics' | 'timing'>,
  ): void {
    const samples = this.#samples[result.backend];
    samples.push(result.timing.totalWorkerUs);
    if (samples.length > 32) samples.shift();
    if (requested === 'webgpu' && result.backend !== 'webgpu') {
      this.#webgpuCooldownUntil = this.#selectionCount + 60;
    }
  }

  public snapshot(): AdaptiveBackendSnapshot {
    return {
      selected: this.#current,
      webgpuSamples: this.#samples.webgpu.length,
      webgl2Samples: this.#samples.webgl2.length,
      webgpuP95Us: percentile95(this.#samples.webgpu),
      webgl2P95Us: percentile95(this.#samples.webgl2),
      webgpuCooldownFrames: Math.max(0, this.#webgpuCooldownUntil - this.#selectionCount),
    };
  }

  #selected(current: 'webgpu' | 'webgl2'): 'webgpu' | 'webgl2' {
    if (this.#selectionCount < this.#webgpuCooldownUntil) return 'webgl2';
    if (this.#samples.webgl2.length < 3) return 'webgl2';
    if (this.#samples.webgpu.length < 3) return 'webgpu';
    const webgpuP95 = percentile95(this.#samples.webgpu) ?? Number.POSITIVE_INFINITY;
    const webgl2P95 = percentile95(this.#samples.webgl2) ?? Number.POSITIVE_INFINITY;
    const currentP95 = current === 'webgpu' ? webgpuP95 : webgl2P95;
    const challenger: 'webgpu' | 'webgl2' = current === 'webgpu' ? 'webgl2' : 'webgpu';
    const challengerP95 = challenger === 'webgpu' ? webgpuP95 : webgl2P95;
    return challengerP95 * 1.15 < currentP95 ? challenger : current;
  }
}

function requiredProgram(material: IrMaterialInstance, mode: RenderMode) {
  if (material.program !== undefined) return material.program;
  if (mode === 'preview' && material.previewPolicy === 'skippable-when-degraded') return undefined;
  throw new Error(`Material ${material.id} has no executable backend`);
}

/** Converts an owned compositor result and releases the source on every path. */
function takeBitmapFrame(bitmap: ImageBitmap | VideoFrame, timestampUs: number): VideoFrame {
  try {
    return new VideoFrame(bitmap, { timestamp: timestampUs });
  } finally {
    bitmap.close();
  }
}

async function presentationBitmap(frame: VideoFrame, signal: AbortSignal | undefined): Promise<ImageBitmap> {
  // A WebGL canvas exports premultiplied RGBA. Normalizing the public bitmap to
  // straight alpha prevents some headless Chromium/ANGLE paths from applying
  // alpha a second time when callers present it through Canvas 2D.
  const bitmap = await createImageBitmap(frame, { premultiplyAlpha: 'none' });
  try {
    throwIfAborted(signal, 'Render IR presentation');
    return bitmap;
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

const VISUAL_UNIFORM_IDS = [
  'positionX',
  'positionY',
  'anchorX',
  'anchorY',
  'scaleX',
  'scaleY',
  'rotationRad',
  'opacity',
  'outputWidth',
  'outputHeight',
  'cropLeft',
  'cropTop',
  'cropRight',
  'cropBottom',
] as const;

const BASE_VISUAL_UNIFORM_IDS = [...VISUAL_UNIFORM_IDS, 'fitMode', 'projectWidth', 'projectHeight'] as const;

const TEXT_VISUAL_UNIFORM_IDS = [...VISUAL_UNIFORM_IDS, 'contentX', 'contentY', 'contentW', 'contentH'] as const;

const BASE_VISUAL_PROGRAM: WebGl2MaterialProgram = {
  backend: 'webgl2',
  nodeSet: 'aelion.visual.builtin/1.0.0',
  graphHash: 'builtin-visual-transform-v6',
  inputPorts: ['source'],
  uniforms: BASE_VISUAL_UNIFORM_IDS.map((id) => ({
    name: `u_parameter_${id}`,
    type: 'float' as const,
    source: { kind: 'parameter' as const, id },
  })),
  executionPlan: {
    passes: [
      {
        id: 'builtin-visual-transform',
        kind: 'draw',
        nodes: ['builtin-visual-transform'],
        estimatedTextureSamples: 1,
      },
    ],
    intermediateTextureCount: 0,
  },
  fragmentShader: `#version 300 es
precision highp float;
uniform sampler2D u_input_source;
uniform float u_parameter_positionX;
uniform float u_parameter_positionY;
uniform float u_parameter_anchorX;
uniform float u_parameter_anchorY;
uniform float u_parameter_scaleX;
uniform float u_parameter_scaleY;
uniform float u_parameter_rotationRad;
uniform float u_parameter_opacity;
uniform float u_parameter_outputWidth;
uniform float u_parameter_outputHeight;
uniform float u_parameter_cropLeft;
uniform float u_parameter_cropTop;
uniform float u_parameter_cropRight;
uniform float u_parameter_cropBottom;
uniform float u_parameter_fitMode;
uniform float u_parameter_projectWidth;
uniform float u_parameter_projectHeight;
in vec2 v_uv;
out vec4 out_color;
void main() {
  // v_uv.y=0 is the bottom of the framebuffer. Convert to Y-down pixels so
  // rotation is a rigid 2D turn (not a UV-space squash) and +rotation is clockwise.
  vec2 size = vec2(max(u_parameter_outputWidth, 1.0), max(u_parameter_outputHeight, 1.0));
  vec2 projectSize = vec2(max(u_parameter_projectWidth, 1.0), max(u_parameter_projectHeight, 1.0));
  vec2 fragPx = vec2(v_uv.x * size.x, (1.0 - v_uv.y) * size.y);
  vec2 posPx = vec2(u_parameter_positionX, size.y - u_parameter_positionY);
  vec2 offsetPx = fragPx - posPx;
  float c = cos(u_parameter_rotationRad);
  float s = sin(u_parameter_rotationRad);
  vec2 rotatedPx = mat2(c, -s, s, c) * offsetPx;
  ivec2 tex = textureSize(u_input_source, 0);
  vec2 texSize = vec2(float(max(tex.x, 1)), float(max(tex.y, 1)));
  float sourceAspect = texSize.x / texSize.y;
  float destAspect = size.x / size.y;
  vec2 fitScale;
  if (u_parameter_fitMode > 2.5) {
    // none: preserve source pixel dimensions relative to project canvas (invariant to preview renderScale)
    fitScale = texSize / projectSize;
  } else if (u_parameter_fitMode > 1.5) {
    // fill: stretch to fill entire output frame
    fitScale = vec2(1.0, 1.0);
  } else if (u_parameter_fitMode > 0.5) {
    // cover: preserve aspect ratio while covering entire output frame (crop overflow)
    fitScale = sourceAspect > destAspect
      ? vec2(sourceAspect / destAspect, 1.0)
      : vec2(1.0, destAspect / sourceAspect);
  } else {
    // contain: preserve aspect ratio inside output frame
    fitScale = sourceAspect > destAspect
      ? vec2(1.0, destAspect / sourceAspect)
      : vec2(sourceAspect / destAspect, 1.0);
  }
  vec2 scalePx = vec2(u_parameter_scaleX, u_parameter_scaleY) * fitScale * size;
  if (abs(scalePx.x) < 1e-6 || abs(scalePx.y) < 1e-6) {
    out_color = vec4(0.0);
    return;
  }
  vec2 sourceYDown = rotatedPx / scalePx
    + vec2(u_parameter_anchorX, 1.0 - u_parameter_anchorY);
  vec2 sourceUv = vec2(sourceYDown.x, 1.0 - sourceYDown.y);
  vec2 cropMin = vec2(u_parameter_cropLeft, u_parameter_cropTop);
  vec2 cropMax = vec2(1.0 - u_parameter_cropRight, 1.0 - u_parameter_cropBottom);
  if (any(lessThan(sourceUv, cropMin)) || any(greaterThan(sourceUv, cropMax))) {
    out_color = vec4(0.0);
  } else {
    out_color = texture(u_input_source, sourceUv) * u_parameter_opacity;
  }
}`,
  webgpu: {
    backend: 'webgpu',
    nodeSet: 'aelion.visual.builtin/1.0.0',
    graphHash: 'builtin-visual-transform-v6',
    inputPorts: ['source'],
    uniforms: BASE_VISUAL_UNIFORM_IDS.map((id) => ({
      name: `u_parameter_${id}`,
      type: 'float' as const,
      source: { kind: 'parameter' as const, id },
    })),
    executionPlan: {
      passes: [
        {
          id: 'builtin-visual-transform',
          kind: 'draw',
          nodes: ['builtin-visual-transform'],
          estimatedTextureSamples: 1,
        },
      ],
      intermediateTextureCount: 0,
    },
    shader: `
struct Uniforms { values: array<vec4f, 17> };
@group(0) @binding(0) var source_sampler: sampler;
@group(0) @binding(1) var input_source: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOut(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}

@fragment fn fs(vertex: VertexOut) -> @location(0) vec4f {
  let size = vec2f(max(uniforms.values[8].x, 1.0), max(uniforms.values[9].x, 1.0));
  let project_size = vec2f(max(uniforms.values[15].x, 1.0), max(uniforms.values[16].x, 1.0));
  let frag_px = vec2f(vertex.uv.x * size.x, vertex.uv.y * size.y);
  let pos_px = vec2f(uniforms.values[0].x, size.y - uniforms.values[1].x);
  let offset_px = frag_px - pos_px;
  let c = cos(uniforms.values[6].x);
  let s = sin(uniforms.values[6].x);
  let rotated_px = mat2x2f(c, -s, s, c) * offset_px;
  let tex_dims = textureDimensions(input_source);
  let tex_size = vec2f(max(f32(tex_dims.x), 1.0), max(f32(tex_dims.y), 1.0));
  let source_aspect = tex_size.x / tex_size.y;
  let dest_aspect = size.x / size.y;
  let fit_mode = uniforms.values[14].x;
  var fit_scale: vec2f;
  if (fit_mode > 2.5) {
    fit_scale = tex_size / project_size;
  } else if (fit_mode > 1.5) {
    fit_scale = vec2f(1.0, 1.0);
  } else if (fit_mode > 0.5) {
    fit_scale = select(
      vec2f(1.0, dest_aspect / source_aspect),
      vec2f(source_aspect / dest_aspect, 1.0),
      source_aspect > dest_aspect
    );
  } else {
    fit_scale = select(
      vec2f(source_aspect / dest_aspect, 1.0),
      vec2f(1.0, dest_aspect / source_aspect),
      source_aspect > dest_aspect
    );
  }
  let scale_px = vec2f(uniforms.values[4].x, uniforms.values[5].x) * fit_scale * size;
  let safe_scale_px = vec2f(
    select(scale_px.x, 1.0, abs(scale_px.x) < 1e-6),
    select(scale_px.y, 1.0, abs(scale_px.y) < 1e-6)
  );
  let source_y_down = rotated_px / safe_scale_px
    + vec2f(uniforms.values[2].x, 1.0 - uniforms.values[3].x);
  let source_uv = source_y_down;
  let crop_uv = vec2f(source_y_down.x, 1.0 - source_y_down.y);
  let crop_min = vec2f(uniforms.values[10].x, uniforms.values[11].x);
  let crop_max = vec2f(1.0 - uniforms.values[12].x, 1.0 - uniforms.values[13].x);
  let sampled = textureSample(input_source, source_sampler, source_uv);
  if (abs(scale_px.x) < 1e-6 || abs(scale_px.y) < 1e-6 || any(crop_uv < crop_min) || any(crop_uv > crop_max)) {
    return vec4f(0.0);
  }
  return sampled * uniforms.values[7].x;
}`,
  },
};

const TEXT_VISUAL_PROGRAM: WebGl2MaterialProgram = {
  backend: 'webgl2',
  nodeSet: 'aelion.visual.builtin/1.0.0',
  graphHash: 'builtin-text-visual-transform-v1',
  inputPorts: ['source'],
  uniforms: TEXT_VISUAL_UNIFORM_IDS.map((id) => ({
    name: `u_parameter_${id}`,
    type: 'float' as const,
    source: { kind: 'parameter' as const, id },
  })),
  executionPlan: {
    passes: [
      {
        id: 'builtin-text-visual-transform',
        kind: 'draw',
        nodes: ['builtin-text-visual-transform'],
        estimatedTextureSamples: 1,
      },
    ],
    intermediateTextureCount: 0,
  },
  fragmentShader: `#version 300 es
precision highp float;
uniform sampler2D u_input_source;
uniform float u_parameter_positionX;
uniform float u_parameter_positionY;
uniform float u_parameter_anchorX;
uniform float u_parameter_anchorY;
uniform float u_parameter_scaleX;
uniform float u_parameter_scaleY;
uniform float u_parameter_rotationRad;
uniform float u_parameter_opacity;
uniform float u_parameter_outputWidth;
uniform float u_parameter_outputHeight;
uniform float u_parameter_cropLeft;
uniform float u_parameter_cropTop;
uniform float u_parameter_cropRight;
uniform float u_parameter_cropBottom;
uniform float u_parameter_contentX;
uniform float u_parameter_contentY;
uniform float u_parameter_contentW;
uniform float u_parameter_contentH;
in vec2 v_uv;
out vec4 out_color;
void main() {
  vec2 size = vec2(u_parameter_outputWidth, u_parameter_outputHeight);
  vec2 fragPx = vec2(v_uv.x * size.x, (1.0 - v_uv.y) * size.y);
  vec2 posPx = vec2(u_parameter_positionX, size.y - u_parameter_positionY);
  vec2 offsetPx = fragPx - posPx;
  float c = cos(u_parameter_rotationRad);
  float s = sin(u_parameter_rotationRad);
  vec2 rotatedPx = mat2(c, -s, s, c) * offsetPx;
  vec2 scalePx = vec2(u_parameter_scaleX, u_parameter_scaleY) * size;
  vec2 sourceYDown = rotatedPx / scalePx
    + vec2(u_parameter_anchorX, 1.0 - u_parameter_anchorY);
  vec2 sourceUv = vec2(sourceYDown.x, 1.0 - sourceYDown.y);
  vec2 cropMin = vec2(u_parameter_cropLeft, u_parameter_cropTop);
  vec2 cropMax = vec2(1.0 - u_parameter_cropRight, 1.0 - u_parameter_cropBottom);
  vec2 contentMin = vec2(u_parameter_contentX, u_parameter_contentY);
  vec2 contentSize = vec2(max(u_parameter_contentW, 1e-6), max(u_parameter_contentH, 1e-6));
  vec2 localYD = (sourceYDown - contentMin) / contentSize;
  if (
    any(lessThan(sourceUv, cropMin)) ||
    any(greaterThan(sourceUv, cropMax)) ||
    any(lessThan(localYD, vec2(0.0))) ||
    any(greaterThan(localYD, vec2(1.0)))
  ) {
    out_color = vec4(0.0);
  } else {
    out_color = texture(u_input_source, vec2(localYD.x, 1.0 - localYD.y)) * u_parameter_opacity;
  }
}`,
  webgpu: {
    backend: 'webgpu',
    nodeSet: 'aelion.visual.builtin/1.0.0',
    graphHash: 'builtin-text-visual-transform-v1',
    inputPorts: ['source'],
    uniforms: TEXT_VISUAL_UNIFORM_IDS.map((id) => ({
      name: `u_parameter_${id}`,
      type: 'float' as const,
      source: { kind: 'parameter' as const, id },
    })),
    executionPlan: {
      passes: [
        {
          id: 'builtin-text-visual-transform',
          kind: 'draw',
          nodes: ['builtin-text-visual-transform'],
          estimatedTextureSamples: 1,
        },
      ],
      intermediateTextureCount: 0,
    },
    shader: `
struct Uniforms { values: array<vec4f, 18> };
@group(0) @binding(0) var source_sampler: sampler;
@group(0) @binding(1) var input_source: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOut(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}

@fragment fn fs(vertex: VertexOut) -> @location(0) vec4f {
  let size = vec2f(uniforms.values[8].x, uniforms.values[9].x);
  let frag_px = vec2f(vertex.uv.x * size.x, vertex.uv.y * size.y);
  let pos_px = vec2f(uniforms.values[0].x, size.y - uniforms.values[1].x);
  let offset_px = frag_px - pos_px;
  let c = cos(uniforms.values[6].x);
  let s = sin(uniforms.values[6].x);
  let rotated_px = mat2x2f(c, -s, s, c) * offset_px;
  let scale_px = vec2f(uniforms.values[4].x, uniforms.values[5].x) * size;
  let source_y_down = rotated_px / scale_px
    + vec2f(uniforms.values[2].x, 1.0 - uniforms.values[3].x);
  let crop_uv = vec2f(source_y_down.x, 1.0 - source_y_down.y);
  let crop_min = vec2f(uniforms.values[10].x, uniforms.values[11].x);
  let crop_max = vec2f(1.0 - uniforms.values[12].x, 1.0 - uniforms.values[13].x);
  let content_min = vec2f(uniforms.values[14].x, uniforms.values[15].x);
  let content_size = vec2f(max(uniforms.values[16].x, 1e-6), max(uniforms.values[17].x, 1e-6));
  let local_yd = (source_y_down - content_min) / content_size;
  if (any(crop_uv < crop_min) || any(crop_uv > crop_max) || any(local_yd < vec2f(0.0)) || any(local_yd > vec2f(1.0))) {
    return vec4f(0.0);
  }
  return textureSample(input_source, source_sampler, local_yd) * uniforms.values[7].x;
}`,
  },
};

const COPY_PROGRAM: WebGl2MaterialProgram = {
  backend: 'webgl2',
  nodeSet: 'aelion.visual.builtin/1.0.0',
  graphHash: 'builtin-copy-v1',
  inputPorts: ['source'],
  uniforms: [],
  executionPlan: {
    passes: [
      {
        id: 'builtin-copy',
        kind: 'draw',
        nodes: ['builtin-copy'],
        estimatedTextureSamples: 1,
      },
    ],
    intermediateTextureCount: 0,
  },
  fragmentShader: `#version 300 es
precision highp float;
uniform sampler2D u_input_source;
in vec2 v_uv;
out vec4 out_color;
void main() {
  out_color = texture(u_input_source, v_uv);
}`,
  webgpu: {
    backend: 'webgpu',
    nodeSet: 'aelion.visual.builtin/1.0.0',
    graphHash: 'builtin-copy-v1',
    inputPorts: ['source'],
    uniforms: [],
    executionPlan: {
      passes: [
        {
          id: 'builtin-copy',
          kind: 'draw',
          nodes: ['builtin-copy'],
          estimatedTextureSamples: 1,
        },
      ],
      intermediateTextureCount: 0,
    },
    shader: `
struct Uniforms { values: array<vec4f, 1> };
@group(0) @binding(0) var source_sampler: sampler;
@group(0) @binding(1) var input_source: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOut(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}
@fragment fn fs(vertex: VertexOut) -> @location(0) vec4f {
  return textureSample(input_source, source_sampler, vertex.uv)
    + vec4f(uniforms.values[0].x * 0.0);
}`,
  },
};

const BLEND_PROGRAM: WebGl2MaterialProgram = {
  backend: 'webgl2',
  nodeSet: 'aelion.visual.builtin/1.0.0',
  graphHash: 'builtin-blend-v1',
  inputPorts: ['base', 'overlay'],
  uniforms: [
    {
      name: 'u_parameter_blendMode',
      type: 'float',
      source: { kind: 'parameter', id: 'blendMode' },
    },
  ],
  executionPlan: {
    passes: [
      {
        id: 'builtin-blend',
        kind: 'draw',
        nodes: ['builtin-blend'],
        estimatedTextureSamples: 2,
      },
    ],
    intermediateTextureCount: 0,
  },
  fragmentShader: `#version 300 es
precision highp float;
uniform sampler2D u_input_base;
uniform sampler2D u_input_overlay;
uniform float u_parameter_blendMode;
in vec2 v_uv;
out vec4 out_color;
vec3 blendColor(vec3 b, vec3 s, int mode) {
  if (mode == 1) return b * s;
  if (mode == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (mode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (mode == 4) return min(b, s);
  if (mode == 5) return max(b, s);
  if (mode == 6) return min(vec3(1.0), b / max(vec3(0.00001), 1.0 - s));
  if (mode == 7) return 1.0 - min(vec3(1.0), (1.0 - b) / max(vec3(0.00001), s));
  if (mode == 8) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  if (mode == 9) {
    vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(max(b, vec3(0.0))), step(0.25, b));
    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
  }
  if (mode == 10) return abs(b - s);
  if (mode == 11) return b + s - 2.0 * b * s;
  return s;
}
void main() {
  vec4 base = texture(u_input_base, v_uv);
  vec4 overlay = texture(u_input_overlay, v_uv);
  vec3 b = base.a > 0.0 ? base.rgb / base.a : vec3(0.0);
  vec3 s = overlay.a > 0.0 ? overlay.rgb / overlay.a : vec3(0.0);
  vec3 blended = blendColor(b, s, int(floor(u_parameter_blendMode + 0.5)));
  out_color = vec4(
    (1.0 - overlay.a) * base.rgb + (1.0 - base.a) * overlay.rgb + base.a * overlay.a * blended,
    overlay.a + base.a * (1.0 - overlay.a)
  );
}`,
  webgpu: {
    backend: 'webgpu',
    nodeSet: 'aelion.visual.builtin/1.0.0',
    graphHash: 'builtin-blend-v1',
    inputPorts: ['base', 'overlay'],
    uniforms: [
      {
        name: 'u_parameter_blendMode',
        type: 'float',
        source: { kind: 'parameter', id: 'blendMode' },
      },
    ],
    executionPlan: {
      passes: [
        {
          id: 'builtin-blend',
          kind: 'draw',
          nodes: ['builtin-blend'],
          estimatedTextureSamples: 2,
        },
      ],
      intermediateTextureCount: 0,
    },
    shader: `
struct Uniforms { values: array<vec4f, 1> };
@group(0) @binding(0) var source_sampler: sampler;
@group(0) @binding(1) var input_base: texture_2d<f32>;
@group(0) @binding(2) var input_overlay: texture_2d<f32>;
@group(0) @binding(3) var<uniform> uniforms: Uniforms;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOut(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}
fn blendColor(b: vec3f, s: vec3f, mode: i32) -> vec3f {
  if (mode == 1) { return b * s; }
  if (mode == 2) { return vec3f(1.0) - (vec3f(1.0) - b) * (vec3f(1.0) - s); }
  if (mode == 3) { return mix(2.0 * b * s, vec3f(1.0) - 2.0 * (vec3f(1.0) - b) * (vec3f(1.0) - s), step(vec3f(0.5), b)); }
  if (mode == 4) { return min(b, s); }
  if (mode == 5) { return max(b, s); }
  if (mode == 6) { return min(vec3f(1.0), b / max(vec3f(0.00001), vec3f(1.0) - s)); }
  if (mode == 7) { return vec3f(1.0) - min(vec3f(1.0), (vec3f(1.0) - b) / max(vec3f(0.00001), s)); }
  if (mode == 8) { return mix(2.0 * b * s, vec3f(1.0) - 2.0 * (vec3f(1.0) - b) * (vec3f(1.0) - s), step(vec3f(0.5), s)); }
  if (mode == 9) {
    let d = mix(((16.0 * b - vec3f(12.0)) * b + vec3f(4.0)) * b, sqrt(max(b, vec3f(0.0))), step(vec3f(0.25), b));
    return mix(b - (vec3f(1.0) - 2.0 * s) * b * (vec3f(1.0) - b), b + (2.0 * s - vec3f(1.0)) * (d - b), step(vec3f(0.5), s));
  }
  if (mode == 10) { return abs(b - s); }
  if (mode == 11) { return b + s - 2.0 * b * s; }
  return s;
}
@fragment fn fs(vertex: VertexOut) -> @location(0) vec4f {
  let base = textureSample(input_base, source_sampler, vertex.uv);
  let overlay = textureSample(input_overlay, source_sampler, vertex.uv);
  let b = select(vec3f(0.0), base.rgb / base.a, base.a > 0.0);
  let s = select(vec3f(0.0), overlay.rgb / overlay.a, overlay.a > 0.0);
  let blended = blendColor(b, s, i32(floor(uniforms.values[0].x + 0.5)));
  return vec4f(
    (1.0 - overlay.a) * base.rgb + (1.0 - base.a) * overlay.rgb + base.a * overlay.a * blended,
    overlay.a + base.a * (1.0 - overlay.a)
  );
}
`,
  },
};

const BLEND_MODE_CODES: Readonly<Record<string, number>> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
};

const MASK_PROGRAM: WebGl2MaterialProgram = {
  backend: 'webgl2',
  nodeSet: 'aelion.visual.builtin/1.0.0',
  graphHash: 'builtin-mask-v1',
  inputPorts: ['source', 'mask'],
  uniforms: ['maskMode', 'invert', 'featherUvX', 'featherUvY'].map((id) => ({
    name: `u_parameter_${id}`,
    type: 'float' as const,
    source: { kind: 'parameter' as const, id },
  })),
  executionPlan: {
    passes: [
      {
        id: 'builtin-mask',
        kind: 'draw',
        nodes: ['builtin-mask'],
        estimatedTextureSamples: 10,
      },
    ],
    intermediateTextureCount: 0,
  },
  fragmentShader: `#version 300 es
precision highp float;
uniform sampler2D u_input_source;
uniform sampler2D u_input_mask;
uniform float u_parameter_maskMode;
uniform float u_parameter_invert;
uniform float u_parameter_featherUvX;
uniform float u_parameter_featherUvY;
in vec2 v_uv;
out vec4 out_color;
float maskValue(vec2 uv) {
  vec4 value = texture(u_input_mask, uv);
  return u_parameter_maskMode < 0.5 ? value.a : dot(value.rgb, vec3(0.2126, 0.7152, 0.0722));
}
void main() {
  vec2 radius = vec2(u_parameter_featherUvX, u_parameter_featherUvY);
  float amount = 0.0;
  amount += maskValue(v_uv);
  amount += maskValue(v_uv + vec2(radius.x, 0.0));
  amount += maskValue(v_uv - vec2(radius.x, 0.0));
  amount += maskValue(v_uv + vec2(0.0, radius.y));
  amount += maskValue(v_uv - vec2(0.0, radius.y));
  amount += maskValue(v_uv + radius);
  amount += maskValue(v_uv - radius);
  amount += maskValue(v_uv + vec2(radius.x, -radius.y));
  amount += maskValue(v_uv + vec2(-radius.x, radius.y));
  amount /= 9.0;
  if (u_parameter_invert > 0.5) amount = 1.0 - amount;
  out_color = texture(u_input_source, v_uv) * clamp(amount, 0.0, 1.0);
}`,
  webgpu: {
    backend: 'webgpu',
    nodeSet: 'aelion.visual.builtin/1.0.0',
    graphHash: 'builtin-mask-v1',
    inputPorts: ['source', 'mask'],
    uniforms: ['maskMode', 'invert', 'featherUvX', 'featherUvY'].map((id) => ({
      name: `u_parameter_${id}`,
      type: 'float' as const,
      source: { kind: 'parameter' as const, id },
    })),
    executionPlan: {
      passes: [
        {
          id: 'builtin-mask',
          kind: 'draw',
          nodes: ['builtin-mask'],
          estimatedTextureSamples: 10,
        },
      ],
      intermediateTextureCount: 0,
    },
    shader: `
struct Uniforms { values: array<vec4f, 4> };
@group(0) @binding(0) var source_sampler: sampler;
@group(0) @binding(1) var input_source: texture_2d<f32>;
@group(0) @binding(2) var input_mask: texture_2d<f32>;
@group(0) @binding(3) var<uniform> uniforms: Uniforms;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOut(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}
fn mask_value(uv: vec2f) -> f32 {
  let value = textureSample(input_mask, source_sampler, uv);
  let luma = dot(value.rgb, vec3f(0.2126, 0.7152, 0.0722));
  return select(luma, value.a, uniforms.values[0].x < 0.5);
}
@fragment fn fs(vertex: VertexOut) -> @location(0) vec4f {
  let radius = vec2f(uniforms.values[2].x, uniforms.values[3].x);
  var amount = mask_value(vertex.uv);
  amount += mask_value(vertex.uv + vec2f(radius.x, 0.0));
  amount += mask_value(vertex.uv - vec2f(radius.x, 0.0));
  amount += mask_value(vertex.uv + vec2f(0.0, radius.y));
  amount += mask_value(vertex.uv - vec2f(0.0, radius.y));
  amount += mask_value(vertex.uv + radius);
  amount += mask_value(vertex.uv - radius);
  amount += mask_value(vertex.uv + vec2f(radius.x, -radius.y));
  amount += mask_value(vertex.uv + vec2f(-radius.x, radius.y));
  amount /= 9.0;
  let masked = select(amount, 1.0 - amount, uniforms.values[1].x > 0.5);
  return textureSample(input_source, source_sampler, vertex.uv) * clamp(masked, 0.0, 1.0);
}`,
  },
};

function blendModeCode(mode: string): number {
  const code = BLEND_MODE_CODES[mode];
  if (code === undefined) throw new TypeError(`BLEND_MODE_UNSUPPORTED: ${mode}`);
  return code;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

interface VisualSourceContent {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function fitModeCode(fit: unknown): number {
  if (fit === 'cover') return 1;
  if (fit === 'fill') return 2;
  if (fit === 'none') return 3;
  return 0;
}

function positiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function computeFitScale(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  fit: unknown,
): readonly [number, number] {
  const safeSrcW = positiveDimension(sourceWidth);
  const safeSrcH = positiveDimension(sourceHeight);
  const safeOutW = positiveDimension(outputWidth);
  const safeOutH = positiveDimension(outputHeight);
  const mode = fitModeCode(fit);
  if (mode === 3) return [safeSrcW / safeOutW, safeSrcH / safeOutH];
  if (mode === 2) return [1, 1];
  const sourceAspect = safeSrcW / safeSrcH;
  const destAspect = safeOutW / safeOutH;
  if (mode === 1) {
    return sourceAspect > destAspect ? [sourceAspect / destAspect, 1] : [1, destAspect / sourceAspect];
  }
  return sourceAspect > destAspect ? [1, destAspect / sourceAspect] : [sourceAspect / destAspect, 1];
}

export function computeVisualParameters(
  visual: object,
  projectWidth: number,
  projectHeight: number,
  outputWidth: number,
  outputHeight: number,
  sequenceTimeUs: number,
  ownerStartUs: number,
): Readonly<Record<string, number>> {
  const visualRecord = visual as Readonly<Record<string, unknown>>;
  const transform = record(visualRecord.transform);
  const evaluated = (value: unknown): unknown =>
    evaluateAnimatedValue(value as import('@aelionsdk/core').JsonValue, sequenceTimeUs, ownerStartUs);
  const position = record(evaluated(transform.positionPx));
  const anchor = record(evaluated(transform.anchor));
  const scale = record(evaluated(transform.scale));
  const crop = record(evaluated(visualRecord.crop));
  const userScaleX = finite(scale.x, 1);
  const userScaleY = finite(scale.y, 1);
  const safeProjectW = positiveDimension(projectWidth);
  const safeProjectH = positiveDimension(projectHeight);
  const safeOutputW = positiveDimension(outputWidth);
  const safeOutputH = positiveDimension(outputHeight);
  const positionScaleX = safeOutputW / safeProjectW;
  const positionScaleY = safeOutputH / safeProjectH;
  return {
    positionX: finite(position.x, safeProjectW / 2) * positionScaleX,
    positionY: finite(position.y, safeProjectH / 2) * positionScaleY,
    anchorX: finite(anchor.x, 0.5),
    anchorY: finite(anchor.y, 0.5),
    scaleX: userScaleX,
    scaleY: userScaleY,
    rotationRad: (finite(evaluated(transform.rotationDeg), 0) * Math.PI) / 180,
    opacity: Math.max(0, Math.min(1, finite(evaluated(visualRecord.opacity), 1))),
    outputWidth: safeOutputW,
    outputHeight: safeOutputH,
    cropLeft: finite(crop.left, 0),
    cropTop: finite(crop.top, 0),
    cropRight: finite(crop.right, 0),
    cropBottom: finite(crop.bottom, 0),
    fitMode: fitModeCode(visualRecord.fit),
    projectWidth: safeProjectW,
    projectHeight: safeProjectH,
  };
}

function visualParameters(
  visual: object,
  projectWidth: number,
  projectHeight: number,
  outputWidth: number,
  outputHeight: number,
  sequenceTimeUs: number,
  ownerStartUs: number,
): Readonly<Record<string, number>> {
  return computeVisualParameters(
    visual,
    projectWidth,
    projectHeight,
    outputWidth,
    outputHeight,
    sequenceTimeUs,
    ownerStartUs,
  );
}

function requiresBaseVisualPass(parameters: Readonly<Record<string, number>>, width: number, height: number): boolean {
  return (
    parameters.positionX !== width / 2 ||
    parameters.positionY !== height / 2 ||
    parameters.anchorX !== 0.5 ||
    parameters.anchorY !== 0.5 ||
    parameters.scaleX !== 1 ||
    parameters.scaleY !== 1 ||
    parameters.rotationRad !== 0 ||
    parameters.opacity !== 1 ||
    parameters.cropLeft !== 0 ||
    parameters.cropTop !== 0 ||
    parameters.cropRight !== 0 ||
    parameters.cropBottom !== 0 ||
    parameters.fitMode !== 0
  );
}

function textRasterPlacement(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  projectWidth: number,
  projectHeight: number,
  outputWidth: number,
  outputHeight: number,
): {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly originX: number;
  readonly originY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly contentX: number;
  readonly contentY: number;
  readonly contentW: number;
  readonly contentH: number;
} {
  const scaleX = outputWidth / projectWidth;
  const scaleY = outputHeight / projectHeight;
  const x0 = Math.floor(box.x * scaleX);
  const y0 = Math.floor(box.y * scaleY);
  const x1 = Math.ceil((box.x + box.width) * scaleX);
  const y1 = Math.ceil((box.y + box.height) * scaleY);
  const canvasWidth = Math.max(1, x1 - x0);
  const canvasHeight = Math.max(1, y1 - y0);
  return {
    canvasWidth,
    canvasHeight,
    originX: x0 / scaleX,
    originY: y0 / scaleY,
    scaleX,
    scaleY,
    contentX: x0 / outputWidth,
    contentY: y0 / outputHeight,
    contentW: canvasWidth / outputWidth,
    contentH: canvasHeight / outputHeight,
  };
}

function canvasFont(style: PortableTextStyle): string {
  const families = style.fontFamilies
    .map((value) => (/^[\w-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`))
    .join(', ');
  return `${style.fontStyle} ${style.fontWeight.toString()} ${style.fontSizePx.toString()}px ${families}`;
}

/**
 * Rasterized 2D surfaces, keyed by the content that produced them.
 *
 * Text, generators and shapes are all pure functions of their clip data and the
 * output size — `timestampUs` only stamps the returned frame and never selects
 * an animated value — so an unchanged clip repaints to identical pixels on
 * every frame. The cache owns its entry; callers receive a clone to close.
 */
const RASTER_CACHE_LIMIT = 16;
const rasterCache: { key: string; frame: VideoFrame }[] = [];

function textRasterKey(
  clip: IrTextClip,
  projectWidth: number,
  projectHeight: number,
  outputWidth: number,
  outputHeight: number,
): string {
  return JSON.stringify({
    kind: 'text',
    box: clip.box,
    overflow: clip.overflow,
    writingMode: clip.writingMode,
    paragraphs: clip.paragraphs,
    projectWidth,
    projectHeight,
    outputWidth,
    outputHeight,
  });
}

function generatorRasterKey(generator: object, width: number, height: number): string {
  return JSON.stringify({ kind: 'generator', generator, width, height });
}

function shapeRasterKey(
  clip: IrShapeClip,
  projectWidth: number,
  projectHeight: number,
  outputWidth: number,
  outputHeight: number,
): string {
  return JSON.stringify({
    kind: 'shape',
    shape: clip.shape,
    projectWidth,
    projectHeight,
    outputWidth,
    outputHeight,
  });
}

function cachedRaster(key: string): VideoFrame | undefined {
  const index = rasterCache.findIndex((entry) => entry.key === key);
  if (index < 0) return undefined;
  const [entry] = rasterCache.splice(index, 1);
  if (entry === undefined) return undefined;
  rasterCache.push(entry);
  return entry.frame;
}

function rememberRaster(key: string, frame: VideoFrame): void {
  rasterCache.push({ key, frame });
  while (rasterCache.length > RASTER_CACHE_LIMIT) {
    const evicted = rasterCache.shift();
    evicted?.frame.close();
  }
}

function clearRasterCache(): void {
  for (const entry of rasterCache) entry.frame.close();
  rasterCache.length = 0;
}

function paintTextClip(
  canvas: OffscreenCanvas,
  clip: IrTextClip,
  originX: number,
  originY: number,
  scaleX: number,
  scaleY: number,
): void {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('TEXT_CANVAS_UNAVAILABLE');
  let measuredFont = '';
  const layout = layoutIrText(clip, {
    measure: {
      measureText(value, style) {
        if (value.length === 0) return 0;
        const font = canvasFont(style);
        if (measuredFont !== font) {
          context.font = font;
          measuredFont = font;
        }
        const width = context.measureText(value).width;
        return Number.isFinite(width) && width >= 0 ? width : 0;
      },
    },
  });
  const paintBox = inflateTextBox(clip.box, textClipPaintExtent(clip));
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.setTransform(scaleX, 0, 0, scaleY, -originX * scaleX, -originY * scaleY);
  if (clip.overflow !== 'visible') {
    context.beginPath();
    context.rect(paintBox.x, paintBox.y, paintBox.width, paintBox.height);
    context.clip();
  }
  paintTextBackgrounds(context, layout.lines);
  context.textBaseline = 'top';
  for (const line of layout.lines) {
    for (const span of line.spans) {
      context.font = canvasFont(span.style);
      context.fillStyle = span.style.fill;
      const y = line.y + Math.max(0, (line.height - span.style.lineHeightPx) / 2);
      context.direction = span.style.direction;
      const draw = (value: string, x: number): void => {
        if (span.style.stroke !== undefined && span.style.strokeWidthPx > 0) {
          context.strokeStyle = span.style.stroke;
          context.lineWidth = span.style.strokeWidthPx;
          context.strokeText(value, x, y);
        }
        context.fillText(value, x, y);
      };
      if (span.style.direction === 'rtl') {
        draw(span.text, span.x + span.advancePx);
      } else if (layout.metricsId === 'aelion-canvas-text-metrics/1' && span.style.letterSpacingPx === 0) {
        draw(span.text, span.x);
      } else {
        for (const glyph of span.glyphs) draw(glyph.text, glyph.x);
      }
    }
  }
  context.restore();
}

function paintTextBackgrounds(context: OffscreenCanvasRenderingContext2D, lines: readonly IrLaidOutTextLine[]): void {
  for (const line of lines) {
    let style: PortableTextStyle | undefined;
    let pad = 0;
    for (const span of line.spans) {
      if (!textBackgroundVisible(span.style)) continue;
      style = span.style;
      pad = Math.max(pad, span.style.backgroundPaddingPx);
    }
    if (style === undefined || line.width <= 0 || line.height <= 0) continue;
    context.fillStyle = cssColorWithAlpha(style.backgroundFill, style.backgroundOpacity);
    fillRoundRect(
      context,
      line.x - pad,
      line.y - pad,
      line.width + pad * 2,
      line.height + pad * 2,
      style.backgroundRadiusPx,
    );
  }
}

function fillRoundRect(
  context: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, r);
  } else {
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }
  context.fill();
}

function rasterTextFrame(
  clip: IrTextClip,
  projectWidth: number,
  projectHeight: number,
  outputWidth: number,
  outputHeight: number,
  timestampUs: number,
  placement: ReturnType<typeof textRasterPlacement>,
): VideoFrame {
  const key = textRasterKey(clip, projectWidth, projectHeight, outputWidth, outputHeight);
  const cached = cachedRaster(key);
  if (cached !== undefined) return cached.clone();
  const canvas = new OffscreenCanvas(placement.canvasWidth, placement.canvasHeight);
  paintTextClip(canvas, clip, placement.originX, placement.originY, placement.scaleX, placement.scaleY);
  const frame = new VideoFrame(canvas, { timestamp: timestampUs });
  rememberRaster(key, frame);
  return frame.clone();
}

function linearChannelToSrgb(value: number): number {
  const channel = Math.max(0, Math.min(1, value));
  return channel <= 0.003_130_8 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function canvasColor(value: unknown, fallback = 'rgba(0, 0, 0, 0)'): string {
  const color = record(value);
  const rgba = color.rgba;
  if (!Array.isArray(rgba) || rgba.length !== 4) return fallback;
  const values = rgba.map((value) => finite(value, 0));
  const red = values[0];
  const green = values[1];
  const blue = values[2];
  const alpha = values[3];
  if (red === undefined || green === undefined || blue === undefined || alpha === undefined) {
    return fallback;
  }
  return `rgba(${Math.round(linearChannelToSrgb(red) * 255).toString()}, ${Math.round(linearChannelToSrgb(green) * 255).toString()}, ${Math.round(linearChannelToSrgb(blue) * 255).toString()}, ${Math.max(0, Math.min(1, alpha)).toString()})`;
}

function backgroundParameters(value: unknown): Readonly<Record<string, import('@aelionsdk/core').JsonValue>> {
  const rgba = record(value).rgba;
  const components =
    Array.isArray(rgba) && rgba.length === 4 ? rgba.map((component) => finite(component, 0)) : [0, 0, 0, 0];
  return {
    red: linearChannelToSrgb(components[0] ?? 0),
    green: linearChannelToSrgb(components[1] ?? 0),
    blue: linearChannelToSrgb(components[2] ?? 0),
    alpha: Math.max(0, Math.min(1, components[3] ?? 0)),
  };
}

const BACKGROUND_PROGRAM: WebGl2MaterialProgram = {
  backend: 'webgl2',
  nodeSet: 'aelion.visual.builtin/1.0.0',
  graphHash: 'builtin-background-v1',
  inputPorts: [],
  uniforms: ['red', 'green', 'blue', 'alpha'].map((id) => ({
    name: `u_parameter_${id}`,
    type: 'float' as const,
    source: { kind: 'parameter' as const, id },
  })),
  executionPlan: {
    passes: [
      {
        id: 'builtin-background',
        kind: 'draw',
        nodes: ['builtin-background'],
        estimatedTextureSamples: 0,
      },
    ],
    intermediateTextureCount: 0,
  },
  fragmentShader: `#version 300 es
precision highp float;
uniform float u_parameter_red;
uniform float u_parameter_green;
uniform float u_parameter_blue;
uniform float u_parameter_alpha;
out vec4 out_color;
void main() {
  out_color = vec4(
    u_parameter_red,
    u_parameter_green,
    u_parameter_blue,
    u_parameter_alpha
  );
}`,
  webgpu: {
    backend: 'webgpu',
    nodeSet: 'aelion.visual.builtin/1.0.0',
    graphHash: 'builtin-background-v1',
    inputPorts: [],
    uniforms: ['red', 'green', 'blue', 'alpha'].map((id) => ({
      name: `u_parameter_${id}`,
      type: 'float' as const,
      source: { kind: 'parameter' as const, id },
    })),
    executionPlan: {
      passes: [
        {
          id: 'builtin-background',
          kind: 'draw',
          nodes: ['builtin-background'],
          estimatedTextureSamples: 0,
        },
      ],
      intermediateTextureCount: 0,
    },
    shader: `
struct Uniforms { values: array<vec4f, 4> };
@group(0) @binding(0) var unused_sampler: sampler;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;
struct VertexOut { @builtin(position) position: vec4f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return VertexOut(vec4f(positions[index], 0.0, 1.0));
}
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(
    uniforms.values[0].x,
    uniforms.values[1].x,
    uniforms.values[2].x,
    uniforms.values[3].x
  );
}`,
  },
};

function rasterGeneratorFrame(generator: object, width: number, height: number, timestampUs: number): VideoFrame {
  const key = generatorRasterKey(generator, width, height);
  const cached = cachedRaster(key);
  if (cached !== undefined) return cached.clone();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('GENERATOR_CANVAS_UNAVAILABLE');
  const properties = generator as Readonly<Record<string, unknown>>;
  const colors = Array.isArray(properties.colors) ? properties.colors : [];
  if (properties.kind === 'linear-gradient' && colors.length > 1) {
    const radians = (finite(properties.angleDeg, 0) * Math.PI) / 180;
    const radius = Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height;
    const centerX = width / 2;
    const centerY = height / 2;
    const x = (Math.cos(radians) * radius) / 2;
    const y = (Math.sin(radians) * radius) / 2;
    const gradient = context.createLinearGradient(centerX - x, centerY - y, centerX + x, centerY + y);
    colors.forEach((color, index) => {
      gradient.addColorStop(index / (colors.length - 1), canvasColor(color));
    });
    context.fillStyle = gradient;
  } else {
    context.fillStyle = canvasColor(colors[0], 'rgba(0, 0, 0, 0)');
  }
  context.fillRect(0, 0, width, height);
  const frame = new VideoFrame(canvas, { timestamp: timestampUs });
  rememberRaster(key, frame);
  return frame.clone();
}

function roundedRectanglePath(
  context: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const clamped = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.moveTo(x + clamped, y);
  context.lineTo(x + width - clamped, y);
  context.quadraticCurveTo(x + width, y, x + width, y + clamped);
  context.lineTo(x + width, y + height - clamped);
  context.quadraticCurveTo(x + width, y + height, x + width - clamped, y + height);
  context.lineTo(x + clamped, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - clamped);
  context.lineTo(x, y + clamped);
  context.quadraticCurveTo(x, y, x + clamped, y);
}

function rasterShapeFrame(
  clip: IrShapeClip,
  projectWidth: number,
  projectHeight: number,
  outputWidth: number,
  outputHeight: number,
  timestampUs: number,
): VideoFrame {
  const key = shapeRasterKey(clip, projectWidth, projectHeight, outputWidth, outputHeight);
  const cached = cachedRaster(key);
  if (cached !== undefined) return cached.clone();
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('SHAPE_CANVAS_UNAVAILABLE');
  const shape = record(clip.shape);
  const box = record(shape.box);
  const x = finite(box.x, 0);
  const y = finite(box.y, 0);
  const width = Math.max(0, finite(box.width, 0));
  const height = Math.max(0, finite(box.height, 0));
  if (width === 0 || height === 0) throw new RangeError(`SHAPE_BOX_INVALID: ${clip.id}`);
  context.save();
  context.scale(outputWidth / projectWidth, outputHeight / projectHeight);
  context.beginPath();
  if (shape.kind === 'ellipse') {
    context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else if (shape.kind === 'polygon') {
    const points = Array.isArray(shape.points) ? shape.points.map((value) => record(value)) : [];
    if (points.length < 3) throw new RangeError(`SHAPE_POLYGON_POINTS_INVALID: ${clip.id}`);
    points.forEach((point, index) => {
      const pointX = x + finite(point.x, 0) * width;
      const pointY = y + finite(point.y, 0) * height;
      if (index === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.closePath();
  } else {
    roundedRectanglePath(context, x, y, width, height, Math.max(0, finite(shape.cornerRadiusPx, 0)));
    context.closePath();
  }
  context.fillStyle = canvasColor(shape.fill);
  context.fill();
  const strokeWidthPx = Math.max(0, finite(shape.strokeWidthPx, 0));
  if (shape.stroke !== undefined && strokeWidthPx > 0) {
    context.strokeStyle = canvasColor(shape.stroke);
    context.lineWidth = strokeWidthPx;
    context.stroke();
  }
  context.restore();
  const frame = new VideoFrame(canvas, { timestamp: timestampUs });
  rememberRaster(key, frame);
  return frame.clone();
}

function rasterTransparentFrame(width: number, height: number, timestampUs: number): VideoFrame {
  return new VideoFrame(new OffscreenCanvas(width, height), { timestamp: timestampUs });
}

export class RenderIrFrameRenderer implements Disposable {
  readonly #compositor: WorkerCompositor;
  readonly #adaptiveBackend = new AdaptiveBackendSelector();
  readonly #disposeController = new AbortController();
  readonly #maxPendingFrames: number;
  readonly #renderTasks = new Map<symbol, Promise<RenderIrFrameResult>>();
  #disposeTask: Promise<void> | undefined;
  #pendingFrames = 0;

  public constructor(options: RenderIrFrameRendererOptions = {}) {
    this.#compositor = new WorkerCompositor({
      ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
    });
    this.#maxPendingFrames = options.maxPendingFrames ?? 2;
    if (!Number.isSafeInteger(this.#maxPendingFrames) || this.#maxPendingFrames <= 0) {
      throw new RangeError('maxPendingFrames must be a positive safe integer');
    }
  }

  public get disposed(): boolean {
    return this.#compositor.disposed;
  }

  public snapshot(): RenderIrFrameRendererSnapshot {
    return {
      disposed: this.disposed,
      pendingFrames: this.#pendingFrames,
      maxPendingFrames: this.#maxPendingFrames,
      adaptiveBackend: this.#adaptiveBackend.snapshot(),
      worker: this.#compositor.snapshot(),
    };
  }

  public async render(options: RenderIrFrameOptions): Promise<RenderIrFrameResult> {
    if (this.disposed) throw new ReferenceError('RenderIrFrameRenderer is disposed');
    const linked = linkAbortSignals(options.signal, this.#disposeController.signal);
    throwIfAborted(linked.signal, 'Render IR frame');
    if (this.#pendingFrames >= this.#maxPendingFrames) {
      linked.detach();
      throw new AelionError([
        {
          code: 'RENDERER_FRAME_QUEUE_FULL',
          severity: 'error',
          message: `Render IR frame queue reached its ${this.#maxPendingFrames.toString()} request limit`,
          recoverable: true,
        },
      ]);
    }
    this.#pendingFrames += 1;
    const token = Symbol('render-task');
    const task = (async () => {
      try {
        return await this.#renderFrame({ ...options, signal: linked.signal });
      } finally {
        linked.detach();
        this.#pendingFrames -= 1;
        this.#renderTasks.delete(token);
      }
    })();
    this.#renderTasks.set(token, task);
    return await task;
  }

  async #renderFrame(options: RenderIrFrameOptions): Promise<RenderIrFrameResult> {
    const requestedScale = options.mode === 'export' ? 1 : (options.renderScale ?? 1);
    if (!Number.isFinite(requestedScale) || requestedScale <= 0 || requestedScale > 1) {
      throw new RangeError('renderScale must be greater than 0 and at most 1');
    }
    const width = Math.max(1, Math.round(options.ir.width * requestedScale));
    const height = Math.max(1, Math.round(options.ir.height * requestedScale));
    const renderScale = Math.min(width / options.ir.width, height / options.ir.height);
    const color = preflightColorPipeline(options.ir, LOCAL_RGBA8_COLOR_CAPABILITY);
    if (!color.ok) throw new AelionError(color.issues);
    const state = evaluateVisualState(options.ir, options.timeUs);
    const backgroundId = '__aelion_background__';
    const externalFrames = new Map<string, VideoFrame>();
    const rendered = new Map<string, FrameGraphInput>();
    const nodes: FrameGraphNode[] = [];
    const appliedMaterialIds: string[] = [];
    let nextExternalId = 0;
    let nextNodeId = 0;
    let inputsTransferred = false;

    const addExternal = (frame: VideoFrame, label: string): FrameGraphInput => {
      const id = `external:${(nextExternalId++).toString()}:${label}`;
      externalFrames.set(id, frame);
      return { kind: 'external', id };
    };
    const addNode = (
      label: string,
      inputs: Readonly<Record<string, FrameGraphInput>>,
      program: WebGl2MaterialProgram,
      parameters: Readonly<Record<string, JsonValue>> = {},
      systems: Readonly<Record<string, number>> = {},
    ): FrameGraphInput => {
      const id = `node:${(nextNodeId++).toString()}:${label}`;
      nodes.push({ id, inputs, program, parameters, systems });
      return { kind: 'node', id };
    };
    rendered.set(
      backgroundId,
      addNode('background', {}, BACKGROUND_PROGRAM, backgroundParameters(options.ir.backgroundColor)),
    );
    try {
      for (const active of state.clips) {
        if (active.clip.kind === 'adjustment-clip') continue;
        let frame: VideoFrame | undefined;
        let textContent: VisualSourceContent | undefined;
        if (active.clip.kind === 'visual-clip') {
          if (active.sourceTimeUs === null) continue;
          const resolved = resolveMediaSourceFrame(active.clip.source, active.sourceTimeUs);
          if (resolved === null) continue;
          frame = await options.source.frameAt(
            resolved.assetId,
            resolved.streamIndex,
            resolved.sourceTimeUs,
            options.signal,
            { purpose: options.mode, maxDimension: Math.max(width, height) },
          );
        } else if (active.clip.kind === 'text-clip') {
          const placement = textRasterPlacement(
            inflateTextBox(active.clip.box, textClipPaintExtent(active.clip)),
            options.ir.width,
            options.ir.height,
            width,
            height,
          );
          textContent = {
            x: placement.contentX,
            y: placement.contentY,
            width: placement.contentW,
            height: placement.contentH,
          };
          frame = rasterTextFrame(
            active.clip,
            options.ir.width,
            options.ir.height,
            width,
            height,
            options.timeUs,
            placement,
          );
        } else if (active.clip.kind === 'generator-clip') {
          frame = rasterGeneratorFrame(active.clip.generator, width, height, options.timeUs);
        } else if (active.clip.kind === 'shape-clip') {
          frame = rasterShapeFrame(active.clip, options.ir.width, options.ir.height, width, height, options.timeUs);
        } else if (active.clip.kind === 'material-content-clip') {
          frame = rasterTransparentFrame(width, height, options.timeUs);
        } else {
          if (active.sourceTimeUs === null) continue;
          const subgraph = options.ir.subgraphs?.[active.clip.source.sequenceId];
          if (subgraph === undefined) {
            throw new ReferenceError(`NESTED_SEQUENCE_MISSING: ${active.clip.source.sequenceId}`);
          }
          const nested = await this.#renderFrame({
            ...options,
            ir: subgraph,
            timeUs: active.sourceTimeUs,
          });
          frame = takeBitmapFrame(nested.bitmap, options.timeUs);
          appliedMaterialIds.push(...nested.materialIds);
        }
        try {
          throwIfAborted(options.signal, 'Render IR media decode');
          let reference = addExternal(frame, active.clip.id);
          frame = undefined;
          const baseParameters = visualParameters(
            active.clip.visual,
            options.ir.width,
            options.ir.height,
            width,
            height,
            options.timeUs,
            active.clip.range.startUs,
          );
          if (active.clip.kind === 'text-clip' && textContent !== undefined) {
            reference = addNode(`${active.clip.id}:visual`, { source: reference }, TEXT_VISUAL_PROGRAM, {
              ...baseParameters,
              contentX: textContent.x,
              contentY: textContent.y,
              contentW: textContent.width,
              contentH: textContent.height,
            });
          } else if (active.clip.kind === 'visual-clip' || requiresBaseVisualPass(baseParameters, width, height)) {
            reference = addNode(`${active.clip.id}:visual`, { source: reference }, BASE_VISUAL_PROGRAM, baseParameters);
          }
          for (const material of active.materials) {
            const program = requiredProgram(material, options.mode);
            if (program === undefined) continue;
            const evaluated = evaluateMaterialInstance(material, options.timeUs, active.clip.range.startUs);
            reference = addNode(
              `${active.clip.id}:material:${material.id}`,
              { source: reference },
              program,
              evaluated.parameters,
              { qualityScale: renderScale },
            );
            appliedMaterialIds.push(material.id);
          }
          rendered.set(active.clip.id, reference);
        } finally {
          frame?.close();
        }
      }

      const consumedMaskIds = new Set<string>();
      for (const active of state.clips) {
        if (active.clip.kind === 'adjustment-clip') continue;
        const mask = active.clip.visual.mask;
        if (mask === undefined) continue;
        const target = rendered.get(active.clip.id);
        const maskSource = rendered.get(mask.sourceItemId);
        if (target === undefined || maskSource === undefined) {
          throw new ReferenceError(`MASK_SOURCE_MISSING: ${active.clip.id} -> ${mask.sourceItemId}`);
        }
        let maskReference = maskSource;
        if (mask.space === 'source') {
          const targetSpace = visualParameters(
            active.clip.visual,
            options.ir.width,
            options.ir.height,
            width,
            height,
            options.timeUs,
            active.clip.range.startUs,
          );
          if (requiresBaseVisualPass(targetSpace, width, height)) {
            maskReference = addNode(
              `${active.clip.id}:source-mask-space`,
              { source: maskReference },
              BASE_VISUAL_PROGRAM,
              targetSpace,
            );
          }
        }
        rendered.set(
          active.clip.id,
          addNode(`${active.clip.id}:mask`, { source: target, mask: maskReference }, MASK_PROGRAM, {
            maskMode: mask.channel === 'luma' ? 1 : 0,
            invert: mask.invert ? 1 : 0,
            featherUvX: mask.featherPx / options.ir.width,
            featherUvY: mask.featherPx / options.ir.height,
          }),
        );
        if (mask.consumeSource) consumedMaskIds.add(mask.sourceItemId);
      }

      let transitionLayerId: string | undefined;
      const layerIds = [
        backgroundId,
        ...state.clips.map((active) => active.clip.id).filter((id) => !consumedMaskIds.has(id)),
      ];
      const blendModes = new Map([
        [backgroundId, 'normal'] as const,
        ...state.clips.map((active) => [active.clip.id, active.clip.visual.blendMode] as const),
      ]);
      if (state.transition !== undefined) {
        const from = rendered.get(state.transition.transition.fromItemId);
        const to = rendered.get(state.transition.transition.toItemId);
        if (from === undefined || to === undefined) {
          throw new Error(`Transition ${state.transition.transition.id} is missing an input frame`);
        }
        const program = requiredProgram(state.transition.material, options.mode);
        if (program === undefined) throw new Error('A transition Material cannot be skipped');
        const evaluated = evaluateMaterialInstance(
          state.transition.material,
          options.timeUs,
          state.transition.transition.range.startUs,
        );
        transitionLayerId = `transition:${state.transition.transition.id}`;
        rendered.set(
          transitionLayerId,
          addNode(transitionLayerId, { from, to }, program, evaluated.parameters, {
            transitionProgress: state.transition.progress,
            qualityScale: renderScale,
          }),
        );
        blendModes.set(transitionLayerId, 'normal');
        appliedMaterialIds.push(state.transition.material.id);
        const fromIndex = layerIds.indexOf(state.transition.transition.fromItemId);
        const toIndex = layerIds.indexOf(state.transition.transition.toItemId);
        const insertionIndex = Math.max(0, Math.min(fromIndex, toIndex));
        const withoutInputs = layerIds.filter(
          (id) => id !== state.transition?.transition.fromItemId && id !== state.transition?.transition.toItemId,
        );
        withoutInputs.splice(insertionIndex, 0, transitionLayerId);
        layerIds.splice(0, layerIds.length, ...withoutInputs);
      }

      const layers = layerIds.flatMap((id) => {
        const frame = rendered.get(id);
        return frame === undefined ? [] : [{ id, frame, blendMode: blendModes.get(id) ?? 'normal' }];
      });
      if (layers.length === 0) throw new Error('No decodable visual frame is active');

      const firstLayer = layers[0];
      if (firstLayer === undefined) throw new Error('No base visual frame is active');
      let composite = firstLayer.frame;
      for (let index = 1; index < layers.length; index += 1) {
        const layer = layers[index];
        if (layer === undefined) continue;
        composite = addNode(`blend:${layer.id}`, { base: composite, overlay: layer.frame }, BLEND_PROGRAM, {
          blendMode: blendModeCode(layer.blendMode),
        });
      }

      for (const active of state.clips) {
        if (active.clip.kind !== 'adjustment-clip' || active.materials.length === 0) continue;
        const original = composite;
        for (const material of active.materials) {
          const program = requiredProgram(material, options.mode);
          if (program === undefined) continue;
          const evaluated = evaluateMaterialInstance(material, options.timeUs, active.clip.range.startUs);
          composite = addNode(
            `${active.clip.id}:adjustment:${material.id}`,
            { source: composite },
            program,
            evaluated.parameters,
            { qualityScale: renderScale },
          );
          appliedMaterialIds.push(material.id);
        }
        const adjustmentParameters = visualParameters(
          active.clip.visual,
          options.ir.width,
          options.ir.height,
          width,
          height,
          options.timeUs,
          active.clip.range.startUs,
        );
        if (requiresBaseVisualPass(adjustmentParameters, width, height)) {
          composite = addNode(
            `${active.clip.id}:adjustment-visual`,
            { source: composite },
            BASE_VISUAL_PROGRAM,
            adjustmentParameters,
          );
          composite = addNode(
            `${active.clip.id}:adjustment-blend`,
            { base: original, overlay: composite },
            BLEND_PROGRAM,
            { blendMode: 0 },
          );
        }
      }

      if (composite.kind === 'external') {
        composite = addNode('final-copy', { source: composite }, COPY_PROGRAM);
      }
      throwIfAborted(options.signal, 'Render IR frame graph');
      const preferredBackend = this.#adaptiveBackend.select(options.preferredBackend ?? 'auto');
      inputsTransferred = true;
      const result = await this.#composeFrameGraphOwned({
        inputs: Object.fromEntries(externalFrames),
        nodes,
        outputNodeId: composite.id,
        width,
        height,
        preferredBackend,
        allowFallback: options.allowFallback ?? true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      this.#adaptiveBackend.record(preferredBackend, result);
      const outputFrame = takeBitmapFrame(result.bitmap, options.timeUs);
      try {
        return {
          bitmap: await presentationBitmap(outputFrame, options.signal),
          backend: result.backend,
          diagnostics: result.diagnostics,
          timing: result.timing,
          resources: result.resources,
          materialIds: appliedMaterialIds,
          width,
          height,
          renderScale,
        };
      } finally {
        outputFrame.close();
      }
    } finally {
      if (!inputsTransferred) externalFrames.forEach((frame) => frame.close());
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask;
    this.#disposeController.abort(new DOMException('RenderIrFrameRenderer was disposed', 'AbortError'));
    this.#compositor.dispose();
    clearRasterCache();
    const tasks = [...this.#renderTasks.values()];
    this.#disposeTask = Promise.allSettled(tasks).then(() => undefined);
    return this.#disposeTask;
  }

  async #composeFrameGraphOwned(options: ComposeFrameGraphOptions): Promise<ComposeSuccess> {
    // No asynchronous code can interleave this state check with composeFrameGraph()'s
    // synchronous admission. Once admitted, WorkerCompositor closes or transfers
    // every input; only this already-disposed path retains local ownership.
    if (this.#compositor.disposed) {
      new Set(Object.values(options.inputs)).forEach((frame) => frame.close());
      throw new ReferenceError('WorkerCompositor is disposed');
    }
    const result = await this.#compositor.composeFrameGraph(options);
    try {
      throwIfAborted(options.signal, 'Render IR composition');
      return result;
    } catch (error) {
      result.bitmap.close();
      throw error;
    }
  }
}
