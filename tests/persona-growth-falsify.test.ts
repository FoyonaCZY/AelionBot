import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGrowthObservations } from '../electron/core/persona/growth-observations';
import { createWerewolf, view } from '../electron/core/games/werewolf';
import { gamePrompt } from '../electron/core/games/model-player';
import { PersonaService } from '../electron/core/persona/persona-service';
import { TRAITS, NEUTRAL } from '../shared/persona/persona-model';
import { parseGrowthAssessment } from '../shared/persona/growth-review';
import { Store } from '../electron/core/storage/store';
import { ModelProviders } from '../electron/core/model/model-providers';
import { registerModels } from '../electron/ipc/register-models';
import type { IpcContext } from '../electron/ipc/context';
import type { GrowthAssessment, GrowthObservation } from '../shared/types/persona-growth-types';

const DAY = 86_400_000;
const settleAsync = () => new Promise<void>((resolve) => setImmediate(resolve));
function batch(prefix: string, at: number): GrowthObservation[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `${prefix}-o${i}`,
    botId: 'bot',
    matchId: `${prefix}-m${Math.floor(i / 2)}`,
    createdAt: at + i,
    role: i < 2 ? 'wolf' : 'villager',
    kind: 'speak',
    day: 1,
    behavior: JSON.stringify({ text: `观察${i}：我愿意先听完不同意见，再主动总结讨论。` }),
    text: '真实的公开发言上下文。',
  }));
}
function answer(obs: GrowthObservation[], direction: -1 | 0 | 1 = 1): string {
  return JSON.stringify({
    version: 1,
    summary: '观察到跨经历的表达变化。',
    traits: Object.fromEntries(
      TRAITS.map((k) => [
        k,
        {
          attribution: k === 'E' && direction !== 0 ? 'trait' : 'stable',
          direction: k === 'E' ? direction : 0,
          reason: '比较前后阶段的主动表达，并考虑角色限制。',
          evidence:
            k === 'E' && direction !== 0
              ? [0, 2, 4].map((i) => ({
                  observationId: obs[i].id,
                  quote: `观察${i}：我愿意先听完不同意见，再主动总结讨论。`,
                }))
              : [],
          counterEvidence: [],
        },
      ]),
    ),
  });
}
async function setup(run: (svc: PersonaService, clock: { at: number }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'growth-falsify-')),
    clock = { at: DAY * 100 + 1000 };
  const svc = new PersonaService(dir, () => clock.at);
  svc.ensureProfile('bot');
  try {
    await run(svc, clock);
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cross-experience evidence cannot cite JSON field names as actual behavior', () => {
  const obs = batch('keys', 1),
    response = JSON.parse(answer(obs)) as GrowthAssessment;
  for (const e of response.traits.E.evidence) e.quote = 'text';
  assert.throws(
    () => parseGrowthAssessment(JSON.stringify(response), obs),
    'JSON field name text is not an observed behavior',
  );
});

test('resetting displayed history does not refund daily movement from earlier legacy growth', () =>
  setup(async (svc, clock) => {
    svc.store.addEpisode({
      botId: 'bot',
      scope: 'game',
      sourceId: 'legacy-game',
      kind: 'vote',
      summary: '旧版同日成长',
      s: {},
      o: 1,
      delta: { ...NEUTRAL, E: 0.02, A: 0, C: 0, N: 0, O: 0 },
      createdAt: clock.at,
    });
    assert.equal(svc.store.growthMovedSince('bot', clock.at - (clock.at % DAY)).E, 0.02);
    svc.resetGrowth('bot');
    svc.configureGrowthReviewer({
      available: () => true,
      ask: async (_bot, _system, user) => ({ text: answer(JSON.parse(user).observations) }),
    });
    svc.recordGrowthObservations(batch('after-reset', clock.at));
    await settleAsync();
    assert.equal(svc.view('bot').profile.traits.E, 0.5, 'daily E budget was already exhausted before reset');
  }));

test('twenty unchanged reviews do not hide the last still-safe applied review from undo', () =>
  setup(async (svc, clock) => {
    let direction: -1 | 0 | 1 = 1;
    svc.configureGrowthReviewer({
      available: () => true,
      ask: async (_bot, _system, user) => ({ text: answer(JSON.parse(user).observations, direction) }),
    });
    svc.recordGrowthObservations(batch('initial', clock.at));
    await settleAsync();
    const applied = svc.view('bot').growthReview!.canUndoReviewId;
    assert.ok(applied);
    direction = 0;
    for (let i = 0; i < 20; i++) {
      clock.at += DAY + 100;
      svc.recordGrowthObservations(batch('stable-' + i, clock.at));
      await settleAsync();
    }
    assert.equal(svc.view('bot').profile.traits.E, 0.505);
    assert.equal(svc.view('bot').growthReview!.canUndoReviewId, applied);
  }));

test('editing an in-use model catalog while growth is pending cancels the old configuration result', () =>
  setup(async (svc, clock) => {
    const dir = mkdtempSync(join(tmpdir(), 'growth-provider-')),
      store = new Store(dir);
    store.data.bots[0].id = 'bot';
    store.save();
    const providers = new ModelProviders(store, { encrypt: (x) => x, decrypt: (x) => x });
    try {
      const p = providers.save({ name: 'fake provider', baseUrl: 'http://localhost:9999/v1', protocol: 'chat' });
      providers.updateModel(p.id, { id: 'fake-model', contextTokens: 32000, reasoningEffort: 'low' });
      providers.setDefault({ providerId: p.id, model: 'fake-model', contextTokens: 32000 });
      let resolve!: (value: { text: string }) => void,
        input = '',
        beforeCalls = 0;
      svc.configureGrowthReviewer({
        available: () => true,
        ask: async (_bot, _system, user) => {
          input = user;
          return new Promise((r) => {
            resolve = r;
          });
        },
      });
      svc.recordGrowthObservations(batch('old-model', clock.at));
      await settleAsync();
      assert.ok(input);
      const handlers = new Map<string, (...args: any[]) => any>();
      registerModels({
        handle: (key: string, handler: (...args: any[]) => any) => handlers.set(key, handler),
        providers,
        beforeModelChange: (bots: string[]) => {
          beforeCalls++;
          for (const bot of bots) svc.cancelGrowthReview(bot);
        },
        afterModelChange: () => {},
      } as unknown as IpcContext);
      assert.equal(providers.config('bot').reasoningEffort, 'low');
      handlers.get('updateProviderModel')!({
        providerId: p.id,
        model: { id: 'fake-model', contextTokens: 64000, reasoningEffort: 'high' },
      });
      assert.equal(providers.config('bot').reasoningEffort, 'high');
      resolve({ text: answer(JSON.parse(input).observations) });
      await settleAsync();
      assert.equal(
        svc.view('bot').profile.traits.E,
        0.5,
        `old model result applied after config changed; beforeModelChange calls=${beforeCalls}`,
      );
    } finally {
      providers.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test('collected growth evidence preserves role distinctions when a legal player name matches a role', () =>
  setup(async (svc, clock) => {
    const observations: GrowthObservation[] = [];
    svc.configureGrowthReviewer({
      available: () => true,
      ask: async (_bot, _system, user) => {
        const obs: GrowthObservation[] = JSON.parse(user).observations;
        const assessment = JSON.parse(answer(obs));
        assessment.traits.E.evidence = [0, 2, 4].map((i) => ({
          observationId: obs[i].id,
          quote: JSON.parse(obs[i].behavior).text,
        }));
        return { text: JSON.stringify(assessment) };
      },
    });
    for (let m = 0; m < 3; m++) {
      const roles =
        m === 0
          ? (['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'] as const)
          : (['villager', 'wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'] as const);
      const match = createWerewolf(
        'group-long-id',
        Array.from({ length: 7 }, (_, i) => ({
          id: 'seat-' + i,
          name: i === 0 ? 'wolf' : 'name-' + i,
          human: false,
          color: '#aaa',
          botId: i === 0 ? 'bot' : undefined,
        })),
        [...roles],
        undefined,
        m,
      );
      match.personaPolicy = 'model_semantic_v1';
      match.persona = { 'seat-0': { botId: 'bot', traits: { ...NEUTRAL }, mbti: 'ENFJ', affinity: {} } };
      match.trace = [];
      for (let i = 0; i < 2; i++) {
        const request = { id: `r-${m}-${i}`, seatId: 'seat-0', kind: 'speak' as const, targets: [] };
        const input = gamePrompt(view(match, 'seat-0'), request);
        match.trace.push({
          seq: i * 2 + 1,
          time: clock.at + m * 10 + i * 2,
          type: 'model_started',
          day: 1,
          phase: 'speech',
          seatId: 'seat-0',
          requestId: request.id,
          kind: 'speak',
          input,
          requestCaptured: true,
        });
        match.trace.push({
          seq: i * 2 + 2,
          time: clock.at + m * 10 + i * 2 + 1,
          type: 'action_accepted',
          day: 1,
          phase: 'speech',
          seatId: 'seat-0',
          requestId: request.id,
          kind: 'speak',
          action: { text: `观察${m * 2 + i}：我愿意先听完不同意见，再主动总结讨论。` },
        });
      }
      match.status = 'finished';
      match.winner = 'village';
      observations.push(...collectGrowthObservations(match));
    }
    assert.equal(observations.length, 6);
    svc.recordGrowthObservations(observations);
    await settleAsync();
    assert.equal(svc.view('bot').growthReview?.latest?.status, 'applied');
    assert.equal(svc.view('bot').profile.traits.E, 0.505);
    assert.equal(svc.view('bot').growthReview!.latest!.observations.length, 6);
  }));

test('late SOUL estimates cannot overwrite a confirmation, manual change, reset, lock, forgotten profile or model cancellation', async () => {
  const facets = JSON.stringify(Object.fromEntries(TRAITS.flatMap((k) => [1, 2, 3].map((i) => [`${k}${i}`, 5]))));
  const mutations = [
    (svc: PersonaService) => {
      svc.confirm('bot');
    },
    (svc: PersonaService) => {
      svc.setTraits('bot', { E: 0.2, A: 0.3, C: 0.4, N: 0.5, O: 0.6 });
    },
    (svc: PersonaService) => {
      svc.resetGrowth('bot');
    },
    (svc: PersonaService) => {
      svc.setLocked('bot', true);
    },
    (svc: PersonaService) => {
      svc.forget('bot');
    },
    (svc: PersonaService) => {
      svc.cancelGrowthReview('bot');
    },
  ];
  for (const mutate of mutations)
    await setup(async (svc) => {
      let resolve!: (value: string) => void;
      const pending = svc.draft(
        'bot',
        '角色',
        '旧角色设定',
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const rejected = assert.rejects(pending, /人格已改变/);
      mutate(svc);
      const expected = svc.store.profile('bot');
      resolve(facets);
      await rejected;
      assert.deepEqual(svc.store.profile('bot'), expected);
    });
});
