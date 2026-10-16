import test from 'node:test';
import assert from 'node:assert/strict';
import { inTempDir, tempDir, until } from './helpers';
import {
  acceptUndercover,
  createUndercover,
  normalizeWord,
  undercoverFacts,
  validateUndercover,
  viewUndercover,
  wordPairs,
  type UndercoverState,
} from '../electron/core/games/undercover';
import { undercoverPrompt } from '../electron/core/games/undercover-prompt';
import { GameRuntime, type Decide } from '../electron/core/games/runtime';
import type { AnyMatch } from '../electron/core/games/modes';
import { settleMatch } from '../electron/core/persona/settle';
import { collectGrowthObservations } from '../electron/core/persona/growth-observations';
import { PersonaService } from '../electron/core/persona/persona-service';
import { settleFinishedGame } from '../electron/core/games/settlement';
import { seededRandom } from '../shared/games/seeded-random';
import type { GameAction, GameRequest } from '../shared/types/game-types';
import { PRESETS } from '../shared/persona/presets';

const players = (n: number, human = -1) =>
  Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: '玩家' + i, color: '#887799', human: i === human }));
const pairs = { pairs: [{ id: 'u001', a: '牛奶', b: '豆浆', category: '食物饮品' }], version: 'test' };
const create = (n = 6, seed = 7, blank = false) => createUndercover('g', players(n), { blank }, seed, pairs);
const roleOf = (s: UndercoverState, role: string) => s.seats.filter((p) => p.role === role).map((p) => p.id);
const ownWord = (s: UndercoverState, id: string) => {
  const role = s.seats.find((p) => p.id === id)!.role;
  return role === 'civilian' ? s.words.civilian : role === 'undercover' ? s.words.undercover : undefined;
};
/** Every remaining description, then the given votes (seat → target, or skip when missing). */
function describeAll(s: UndercoverState) {
  while (s.requests[0]?.kind === 'describe') acceptUndercover(s, s.requests[0].id, { text: '早餐常见，白色的' });
}
function vote(s: UndercoverState, choose: (r: GameRequest) => string | undefined) {
  for (const r of Array.from(s.requests)) {
    const target = choose(r);
    acceptUndercover(s, r.id, target ? { target } : { skip: true });
  }
}

test('the deal: one spy up to six players, two from seven, and an optional blank', () => {
  const six = create(6);
  assert.equal(roleOf(six, 'undercover').length, 1);
  assert.equal(roleOf(six, 'civilian').length, 5);
  const eight = create(8, 3, true);
  assert.equal(roleOf(eight, 'undercover').length, 2);
  assert.equal(roleOf(eight, 'blank').length, 1);
  assert.notEqual(eight.words.civilian, eight.words.undercover);
  assert.deepEqual([eight.words.civilian, eight.words.undercover].sort(), ['牛奶', '豆浆'].sort());
  assert.throws(() => create(6, 1, true), /7 人及以上/);
  assert.throws(() => create(3), /4–10/);
  assert.throws(() => create(11), /4–10/);
});

test('the shipped word list loads, has no repeated words, and every pair differs', () => {
  const { pairs: all, version } = wordPairs();
  assert.ok(all.length >= 150);
  assert.match(version, /^[0-9a-f]{12}$/);
  const words = all.flatMap((p) => [p.a, p.b]);
  assert.equal(new Set(words).size, words.length);
  assert.ok(all.every((p) => p.a !== p.b && normalizeWord(p.a) && normalizeWord(p.b)));
});

test('each seat sees only its own word, never its own role, and never the other word', () => {
  const s = create(8, 11, true);
  for (const seat of s.seats) {
    const v = viewUndercover(s, seat.id);
    const own = ownWord(s, seat.id);
    assert.equal(v.words?.own, own);
    assert.equal(v.words?.civilian, undefined);
    assert.equal(v.words?.undercover, undefined);
    const me = v.seats.find((p) => p.id === seat.id)!;
    assert.equal(me.role, seat.role === 'blank' ? 'blank' : undefined, 'only a blank knows what it is');
    assert.ok(v.seats.every((p) => p.id === seat.id || p.role === undefined));
    const text = JSON.stringify(v) + undercoverPrompt(v, s.requests[0]);
    const other = [s.words.civilian, s.words.undercover].filter((w) => w !== own);
    for (const word of other) assert.ok(!text.includes(word), `${seat.role} must not see ${word}`);
    assert.ok(!/"(undercover|civilian)"/.test(undercoverPrompt(v, s.requests[0])), 'the prompt names no role');
  }
  const spectator = viewUndercover(s, undefined, true);
  assert.equal(spectator.words?.civilian, s.words.civilian, 'an all-AI spectator may see everything');
});

test('a description may not contain your own word, however it is written', () => {
  const s = create(6, 5);
  const r = s.requests[0];
  const word = ownWord(s, r.seatId)!;
  for (const text of [word, `我觉得是${word}吧`, word.split('').join(' '), `「${word}」`])
    assert.throws(() => validateUndercover(s, r, { text }), /不能出现自己的词/);
  assert.throws(() => validateUndercover(s, r, { text: 'x'.repeat(61) }), /1–60/);
  assert.doesNotThrow(() => validateUndercover(s, r, { text: '早上会喝的东西' }));
});

test('a first tie makes the tied seats describe again and the revote is among them; a second tie exiles nobody', () => {
  const s = create(6, 9);
  describeAll(s);
  assert.equal(s.phase, 'vote');
  const [a, b] = s.seats;
  // Three votes each for a and b.
  vote(s, (r) =>
    s.seats.findIndex((p) => p.id === r.seatId) % 2
      ? r.seatId === a.id
        ? b.id
        : a.id
      : r.seatId === b.id
        ? a.id
        : b.id,
  );
  assert.equal(s.phase, 'speech');
  assert.deepEqual(s.runoff, [a.id, b.id]);
  assert.deepEqual(
    s.requests.map((r) => r.seatId),
    [a.id],
  );
  describeAll(s);
  assert.equal(s.phase, 'vote');
  assert.ok(s.requests.every((r) => r.targets.every((t) => [a.id, b.id].includes(t))));
  vote(s, (r) =>
    r.seatId === a.id
      ? b.id
      : r.seatId === b.id
        ? a.id
        : s.seats.indexOf(s.seats.find((p) => p.id === r.seatId)!) % 2
          ? a.id
          : b.id,
  );
  assert.ok(
    s.seats.every((p) => p.alive),
    'the second tie exiles nobody',
  );
  assert.equal(s.day, 2);
  assert.ok(s.logs.some((l) => l.text === '再次平票，本轮无人出局。'));
});

test('voting out every spy wins for the civilians and announces both words', () => {
  const s = create(5, 2);
  const spy = roleOf(s, 'undercover')[0];
  describeAll(s);
  vote(s, (r) => (r.seatId === spy ? r.targets[0] : spy));
  assert.equal(s.winner, 'civilian');
  assert.equal(s.status, 'finished');
  assert.ok(s.logs.some((l) => l.text === `平民的词是「${s.words.civilian}」，卧底的词是「${s.words.undercover}」。`));
  assert.ok(s.logs.some((l) => l.text.includes('出局，身份是卧底')));
});

test('spies win once they are as many as the civilians', () => {
  const s = create(4, 4);
  const spy = roleOf(s, 'undercover')[0];
  // Two rounds of voting civilians out leaves one spy and one civilian.
  for (let round = 0; round < 2 && s.status === 'running'; round++) {
    describeAll(s);
    const victim = s.seats.find((p) => p.alive && p.role === 'civilian')!.id;
    vote(s, (r) => (r.targets.includes(victim) ? victim : r.targets[0]));
  }
  assert.equal(s.winner, 'undercover');
  assert.ok(s.seats.find((p) => p.id === spy)!.alive);
});

test('a voted-out blank guesses the civilian word once: right wins alone, wrong plays on', () => {
  for (const right of [true, false]) {
    const s = create(7, 21, true);
    const blank = roleOf(s, 'blank')[0];
    describeAll(s);
    vote(s, (r) => (r.seatId === blank ? r.targets[0] : blank));
    assert.equal(s.phase, 'resolution');
    assert.deepEqual(
      s.requests.map((r) => [r.seatId, r.kind]),
      [[blank, 'blank_guess']],
    );
    const v = viewUndercover(s, blank);
    assert.equal(v.words?.own, undefined, 'the blank still has no word to read');
    acceptUndercover(s, s.requests[0].id, { text: right ? ` ${s.words.civilian}！` : '咖啡' });
    if (right) assert.equal(s.winner, 'blank');
    else {
      assert.equal(s.winner, undefined);
      assert.equal(s.day, 2);
      assert.equal(s.phase, 'speech');
    }
    assert.ok(s.events?.some((e) => e.type === 'blank_guess' && e.correct === right));
  }
});

test('random legal play always ends, and the same seed with the same answers replays exactly', () => {
  for (let k = 0; k < 200; k++) {
    const n = 4 + (k % 7);
    const run = () => {
      const s = create(n, 1000 + k, n >= 7 && k % 2 === 0);
      const pick = seededRandom(k);
      let steps = 0;
      while (s.status === 'running') {
        assert.ok(s.requests.length, 'a running match always waits for someone');
        assert.ok(++steps < 2000);
        const r = s.requests[pick.int(s.requests.length)];
        const action: GameAction =
          r.kind === 'describe'
            ? { text: '一个常见的东西' }
            : r.kind === 'blank_guess'
              ? { text: pick.int(2) ? s.words.civilian : '不知道' }
              : pick.int(5)
                ? { target: r.targets[pick.int(r.targets.length)] }
                : { skip: true };
        acceptUndercover(s, r.id, action);
      }
      return s;
    };
    const first = run(),
      second = run();
    assert.ok(['civilian', 'undercover', 'blank'].includes(first.winner!) || first.error, `match ${k} ended`);
    const strip = (s: UndercoverState) =>
      JSON.stringify({ ...s, id: '', requests: [], accepted: [], logs: s.logs.map(({ time: _, ...l }) => l) });
    assert.equal(strip(first), strip(second), 'replay');
  }
});

test('the finished match reaches the persona module as plain facts', () => {
  const s = create(5, 2);
  s.seats.forEach((p, i) => (p.botId = 'B' + i));
  const spy = roleOf(s, 'undercover')[0];
  describeAll(s);
  vote(s, (r) => (r.seatId === spy ? r.targets[0] : spy));
  const facts = undercoverFacts(s);
  assert.equal(facts.game, '谁是卧底');
  assert.deepEqual(facts.winners, ['civilian']);
  assert.ok(facts.seats.every((p) => p.team === s.seats.find((x) => x.id === p.id)!.role));
  const settled = settleMatch(facts)!;
  assert.match(settled.recap, /^谁是卧底战报：平民获胜。/);
  assert.ok(settled.recap.includes(`词：平民「${s.words.civilian}」，卧底「${s.words.undercover}」。`));
  assert.ok(
    settled.affinity.every((a) => a.source.endsWith('won_together')),
    'civilians who won together',
  );
  assert.equal(settled.affinity.length, 4 * 3);
});

test("the runtime plays Who's the Spy with model seats, settles it and keeps observations", async (t) => {
  const dir = tempDir(t);
  const persona = inTempDir(t, (dir) => new PersonaService(dir));
  persona.applyPreset('bot0', 'queshi');
  const inputs: string[] = [];
  const decide: Decide = async (_player, context, request, _signal, options) => {
    // As the real providers do: report the exact input this seat was sent.
    const input = undercoverPrompt(context, request);
    inputs.push(JSON.stringify(input));
    options?.onRequest?.({ input, instruction: '', config: { model: 'test' } });
    if (request.kind === 'describe') return { text: '一个常见的东西', note: '先说得含糊一点。' };
    if (request.kind === 'blank_guess') return { text: '不知道' };
    return { target: request.targets[0], note: '投给第一个可选的人。' };
  };
  let finished: AnyMatch | undefined;
  const runtime = new GameRuntime(dir, decide, () => {}, undefined, {
    personas: (bots, members) => persona.seeds(bots, members),
    finished: (match) => {
      finished = match;
    },
  });
  t.after(() => runtime.dispose());
  const seats = players(6).map((p, i) => ({ ...p, ...(i < 3 ? { botId: 'bot' + i } : {}) }));
  const created = runtime.create({ groupId: 'g', mode: 'undercover', players: seats });
  assert.equal(created.mode, 'undercover');
  await until(() => !!finished, { timeoutMs: 30000 });
  const match = finished as UndercoverState;
  assert.equal(match.mode, 'undercover');
  assert.ok(match.winner);
  assert.equal(Object.keys(match.persona || {}).length, 3, 'every member Bot plays with its persona');
  assert.ok(Object.values(match.persona!).every((p) => ['直白描述', '含糊描述'].includes(p.plan!.name)));
  const queshi = Object.values(match.persona!).find((p) => p.botId === 'bot0')!;
  assert.match(queshi.voice!, /口头禅：「确实」/, "a preset's voice travels with its seat");
  assert.match(queshi.voice!, /大约每 1 次发言用一次/);
  assert.ok(
    inputs.some((i) => i.includes('voice') && i.includes('口头禅：「确实」')),
    "and reaches that seat's prompt",
  );
  assert.equal(Object.values(match.persona!).filter((p) => p.voice).length, 1, 'Bots without contents have no voice');
  const report = runtime.read('g')!;
  assert.equal(report.status, 'finished');
  assert.ok(report.words?.civilian && report.words.undercover, 'the words are revealed at the end');
  const observations = collectGrowthObservations(match);
  assert.ok(observations.length > 0);
  assert.ok(observations.every((o) => o.role.startsWith('undercover:')));
  const posted: string[] = [];
  settleFinishedGame(match, persona, { postGameResult: (_group, report) => void posted.push(report) });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /^谁是卧底战报：/);
  assert.ok(persona.store.recentHighlights('bot0').some((h) => h.summary.startsWith('一局谁是卧底：')));
  assert.equal(
    persona.view('bot0').profile.lastPlans?.['undercover:player'],
    match.persona![match.seats[0].id].plan!.id,
  );
});

test('the model input keeps the shape the run record reads: round as day, own word, no role', () => {
  const s = create(6, 13);
  const r = s.requests[0];
  const input = JSON.parse(undercoverPrompt(viewUndercover(s, r.seatId), r));
  assert.equal(input.you, r.seatId);
  assert.equal(input.context.shared.day, 1);
  assert.equal(input.context.personal.self.word, ownWord(s, r.seatId));
  assert.equal(input.context.personal.self.role, undefined);
  assert.equal(input.request.kind, 'describe');
});

test('a preset chosen for one match plays for that match only, for member Bots and guests alike', async (t) => {
  const dir = tempDir(t);
  const persona = inTempDir(t, (dir) => new PersonaService(dir));
  persona.setTraits('bot0', { E: 0.5, A: 0.5, C: 0.5, N: 0.5, O: 0.5 });
  const before = persona.view('bot0').profile;
  const inputs: string[] = [];
  const decide: Decide = async (_player, context, request) => {
    inputs.push(JSON.stringify(undercoverPrompt(context, request)));
    if (request.kind === 'describe') return { text: '一个常见的东西' };
    if (request.kind === 'blank_guess') return { text: '不知道' };
    return { target: request.targets[0] };
  };
  let finished: AnyMatch | undefined;
  const runtime = new GameRuntime(dir, decide, () => {}, undefined, {
    personas: (bots, members) => persona.seeds(bots, members),
    finished: (match) => {
      finished = match;
    },
  });
  t.after(() => runtime.dispose());
  const seats = players(6).map((p, i) => ({
    ...p,
    ...(i === 0 ? { botId: 'bot0', preset: 'npd' } : {}),
    ...(i === 1 ? { preset: 'catgirl' } : {}),
    ...(i === 2 ? { preset: 'not-a-preset' } : {}),
  }));
  runtime.create({ groupId: 'g', mode: 'undercover', players: seats });
  await until(() => !!finished, { timeoutMs: 30000 });
  const match = finished as UndercoverState;
  const member = Object.values(match.persona!).find((p) => p.botId === 'bot0')!;
  assert.equal(member.preset, 'npd');
  assert.deepEqual(member.traits, PRESETS.npd.traits, 'the member plays the preset, not its profile');
  assert.match(member.voice!, /这对我来说太简单了/);
  const guest = match.seats.find((p) => p.name === seats[1].name)!;
  assert.match(guest.personality!, /喵～/, 'a guest plays the preset through its game personality');
  assert.equal(match.seats.find((p) => p.name === seats[2].name)!.preset, undefined, 'unknown presets are dropped');
  assert.ok(inputs.some((i) => i.includes('喵～')));
  persona.settle(undercoverFacts(match));
  assert.deepEqual(persona.view('bot0').profile.traits, before.traits, "the member's own profile is untouched");
  assert.equal(collectGrowthObservations(match).length, 0, 'nothing from a borrowed personality is learned');
});
