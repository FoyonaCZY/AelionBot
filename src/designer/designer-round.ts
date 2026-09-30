import type { Attachment } from '../../shared/types/attachment-types';
import type { DesignFileChange } from '../../shared/designer/design-changes';

export interface DesignRoundFile {
  attachment: Attachment;
  change?: DesignFileChange;
}

const base = (path: string) => path.split(/[\\/]/).pop() || path;

/**
 * One row per delivered file. A run may attach the same file several times (each publish re-attaches the
 * deliverables); the last copy is the current one. Change stats match by file name when that name is unique.
 */
export function designRoundFiles(attachments: Attachment[] = [], changes: Record<string, DesignFileChange> = {}) {
  const latest = new Map<string, Attachment>();
  for (const file of attachments) {
    latest.delete(file.name);
    latest.set(file.name, file);
  }
  const byName = new Map<string, DesignFileChange | null>();
  for (const [path, change] of Object.entries(changes)) {
    const name = base(path);
    byName.set(name, byName.has(name) ? null : change);
  }
  return [...latest.values()].map((attachment): DesignRoundFile => {
    const change = byName.get(attachment.name);
    return change ? { attachment, change } : { attachment };
  });
}

/** Chat column bounds in the split layout; the canvas keeps at least 360px. */
export const clampDesignerChatWidth = (width: number, available = Infinity) =>
  Math.round(Math.max(360, Math.min(640, available - 360, width)));

type DeliveryState = 'running' | 'blocked' | 'pending' | 'accepted' | 'empty';
/** Which of the four states the delivery bar shows. P0 findings block confirming. */
export function deliveryState(input: {
  accepted: boolean;
  running: boolean;
  blocking: number;
  canAccept: boolean;
}): DeliveryState {
  if (input.accepted) return 'accepted';
  if (input.running) return 'running';
  if (input.blocking > 0) return 'blocked';
  return input.canAccept ? 'pending' : 'empty';
}
