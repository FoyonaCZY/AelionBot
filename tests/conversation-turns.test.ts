import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTimeline } from '../shared/chat/activity';
import { conversationTurns, previewText } from '../shared/chat/conversation-turns';
import { errorCode } from '../shared/errors';
import { normalizeAppearance } from '../shared/preview/appearance';
import type { ChatMessage, RunRecord } from '../shared/types/core';
import { markMessage } from '../electron/core/agent/message-marks';
import { Store } from '../electron/core/storage/store';
import { tempDir } from './helpers';

let serial = 0;
const message = (fields: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage => ({
  id: 'm' + ++serial,
  botId: 'bot-a',
  time: new Date(Date.UTC(2026, 10, 1, 8, serial)).toISOString(),
  ...fields,
});
const run = (id: string, status: RunRecord['status'] = 'completed'): RunRecord => ({
  id,
  botId: 'bot-a',
  status,
  startedAt: new Date(Date.UTC(2026, 10, 1, 8)).toISOString(),
  modelCalls: 1,
  toolCalls: 0,
});
const turnsOf = (messages: ChatMessage[], runs: RunRecord[]) =>
  conversationTurns(conversationTimeline(messages), new Map(runs.map((item) => [item.id, item])));

test('each thing the user said is a turn with the answer it got, as plain text', () => {
  serial = 0;
  const messages = [
    message({ role: 'assistant', content: '你好，我是阿尔法。', runId: 'r0', presentation: 'answer' }),
    message({
      role: 'user',
      content: '**先做**一个 [模板](https://example.com)\n\n看看效果',
      runId: 'r1',
      marked: true,
    }),
    message({ role: 'assistant', content: '先找素材。', runId: 'r1', presentation: 'progress' }),
    message({ role: 'tool', content: '{}', runId: 'r1', tool: 'web_search' }),
    message({ role: 'assistant', content: '## 计划\n\n- 选歌\n- `建模板`', runId: 'r1', presentation: 'answer' }),
    message({ role: 'event', content: '工作电脑已启动' }),
    message({ role: 'user', content: '👍', reaction: { messageId: 'm5', emoji: '👍', removed: false } }),
    message({ role: 'user', content: '换一首', runId: 'r2' }),
    message({ role: 'assistant', content: '正在找', runId: 'r2', status: 'running' }),
  ];
  const turns = turnsOf(messages, [run('r0'), run('r1'), run('r2', 'running')]);
  assert.deepEqual(
    turns.map(({ id, prompt, reply, marked }) => ({ id, prompt, reply, marked })),
    [
      { id: 'm1', prompt: '', reply: '你好，我是阿尔法。', marked: false },
      { id: 'm2', prompt: '先做一个 模板 看看效果', reply: '计划 选歌 建模板', marked: true },
      { id: 'm8', prompt: '换一首', reply: '', marked: false },
    ],
  );
  for (const turn of turns) assert.ok(turn.weight > 0 && turn.weight <= 1);
});

test('an automation turn is named by its title, a file-only message by its files', () => {
  serial = 0;
  const turns = turnsOf(
    [
      message({
        role: 'user',
        content: '把今天的新闻整理成摘要',
        scheduled: { taskId: 't1', occurrenceId: 'o1', title: '每日新闻', scheduledFor: '2026-11-01T08:00:00.000Z' },
      }),
      message({
        role: 'user',
        content: '',
        attachments: [{ id: 'a', name: '报告.pdf', size: 1, mime: 'application/pdf' }],
      }),
    ],
    [],
  );
  assert.deepEqual(
    turns.map((turn) => turn.prompt),
    ['每日新闻', '报告.pdf'],
  );
});

test('longer turns weigh more, and previews stay short', () => {
  serial = 0;
  const [short, long] = turnsOf(
    [message({ role: 'user', content: '好' }), message({ role: 'user', content: '很长的需求。'.repeat(400) })],
    [],
  );
  assert.ok(short.weight < long.weight && long.weight <= 1);
  assert.ok(long.prompt.length <= 281 && long.prompt.endsWith('…'));
  assert.equal(previewText('```js\nconsole.log(1)\n```'), 'console.log(1)');
  assert.equal(previewText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |'), '甲 乙 1 2');
});

test('marks persist on the message, toggle idempotently and reject what is not in the chat', (t) => {
  const dir = tempDir(t, 'aelion-mark-test-'),
    store = new Store(dir),
    bot = store.data.bots[0];
  const target = store.message(bot.id, 'assistant', '报告已经完成', { status: 'done' });
  assert.equal(markMessage(store, { botId: bot.id, messageId: target.id, marked: true }), true);
  assert.equal(markMessage(store, { botId: bot.id, messageId: target.id, marked: true }), false);
  store.close();
  const reopened = new Store(dir);
  assert.equal(reopened.data.messages.find((item) => item.id === target.id)?.marked, true);
  assert.equal(markMessage(reopened, { botId: bot.id, messageId: target.id, marked: false }), true);
  assert.equal(reopened.data.messages.find((item) => item.id === target.id)?.marked, undefined);
  assert.throws(
    () => markMessage(reopened, { botId: bot.id, messageId: 'missing', marked: true }),
    (error) => errorCode(error) === 'chat.mark_target_missing',
  );
  assert.throws(
    () => markMessage(reopened, { botId: bot.id, messageId: target.id, marked: 'yes' as unknown as boolean }),
    (error) => errorCode(error) === 'chat.mark_invalid',
  );
  reopened.close();
});

test('the conversation rail setting is still unless asked to move with the sound', () => {
  assert.equal(normalizeAppearance(undefined).conversationRail, 'static');
  assert.equal(normalizeAppearance({ conversationRail: 'disco' }).conversationRail, 'static');
  assert.equal(normalizeAppearance({ conversationRail: 'audio' }).conversationRail, 'audio');
  assert.equal(normalizeAppearance({ conversationRail: 'hidden' }).conversationRail, 'hidden');
});
