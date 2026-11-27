import {
  copyMaterialBytes,
  inspectPackedMaterialPackage,
  type MaterialPackageTransportInspection,
} from './package-limits.js';
import { assertMaterialPackageManifestShape } from './package-shape.js';
import type { MaterialPackageByteLimitOptions, PackedMaterialPackage } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Creates an ownership-isolated package value for trust decisions and registry storage. */
export function snapshotMaterialPackage(
  packed: PackedMaterialPackage,
  options: MaterialPackageByteLimitOptions = {},
  inspection: MaterialPackageTransportInspection = inspectPackedMaterialPackage(packed, options),
): PackedMaterialPackage {
  // Budget inspection is deliberately complete before parsing or the
  // first transport byte copy. This prevents an untrusted package from using
  // defensive ownership snapshots as a memory amplification primitive.
  // `manifestBytes` is the signed transport authority. Never enumerate the
  // caller's convenience `manifest` object: a Proxy ownKeys trap can allocate
  // unbounded key lists before any object-key budget is observable.
  const manifestBytes = copyMaterialBytes(inspection.manifestBytes, inspection.manifestByteLength, 'manifestBytes');
  let manifest: unknown;
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes)) as unknown;
  } catch {
    throw new TypeError('MATERIAL_PACKAGE_INVALID: manifestBytes is not valid UTF-8 JSON');
  }
  assertMaterialPackageManifestShape(manifest);
  return {
    manifest,
    manifestBytes,
    files: new Map(
      inspection.files.map(({ path, data, byteLength }) => [path, copyMaterialBytes(data, byteLength, `file ${path}`)]),
    ),
    archiveBytes: copyMaterialBytes(inspection.archiveBytes, inspection.archiveByteLength, 'archiveBytes'),
    integrity: inspection.integrity,
  };
}
