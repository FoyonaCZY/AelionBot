import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, until } from './helpers';
import { PersonaService } from '../electron/core/persona/persona-service';
import { appraisalModifier, grudgeFactor, parseAppraisal } from '../electron/core/persona/appraisal';
import { appraiser, groupSocialHooks } from '../electron/core/persona/group-relations';
import { NEUTRAL } from '../shared/persona/persona-model';

const DAY = 86_400_000;
function service(t: test.TestContext, now = () => 1_000 * DAY) {
  const svc = new PersonaService(tempDir(t), now);
  t.after(() => svc.close());
  return svc;
}
const event = (over: Record<string, unknown> = {}) => ({
  botId: 'A',
  actorId: 'user',
  actorName: '你',
  appraisal: { type: 'insult' as const, intensity: 1 },
  quote: '你怎么这么笨',
  groupId: 'g',
  sourceId: 'm1',
  ...over,
});

test('grudges last longer for disagreeable, touchy Bots, and intent scales the hit', () => {
  const easy = { ...NEUTRAL, A: 0.9, N: 0.1 },
    prickly = { ...NEUTRAL, A: 0.1, N: 0.9 };
  assert.ok(grudgeFactor(prickly) > grudgeFactor(easy));
  assert.equal(grudgeFactor(prickly), 1.4);
  assert.equal(grudgeFactor(easy), 0.6);
  const full = appraisalModifier({ type: 'insult', intensity: 1 }, prickly)!,
    mild = appraisalModifier({ type: 'insult', intensity: 0 }, prickly);
  assert.deepEqual(full, { value: -0.5, durationDays: 84 });
  assert.equal(mild, undefined, 'no intensity, no change');
  assert.equal(appraisalModifier({ type: 'insult', intensity: 0.2 }, prickly)!.value, -0.3);
  assert.equal(appraisalModifier({ type: 'none', intensity: 1 }, prickly), undefined);
  assert.equal(
    appraisalModifier({ type: 'thanks', intensity: 1 }, prickly)!.durationDays,
    14,
    'goodwill does not stretch',
  );
});

test('a model reply is read defensively', () => {
  assert.deepEqual(parseAppraisal('```json\n{"type":"offense","intent":1,"severity":0.5}\n```'), {
    type: 'offense',
    intensity: 0.5,
  });
  assert.equal(parseAppraisal('{"type":"weird"}').type, 'none');
});

test('an insult hurts and is remembered with the words; the same kind counts once a day', (t) => {
  const svc = service(t);
  assert.ok(svc.appraise(event()));
  assert.ok(svc.affinity('A', 'user') < -0.5, 'an insult hurts, amplified by neuroticism');
  assert.equal(svc.appraise(event({ sourceId: 'm2' })), undefined, 'a second insult the same day adds nothing');
  const memory = svc.store.recentHighlights('A')[0];
  assert.equal(
    memory.summary,
    '用户骂了你：「你怎么这么笨」',
    "an unnamed human is not 「你」 in the Bot's own memory",
  );
  assert.match(svc.groupFragment('A', [{ id: 'user', name: '你' }]), /关系(很差|有芥蒂)/);
  assert.equal(svc.appraise(event({ botId: 'user', actorId: 'user' })), undefined, 'nobody appraises itself');
});

test('a new offence while a grudge runs extends it once; an apology halves what is left', (t) => {
  let now = 1_000 * DAY;
  const svc = service(t, () => now);
  // Mild events, so the relationship stays above the −1 floor and the apology's effect is visible.
  svc.appraise(event({ appraisal: { type: 'insult', intensity: 0.2 } }));
  const [first] = svc.store.affinity('A', 'user');
  now += DAY;
  svc.appraise(event({ appraisal: { type: 'offense', intensity: 0.2 }, sourceId: 'm2' }));
  const extended = svc.store.affinity('A', 'user').find((m) => m.id === first.id)!;
  assert.equal(extended.durationDays, first.durationDays * 1.5, 'rumination keeps the old grudge alive');
  assert.match(extended.source, /:ruminated$/);
  now += DAY;
  svc.appraise(event({ appraisal: { type: 'offense', intensity: 0.2 }, sourceId: 'm3' }));
  assert.equal(
    svc.store.affinity('A', 'user').find((m) => m.id === first.id)!.durationDays,
    extended.durationDays,
    'a grudge is extended at most once',
  );
  const before = svc.affinity('A', 'user');
  now += DAY;
  svc.appraise(event({ appraisal: { type: 'apology', intensity: 1 }, quote: '刚才说重了，抱歉', sourceId: 'm4' }));
  const after = svc.store.affinity('A', 'user').find((m) => m.id === first.id)!;
  const left = (m: { createdAt: number; durationDays: number }) => m.createdAt + m.durationDays * DAY - now;
  assert.ok(Math.abs(left(after) - left(extended) / 2) < 1000, 'the apology halved the time left');
  assert.ok(svc.affinity('A', 'user') > before, 'and the relationship warmed');
});

test('group hooks classify each aimed-at Bot in order and give new members a profile', async (t) => {
  const svc = service(t);
  const seen: string[] = [];
  const hooks = groupSocialHooks(
    svc,
    (ids) => ids.map((id) => ({ id, name: id, soul: '直率的工程师' })),
    async (botId, input) => {
      seen.push(`${botId}:${input.message}`);
      return { type: input.message.includes('笨') ? 'insult' : 'thanks', intensity: 1 };
    },
    async () =>
      JSON.stringify(
        Object.fromEntries(['E', 'A', 'C', 'N', 'O'].flatMap((t) => [1, 2, 3].map((i) => [`${t}${i}`, 4]))),
      ),
  );
  hooks.aimed!({
    groupId: 'g',
    messageId: 'm1',
    sender: { id: 'user', name: '你' },
    targets: [
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
    ],
    text: '你们俩真笨',
  });
  await until(() => svc.store.affinity('B', 'user').length > 0);
  assert.deepEqual(seen, ['A:你们俩真笨', 'B:你们俩真笨']);
  hooks.joined!(['C']);
  await until(() => svc.store.profile('C')?.source === 'bfi2');
  const c = svc.store.profile('C')!;
  assert.equal(c.confirmed, false, 'the estimate waits for the user');
  assert.equal(Object.keys(c.facets!).length, 15, 'facets are kept, not averaged away');
  assert.equal(c.traits.E, 0.75);
});

test("without Laya the aimed-at Bot's own model classifies; Laya answers when it is ready", async () => {
  const asked: string[] = [];
  const viaModel = appraiser(undefined, async (botId) => {
    asked.push(botId);
    return '{"type":"help","intent":1,"severity":1}';
  });
  assert.deepEqual(await viaModel('A', { target: 'A', sender: '你', message: '我帮你改好了' }), {
    type: 'help',
    intensity: 1,
  });
  assert.deepEqual(asked, ['A']);
  const viaLaya = appraiser(
    {
      enabled: true,
      isReady: true,
      predict: async () => ({ choice: 'apology', confidence: 0.8, model: 'laya', runtime: 'mlx', elapsedMs: 1 }),
    },
    async () => {
      throw Error('the main model must not be asked');
    },
  );
  assert.deepEqual(await viaLaya('A', { target: 'A', sender: '你', message: '抱歉' }), {
    type: 'apology',
    intensity: 0.8,
  });
});
