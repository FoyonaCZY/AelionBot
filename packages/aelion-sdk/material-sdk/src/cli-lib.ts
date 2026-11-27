import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type { JsonValue } from '@aelionsdk/core';
import type { MaterialGraph } from '@aelionsdk/material-compiler';

import { canonicalMaterialBytes, sha256Hex } from './canonical.js';
import { MaterialLabSession, compareMaterialGolden } from './lab.js';
import { packMaterialPackage, verifyMaterialPackage } from './package.js';
import {
  assertMaterialDefinitionSchema,
  assertMaterialGraphSchema,
  assertMaterialManifestSchema,
} from './schema-validation.js';
import type {
  AuthoredMaterial,
  MaterialDefinition,
  MaterialPackageFile,
  MaterialPackageManifest,
  PackedMaterialPackage,
} from './types.js';
import { createDeterministicMaterialArchive } from './zip.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export interface MaterialAuthorInspection {
  readonly directory: string;
  readonly packageId: string;
  readonly version: string;
  readonly integrity: string;
  readonly files: number;
  readonly materials: readonly {
    readonly id: string;
    readonly kind: string;
    readonly parameters: number;
    readonly webgl2: boolean;
    readonly webgpu: boolean;
    readonly budget: ReturnType<MaterialLabSession['analyze']>['budget'];
  }[];
}

interface LoadedAuthorPackage {
  readonly directory: string;
  readonly manifest: MaterialPackageManifest;
  readonly packed: PackedMaterialPackage;
  readonly authored: readonly AuthoredMaterial[];
  readonly extraFiles: readonly MaterialPackageFile[];
}

function safePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute).replaceAll('\\', '/');
  if (
    fromRoot.length === 0 ||
    fromRoot === '..' ||
    fromRoot.startsWith('../') ||
    fromRoot.startsWith('/') ||
    path.includes('\\')
  ) {
    throw new TypeError(`Unsafe Material path ${path}`);
  }
  return absolute;
}

function json(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    throw new TypeError(`Invalid JSON in ${path}`, { cause: error });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadAuthorPackage(directory: string): Promise<LoadedAuthorPackage> {
  const root = resolve(directory);
  const manifestPath = resolve(root, 'manifest.json');
  const manifestSource = new Uint8Array(await readFile(manifestPath));
  const manifestValue = json(manifestSource, manifestPath);
  assertMaterialManifestSchema(manifestValue);
  const manifest = manifestValue as MaterialPackageManifest;
  const manifestBytes = canonicalMaterialBytes(manifest as unknown as JsonValue);
  const files = new Map<string, Uint8Array>([['manifest.json', manifestBytes]]);
  for (const entry of manifest.files) {
    const bytes = new Uint8Array(await readFile(safePath(root, entry.path)));
    files.set(entry.path, bytes);
  }
  const archiveBytes = createDeterministicMaterialArchive(files);
  const integrity = `sha256:${await sha256Hex(manifestBytes)}` as const;
  const packed: PackedMaterialPackage = {
    manifest,
    manifestBytes,
    files,
    archiveBytes,
    integrity,
  };
  await verifyMaterialPackage(packed, integrity);

  const definitionPaths = new Set(manifest.materials.map((material) => material.definition));
  const graphPaths = new Set<string>();
  const authored = manifest.materials.map((material) => {
    const definitionBytes = files.get(material.definition);
    if (definitionBytes === undefined) {
      throw new TypeError(`Definition ${material.definition} is missing`);
    }
    const definitionValue = json(definitionBytes, material.definition);
    assertMaterialDefinitionSchema(definitionValue);
    const definition = definitionValue as MaterialDefinition;
    if (definition.id !== material.id || definition.kind !== material.kind) {
      throw new TypeError(`Definition identity differs for ${material.id}`);
    }
    const graphImplementation = definition.implementations.find((value) => value.type === 'graph');
    if (graphImplementation === undefined) return { definition };
    graphPaths.add(graphImplementation.graph);
    const graphBytes = files.get(graphImplementation.graph);
    if (graphBytes === undefined) {
      throw new TypeError(`Graph ${graphImplementation.graph} is missing`);
    }
    const graphValue = json(graphBytes, graphImplementation.graph);
    assertMaterialGraphSchema(graphValue);
    return {
      definition,
      graph: graphValue as MaterialGraph,
      definitionPath: material.definition,
      graphPath: graphImplementation.graph,
    };
  });
  const extraFiles = manifest.files.flatMap((entry) => {
    if (definitionPaths.has(entry.path) || graphPaths.has(entry.path)) return [];
    const data = files.get(entry.path);
    if (data === undefined) throw new TypeError(`Package file ${entry.path} is missing`);
    return [{ path: entry.path, mediaType: entry.mediaType, data }];
  });

  // Re-run the same authoring validation/compilation path used by package
  // creation. The stored manifest verification above remains authoritative for
  // exact payload bytes and transport integrity.
  await packMaterialPackage({
    metadata: manifest.package,
    materials: authored,
    files: extraFiles,
  });
  return { directory: root, manifest, packed, authored, extraFiles };
}

function inspection(loaded: LoadedAuthorPackage): MaterialAuthorInspection {
  return {
    directory: loaded.directory,
    packageId: loaded.manifest.package.id,
    version: loaded.manifest.package.version,
    integrity: loaded.packed.integrity,
    files: loaded.manifest.files.length + 1,
    materials: loaded.authored.map((material) => {
      const report = new MaterialLabSession(material).analyze();
      return {
        id: material.definition.id,
        kind: material.definition.kind,
        parameters: material.definition.parameters.length,
        webgl2: report.webgl2.available,
        webgpu: report.webgpu.available,
        budget: report.budget,
      };
    }),
  };
}

export async function validateMaterialAuthorPackage(directory: string): Promise<MaterialAuthorInspection> {
  return inspection(await loadAuthorPackage(directory));
}

export async function synchronizeMaterialAuthorManifest(directory: string): Promise<string> {
  const root = resolve(directory);
  const manifestPath = resolve(root, 'manifest.json');
  const manifestValue = json(new Uint8Array(await readFile(manifestPath)), manifestPath);
  assertMaterialManifestSchema(manifestValue);
  const manifest = manifestValue as MaterialPackageManifest;
  const files = await Promise.all(
    manifest.files.map(async (entry) => {
      const bytes = new Uint8Array(await readFile(safePath(root, entry.path)));
      return {
        ...entry,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      };
    }),
  );
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function parameterType(type: MaterialDefinition['parameters'][number]['type']): string {
  if (type === 'boolean') return 'boolean';
  if (type === 'enum' || type === 'string') return 'string';
  if (['integer', 'float', 'angle', 'duration'].includes(type)) return 'number';
  if (type === 'vec2') return 'readonly [number, number]';
  if (type === 'vec3') return 'readonly [number, number, number]';
  if (type === 'vec4' || type === 'color') return 'readonly [number, number, number, number]';
  return 'JsonValue';
}

export async function generateMaterialTypes(
  directory: string,
  outputPath = resolve(directory, 'material.generated.d.ts'),
): Promise<string> {
  const loaded = await loadAuthorPackage(directory);
  const needsJsonValue = loaded.authored.some((material) =>
    material.definition.parameters.some((parameter) => ['gradient', 'curve'].includes(parameter.type)),
  );
  const sections = loaded.authored.map((material) => {
    const name = `${material.definition.id
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
      .join('')}Parameters`;
    const members = material.definition.parameters.map(
      (parameter) => `  readonly ${JSON.stringify(parameter.id)}: ${parameterType(parameter.type)};`,
    );
    return `export interface ${name} {\n${members.join('\n')}\n}`;
  });
  const source = `${needsJsonValue ? "import type { JsonValue } from '@aelionsdk/core';\n\n" : ''}${sections.join('\n\n')}\n`;
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), source, 'utf8');
  return resolve(outputPath);
}

export async function writeMaterialPreviewReport(
  directory: string,
  outputPath = resolve(directory, 'material-preview.json'),
): Promise<string> {
  const loaded = await loadAuthorPackage(directory);
  const report = {
    reportVersion: '1.0.0',
    package: {
      id: loaded.manifest.package.id,
      version: loaded.manifest.package.version,
      integrity: loaded.packed.integrity,
    },
    materials: loaded.authored.map((material) => ({
      id: material.definition.id,
      display: material.definition.display,
      execution: material.definition.execution,
      analysis: new MaterialLabSession(material).analyze(),
    })),
  };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolve(outputPath);
}

export async function packMaterialAuthorPackage(
  directory: string,
  outputPath: string,
): Promise<{ readonly path: string; readonly integrity: string; readonly bytes: number }> {
  await synchronizeMaterialAuthorManifest(directory);
  const loaded = await loadAuthorPackage(directory);
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), loaded.packed.archiveBytes);
  return {
    path: resolve(outputPath),
    integrity: loaded.packed.integrity,
    bytes: loaded.packed.archiveBytes.byteLength,
  };
}

export async function buildMaterialAuthorPackage(directory: string): Promise<{
  readonly inspection: MaterialAuthorInspection;
  readonly typesPath: string;
  readonly previewPath: string;
}> {
  await synchronizeMaterialAuthorManifest(directory);
  const inspection = await validateMaterialAuthorPackage(directory);
  const [typesPath, previewPath] = await Promise.all([
    generateMaterialTypes(directory),
    writeMaterialPreviewReport(directory),
  ]);
  return { inspection, typesPath, previewPath };
}

export async function compareMaterialGoldenFiles(
  actualPath: string,
  expectedPath: string,
  tolerance = 2,
): Promise<ReturnType<typeof compareMaterialGolden>> {
  const [actual, expected] = await Promise.all([readFile(actualPath), readFile(expectedPath)]);
  return compareMaterialGolden(actual, expected, tolerance);
}

export async function prepublishMaterialAuthorPackage(directory: string): Promise<MaterialAuthorInspection> {
  const loaded = await loadAuthorPackage(directory);
  for (const material of loaded.authored) {
    const report = new MaterialLabSession(material).analyze();
    if (report.diagnostics.some((value) => value.severity === 'error')) {
      throw new TypeError(`Material ${material.definition.id} has error diagnostics`);
    }
    if (material.graph !== undefined && (!report.webgl2.available || !report.webgpu.available)) {
      throw new TypeError(`Material ${material.definition.id} lacks WebGL2/WebGPU compiler parity`);
    }
    if (material.definition.execution.determinism === 'non-deterministic') {
      throw new TypeError(`Material ${material.definition.id} is non-deterministic`);
    }
  }
  return inspection(loaded);
}

export async function initializeMaterialAuthorPackage(directory: string): Promise<string> {
  const root = resolve(directory);
  if ((await exists(root)) && (await readdir(root)).length > 0) {
    throw new TypeError(`Material directory is not empty: ${root}`);
  }
  const definition: MaterialDefinition = {
    $schema: 'https://schemas.aelion.dev/material/definition/v1.json',
    protocolVersion: '1.0.0',
    id: 'starter-filter',
    kind: 'visual-filter',
    display: { name: 'Starter Filter', category: 'starter' },
    scopes: ['source', 'item', 'track', 'sequence'],
    ports: [
      {
        id: 'source',
        direction: 'input',
        type: 'visual-frame',
        role: 'source',
        binding: 'host',
        required: true,
      },
      {
        id: 'result',
        direction: 'output',
        type: 'visual-frame',
        role: 'result',
        binding: 'host',
        required: true,
      },
    ],
    parameters: [
      {
        id: 'intensity',
        type: 'float',
        default: 1,
        range: { min: 0, max: 1, step: 0.01 },
        unit: 'ratio',
        animatable: true,
        interpolation: 'linear',
        affects: 'uniform',
        ui: { control: 'slider', group: 'main', order: 0, label: 'Intensity' },
      },
    ],
    bundledResources: [],
    resourceSlots: [],
    execution: {
      color: { input: 'working-linear', output: 'working-linear' },
      alpha: {
        input: 'premultiplied',
        output: 'premultiplied',
        preservesTransparency: true,
      },
      resolution: { policy: 'same-as-host' },
      spatialPadding: { mode: 'none' },
      temporal: { pastUs: 0, futureUs: 0, stateful: false, seekPolicy: 'stateless' },
      determinism: 'strict',
      supports: { realtime: true, offline: true, alpha: true, hdr: false, tiled: true },
    },
    implementations: [
      {
        type: 'graph',
        graph: 'graphs/starter-filter.graph.json',
        nodeSet: 'aelion.visual.nodes/1.0.0',
      },
    ],
    splitPolicy: 'copy',
  };
  const graph: MaterialGraph = {
    $schema: 'https://schemas.aelion.dev/material/graph/v1.json',
    graphVersion: '1.0.0',
    nodeSet: 'aelion.visual.nodes/1.0.0',
    nodes: [
      {
        id: 'mix',
        type: 'composite.mix',
        typeVersion: '1.0.0',
        inputs: {
          a: { inputPort: 'source' },
          b: { inputPort: 'source' },
          amount: { parameter: 'intensity' },
        },
      },
    ],
    outputs: { result: { node: 'mix', output: 'frame' } },
  };
  const definitionPath = 'materials/starter-filter.material.json';
  const graphPath = 'graphs/starter-filter.graph.json';
  const definitionSource = `${JSON.stringify(definition, null, 2)}\n`;
  const graphSource = `${JSON.stringify(graph, null, 2)}\n`;
  const manifest: MaterialPackageManifest = {
    $schema: 'https://schemas.aelion.dev/material/package/v1.json',
    protocolVersion: '1.0.0',
    package: {
      id: 'dev.example.starter',
      version: '0.1.0',
      displayName: 'Starter Material',
      publisher: { id: 'dev.example', name: 'Example Publisher' },
      license: 'MIT',
      engines: { aelion: '>=1.0.0-rc.1 <2.0.0', nodeSet: 'aelion.visual.nodes/1.0.0' },
      trust: 'declarative',
    },
    materials: [{ id: definition.id, kind: definition.kind, definition: definitionPath }],
    files: [
      {
        path: graphPath,
        mediaType: 'application/vnd.aelion.material-graph+json',
        bytes: encoder.encode(graphSource).byteLength,
        sha256: await sha256Hex(encoder.encode(graphSource)),
      },
      {
        path: definitionPath,
        mediaType: 'application/vnd.aelion.material+json',
        bytes: encoder.encode(definitionSource).byteLength,
        sha256: await sha256Hex(encoder.encode(definitionSource)),
      },
    ],
  };
  await mkdir(resolve(root, 'materials'), { recursive: true });
  await mkdir(resolve(root, 'graphs'), { recursive: true });
  await writeFile(resolve(root, definitionPath), definitionSource, 'utf8');
  await writeFile(resolve(root, graphPath), graphSource, 'utf8');
  await writeFile(resolve(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await validateMaterialAuthorPackage(root);
  await generateMaterialTypes(root);
  return root;
}
