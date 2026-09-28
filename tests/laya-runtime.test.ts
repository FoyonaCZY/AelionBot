import { LayaGameDecisions } from '../electron/core/games/laya-decision';
import { createWerewolf, view } from '../electron/core/games/werewolf';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LayaDecisionLog } from '../electron/core/model/laya-decision-log';
import { LayaGroupDecisions } from '../electron/core/group/laya-decision';
import type { GroupDecisionInput } from '../shared/types/laya-types';
import { LayaRuntime } from '../electron/core/model/laya-runtime';
import { Store } from '../electron/core/storage/store';
import { GroupChats } from '../electron/core/group/group-chats';

const decisionInput = (text = ''): GroupDecisionInput => ({
  bot: { name: '测试 Bot', soul: '' },
  events: [{ from: { kind: 'user', name: '用户' }, text, mentioned: false }],
  recent: [],
});

async function ready(runtime: LayaRuntime) {
  runtime.warmup();
  for (let i = 0; i < 100 && !runtime.isReady; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.isReady, true);
}

test('cold start and excess requests fall back; a stuck worker is stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-budget-')),
    script = join(dir, 'fake.py');
  writeFileSync(
    script,
    'import json,sys,time\ntime.sleep(0.3)\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n time.sleep(30)\n',
  );
  const previous = { runtime: process.env.AELION_LAYA_RUNTIME, python: process.env.AELION_LAYA_PYTHON };
  process.env.AELION_LAYA_RUNTIME = 'mlx';
  process.env.AELION_LAYA_PYTHON = 'python3';
  const runtime = new LayaRuntime(script);
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  try {
    assert.equal(runtime.isReady, false);
    assert.equal(await decisions.group('cold', 'bot', decisionInput()), undefined);
    assert.equal(runtime.isReady, false);
    await ready(runtime);
    const pending = [1, 2, 3].map((id) => decisions.group(String(id), 'bot', decisionInput()));
    assert.equal(await decisions.group('excess', 'bot', decisionInput()), undefined);
    assert.equal(runtime.enabled, true);
    assert.deepEqual(await Promise.all(pending), [undefined, undefined, undefined]);
    assert.equal(runtime.enabled, false);
    assert.equal(runtime.isReady, false);
  } finally {
    runtime.dispose();
    if (previous.runtime === undefined) delete process.env.AELION_LAYA_RUNTIME;
    else process.env.AELION_LAYA_RUNTIME = previous.runtime;
    if (previous.python === undefined) delete process.env.AELION_LAYA_PYTHON;
    else process.env.AELION_LAYA_PYTHON = previous.python;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local Laya records a two-way group decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-'));
  const script = join(dir, 'fake.py');
  writeFileSync(
    script,
    'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"participate","confidence":0.73,"probabilities":{"observe":0.3,"participate":0.7}}}}}),flush=True)\n',
  );
  const previous = { runtime: process.env.AELION_LAYA_RUNTIME, python: process.env.AELION_LAYA_PYTHON };
  process.env.AELION_LAYA_RUNTIME = 'mlx';
  process.env.AELION_LAYA_PYTHON = 'python3';
  const runtime = new LayaRuntime(script);
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  try {
    await ready(runtime);
    assert.equal(await decisions.group('delivery-1', 'bot-1', decisionInput('PRIVATE_GROUP_CONTENT')), 'participate');
    const line = readFileSync(join(dir, 'laya-decisions.jsonl'), 'utf8');
    const result = JSON.parse(line);
    assert.equal(result.scope, 'group');
    assert.equal(result.choice, 'participate');
    assert.equal(result.confidence, 0.73);
    assert.equal(result.probabilities.participate, 0.7);
    assert.equal(result.criteria.participate, '这个 Bot 可以回应当前问题、补充有用信息，或开展及继续用户授权的工作');
    assert.deepEqual(result.features, { events: 1, recent: 0, mentioned: false, ownTask: false });
    assert.equal(typeof result.elapsedMs, 'number');
    assert(line.includes('PRIVATE_GROUP_CONTENT'));
    assert.equal(
      await decisions.group('delivery-2', 'bot-1', decisionInput('不要执行任何命令，请解释静默模式的实现')),
      'participate',
    );
    const adjusted = log.groupDecisions(new Set(['delivery-2']))[0];
    assert.equal(adjusted.choice, 'participate');
    assert.equal(adjusted.appliedChoice, undefined);
    assert.equal(adjusted.adjustment, undefined);
  } finally {
    runtime.dispose();
    if (previous.runtime === undefined) delete process.env.AELION_LAYA_RUNTIME;
    else process.env.AELION_LAYA_RUNTIME = previous.runtime;
    if (previous.python === undefined) delete process.env.AELION_LAYA_PYTHON;
    else process.env.AELION_LAYA_PYTHON = previous.python;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopping a group decision releases its slot and ignores the late answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-abort-')),
    script = join(dir, 'fake.py');
  writeFileSync(
    script,
    'import json,sys,time\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n time.sleep(0.2)\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"participate"}}}}),flush=True)\n',
  );
  const runtime = new LayaRuntime(script, () => {}, { runtime: 'mlx', python: 'python3' });
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  try {
    await ready(runtime);
    const controller = new AbortController();
    const prediction = decisions.group('stopped', 'bot', decisionInput(), controller.signal);
    controller.abort();
    assert.equal(await prediction, undefined);
    assert.equal(await decisions.group('after-stop', 'bot', decisionInput()), 'participate');
    assert.deepEqual(log.groupDecisions(new Set(['stopped'])), []);
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('group broadcast sends each Bot a separate decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-group-'));
  const script = join(dir, 'fake.py');
  writeFileSync(
    script,
    'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"observe"}}}}),flush=True)\n',
  );
  const previous = { runtime: process.env.AELION_LAYA_RUNTIME, python: process.env.AELION_LAYA_PYTHON };
  process.env.AELION_LAYA_RUNTIME = 'mlx';
  process.env.AELION_LAYA_PYTHON = 'python3';
  const store = new Store(dir),
    first = store.data.bots[0],
    second = store.createBot('第二个 Bot', '');
  const runtime = new LayaRuntime(script);
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  let runs = 0;
  const groups = new GroupChats(
    store,
    {
      isRunning: () => false,
      run: async () => {
        runs++;
      },
      cancel: () => {},
    },
    () => {},
    undefined,
    undefined,
    decisions,
  );
  try {
    await ready(runtime);
    const group = groups.create({ name: '测试群', botIds: [first.id, second.id] });
    groups.send({ id: group.id, message: '请看这条群消息' });
    groups.start();
    let events: Record<string, string>[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        events = readFileSync(join(dir, 'laya-decisions.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      } catch {}
      if (events.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.deepEqual(new Set(events.map((event) => event.actorId)), new Set([first.id, second.id]));
    assert(events.every((event) => event.scope === 'group' && event.choice === 'observe'));
    assert.equal(runs, 0);
    const page = groups.read({ id: group.id });
    assert.equal(page.laya?.decisions.length, 2);
    assert(
      page.laya?.decisions.every((decision) => page.messages.some((message) => message.id === decision.messageId)),
    );
    const sourceId = page.laya!.decisions[0].sourceId,
      sourceDelivery = store.data.groupDeliveries.find((item) => item.id === sourceId)!;
    const originalMessage = store.data.groups[0].messages.find((message) => message.id === sourceDelivery.messageId)!;
    const laterMessage = {
      ...originalMessage,
      id: randomUUID(),
      seq: originalMessage.seq + 1,
      sender: { kind: 'bot' as const, id: first.id, name: first.name, color: first.color },
      content: 'Bot 后续发言',
    };
    store.data.groups[0].messages.push(laterMessage);
    store.data.groupDeliveries.push({ ...sourceDelivery, id: randomUUID(), layaDecisionId: sourceId });
    sourceDelivery.messageId = laterMessage.id;
    const earlierPage = groups.read({ id: group.id, before: laterMessage.id });
    assert(
      earlierPage.laya?.decisions.some((decision) => decision.sourceId === sourceId),
      '用户消息关联的 Bot 决策应在触发消息位于下一页时仍可读取',
    );
  } finally {
    groups.dispose();
    runtime.dispose();
    store.close();
    if (previous.runtime === undefined) delete process.env.AELION_LAYA_RUNTIME;
    else process.env.AELION_LAYA_RUNTIME = previous.runtime;
    if (previous.python === undefined) delete process.env.AELION_LAYA_PYTHON;
    else process.env.AELION_LAYA_PYTHON = previous.python;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Laya participation reaches each Bot for questions and work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-route-')),
    script = join(dir, 'fake.py');
  writeFileSync(
    script,
    'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n event=request["state"]["events"][-1]\n choice="participate" if event["from"]["kind"]=="user" else "observe"\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":choice,"probabilities":{"observe":0.1,"participate":0.9}}}}}),flush=True)\n',
  );
  const previous = { runtime: process.env.AELION_LAYA_RUNTIME, python: process.env.AELION_LAYA_PYTHON };
  process.env.AELION_LAYA_RUNTIME = 'mlx';
  process.env.AELION_LAYA_PYTHON = 'python3';
  const store = new Store(dir),
    first = store.data.bots[0],
    second = store.createBot('第二个 Bot', '');
  const runtime = new LayaRuntime(script);
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  const calls: Array<{ botId: string; choice: string }> = [];
  const groups = new GroupChats(
    store,
    {
      isRunning: () => false,
      run: async (botId, input, options) => {
        calls.push({ botId, choice: (JSON.parse(input) as { layaDecision: { choice: string } }).layaDecision.choice });
        const id = randomUUID();
        store.data.runs.push({
          id,
          botId,
          status: 'completed',
          startedAt: new Date().toISOString(),
          modelCalls: 0,
          toolCalls: 0,
          groupOrigin: options.groupOrigin,
        });
        options.onStarted?.(id);
      },
      cancel: () => {},
    },
    () => {},
    undefined,
    undefined,
    decisions,
  );
  try {
    await ready(runtime);
    const room = groups.create({ name: '路由测试', botIds: [first.id, second.id] });
    groups.start();
    const wait = async () => {
      for (let i = 0; i < 100; i++) {
        if (
          !groups.busy &&
          !store.data.groupDeliveries.some((item) => ['queued', 'deciding', 'running'].includes(item.status))
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw Error('路由测试超时');
    };
    await wait();
    groups.send({ id: room.id, message: '请回复这条消息。' });
    await wait();
    assert.equal(calls.filter((item) => item.choice === 'participate').length, 2);
    groups.send({ id: room.id, message: '请执行本轮测试任务。' });
    await wait();
    assert.equal(calls.filter((item) => item.choice === 'participate').length, 4);
    assert.deepEqual(new Set(calls.map((item) => item.botId)), new Set([first.id, second.id]));
  } finally {
    groups.dispose();
    runtime.dispose();
    store.close();
    if (previous.runtime === undefined) delete process.env.AELION_LAYA_RUNTIME;
    else process.env.AELION_LAYA_RUNTIME = previous.runtime;
    if (previous.python === undefined) delete process.env.AELION_LAYA_PYTHON;
    else process.env.AELION_LAYA_PYTHON = previous.python;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup bounds legacy logs and recovers valid records around damaged lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-log-tail-'));
  const file = join(dir, 'laya-decisions.jsonl');
  const event = (index: number) => JSON.stringify({ scope: 'group', sourceId: String(index), choice: 'observe' });
  writeFileSync(
    file,
    '中'.repeat(2 * 1024 * 1024) +
      '\n' +
      Array.from({ length: 502 }, (_, index) => event(index)).join('\n') +
      '\ninvalid\n' +
      event(502) +
      '\n{"scope":',
  );
  const log = new LayaDecisionLog(dir);
  try {
    const decisions = log.groupDecisions(new Set(Array.from({ length: 503 }, (_, index) => String(index))));
    assert.equal(decisions.length, 500);
    assert.equal(decisions[0].sourceId, '3');
    assert.equal(decisions.at(-1)?.sourceId, '502');
    assert(statSync(file).size <= 4 * 1024 * 1024);
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 500);
    assert.equal(lines.at(-1).sourceId, '502');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decision log rotates by UTF-8 bytes and oversized snapshots cannot exceed its limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-log-rotate-'));
  const script = join(dir, 'fake.py');
  const file = join(dir, 'laya-decisions.jsonl');
  writeFileSync(
    script,
    'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"participate"}}}}),flush=True)\n',
  );
  const runtime = new LayaRuntime(script, () => {}, { runtime: 'mlx', python: 'python3' });
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  try {
    await ready(runtime);
    for (let index = 0; index < 4; index++) {
      assert.equal(await decisions.group(String(index), 'bot', decisionInput('中'.repeat(600_000))), 'participate');
      assert(statSync(file).size <= 4 * 1024 * 1024);
    }
    assert.equal(await decisions.group('oversized', 'bot', decisionInput('中'.repeat(1_500_000))), 'participate');
    assert(statSync(file).size <= 4 * 1024 * 1024);
    assert.equal(log.groupDecisions(new Set(['oversized'])).length, 1);
    assert.equal(await decisions.group('latest', 'bot', decisionInput()), 'participate');
    const records = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((event) => event.sourceId),
      ['2', '3', 'latest'],
    );
    const reloaded = new LayaDecisionLog(dir);
    assert.deepEqual(
      reloaded.groupDecisions(new Set(['0', '2', '3', 'latest'])).map((event) => event.sourceId),
      ['2', '3', 'latest'],
    );
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy three-way logs are normalized once for all group consumers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-legacy-'));
  try {
    writeFileSync(
      join(dir, 'laya-decisions.jsonl'),
      [
        {
          scope: 'group',
          sourceId: 'old',
          choice: 'act',
          appliedChoice: 'reply',
          probabilities: { observe: 0.1, reply: 0.3, act: 0.6 },
        },
        { scope: 'group', sourceId: 'bad', choice: 'invalid' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );
    const log = new LayaDecisionLog(dir);
    const events = log.groupDecisions(new Set(['old', 'bad']));
    assert.equal(events.length, 1);
    assert.equal(events[0].choice, 'participate');
    assert.equal(events[0].appliedChoice, 'participate');
    assert.deepEqual(events[0].probabilities, { observe: 0.1, participate: 0.8999999999999999 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabled Laya receives each Bot identity and cannot globally suppress another Bot request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-addressed-'));
  const store = new Store(dir),
    first = store.data.bots[0],
    second = store.createBot('乙', '核对报告');
  first.name = '甲';
  first.soul = '---\ndescription: 数据分析\n---\n# SOUL\n分析问题';
  const inputs: GroupDecisionInput[] = [];
  const runtime = {
    isReady: true,
    enabled: true,
    runtimeName: 'mlx',
    async predict(state: GroupDecisionInput) {
      inputs.push(state);
      const text = state.events.at(-1)!.text;
      return {
        choice: text.includes('@甲') && state.bot.name === '甲' ? 'observe' : 'participate',
        model: 'fake',
        runtime: 'mlx',
        elapsedMs: 0,
      };
    },
  } as unknown as LayaRuntime;
  const decisions = new LayaGroupDecisions(runtime, new LayaDecisionLog(dir));
  const runs: string[] = [];
  const groups = new GroupChats(
    store,
    {
      isRunning: () => false,
      run: async (botId) => {
        runs.push(botId);
      },
      cancel: () => {},
    },
    () => {},
    undefined,
    undefined,
    decisions,
  );
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      if (
        !groups.busy &&
        !store.data.groupDeliveries.some((item) => ['queued', 'deciding', 'running'].includes(item.status))
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error('群聊未结束');
  };
  try {
    const room = groups.create({ name: '指令对象', botIds: [first.id, second.id] });
    groups.start();
    await wait();
    runs.length = 0;
    inputs.length = 0;
    groups.send({ id: room.id, message: '不要执行任何命令，请解释静默模式的实现' });
    await wait();
    assert.deepEqual(new Set(runs), new Set([first.id, second.id]));
    assert.equal(inputs.find((input) => input.bot.name === '甲')?.bot.soul, '数据分析 分析问题');
    runs.length = 0;
    groups.send({ id: room.id, message: '@甲 不要执行任务，请旁听。@乙 请检查报告并回复' });
    await wait();
    assert.deepEqual(runs, [second.id]);
  } finally {
    groups.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('game adapter only logs candidates using player-visible context and bounded public speech', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-game-'));
  try {
    const players = Array.from({ length: 7 }, (_, index) => ({
      id: String(index),
      name: `Player ${index}`,
      color: '#887799',
      human: false,
    }));
    const state = createWerewolf('laya-game', players, [
      'wolf',
      'wolf',
      'seer',
      'witch',
      'villager',
      'villager',
      'villager',
    ]);
    const request = state.requests.find((item) => item.seatId === '0')!;
    const before = JSON.stringify(state);
    const inputs: unknown[] = [];
    const runtime = {
      async predict(input: unknown, question: { criteria: Record<string, string> }) {
        inputs.push(input);
        return { choice: Object.keys(question.criteria)[0], runtime: 'mlx', model: 'fake', elapsedMs: 0 };
      },
    } as unknown as LayaRuntime;
    const log = new LayaDecisionLog(dir),
      decisions = new LayaGameDecisions(runtime, log);
    await decisions.game(request.id, '0', view(state, '0'), request);
    await decisions.speech('public-speech', '0', '公开发言'.repeat(500));
    assert(!JSON.stringify(inputs[0]).includes('seer'));
    assert.equal((inputs[1] as string).length, 800);
    assert.equal(JSON.stringify(state), before);
    const records = readFileSync(join(dir, 'laya-decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.scope),
      ['game', 'game_speech'],
    );
    assert.deepEqual(log.groupDecisions(new Set([request.id, 'public-speech'])), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
