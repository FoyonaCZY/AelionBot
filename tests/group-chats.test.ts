import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, delay, settle, until } from './helpers';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/core/storage/store';
import { Cognition } from '../electron/core/memory/cognition';
import { SkillLibrary } from '../electron/core/extensions/skill-library';
import { Harness } from '../electron/core/agent/harness';
import { GroupChats } from '../electron/core/group/group-chats';
import { groupMainContext } from '../electron/core/group/group-context';
import { Interactions } from '../electron/core/agent/interactions';
import { HostComputer } from '../electron/core/host/host';
import type { ModelClient, Completion, ToolDefinition } from '../electron/core/model/model';
import type { Bot, WireMessage, RunRecord } from '../shared/types/core';
import { botIdentity } from '../shared/chat/bot-colors';
import type { VmController } from '../electron/core/vm/vm';
import { groupPending } from '../shared/types/group-types';
import { conversationTimeline } from '../shared/chat/activity';
import { groupParaphrases } from './fixtures/group-paraphrases';
const publishedMessages = (messages: WireMessage[]) =>
  messages.filter((message) => message.groupMessageId).map((message) => JSON.parse(message.content!));
const silent = () => answer('');
const call = (name: string, args: Record<string, unknown>): Completion => ({
  content: '',
  calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  finishReason: 'tool_calls',
});
const waitAbort = (signal: AbortSignal) =>
  new Promise<Completion>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

test('a group reaction alongside file work preserves the final reply and its delivery record', async (t) => {
  let requests = 0;
  const fx = fixture(
    t,
    (run) => {
      if (run.botId !== fx.a.id) return silent();
      const room = fx.store.data.groups.find((room) => room.id === run.groupOrigin!.groupId)!,
        user = room.messages.find((message) => message.sender.kind === 'user' && message.kind === 'message');
      if (!user) return silent();
      requests++;
      if (requests === 1)
        return {
          content: '先看文件内容，再把结论发到群里。',
          calls: [
            ...call('group_react', { groupId: room.id, messageId: user.id, emoji: '👀' }).calls,
            ...call('file_read', { path: 'README.md' }).calls,
          ],
          finishReason: 'tool_calls',
        };
      return answer('README 已核对，项目说明完整。');
    },
    {
      execute: async (_command: string, botId: string) => ({
        stdout: JSON.stringify({ path: `/work/${botId}/README.md`, data: Buffer.from('项目说明').toString('base64') }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      }),
    } as unknown as VmController,
  );
  const room = fx.groups.create({ name: '项目核对', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '请读取 README 并说明结果' });
  await until(fx.settled);
  const messages = fx.groups.read({ id: room.id }).messages,
    user = messages.find((message) => message.sender.kind === 'user' && message.kind === 'message')!,
    reply = messages.find(
      (message) =>
        message.sender.id === fx.a.id &&
        message.kind === 'message' &&
        message.content === 'README 已核对，项目说明完整。',
    );
  assert.equal(requests, 2);
  assert.ok(reply);
  assert.ok(user.pins?.some((pin) => pin.actor.id === fx.a.id));
  assert.equal(
    fx.store.data.groupDeliveries.find((delivery) => delivery.messageId === user.id && delivery.recipientId === fx.a.id)
      ?.replyMessageId,
    reply.id,
  );
  assert.ok(
    fx.store.data.groupRunMessages.some(
      (message) =>
        message.botId === fx.a.id &&
        message.presentation === 'progress' &&
        message.content === '先看文件内容，再把结论发到群里。',
    ),
  );
});
function fixture(
  t: test.TestContext,
  complete: (
    run: RunRecord,
    messages: WireMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ) => Completion | Promise<Completion> = () => silent(),
  vm?: VmController,
  withCognition = false,
) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-group-test-')),
    store = new Store(dir),
    a = store.data.bots[0],
    b = store.createBot('数据伙伴', '分析'),
    c = store.createBot('核对伙伴', '核对'),
    busy = new Set<string>();
  let groups: GroupChats;
  const modelAssertions: unknown[] = [];
  store.data.model.contextTokens = 64000;
  const interactions = new Interactions(() => groups?.wake()),
    host = new HostComputer({ dataDir: dir, homeDir: dir, projectDir: dir }, interactions);
  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[], signal: AbortSignal) => {
      const prompt = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n'),
        id =
          /\/work\/([a-f0-9-]+)/.exec(prompt)?.[1] ||
          store.data.bots.find((bot) => prompt.includes(`You are ${bot.name},`))?.id;
      const run = store.data.runs.find((r) => r.botId === id && r.status === 'running')!;
      assert.ok(run);
      try {
        return await complete(run, messages, tools, signal);
      } catch (error) {
        if ((error as Error).name === 'AssertionError') modelAssertions.push(error);
        throw error;
      }
    },
  } as unknown as ModelClient;
  const cognition = withCognition
    ? new Cognition(
        store,
        model,
        new SkillLibrary(store, {
          dataDir: dir,
          homeDir: join(dir, 'home'),
          projectDir: dir,
          configDir: join(dir, 'config'),
          env: {},
        }),
        () => {},
        () => true,
      )
    : undefined;
  const harness = new Harness(
    store,
    vm || ({} as VmController),
    model,
    () => groups?.wake(),
    undefined,
    undefined,
    undefined,
    host,
    interactions,
    cognition,
  );
  groups = new GroupChats(
    store,
    {
      isRunning: (id) => busy.has(id) || harness.isRunning(id),
      run: (id, input, options) => harness.run(id, input, options),
      cancel: (id) => harness.cancel(id),
      refresh: (id) => harness.refreshGroup(id),
    },
    () => {},
  );
  harness.setGroupGateway(groups);
  groups.start();
  t.after(async () => {
    groups.dispose();
    for (const bot of store.data.bots) harness.cancel(bot.id);
    await until(() => !groups.busy && !harness.busy);
    host.dispose();
    interactions.dispose();
    await cognition?.close();
    await delay(10);
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(modelAssertions, []);
  });
  const settled = () =>
    !groups.busy && !harness.busy && !store.data.groupDeliveries.some((d) => groupPending(d.status));
  /** Send a user message that @-addresses the given Bots, so each of them must answer. */
  const ask = (id: string, to: Bot | Bot[], message: string) => {
    let text = '';
    const mentions = [to].flat().map((bot) => {
      const start = text.length;
      text += `@${bot.name} `;
      return { ...botIdentity(bot), start, end: start + bot.name.length + 1 };
    });
    groups.send({ id, message: text + message, mentions });
  };
  return { store, groups, harness, a, b, c, busy, dir, interactions, settled, ask };
}

for (const message of ['不要执行任何命令，请解释静默模式的实现', '@甲 不要执行任务，请旁听。@乙 请检查报告并回复']) {
  test(`without Laya the main model receives the user request: ${message}`, async (t) => {
    const received = new Set<string>();
    const fx = fixture(t, (run) => {
      const room = fx.store.data.groups[0];
      if (room.messages.some((item) => item.sender.kind === 'user' && item.kind === 'message')) {
        received.add(run.botId);
      }
      return silent();
    });
    fx.a.name = '甲';
    fx.b.name = '乙';
    const room = fx.groups.create({ name: '静默语义回归', botIds: [fx.a.id, fx.b.id] });
    await until(fx.settled);
    fx.groups.send({ id: room.id, message });
    await until(fx.settled);
    assert.deepEqual(received, new Set([fx.a.id, fx.b.id]));
    assert(fx.store.data.runs.every((run) => run.status !== 'failed'));
  });
}

test('group tool results remain available across multiple model turns', async (t) => {
  const calls: string[] = [];
  let turns = 0;
  const fx = fixture(t, (run, messages, _tools) => {
    if (run.botId !== fx.a.id) return silent();
    turns++;
    for (const id of calls)
      assert.ok(
        messages.some((message) => message.role === 'tool' && message.tool_call_id === id),
        `Lost earlier tool result ${id} on turn ${turns}`,
      );
    if (calls.length < 3) {
      const result = call('task_update', {
        revision: run.plan?.revision || 0,
        goal: '验证多轮上下文',
        steps: [
          {
            id: 'check',
            title: '核对历史',
            acceptance: '先前工具结果仍可见',
            status: 'skipped',
            evidenceIds: [],
            note: '本次仅验证上下文保留，无需执行文件操作。',
          },
        ],
      });
      calls.push(result.calls[0].id);
      return result;
    }
    return answer('三次工具结果均已保留，核对完成。');
  });
  const room = fx.groups.create({ name: '历史回归', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, fx.a, '核对群历史');
  await until(fx.settled);
  assert.equal(turns, 4);
  assert.equal(fx.store.data.runs.filter((run) => run.botId === fx.a.id).length, 1);
  assert.equal(
    fx.groups.read({ id: room.id }).messages.filter((message) => message.content === '三次工具结果均已保留，核对完成。')
      .length,
    1,
  );
});

test('stalled group plans close as blocked and publish a truthful result instead of failing silently', async (t) => {
  let turns = 0;
  const fx = fixture(t, (run) => {
    if (run.botId !== fx.a.id) return silent();
    turns++;
    if (turns === 1)
      return call('plan_update', {
        revision: 0,
        goal: '提交核对结果',
        steps: [{ id: 'check', title: '核对材料', acceptance: '引用实际材料', status: 'pending', evidenceIds: [] }],
      });
    if (turns > 4) throw Error('test: repeated generation was not stopped');
    return answer('材料已齐，现在发送正文。');
  });
  const room = fx.groups.create({ name: '循环回归', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, fx.a, '核对材料后提交正文');
  await until(fx.settled);
  assert.equal(turns, 4);
  const messages = fx.groups.read({ id: room.id }).messages;
  assert.ok(
    messages.some(
      (message) =>
        message.sender.id === fx.a.id &&
        message.kind === 'message' &&
        /任务未能确认完成.*连续 3 次/.test(message.content),
    ),
  );
  assert.ok(!messages.some((message) => message.kind === 'message' && message.content === '材料已齐，现在发送正文。'));
  assert.equal(fx.store.data.workItems?.[0]?.status, 'blocked');
  assert.ok(!fx.store.data.groupDeliveries.some((d) => d.recipientId === fx.a.id && d.status === 'failed'));
  assert.equal(
    fx.store.data.groupDeliveries.find((d) => d.recipientId === fx.a.id && d.status === 'replied')?.status,
    'replied',
  );
});

test('a group plan that repeats a successful action with the same result is closed as blocked', async (t) => {
  let executions = 0,
    planned = false;
  const vm = {
    execute: async () => {
      executions++;
      return { exitCode: 0, stdout: 'same inspection result', stderr: '', durationMs: 1 };
    },
  } as unknown as VmController;
  const fx = fixture(
    t,
    (run) => {
      if (run.botId !== fx.a.id) return silent();
      if (!planned) {
        planned = true;
        return call('plan_update', {
          revision: 0,
          goal: '核对报告',
          steps: [{ id: 'check', title: '核对报告', acceptance: '引用核对结果', status: 'pending', evidenceIds: [] }],
        });
      }
      if (fx.store.data.workItems?.[0]?.status === 'blocked') return silent();
      if (executions > 8) throw Error('test: repeated action was not stopped');
      return call('computer_execute', { command: 'inspect report' });
    },
    vm,
  );
  const room = fx.groups.create({ name: '重复操作收尾', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '请核对报告' });
  await until(fx.settled);
  assert.equal(fx.store.data.workItems?.[0]?.status, 'blocked');
  assert.equal(executions, 4);
  assert.ok(
    fx.groups
      .read({ id: room.id })
      .messages.some((message) => message.sender.id === fx.a.id && /标记为受阻/.test(message.content)),
  );
  assert.ok(
    !fx.store.data.groupDeliveries.some((delivery) => delivery.recipientId === fx.a.id && delivery.status === 'failed'),
  );
});

test('real group dispatch keeps mixed-language conversation without language rules', async (t) => {
  const captured: Array<{ text: string; botEvent: boolean }> = [];
  let replied = false;
  const fx = fixture(t, (run, messages) => {
    const context = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content || '')
      .join('\n');
    if (!context.includes('Build an awesome project.')) return silent();
    const history = publishedMessages(messages);
    captured.push({
      text: context,
      botEvent: history.some((m) => m.sender.kind === 'bot' && m.content === '我建议做音乐项目。'),
    });
    if (run.botId === fx.a.id && !replied) {
      replied = true;
      return call('group_send_message', { groupId: run.groupOrigin!.groupId, message: '我建议做音乐项目。' });
    }
    return silent();
  });
  fx.store.data.language = 'en';
  const room = fx.groups.create({ name: 'Team', botIds: [fx.a.id, fx.b.id] });
  await until(fx.settled);
  fx.groups.send({ id: room.id, message: 'Build an awesome project.' });
  await until(fx.settled);
  assert.ok(captured.length >= 2);
  assert.ok(captured.some((item) => item.botEvent));
  for (const item of captured) {
    assert.doesNotMatch(item.text, /Response language policy|current interface language|latestHumanMessage/);
    assert.doesNotMatch(item.text, /这是群聊|群聊发言规则|系统发布的 event/);
  }
});

test('group work stays out of the private chat while public progress reaches every member', async (t) => {
  let actions = 0;
  const recipients = new Set<string>(),
    privateContexts: string[] = [],
    privateToolNames: string[] = [],
    vm = {
      execute: async () => ({ stdout: `完成步骤 ${++actions}`, stderr: '', exitCode: 0, durationMs: 1 }),
    } as unknown as VmController;
  const fx = fixture(
    t,
    (run, messages, tools) => {
      if (!run.groupOrigin) {
        privateContexts.push(JSON.stringify(messages));
        privateToolNames.push(...tools.map((tool) => tool.function.name));
        return answer('私聊回复');
      }
      assert.ok(!JSON.stringify(messages).includes('现在只向用户简短汇报'));
      if (run.botId !== fx.a.id) {
        if (publishedMessages(messages).some((m) => m.kind === 'progress')) recipients.add(run.botId);
        return silent();
      }
      return actions < 4
        ? {
            ...call('computer_execute', { command: 'verify-step' }),
            content: '这是私有执行草稿',
            calls: [
              ...(actions === 3
                ? call('group_send_message', {
                    groupId: run.groupOrigin!.groupId,
                    message: '已核对三处配置，接下来检查运行结果。',
                    kind: 'progress',
                    clientMessageId: 'step-3',
                  }).calls
                : []),
              ...call('computer_execute', { command: 'verify-step' }).calls,
            ],
          }
        : answer('已完成核对。');
    },
    vm,
  );
  const room = fx.groups.create({ name: '工作进度', botIds: [fx.a.id, fx.b.id, fx.c.id] });
  fx.groups.send({ id: room.id, message: '请核对配置和运行结果' });
  await until(fx.settled);
  const progress = fx.groups.read({ id: room.id }).messages.filter((message) => message.kind === 'progress');
  assert.equal(progress.length, 1);
  assert.equal(actions, 4);
  assert.deepEqual(recipients, new Set([fx.b.id, fx.c.id]));
  assert.ok(!fx.groups.read({ id: room.id }).messages.some((message) => message.content === '这是私有执行草稿'));
  assert.match(JSON.stringify(fx.store.data.groupContexts), /这是私有执行草稿/);
  assert.equal(
    fx.store.data.groupOutbox?.filter((item) => item.content === progress[0].content && item.status === 'sent').length,
    1,
  );
  assert.equal(fx.store.data.messages.length, 0);
  assert.ok(fx.store.data.groupRunMessages.some((message) => message.content === '这是私有执行草稿'));
  assert.equal(fx.store.data.runs.filter((run) => run.botId === fx.a.id).length, 1);
  assert.equal(fx.store.data.runs.find((run) => run.botId === fx.a.id)?.status, 'completed');
  const groupRun = fx.store.data.runs.find((run) => run.botId === fx.a.id && run.groupOrigin)!;
  fx.store.data.artifacts.push({
    id: randomUUID(),
    botId: fx.a.id,
    runId: groupRun.id,
    name: 'GROUP_ONLY_ARTIFACT_TOKEN.csv',
    path: '/groups/work/GROUP_ONLY_ARTIFACT_TOKEN.csv',
    size: 8,
    modifiedAt: new Date().toISOString(),
  });
  await fx.harness.run(fx.a.id, '现在帮我处理私聊');
  assert.doesNotMatch(privateContexts[0], /完成步骤 [1-4]|已完成核对|这是私有执行草稿|GROUP_ONLY_ARTIFACT_TOKEN/);
  assert.ok(privateToolNames.includes('groups_list'));
  assert.ok(!privateToolNames.includes('group_read'));
  assert.ok(fx.store.data.groupRunMessages.some((message) => message.content.includes('完成步骤 4')));
  const privateRun = fx.store.data.runs.find((run) => run.botId === fx.a.id && !run.groupOrigin)!;
  assert.deepEqual(fx.groups.invoke(fx.a.id, privateRun.id, 'groups_list', {}, new AbortController().signal, {}), [
    { id: room.id, name: '工作进度' },
  ]);
});
test('a small-context private run can find a group by name and send without reading its messages', async (t) => {
  let privateTurn = 0;
  const fx = fixture(t, (run, messages, tools) => {
    if (run.groupOrigin) return silent();
    privateTurn++;
    if (privateTurn === 1) {
      assert.ok(tools.some((tool) => tool.function.name === 'groups_list'));
      assert.ok(tools.some((tool) => tool.function.name === 'group_send_message'));
      assert.ok(!tools.some((tool) => tool.function.name === 'group_read'));
      return call('groups_list', {});
    }
    const result = JSON.parse(messages.filter((message) => message.role === 'tool').at(-1)!.content!).result;
    if (privateTurn === 2) {
      assert.deepEqual(result, [{ id: room.id, name: '通知群' }]);
      return call('group_send_message', { groupId: result[0].id, message: '私聊要求发送的通知' });
    }
    assert.ok(result.messageId);
    return answer('已发送。');
  });
  const room = fx.groups.create({ name: '通知群', botIds: [fx.a.id, fx.b.id] });
  await until(fx.settled);
  fx.store.data.model.contextTokens = 8000;
  await fx.harness.run(fx.a.id, '把通知发到通知群');
  await until(fx.settled);
  assert.equal(privateTurn, 3);
  assert.equal(
    fx.groups
      .read({ id: room.id })
      .messages.filter((message) => message.sender.id === fx.a.id && message.content === '私聊要求发送的通知').length,
    1,
  );
});
test('each human or bot message broadcasts equally without aborting busy recipients', async (t) => {
  const releases = new Map<string, (result: Completion) => void>(),
    signals = new Map<string, AbortSignal>();
  let first = true;
  const fx = fixture(t, (run, messages, tools, signal) => {
    assert.ok(tools.some((tool) => tool.function.name === 'group_read'));
    if (first) {
      signals.set(run.botId, signal);
      return new Promise((resolve) => releases.set(run.botId, resolve));
    }
    assert.ok(JSON.stringify(messages).includes('第一份实际结果'));
    return silent();
  });
  const room = fx.groups.create({ name: '广播', botIds: [fx.a.id, fx.b.id, fx.c.id] });
  fx.groups.send({ id: room.id, message: '并行处理' });
  await until(() => releases.size === 3);
  first = false;
  releases.get(fx.a.id)!(call('group_send_message', { groupId: room.id, message: '第一份实际结果' }));
  await until(() => fx.store.data.groups[0].messages.some((m) => m.sender.id === fx.a.id));
  assert.ok(!signals.get(fx.b.id)!.aborted && !signals.get(fx.c.id)!.aborted);
  releases.get(fx.b.id)!(silent());
  releases.get(fx.c.id)!(silent());
  await until(fx.settled);
  const page = fx.groups.read({ id: room.id }),
    reply = page.messages.find((m) => m.sender.id === fx.a.id)!;
  assert.deepEqual(
    page.deliveries
      .filter((d) => d.messageId === reply.id)
      .map((d) => d.recipientId)
      .sort(),
    ['user', fx.b.id, fx.c.id].sort(),
  );
  assert.equal(fx.store.data.runs.filter((r) => r.status === 'cancelled').length, 0);
  assert.equal(fx.store.data.messages.length, 0);
});
test('every member handles a notification even when all choose silence', async (t) => {
  let calls = 0;
  const fx = fixture(t, () => {
    calls++;
    return silent();
  });
  const room = fx.groups.create({ name: '安静', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '谢谢，不用回复' });
  await until(fx.settled);
  assert.equal(calls, 2);
  assert.ok(fx.store.data.groupDeliveries.filter((d) => d.recipientId !== 'user').every((d) => d.status === 'ignored'));
  assert.equal(fx.store.data.groups[0].messages.filter((m) => m.kind === 'message').length, 1);
});
test('busy recipients retain unread events and never automatically import private conversations', async (t) => {
  const seen = new Map<string, string>();
  const fx = fixture(t, (run, messages, tools) => {
    seen.set(run.botId, JSON.stringify(messages));
    assert.ok(!tools.some((t) => t.function.name === 'bot_send_message'));
    return silent();
  });
  fx.store.message(fx.a.id, 'user', '项目路径 A:/alpha，仅A可见');
  fx.store.message(fx.b.id, 'user', '项目路径 B:/beta，仅B可见');
  fx.store.data.conversations[fx.a.id] = [{ role: 'user', content: '主会话原文' }];
  const main = JSON.stringify(fx.store.data.conversations);
  fx.busy.add(fx.a.id);
  const room = fx.groups.create({ name: '交接', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '交接之前的工作' });
  await until(() => seen.has(fx.b.id));
  assert.ok(!seen.has(fx.a.id));
  fx.busy.clear();
  fx.groups.wake();
  await until(fx.settled);
  assert.equal(seen.size, 2);
  for (const context of seen.values()) assert.doesNotMatch(context, /仅A可见|仅B可见|主会话原文/);
  assert.equal(JSON.stringify(fx.store.data.conversations), main);
  assert.ok(fx.store.data.runs.every((r) => r.status === 'completed'));
  assert.equal(fx.store.data.messages.length, 2);
});
test('two Bots stop waking each other after two rounds and whoever spoke first sums up', async (t) => {
  const points = [
    '数据库事务可以保证订单与库存同时落库',
    '但外部支付无法参与数据库事务，应使用状态机',
    '状态机仍要处理回调乱序，建议记录支付事件序号',
    '回调事件也需要幂等键，防止重复发货',
    '发货前校验库存预占是否过期',
    '预占过期后不要直接扣款，先撤销支付授权',
  ];
  let summary = 0;
  const fx = fixture(t, (run, messages) => {
    const room = fx.store.data.groups[0],
      latest = publishedMessages(messages).at(-1),
      other = run.botId === fx.a.id ? fx.b : fx.a;
    if (latest?.sender.kind === 'system' && latest.content.includes('来回')) {
      summary++;
      return answer('结论：订单用状态机，支付回调按事件序号和幂等键处理。');
    }
    // Speak once per wake: A opens after the user, then each answers the other.
    const opening = run.botId === fx.a.id && latest?.sender.kind === 'user';
    if (!opening && latest?.sender.id !== other.id) return silent();
    const n = room.messages.filter((m) => m.sender.kind === 'bot').length;
    return n < points.length
      ? call('group_send_message', { groupId: room.id, message: `@{${other.id}} ${points[n]}` })
      : silent();
  });
  const room = fx.groups.create({ name: '深入讨论', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, fx.a, '深入讨论支付方案');
  await until(fx.settled);
  const messages = fx.store.data.groups[0].messages,
    exchanged = messages.filter((m) => m.sender.kind === 'bot' && m.mentions?.length);
  // Two rounds wake each other; the fifth message is delivered but wakes nobody.
  assert.equal(exchanged.length, 5);
  const notice = messages.find((m) => m.notice === 'pair_limit')!;
  assert.ok(notice);
  assert.equal(notice.mentions?.[0].id, fx.a.id);
  assert.equal(messages.filter((m) => m.notice === 'pair_limit').length, 1);
  assert.equal(summary, 1);
  assert.ok(messages.some((m) => m.sender.id === fx.a.id && m.content.includes('结论：')));
  assert.ok(
    fx.store.data.groupDeliveries.some(
      (d) => d.messageId === exchanged.at(-1)!.id && d.recipientId === fx.b.id && d.status === 'limited',
    ),
  );
});
test('a new user message resets the Bot-to-Bot limits', async (t) => {
  const fx = fixture(t);
  const room = fx.groups.create({ name: '限流重置', botIds: [fx.a.id, fx.b.id] }),
    stored = fx.store.data.groups[0];
  await until(fx.settled);
  fx.busy.add(fx.a.id);
  fx.busy.add(fx.b.id);
  const round = fx.store.data.groupRounds.at(-1)!;
  for (let i = 0; i < 4; i++) {
    const [from, to] = i % 2 ? [fx.b, fx.a] : [fx.a, fx.b];
    (fx.groups as any).append(stored, { kind: 'bot', ...botIdentity(from) }, `@${to.name} 第 ${i + 1} 条`, round, [
      { ...botIdentity(to), start: 0, end: to.name.length + 1 },
    ]);
  }
  (fx.groups as any).pump();
  const limited = fx.store.data.groupDeliveries.find(
    (d) => d.messageId === stored.messages.at(-1)!.id && d.recipientId === fx.a.id,
  )!;
  assert.equal(limited.triage, 'wake');
  fx.ask(room.id, fx.a, '继续讨论');
  (fx.groups as any).append(stored, { kind: 'bot', ...botIdentity(fx.a) }, `@${fx.b.name} 用户发言后的第一条`, round, [
    { ...botIdentity(fx.b), start: 0, end: fx.b.name.length + 1 },
  ]);
  const last = stored.messages.at(-1)!;
  (fx.groups as any).pump();
  const delivery = fx.store.data.groupDeliveries.find((d) => d.messageId === last.id && d.recipientId === fx.b.id)!;
  assert.equal(delivery.triage, 'wake');
  assert.equal(delivery.must, true);
  fx.busy.clear();
});
test('an addressed Bot ending silently is reminded once to answer', async (t) => {
  const seen: string[] = [];
  const fx = fixture(t, (run, messages) => {
    if (run.botId !== fx.a.id) return silent();
    seen.push(JSON.stringify(messages.filter((message) => message.role === 'system').map((m) => m.content)));
    return seen.length === 1
      ? silent()
      : call('group_react', { groupId: run.groupOrigin!.groupId, messageId: question, emoji: '👀' });
  });
  const room = fx.groups.create({ name: '必须回', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, fx.a, '看一下这个问题');
  const question = fx.store.data.groups[0].messages.at(-1)!.id;
  await until(fx.settled);
  assert.match(seen[1], /addressed you and have no answer yet/);
  assert.ok(fx.store.data.groups[0].messages.some((m) => m.kind === 'reaction' && m.sender.id === fx.a.id));
});
test('a reply written while another member answered the same message is reviewed once before publishing', async (t) => {
  let release: (value: Completion) => void = () => {};
  const notes: string[] = [];
  const fx = fixture(t, (run, messages) => {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content || '');
    if (run.botId === fx.b.id) return answer('用 CSV，UTF-8 编码。');
    if (run.botId !== fx.a.id) return silent();
    const note = system.find((content) => content.includes('Before your reply is published'));
    if (note) {
      notes.push(note);
      return answer('补充：文件开头加 BOM，Excel 才不会乱码。');
    }
    return new Promise((resolve) => (release = resolve));
  });
  const room = fx.groups.create({ name: '发前再看', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, [fx.a, fx.b], '导出文件用什么格式？');
  await until(() => fx.store.data.groups[0].messages.some((m) => m.sender.id === fx.b.id));
  release(answer('用 CSV。'));
  await until(fx.settled);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /UTF-8/);
  const replies = fx.store.data.groups[0].messages.filter((m) => m.sender.id === fx.a.id);
  assert.deepEqual(
    replies.map((m) => m.content),
    ['补充：文件开头加 BOM，Excel 才不会乱码。'],
  );
});
test('an unaddressed reply is published directly, and ending without text publishes nothing', async (t) => {
  const fx = fixture(t, (run, messages) => {
    if (publishedMessages(messages).at(-1)?.event) return silent();
    return run.botId === fx.a.id ? answer('我觉得还行。') : silent();
  });
  const room = fx.groups.create({ name: '不点名', botIds: [fx.a.id, fx.b.id] });
  await until(fx.settled);
  fx.groups.send({ id: room.id, message: '随便聊聊' });
  await until(fx.settled);
  const messages = fx.store.data.groups[0].messages,
    question = messages.find((m) => m.content === '随便聊聊')!;
  assert.deepEqual(
    messages.filter((m) => m.sender.kind === 'bot').map((m) => [m.sender.id, m.content, m.replyTo]),
    [[fx.a.id, '我觉得还行。', question.id]],
  );
  assert.ok(fx.store.data.runs.every((run) => run.status === 'completed'));
  assert.equal(
    fx.store.data.groupDeliveries.find((d) => d.messageId === question.id && d.recipientId === fx.b.id)?.status,
    'ignored',
  );
  assert.ok(!messages.some((m) => m.notice === 'unanswered'));
});
test('exact retries are idempotent per sender while each member may express the same conclusion', async (t) => {
  const fx = fixture(t, (_run, messages) =>
    publishedMessages(messages).at(-1)?.event ? silent() : answer('我们已确认采用消息队列进行订单通知。'),
  );
  const room = fx.groups.create({ name: '去重', botIds: [fx.a.id, fx.b.id, fx.c.id] });
  await until(fx.settled);
  fx.ask(room.id, [fx.a, fx.b, fx.c], '讨论通知机制');
  await until(fx.settled);
  assert.equal(fx.store.data.groupRounds.at(-1)!.botMessages, 3);
  assert.equal(
    new Set(fx.store.data.groups[0].messages.filter((m) => m.sender.kind === 'bot').map((m) => m.sender.id)).size,
    3,
  );
});

test('similar opinions and a slower correction are all published without a semantic judge', async (t) => {
  const correction = '更正：暂停按钮没有停止轮子动画，需要修复。';
  const fx = fixture(t, async (run) => {
    const index = fx.store.data.bots.findIndex((b) => b.id === run.botId);
    if (index === 5) {
      await delay(150);
      return answer(correction);
    }
    return answer(groupParaphrases[index]);
  });
  for (let n = 3; n < 6; n++) fx.store.createBot('伙伴' + n, '协作');
  const group = fx.groups.create({ name: '自由讨论', botIds: fx.store.data.bots.map((b) => b.id) });
  fx.ask(group.id, fx.store.data.bots, '这是什么');
  await until(fx.settled);
  const replies = fx.groups.read({ id: group.id }).messages.filter((m) => m.sender.kind === 'bot');
  assert.equal(replies.length, 6);
  assert.ok(replies.some((m) => m.content === correction));
  assert.ok(fx.store.data.runs.every((r) => r.status === 'completed'));
});
test('an explicit vote can receive the same requested answer from each member only once', async (t) => {
  const fx = fixture(t, () => answer('同意'));
  const group = fx.groups.create({ name: '投票', botIds: [fx.a.id, fx.b.id, fx.c.id] });
  fx.ask(group.id, [fx.a, fx.b, fx.c], '请每个人投票表态');
  await until(fx.settled);
  const replies = fx.groups.read({ id: group.id }).messages.filter((message) => message.sender.kind === 'bot');
  assert.equal(replies.length, 3);
  assert.equal(new Set(replies.map((message) => message.sender.id)).size, 3);
});
test('new human events stay in the inbox until a safe boundary without aborting inference', async (t) => {
  const releases: Array<(value: Completion) => void> = [],
    signals: AbortSignal[] = [],
    seen: string[] = [];
  const fx = fixture(t, (_run, messages, _tools, signal) => {
    if (releases.length < 2) {
      signals.push(signal);
      return new Promise((resolve) => releases.push(resolve));
    }
    seen.push(JSON.stringify(messages));
    return silent();
  });
  const room = fx.groups.create({ name: '实时消息', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '旧问题' });
  await until(() => signals.length === 2);
  fx.groups.send({ id: room.id, message: '新的群发事件' });
  assert.ok(signals.every((signal) => !signal.aborted));
  for (const release of releases) release(silent());
  await until(fx.settled);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((text) => text.includes('新的群发事件')));
  assert.ok(fx.store.data.runs.every((r) => r.status === 'completed'));
});
test('a running command finishes once; its result survives interruption and supports handoff', async (t) => {
  let finish: (value: unknown) => void = () => {},
    executions = 0,
    toolSignal: AbortSignal | undefined,
    resumed = false;
  const vm = {
    execute: async (_command: string, signal?: AbortSignal) => {
      executions++;
      toolSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  } as unknown as VmController;
  const fx = fixture(
    t,
    (run, messages) => {
      if (run.botId !== fx.a.id) return silent();
      if (!messages.some((m) => m.role === 'tool')) return call('computer_execute', { command: 'create-report-once' });
      assert.ok(JSON.stringify(messages).includes('/work/completed-report.csv'));
      assert.ok(JSON.stringify(messages).includes('改为向大家交接'));
      resumed = true;
      return answer('报告已完成，文件是 /work/completed-report.csv，接下来核对汇总。');
    },
    vm,
  );
  const room = fx.groups.create({ name: '不中断副作用', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '生成报告' });
  await until(() => executions === 1);
  fx.groups.send({ id: room.id, message: '改为向大家交接报告路径' });
  assert.ok(!toolSignal?.aborted);
  finish({ stdout: '/work/completed-report.csv', stderr: '', exitCode: 0, durationMs: 30 });
  await until(fx.settled);
  assert.equal(executions, 1);
  assert.ok(resumed);
  assert.ok(groupMainContext(fx.store, fx.a.id, 6500, undefined, room.id).includes('/work/completed-report.csv'));
  assert.ok(fx.store.data.groups[0].messages.some((m) => m.content.includes('报告已完成')));
  assert.equal(fx.store.data.messages.filter((m) => m.role === 'user').length, 0);
  assert.ok(!fx.store.data.messages.some((m) => m.groupTaskSource));
  assert.ok(!fx.store.data.messages.some((m) => m.tool === 'computer_execute'));
  assert.ok(fx.store.data.groupRunMessages.some((m) => m.tool === 'computer_execute'));
});
test('explicit group stop withdraws pending permission without executing a file write', async (t) => {
  const fx = fixture(t, (run, messages) =>
    run.botId === fx.a.id && !messages.at(-1)?.content?.includes('不用写了')
      ? call('host_file_write', { path: join(fx.dir, 'obsolete.txt'), content: '测试', reason: '群任务' })
      : silent(),
  );
  const room = fx.groups.create({ name: '过期许可', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '写文件' });
  await until(() => fx.interactions.snapshot().length === 1);
  fx.groups.stop(room.id);
  await until(fx.settled);
  assert.equal(fx.interactions.snapshot().length, 0);
  assert.equal(existsSync(join(fx.dir, 'obsolete.txt')), false);
});
test('membership changes, user stop and resume, unread state and restart remain durable', async (t) => {
  const fx = fixture(t);
  fx.busy.add(fx.a.id);
  fx.busy.add(fx.b.id);
  const room = fx.groups.create({ name: '管理', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '待处理' });
  assert.throws(
    () => fx.groups.invoke(fx.c.id, 'none', 'group_read', { groupId: room.id }, new AbortController().signal, {}),
    { code: 'group.not_member' },
  );
  fx.groups.update({ id: room.id, name: '管理更新', botIds: [fx.a.id, fx.c.id] });
  assert.ok(
    fx.store.data.groupDeliveries.filter((d) => d.recipientId === fx.b.id).every((d) => d.status === 'cancelled'),
  );
  assert.equal(fx.store.data.groupDeliveries.filter((d) => d.recipientId === fx.c.id).length, 1);
  fx.groups.stop(room.id);
  assert.equal(fx.groups.snapshot().rooms[0].round?.status, 'stopped');
  fx.groups.continue(room.id);
  fx.busy.clear();
  fx.groups.wake();
  await until(fx.settled);
  fx.groups.markRead({ id: room.id, seq: fx.groups.read({ id: room.id }).group.lastSeq });
  assert.equal(fx.groups.snapshot().rooms[0].unread, 0);
  const restored = new Store(fx.dir),
    service = new GroupChats(
      restored,
      {
        isRunning: () => false,
        run: async () => {
          throw Error('不能重放');
        },
        cancel: () => {},
      },
      () => {},
    );
  assert.equal(service.snapshot().rooms[0].round?.status, 'stopped');
  service.dispose();
});
test('bot-created groups inherit the real user task and cannot turn broadcast into a private side channel', async (t) => {
  const fx = fixture(t);
  const root: RunRecord = {
    id: randomUUID(),
    botId: fx.a.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  };
  fx.store.data.runs.push(root);
  fx.store.message(fx.a.id, 'user', '组织协作', { runId: root.id });
  const created = fx.groups.invoke(
    fx.a.id,
    root.id,
    'group_create',
    { name: '自主建群', botIds: [fx.b.id], message: '请交接项目' },
    new AbortController().signal,
    {},
  ) as { groupId: string };
  root.status = 'completed';
  await until(fx.settled);
  assert.equal(fx.store.data.groupRounds[0].request, '组织协作');
  assert.ok(fx.store.data.messages.some((m) => m.groupLink?.groupId === created.groupId));
  assert.ok(groupMainContext(fx.store, fx.a.id).includes('组织协作'));
});
test('bursts preserve every individual broadcast event even when processing in batches', async (t) => {
  const seen = new Set<string>();
  const fx = fixture(t, (_run, messages) => {
    for (const event of publishedMessages(messages).filter((event) => event.kind === 'message'))
      seen.add(`${_run.botId}:${event.messageId}`);
    return silent();
  });
  fx.busy.add(fx.a.id);
  fx.busy.add(fx.b.id);
  const room = fx.groups.create({ name: '突发消息', botIds: [fx.a.id, fx.b.id] });
  for (let i = 0; i < 22; i++) fx.groups.send({ id: room.id, message: `广播事件 ${i}` });
  fx.busy.clear();
  fx.groups.wake();
  await until(fx.settled);
  assert.equal(seen.size, 44);
  assert.ok(
    fx.store.data.groupDeliveries
      .filter((d) => fx.store.data.groups[0].messages.find((m) => m.id === d.messageId)?.kind === 'message')
      .every((d) => seen.has(`${d.recipientId}:${d.messageId}`)),
  );
});
test('a Bot @ is persisted as a real member identity and included in every broadcast event', async (t) => {
  let received = false;
  const fx = fixture(t, (run, messages) => {
    const payload = { events: publishedMessages(messages).slice(-1) };
    if (run.botId === fx.a.id && payload.events.some((event: any) => event.sender.kind === 'user'))
      return answer(`@{${fx.b.id}} 请复核报告，@${fx.c.name} 请补充意见。`);
    const direct = payload.events.find((event: any) => event.sender.id === fx.a.id);
    if (run.botId === fx.b.id && direct) {
      assert.equal(direct.mentioned, true);
      assert.equal(direct.mentions[0].id, fx.b.id);
      received = true;
    }
    return silent();
  });
  const room = fx.groups.create({ name: '点名协作', botIds: [fx.a.id, fx.b.id, fx.c.id] });
  fx.ask(room.id, fx.a, '分派复核任务');
  await until(fx.settled);
  const reply = fx.groups.read({ id: room.id }).messages.find((message) => message.sender.id === fx.a.id)!;
  assert.deepEqual(
    reply.mentions?.map((mention) => mention.id),
    [fx.b.id, fx.c.id],
  );
  assert.ok(!reply.content.includes('@{'));
  assert.ok(received);
  assert.equal(fx.store.data.groupDeliveries.filter((d) => d.messageId === reply.id).length, 3);
  const reopened = new Store(fx.dir);
  assert.deepEqual(reopened.data.groups[0].messages.find((m) => m.id === reply.id)?.mentions, reply.mentions);
});
test('invalid Bot mention formatting is repaired without repeating successful work', async (t) => {
  let writes = 0,
    answers = 0;
  const vm = {
    execute: async () => {
      writes++;
      return { stdout: 'report ready', stderr: '', exitCode: 0, durationMs: 1 };
    },
  } as unknown as VmController;
  const fx = fixture(
    t,
    (run, messages) => {
      if (run.botId !== fx.a.id) return silent();
      if (!run.toolCalls) return call('computer_execute', { command: 'create-once' });
      if (answers++ === 0) return answer('@{not-a-member} 请检查');
      assert.ok(JSON.stringify(messages).includes('身份检查未通过'));
      return answer(`@{${fx.b.id}} 文件已生成，请检查。`);
    },
    vm,
  );
  const room = fx.groups.create({ name: '身份核对', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '生成一次并交接' });
  await until(fx.settled);
  assert.equal(writes, 1);
  assert.equal(
    fx.groups.read({ id: room.id }).messages.find((m) => m.sender.id === fx.a.id)?.mentions?.[0].id,
    fx.b.id,
  );
});
test('group tool messages can address different same-name Bots without being deduplicated', async (t) => {
  const fx = fixture(t);
  fx.c.name = fx.b.name;
  const room = fx.groups.create({ name: '同名点名', botIds: [fx.a.id, fx.b.id, fx.c.id] });
  const root: RunRecord = {
    id: randomUUID(),
    botId: fx.a.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  };
  fx.store.data.runs.push(root);
  fx.store.message(fx.a.id, 'user', '请分别点名两位成员', { runId: root.id });
  for (const target of [fx.b, fx.c])
    fx.groups.invoke(
      fx.a.id,
      root.id,
      'group_send_message',
      { groupId: room.id, message: `@{${target.id}} 请检查` },
      new AbortController().signal,
      {},
    );
  root.status = 'completed';
  await until(fx.settled);
  const messages = fx.groups.read({ id: room.id }).messages.filter((message) => message.sender.id === fx.a.id);
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((m) => m.mentions?.[0].id),
    [fx.b.id, fx.c.id],
  );
});
test('group work and its private execution records stay inside the group context', async (t) => {
  let finish: (value: unknown) => void = () => {};
  const vm = {
    execute: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  } as unknown as VmController;
  const fx = fixture(
    t,
    (run) =>
      run.botId !== fx.a.id
        ? silent()
        : run.toolCalls
          ? answer('任务完成，已生成报告。')
          : call('computer_execute', { command: 'generate-report' }),
    vm,
  );
  const room = fx.groups.create({ name: '项目组', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '请生成报告' });
  await until(() => fx.store.data.groupRunMessages.some((m) => m.role === 'tool' && m.status === 'running'));
  const run = fx.store.data.runs.find((r) => r.botId === fx.a.id && r.status === 'running')!;
  assert.equal(run.groupTask, undefined);
  assert.ok(!fx.store.data.messages.some((m) => m.runId === run.id));
  assert.equal(conversationTimeline(fx.store.data.messages).length, 0);
  finish({ stdout: 'report ready', stderr: '', exitCode: 0, durationMs: 1 });
  await until(fx.settled);
  assert.ok(
    fx.store.data.groupRunMessages.some(
      (m) => m.runId === run.id && m.presentation === 'answer' && m.content === '任务完成，已生成报告。',
    ),
  );
  assert.ok(fx.groups.read({ id: room.id }).messages.some((m) => m.content === '任务完成，已生成报告。'));
  assert.equal(fx.store.data.messages.filter((m) => m.botId === fx.b.id).length, 0);
  assert.equal(fx.store.data.messages.filter((m) => m.role === 'user').length, 0);
});
test('another Bot event joins the existing work without restarting tools or duplicating the task', async (t) => {
  let executions = 0,
    finish: (value: unknown) => void = () => {};
  const vm = {
    execute: async () => {
      executions++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  } as unknown as VmController;
  const fx = fixture(
    t,
    async (run, messages) => {
      const payload = { events: publishedMessages(messages).slice(-1) };
      if (run.botId === fx.b.id) {
        if (payload.events?.some((e: any) => e.sender.kind === 'user')) {
          await until(() => executions === 1);
          return call('group_send_message', { groupId: run.groupOrigin!.groupId, message: '补充：报告中请保留总计。' });
        }
        return silent();
      }
      return messages.some((m) => m.role === 'tool')
        ? answer('已完成报告，并保留总计。')
        : call('computer_execute', { command: 'run-once' });
    },
    vm,
  );
  const room = fx.groups.create({ name: '续接', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '生成报告' });
  await until(() => fx.store.data.groups[0].messages.some((m) => m.sender.id === fx.b.id));
  finish({ stdout: 'done', stderr: '', exitCode: 0, durationMs: 1 });
  await until(fx.settled);
  assert.equal(executions, 1);
  assert.equal(fx.store.data.messages.filter((m) => m.botId === fx.a.id && m.groupTaskSource).length, 0);
  assert.ok(!fx.store.data.messages.some((m) => m.content === '已完成报告，并保留总计。'));
  assert.ok(fx.store.data.groupRunMessages.some((m) => m.content === '已完成报告，并保留总计。'));
  assert.ok(!fx.store.data.runs.some((r) => r.groupUpdated));
});
test('historical group work migrates out of private history once without replaying tools', async (t) => {
  const fx = fixture(t);
  fx.busy.add(fx.a.id);
  fx.busy.add(fx.b.id);
  const room = fx.groups.create({ name: '旧群任务', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '旧任务：创建表格' });
  const delivery = fx.store.data.groupDeliveries.find(
    (d) =>
      d.recipientId === fx.a.id &&
      fx.store.data.groups[0].messages.find((m) => m.id === d.messageId)?.kind === 'message',
  )!;
  const work: RunRecord = {
    id: randomUUID(),
    botId: fx.a.id,
    status: 'completed',
    startedAt: new Date().toISOString(),
    toolCalls: 1,
    modelCalls: 2,
    groupOrigin: { groupId: room.id, rootId: delivery.rootId, deliveryId: delivery.id },
  };
  fx.store.data.runs.push(work);
  const legacy = (message: ReturnType<Store['message']>) => {
    fx.store.data.groupRunMessages = fx.store.data.groupRunMessages.filter((item) => item.id !== message.id);
    fx.store.data.messages.push(message);
    return message;
  };
  const tool = legacy(
    fx.store.message(fx.a.id, 'tool', '{"result":{"stdout":"old report"}}', {
      runId: work.id,
      tool: 'computer_execute',
      status: 'done',
    }),
  );
  legacy(
    fx.store.message(fx.a.id, 'event', '旧表格已完成', {
      runId: work.id,
      groupTaskSource: { groupId: room.id, name: room.name },
    }),
  );
  legacy(
    fx.store.message(fx.a.id, 'assistant', '旧表格已完成', { runId: work.id, presentation: 'answer', status: 'done' }),
  );
  const chat: RunRecord = { ...work, id: randomUUID(), toolCalls: 0 };
  fx.store.data.runs.push(chat);
  const chatter = legacy(
    fx.store.message(fx.a.id, 'assistant', '普通群聊发言', { runId: chat.id, presentation: 'answer', status: 'done' }),
  );
  fx.store.save();
  const restored = new Store(fx.dir);
  assert.ok(!restored.data.messages.some((m) => m.runId === work.id || m.runId === chat.id));
  assert.ok(restored.data.groupRunMessages.some((m) => m.id === tool.id));
  assert.equal(restored.data.groupRunMessages.filter((m) => m.groupTaskSource).length, 1);
  assert.ok(restored.data.groupRunMessages.some((m) => m.id === chatter.id));
  assert.ok(existsSync(join(fx.dir, 'group-task-visibility-backup.json')));
  const again = new Store(fx.dir);
  assert.equal(again.data.groupRunMessages.filter((m) => m.id === tool.id).length, 1);
  assert.equal(again.data.groupRunMessages.filter((m) => m.groupTaskSource).length, 1);
  assert.deepEqual(again.data.groups, restored.data.groups);
});

test('a completed reply keeps its original reply target when another message arrives before publication', async (t) => {
  let first = true,
    held = false,
    release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fx = fixture(t, (run, _messages) => {
    if (run.botId !== fx.a.id) return silent();
    if (first) {
      first = false;
      return answer('原问题的完整答复');
    }
    return silent();
  });
  const runner = (fx.groups as any).runner,
    original = runner.run;
  runner.run = async (id: string, input: string, options: any) => {
    await original(id, input, options);
    if (id === fx.a.id && !held) {
      held = true;
      await gate;
    }
  };
  const room = fx.groups.create({ name: '发布前被抢话', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, fx.a, '旧问题');
  await until(() => held);
  fx.groups.send({ id: room.id, message: '补充一个新问题' });
  release();
  await until(fx.settled);
  assert.ok(JSON.stringify(fx.store.data.groupContexts).includes('原问题的完整答复'));
  const page = fx.groups.read({ id: room.id }),
    reply = page.messages.find((m) => m.content === '原问题的完整答复')!;
  assert.ok(reply);
  assert.equal(page.messages.find((m) => m.id === reply.replyTo)?.content, `@${fx.a.name} 旧问题`);
  for (const history of Object.values(fx.store.data.groupContexts)) {
    const ids = history.filter((m) => m.groupMessageId).map((m) => m.groupMessageId);
    assert.equal(ids.length, new Set(ids).size);
  }
});

test('a Bot reaction is delivered to everyone, wakes nobody, retains tool pairing, and answers the message', async (t) => {
  const fx = fixture(t, (run, messages) => {
    const latest = publishedMessages(messages).at(-1);
    if (run.botId === fx.a.id && latest?.sender.kind === 'user')
      return call('group_react', { groupId: run.groupOrigin!.groupId, messageId: latest.messageId, emoji: '👍' });
    return silent();
  });
  const room = fx.groups.create({ name: '表态', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, fx.a, '这个方案我觉得可以');
  await until(fx.settled);
  const page = fx.groups.read({ id: room.id }),
    reaction = page.messages.find((m) => m.kind === 'reaction')!,
    target = page.messages.find((m) => m.kind === 'message')!;
  assert.ok(
    page.deliveries
      .filter((d) => d.messageId === reaction.id && d.recipientId !== 'user')
      .every((d) => d.status === 'ignored' && d.triage === 'skip'),
  );
  // The reaction answered the @, so there was no reminder and no extra text reply.
  assert.ok(!page.messages.some((m) => m.sender.id === fx.a.id && m.kind === 'message'));
  assert.equal(target.pins?.[0].actor.id, fx.a.id);
  assert.equal(reaction.reaction?.messageId, target.id);
  assert.equal(page.messages.filter((m) => m.sender.kind === 'bot').length, 1);
  assert.deepEqual(
    page.deliveries
      .filter((d) => d.messageId === reaction.id)
      .map((d) => d.recipientId)
      .sort(),
    ['user', fx.b.id].sort(),
  );
  const history = fx.store.data.groupContexts['group:' + room.id + ':' + fx.a.id],
    at = history.findIndex((m) => m.tool_calls?.some((c) => c.function.name === 'group_react'));
  assert.ok(at >= 0);
  assert.equal(history[at + 1].role, 'tool');
  assert.equal(history[at].tool_calls?.[0].id, history[at + 1].tool_call_id);
  assert.ok(!fx.store.data.runs.some((r) => r.botId === fx.a.id && r.groupTask));
});

test('wrapped group-silence markers suppress reaction chatter instead of publishing the explanation', async (t) => {
  const fx = fixture(t, (run, messages) => {
    const latest = publishedMessages(messages).at(-1);
    if (latest?.kind === 'reaction')
      return answer(
        run.botId === fx.a.id
          ? '介绍已经发出，没有新问题，先不补话。[群聊静默]'
          : 'Mi 只是点了赞，没有新问题，不必再回。[群聊静默]',
      );
    if (run.botId === fx.a.id && latest?.sender.kind === 'user' && latest.kind === 'message')
      return answer('盖世游戏是一个跨平台游戏服务。');
    return silent();
  });
  const room = fx.groups.create({ name: '静默标记', botIds: [fx.a.id, fx.b.id] });
  fx.ask(room.id, fx.a, '介绍一下盖世游戏是什么平台');
  await until(fx.settled);
  const before = fx.groups.read({ id: room.id }).messages,
    reply = before.find((message) => message.sender.id === fx.a.id && message.kind === 'message')!;
  assert.ok(reply);
  fx.groups.pinUser({ groupId: room.id, messageId: reply.id, emoji: '👍' });
  await until(fx.settled);
  const page = fx.groups.read({ id: room.id }),
    botMessages = page.messages.filter((message) => message.sender.kind === 'bot');
  assert.equal(botMessages.length, before.filter((message) => message.sender.kind === 'bot').length);
  assert.ok(!page.messages.some((message) => message.content.includes('[群聊静默]')));
  const reaction = page.messages.find((message) => message.kind === 'reaction')!;
  assert.ok(
    page.deliveries
      .filter((delivery) => delivery.messageId === reaction.id && delivery.recipientId !== 'user')
      .every((delivery) => delivery.status === 'ignored'),
  );
});

test('user group pins add and remove once, refresh old message badges and cannot target reactions or foreign groups', async (t) => {
  let reactionsSeen = 0;
  const fx = fixture(t, (_run, messages) => {
    if (publishedMessages(messages).at(-1)?.kind === 'reaction') reactionsSeen++;
    return silent();
  });
  const room = fx.groups.create({ name: '用户表态', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '先讨论一下' });
  await until(fx.settled);
  const target = fx.groups.read({ id: room.id }).messages.find((m) => m.kind === 'message')!;
  fx.groups.pinUser({ groupId: room.id, messageId: target.id, emoji: '👀' });
  fx.groups.pinUser({ groupId: room.id, messageId: target.id, emoji: '👀' });
  await until(fx.settled);
  let page = fx.groups.read({ id: room.id });
  assert.equal(page.messages.filter((m) => m.kind === 'reaction').length, 1);
  // Reactions are delivered but wake nobody.
  assert.equal(reactionsSeen, 0);
  assert.equal(page.pins?.[target.id][0].actor.id, 'user');
  const reopened = new Store(fx.dir);
  assert.equal(reopened.data.groups[0].messages.find((m) => m.id === target.id)?.pins?.[0].emoji, '👀');
  assert.throws(() => fx.groups.pinUser({ groupId: room.id, messageId: page.messages.at(-1)!.id, emoji: '👍' }), {
    code: 'group.reaction_target_invalid',
  });
  const other = fx.groups.create({ name: '另一个群', botIds: [fx.a.id, fx.b.id] });
  assert.throws(() => fx.groups.pinUser({ groupId: other.id, messageId: target.id, emoji: '👍' }), {
    code: 'group.reaction_target_invalid',
  });
  fx.groups.pinUser({ groupId: room.id, messageId: target.id, emoji: '👀', remove: true });
  await until(fx.settled);
  page = fx.groups.read({ id: room.id });
  assert.equal(page.messages.filter((m) => m.kind === 'reaction').length, 2);
  assert.equal(page.pins?.[target.id], undefined);
  assert.equal(reactionsSeen, 0);
});

test('creating a group broadcasts one persisted lifecycle event to every member and the model receives its identities', async (t) => {
  const seen: string[] = [];
  const fx = fixture(t, (run, messages) => {
    const event = publishedMessages(messages).find((message) => message.event);
    assert.equal(event.kind, 'system');
    assert.equal(event.event.type, 'created');
    assert.equal(event.event.actor.kind, 'user');
    assert.deepEqual(
      event.event.members.map((member: any) => member.id),
      [fx.a.id, fx.b.id],
    );
    seen.push(run.botId);
    return silent();
  });
  const group = fx.groups.create({ name: '创建事件', botIds: [fx.a.id, fx.b.id] });
  await until(fx.settled);
  const page = fx.groups.read({ id: group.id }),
    events = page.messages.filter((message) => message.event);
  assert.equal(events.length, 1);
  assert.equal(events[0].event!.left.length, 0);
  assert.deepEqual(page.deliveries.map((delivery) => delivery.recipientId).sort(), ['user', fx.a.id, fx.b.id].sort());
  assert.deepEqual(seen.sort(), [fx.a.id, fx.b.id].sort());
  fx.groups.wake();
  fx.groups.read({ id: group.id });
  await settle();
  assert.equal(seen.length, 2);
  assert.equal(fx.groups.read({ id: group.id }).messages.length, 1);
  const restored = new Store(fx.dir),
    before = restored.data.groupDeliveries.length;
  const service = new GroupChats(
    restored,
    {
      isRunning: () => false,
      run: async () => {
        throw Error('不能重播创建事件');
      },
      cancel: () => {},
    },
    () => {},
  );
  service.start();
  await settle();
  assert.equal(restored.data.groupDeliveries.length, before);
  assert.equal(restored.data.groups[0].messages.filter((message) => message.event).length, 1);
  service.dispose();
});

test('one membership save combines joins and removals and broadcasts only to the resulting members', async (t) => {
  const seen: Array<{ botId: string; event: any }> = [];
  const fx = fixture(t, (run, messages) => {
    seen.push({ botId: run.botId, event: publishedMessages(messages).at(-1)?.event });
    return silent();
  });
  const d = fx.store.createBot('新成员', '协作'),
    group = fx.groups.create({ name: '成员事件', botIds: [fx.a.id, fx.b.id] });
  await until(fx.settled);
  seen.length = 0;
  fx.groups.update({ id: group.id, name: group.name, botIds: [fx.a.id, fx.c.id, d.id] });
  await until(fx.settled);
  const page = fx.groups.read({ id: group.id }),
    event = page.messages.find((message) => message.event?.type === 'members_changed')!;
  assert.ok(event);
  assert.equal(page.messages.filter((message) => message.event?.type === 'members_changed').length, 1);
  assert.deepEqual(
    event.event!.joined.map((bot) => bot.id),
    [fx.c.id, d.id],
  );
  assert.deepEqual(
    event.event!.left.map((bot) => bot.id),
    [fx.b.id],
  );
  assert.deepEqual(
    event.event!.members.map((bot) => bot.id),
    [fx.a.id, fx.c.id, d.id],
  );
  assert.deepEqual(
    page.deliveries
      .filter((delivery) => delivery.messageId === event.id)
      .map((delivery) => delivery.recipientId)
      .sort(),
    ['user', fx.a.id, fx.c.id, d.id].sort(),
  );
  assert.deepEqual(seen.map((item) => item.botId).sort(), [fx.a.id, fx.c.id, d.id].sort());
  assert.ok(seen.every((item) => item.event.type === 'members_changed'));
  const count = fx.store.data.groupDeliveries.length;
  fx.groups.update({ id: group.id, name: group.name, botIds: [d.id, fx.a.id, fx.c.id] });
  fx.groups.update({ id: group.id, name: '仅改群名', botIds: [fx.a.id, fx.c.id, d.id] });
  await settle();
  assert.equal(fx.store.data.groupDeliveries.length, count);
  fx.groups.update({ id: group.id, name: '仅改群名', botIds: [fx.a.id, fx.b.id, fx.c.id, d.id] });
  await until(fx.settled);
  assert.deepEqual(
    fx.groups
      .read({ id: group.id })
      .messages.at(-1)!
      .event!.joined.map((bot) => bot.id),
    [fx.b.id],
  );
});

test('membership changes cancel only the removed member and queue the event for others', async (t) => {
  const aborted = new Set<string>(),
    signals = new Map<string, AbortSignal>();
  let release: (value: Completion) => void = () => {};
  const fx = fixture(t, async (run, messages, _tools, signal) => {
    if (publishedMessages(messages).at(-1)?.kind === 'message') {
      signals.set(run.botId, signal);
      if (run.botId === fx.a.id)
        return new Promise((resolve) => {
          release = resolve;
        });
      try {
        return await waitAbort(signal);
      } finally {
        aborted.add(run.botId);
      }
    }
    return silent();
  });
  const group = fx.groups.create({ name: '成员变动', botIds: [fx.a.id, fx.b.id] });
  await until(fx.settled);
  fx.groups.send({ id: group.id, message: '等待分工' });
  await until(() => signals.size === 2);
  fx.groups.update({ id: group.id, name: group.name, botIds: [fx.a.id, fx.c.id] });
  assert.equal(signals.get(fx.a.id)!.aborted, false);
  release(silent());
  await until(fx.settled);
  assert.deepEqual(aborted, new Set([fx.b.id]));
  const page = fx.groups.read({ id: group.id }),
    event = page.messages.at(-1)!;
  assert.equal(event.event?.type, 'members_changed');
  assert.ok(!page.deliveries.some((d) => d.messageId === event.id && d.recipientId === fx.b.id));
});
test('Bot creation and invitations broadcast once with the true actor and deletion notifies remaining members', async (t) => {
  const fx = fixture(t),
    run: RunRecord = {
      id: randomUUID(),
      botId: fx.a.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      modelCalls: 0,
      toolCalls: 0,
    };
  fx.store.data.runs.push(run);
  fx.store.message(fx.a.id, 'user', '创建群聊并邀请伙伴', { runId: run.id });
  const { groupId } = fx.groups.invoke(
    fx.a.id,
    run.id,
    'group_create',
    { name: 'Bot 建群', botIds: [fx.b.id], message: '一起协作' },
    new AbortController().signal,
    {},
  ) as { groupId: string };
  let page = fx.groups.read({ id: groupId });
  const created = page.messages.find((message) => message.event?.type === 'created')!;
  assert.equal(created.event!.actor.id, fx.a.id);
  assert.equal(created.event!.actor.kind, 'bot');
  assert.ok(page.deliveries.some((delivery) => delivery.messageId === created.id && delivery.recipientId === fx.a.id));
  assert.equal(fx.store.data.groupRounds.find((round) => round.id === created.rootId)?.request, '创建群聊并邀请伙伴');
  fx.groups.invoke(fx.a.id, run.id, 'group_invite', { groupId, botIds: [fx.c.id] }, new AbortController().signal, {});
  const count = fx.store.data.groupDeliveries.length;
  fx.groups.invoke(fx.a.id, run.id, 'group_invite', { groupId, botIds: [fx.c.id] }, new AbortController().signal, {});
  assert.equal(fx.store.data.groupDeliveries.length, count);
  run.status = 'completed';
  await until(fx.settled);
  page = fx.groups.read({ id: groupId });
  const invite = page.messages.find((message) => message.event?.type === 'members_changed')!;
  assert.equal(invite.event!.actor.id, fx.a.id);
  assert.deepEqual(
    invite.event!.joined.map((bot) => bot.id),
    [fx.c.id],
  );
  fx.groups.deletingBot(fx.b.id);
  fx.store.deleteBot(fx.b.id);
  await until(fx.settled);
  page = fx.groups.read({ id: groupId });
  const removed = page.messages.at(-1)!;
  assert.deepEqual(
    removed.event!.left.map((bot) => bot.id),
    [fx.b.id],
  );
  assert.deepEqual(
    page.deliveries
      .filter((delivery) => delivery.messageId === removed.id)
      .map((delivery) => delivery.recipientId)
      .sort(),
    ['user', fx.a.id, fx.c.id].sort(),
  );
});

test('a group member can retrieve its own private history on demand without copying it into the public log or DM context', async (t) => {
  let step = 0;
  const contexts: string[] = [];
  const fx = fixture(
    t,
    (run, messages, tools) => {
      if (run.botId !== fx.a.id) return silent();
      contexts.push(JSON.stringify(messages));
      assert.ok(tools.some((t) => t.function.name === 'history_search'));
      if (step++ === 0) return call('history_search', { query: 'ALPHA_PRIVATE_DETAIL' });
      if (step === 2) return call('history_read', { messageId: source.id, before: 0, after: 0 });
      return answer('根据之前的核对经验，建议补查汇总口径。');
    },
    undefined,
    true,
  );
  const source = fx.store.message(fx.a.id, 'user', 'ALPHA_PRIVATE_DETAIL 仅限本人参考');
  fx.store.message(fx.b.id, 'user', 'BETA_PRIVATE_DETAIL');
  fx.store.data.conversations[fx.a.id] = [{ role: 'user', content: source.content }];
  const before = JSON.stringify(fx.store.data.conversations);
  const room = fx.groups.create({ name: '按需回查', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '请结合你之前的核对经验补充建议' });
  await until(fx.settled);
  assert.doesNotMatch(contexts[0], /ALPHA_PRIVATE_DETAIL|BETA_PRIVATE_DETAIL/);
  assert.match(contexts[1], /ALPHA_PRIVATE_DETAIL/);
  assert.ok(contexts.every((text) => !text.includes('BETA_PRIVATE_DETAIL')));
  assert.ok(fx.store.data.runs.every((r) => r.status === 'completed'));
  assert.doesNotMatch(JSON.stringify(fx.store.data.groups[0].messages), /ALPHA_PRIVATE_DETAIL|BETA_PRIVATE_DETAIL/);
  assert.equal(JSON.stringify(fx.store.data.conversations), before);
});

test('a private input that supersedes group work does not inherit the group plan or context', async (t) => {
  const fx = fixture(t, (run) => (run.groupOrigin ? answer('收到') : answer('私聊答复')));
  const group = fx.groups.create({ name: '群工作', botIds: [fx.a.id, fx.b.id] });
  fx.ask(group.id, fx.a, '开始群工作');
  await until(fx.settled);
  const previous = fx.store.data.runs.find((r) => r.botId === fx.a.id)!;
  previous.workItemId = 'group-plan';
  fx.store.data.workItems!.push({
    id: 'group-plan',
    botId: fx.a.id,
    scope: { kind: 'group', id: group.id },
    kind: 'goal',
    objective: 'GROUP_ONLY_WORK',
    status: 'paused',
    createdBy: 'bot',
    createdAt: previous.startedAt,
    updatedAt: previous.startedAt,
    runIds: [previous.id],
  });
  await fx.harness.run(fx.a.id, '新的私聊问题', { supersedesRunId: previous.id });
  const current = fx.store.data.runs.at(-1)!;
  assert.equal(current.status, 'completed');
  assert.equal(current.workItemId, undefined);
  assert.equal(current.supersedesRunId, undefined);
  assert.doesNotMatch(JSON.stringify(fx.store.data.conversations[fx.a.id]), /GROUP_ONLY_WORK/);
  assert.equal(fx.store.data.workItems![0].status, 'paused');
});

test('yielding to private chat retains the group inbox and resumes successful tool work exactly once', async (t) => {
  let executions = 0,
    finish: (value: unknown) => void = () => {};
  const vm = {
    execute: async () => {
      executions++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  } as unknown as VmController;
  const fx = fixture(
    t,
    (run, messages) => {
      if (!run.groupOrigin) return answer('PRIVATE_REPLY');
      if (run.botId !== fx.a.id) return silent();
      return messages.some((m) => m.role === 'tool')
        ? answer('群工作已完成')
        : call('computer_execute', { command: 'once' });
    },
    vm,
  );
  const room = fx.groups.create({ name: '私聊优先', botIds: [fx.a.id, fx.b.id] });
  fx.groups.send({ id: room.id, message: '完成群工作' });
  await until(() => executions === 1);
  fx.busy.add(fx.a.id);
  fx.groups.yieldToUser(fx.a.id);
  finish({ stdout: 'saved', stderr: '', exitCode: 0, durationMs: 1 });
  await until(() => !fx.groups.busy && !fx.harness.busy);
  const queued = fx.store.data.groupDeliveries.filter((d) => d.recipientId === fx.a.id && d.triage === 'wake');
  assert.ok(queued.length && queued.every((d) => d.status === 'queued'));
  await fx.harness.run(fx.a.id, 'PRIVATE_QUESTION');
  fx.busy.clear();
  fx.groups.wake();
  await until(fx.settled);
  assert.equal(executions, 1);
  assert.ok(fx.groups.read({ id: room.id }).messages.some((m) => m.content === '群工作已完成'));
  assert.doesNotMatch(JSON.stringify(fx.store.data.groupContexts), /PRIVATE_QUESTION|PRIVATE_REPLY/);
  assert.doesNotMatch(JSON.stringify(fx.store.data.conversations[fx.a.id]), /群工作已完成/);
});
