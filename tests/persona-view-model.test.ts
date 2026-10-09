import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  episodeChange,
  episodeSource,
  growthSummary,
  historyPoints,
  historyRange,
  relationWord,
  signed,
  soulPath,
  statusText,
} from '../src/group/persona-view-model';
import { NEUTRAL } from '../shared/persona/persona-model';
import type { PersonaView } from '../shared/types/persona-types';
import { PersonaService } from '../electron/core/persona/persona-service';
import type { GrowthReviewRecord } from '../shared/types/persona-growth-types';

/** A Bot born at the neutral personality whose extraversion was `E` after each recorded experience. */
function grown(E: number[]): PersonaView {
  return {
    profile: {
      botId: 'b',
      traits: { ...NEUTRAL, E: E[E.length - 1] },
      anchor: { ...NEUTRAL },
      n: E.length,
      locked: false,
      source: 'mbti',
      confirmed: true,
      lastPlans: {},
      createdAt: 0,
      updatedAt: 0,
    },
    mbti: 'ISTJ-A',
    history: E.map((e, i) => ({ traits: { ...NEUTRAL, E: e }, createdAt: i, reason: '' })),
    episodes: [],
    relations: [],
    highlights: [],
  };
}

test('the soul shape is a closed curve that grows with each trait and stays visible at zero', () => {
  const low = soulPath({ E: 0, A: 0, C: 0, N: 0, O: 0 }),
    high = soulPath({ E: 1, A: 1, C: 1, N: 1, O: 1 });
  assert.match(low, /^M[\d.]+ [\d.]+( C[\d. ]+){5}Z$/);
  // The first point is the top lobe (E): its y is smaller (further up) when E is higher, but never at the centre.
  const y = (p: string) => Number(p.split(' ')[1]);
  assert.ok(y(high) < y(low) && y(low) < 80);
  assert.notEqual(
    soulPath({ ...NEUTRAL, E: 0.9 }),
    soulPath({ ...NEUTRAL, O: 0.9 }),
    'different traits, different shapes',
  );
});

test('numbers on the page: signed changes, the strongest moved trait, relation words, status', () => {
  assert.equal(signed(0.034), '+0.03');
  assert.equal(signed(-0.012), '−0.01');
  assert.equal(signed(0.0004), '0');
  const e = {
    id: '1',
    botId: 'b',
    scope: 'game' as const,
    sourceId: 'm',
    kind: 'vote',
    summary: '',
    s: {},
    o: 1,
    delta: { E: 0.0042, A: -0.001, C: 0, N: 0, O: 0 },
    createdAt: 0,
  };
  assert.equal(episodeChange(e), '外向性 +0.004');
  assert.equal(episodeChange({ ...e, delta: { E: 0, A: 0, C: 0, N: 0, O: 0 } }), undefined);
  assert.equal(episodeSource(e), '游戏');
  assert.equal(episodeSource({ ...e, scope: 'chat' }), '群聊');
  assert.equal(episodeSource({ ...e, kind: 'growth_review' }), '成长评估');
  assert.equal(episodeSource({ ...e, kind: 'growth_review_undo' }), '撤销成长');
  assert.deepEqual([0.6, 0.2, 0, -0.2, -0.6].map(relationWord), ['很好', '不错', '一般', '有芥蒂', '很差']);
});

function reviewed(): PersonaView {
  const view = grown([0.5, 0.505]);
  view.profile.n = 1;
  const review: GrowthReviewRecord = {
    id: 'review',
    botId: 'b',
    policyVersion: 'v1',
    triggerMatchId: 'match',
    batchId: 'batch',
    createdAt: 10,
    completedAt: 20,
    status: 'applied',
    summary: '跨局评估确认了新的持续倾向。',
    observations: [],
    before: { ...NEUTRAL },
    after: { ...view.profile.traits },
    anchor: { ...NEUTRAL },
    delta: { E: 0.005, A: 0, C: 0, N: 0, O: 0 },
    nBefore: 0,
    profileEpoch: 0,
  };
  view.history = [
    { traits: review.before, reason: '手动设定', createdAt: 0 },
    { traits: review.after, reason: '跨经历成长评估', createdAt: 20 },
  ];
  view.growthReview = {
    running: false,
    eligibleObservations: 0,
    eligibleMatches: 0,
    minObservations: 6,
    minMatches: 3,
    latest: review,
    recent: [review],
  };
  return view;
}

test('growth summary recognizes legacy growth without inventing an assessment', () => {
  assert.equal(growthSummary(grown([0.5, 0.51])), '人格已有变化，可从曲线和历史记录回看。');
  assert.equal(growthSummary(grown([0.5])), '当前人格与出生时一致；经历仍在积累。');
});

test('growth summary shows a current applied or unchanged conclusion only when its numbers match', () => {
  const view = reviewed(),
    review = view.growthReview!.latest!;
  assert.equal(growthSummary(view), review.summary);
  view.profile.n++;
  assert.equal(growthSummary(view), '人格已有变化，可从曲线和历史记录回看。');
  view.profile.n--;
  review.before.E = 0.4;
  assert.equal(growthSummary(view), '人格已有变化，可从曲线和历史记录回看。');
  review.status = 'unchanged';
  review.before = { ...review.after };
  review.delta.E = 0;
  review.nBefore = view.profile.n;
  assert.equal(growthSummary(view), review.summary);
});

test('growth summary does not present failures or retained pre-reset audits as an applied change', () => {
  const view = reviewed();
  for (const status of ['failed', 'rejected', 'stale', 'running'] as const) {
    view.growthReview!.latest!.status = status;
    assert.equal(growthSummary(view), '人格已有变化，可从曲线和历史记录回看。');
  }
  view.growthReview!.latest!.status = 'applied';
  view.profile.traits = { ...view.profile.anchor };
  view.profile.n = 0;
  view.history = [{ traits: view.profile.traits, createdAt: 30, reason: '重置成长' }];
  assert.equal(growthSummary(view), '当前人格与出生时一致；经历仍在积累。');
});

test('growth summary recognizes reversal and suppresses it after a reset or identical manual save', () => {
  const view = reviewed(),
    review = view.growthReview!.latest!;
  review.status = 'reverted';
  review.summary = '已撤销最近一次变化。';
  review.reverts = 'original';
  review.before = { ...view.profile.traits };
  review.after = { ...view.profile.anchor };
  review.delta.E = -0.005;
  review.nBefore = 1;
  view.profile.n = 0;
  view.profile.traits = { ...review.after };
  view.history.push({ traits: review.after, createdAt: 20, reason: '撤回跨经历成长' });
  assert.equal(growthSummary(view), review.summary);
  for (const reason of ['重置成长', '手动设定', '角色设定估计']) {
    const after = { ...view, history: [...view.history, { traits: review.after, createdAt: 20, reason }] };
    assert.equal(growthSummary(after), '当前人格与出生时一致；经历仍在积累。');
  }
});

test('viewing a Bot never saves a draft; confirming does, and the draft follows the game preset', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona-view-'));
  const svc = new PersonaService(dir);
  // Close before removing the folder: Windows cannot delete an open SQLite file.
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const looked = svc.view('A', 'ESTP');
  assert.equal(looked.profile.traits.E, 0.7);
  assert.equal(statusText(looked), '初稿 · 由游戏预设生成，待你确认');
  assert.equal(svc.store.profile('A'), undefined, 'looking at the page does not freeze the draft');
  // A later preset change still applies, because nothing was saved.
  assert.equal(svc.view('A', 'ISFJ').profile.traits.E, 0.3);
  const confirmed = svc.confirm('A', 'ISFJ');
  assert.equal(confirmed.profile.confirmed, true);
  assert.equal(svc.store.profile('A')!.traits.E, 0.3);
  assert.equal(statusText(confirmed), '已确认');
  assert.deepEqual(historyPoints(confirmed, 'E', 100, 40), [[100, 20]], 'one point, on the midline at birth');
});

test('growth charts zoom to the moves so far, share one scale, and keep the birth value at the midline', () => {
  assert.equal(historyRange(grown([0.5, 0.5])), 0.02, 'never below one day of game growth');
  assert.equal(historyRange(grown([0.5, 0.51, 0.52])), 0.03, 'a move of 0.02 plus 20% headroom, rounded up to 0.01');
  assert.equal(historyRange(grown([0.5, 0.55, 0.62])), 0.15, 'a long history widens the window instead of clipping');
  assert.equal(
    historyRange(grown([0.5, 0.45, 0.4])),
    historyRange(grown([0.5, 0.55, 0.6])),
    'moves down count as much as moves up',
  );

  const day = grown([0.5, 0.51, 0.52]);
  const points = historyPoints(day, 'E', 100, 40, historyRange(day) * 2);
  assert.deepEqual(
    points.map(([x]) => x),
    [0, 50, 100],
    'points are spread over the history in order',
  );
  assert.equal(points[0][1], 20, 'the birth value is the midline');
  // +0.02 in a window of ±0.03 is two thirds of the way up: a line of a few pixels instead of a flat one.
  assert.ok(Math.abs(points[2][1] - (20 - (0.02 / 0.03) * 20)) < 1e-9);
  // Traits that did not move stay on the midline, and a move outside the window is clamped to the edge.
  assert.deepEqual(
    historyPoints(day, 'A', 100, 40, 0.06).map(([, y]) => y),
    [20, 20, 20],
  );
  assert.equal(historyPoints(grown([0.5, 0.9]), 'E', 100, 40, 0.04)[1][1], 0);
});
