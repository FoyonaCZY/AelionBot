import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaService, type PersonaMatch } from '../electron/core/persona/persona-service';
import { matchExperiences } from '../electron/core/persona/growth';
import { settleMatch } from '../electron/core/persona/settle';
import type { PersonaDecision } from '../electron/core/games/persona-play';
import { NEUTRAL } from '../shared/persona/persona-model';

const zero = { E: 0, A: 0, C: 0, N: 0, O: 0 };
const seats: PersonaMatch['seats'] = [
  { id: 'a', name: '阿甲', human: false, botId: 'A', role: 'wolf' },
  { id: 'b', name: '阿乙', human: false, botId: 'B', role: 'wolf' },
  { id: 'c', name: '阿丙', human: false, botId: 'C', role: 'witch' },
  { id: 'd', name: '阿丁', human: true, role: 'villager' },
];
const decision = (over: Partial<PersonaDecision> = {}): PersonaDecision => ({
  requestId: 'r',
  seatId: 'b',
  kind: 'vote',
  day: 1,
  strong: false,
  options: 2,
  chosen: { target: 'a' },
  subject: 'a',
  features: { cooperate: -1, vengeance: 1 },
  prob: 0.5,
  overridden: false,
  selectionMethod: 'model_semantic_v1',
  growthDisposition: 'record_only',
  ...over,
});
const match = (over: Partial<PersonaMatch> = {}): PersonaMatch => ({
  id: 'semantic-m1',
  groupId: 'g',
  winner: 'village',
  seats,
  events: [{ type: 'exile', day: 1, seatId: 'a', voters: ['b', 'c', 'd'] }],
  decisions: [decision()],
  personaPolicy: 'model_semantic_v1',
  persona: { b: { botId: 'B', traits: { ...NEUTRAL }, mbti: 'ENFJ-T', affinity: {} } },
  ...over,
});
function service(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-semantic-growth-'));
  const svc = new PersonaService(dir, () => Date.UTC(2026, 9, 6));
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

test('semantic experiences remember actual actions and reveals without rewarding inferred motives', () => {
  const experiences = matchExperiences(
    seats,
    [
      decision(),
      decision({ strong: true, requestId: 'strong', seatId: 'c', subject: 'a' }),
      decision({ requestId: 'save', seatId: 'c', kind: 'witch', chosen: { potion: 'save' }, subject: 'b' }),
    ],
    [],
  );
  assert.equal(experiences.length, 3, 'a strong semantic choice is still a factual experience');
  assert.deepEqual(
    experiences.map((e) => e.summary),
    ['投票给 1 号，揭晓是狼人', '投票给 1 号，揭晓是狼人', '救了 2 号，揭晓是狼人'],
  );
  assert.ok(experiences.every((e) => e.growthDisposition === 'record_only' && e.o === 0));
  assert.ok(experiences.every((e) => Object.keys(e.s).length === 0));
});

test('semantic settlement preserves traits away from anchor, learning count, and factual episodes exactly once', (t) => {
  const svc = service(t);
  const p = svc.ensureProfile('B', 'ENTJ');
  const traits = { ...p.traits, E: 0.93, N: 0.812 };
  svc.store.saveProfile({ ...p, traits, n: 7 });
  const beforeHistory = svc.view('B').history;
  assert.ok(svc.settle(match()));
  const first = svc.view('B');
  assert.deepEqual(first.profile.traits, traits, 'zero reward must not trigger the old anchor pull');
  assert.deepEqual(first.profile.anchor, p.anchor);
  assert.equal(first.profile.n, 7, 'record-only facts must not age the legacy learning rate');
  assert.deepEqual(first.history, beforeHistory, 'no trait-history update is fabricated');
  assert.equal(first.episodes.length, 1);
  assert.deepEqual(first.episodes[0].delta, zero);
  assert.equal(first.episodes[0].o, 0);
  assert.match(first.episodes[0].summary, /投票给 1 号，揭晓是狼人/);
  assert.equal(svc.settle(match()), undefined);
  assert.deepEqual(svc.view('B').episodes, first.episodes, 'replaying a finished match does not duplicate facts');
});

test('growth lock still records semantic facts while blocking legacy growth', (t) => {
  const svc = service(t);
  svc.ensureProfile('B');
  const before = svc.setLocked('B', true).profile;
  svc.settle(match());
  const first = svc.view('B');
  assert.equal(first.episodes.length, 1);
  assert.deepEqual(first.profile.traits, before.traits);
  assert.equal(first.profile.n, 0);
  svc.settle(
    match({
      id: 'legacy-locked',
      personaPolicy: undefined,
      decisions: [decision({ selectionMethod: undefined, growthDisposition: undefined })],
    }),
  );
  assert.equal(svc.view('B').episodes.length, 1, 'legacy locked behavior remains unchanged');
});

test('legacy settlement still uses the existing growth rule without retroactively reinterpreting records', (t) => {
  const svc = service(t);
  const before = svc.ensureProfile('B');
  svc.settle(
    match({
      id: 'legacy-m1',
      personaPolicy: undefined,
      decisions: [decision({ selectionMethod: undefined, growthDisposition: undefined })],
    }),
  );
  const after = svc.view('B');
  assert.equal(after.profile.n, 1);
  assert.notDeepEqual(after.profile.traits, before.traits);
  assert.equal(after.episodes[0].o, -1);
  assert.notDeepEqual(after.episodes[0].delta, zero);
});

test('new-policy teammate exile retains a factual memory without an automatic grudge, even without decisions', () => {
  for (const m of [match({ decisions: [] }), match({ personaPolicy: undefined })]) {
    const result = settleMatch(m)!;
    assert.ok(!result.affinity.some((a) => a.source.endsWith('exiled_by_teammate')));
    const memory = result.highlights.find((h) => h.type === 'exiled_by_teammate');
    assert.ok(memory?.participants.includes('B'));
    assert.match(memory!.summary, /被同阵营的 阿乙 投票放逐/);
    assert.doesNotMatch(memory!.summary, /背叛|报复|不合作/);
  }
  const legacy = settleMatch(match({ personaPolicy: undefined, decisions: [] }))!;
  assert.equal(legacy.affinity.find((a) => a.source.endsWith('exiled_by_teammate'))?.value, -0.4);
});

test('new-policy relationship settlement keeps the existing explicit save and shared-win rules', () => {
  const result = settleMatch(match({ events: [{ type: 'save', day: 1, witchId: 'c', seatId: 'b' }] }))!;
  assert.equal(result.affinity.find((a) => a.source.endsWith('saved_by_witch'))?.value, 0.3);
  assert.equal(result.affinity.find((a) => a.source.endsWith('won_together'))?.value, 0.1);
});
