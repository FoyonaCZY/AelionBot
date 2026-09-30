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
import type { HarnessRunOptions } from '../electron/core/agent/peer-runtime-types';
import type { RunRecord } from '../shared/types/core';
import { until } from './helpers';
import { GroupChats } from '../electron/core/group/group-chats';

const decisionInput = (text = ''): GroupDecisionInput => ({
  bot: { name: '测试 Bot', role: '' },
  work: '空闲',
  message: { from: { kind: 'user', name: '用户' }, text },
});

async function choose(
  decisions: LayaGroupDecisions,
  sourceId: string,
  actorId: string,
  input: GroupDecisionInput,
  signal?: AbortSignal,
) {
  return (await decisions.decide({ sourceId, actorId, input }, signal))?.appliedChoice;
}

// Complete the same lifecycle the real runner promises: persist a running Run,
// notify onStarted, record its final answer and only then mark completion.
function completedGroupRunner(
  store: Store,
  onRun: (botId: string, input: string, options: HarnessRunOptions, run: RunRecord) => string | void = () => {},
): ConstructorParameters<typeof GroupChats>[1] {
  const busy = new Set<string>();
  return {
    isRunning: (botId) => busy.has(botId),
    cancel: (botId) => {
      const run = store.data.runs.find((item) => item.botId === botId && item.status === 'running');
      if (run) run.status = 'cancelled';
    },
    async run(botId, input, options) {
      const run: RunRecord = {
        id: randomUUID(),
        botId,
        status: 'running',
        startedAt: new Date().toISOString(),
        modelCalls: 0,
        toolCalls: 0,
        groupOrigin: options.groupOrigin,
      };
      store.data.runs.push(run);
      busy.add(botId);
      options.onStarted?.(run.id);
      try {
        const content = onRun(botId, input, options, run) || '[群聊静默]';
        store.message(botId, 'assistant', content, { runId: run.id, presentation: 'answer', status: 'done' });
        run.status = 'completed';
        run.endedAt = new Date().toISOString();
      } catch (error) {
        run.status = 'failed';
        run.error = (error as Error).message;
        throw error;
      } finally {
        busy.delete(botId);
      }
    },
  };
}
function assertDeliveriesSettled(store: Store) {
  assert(store.data.groupDeliveries.length > 0);
  assert.deepEqual(
    store.data.groupDeliveries.filter((delivery) => delivery.status === 'failed'),
    [],
  );
  assert(
    store.data.groupDeliveries.every((delivery) =>
      (delivery.recipientId === 'user' ? ['delivered', 'read'] : ['ignored', 'replied']).includes(delivery.status),
    ),
  );
  assert(store.data.runs.every((run) => run.status === 'completed'));
}

async function ready(runtime: LayaRuntime) {
  runtime.warmup();
  await until(() => runtime.isReady, { message: 'Laya 未就绪' });
  assert.equal(runtime.isReady, true);
}

test('cold start and excess requests fall back; a stuck worker is stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-budget-')),
    script = join(dir, 'fake.py');
  writeFileSync(
    script,
    'import json,sys,time\ntime.sleep(0.3)\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n time.sleep(30)\n',
  );
  const runtime = new LayaRuntime(script, () => {}, { runtime: 'mlx', python: 'python3' });
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  try {
    assert.equal(runtime.isReady, false);
    assert.equal(await choose(decisions, 'cold', 'bot', decisionInput()), undefined);
    assert.equal(runtime.isReady, false);
    await ready(runtime);
    const pending = [1, 2, 3].map((id) => choose(decisions, String(id), 'bot', decisionInput()));
    assert.equal(await choose(decisions, 'excess', 'bot', decisionInput()), undefined);
    assert.equal(runtime.enabled, true);
    assert.deepEqual(await Promise.all(pending), [undefined, undefined, undefined]);
    assert.equal(runtime.enabled, false);
    assert.equal(runtime.isReady, false);
  } finally {
    runtime.dispose();
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
  const runtime = new LayaRuntime(script, () => {}, { runtime: 'mlx', python: 'python3' });
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  try {
    await ready(runtime);
    assert.equal(await choose(decisions, 'delivery-1', 'bot-1', decisionInput('PRIVATE_GROUP_CONTENT')), 'participate');
    const line = readFileSync(join(dir, 'laya-decisions.jsonl'), 'utf8');
    const result = JSON.parse(line);
    assert.equal(result.scope, 'group');
    assert.equal(result.choice, 'participate');
    assert.equal(result.confidence, 0.73);
    assert.equal(result.probabilities.participate, 0.7);
    assert.equal(result.criteria.participate, '回应：这条消息和当前 Bot 的职责或手上的事有关');
    assert.deepEqual(result.features, { repliedTo: false, answered: false, working: false });
    assert.equal(typeof result.elapsedMs, 'number');
    assert(line.includes('PRIVATE_GROUP_CONTENT'));
    assert.equal(
      await choose(decisions, 'delivery-2', 'bot-1', decisionInput('不要执行任何命令，请解释静默模式的实现')),
      'participate',
    );
    const adjusted = log.groupDecisions(new Set(['delivery-2']))[0];
    assert.equal(adjusted.choice, 'participate');
    assert.equal(adjusted.appliedChoice, 'participate');
    assert.equal(adjusted.adjustment, undefined);
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('30 cancelled callers keep at most three backend requests until responses finish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-abort-')),
    script = join(dir, 'fake.py'),
    completed = join(dir, 'completed');
  writeFileSync(
    script,
    'import json,sys,time\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n time.sleep(0.2)\n with open(' +
      JSON.stringify(completed) +
      ',"a") as f: f.write(request["id"]+"\\n")\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"participate"}}}}),flush=True)\n',
  );
  const runtime = new LayaRuntime(script, () => {}, { runtime: 'mlx', python: 'python3' });
  const log = new LayaDecisionLog(dir),
    decisions = new LayaGroupDecisions(runtime, log);
  try {
    await ready(runtime);
    for (let index = 0; index < 30; index++) {
      const controller = new AbortController();
      const prediction = choose(decisions, `stopped-${index}`, 'bot', decisionInput(), controller.signal);
      controller.abort();
      assert.equal(await prediction, undefined);
    }
    // All backend slots are still occupied; no fourth request is written to stdin.
    assert.equal(await choose(decisions, 'excess', 'bot', decisionInput()), undefined);
    await until(() => {
      try {
        return readFileSync(completed, 'utf8').trim().split('\n').length === 3;
      } catch {
        return false;
      }
    });
    // The completion marker can precede receipt of the response; retry until a slot is free.
    await until(async () => (await choose(decisions, 'after-stop', 'bot', decisionInput())) === 'participate');
    assert.equal(readFileSync(completed, 'utf8').trim().split('\n').length, 4);
    assert.equal(runtime.isReady, true);
    assert.deepEqual(log.groupDecisions(new Set(Array.from({ length: 30 }, (_, index) => `stopped-${index}`))), []);
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
  const store = new Store(dir),
    first = store.data.bots[0],
    second = store.createBot('第二个 Bot', '');
  const runtime = new LayaRuntime(script, () => {}, { runtime: 'mlx', python: 'python3' });
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  let runs = 0;
  const groups = new GroupChats(
    store,
    completedGroupRunner(store, () => {
      runs++;
    }),
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
    await until(() => {
      try {
        events = readFileSync(join(dir, 'laya-decisions.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      } catch {}
      return events.length >= 2;
    });
    assert.deepEqual(new Set(events.map((event) => event.actorId)), new Set([first.id, second.id]));
    assert(events.every((event) => event.scope === 'group' && event.choice === 'observe'));
    await until(() => !groups.busy && !store.data.groupDeliveries.some((item) => item.status === 'queued'));
    // Nobody answered the unaddressed message, so the group was told once to @ someone.
    assert.equal(store.data.groups[0].messages.filter((message) => message.notice === 'unanswered').length, 1);
    assert.equal(runs, 0);
    assertDeliveriesSettled(store);
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
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Laya participation reaches each Bot for questions and work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-route-')),
    script = join(dir, 'fake.py');
  writeFileSync(
    script,
    'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n event=request["state"]["message"]\n choice="participate" if event["from"]["kind"]=="user" else "observe"\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":choice,"probabilities":{"observe":0.1,"participate":0.9}}}}}),flush=True)\n',
  );
  const store = new Store(dir),
    first = store.data.bots[0],
    second = store.createBot('第二个 Bot', '');
  const runtime = new LayaRuntime(script, () => {}, { runtime: 'mlx', python: 'python3' });
  const log = new LayaDecisionLog(dir);
  const decisions = new LayaGroupDecisions(runtime, log);
  const calls: string[] = [];
  const groups = new GroupChats(
    store,
    completedGroupRunner(store, (botId) => {
      calls.push(botId);
    }),
    () => {},
    undefined,
    undefined,
    decisions,
  );
  try {
    await ready(runtime);
    const room = groups.create({ name: '路由测试', botIds: [first.id, second.id] });
    groups.start();
    const wait = () =>
      until(
        () =>
          !groups.busy &&
          !store.data.groupDeliveries.some((item) => ['queued', 'deciding', 'running'].includes(item.status)),
      );
    await wait();
    groups.send({ id: room.id, message: '请回复这条消息。' });
    await wait();
    assert.equal(calls.length, 2);
    groups.send({ id: room.id, message: '请执行本轮测试任务。' });
    await wait();
    assert.equal(calls.length, 4);
    assert.deepEqual(new Set(calls), new Set([first.id, second.id]));
    // Membership notices never reach Laya; only the two user messages were judged, once per Bot.
    assert.equal(log.groupDecisions(new Set(store.data.groupDeliveries.map((item) => item.id))).length, 4);
    assertDeliveriesSettled(store);
  } finally {
    groups.dispose();
    runtime.dispose();
    store.close();
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
      assert.equal(await choose(decisions, String(index), 'bot', decisionInput('中'.repeat(600_000))), 'participate');
      assert(statSync(file).size <= 4 * 1024 * 1024);
    }
    assert.equal(await choose(decisions, 'oversized', 'bot', decisionInput('中'.repeat(1_500_000))), 'participate');
    assert(statSync(file).size <= 4 * 1024 * 1024);
    assert.equal(log.groupDecisions(new Set(['oversized'])).length, 1);
    assert.equal(await choose(decisions, 'latest', 'bot', decisionInput()), 'participate');
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
      const text = state.message.text;
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
    completedGroupRunner(store, (botId) => {
      runs.push(botId);
    }),
    () => {},
    undefined,
    undefined,
    decisions,
  );
  const wait = () =>
    until(
      () =>
        !groups.busy &&
        !store.data.groupDeliveries.some((item) => ['queued', 'deciding', 'running'].includes(item.status)),
    );
  try {
    const room = groups.create({ name: '指令对象', botIds: [first.id, second.id] });
    groups.start();
    await wait();
    runs.length = 0;
    inputs.length = 0;
    groups.send({ id: room.id, message: '不要执行任何命令，请解释静默模式的实现' });
    await wait();
    assert.deepEqual(new Set(runs), new Set([first.id, second.id]));
    assert.equal(inputs.find((input) => input.bot.name === '甲')?.bot.role, '数据分析 分析问题');
    assert.ok(inputs.every((input) => input.work === '空闲'));
    runs.length = 0;
    groups.send({ id: room.id, message: '@甲 不要执行任务，请旁听。@乙 请检查报告并回复' });
    await wait();
    assert.deepEqual(runs, [second.id]);
    assertDeliveriesSettled(store);
  } finally {
    groups.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requeued group work resumes without asking Laya while other members are still judged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-laya-resume-'));
  const store = new Store(dir),
    bot = store.data.bots[0],
    second = store.createBot('旁听伙伴', '');
  const judged: string[] = [];
  const runtime = {
    enabled: true,
    isReady: true,
    runtimeName: 'mlx',
    predict: async (state: GroupDecisionInput) => {
      judged.push(state.bot.name);
      return {
        choice: 'observe',
        confidence: 0.9,
        probabilities: { observe: 0.9, participate: 0.1 },
        runtime: 'mlx',
        model: 'fake',
        elapsedMs: 0,
      };
    },
  } as unknown as LayaRuntime;
  const decisions = new LayaGroupDecisions(runtime, new LayaDecisionLog(dir));
  const resumed: string[] = [];
  const groups = new GroupChats(
    store,
    completedGroupRunner(store, (botId, _input, options) => {
      resumed.push(botId);
      assert.equal(options.groupTaskFrom, previousRunId);
      return '报告已核对。';
    }),
    () => {},
    undefined,
    undefined,
    decisions,
  );
  const previousRunId = randomUUID();
  try {
    const room = groups.create({ name: '任务续跑', botIds: [bot.id, second.id] });
    groups.send({ id: room.id, message: '请继续核对报告' });
    const storedRoom = store.data.groups[0],
      user = storedRoom.messages.find((message) => message.sender.kind === 'user' && message.kind === 'message')!;
    assert(user.rootId);
    const time = new Date().toISOString();
    store.data.runs.push({
      id: previousRunId,
      botId: bot.id,
      status: 'completed',
      startedAt: time,
      endedAt: time,
      modelCalls: 1,
      toolCalls: 1,
      groupOrigin: { groupId: room.id, rootId: user.rootId, deliveryId: 'previous-delivery' },
    });
    store.message(bot.id, 'tool', '{"stdout":"checked"}', {
      runId: previousRunId,
      tool: 'computer_execute',
      status: 'done',
    });
    // A private chat took over: the delivery was requeued already woken and still names its run.
    const requeued = store.data.groupDeliveries.find(
      (item) => item.messageId === user.id && item.recipientId === bot.id,
    )!;
    requeued.runId = previousRunId;
    requeued.triage = 'wake';
    groups.start();
    await until(
      () =>
        !groups.busy &&
        !store.data.groupDeliveries.some((item) => ['queued', 'deciding', 'running'].includes(item.status)),
    );
    assertDeliveriesSettled(store);
    assert.deepEqual(resumed, [bot.id]);
    // The resumed Bot skips Laya; the other member is judged on the user message (and on the reply).
    assert.ok(judged.length && judged.every((name) => name === second.name));
    const page = groups.read({ id: room.id });
    assert.ok(page.messages.some((message) => message.sender.id === bot.id && message.content === '报告已核对。'));
    const other = page.laya?.decisions.find((item) => item.messageId === user.id && item.actorId === second.id);
    assert(other);
    assert.equal(other.appliedChoice, 'observe');
    assert.deepEqual(other.probabilities, { observe: 0.9, participate: 0.1 });
    const persisted = new LayaDecisionLog(dir).groupDecisions(new Set([other.sourceId]))[0];
    assert.deepEqual(persisted, decisions.read(new Set([other.sourceId]))[0]);
  } finally {
    groups.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
