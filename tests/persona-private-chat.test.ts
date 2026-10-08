import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../electron/core/agent/harness';
import { GroupChats } from '../electron/core/group/group-chats';
import { Store } from '../electron/core/storage/store';
import { PersonaService } from '../electron/core/persona/persona-service';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import type { WireMessage } from '../shared/types/core';

const SOUL = '# SOUL.md\nPRIVATE_SOUL_SENTINEL: explain clearly and keep the user’s chosen voice.';
const GROUP_ONLY = '[你的关系与记忆，仅供参考]\nGROUP_PERSONA_SENTINEL: 游戏中的外向性与共同经历。';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona-private-'));
  const store = new Store(dir);
  store.data.model.model = 'test';
  store.data.model.contextTokens = 64000;
  const bot = store.data.bots[0];
  bot.soul = SOUL;
  bot.memories = ['PRIVATE_MEMORY_SENTINEL: the user prefers concise replies.'];
  const requests: WireMessage[][] = [];
  const model = {
    complete: async (messages: WireMessage[]) => {
      requests.push(structuredClone(messages));
      return { content: '已收到。', calls: [], finishReason: 'stop' };
    },
  } as unknown as ModelClient;
  const harness = new Harness(store, {} as VmController, model, () => {});
  const persona = new PersonaService(dir);
  t.after(() => {
    harness.disposeTools();
    persona.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, bot, harness, persona, requests };
}

function assertPrivateRequest(messages: WireMessage[]) {
  assert.ok(messages.some((message) => message.role === 'system' && message.content?.includes(SOUL)));
  assert.doesNotMatch(JSON.stringify(messages), /GROUP_PERSONA_SENTINEL|\[你的关系与记忆，仅供参考\]/);
}

test('a valid group run still receives its group persona context', async (t) => {
  const f = fixture(t);
  const peer = f.store.createBot('群聊伙伴', 'A group conversation partner.');
  const groups = new GroupChats(
    f.store,
    {
      isRunning: (id) => f.harness.isRunning(id),
      run: (id, input, options) => f.harness.run(id, input, options),
      cancel: (id) => f.harness.cancel(id),
    },
    () => {},
  );
  try {
    const room = groups.create({ name: '人格群聊正向验证', botIds: [f.bot.id, peer.id] });
    groups.send({ id: room.id, message: '一起聊聊上一局。' });
    const source = f.store.data.groups.find((group) => group.id === room.id)!.messages.at(-1)!;
    const delivery = f.store.data.groupDeliveries.find(
      (item) => item.recipientId === f.bot.id && item.messageId === source.id,
    );
    assert.ok(delivery);
    delivery.status = 'running';
    await f.harness.run(f.bot.id, source.content, {
      groupOrigin: { groupId: room.id, rootId: delivery.rootId, deliveryId: delivery.id },
      groupContext: GROUP_ONLY,
      onStarted: (runId) => {
        delivery.runId = runId;
      },
    });

    assert.equal(f.store.data.runs.at(-1)?.status, 'completed');
    assert.equal(f.requests.length, 1);
    assert.ok(f.requests[0].some((message) => message.role === 'system' && message.content?.includes(GROUP_ONLY)));
    assert.ok(f.requests[0].some((message) => message.role === 'system' && message.content?.includes(SOUL)));
    assert.match(JSON.stringify(f.requests[0]), /一起聊聊上一局/);
    assert.doesNotMatch(JSON.stringify(f.store.data.conversations[f.bot.id]), /GROUP_PERSONA_SENTINEL/);
  } finally {
    groups.dispose();
  }
});

test('human private chat and its next turn ignore mistakenly supplied group persona context', async (t) => {
  const f = fixture(t);
  await f.harness.run(f.bot.id, '第一轮：说说今天的安排。', { groupContext: GROUP_ONLY });
  await f.harness.run(f.bot.id, '第二轮：接着聊刚才的安排。', { groupContext: GROUP_ONLY });

  assert.deepEqual(
    f.store.data.runs.map((run) => run.status),
    ['completed', 'completed'],
  );
  assert.equal(f.requests.length, 2);
  for (const messages of f.requests) assertPrivateRequest(messages);
  assert.ok(f.requests[1].some((message) => message.role === 'user' && message.content?.includes('第一轮')));
  assert.ok(f.requests[1].some((message) => message.role === 'user' && message.content?.includes('第二轮')));
  assert.doesNotMatch(JSON.stringify(f.store.data.conversations[f.bot.id]), /GROUP_PERSONA_SENTINEL/);
});

test('a private Bot-to-Bot reply ignores group persona context too', async (t) => {
  const f = fixture(t);
  await f.harness.run(f.bot.id, '另一个 Bot 发来的私聊消息。', {
    privateSessionId: 'private-peer-session',
    peerOrigin: { kind: 'peer_request', exchangeId: 'private-peer-exchange', sessionId: 'private-peer-session' },
    peerContext: 'PEER_CONTEXT_SENTINEL: this is a private reply to another Bot.',
    groupContext: GROUP_ONLY,
  });

  assert.equal(f.store.data.runs.at(-1)?.status, 'completed');
  assert.equal(f.requests.length, 1);
  assertPrivateRequest(f.requests[0]);
  assert.match(JSON.stringify(f.requests[0]), /PEER_CONTEXT_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(f.store.data.peerContexts['private-peer-session']), /GROUP_PERSONA_SENTINEL/);
});

test('editing five traits and settling a game leave private chat identity and memories unchanged', async (t) => {
  const f = fixture(t);
  const original = { soul: f.bot.soul, memories: structuredClone(f.bot.memories) };
  await f.harness.run(f.bot.id, '游戏前，继续使用我们原来的聊天方式。');

  f.persona.ensureProfile(f.bot.id, 'INTJ');
  const traits = { E: 0.91, A: 0.82, C: 0.73, N: 0.14, O: 0.95 };
  const view = f.persona.setTraits(f.bot.id, traits);
  f.persona.settle({
    id: 'private-isolation-match',
    groupId: 'private-isolation-group',
    winner: 'village',
    personaPolicy: 'model_semantic_v1',
    seats: [
      { id: 'bot-seat', name: f.bot.name, human: false, botId: f.bot.id, role: 'villager' },
      { id: 'user-seat', name: 'GAME_RELATION_SENTINEL', human: true, role: 'witch' },
      { id: 'wolf-seat', name: '游戏中的狼人', human: false, role: 'wolf' },
    ],
    events: [{ type: 'save', day: 1, witchId: 'user-seat', seatId: 'bot-seat' }],
    persona: {
      'bot-seat': { botId: f.bot.id, traits, mbti: view.mbti, affinity: {} },
    },
    decisions: [
      {
        selectionMethod: 'model_semantic_v1',
        growthDisposition: 'record_only',
        requestId: 'private-isolation-vote',
        seatId: 'bot-seat',
        kind: 'vote',
        day: 1,
        strong: false,
        options: 1,
        chosen: { target: 'wolf-seat' },
        subject: 'wolf-seat',
        features: {},
        prob: 1,
        overridden: false,
      },
    ],
  });
  const settled = f.persona.view(f.bot.id);
  assert.deepEqual(settled.profile.traits, traits);
  assert.equal(settled.episodes.length, 1, 'the game really wrote an experience to the persona store');
  assert.ok(settled.relations.some((relation) => relation.id === 'user' && relation.affinity > 0));
  const fragment = f.persona.groupFragment(f.bot.id, [{ id: 'user', name: 'GAME_RELATION_SENTINEL' }]);
  assert.match(fragment, /\[你的关系与记忆，仅供参考\]/, 'settlement produced a usable group-only fragment');
  assert.match(fragment, /GAME_RELATION_SENTINEL/);

  await f.harness.run(f.bot.id, '游戏后，继续使用我们原来的聊天方式。');

  assert.deepEqual(
    f.store.data.runs.map((run) => run.status),
    ['completed', 'completed'],
  );
  assert.equal(f.requests.length, 2);
  for (const messages of f.requests) {
    assertPrivateRequest(messages);
    const prompt = JSON.stringify(messages);
    assert.doesNotMatch(prompt, /GAME_RELATION_SENTINEL|private-isolation-match|private-isolation-vote/);
    assert.ok(!prompt.includes(JSON.stringify(traits)), 'persisted five-trait values are not private chat context');
  }
  assert.equal(f.requests[1][0].content, f.requests[0][0].content, 'the private identity prompt stayed the same');
  assert.deepEqual({ soul: f.bot.soul, memories: f.bot.memories }, original);
});
