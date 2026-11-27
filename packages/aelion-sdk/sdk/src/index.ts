import { AelionSession } from './session.js';
import type { AelionApi } from './types.js';

export {
  CURRENT_PROJECT_SCHEMA_URI,
  CURRENT_PROJECT_SCHEMA_VERSION,
  LEGACY_PROJECT_SCHEMA_URI,
  LEGACY_PROJECT_SCHEMA_VERSION,
  PROJECT_SCHEMA_V1_2_URI,
  PROJECT_SCHEMA_V1_2_VERSION,
  migrateProjectToCurrent,
  type ProjectIdentityMigration,
} from '@aelionsdk/project-schema';

/**
 * The editing model, re-exported so one import covers building an editor.
 *
 * These live in `@aelionsdk/transaction` because that is where the Project is
 * written, but a host reaches for them alongside the Session rather than
 * separately: resolve a drag with `planTimelineMove`, show it with
 * `preview.renderFrame({ overlay })`, commit it with `applyPlacements`.
 */
export {
  firstFreeStartOnTrack,
  isRangeFreeOnTrack,
  itemsOnTrack,
  overlappingItemOnTrack,
  packTrack,
  placementsChange,
  planTimelineMove,
  rangeOverlapUs,
  sequenceTracks,
  speculateProject,
  speculateProjectChange,
  storylineTrackId,
  violatesOccupancy,
  writeTimelinePlacements,
  type ApplyPlacementsOptions,
  type ItemExcept,
  type PlanTimelineMoveOptions,
  type SpeculativeProjectChange,
  type TimelineMovePlan,
  type TimelinePlacement,
  type WriteTimelinePlacementsOptions,
} from '@aelionsdk/transaction';

export * from './runtime-material-registry.js';
export * from './media-provider.js';
export * from './production-media-provider.js';
export * from './item-factories.js';
export * from './project-builder.js';
export * from './proxy-automation.js';
export * from './rate-envelope.js';
export * from './subtitle-io.js';
export * from './composition.js';
export * from './diagnostic-report.js';
export * from './migration.js';
export * from './migration-materials.js';
export * from './audio-controller.js';
export * from './audio-mastering.js';
export * from './persistence.js';
export * from './extension-host.js';
export * from './preview-controller.js';
export * from './default-schemas.js';
export * from './session.js';
export * from './types.js';

export const Aelion: AelionApi = {
  createSession: (options) => Promise.resolve(new AelionSession(options)),
};
