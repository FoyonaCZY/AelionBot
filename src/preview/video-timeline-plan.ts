import type { AelionProject, LinkGroupEntity } from '@aelionsdk/project-schema';
import { planTimelineMove } from '@aelionsdk/transaction';
import type { VideoProjectDetail } from '../../shared/types/video-studio-types';

/** Where a clip goes. */
export interface ClipMove {
  readonly clipId: string;
  readonly trackId: string;
  readonly startUs: number;
}

export interface ClipMovePlan {
  /** Every clip the drop moves: the dragged one when it moves, the neighbours it pushes, and their sound. */
  readonly moves: readonly ClipMove[];
  /** Where the dragged clip lands. On the main track that is the slot it opened, not where the pointer let go. */
  readonly startUs: number;
}

/**
 * The project as the move planner sees it.
 *
 * A video's picture and its sound are two clips of one asset at the same place on two tracks, and the document does
 * not link them. Linked here, a drag carries the sound with its picture, both for the dragged clip and for every
 * neighbour the main track pushes aside, so a reorder never leaves a cut talking over the wrong shot.
 */
export function planningProject(detail: VideoProjectDetail): AelionProject {
  const project = detail.projectJson as unknown as AelionProject;
  const sounds = detail.tracks.filter((track) => track.kind === 'audio').flatMap((track) => track.clips);
  const items = { ...project.items },
    linkGroups = { ...project.linkGroups },
    taken = new Set<string>();
  for (const track of detail.tracks) {
    if (track.kind !== 'visual') continue;
    for (const picture of track.clips) {
      if (picture.kind !== 'video' || !picture.assetId || items[picture.id]?.linkGroupId) continue;
      const sound = sounds.find(
        (clip) =>
          !taken.has(clip.id) &&
          !items[clip.id]?.linkGroupId &&
          clip.assetId === picture.assetId &&
          clip.startUs === picture.startUs &&
          clip.durationUs === picture.durationUs &&
          (clip.sourceStartUs ?? 0) === (picture.sourceStartUs ?? 0) &&
          (clip.rate ?? 1) === (picture.rate ?? 1),
      );
      const pictureItem = items[picture.id],
        soundItem = sound && items[sound.id];
      if (!sound || !pictureItem || !soundItem) continue;
      taken.add(sound.id);
      const id = `planning-link:${picture.id}`;
      linkGroups[id] = { id, kind: 'av-sync', itemIds: [picture.id, sound.id] } satisfies LinkGroupEntity;
      items[picture.id] = { ...pictureItem, linkGroupId: id };
      items[sound.id] = { ...soundItem, linkGroupId: id };
    }
  }
  return { ...project, items, linkGroups };
}

/**
 * Resolves a clip dragged to `startUs` on its track into the layout a drop would leave, with the SDK's planner — the
 * same one the player's preview of the drag uses. On the main track the clip takes the slot whose middle it has
 * passed and the others close up around it; elsewhere it stays where it is put, and pushing past the middle of a
 * neighbour swaps the two. Undefined when the drop is refused, such as sound that would be pushed before zero.
 */
export function planClipMove(
  project: AelionProject,
  clipId: string,
  trackId: string,
  startUs: number,
): ClipMovePlan | undefined {
  const plan = planTimelineMove(project, { movedItemId: clipId, targetTrackId: trackId, targetStartUs: startUs });
  if (!plan) return undefined;
  return {
    moves: [...plan.placements].map(([id, at]) => ({ clipId: id, trackId: at.trackId, startUs: at.startUs })),
    startUs: plan.ghost.startUs,
  };
}
