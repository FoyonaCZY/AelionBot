import test from 'node:test';
import assert from 'node:assert/strict';
import { inTempDir, until } from './helpers';
import { PersonaService } from '../electron/core/persona/persona-service';
import { groupSocialHooks, judger } from '../electron/core/persona/group-relations';
import { bondOf, grudgeConduct, relationsText } from '../electron/core/persona/relations';
import { parseVerdict, speechPlan, usedCatchphrase } from '../electron/core/persona/speech';
import { PRESETS, contentText } from '../shared/persona/presets';
import { NEUTRAL } from '../shared/persona/persona-model';

const DAY = 86_400_000;
function service(t: test.TestContext, now = () => 1_000 * DAY, random = () => 0.5) {
  return inTempDir(t, (dir) => new PersonaService(dir, now, random));
}
const insult = (over: Record<string, unknown> = {}) => ({
  botId: 'A',
  actorId: 'B',
  actorName: '小周',
  appraisal: { type: 'insult' as const, intensity: 1 },
  quote: '你真菜',
  groupId: 'g',
  sourceId: 'm1',
  ...over,
});
const members = [
  { id: 'user', name: '何梓鸿' },
  { id: 'A', name: '阿岩' },
  { id: 'B', name: '小周' },
];

test('every member sees all its relationships with the reason, and how to treat someone it resents', (t) => {
  const svc = service(t);
  svc.applyPreset('A', 'yinyang');
  svc.appraise(insult());
  const style = svc.groupStyle('A', undefined, members);
  assert.match(style, /\[你和群里每个人的关系\]/);
  assert.match(
    style,
    /- 何梓鸿：一般，没什么特别的。/,
    'a member with no history is listed too, so the Bot can say so',
  );
  assert.match(style, /- 小周：很差。原因：小周骂了你：「你真菜」。小周还没向你道歉。/);
  assert.match(style, /对还没道歉的小周：用反话和明褒暗贬对待他/, '阴阳怪气 shows a grudge in its own way');
  assert.match(style, /劝和的人面子，但不会因此马上和对方亲近/);
  assert.doesNotMatch(style, /- 阿岩/, 'no line about itself');
  assert.equal(
    svc.view('A').relations.find((r) => r.id === 'B')!.grudge > 0.15,
    true,
    'the page reads the same grudge',
  );
});

test("a third party's urging eases a grudge a little; only the offender's apology changes the attitude", (t) => {
  let now = 1_000 * DAY;
  const svc = service(t, () => now);
  svc.setTraits('A', { ...NEUTRAL, A: 0.2, N: 0.8 });
  svc.appraise(insult({ appraisal: { type: 'insult', intensity: 0.4 } }));
  const hurt = () => svc.store.affinity('A', 'B').find((m) => m.value < 0)!;
  const end = () => hurt().createdAt + hurt().durationDays * DAY;
  const before = end();
  now += DAY;
  svc.appraise(insult({ actorId: 'user', actorName: '何梓鸿', appraisal: { type: 'mediation', intensity: 1 } }));
  const left = before - now,
    eased = end() - now;
  assert.ok(Math.abs(eased - left * (1 - (0.1 + 0.3 * 0.2))) < 1000, 'a disagreeable Bot gives up only 16% of it');
  assert.ok(svc.bond('A', 'B').grudge >= 0.15, 'urging alone does not end it');
  assert.match(svc.groupStyle('A', undefined, members), /小周还没向你道歉/);
  now += DAY;
  svc.appraise(insult({ appraisal: { type: 'apology', intensity: 1 }, sourceId: 'm3' }));
  assert.equal(svc.bond('A', 'B').apologized, true);
  assert.match(svc.groupStyle('A', undefined, members), /小周已经向你道过歉，你在慢慢缓和/);
});

test('grudge and closeness are kept apart, and each personality shows a grudge its own way', () => {
  const now = 100 * DAY;
  const mod = (value: number, source: string, at = now) => ({
    id: source,
    botId: 'A',
    targetId: 'B',
    value,
    createdAt: at,
    durationDays: 30,
    source,
  });
  const bond = bondOf([mod(0.6, 'match:x:won'), mod(-0.2, 'chat:insult:m1')], now, 0.5);
  assert.deepEqual([bond.closeness, Math.round(bond.grudge * 100) / 100, bond.apologized], [0.6, 0.3, false]);
  assert.equal(
    bondOf([mod(-0.2, 'chat:insult:m1', now - DAY), mod(0.2, 'chat:apology:m2')], now, 0.5).apologized,
    true,
  );
  assert.match(grudgeConduct(PRESETS.npd, PRESETS.npd.traits), /怼回去/);
  assert.match(grudgeConduct(PRESETS.queshi, PRESETS.queshi.traits), /冷处理/);
  assert.match(grudgeConduct({}, { ...NEUTRAL, A: 0.8 }), /表面客气/);
  assert.equal(relationsText([], '…'), '');
});

test('the speech plan paces catchphrases to the preset rate and rotates them', () => {
  const queshi = { ...PRESETS.queshi, preset: 'queshi' as const };
  assert.match(
    speechPlan(queshi, { used: ['确实', '确实', ''] }, () => 0.5),
    /要用口头禅「没错」/,
  );
  assert.match(
    speechPlan(queshi, { used: Array(6).fill('确实') }, () => 0.5),
    /不用口头禅/,
    'not literally every time',
  );
  const npd = { ...PRESETS.npd, preset: 'npd' as const };
  assert.match(
    speechPlan(npd, { used: ['你们不懂', '要不是我', ''] }, () => 0.5),
    /不用口头禅/,
    '2 in 3 is over 0.4',
  );
  assert.match(
    speechPlan(npd, { used: ['', '', '你们不懂', ''] }, () => 0.5),
    /要用口头禅「这对我来说太简单了」/,
  );
  assert.match(
    speechPlan(npd, { used: [] }, () => 0.9),
    /优先用「反驳观点」/,
    'strategies are sampled by weight',
  );
  assert.match(
    speechPlan(npd, { used: [] }, () => 0),
    /优先用「炫耀自己」/,
  );
  assert.equal(
    speechPlan({}, { used: [] }, () => 0),
    '',
    'a Bot without contents gets no plan',
  );
  assert.equal(usedCatchphrase(queshi, '确实确实，没毛病'), '确实确实');
  assert.equal(usedCatchphrase(queshi, '好的'), '');
});

test('preset text reads as concrete behaviour with a few lines of voice', () => {
  const text = contentText({ ...PRESETS.queshi, preset: 'queshi' }, () => undefined);
  assert.match(text, /具体做法：\n- 不管别人说什么，你通常先回「确实」/);
  assert.match(text, /你说话的样子（只学语气和习惯，不照抄内容）：\n- 别人：这个 bug 太离谱了\n {2}你：确实。/);
  // A profile saved before conduct existed still gets it from its preset.
  const { conduct: _c, examples: _e, ...saved } = PRESETS.npd;
  assert.match(
    contentText({ ...saved, preset: 'npd' }, () => undefined),
    /被人批评或纠正时，你从不认错/,
  );
});

test('only key turns are checked, after publication; a failed check leaves one reminder for the next turn', async (t) => {
  const svc = service(
    t,
    () => 1_000 * DAY,
    () => 0.5,
  );
  svc.applyPreset('A', 'npd');
  svc.setTraits('C', NEUTRAL);
  const people = [{ id: 'B', name: '小周' }];
  assert.equal(svc.spoke('C', '好的', people), undefined, 'an ordinary turn of an ordinary Bot is not checked');
  for (let i = 1; i < 5; i++) assert.equal(svc.spoke('A', '这对我来说太简单了', people), undefined);
  assert.ok(svc.spoke('A', '你们不懂', people), 'every fifth turn of a preset is checked for its voice');
  svc.appraise(insult());
  const input = svc.spoke('A', '好啦好啦，小周你说得对', people)!;
  assert.match(input.relations, /小周：很差/, 'someone it resents is in the conversation');
  assert.equal(input.speaker, 'NPD');

  const judged: string[] = [];
  const hooks = groupSocialHooks(
    svc,
    () => [],
    async () => undefined,
    async () => '',
    () => {},
    async (botId, check) => {
      judged.push(`${botId}:${check.reply}`);
      return 'too_friendly';
    },
  );
  hooks.spoke!({ groupId: 'g', messageId: 'r1', botId: 'A', text: '小周你说得都对', people });
  await until(() => judged.length === 1);
  assert.doesNotMatch(svc.groupFragment('A', people, 'other'), /提醒/, 'a reminder stays in its own group');
  await until(() => svc.groupFragment('A', people, 'g').includes('提醒'));
  assert.doesNotMatch(svc.groupFragment('A', people, 'g'), /提醒/, 'a reminder is shown once');
  svc.judged('A', 'too_friendly', people, 'g');
  svc.judged('A', 'ok', people, 'g');
  assert.doesNotMatch(svc.groupFragment('A', people, 'g'), /提醒/, 'a later good turn clears it');
});

test("the check uses Laya when it is ready, otherwise the Bot's own model, and reads replies defensively", async () => {
  const input = { speaker: 'NPD', persona: '…', relations: '…', reply: '好的' };
  const laya = {
    enabled: true,
    isReady: true,
    predict: async () => ({ choice: 'out_of_voice', confidence: 0.9 }),
  };
  assert.equal(await judger(laya as never, async () => '')('A', input), 'out_of_voice');
  assert.equal(
    await judger(undefined, async () => '```json\n{"verdict":"too_friendly"}\n```')('A', input),
    'too_friendly',
  );
  assert.equal(parseVerdict(''), undefined, 'a reply cut off before its answer changes nothing');
  assert.equal(parseVerdict('not json'), undefined);
  assert.equal(parseVerdict('{"verdict":"weird"}'), undefined);
});

test('妈咪 and 猫娘 regard their focus their own way and show a grudge in character', () => {
  const name = () => '何梓鸿';
  assert.match(contentText({ ...PRESETS.mom, preset: 'mom' }, name), /何梓鸿是你最宠的孩子：你总是温柔地哄何梓鸿/);
  assert.match(contentText({ ...PRESETS.catgirl, preset: 'catgirl' }, name), /何梓鸿是你的主人/);
  assert.doesNotMatch(contentText({ ...PRESETS.catgirl, preset: 'catgirl' }, name), /\{name\}/);
  assert.match(contentText({ ...PRESETS.simp, preset: 'simp' }, name), /心思几乎全在何梓鸿身上/, '舔狗 keeps its line');
  assert.match(grudgeConduct({ ...PRESETS.mom, preset: 'mom' }, PRESETS.mom.traits), /妈咪有点失望哦/);
  assert.match(grudgeConduct({ ...PRESETS.catgirl, preset: 'catgirl' }, PRESETS.catgirl.traits), /炸毛/);
  assert.match(
    speechPlan({ ...PRESETS.catgirl, preset: 'catgirl' }, { used: [] }, () => 0),
    /口头禅「喵～」/,
  );
});

test('the page lists a relationship whose good and bad cancel out, since the grudge is still felt', (t) => {
  const svc = service(t);
  svc.store.addAffinity({
    botId: 'A',
    targetId: 'B',
    value: 0.45,
    durationDays: 30,
    createdAt: 1_000 * DAY,
    source: 'x',
  });
  svc.appraise(insult({ appraisal: { type: 'insult', intensity: 0.2 } }));
  const relation = svc.view('A').relations.find((r) => r.id === 'B');
  assert.ok(relation && relation.grudge >= 0.15, 'listed even with a net affinity near zero');
});

test('a Bot without a preset is never told to return to catchphrases it does not have', (t) => {
  const svc = service(t);
  svc.setTraits('C', NEUTRAL);
  svc.judged('C', 'out_of_voice', [], 'g');
  assert.doesNotMatch(svc.groupFragment('C', [], 'g'), /口头禅/);
  svc.applyPreset('A', 'queshi');
  svc.judged('A', 'out_of_voice', [], 'g');
  assert.match(svc.groupFragment('A', [], 'g'), /回到你的说话方式和口头禅/);
});
