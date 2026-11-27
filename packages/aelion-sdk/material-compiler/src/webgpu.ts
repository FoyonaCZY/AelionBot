import { buildMaterialExecutionPlan, compileMaterialGraph } from './compiler.js';
import { graphHash, identifier, literal } from './codegen-common.js';
import type {
  CompileMaterialOptions,
  GraphBinding,
  MaterialGraph,
  MaterialUniformBinding,
  WebGpuMaterialProgram,
} from './types.js';

function uniformExpression(binding: GraphBinding, uniforms: Map<string, MaterialUniformBinding>): string | undefined {
  let source: MaterialUniformBinding['source'] | undefined;
  if ('parameter' in binding) source = { kind: 'parameter', id: binding.parameter };
  if ('system' in binding) source = { kind: 'system', id: binding.system };
  if (source === undefined) return undefined;
  const name = `u_${source.kind}_${identifier(source.id)}`;
  if (!uniforms.has(name)) {
    uniforms.set(name, { name, type: 'float', source });
  }
  const index = [...uniforms.keys()].indexOf(name);
  return `uniforms.values[${index.toString()}].x`;
}

function bindingExpression(
  binding: GraphBinding,
  nodeExpressions: ReadonlyMap<string, string>,
  inputPorts: Set<string>,
  uniforms: Map<string, MaterialUniformBinding>,
): string {
  if ('value' in binding) return literal(binding.value, 'WebGPU');
  const uniform = uniformExpression(binding, uniforms);
  if (uniform !== undefined) return uniform;
  if ('inputPort' in binding) {
    inputPorts.add(binding.inputPort);
    return `textureSample(input_${identifier(binding.inputPort)}, source_sampler, vertex.uv)`;
  }
  if ('node' in binding) {
    const expression = nodeExpressions.get(binding.node);
    if (expression === undefined) throw new TypeError(`Node ${binding.node} has no expression`);
    return expression;
  }
  throw new TypeError('Resource bindings are not executable in the Phase 0 WebGPU backend');
}

function nodeExpression(
  type: string,
  input: (name: string) => string,
  binding: (name: string) => GraphBinding,
  options: CompileMaterialOptions,
): string {
  switch (type) {
    case 'time.transition-curve': {
      const curveBinding = binding('curve');
      const curve =
        'value' in curveBinding
          ? curveBinding.value
          : 'parameter' in curveBinding
            ? options.specializationValues?.[curveBinding.parameter]
            : undefined;
      if (curve === 'linear') return `clamp(${input('progress')}, 0.0, 1.0)`;
      if (curve === 'smooth') {
        return `smoothstep(0.0, 1.0, clamp(${input('progress')}, 0.0, 1.0))`;
      }
      throw new TypeError('time.transition-curve requires a linear or smooth specialization value');
    }
    case 'composite.mix':
      return `mix(${input('a')}, ${input('b')}, clamp(${input('amount')}, 0.0, 1.0))`;
    case 'color.temperature':
      return `aelion_temperature(${input('source')}, ${input('amount')})`;
    case 'color.lift-black':
      return `aelion_lift_black(${input('source')}, ${input('amount')})`;
    case 'color.scale-rgb':
      return `aelion_scale_rgb(${input('source')}, ${input('scale')})`;
    case 'composite.screen':
      return `aelion_screen(${input('base')}, ${input('overlay')})`;
    case 'math.add':
      return `(${input('a')} + ${input('b')})`;
    case 'math.subtract':
      return `(${input('a')} - ${input('b')})`;
    case 'math.multiply':
      return `(${input('a')} * ${input('b')})`;
    case 'math.divide':
      return `(${input('a')} / ${input('b')})`;
    case 'math.clamp':
      return `clamp(${input('value')}, ${input('min')}, ${input('max')})`;
    case 'math.smoothstep':
      return `smoothstep(${input('edge0')}, ${input('edge1')}, ${input('x')})`;
    case 'color.exposure':
      return `aelion_scale_rgb(${input('source')}, exp2(${input('stops')}))`;
    case 'color.contrast':
      return `aelion_contrast(${input('source')}, ${input('amount')})`;
    case 'color.saturation':
      return `aelion_saturation(${input('source')}, ${input('amount')})`;
    case 'color.invert':
      return `aelion_invert(${input('source')})`;
    case 'composite.multiply':
      return `aelion_multiply(${input('base')}, ${input('overlay')})`;
    case 'composite.add':
      return `aelion_add(${input('base')}, ${input('overlay')})`;
    default:
      throw new TypeError(`Node ${type} is not supported by the Phase 0 WebGPU backend`);
  }
}

const HELPERS = `
fn aelion_temperature(color: vec4f, amount: f32) -> vec4f {
  let scale = vec3f(1.0 + amount, 1.0 + amount * 0.15, 1.0 - amount * 0.55);
  return vec4f(max(color.rgb * scale, vec3f(0.0)), color.a);
}
fn aelion_lift_black(color: vec4f, amount: f32) -> vec4f {
  return vec4f(mix(color.rgb, vec3f(1.0), clamp(amount, 0.0, 1.0)), color.a);
}
fn aelion_scale_rgb(color: vec4f, scale: f32) -> vec4f {
  return vec4f(max(color.rgb * scale, vec3f(0.0)), color.a);
}
fn aelion_screen(base: vec4f, overlay: vec4f) -> vec4f {
  return vec4f(1.0 - (1.0 - base.rgb) * (1.0 - overlay.rgb), base.a + overlay.a - base.a * overlay.a);
}
fn aelion_contrast(color: vec4f, amount: f32) -> vec4f {
  return vec4f((color.rgb - vec3f(0.5)) * amount + vec3f(0.5), color.a);
}
fn aelion_saturation(color: vec4f, amount: f32) -> vec4f {
  let luma = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(mix(vec3f(luma), color.rgb, amount), color.a);
}
fn aelion_invert(color: vec4f) -> vec4f { return vec4f(color.a - color.rgb, color.a); }
fn aelion_multiply(base: vec4f, overlay: vec4f) -> vec4f { return vec4f(base.rgb * overlay.rgb, base.a * overlay.a); }
fn aelion_add(base: vec4f, overlay: vec4f) -> vec4f { return min(base + overlay, vec4f(1.0)); }
`;

export function compileMaterialGraphToWebGpu(
  graph: MaterialGraph,
  options: CompileMaterialOptions,
): WebGpuMaterialProgram {
  const analysis = compileMaterialGraph(graph, options);
  const errors = analysis.diagnostics.filter((value) => value.severity === 'error');
  if (errors.length > 0) {
    throw new TypeError(`Material graph is not executable: ${errors.map((value) => value.code).join(', ')}`);
  }
  if (graph.nodes.some((node) => node.type === 'blur.gaussian')) {
    throw new TypeError(
      'MATERIAL_BACKEND_UNAVAILABLE: multi-pass blur is not implemented on the WebGPU backend; use WebGL2 for blur.gaussian graphs',
    );
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const expressions = new Map<string, string>();
  const inputPorts = new Set<string>();
  const uniforms = new Map<string, MaterialUniformBinding>();
  for (const id of analysis.order) {
    const node = nodes.get(id);
    if (node === undefined) continue;
    const input = (name: string): string => {
      const value = node.inputs[name];
      if (value === undefined) throw new TypeError(`Node ${node.id} is missing ${name}`);
      return bindingExpression(value, expressions, inputPorts, uniforms);
    };
    const binding = (name: string): GraphBinding => {
      const value = node.inputs[name];
      if (value === undefined) throw new TypeError(`Node ${node.id} is missing ${name}`);
      return value;
    };
    expressions.set(id, nodeExpression(node.type, input, binding, options));
  }
  const output = graph.outputs.result ?? Object.values(graph.outputs)[0];
  if (output === undefined) throw new TypeError('Material graph has no output');
  const resultExpression = expressions.get(output.node);
  if (resultExpression === undefined) throw new TypeError('Material graph output is unavailable');
  const ports = [...inputPorts];
  const uniformValues = [...uniforms.values()];
  const textureDeclarations = ports
    .map(
      (port, index) => `@group(0) @binding(${(index + 1).toString()}) var input_${identifier(port)}: texture_2d<f32>;`,
    )
    .join('\n');
  const uniformBinding = ports.length + 1;
  const uniformSlots = Math.max(1, uniformValues.length);
  const hash = graphHash({
    ...graph,
    ...(options.specializationValues === undefined ? {} : { specializationValues: options.specializationValues }),
  });
  return {
    backend: 'webgpu',
    nodeSet: graph.nodeSet,
    graphHash: hash,
    inputPorts: ports,
    uniforms: uniformValues,
    executionPlan: buildMaterialExecutionPlan(graph, analysis),
    shader: `
struct Uniforms { values: array<vec4f, ${uniformSlots.toString()}> };
@group(0) @binding(0) var source_sampler: sampler;
${textureDeclarations}
@group(0) @binding(${uniformBinding.toString()}) var<uniform> uniforms: Uniforms;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOut(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}
${HELPERS}
@fragment fn fs(vertex: VertexOut) -> @location(0) vec4f {
  return ${resultExpression};
}
`,
  };
}
