// Which release notes someone still has to see after updating. The version whose notes were last seen is kept in the
// installation's profile, next to the update launch context, so a new version shows everything since then once.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from '../storage/store';
import { compareVersions } from '../../../shared/version';

export interface WhatsNew {
  /** The last version whose notes were seen; absent when it is unknown, and only this version's notes show. */
  from?: string;
  version: string;
}
const file = (profileDir: string) => join(profileDir, 'release-notes-seen.json');

function seenVersion(profileDir: string) {
  try {
    if (!existsSync(file(profileDir))) return;
    const value = JSON.parse(readFileSync(file(profileDir), 'utf8'))?.version;
    return typeof value === 'string' && compareVersions(value, value) === 0 ? value : undefined;
  } catch {
    return;
  }
}
export function markReleaseNotesSeen(profileDir: string, version: string) {
  mkdirSync(profileDir, { recursive: true });
  atomicJson(file(profileDir), { version });
}
/**
 * The notes to show on this launch, if any. Without a record, an installation that the in-app updater just moved to this
 * version sees this version's notes; a new installation sees nothing and starts its record here.
 */
export function pendingWhatsNew(profileDir: string, version: string, updatedTo?: string): WhatsNew | undefined {
  const seen = seenVersion(profileDir);
  if (!seen) {
    if (updatedTo === version) return { version };
    markReleaseNotesSeen(profileDir, version);
    return;
  }
  return compareVersions(seen, version) < 0 ? { from: seen, version } : undefined;
}
