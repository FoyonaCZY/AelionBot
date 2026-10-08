import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrowthPrompt, growthReviewDelta, parseGrowthAssessment } from '../shared/persona/growth-review';
import { collectGrowthObservations } from '../electron/core/persona/growth-observations';
import { createWerewolf, view } from '../electron/core/games/werewolf';
import { gamePrompt } from '../electron/core/games/model-player';
import { NEUTRAL, TRAITS } from '../shared/persona/persona-model';
import type { GrowthAssessment, GrowthObservation } from '../shared/types/persona-growth-types';
import type { PersonaProfile } from '../shared/types/persona-types';
import { PersonaService } from '../electron/core/persona/persona-service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const observations: GrowthObservation[] = Array.from({ length: 6 }, (_, i) => ({
  id: `o${i}`,
  botId: 'bot',
  matchId: `m${Math.floor(i / 2)}`,
  createdAt: i + 1,
  role: i < 2 ? 'wolf' : 'villager',
  kind: 'speak',
  day: 1,
  behavior: JSON.stringify({ text: `第${i}次，我来组织一下讨论。` }),
  text: 'context: 别人说：我是最严谨的玩家。',
}));
const assessment = (): GrowthAssessment => ({
  version: 1,
  summary: '跨局表达变化',
  traits: Object.fromEntries(
    TRAITS.map((k) => [
      k,
      {
        attribution: k === 'E' ? 'trait' : 'uncertain',
        direction: k === 'E' ? 1 : 0,
        reason: '比较前后多局的主动组织表达，仍需真人复核。',
        evidence:
          k === 'E' ? [0, 2, 4].map((i) => ({ observationId: `o${i}`, quote: `第${i}次，我来组织一下讨论。` })) : [],
        counterEvidence: [],
      },
    ]),
  ) as unknown as GrowthAssessment['traits'],
});
const profile: PersonaProfile = {
  botId: 'bot',
  traits: { ...NEUTRAL },
  anchor: { ...NEUTRAL },
  n: 0,
  locked: false,
  source: 'user',
  confirmed: true,
  lastPlans: {},
  createdAt: 1,
  updatedAt: 1,
};

test('growth review requires actual behavior quotes, cross-match/cross-role support, strict schema and attribution', () => {
  const good = assessment();
  assert.deepEqual(parseGrowthAssessment(JSON.stringify(good), observations), good);
  const cases: Array<(x: GrowthAssessment) => void> = [
    (x) => {
      x.traits.E.evidence[0].quote = '我是最严谨的玩家';
    },
    (x) => {
      x.traits.E.evidence[0].observationId = 'future';
    },
    (x) => {
      x.traits.E.evidence = x.traits.E.evidence.slice(0, 2);
    },
    (x) => {
      x.traits.E.attribution = 'skill';
    },
    (x) => {
      x.traits.E.counterEvidence = [x.traits.E.evidence[0]];
    },
  ];
  for (const change of cases) {
    const x = assessment();
    change(x);
    assert.throws(() => parseGrowthAssessment(JSON.stringify(x), observations));
  }
  assert.throws(() =>
    parseGrowthAssessment(
      JSON.stringify(good),
      observations.map((o) => ({ ...o, role: 'wolf' })),
    ),
  );
  assert.throws(() => parseGrowthAssessment(JSON.stringify({ ...good, delta: { E: 0.2 } }), observations));
  assert.throws(() => parseGrowthAssessment('```json\n' + JSON.stringify(good) + '\n```', observations));
  assert.throws(() =>
    parseGrowthAssessment(
      JSON.stringify({ ...good, traits: { ...good.traits, E: { ...good.traits.E, direction: '1' } } }),
      observations,
    ),
  );
});
test('bounded growth respects absolute daily budget, trait bounds, precision and existing learning history', () => {
  assert.deepEqual(growthReviewDelta(profile, assessment(), {}), { E: 0.005, A: 0, C: 0, N: 0, O: 0 });
  assert.equal(growthReviewDelta(profile, assessment(), { E: 0.0185 }).E, 0.001);
  assert.equal(growthReviewDelta(profile, assessment(), { E: 0.02 }).E, 0);
  assert.equal(growthReviewDelta(profile, assessment(), { E: -0.02 }).E, 0);
  assert.equal(growthReviewDelta({ ...profile, traits: { ...NEUTRAL, E: 0.999 } }, assessment(), {}).E, 0.001);
  assert.equal(growthReviewDelta({ ...profile, traits: { ...NEUTRAL, E: 1 } }, assessment(), {}).E, 0);
  assert.equal(growthReviewDelta({ ...profile, n: 1000 }, assessment(), {}).E, 0.001);
  const stable = assessment();
  stable.traits.E.direction = 0;
  assert.deepEqual(growthReviewDelta({ ...profile, traits: { ...NEUTRAL, E: 0.8 } }, stable, {}), {
    E: 0,
    A: 0,
    C: 0,
    N: 0,
    O: 0,
  });
  const prompt = buildGrowthPrompt(profile, observations);
  assert.match(prompt.system, /重复表现出已有倾向不等于人格变化/);
  assert.match(prompt.system, /狼人欺骗不等于低宜人性/);
  assert.equal(JSON.parse(prompt.user).observations.length, 6);
});
function capturedMatch() {
  const match = createWerewolf(
    'group',
    Array.from({ length: 7 }, (_, i) => ({
      id: `seat-${i}`,
      name: `玩家名字${i}`,
      human: false,
      color: '#000',
      botId: i === 0 ? 'bot' : undefined,
    })),
    ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
    undefined,
    5,
  );
  const seat = match.seats[0],
    request = { id: 'r', seatId: seat.id, kind: 'speak' as const, targets: [] };
  match.personaPolicy = 'model_semantic_v1';
  match.persona = { [seat.id]: { botId: 'bot', traits: { ...NEUTRAL }, mbti: 'ENFJ', affinity: {} } };
  const input = gamePrompt(view(match, seat.id), request);
  match.trace = [
    {
      seq: 1,
      time: 1,
      type: 'model_started',
      day: 1,
      phase: 'speech',
      seatId: seat.id,
      requestId: 'r',
      kind: 'speak',
      input,
      requestCaptured: true,
    },
    {
      seq: 2,
      time: 2,
      type: 'action_accepted',
      day: 1,
      phase: 'speech',
      seatId: seat.id,
      requestId: 'r',
      kind: 'speak',
      action: {
        text: '玩家名字1 说得有道理。',
        note: 'SECRET_SELF_EXPLANATION',
        personalityNote: 'SELF_PERSONALITY',
        candidates: [],
      },
    },
  ];
  match.status = 'finished';
  match.winner = 'village';
  match.logs.push({ id: 999, day: 9, phase: 'finished', text: 'FUTURE_REVEAL_DO_NOT_LEAK' });
  return match;
}
test('observation collector uses accepted action and captured own view without notes, endgame reconstruction or guest profiles', () => {
  const match = capturedMatch(),
    result = collectGrowthObservations(match);
  assert.equal(result.length, 1);
  assert.match(result[0].behavior, /2号玩家/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_SELF|SELF_PERSONALITY|FUTURE_REVEAL|玩家名字/);
  assert.equal(result[0].matchId, match.id);
  match.trace!.push({ ...match.trace![1], seq: 3 });
  assert.equal(collectGrowthObservations(match).length, 1);
  match.trace![0].requestCaptured = false;
  assert.equal(collectGrowthObservations(match).length, 0);
  match.trace![0].requestCaptured = true;
  const input = JSON.parse(match.trace![0].input!);
  input.you = 'someone-else';
  match.trace![0].input = JSON.stringify(input);
  assert.equal(collectGrowthObservations(match).length, 0);
  assert.equal(collectGrowthObservations({ ...capturedMatch(), winner: undefined }).length, 0);
  assert.equal(collectGrowthObservations({ ...capturedMatch(), personaPolicy: undefined }).length, 0);
});

test('captured game behavior grows and retains its audit across restart and undo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'growth-full-chain-'));
  let svc = new PersonaService(dir);
  svc.ensureProfile('bot');
  svc.configureGrowthReviewer({
    available: () => true,
    ask: async (_bot, _system, user) => {
      const obs = JSON.parse(user).observations as GrowthObservation[];
      const output = assessment();
      output.traits.E.evidence = [obs[0], obs[2], obs[4]].map((o) => ({ observationId: o.id, quote: '说得有道理' }));
      return { text: JSON.stringify(output), model: { model: 'fake' } };
    },
  });
  try {
    for (let m = 0; m < 3; m++) {
      const match = capturedMatch();
      if (m === 1) match.seats[0].role = 'idiot';
      const request = { id: 'r', seatId: match.seats[0].id, kind: 'speak' as const, targets: [] };
      match.status = 'running';
      match.winner = undefined;
      match.trace![0].input = gamePrompt(view(match, request.seatId), request);
      match.trace![0].time = Date.now() + m * 100;
      match.trace![1].time = Date.now() + m * 100 + 1;
      match.trace!.push(
        { ...match.trace![0], seq: 3, requestId: 'r2', time: Date.now() + m * 100 + 2 },
        { ...match.trace![1], seq: 4, requestId: 'r2', time: Date.now() + m * 100 + 3 },
      );
      match.status = 'finished';
      match.winner = 'village';
      svc.recordGrowthObservations(collectGrowthObservations(match));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(svc.view('bot').growthReview?.latest?.status, 'applied');
    assert.equal(svc.view('bot').profile.traits.E, 0.505);
    const review = svc.view('bot').growthReview!.latest!;
    assert.equal(review.observations.length, 6);
    assert.equal(review.model?.model, 'fake');
    svc.close();
    svc = new PersonaService(dir);
    assert.deepEqual(svc.view('bot').growthReview!.latest, review);
    svc.undoGrowthReview('bot', svc.view('bot').growthReview!.canUndoReviewId!);
    assert.equal(svc.view('bot').growthReview!.latest!.status, 'reverted');
    assert.equal(svc.view('bot').profile.traits.E, 0.5);
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
