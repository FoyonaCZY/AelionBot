import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NEUTRAL } from '../shared/persona/persona-model';
import {
  parseCandidateSemantic,
  semanticEvidenceMatches,
  type CandidateSemantic,
} from '../shared/persona/persona-assessment';
import { personaPick } from '../electron/core/games/persona-play';
import { createWerewolf, validateAction, view } from '../electron/core/games/werewolf';
import { gameInstructions, parseGameAction } from '../electron/core/games/model-player';
import { GameRuntime } from '../electron/core/games/runtime';
import { until } from './helpers';
import type { GameAction, GameRequest } from '../shared/types/game-types';

function fixture(kind: GameRequest['kind'] = 'vote') {
  const s = createWerewolf(
    'g',
    Array.from({ length: 7 }, (_, i) => ({ id: 's' + i, name: 'P' + i, human: false, color: '#888', botId: 'b' + i })),
    ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
    undefined,
    24,
  );
  s.phase = 'vote';
  const r: GameRequest = { id: 'decision', seatId: 's0', kind, targets: ['s1', 's4'] };
  s.requests = [r];
  s.persona = { s0: { botId: 'b0', mbti: 'ENTJ', traits: { ...NEUTRAL, E: 0.9 }, affinity: { s1: -0.7 } } };
  const input = JSON.stringify({
    you: 's0',
    request: r,
    context: {
      shared: { logs: [{ id: 1, text: '5号发言很稳，我在保护5号，不是指控5号。' }] },
      personal: { logs: [{ id: 1, text: '队友明确同意必要时投我，按商量好的战术做。' }] },
    },
  });
  const semantic = (fit: -1 | 0 | 1): CandidateSemantic => ({
    version: 1,
    status: 'supported',
    fit,
    summary: fit === 1 ? '按队内已讨论的战术配合，不推断背叛或报复。' : '此选项与主动配合的设定有冲突。',
    evidence: [{ source: 'personal_log', id: 1, quote: '队友明确同意必要时投我' }],
  });
  const action: GameAction = {
    target: 's4',
    note: '原首选说明',
    candidates: [
      { target: 's4', reasonable: true, semantic: semantic(-1) },
      { target: 's1', reasonable: true, semantic: semantic(1) },
    ],
  };
  const valid = (a: GameAction) => {
    try {
      validateAction(s, r, a);
      return true;
    } catch {
      return false;
    }
  };
  return { s, r, input, semantic, action, valid };
}

test('semantic parser keeps optional advice bounded and never converts uncertainty into a score', () => {
  const { semantic } = fixture();
  assert.deepEqual(parseCandidateSemantic(semantic(1)), semantic(1));
  for (const bad of [
    { ...semantic(1), fit: 2 },
    { ...semantic(1), fit: NaN },
    { ...semantic(1), extra: 'unsafe' },
    { ...semantic(1), evidence: [] },
    { ...semantic(1), status: 'uncertain' },
    { ...semantic(1), status: ['uncertain'], fit: undefined, evidence: [] },
    { ...semantic(1), evidence: [{ source: ['personal_log'], id: 1, quote: 'a' }] },
    { ...semantic(1), evidence: [{ source: 'personal_log', id: 0, quote: 'a' }] },
  ])
    assert.equal(parseCandidateSemantic(bad), undefined);
  assert.ok(parseCandidateSemantic({ version: 1, status: 'uncertain', summary: '没有足够证据', evidence: [] }));
});

test('supported semantics can select a legal reasonable alternative and keep the actual-action explanation', () => {
  const { s, r, input, action, valid } = fixture();
  const twin = structuredClone(s),
    seen = new Set<string>();
  const first = personaPick(s, r, action, valid, input),
    again = personaPick(twin, r, action, valid, input);
  assert.deepEqual(first, again, 'same seed and captured reply replay identically');
  for (let i = 0; i < 120; i++) {
    const picked = personaPick(s, r, action, valid, input);
    seen.add(picked.action.target!);
    assert.ok(['s1', 's4'].includes(picked.action.target!));
    assert.equal(picked.decision?.gateReason, 'weak');
    assert.equal(picked.decision?.growthDisposition, 'record_only');
    assert.deepEqual(picked.decision?.features, {}, 'no count/teammate/affinity heuristic feeds old growth');
    if (picked.decision?.overridden) assert.equal(picked.action.note, action.candidates![1].semantic!.summary);
  }
  assert.deepEqual([...seen].sort(), ['s1', 's4']);
});

test('missing, uncertain, conflicting, indistinguishable or fabricated advice keeps the model first pick', () => {
  const { s, r, input, action, valid } = fixture();
  const expect = (a: GameAction, gate: string, captured: string | undefined = input) => {
    const result = personaPick(s, r, a, valid, captured);
    assert.equal(result.action.target, 's4');
    assert.equal(result.decision?.gateReason, gate);
    assert.equal(result.decision?.overridden, false);
  };
  const missing = structuredClone(action);
  delete missing.candidates![0].semantic;
  expect(missing, 'semantic_missing');
  const uncertain = structuredClone(action);
  uncertain.candidates![1].semantic = { version: 1, status: 'uncertain', summary: '无法归因', evidence: [] };
  expect(uncertain, 'semantic_uncertain');
  const same = structuredClone(action);
  same.candidates![1].semantic!.fit = -1;
  expect(same, 'semantic_indistinguishable');
  const fabricated = structuredClone(action);
  fabricated.candidates![1].semantic!.evidence[0].quote = '未来揭晓5号是狼';
  expect(fabricated, 'semantic_evidence_invalid');
  const conflict = structuredClone(action);
  conflict.candidates!.push({ ...conflict.candidates![0], reasonable: false });
  expect(conflict, 'semantic_conflict');
  const decisive = structuredClone(action);
  decisive.candidates![0].decisive = true;
  expect(decisive, 'model_decisive');
  expect(action, 'semantic_evidence_invalid', '');
  const illegal = structuredClone(action);
  illegal.candidates![1].target = 'missing';
  expect(illegal, 'single_candidate');
});

test('evidence references are source-scoped and tied to the dispatched input, never later state', () => {
  const { s, r, input, action, valid, semantic } = fixture();
  assert.equal(semanticEvidenceMatches(semantic(1), input, 's0', 'vote'), true);
  assert.equal(semanticEvidenceMatches(semantic(1), input, 's1', 'vote'), false);
  const crossed = semantic(1);
  crossed.evidence[0].source = 'shared_log';
  assert.equal(semanticEvidenceMatches(crossed, input, 's0', 'vote'), false);
  s.logs.push({ id: 900, day: 1, phase: 'vote', text: '稍后才到达的私有证据', audience: ['s0'] });
  action.candidates![1].semantic!.evidence[0].quote = '稍后才到达的私有证据';
  assert.equal(personaPick(s, r, action, valid, input).decision?.gateReason, 'semantic_evidence_invalid');
});

test('sheriff choices must be explicitly reasonable and optional malformed metadata cannot fail the main action', () => {
  const { s, r, input, semantic } = fixture('sheriff_join');
  const own = personaPick(s, r, { choice: true }, () => true, input);
  assert.equal(own.decision?.options, 1, 'never synthesize the opposite boolean');
  const parsed = parseGameAction(
    JSON.stringify({
      choice: false,
      candidates: [
        { choice: false, reasonable: true, semantic: semantic(-1) },
        { choice: true, reasonable: true, semantic: semantic(1) },
        { choice: false, target: 's1', reasonable: true },
        { choice: 'true', reasonable: true },
      ],
    }),
    'sheriff_join',
    r,
  );
  assert.equal(parsed.candidates?.length, 2);
  assert.equal(parsed.candidates?.[0].choice, false);
  const bad = parseGameAction(
    JSON.stringify({ choice: false, candidates: [{ choice: false, reasonable: true, semantic: { bad: 'shape' } }] }),
    'sheriff_join',
    r,
  );
  assert.equal(bad.choice, false);
  assert.equal(bad.candidates?.[0].semantic, undefined);
  assert.match(gameInstructions(view(s, r.seatId), r), /顶层 candidates/);
});

test('resuming an old unfinished game enables semantic growth rules', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-semantic-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { s } = fixture();
  s.status = 'paused';
  delete s.personaPolicy;
  writeFileSync(join(dir, 'matches.json'), JSON.stringify([s]));
  const runtime = new GameRuntime(dir, async () => ({ target: 's1' }));
  t.after(() => runtime.dispose());
  runtime.control(s.id, 'resume');
  await until(() => runtime.read('g')!.revision! > 0, { timeoutMs: 1000, intervalMs: 5 });
  runtime.control(s.id, 'stop');
  const saved = JSON.parse(readFileSync(join(dir, 'matches.json'), 'utf8'))[0];
  assert.equal(saved.personaPolicy, 'model_semantic_v1');
});

test('runtime semantic validation uses onRequest input from the successful attempt, not regenerated or later context', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-semantic-dispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { s, action, input } = fixture();
  s.status = 'paused';
  writeFileSync(join(dir, 'matches.json'), JSON.stringify([s]));
  const readDecision = (): import('../electron/core/games/persona-play').PersonaDecision | undefined =>
    JSON.parse(readFileSync(join(dir, 'matches.json'), 'utf8'))[0].decisions?.find(
      (d: { requestId: string }) => d.requestId === 'decision',
    );
  const runtime = new GameRuntime(
    dir,
    async (_p, _v, r, signal, options) => {
      if (r.id !== 'decision')
        return new Promise<GameAction>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      options?.onRequest?.({
        input,
        instruction: 'Synthetic provider input for evidence boundary test',
        config: { model: 'local-fixture' },
      });
      return action;
    },
    () => {},
    { aiTimeoutMs: 90000 },
  );
  t.after(() => runtime.dispose());
  runtime.control(s.id, 'resume');
  await until(() => !!readDecision(), { timeoutMs: 1000, intervalMs: 5 });
  runtime.control(s.id, 'stop');
  const observed = readDecision();
  assert.equal(
    observed?.gateReason,
    'weak',
    'quoted provider input was not the runtime template, but it really was sent',
  );
  assert.equal(observed?.growthDisposition, 'record_only');
});
