import type { Diagnostic, JsonValue } from '@aelionsdk/core';
import type { MaterialGraph } from '@aelionsdk/material-compiler';

export const MATERIAL_PROTOCOL_VERSION = '1.0.0' as const;
export const MATERIAL_PACKAGE_SCHEMA = 'https://schemas.aelion.dev/material/package/v1.json' as const;
export const MATERIAL_DEFINITION_SCHEMA = 'https://schemas.aelion.dev/material/definition/v1.json' as const;
export const MATERIAL_GRAPH_SCHEMA = 'https://schemas.aelion.dev/material/graph/v1.json' as const;
export const MATERIAL_NODE_SET = 'aelion.visual.nodes/1.0.0' as const;

export type MaterialKind = 'visual-filter' | 'visual-effect' | 'visual-transition' | 'visual-generator';
export type MaterialScope = 'source' | 'item' | 'track' | 'sequence' | 'transition';
export type MaterialPortType = 'visual-frame' | 'mask' | 'depth' | 'motion-vectors';
export type MaterialParameterType =
  | 'boolean'
  | 'integer'
  | 'float'
  | 'enum'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color'
  | 'angle'
  | 'duration'
  | 'gradient'
  | 'curve'
  | 'string';
export type MaterialResourceKind =
  'texture2d' | 'texture3d' | 'lut1d' | 'lut3d' | 'cube-texture' | 'mask' | 'binary-table';

export interface MaterialDisplay {
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly icon?: string;
  readonly thumbnail?: string;
  readonly preview?: string;
  readonly localizationPrefix?: string;
}

export interface MaterialPort {
  readonly id: string;
  readonly direction: 'input' | 'output';
  readonly type: MaterialPortType;
  readonly role: 'source' | 'from' | 'to' | 'auxiliary' | 'result';
  readonly binding: 'host' | 'instance';
  readonly required: boolean;
  readonly description?: string;
}

export interface MaterialParameter {
  readonly id: string;
  readonly type: MaterialParameterType;
  readonly default: JsonValue;
  readonly range?: {
    readonly min?: number;
    readonly max?: number;
    readonly softMin?: number;
    readonly softMax?: number;
    readonly step?: number;
  };
  readonly values?: readonly string[];
  readonly unit?: 'none' | 'ratio' | 'percent' | 'px' | 'degree' | 'us' | 'db' | 'hz';
  readonly animatable: boolean;
  readonly interpolation?: 'hold' | 'linear' | 'cubic-bezier' | 'shortest-angle' | 'linear-color';
  readonly affects: 'uniform' | 'specialization' | 'graph';
  readonly ui: {
    readonly control:
      'toggle' | 'slider' | 'number' | 'select' | 'segmented' | 'color' | 'point' | 'curve' | 'gradient' | 'text';
    readonly group: string;
    readonly order: number;
    readonly label: string;
  };
}

export interface BundledMaterialResource {
  readonly id: string;
  readonly kind: MaterialResourceKind;
  readonly path: string;
  readonly [key: string]: JsonValue;
}

export interface MaterialResourceSlot {
  readonly id: string;
  readonly kind: MaterialResourceKind;
  readonly required: boolean;
  readonly fallbackResourceId?: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface MaterialExecutionContract {
  readonly color: { readonly input: 'working-linear'; readonly output: 'working-linear' };
  readonly alpha: {
    readonly input: 'premultiplied';
    readonly output: 'premultiplied';
    readonly preservesTransparency: boolean;
  };
  readonly resolution: {
    readonly policy: 'same-as-host' | 'scale';
    readonly scale?: number;
    readonly minimum?: { readonly width: number; readonly height: number };
  };
  readonly spatialPadding:
    | { readonly mode: 'none' }
    | { readonly mode: 'fixed'; readonly pixels: number }
    | {
        readonly mode: 'parameter-bound';
        readonly parameter: string;
        readonly maximumPixels: number;
      };
  readonly temporal: {
    readonly pastUs: number;
    readonly futureUs: number;
    readonly stateful: boolean;
    readonly seekPolicy: 'stateless' | 'reconstruct' | 'reset-with-warning';
  };
  readonly determinism: 'strict' | 'backend-tolerant' | 'non-deterministic';
  readonly supports: {
    readonly realtime: boolean;
    readonly offline: boolean;
    readonly alpha: boolean;
    readonly hdr: boolean;
    readonly tiled: boolean;
  };
}

export type MaterialImplementation =
  | { readonly type: 'graph'; readonly graph: string; readonly nodeSet: string }
  | (
      | {
          readonly type: 'shader';
          readonly backend: 'webgpu';
          readonly abi: 'aelion-material-shader/1';
          readonly module: string;
          readonly entryPoint: string;
          readonly [key: string]: JsonValue;
        }
      | {
          readonly type: 'shader';
          readonly backend: 'webgl2';
          readonly abi: 'aelion-material-webgl/1';
          readonly vertexModule?: string;
          readonly fragmentModule: string;
          readonly entryPoint: string;
          readonly [key: string]: JsonValue | undefined;
        }
    )
  | {
      readonly type: 'wasm';
      readonly module: string;
      readonly abi: 'aelion-material-wasm/1';
      readonly [key: string]: JsonValue;
    };

export interface MaterialDefinition {
  readonly $schema: typeof MATERIAL_DEFINITION_SCHEMA;
  readonly protocolVersion: typeof MATERIAL_PROTOCOL_VERSION;
  readonly id: string;
  readonly kind: MaterialKind;
  readonly display: MaterialDisplay;
  readonly scopes: readonly MaterialScope[];
  readonly ports: readonly MaterialPort[];
  readonly parameters: readonly MaterialParameter[];
  readonly bundledResources: readonly BundledMaterialResource[];
  readonly resourceSlots: readonly MaterialResourceSlot[];
  readonly execution: MaterialExecutionContract;
  readonly implementations: readonly MaterialImplementation[];
  readonly splitPolicy: 'copy' | 'reset' | 'reject';
}

export interface MaterialPackageMetadata {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly license: string;
  readonly engines: { readonly aelion: string; readonly nodeSet: string };
  readonly trust: 'declarative' | 'trusted-code';
}

export interface MaterialPackageManifest {
  readonly $schema: typeof MATERIAL_PACKAGE_SCHEMA;
  readonly protocolVersion: typeof MATERIAL_PROTOCOL_VERSION;
  readonly package: MaterialPackageMetadata;
  readonly materials: readonly {
    readonly id: string;
    readonly kind: MaterialKind;
    readonly definition: string;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

export interface AuthoredMaterial {
  readonly definition: MaterialDefinition;
  readonly graph?: MaterialGraph;
  readonly definitionPath?: string;
  readonly graphPath?: string;
}

export interface MaterialPackageFile {
  readonly path: string;
  readonly mediaType: string;
  readonly data: Uint8Array | string;
}

/** Hard transport bounds applied before package bytes are copied or ZIP bytes are rebuilt. */
export interface MaterialPackageByteLimits {
  /** Includes `manifest.json`. ZIP transport cannot represent more than 65,535 entries. */
  readonly maxFiles: number;
  /** Maximum bytes for any one non-manifest payload. */
  readonly maxFileBytes: number;
  /** Maximum canonical `manifest.json` bytes. */
  readonly maxManifestBytes: number;
  /** Maximum sum of `manifest.json` and all payload bytes. */
  readonly maxPackageBytes: number;
  /** Maximum deterministic `.aelionmat` ZIP bytes. */
  readonly maxArchiveBytes: number;
}

export type MaterialPackageByteLimitOptions = Partial<MaterialPackageByteLimits>;

export interface PackMaterialPackageOptions {
  readonly metadata: MaterialPackageMetadata;
  readonly materials: readonly AuthoredMaterial[];
  readonly files?: readonly MaterialPackageFile[];
  /** Defaults to the fail-closed browser transport limits exported by this package. */
  readonly limits?: MaterialPackageByteLimitOptions;
}

export interface PackedMaterialPackage {
  /** Derived convenience view; verification authority is the signed `manifestBytes`. */
  readonly manifest: MaterialPackageManifest;
  readonly manifestBytes: Uint8Array;
  /** Includes manifest.json and every manifest-declared payload file. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Deterministic, store-only ZIP bytes suitable for a `.aelionmat` file. */
  readonly archiveBytes: Uint8Array;
  readonly integrity: `sha256:${string}`;
}

export interface MaterialValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface MaterialPackageReference {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly packageIntegrity: string;
  readonly materialId: string;
}

export interface ResolvedMaterial {
  readonly reference: MaterialPackageReference;
  readonly manifest: MaterialPackageManifest;
  readonly definition: MaterialDefinition;
  readonly graph?: MaterialGraph;
}

export interface MaterialPackageResolver {
  resolve(
    reference: Pick<MaterialPackageReference, 'packageId' | 'packageVersion' | 'packageIntegrity'>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PackedMaterialPackage>;
}
