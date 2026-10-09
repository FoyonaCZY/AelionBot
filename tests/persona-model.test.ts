import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JACOBIAN,
  NEUTRAL,
  PLANS,
  TENDENCIES,
  TRAITS,
  DAILY_CAP,
  choose,
  growthStep,
  mbtiOf,
  tendencies,
  traitsFromMbti,
  speechLimit,
  type Traits,
} from '../shared/persona/persona-model';
import { seededRandom } from '../shared/games/seeded-random';
import {
  createWerewolf,
  acceptAction,
  view,
  validateAction,
  type WerewolfState,
} from '../electron/core/games/werewolf';
import { assignPersonas, personaPick, mostNominated, type PersonaSeed } from '../electron/core/games/persona-play';
import { matchExperiences } from '../electron/core/persona/growth';
import { PersonaService } from '../electron/core/persona/persona-service';
import { gamePrompt, gameInstructions, parseGameAction } from '../electron/core/games/model-player';
import type { GameAction, GameRequest } from '../shared/types/game-types';

const T = (over: Partial<Traits> = {}): Traits => ({ ...NEUTRAL, ...over });
// Close the service before removing its folder: Windows cannot delete an open SQLite file.
function personaService(t: test.TestContext, now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona2-'));
  const svc = new PersonaService(dir, now);
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

test('derived tendencies are zero at the neutral level and the Jacobian is their exact derivative', () => {
  for (const v of Object.values(tendencies(NEUTRAL))) assert.equal(Math.abs(v), 0);
  const base = T({ E: 0.3, A: 0.7, C: 0.4, N: 0.6, O: 0.55 }),
    h = 1e-6;
  for (const k of TRAITS) {
    const up = tendencies({ ...base, [k]: base[k] + h }),
      at = tendencies(base);
    for (const d of TENDENCIES) assert.ok(Math.abs((up[d] - at[d]) / h - (JACOBIAN[d][k] || 0)) < 1e-4, `∂${d}/∂${k}`);
  }
});

test('MBTI letters follow the Big Five mapping and a preset draft maps back to the same letters', () => {
  assert.equal(mbtiOf(T({ E: 0.8, O: 0.2, A: 0.9, C: 0.1, N: 0.7 })), 'ESFP-T');
  for (const type of ['INTJ', 'ESFP', 'ENFJ', 'ISTP']) assert.equal(mbtiOf(traitsFromMbti(type)).slice(0, 4), type);
});

test('choice: neutral personality favours the model pick; personality shifts plans in the predicted direction', () => {
  const options = [0, 1, 2].map((rank) => ({ value: rank, rank, f: {} }));
  const neutral = choose(NEUTRAL, options, seededRandom(1));
  assert.ok(neutral.probs[0] > neutral.probs[1] && neutral.probs[1] > neutral.probs[2]);
  assert.ok(neutral.probs[0] < 1, 'sampling, not argmax');
  // Dose-response on the wolf plans: higher E makes the jump (assert +1) more likely, lower E the deep cover.
  const wolf = PLANS.filter((p) => p.role === 'wolf').map((p) => ({ value: p.id, rank: 0, f: p.f }));
  const share = (E: number) => {
    let jumps = 0;
    for (let i = 0; i < 2000; i++) if (choose(T({ E }), wolf, seededRandom(i)).value === 'wolf_jump') jumps++;
    return jumps / 2000;
  };
  const low = share(0.1),
    mid = share(0.5),
    high = share(0.9);
  assert.ok(low < mid && mid < high, `jump share ${low} < ${mid} < ${high}`);
  assert.ok(Math.abs(mid - 1 / 3) < 0.04, 'neutral is uniform among plans');
});

test('growth: rewards scale with E and punishments with N, the anchor pulls back, and the daily cap holds', () => {
  const risky = { s: { risk: 1, assert: 1 }, o: 1 };
  const shy = growthStep(T({ E: 0.2 }), T({ E: 0.2 }), 0, risky, 'game'),
    bold = growthStep(T({ E: 0.8 }), T({ E: 0.8 }), 0, risky, 'game');
  assert.ok(bold.E > shy.E && shy.E > 0, 'reward sensitivity is E');
  const punished = growthStep(T({ N: 0.9 }), T({ N: 0.9 }), 0, { ...risky, o: -1 }, 'game'),
    calm = growthStep(T({ N: 0.1 }), T({ N: 0.1 }), 0, { ...risky, o: -1 }, 'game');
  assert.ok(punished.E < calm.E && calm.E < 0, 'threat sensitivity is N');
  const drifted = growthStep(T({ E: 0.9 }), T({ E: 0.5 }), 0, { s: {}, o: 1 }, 'game');
  assert.ok(drifted.E < 0, 'with no push the anchor pulls back');
  const late = growthStep(T(), T(), 500, risky, 'game'),
    early = growthStep(T(), T(), 0, risky, 'game');
  assert.ok(late.E < early.E / 5, 'the learning rate falls with experience');
  const capped = growthStep(T(), T(), 0, risky, 'chat', { E: DAILY_CAP.chat - 0.0001 });
  assert.ok(capped.E <= 0.0001 + 1e-12, 'chat stops at its daily cap');
  assert.ok(speechLimit(T({ E: 1 })) > speechLimit(T({ E: 0 })));
});

const seat7 = (bots = 7) =>
  Array.from({ length: 7 }, (_, i) => ({
    id: 's' + i,
    name: 'P' + i,
    human: false,
    color: '#888',
    ...(i < bots ? { botId: 'bot' + i } : {}),
  }));
const seedsFor = (s: WerewolfState, traits: (i: number) => Traits): Record<string, PersonaSeed> =>
  Object.fromEntries(s.seats.filter((p) => p.botId).map((p, i) => [p.botId!, { traits: traits(i) }]));

test('plans are seeded, private, and at most one wolf jumps', () => {
  const deal = () =>
    createWerewolf('g', seat7(), ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'], undefined, 42);
  const a = deal(),
    b = deal();
  assignPersonas(
    a,
    seedsFor(a, () => T({ E: 0.95 })),
  );
  assignPersonas(
    b,
    seedsFor(b, () => T({ E: 0.95 })),
  );
  assert.deepEqual(
    Object.values(a.persona!).map((p) => p.plan!.id),
    Object.values(b.persona!).map((p) => p.plan!.id),
  );
  for (let seed = 0; seed < 50; seed++) {
    const s = createWerewolf(
      'g',
      seat7(),
      ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
      undefined,
      seed,
    );
    assignPersonas(
      s,
      seedsFor(s, () => T({ E: 0.99 })),
    );
    assert.ok(Object.values(s.persona!).filter((p) => p.plan?.id === 'wolf_jump').length <= 1);
  }
  const r = a.requests[0];
  const v = view(a, r.seatId);
  assert.deepEqual(Object.keys(v.persona || {}), [r.seatId], 'a seat sees only its own persona while running');
  assert.equal(view(a).persona, undefined, 'spectators see none before the reveal');
  const prompt = gamePrompt(view(a, r.seatId), r);
  assert.ok(prompt.includes('bot_persona') && !prompt.includes('behaviorPolicy'));
  assert.ok(!prompt.includes('"traits"'), 'raw numbers stay out of the prompt; only plan and style go in');
});

function voteState() {
  // Play the seven-seat match until the first day vote, with every Bot having a persona.
  const s = createWerewolf(
    'g',
    seat7(),
    ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
    undefined,
    3,
  );
  assignPersonas(
    s,
    seedsFor(s, () => T({ E: 0.9, O: 0.9 })),
  );
  let guard = 0;
  while (s.requests.length && !s.requests.some((r) => r.kind === 'vote') && guard++ < 200) {
    const r = s.requests[0];
    acceptAction(
      s,
      r.id,
      r.kind === 'witch'
        ? { potion: 'skip' }
        : r.kind === 'speak' || r.kind === 'wolf_plan'
          ? { text: '我先听听 5号。' }
          : { target: r.targets[0] },
    );
  }
  return s;
}
const valid = (s: WerewolfState, r: GameRequest) => (a: GameAction) => {
  try {
    validateAction(s, r, a);
    return true;
  } catch {
    return false;
  }
};

test('weak-situation pick: strong situations keep the model pick; overrides stay among legal reasonable candidates', () => {
  const s = voteState();
  const r = s.requests.find(
    (x) => x.kind === 'vote' && x.targets.length >= 3 && s.seats.find((p) => p.id === x.seatId)!.role !== 'wolf',
  )!;
  const [first, second, third] = r.targets;
  // Single reasonable candidate → strong.
  const alone = personaPick(
    s,
    r,
    { target: first, candidates: [{ target: first, reasonable: true }, { target: second }] },
    valid(s, r),
  );
  assert.equal(alone.action.target, first);
  assert.equal(alone.decision!.strong, true);
  // Decisive evidence → strong.
  const decisive = personaPick(
    s,
    r,
    {
      target: first,
      candidates: [
        { target: first, reasonable: true, decisive: true },
        { target: second, reasonable: true },
      ],
    },
    valid(s, r),
  );
  assert.equal(decisive.action.target, first);
  // Older providers without semantic evidence now keep the first choice; no hard action-feature inference.
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const res = personaPick(
      s,
      r,
      {
        target: first,
        note: 'n',
        candidates: [
          { target: first, reasonable: true },
          { target: second, reasonable: true },
          { target: third, reasonable: false },
          { target: 'not-a-seat', reasonable: true },
        ],
      },
      valid(s, r),
    );
    seen.add(res.action.target!);
    assert.equal(res.action.note, 'n', 'the model note is kept');
    assert.equal(res.decision!.strong, false);
    assert.equal(res.decision!.gateReason, 'semantic_missing');
    assert.deepEqual(res.decision!.features, {});
  }
  assert.deepEqual([...seen], [first]);
  // No persona → untouched.
  const plain = createWerewolf('g', seat7(0), undefined, undefined, 1);
  const pr = plain.requests[0];
  assert.equal(personaPick(plain, pr, { target: pr.targets[0] }, () => true).decision, undefined);
});

test('the most nominated seat is counted from public speech by seat number', () => {
  const s = voteState();
  s.logs.push({
    id: 900,
    day: s.day,
    phase: s.phase,
    text: '我觉得 5号 和 5号的票型都很怪，3号还行',
    seatId: s.seats[0].id,
    time: 0,
  });
  assert.equal(mostNominated(s, s.seats[1].id), s.seats[4].id);
});

test('the parser keeps valid candidates and drops malformed ones without failing the action', () => {
  const r: GameRequest = { id: 'r', seatId: 'a', kind: 'vote', targets: ['x', 'y'] };
  const a = parseGameAction(
    JSON.stringify({
      target: 'x',
      candidates: [
        { target: 'x', reasonable: true },
        { target: 'zz', reasonable: true },
        'junk',
        { target: 'y', reasonable: true, decisive: false },
      ],
    }),
    'vote',
    r,
  );
  assert.equal(a.target, 'x');
  assert.deepEqual(
    a.candidates!.map((c) => c.target),
    ['x', 'y'],
  );
  assert.equal(parseGameAction(JSON.stringify({ target: 'x', candidates: 'nope' }), 'vote', r).candidates, undefined);
  const s = voteState(),
    vote = s.requests.find((x) => x.kind === 'vote')!;
  assert.ok(gameInstructions(view(s, vote.seatId), vote).includes('candidates'));
});

test('growth experiences: votes judged by the revealed camp, strong decisions skipped, sheriff against its baseline', () => {
  const seats = [
    { id: 'a', name: 'A', botId: 'A', role: 'villager' as const },
    { id: 'b', name: 'B', botId: 'B', role: 'wolf' as const },
    { id: 'c', name: 'C', role: 'seer' as const },
    { id: 'd', name: 'D', botId: 'D', role: 'villager' as const },
  ];
  const decision = (over: object) => ({
    requestId: 'r',
    seatId: 'a',
    kind: 'vote' as const,
    day: 1,
    strong: false,
    options: 2,
    chosen: {},
    features: { conform: 1 },
    prob: 0.5,
    overridden: false,
    ...over,
  });
  const ex = matchExperiences(
    seats,
    [
      decision({ subject: 'b' }),
      decision({ subject: 'c', seatId: 'd' }),
      decision({ subject: 'b', strong: true, seatId: 'd' }),
      decision({ kind: 'sheriff_join', chosen: { choice: true }, seatId: 'a', features: { assert: 1 } }),
      decision({ kind: 'sheriff_join', chosen: { choice: true }, seatId: 'd', features: { assert: 1 } }),
    ],
    [{ type: 'elect', day: 1, seatId: 'a', applicants: ['a', 'd', 'b'], withdrawn: ['b'] }],
  );
  assert.deepEqual(
    ex.map((e) => [e.botId, e.kind, e.o]),
    [
      ['A', 'vote', 1],
      ['D', 'vote', -1],
      ['A', 'sheriff_join', 1],
      ['D', 'sheriff_join', -1],
    ],
  );
});

test('settlement grows each Bot within the daily cap, records why, remembers plans; lock and reset work', (t) => {
  let now = Date.UTC(2026, 9, 1, 8);
  const svc = personaService(t, () => now);
  const seeds = svc.seeds([{ botId: 'A', mbti: 'ENTJ' }, { botId: 'B' }], ['A', 'B', 'user']);
  assert.equal(seeds.A.traits.E, 0.7);
  const seats = [
    { id: 'a', name: 'A', human: false, botId: 'A', role: 'villager' as const },
    { id: 'b', name: 'B', human: false, botId: 'B', role: 'wolf' as const },
    { id: 'u', name: '我', human: true, role: 'villager' as const },
  ];
  const persona = {
    a: {
      botId: 'A',
      traits: seeds.A.traits,
      mbti: 'ENTJ-A',
      affinity: {},
      plan: { id: 'villager_lead', name: '', detail: '', f: {}, prob: 0.5 },
    },
    b: {
      botId: 'B',
      traits: seeds.B.traits,
      mbti: 'ENFJ-T',
      affinity: {},
      plan: { id: 'wolf_deep', name: '', detail: '', f: {}, prob: 0.5 },
    },
  };
  const votes = Array.from({ length: 40 }, (_, i) => ({
    requestId: 'r' + i,
    seatId: 'a',
    kind: 'vote' as const,
    day: 1,
    strong: false,
    options: 2,
    chosen: {},
    subject: 'b',
    features: { conform: -1, assert: 1 },
    prob: 0.5,
    overridden: false,
  }));
  const match = (id: string) => ({
    id,
    groupId: 'g',
    winner: 'village' as const,
    seats,
    events: [],
    decisions: votes,
    persona,
  });
  svc.settle(match('m1'));
  const after = svc.view('A');
  assert.equal(after.episodes.length, 30, 'the page lists the latest 30');
  assert.ok(after.profile.traits.E > 0.7, 'right votes with assert reward E');
  for (const k of TRAITS)
    assert.ok(
      Math.abs(after.profile.traits[k] - after.profile.anchor[k]) <= DAILY_CAP.game + 1e-9,
      `${k} within the daily cap`,
    );
  assert.equal(after.profile.lastPlans.villager, 'villager_lead');
  assert.equal(svc.view('B').profile.lastPlans.wolf, 'wolf_deep');
  assert.ok(after.history.at(-1)!.reason.includes('40'));
  now += 86_400_000;
  svc.setLocked('A', true);
  const locked = svc.view('A').profile.traits;
  svc.settle(match('m2'));
  assert.deepEqual(svc.view('A').profile.traits, locked, 'a locked profile does not grow');
  const reset = svc.resetGrowth('A');
  assert.deepEqual(reset.profile.traits, reset.profile.anchor);
  assert.equal(reset.episodes.length, 0);
  const set = svc.setTraits('A', T({ E: 0.2, O: 0.9 }));
  assert.equal(set.profile.source, 'user');
  assert.equal(set.profile.anchor.O, 0.9);
  assert.throws(() => svc.setTraits('A', { ...T(), E: Number.NaN }));
});

test('a whole match through the runtime: personas assigned, candidates honoured, decisions settled', async (t) => {
  const { GameRuntime } = await import('../electron/core/games/runtime');
  const { until } = await import('./helpers');
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona2-'));
  const svc = new PersonaService(dir);
  let done: WerewolfState | undefined;
  const runtime = new GameRuntime(
    join(dir, 'games'),
    async (_p, _v, r) =>
      ['speak', 'wolf_plan', 'campaign', 'pk_speak', 'last_words'].includes(r.kind)
        ? { text: '我先听听。' }
        : r.kind === 'witch'
          ? { potion: 'skip' }
          : r.kind === 'sheriff_join' || r.kind === 'withdraw'
            ? { choice: false }
            : r.kind === 'sheriff_order'
              ? { direction: 'clockwise' }
              : {
                  target: r.targets[0],
                  candidates: r.targets.slice(0, 3).map((target) => ({ target, reasonable: true })),
                },
    () => {},
    { aiTimeoutMs: 90000 },
    {
      personas: (bots, members) => svc.seeds(bots, members),
      finished: (s) => {
        done = s;
        svc.settle({
          id: s.id,
          groupId: s.groupId,
          winner: s.winner,
          seats: s.seats,
          events: s.events || [],
          decisions: s.decisions,
          persona: s.persona,
        });
      },
    },
  );
  t.after(() => {
    runtime.dispose();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  runtime.create({ groupId: 'g', players: seat7(4) });
  await until(() => !!done, { timeoutMs: 25_000, intervalMs: 50 });
  assert.equal(Object.keys(done!.persona!).length, 4, 'only member Bots get a persona; guests keep the preset');
  const votes = done!.decisions!.filter((d) => d.kind === 'vote');
  assert.ok(votes.length > 0);
  assert.ok(votes.every((d) => d.strong || d.options >= 2));
  const revealed = view(done!);
  assert.equal(Object.keys(revealed.persona!).length, 4, 'after the reveal everyone can see the personas');
  const grown = ['bot0', 'bot1', 'bot2', 'bot3'].map((b) => svc.view(b));
  assert.ok(
    grown.some((g) => g.episodes.length > 0),
    'weak votes became growth experiences',
  );
});

test('birth draft: facet ratings map to traits, bad replies fail, and a grown Bot is never overwritten', async (t) => {
  const { traitsFromFacets, birthPrompt } = await import('../electron/core/persona/birth');
  const all = (v: number) => Object.fromEntries(TRAITS.flatMap((k) => [1, 2, 3].map((i) => [`${k}${i}`, v])));
  assert.deepEqual(traitsFromFacets(JSON.stringify(all(5))), T({ E: 1, A: 1, C: 1, N: 1, O: 1 }));
  assert.deepEqual(traitsFromFacets('```json\n' + JSON.stringify({ ...all(3), E1: 5, E2: 5, E3: 5 }) + '\n```').E, 1);
  assert.equal(
    traitsFromFacets(JSON.stringify({ ...all(1), O1: 99 })).O,
    0.167,
    'an out-of-range rating counts as 3; values keep 3 decimals',
  );
  assert.throws(() => traitsFromFacets('{"E1":3}'), /不完整/);
  assert.ok(birthPrompt('阿岩', '话少，爱观察').user.includes('E1.'));
  const svc = personaService(t);
  const drafted = await svc.draft('A', '阿岩', '话少', async () => JSON.stringify({ ...all(3), E1: 1, E2: 1, E3: 1 }));
  assert.equal(drafted.profile.source, 'bfi2');
  assert.equal(drafted.profile.confirmed, false);
  assert.equal(drafted.profile.anchor.E, 0);
  const p = svc.store.profile('A')!;
  svc.store.saveProfile({ ...p, n: 3 });
  await assert.rejects(
    svc.draft('A', '阿岩', '', async () => '{}'),
    /重置成长/,
  );
});
