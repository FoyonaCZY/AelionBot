import type { JsonValue } from '@aelionsdk/core';

import { snapshotProjectInput } from './admission.js';
import type { AelionProject } from './types.js';

/** Immutable schema URI emitted by AelionSDK before the 1.2 remediation. */
export const LEGACY_PROJECT_SCHEMA_URI = 'https://schemas.aelion.dev/project/v1.json';
/** Version paired with the immutable legacy Project schema URI. */
export const LEGACY_PROJECT_SCHEMA_VERSION = '1.0.0';
/** Immutable schema URI emitted by the stable AelionSDK 1.2 release. */
export const PROJECT_SCHEMA_V1_2_URI = 'https://schemas.aelion.dev/project/v1.2.json';
/** Version paired with the immutable stable 1.2 Project schema URI. */
export const PROJECT_SCHEMA_V1_2_VERSION = '1.2.0';
/** Canonical schema URI for Projects containing the 2.0 timeline model. */
export const CURRENT_PROJECT_SCHEMA_URI = 'https://schemas.aelion.dev/project/v2.0.json';
/** Version paired with the canonical Project v2.0 schema URI. */
export const CURRENT_PROJECT_SCHEMA_VERSION = '2.0.0';

/** Result of isolating and, when necessary, migrating a Project identity. */
export interface ProjectIdentityMigration {
  readonly project: AelionProject;
  readonly migrated: boolean;
  readonly fromSchema?: string;
  readonly fromVersion?: string;
  readonly toSchema: typeof CURRENT_PROJECT_SCHEMA_URI;
  readonly toVersion: typeof CURRENT_PROJECT_SCHEMA_VERSION;
}

function object(value: JsonValue): Record<string, JsonValue | undefined> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** @internal The value must already be an ownership-isolated admission snapshot. */
export function migrateAdmittedProjectToCurrent(value: JsonValue): ProjectIdentityMigration {
  const project = object(value);
  if (project === undefined) {
    return {
      project: value as unknown as AelionProject,
      migrated: false,
      toSchema: CURRENT_PROJECT_SCHEMA_URI,
      toVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    };
  }
  const fromSchema = typeof project.$schema === 'string' ? project.$schema : undefined;
  const fromVersion = typeof project.schemaVersion === 'string' ? project.schemaVersion : undefined;
  const legacy = fromSchema === LEGACY_PROJECT_SCHEMA_URI && fromVersion === LEGACY_PROJECT_SCHEMA_VERSION;
  const stableV1_2 = fromSchema === PROJECT_SCHEMA_V1_2_URI && fromVersion === PROJECT_SCHEMA_V1_2_VERSION;
  if (legacy || stableV1_2) {
    project.$schema = CURRENT_PROJECT_SCHEMA_URI;
    project.schemaVersion = CURRENT_PROJECT_SCHEMA_VERSION;
  }
  return {
    project: project as unknown as AelionProject,
    migrated: legacy || stableV1_2,
    ...(fromSchema === undefined ? {} : { fromSchema }),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    toSchema: CURRENT_PROJECT_SCHEMA_URI,
    toVersion: CURRENT_PROJECT_SCHEMA_VERSION,
  };
}

/**
 * Capture an ownership-isolated Project snapshot and upgrade either supported
 * 1.x identity to the immutable v2.0 identity. Content is preserved at the
 * JSON-value level; v2 fields are optional so legacy documents retain their
 * established overlay/free behavior until a product assigns roles explicitly.
 */
export function migrateProjectToCurrent(value: unknown): ProjectIdentityMigration {
  const snapshot = snapshotProjectInput(value);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Project migration requires a JSON object');
  }
  return migrateAdmittedProjectToCurrent(snapshot);
}
