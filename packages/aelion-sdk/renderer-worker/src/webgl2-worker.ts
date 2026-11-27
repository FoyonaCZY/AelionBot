/// <reference lib="webworker" />

import type {
  ComposeFrameGraphRequest,
  ComposeRequest,
  FrameGraphNode,
  RendererWorkerDiagnostic,
  RendererWorkerRequest,
  RendererWorkerResourceSnapshot,
  RendererWorkerResponse,
} from './protocol.js';

interface GpuBuffer {
  destroy(): void;
}

interface GpuTexture {
  createView(): unknown;
  destroy(): void;
}

interface GpuCanvasContext {
  configure(descriptor: {
    readonly device: GpuDevice;
    readonly format: 'rgba8unorm';
    readonly usage: number;
    readonly alphaMode: 'premultiplied';
  }): void;
  getCurrentTexture(): GpuTexture;
  unconfigure?(): void;
}

interface GpuQueue {
  submit(commands: readonly unknown[]): void;
  writeBuffer(buffer: GpuBuffer, offset: number, data: BufferSource): void;
}

interface GpuPipeline {
  getBindGroupLayout(index: number): unknown;
}

interface GpuDevice {
  readonly queue: GpuQueue;
  readonly lost: Promise<{ readonly reason: string; readonly message: string }>;
  createBindGroup(descriptor: object): unknown;
  createBuffer(descriptor: object): GpuBuffer;
  createCommandEncoder(): {
    beginRenderPass(descriptor: object): {
      draw(vertexCount: number): void;
      end(): void;
      setBindGroup(index: number, bindGroup: unknown): void;
      setPipeline(pipeline: unknown): void;
    };
    copyTextureToTexture(source: object, destination: object, size: object): void;
    finish(): unknown;
  };
  createRenderPipeline(descriptor: object): GpuPipeline;
  importExternalTexture(descriptor: { readonly source: VideoFrame }): unknown;
  createSampler(descriptor: object): unknown;
  createShaderModule(descriptor: object): unknown;
  createTexture(descriptor: object): GpuTexture;
  destroy(): void;
  popErrorScope(): Promise<{ readonly message: string } | null>;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
}

class RendererBackendError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RendererBackendError';
  }
}

function emptyResources(inputFrames: number): RendererWorkerResourceSnapshot {
  return {
    activeRequests: 0,
    cancelledRequests: 0,
    webgpuDevices: 0,
    webgpuPipelines: 0,
    webgpuBuffers: 0,
    webgpuTextures: 0,
    webgl2Contexts: 0,
    webgl2Programs: 0,
    webgl2Buffers: 0,
    webgl2Textures: 0,
    inputFrames,
  };
}

function backendError(error: unknown, fallbackCode: string): RendererBackendError {
  return error instanceof RendererBackendError
    ? error
    : new RendererBackendError(fallbackCode, error instanceof Error ? error.message : 'Unknown renderer backend error');
}

interface GpuNavigator extends Navigator {
  readonly gpu?: {
    requestAdapter(): Promise<{ requestDevice(): Promise<GpuDevice> } | null>;
  };
}

interface MutableWorkerTiming {
  gpuCompletionUs: number;
}

const GPU_BUFFER_USAGE = {
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
};
const GPU_TEXTURE_USAGE = {
  COPY_DST: 0x0002,
  COPY_SRC: 0x0001,
  RENDER_ATTACHMENT: 0x0010,
  TEXTURE_BINDING: 0x0004,
};

let persistentGpuDevice: GpuDevice | undefined;
let persistentGpuDeviceTask: Promise<GpuDevice> | undefined;
const persistentGpuPipelines = new Map<string, GpuPipeline>();
const persistentGpuTextures = new Map<string, GpuTexture[]>();
const MAX_POOLED_GPU_TEXTURE_BYTES = 256 * 1_024 * 1_024;
let pooledGpuTextureBytes = 0;

class WebGpuCanvasRuntime {
  readonly canvas: OffscreenCanvas;
  readonly context: GpuCanvasContext;

  public constructor(
    public readonly device: GpuDevice,
    public readonly width: number,
    public readonly height: number,
  ) {
    this.canvas = new OffscreenCanvas(width, height);
    const context = this.canvas.getContext('webgpu') as unknown as GpuCanvasContext | null;
    if (context === null) throw new Error('Worker WebGPU canvas context is unavailable');
    context.configure({
      device,
      format: 'rgba8unorm',
      usage: GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_DST,
      alphaMode: 'premultiplied',
    });
    this.context = context;
  }

  public dispose(): void {
    this.context.unconfigure?.();
  }
}

const MAX_WEBGPU_CANVAS_RUNTIMES = 2;
const webGpuCanvasRuntimes = new Map<string, WebGpuCanvasRuntime>();
let webGpuCanvasRuntimeClock = 0;
const webGpuCanvasAccess = new Map<string, number>();

function webGpuCanvasRuntime(device: GpuDevice, width: number, height: number): WebGpuCanvasRuntime {
  const key = `${width.toString()}x${height.toString()}`;
  let runtime = webGpuCanvasRuntimes.get(key);
  if (runtime !== undefined && runtime.device !== device) {
    runtime.dispose();
    webGpuCanvasRuntimes.delete(key);
    webGpuCanvasAccess.delete(key);
    runtime = undefined;
  }
  if (runtime === undefined) {
    runtime = new WebGpuCanvasRuntime(device, width, height);
    webGpuCanvasRuntimes.set(key, runtime);
  }
  webGpuCanvasAccess.set(key, ++webGpuCanvasRuntimeClock);
  while (webGpuCanvasRuntimes.size > MAX_WEBGPU_CANVAS_RUNTIMES) {
    const oldest = [...webGpuCanvasAccess.entries()].sort((left, right) => left[1] - right[1])[0];
    if (oldest === undefined) break;
    webGpuCanvasRuntimes.get(oldest[0])?.dispose();
    webGpuCanvasRuntimes.delete(oldest[0]);
    webGpuCanvasAccess.delete(oldest[0]);
  }
  return runtime;
}

function clearWebGpuCanvasRuntimes(): void {
  webGpuCanvasRuntimes.forEach((runtime) => runtime.dispose());
  webGpuCanvasRuntimes.clear();
  webGpuCanvasAccess.clear();
}

interface AcquiredGpuTexture {
  readonly texture: GpuTexture;
  readonly key: string;
  readonly bytes: number;
}

function gpuTextureKey(width: number, height: number, usage: number): string {
  return `${width.toString()}x${height.toString()}:rgba8unorm:${usage.toString()}`;
}

function acquireGpuTexture(device: GpuDevice, width: number, height: number, usage: number): AcquiredGpuTexture {
  const key = gpuTextureKey(width, height, usage);
  const bytes = width * height * 4;
  const bucket = persistentGpuTextures.get(key);
  const texture = bucket?.pop();
  if (texture !== undefined) {
    pooledGpuTextureBytes -= bytes;
    if (bucket?.length === 0) persistentGpuTextures.delete(key);
    return { texture, key, bytes };
  }
  return {
    texture: device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage,
    }),
    key,
    bytes,
  };
}

function releaseGpuTexture(acquired: AcquiredGpuTexture): void {
  if (pooledGpuTextureBytes + acquired.bytes > MAX_POOLED_GPU_TEXTURE_BYTES) {
    acquired.texture.destroy();
    return;
  }
  const bucket = persistentGpuTextures.get(acquired.key) ?? [];
  bucket.push(acquired.texture);
  persistentGpuTextures.set(acquired.key, bucket);
  pooledGpuTextureBytes += acquired.bytes;
}

function clearGpuTexturePool(): void {
  persistentGpuTextures.forEach((bucket) => bucket.forEach((texture) => texture.destroy()));
  persistentGpuTextures.clear();
  pooledGpuTextureBytes = 0;
}

function shaderIdentifier(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/gu, '_');
}

function shaderWithExternalInputs(shader: string, ports: readonly string[]): string {
  let output = shader;
  for (const port of ports) {
    const name = `input_${shaderIdentifier(port)}`;
    output = output
      .replace(`var ${name}: texture_2d<f32>;`, `var ${name}: texture_external;`)
      .replaceAll(`textureSample(${name}, source_sampler,`, `textureSampleBaseClampToEdge(${name}, source_sampler,`);
  }
  return output;
}

async function gpuDevice(): Promise<GpuDevice> {
  if (persistentGpuDevice !== undefined) return persistentGpuDevice;
  persistentGpuDeviceTask ??= (async () => {
    const gpu = (navigator as GpuNavigator).gpu;
    if (gpu === undefined) throw new Error('WebGPU is unavailable');
    const adapter = await gpu.requestAdapter();
    if (adapter === null) throw new Error('WebGPU adapter is unavailable');
    const device = await adapter.requestDevice();
    persistentGpuDevice = device;
    void device.lost.then(() => {
      if (persistentGpuDevice === device) {
        persistentGpuDevice = undefined;
        persistentGpuDeviceTask = undefined;
        persistentGpuPipelines.clear();
        clearWebGpuCanvasRuntimes();
        clearGpuTexturePool();
      }
    });
    return device;
  })().catch((error: unknown) => {
    persistentGpuDeviceTask = undefined;
    throw error;
  });
  return persistentGpuDeviceTask;
}

function disposeGpuRuntime(): void {
  clearWebGpuCanvasRuntimes();
  clearGpuTexturePool();
  persistentGpuDevice?.destroy();
  persistentGpuDevice = undefined;
  persistentGpuDeviceTask = undefined;
  persistentGpuPipelines.clear();
}

async function composeWebGpu(
  request: ComposeRequest,
  resources: RendererWorkerResourceSnapshot,
  timing: MutableWorkerTiming,
): Promise<ImageBitmap> {
  const webgpu = request.program.webgpu;
  if (webgpu === undefined) throw new Error('Material has no WebGPU program');
  const frames = webgpu.inputPorts.map((port) => {
    const frame = request.inputs[port];
    if (frame === undefined) throw new Error(`WebGPU Material input ${port} is missing`);
    return frame;
  });
  const device = await gpuDevice();
  (resources as { webgpuDevices: number }).webgpuDevices += 1;
  device.pushErrorScope('validation');
  let uniformBuffer: GpuBuffer | undefined;
  try {
    const presentation = webGpuCanvasRuntime(device, request.width, request.height);
    const outputTexture = presentation.context.getCurrentTexture();
    const inputTextures = frames.map((frame) => device.importExternalTexture({ source: frame }));
    (resources as { webgpuTextures: number }).webgpuTextures += inputTextures.length;
    if (request.debugSimulateLoss === 'webgpu-device') {
      disposeGpuRuntime();
      throw new RendererBackendError('RENDERER_WEBGPU_DEVICE_LOST', 'WebGPU device was lost during composition');
    }
    const uniformData = new Float32Array(Math.max(1, webgpu.uniforms.length) * 4);
    webgpu.uniforms.forEach((uniform, index) => {
      const value =
        uniform.source.kind === 'parameter'
          ? request.parameters[uniform.source.id]
          : request.systems[uniform.source.id];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`WebGPU Material uniform ${uniform.source.id} must be finite`);
      }
      uniformData[index * 4] = value;
    });
    uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    });
    (resources as { webgpuBuffers: number }).webgpuBuffers += 1;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    const shader = shaderWithExternalInputs(webgpu.shader, webgpu.inputPorts);
    const pipelineKey = `${request.program.graphHash}:external:${webgpu.inputPorts.join(',')}:${shader}`;
    let pipeline = persistentGpuPipelines.get(pipelineKey);
    if (pipeline === undefined) {
      const module = device.createShaderModule({ code: shader });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
      persistentGpuPipelines.set(pipelineKey, pipeline);
    }
    (resources as { webgpuPipelines: number }).webgpuPipelines += 1;
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        ...(inputTextures.length === 0
          ? []
          : [
              {
                binding: 0,
                resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
              },
            ]),
        ...inputTextures.map((texture, index) => ({
          binding: index + 1,
          resource: texture,
        })),
        { binding: inputTextures.length + 1, resource: { buffer: uniformBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: outputTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    const gpuStartedAt = performance.now();
    device.queue.submit([encoder.finish()]);
    const validationError = await device.popErrorScope();
    timing.gpuCompletionUs += Math.round((performance.now() - gpuStartedAt) * 1_000);
    if (validationError !== null) {
      throw new Error(`WebGPU validation failed: ${validationError.message}`);
    }
    return presentation.canvas.transferToImageBitmap();
  } finally {
    uniformBuffer?.destroy();
    (resources as { webgpuDevices: number }).webgpuDevices = 0;
    (resources as { webgpuPipelines: number }).webgpuPipelines = 0;
    (resources as { webgpuBuffers: number }).webgpuBuffers = 0;
    (resources as { webgpuTextures: number }).webgpuTextures = 0;
  }
}

function frameGraphWebGpuInput(
  device: GpuDevice,
  node: FrameGraphNode,
  port: string,
  externalFrames: ReadonlyMap<string, VideoFrame>,
  importedExternalTextures: Map<string, unknown>,
  nodeTextures: ReadonlyMap<string, AcquiredGpuTexture>,
): { readonly external: boolean; readonly resource: unknown } {
  const reference = node.inputs[port];
  if (reference === undefined) {
    throw new RangeError(`Frame graph node ${node.id} is missing input ${port}`);
  }
  if (reference.kind === 'external') {
    const frame = externalFrames.get(reference.id);
    if (frame === undefined) {
      throw new RangeError(`Frame graph node ${node.id} references unknown external input ${reference.id}`);
    }
    let texture = importedExternalTextures.get(reference.id);
    if (texture === undefined) {
      texture = device.importExternalTexture({ source: frame });
      importedExternalTextures.set(reference.id, texture);
    }
    return { external: true, resource: texture };
  }
  const texture = nodeTextures.get(reference.id);
  if (texture === undefined) {
    throw new RangeError(`Frame graph node ${node.id} references unknown prior node ${reference.id}`);
  }
  return { external: false, resource: texture.texture.createView() };
}

async function composeWebGpuFrameGraph(
  request: ComposeFrameGraphRequest,
  resources: RendererWorkerResourceSnapshot,
  timing: MutableWorkerTiming,
): Promise<ImageBitmap> {
  if (
    !Number.isInteger(request.width) ||
    !Number.isInteger(request.height) ||
    request.width <= 0 ||
    request.height <= 0
  ) {
    throw new RangeError('Frame graph dimensions must be positive integers');
  }
  if (request.nodes.length === 0) throw new RangeError('Frame graph has no nodes');
  const device = await gpuDevice();
  (resources as { webgpuDevices: number }).webgpuDevices = 1;
  const textureUsage =
    GPU_TEXTURE_USAGE.TEXTURE_BINDING |
    GPU_TEXTURE_USAGE.COPY_DST |
    GPU_TEXTURE_USAGE.COPY_SRC |
    GPU_TEXTURE_USAGE.RENDER_ATTACHMENT;
  const allocatedTextures: AcquiredGpuTexture[] = [];
  const uniformBuffers: GpuBuffer[] = [];
  const externalFrames = new Map(Object.entries(request.inputs));
  const importedExternalTextures = new Map<string, unknown>();
  const nodeTextures = new Map<string, AcquiredGpuTexture>();
  let errorScopeOpen = false;
  try {
    device.pushErrorScope('validation');
    errorScopeOpen = true;
    const encoder = device.createCommandEncoder();
    for (const node of request.nodes) {
      if (cancelledRequestIds.has(request.id)) {
        throw new DOMException('Renderer request cancelled', 'AbortError');
      }
      if (nodeTextures.has(node.id)) {
        throw new RangeError(`Frame graph node id ${node.id} is duplicated`);
      }
      const webgpu = node.program.webgpu;
      if (webgpu === undefined) {
        throw new RendererBackendError(
          'RENDERER_WEBGPU_GRAPH_NODE_UNAVAILABLE',
          `Frame graph node ${node.id} (${node.program.graphHash}) has no WebGPU program`,
        );
      }
      const inputs = webgpu.inputPorts.map((port) =>
        frameGraphWebGpuInput(device, node, port, externalFrames, importedExternalTextures, nodeTextures),
      );
      const output = acquireGpuTexture(device, request.width, request.height, textureUsage);
      allocatedTextures.push(output);
      nodeTextures.set(node.id, output);
      const uniformData = new Float32Array(Math.max(1, webgpu.uniforms.length) * 4);
      webgpu.uniforms.forEach((uniform, index) => {
        uniformData[index * 4] = materialUniformValue(uniform, node.parameters, node.systems);
      });
      const uniformBuffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
      });
      uniformBuffers.push(uniformBuffer);
      device.queue.writeBuffer(uniformBuffer, 0, uniformData);
      const externalPorts = webgpu.inputPorts.filter((_port, index) => inputs[index]?.external === true);
      const shader = shaderWithExternalInputs(webgpu.shader, externalPorts);
      const pipelineKey = `${node.program.graphHash}:external:${externalPorts.join(',')}:${shader}`;
      let pipeline = persistentGpuPipelines.get(pipelineKey);
      if (pipeline === undefined) {
        const module = device.createShaderModule({ code: shader });
        pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        });
        persistentGpuPipelines.set(pipelineKey, pipeline);
      }
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...(inputs.length === 0
            ? []
            : [
                {
                  binding: 0,
                  resource: device.createSampler({
                    magFilter: 'linear',
                    minFilter: 'linear',
                  }),
                },
              ]),
          ...inputs.map((texture, index) => ({
            binding: index + 1,
            resource: texture.resource,
          })),
          { binding: inputs.length + 1, resource: { buffer: uniformBuffer } },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: output.texture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    const output = nodeTextures.get(request.outputNodeId);
    if (output === undefined) {
      throw new RangeError(`Frame graph output node ${request.outputNodeId} is missing`);
    }
    const presentation = webGpuCanvasRuntime(device, request.width, request.height);
    const presentationTexture = presentation.context.getCurrentTexture();
    encoder.copyTextureToTexture(
      { texture: output.texture },
      { texture: presentationTexture },
      { width: request.width, height: request.height },
    );
    (resources as { webgpuTextures: number }).webgpuTextures = allocatedTextures.length + importedExternalTextures.size;
    (resources as { webgpuBuffers: number }).webgpuBuffers = uniformBuffers.length;
    (resources as { webgpuPipelines: number }).webgpuPipelines = request.nodes.length;
    const gpuStartedAt = performance.now();
    device.queue.submit([encoder.finish()]);
    const validationError = await device.popErrorScope();
    timing.gpuCompletionUs += Math.round((performance.now() - gpuStartedAt) * 1_000);
    errorScopeOpen = false;
    if (validationError !== null) {
      throw new RendererBackendError(
        'RENDERER_WEBGPU_VALIDATION_FAILED',
        `WebGPU validation failed: ${validationError.message}`,
      );
    }
    return presentation.canvas.transferToImageBitmap();
  } finally {
    if (errorScopeOpen) void device.popErrorScope();
    uniformBuffers.forEach((buffer) => buffer.destroy());
    allocatedTextures.forEach((texture) => {
      if (persistentGpuDevice === device) releaseGpuTexture(texture);
      else texture.texture.destroy();
    });
    (resources as { webgpuDevices: number }).webgpuDevices = 0;
    (resources as { webgpuPipelines: number }).webgpuPipelines = 0;
    (resources as { webgpuBuffers: number }).webgpuBuffers = 0;
    (resources as { webgpuTextures: number }).webgpuTextures = 0;
  }
}

const vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_uv;
}`;

/** Retained render targets beyond this are deleted instead of pooled. */
const MAX_POOLED_FRAME_GRAPH_TARGETS = 32;

class WebGl2Runtime {
  readonly canvas: OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  readonly #programs = new Map<string, WebGLProgram>();
  readonly #textures: WebGLTexture[] = [];
  readonly #positionBuffer: WebGLBuffer;
  readonly #uvBuffer: WebGLBuffer;
  /** Free render targets at the current size, reused across frames. */
  readonly #targetPool: FrameGraphTexture[] = [];
  /** Targets handed out for the frame in flight. */
  readonly #targetsInUse: FrameGraphTexture[] = [];
  public width: number;
  public height: number;
  lastAccess = 0;

  public constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas = new OffscreenCanvas(width, height);
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (gl === null) throw new Error('Worker WebGL2 context is unavailable');
    this.gl = gl;
    this.#positionBuffer = this.#createBuffer([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.#uvBuffer = this.#createBuffer([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
  }

  public program(fragmentShader: string): WebGLProgram {
    const cached = this.#programs.get(fragmentShader);
    if (cached !== undefined) return cached;
    const program = createProgram(this.gl, fragmentShader);
    this.#programs.set(fragmentShader, program);
    return program;
  }

  public bindAttributes(program: WebGLProgram): void {
    this.#bindAttribute(program, 'a_position', this.#positionBuffer);
    this.#bindAttribute(program, 'a_uv', this.#uvBuffer);
  }

  public uploadTexture(index: number, source: VideoFrame | ImageBitmap): WebGLTexture {
    const gl = this.gl;
    let texture = this.#textures[index];
    if (texture === undefined) {
      texture = gl.createTexture();
      this.#textures[index] = texture;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as unknown as TexImageSource);
    return texture;
  }

  /**
   * Resizes the drawing buffer in place. Compiled programs, vertex buffers and
   * input textures are resolution independent and survive; only the render
   * target pool is sized and has to be dropped.
   */
  public resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.#releaseTargetPool();
  }

  /** Borrows a render target for the frame in flight. */
  public acquireTarget(): FrameGraphTexture {
    const pooled = this.#targetPool.pop();
    const target = pooled ?? createFrameGraphTexture(this.gl, this.width, this.height);
    this.#targetsInUse.push(target);
    return target;
  }

  /** Returns every borrowed target to the pool. Call once per frame. */
  public releaseTargets(): void {
    for (const target of this.#targetsInUse) {
      if (this.#targetPool.length < MAX_POOLED_FRAME_GRAPH_TARGETS) {
        this.#targetPool.push(target);
        continue;
      }
      this.#deleteTarget(target);
    }
    this.#targetsInUse.length = 0;
  }

  public snapshot(): {
    readonly programs: number;
    readonly textures: number;
    readonly buffers: number;
  } {
    return {
      programs: this.#programs.size,
      textures: this.#textures.length + this.#targetPool.length + this.#targetsInUse.length,
      buffers: 2,
    };
  }

  public dispose(): void {
    const gl = this.gl;
    this.#programs.forEach((program) => gl.deleteProgram(program));
    this.#programs.clear();
    this.#textures.forEach((texture) => gl.deleteTexture(texture));
    this.#textures.length = 0;
    this.#releaseTargetPool();
    gl.deleteBuffer(this.#positionBuffer);
    gl.deleteBuffer(this.#uvBuffer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  #releaseTargetPool(): void {
    for (const target of this.#targetPool) this.#deleteTarget(target);
    for (const target of this.#targetsInUse) this.#deleteTarget(target);
    this.#targetPool.length = 0;
    this.#targetsInUse.length = 0;
  }

  #deleteTarget(target: FrameGraphTexture): void {
    if (target.framebuffer !== undefined) this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  #createBuffer(values: readonly number[]): WebGLBuffer {
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(values), this.gl.STATIC_DRAW);
    return buffer;
  }

  #bindAttribute(program: WebGLProgram, name: string, buffer: WebGLBuffer): void {
    const location = this.gl.getAttribLocation(program, name);
    if (location < 0) throw new Error(`Missing WebGL attribute ${name}`);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribPointer(location, 2, this.gl.FLOAT, false, 0, 0);
  }
}

/**
 * One context, resized on demand.
 *
 * Keying runtimes by output size meant every renderScale change built a fresh
 * WebGL2 context and recompiled every shader, because the program cache lives
 * on the runtime. Adaptive preview quality walks several scales, so that ran on
 * ordinary playback. Programs, buffers and input textures do not depend on the
 * drawing buffer size, so resizing keeps all of them.
 */
let webGl2RuntimeInstance: WebGl2Runtime | undefined;
let webGl2RuntimeClock = 0;

function webGl2Runtime(width: number, height: number): WebGl2Runtime {
  let runtime = webGl2RuntimeInstance;
  if (runtime?.gl.isContextLost() === true) {
    runtime.dispose();
    runtime = undefined;
    webGl2RuntimeInstance = undefined;
  }
  if (runtime === undefined) {
    runtime = new WebGl2Runtime(width, height);
    webGl2RuntimeInstance = runtime;
  } else {
    runtime.resize(width, height);
  }
  runtime.lastAccess = ++webGl2RuntimeClock;
  return runtime;
}

/** Drops the context after a loss so the next frame rebuilds it. */
function dropWebGl2Runtime(): void {
  webGl2RuntimeInstance?.dispose();
  webGl2RuntimeInstance = undefined;
}

function disposeWebGl2Runtimes(): void {
  dropWebGl2Runtime();
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('Unable to allocate WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentShaderSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown program link error';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function uniformValue(uniform: ComposeRequest['program']['uniforms'][number], request: ComposeRequest): number {
  return materialUniformValue(uniform, request.parameters, request.systems);
}

function materialUniformValue(
  uniform: ComposeRequest['program']['uniforms'][number],
  parameters: ComposeRequest['parameters'],
  systems: ComposeRequest['systems'],
): number {
  const value = uniform.source.kind === 'parameter' ? parameters[uniform.source.id] : systems[uniform.source.id];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Material uniform ${uniform.source.id} must be a finite number`);
  }
  return value;
}

function renderWebGl2Pass(
  request: ComposeRequest,
  fragmentShader: string,
  passInputs: readonly {
    readonly sampler: string;
    readonly source: VideoFrame | ImageBitmap;
  }[],
  uniforms: ComposeRequest['program']['uniforms'],
  timing: MutableWorkerTiming,
): ImageBitmap {
  const runtime = webGl2Runtime(request.width, request.height);
  const gl = runtime.gl;
  const program = runtime.program(fragmentShader);
  gl.useProgram(program);
  runtime.bindAttributes(program);
  passInputs.forEach((input, index) => {
    gl.activeTexture(gl.TEXTURE0 + index);
    runtime.uploadTexture(index, input.source);
    gl.uniform1i(gl.getUniformLocation(program, `u_input_${input.sampler}`), index);
  });
  for (const uniform of uniforms) {
    gl.uniform1f(gl.getUniformLocation(program, uniform.name), uniformValue(uniform, request));
  }
  gl.viewport(0, 0, request.width, request.height);
  const gpuStartedAt = performance.now();
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  // No gl.finish(): transferToImageBitmap already orders against the pending
  // draw, so the explicit stall only served to make the timing below a
  // completion measure. It now reports submission, matching the WebGPU path.
  timing.gpuCompletionUs += Math.round((performance.now() - gpuStartedAt) * 1_000);
  if (gl.isContextLost()) {
    dropWebGl2Runtime();
    throw new RendererBackendError('RENDERER_WEBGL_CONTEXT_LOST', 'WebGL2 context was lost during composition');
  }
  const bitmap = runtime.canvas.transferToImageBitmap();
  // Chromium may evict a context between GPU completion and bitmap transfer
  // when several tabs/workers contend for the page context budget. Never return
  // the resulting transparent/stale bitmap as a successful composition.
  if (gl.isContextLost()) {
    bitmap.close();
    dropWebGl2Runtime();
    throw new RendererBackendError(
      'RENDERER_WEBGL_CONTEXT_LOST',
      'WebGL2 context was lost while transferring the composed frame',
    );
  }
  return bitmap;
}

function composeWebGl2MultiPass(
  request: ComposeRequest,
  resources: RendererWorkerResourceSnapshot,
  timing: MutableWorkerTiming,
): ImageBitmap {
  const passes = request.program.passes;
  if (passes === undefined || passes.length === 0) {
    throw new TypeError('Multi-pass WebGL2 program has no passes');
  }
  const outputs = new Map<string, ImageBitmap>();
  (resources as { webgl2Contexts: number }).webgl2Contexts = passes.length;
  (resources as { webgl2Programs: number }).webgl2Programs = passes.length;
  (resources as { webgl2Buffers: number }).webgl2Buffers = passes.length * 2;
  try {
    for (const pass of passes) {
      const inputs = pass.inputs.map((input) => {
        const source =
          input.source.kind === 'external' ? request.inputs[input.source.port] : outputs.get(input.source.passId);
        if (source === undefined) {
          throw new RangeError(`Material pass ${pass.id} is missing input ${input.sampler}`);
        }
        return { sampler: input.sampler, source };
      });
      (resources as { webgl2Textures: number }).webgl2Textures = inputs.length;
      const bitmap = renderWebGl2Pass(request, pass.fragmentShader, inputs, pass.uniforms, timing);
      outputs.set(pass.id, bitmap);
    }
    const last = outputs.get(passes.at(-1)?.id ?? '');
    if (last === undefined) throw new Error('Multi-pass Material produced no output');
    outputs.delete(passes.at(-1)?.id ?? '');
    return last;
  } finally {
    outputs.forEach((bitmap) => bitmap.close());
    (resources as { webgl2Contexts: number }).webgl2Contexts = 0;
    (resources as { webgl2Programs: number }).webgl2Programs = 0;
    (resources as { webgl2Buffers: number }).webgl2Buffers = 0;
    (resources as { webgl2Textures: number }).webgl2Textures = 0;
  }
}

function composeWebGl2(
  request: ComposeRequest,
  resources: RendererWorkerResourceSnapshot,
  timing: MutableWorkerTiming,
): ImageBitmap {
  if (
    !Number.isInteger(request.width) ||
    !Number.isInteger(request.height) ||
    request.width <= 0 ||
    request.height <= 0
  ) {
    throw new RangeError('Composition dimensions must be positive integers');
  }
  for (const port of request.program.inputPorts) {
    if (request.inputs[port] === undefined) {
      throw new RangeError(`Material input ${port} is missing`);
    }
  }
  if (request.program.passes !== undefined) {
    return composeWebGl2MultiPass(request, resources, timing);
  }
  const inputs = request.program.inputPorts.map((port) => {
    const source = request.inputs[port];
    if (source === undefined) throw new RangeError(`Material input ${port} is missing`);
    return { sampler: port.replaceAll(/[^a-zA-Z0-9_]/gu, '_'), source };
  });
  if (request.debugSimulateLoss === 'webgl2-context') {
    const runtime = webGl2Runtime(request.width, request.height);
    runtime.gl.getExtension('WEBGL_lose_context')?.loseContext();
    dropWebGl2Runtime();
    throw new RendererBackendError('RENDERER_WEBGL_CONTEXT_LOST', 'WebGL2 context was lost during composition');
  }
  return renderWebGl2Pass(request, request.program.fragmentShader, inputs, request.program.uniforms, timing);
}

async function composeWebGl2WithAdmissionRetry(
  request: ComposeRequest,
  resources: RendererWorkerResourceSnapshot,
  timing: MutableWorkerTiming,
): Promise<ImageBitmap> {
  const maxAttempts = 80;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return composeWebGl2(request, resources, timing);
    } catch (error) {
      const unavailable = error instanceof Error && error.message === 'Worker WebGL2 context is unavailable';
      if (!unavailable) throw error;
      if (cancelledRequestIds.has(request.id)) {
        throw new DOMException('Renderer request cancelled', 'AbortError');
      }
      if (attempt === maxAttempts - 1) {
        throw new RendererBackendError(
          'RENDERER_WEBGL_ADMISSION_TIMEOUT',
          'Timed out waiting for a page WebGL2 context budget',
        );
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    }
  }
  throw new RendererBackendError(
    'RENDERER_WEBGL_ADMISSION_TIMEOUT',
    'Timed out waiting for a page WebGL2 context budget',
  );
}

interface FrameGraphTexture {
  readonly texture: WebGLTexture;
  readonly framebuffer?: WebGLFramebuffer;
}

const FRAME_GRAPH_COPY_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_input_source;
in vec2 v_uv;
out vec4 out_color;
void main() {
  out_color = texture(u_input_source, v_uv);
}`;

/**
 * Allocates a colour-attachment render target. External inputs no longer come
 * through here: they upload into the runtime's reusable input slots.
 */
function createFrameGraphTexture(gl: WebGL2RenderingContext, width: number, height: number): FrameGraphTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new RendererBackendError(
      'RENDERER_WEBGL_FRAMEBUFFER_INCOMPLETE',
      'Unable to allocate a complete WebGL2 frame graph target',
    );
  }
  return { texture, framebuffer };
}

function bindFrameGraphInputs(
  runtime: WebGl2Runtime,
  program: WebGLProgram,
  inputs: readonly { readonly sampler: string; readonly texture: WebGLTexture }[],
): void {
  const gl = runtime.gl;
  inputs.forEach((input, index) => {
    if (index >= gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) {
      throw new RangeError('Frame graph node exceeds the WebGL2 texture unit limit');
    }
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, input.texture);
    gl.uniform1i(gl.getUniformLocation(program, `u_input_${input.sampler}`), index);
  });
}

function drawFrameGraphPass(
  runtime: WebGl2Runtime,
  fragmentShader: string,
  inputs: readonly { readonly sampler: string; readonly texture: WebGLTexture }[],
  uniforms: ComposeRequest['program']['uniforms'],
  parameters: ComposeRequest['parameters'],
  systems: ComposeRequest['systems'],
  target: WebGLFramebuffer | null,
): void {
  const gl = runtime.gl;
  const program = runtime.program(fragmentShader);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target);
  gl.useProgram(program);
  runtime.bindAttributes(program);
  bindFrameGraphInputs(runtime, program, inputs);
  for (const uniform of uniforms) {
    gl.uniform1f(gl.getUniformLocation(program, uniform.name), materialUniformValue(uniform, parameters, systems));
  }
  gl.viewport(0, 0, runtime.width, runtime.height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function frameGraphInputTexture(
  request: ComposeFrameGraphRequest,
  node: FrameGraphNode,
  port: string,
  externalTextures: ReadonlyMap<string, FrameGraphTexture>,
  nodeTextures: ReadonlyMap<string, FrameGraphTexture>,
): WebGLTexture {
  const reference = node.inputs[port];
  if (reference === undefined) {
    throw new RangeError(`Frame graph node ${node.id} is missing input ${port}`);
  }
  const resolved = reference.kind === 'external' ? externalTextures.get(reference.id) : nodeTextures.get(reference.id);
  if (resolved === undefined) {
    const sourceKind = reference.kind === 'external' ? 'external input' : 'prior node';
    throw new RangeError(`Frame graph node ${node.id} references unknown ${sourceKind} ${reference.id}`);
  }
  if (reference.kind === 'external' && request.inputs[reference.id] === undefined) {
    throw new RangeError(`Frame graph external input ${reference.id} is missing`);
  }
  return resolved.texture;
}

function executeFrameGraphNode(
  request: ComposeFrameGraphRequest,
  runtime: WebGl2Runtime,
  node: FrameGraphNode,
  externalTextures: ReadonlyMap<string, FrameGraphTexture>,
  nodeTextures: Map<string, FrameGraphTexture>,
): void {
  if (nodeTextures.has(node.id)) {
    throw new RangeError(`Frame graph node id ${node.id} is duplicated`);
  }
  const passes = node.program.passes;
  if (passes === undefined) {
    const target = runtime.acquireTarget();
    const inputs = node.program.inputPorts.map((port) => ({
      sampler: port.replaceAll(/[^a-zA-Z0-9_]/gu, '_'),
      texture: frameGraphInputTexture(request, node, port, externalTextures, nodeTextures),
    }));
    drawFrameGraphPass(
      runtime,
      node.program.fragmentShader,
      inputs,
      node.program.uniforms,
      node.parameters,
      node.systems,
      target.framebuffer ?? null,
    );
    nodeTextures.set(node.id, target);
    return;
  }
  if (passes.length === 0) {
    throw new TypeError(`Frame graph node ${node.id} has an empty multi-pass program`);
  }
  const passTextures = new Map<string, FrameGraphTexture>();
  for (const pass of passes) {
    if (passTextures.has(pass.id)) {
      throw new RangeError(`Material pass id ${pass.id} is duplicated in node ${node.id}`);
    }
    const target = runtime.acquireTarget();
    const inputs = pass.inputs.map((input) => {
      const texture =
        input.source.kind === 'external'
          ? frameGraphInputTexture(request, node, input.source.port, externalTextures, nodeTextures)
          : passTextures.get(input.source.passId)?.texture;
      if (texture === undefined) {
        throw new RangeError(`Frame graph node ${node.id} pass ${pass.id} references unknown input ${input.sampler}`);
      }
      return { sampler: input.sampler, texture };
    });
    drawFrameGraphPass(
      runtime,
      pass.fragmentShader,
      inputs,
      pass.uniforms,
      node.parameters,
      node.systems,
      target.framebuffer ?? null,
    );
    passTextures.set(pass.id, target);
  }
  const output = passTextures.get(passes.at(-1)?.id ?? '');
  if (output === undefined) throw new Error(`Frame graph node ${node.id} produced no output`);
  nodeTextures.set(node.id, output);
}

function composeWebGl2FrameGraph(
  request: ComposeFrameGraphRequest,
  resources: RendererWorkerResourceSnapshot,
  timing: MutableWorkerTiming,
): ImageBitmap {
  if (
    !Number.isInteger(request.width) ||
    !Number.isInteger(request.height) ||
    request.width <= 0 ||
    request.height <= 0
  ) {
    throw new RangeError('Frame graph dimensions must be positive integers');
  }
  if (request.nodes.length === 0) throw new RangeError('Frame graph has no nodes');
  const runtime = webGl2Runtime(request.width, request.height);
  const gl = runtime.gl;
  const externalTextures = new Map<string, FrameGraphTexture>();
  const nodeTextures = new Map<string, FrameGraphTexture>();
  (resources as { webgl2Contexts: number }).webgl2Contexts = 1;
  (resources as { webgl2Buffers: number }).webgl2Buffers = 2;
  try {
    // Input textures are reused by slot and render targets come from the pool,
    // so a steady-state frame allocates no GPU memory. Previously every input
    // and every node built a texture (plus an FBO) that was deleted again at
    // the end of the frame — at 1080p that is 8 MB of churn per surface.
    let inputSlot = 0;
    for (const [id, frame] of Object.entries(request.inputs)) {
      externalTextures.set(id, { texture: runtime.uploadTexture(inputSlot, frame) });
      inputSlot += 1;
    }
    const gpuStartedAt = performance.now();
    for (const node of request.nodes) {
      if (cancelledRequestIds.has(request.id)) {
        throw new DOMException('Renderer request cancelled', 'AbortError');
      }
      executeFrameGraphNode(request, runtime, node, externalTextures, nodeTextures);
    }
    const output = nodeTextures.get(request.outputNodeId);
    if (output === undefined) {
      throw new RangeError(`Frame graph output node ${request.outputNodeId} is missing`);
    }
    drawFrameGraphPass(
      runtime,
      FRAME_GRAPH_COPY_SHADER,
      [{ sampler: 'source', texture: output.texture }],
      [],
      {},
      {},
      null,
    );
    // See renderWebGl2Pass: transferToImageBitmap orders against the pending
    // draws, so this timing is submission rather than completion.
    timing.gpuCompletionUs += Math.round((performance.now() - gpuStartedAt) * 1_000);
    if (gl.isContextLost()) {
      dropWebGl2Runtime();
      throw new RendererBackendError(
        'RENDERER_WEBGL_CONTEXT_LOST',
        'WebGL2 context was lost during frame graph composition',
      );
    }
    (resources as { webgl2Programs: number }).webgl2Programs = runtime.snapshot().programs;
    (resources as { webgl2Textures: number }).webgl2Textures = runtime.snapshot().textures;
    const bitmap = runtime.canvas.transferToImageBitmap();
    if (gl.isContextLost()) {
      bitmap.close();
      dropWebGl2Runtime();
      throw new RendererBackendError(
        'RENDERER_WEBGL_CONTEXT_LOST',
        'WebGL2 context was lost while transferring the frame graph result',
      );
    }
    return bitmap;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    runtime.releaseTargets();
    (resources as { webgl2Contexts: number }).webgl2Contexts = 0;
    (resources as { webgl2Programs: number }).webgl2Programs = 0;
    (resources as { webgl2Buffers: number }).webgl2Buffers = 0;
    (resources as { webgl2Textures: number }).webgl2Textures = 0;
  }
}

async function composeWebGl2FrameGraphWithAdmissionRetry(
  request: ComposeFrameGraphRequest,
  resources: RendererWorkerResourceSnapshot,
  timing: MutableWorkerTiming,
): Promise<ImageBitmap> {
  const maxAttempts = 80;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return composeWebGl2FrameGraph(request, resources, timing);
    } catch (error) {
      const unavailable = error instanceof Error && error.message === 'Worker WebGL2 context is unavailable';
      if (!unavailable) throw error;
      if (cancelledRequestIds.has(request.id)) {
        throw new DOMException('Renderer request cancelled', 'AbortError');
      }
      if (attempt === maxAttempts - 1) {
        throw new RendererBackendError(
          'RENDERER_WEBGL_ADMISSION_TIMEOUT',
          'Timed out waiting for a page WebGL2 context budget',
        );
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    }
  }
  throw new RendererBackendError(
    'RENDERER_WEBGL_ADMISSION_TIMEOUT',
    'Timed out waiting for a page WebGL2 context budget',
  );
}

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;
const MAX_ACTIVE_REQUESTS = 8;
const activeRequestIds = new Set<number>();
const cancelledRequestIds = new Set<number>();

function finishRequest(id: number, resources: RendererWorkerResourceSnapshot): void {
  activeRequestIds.delete(id);
  cancelledRequestIds.delete(id);
  (resources as { activeRequests: number }).activeRequests = activeRequestIds.size;
  (resources as { cancelledRequests: number }).cancelledRequests = cancelledRequestIds.size;
}

function acknowledgeCancellation(id: number): void {
  worker.postMessage({ type: 'cancelled', id } satisfies RendererWorkerResponse);
}

worker.addEventListener('message', (event: MessageEvent<RendererWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'dispose') {
    disposeGpuRuntime();
    disposeWebGl2Runtimes();
    worker.close();
    return;
  }
  if (request.type === 'cancel') {
    if (activeRequestIds.has(request.id)) cancelledRequestIds.add(request.id);
    return;
  }
  if (request.type === 'inspect-resources') {
    request.responsePort.postMessage({
      activeRequests: activeRequestIds.size,
      cancelledRequests: cancelledRequestIds.size,
    });
    request.responsePort.close();
    return;
  }

  if (activeRequestIds.size >= MAX_ACTIVE_REQUESTS) {
    Object.values(request.inputs).forEach((frame) => frame.close());
    worker.postMessage({
      type: 'failed',
      id: request.id,
      code: 'RENDERER_QUEUE_FULL',
      message: `Renderer Worker reached its ${MAX_ACTIVE_REQUESTS.toString()} active request limit`,
    } satisfies RendererWorkerResponse);
    return;
  }

  activeRequestIds.add(request.id);
  void (async () => {
    const workerStartedAt = performance.now();
    let response: RendererWorkerResponse;
    const diagnostics: RendererWorkerDiagnostic[] = [];
    const resources = emptyResources(Object.keys(request.inputs).length);
    const timing: MutableWorkerTiming = { gpuCompletionUs: 0 };
    let inputsClosed = false;
    const closeInputs = (): void => {
      if (inputsClosed) return;
      inputsClosed = true;
      Object.values(request.inputs).forEach((frame) => frame.close());
      (resources as { inputFrames: number }).inputFrames = 0;
    };
    try {
      let bitmap: ImageBitmap;
      let backend: 'webgpu' | 'webgl2';
      if (request.type === 'compose-frame-graph') {
        if (request.preferredBackend === 'webgpu') {
          try {
            bitmap = await composeWebGpuFrameGraph(request, resources, timing);
            backend = 'webgpu';
          } catch (error) {
            const failure = backendError(error, 'RENDERER_WEBGPU_FRAME_GRAPH_FAILED');
            if (!request.allowFallback) throw failure;
            diagnostics.push({ code: failure.code, message: failure.message });
            bitmap = await composeWebGl2FrameGraphWithAdmissionRetry(request, resources, timing);
            backend = 'webgl2';
          }
        } else {
          bitmap = await composeWebGl2FrameGraphWithAdmissionRetry(request, resources, timing);
          backend = 'webgl2';
        }
      } else if (request.preferredBackend === 'webgpu') {
        try {
          bitmap = await composeWebGpu(request, resources, timing);
          backend = 'webgpu';
        } catch (error) {
          const failure = backendError(error, 'RENDERER_WEBGPU_FAILED');
          if (!request.allowFallback) throw failure;
          diagnostics.push({ code: failure.code, message: failure.message });
          bitmap = await composeWebGl2WithAdmissionRetry(request, resources, timing);
          backend = 'webgl2';
        }
      } else {
        bitmap = await composeWebGl2WithAdmissionRetry(request, resources, timing);
        backend = 'webgl2';
      }
      closeInputs();
      if (cancelledRequestIds.has(request.id)) {
        bitmap.close();
        finishRequest(request.id, resources);
        acknowledgeCancellation(request.id);
        return;
      }
      finishRequest(request.id, resources);
      response = {
        type: 'composed',
        id: request.id,
        bitmap,
        backend,
        graphHash:
          request.type === 'compose'
            ? request.program.graphHash
            : `frame-graph:${request.nodes.map((node) => `${node.id}:${node.program.graphHash}`).join('|')}`,
        diagnostics,
        resources,
        outputBitmapOwner: 'caller',
        timing: {
          totalWorkerUs: Math.round((performance.now() - workerStartedAt) * 1_000),
          gpuCompletionUs: timing.gpuCompletionUs,
        },
      };
      worker.postMessage(response, [bitmap]);
    } catch (error) {
      if (cancelledRequestIds.has(request.id)) {
        finishRequest(request.id, resources);
        acknowledgeCancellation(request.id);
        return;
      }
      finishRequest(request.id, resources);
      const failure = backendError(error, 'RENDERER_WORKER_COMPOSE_FAILED');
      response = {
        type: 'failed',
        id: request.id,
        code: failure.code,
        message: failure.message,
      };
      worker.postMessage(response);
    } finally {
      closeInputs();
      finishRequest(request.id, resources);
    }
  })();
});
