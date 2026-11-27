import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VideoProjects } from '../electron/core/video/video-projects';
import type { VideoEditOperation, VideoProjectDetail } from '../shared/types/video-studio-types';
import { planClipMove, planningProject } from '../src/preview/video-timeline-plan';
import { tempDir } from './helpers';

/** Three shots on the main track, each with its sound at the same place on the voice track, and music under them. */
async function threeShots(root: string) {
  const projects = new VideoProjects({ workspaceRoot: () => root });
  const project = projects.create({ title: 'Three shots' });
  const operations: VideoEditOperation[] = [];
  let atUs = 0;
  for (const [index, seconds] of [4, 3, 5].entries()) {
    const file = join(root, `shot${index}.mp4`);
    writeFileSync(file, Buffer.from(`shot${index}`));
    const { asset } = await projects.importAsset({ projectId: project.id, source: { kind: 'host', path: file } });
    projects.updateAssetProbe(project.id, asset.id, {
      durationUs: seconds * 1_000_000,
      hasAudio: true,
      hasVideo: true,
      width: 1920,
      height: 1080,
      fps: 30,
    } as never);
    operations.push(
      { op: 'add_clip', trackId: 'video-main', assetId: asset.id, startUs: atUs },
      { op: 'add_clip', trackId: 'audio-voice', assetId: asset.id, kind: 'audio', startUs: atUs },
    );
    atUs += seconds * 1_000_000;
  }
  projects.edit({ projectId: project.id, operations });
  return { projects, project: projects.get(project.id) };
}

/** A track's clips in time order, as [asset, start in seconds]. */
function layout(project: VideoProjectDetail, trackId: string) {
  return project.tracks
    .find((track) => track.id === trackId)!
    .clips.toSorted((a, b) => a.startUs - b.startUs)
    .map((clip) => [clip.assetId, clip.startUs / 1_000_000]);
}

test('a shot dragged to the front of the main track pushes the others back, and every sound moves with its picture', async (t) => {
  const { projects, project } = await threeShots(tempDir(t, 'aelion-timeline-plan-'));
  const [first, second, third] = project.tracks.find((track) => track.id === 'video-main')!.clips;

  // Its start over the first half of the first shot: it takes the front, and the others close up behind it.
  const plan = planClipMove(planningProject(project), third!.id, 'video-main', 1_000_000);
  assert.ok(plan);
  assert.equal(plan.startUs, 0);

  const moved = projects.edit({
    projectId: project.id,
    operations: plan.moves.map((move) => ({ op: 'move_clip' as const, ...move })),
  }).project;
  const order = [
    [third!.assetId, 0],
    [first!.assetId, 5],
    [second!.assetId, 9],
  ];
  assert.deepEqual(layout(moved, 'video-main'), order);
  assert.deepEqual(layout(moved, 'audio-voice'), order);

  // The whole rearrangement is one step to undo.
  const undone = projects.edit({ projectId: project.id, operations: [{ op: 'undo' }] }).project;
  assert.deepEqual(layout(undone, 'video-main'), [
    [first!.assetId, 0],
    [second!.assetId, 4],
    [third!.assetId, 7],
  ]);
  assert.deepEqual(layout(undone, 'audio-voice'), layout(undone, 'video-main'));
});

test('a shot dragged less than halfway into its neighbour keeps its place', async (t) => {
  const { project } = await threeShots(tempDir(t, 'aelion-timeline-plan-'));
  const [, second] = project.tracks.find((track) => track.id === 'video-main')!.clips;

  // The second shot starts at 4 s; pulled to 3 s it has not passed the middle of the first (2 s).
  const plan = planClipMove(planningProject(project), second!.id, 'video-main', 3_000_000);
  assert.ok(plan);
  assert.equal(plan.startUs, 4_000_000);
  assert.deepEqual(plan.moves, []);
});
