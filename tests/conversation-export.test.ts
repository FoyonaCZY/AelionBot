import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationMarkdown } from '../electron/core/app/conversations';
import { Store } from '../electron/core/storage/store';
import {
  conversationExportName,
  exportBotConversation,
  exportGroupConversation,
} from '../shared/chat/conversation-export';
import { errorCode } from '../shared/errors';
import type { ChatMessage, RunRecord } from '../shared/types/core';
import type { GroupMessage } from '../shared/types/group-types';
import { tempDir } from './helpers';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 8, minute)).toISOString();
/** The UTC clock time, so the expected text does not depend on where the test runs. */
const formatTime = (time: string) => time.slice(0, 16).replace('T', ' ');
const options = { title: '阿尔法', userName: '小周', exportedAt: at(59), formatTime };
let serial = 0;
const message = (fields: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage => ({
  id: 'm' + ++serial,
  botId: 'bot-a',
  time: at(serial),
  ...fields,
});
const run = (id: string, status: RunRecord['status'] = 'completed'): RunRecord => ({
  id,
  botId: 'bot-a',
  status,
  startedAt: at(0),
  modelCalls: 1,
  toolCalls: 2,
});
const file = (name: string) => ({ id: name, name, size: 10, mime: 'text/plain' });

test('a Bot chat exports who said what, with the work behind an answer as one line', () => {
  serial = 0;
  const messages = [
    message({
      role: 'user',
      content: '整理一下**发布清单**',
      attachments: [file('清单.xlsx')],
      reply: { messageId: 'old', author: '阿尔法', excerpt: '上周的清单在这里' },
    }),
    message({ role: 'assistant', content: '先看一下文件。', runId: 'r1', presentation: 'progress' }),
    message({
      role: 'tool',
      content: '{"result":"机密的工具输出"}',
      runId: 'r1',
      tool: 'file_read',
      activity: { label: '读取文件', detail: '清单.xlsx' },
    }),
    message({
      role: 'assistant',
      content: '<think>不该导出的推理</think>清单整理好了：\n\n- 第一项\n- 第二项',
      runId: 'r1',
      presentation: 'answer',
      reasoning: { text: '也不该导出的推理' },
      attachments: [file('发布清单.md')],
    }),
  ];
  const text = exportBotConversation({ botName: '阿尔法', messages, runs: [run('r1')] }, options);
  assert.equal(
    text,
    [
      '# 阿尔法',
      '导出时间：2026-10-01 08:59',
      '**小周** · 2026-10-01 08:01',
      '> 引用 阿尔法：上周的清单在这里',
      '整理一下**发布清单**',
      '附件：清单.xlsx',
      '**阿尔法** · 2026-10-01 08:04',
      '（处理步骤 2 步）',
      '清单整理好了：\n\n- 第一项\n- 第二项',
      '附件：发布清单.md',
    ].join('\n\n') + '\n',
  );

  const detailed = exportBotConversation(
    { botName: '阿尔法', messages, runs: [run('r1')] },
    { ...options, steps: true },
  );
  assert.ok(detailed.includes('处理步骤（2 步）\n- 先看一下文件。\n- 读取文件：清单.xlsx'), detailed);
  for (const exported of [text, detailed]) {
    assert.ok(!exported.includes('推理'), 'reasoning stays out');
    assert.ok(!exported.includes('机密的工具输出'), 'tool output stays out');
  }
});

test('a task that did not finish says so, and notices are quoted rather than attributed', () => {
  serial = 0;
  const messages = [
    message({ role: 'user', content: '跑一下测试' }),
    message({ role: 'tool', content: '{}', runId: 'r1', tool: 'run_command', activity: { label: '运行命令' } }),
    message({ role: 'assistant', content: '模型服务超时', runId: 'r1', status: 'failed', presentation: 'error' }),
    message({ role: 'event', content: '上下文已整理' }),
    message({ role: 'user', content: '再试一次', reaction: {} as ChatMessage['reaction'] }),
    message({
      role: 'user',
      content: '每日汇总',
      scheduled: { taskId: 't', occurrenceId: 'o', title: '晨报', scheduledFor: at(0) },
    }),
    message({ role: 'tool', content: '{}', runId: 'r2', tool: 'run_command', activity: { label: '运行命令' } }),
    message({ role: 'assistant', content: '', runId: 'r2', status: 'cancelled' }),
  ];
  const text = exportBotConversation(
    { botName: '阿尔法', messages, runs: [{ ...run('r1', 'failed'), error: '模型服务超时' }, run('r2', 'cancelled')] },
    options,
  );
  assert.equal(
    text,
    [
      '# 阿尔法',
      '导出时间：2026-10-01 08:59',
      '**小周** · 2026-10-01 08:01',
      '跑一下测试',
      '**阿尔法** · 2026-10-01 08:02',
      '（处理步骤 1 步）',
      '（任务没有完成）',
      '> 上下文已整理',
      '**自动化：晨报** · 2026-10-01 08:06',
      '每日汇总',
      '**阿尔法** · 2026-10-01 08:07',
      '（处理步骤 1 步）',
      '（任务已停止）',
    ].join('\n\n') + '\n',
  );
});

test('a group exports every member, with notices quoted and replies that say nothing left out', () => {
  serial = 0;
  const group = (fields: Partial<GroupMessage> & Pick<GroupMessage, 'sender' | 'content'>): GroupMessage => ({
    id: 'g' + ++serial,
    seq: serial,
    groupId: 'room',
    kind: 'message',
    time: at(serial),
    ...fields,
  });
  const user = { kind: 'user', id: 'user', name: '你' } as const,
    system = { kind: 'system', id: 'system', name: '系统' } as const,
    bot = (id: string, name: string) => ({ kind: 'bot' as const, id, name, color: '#8b6bea' });
  const text = exportGroupConversation(
    {
      members: ['阿尔法', 'Beta'],
      botName: (id) => (id === 'bot-a' ? '阿尔法' : undefined),
      messages: [
        group({ sender: system, kind: 'system', content: '小周创建了群聊' }),
        group({ sender: user, content: '谁来写周报？' }),
        group({ sender: bot('bot-a', '旧名字'), content: '我来写。', attachments: [file('周报.md')] }),
        group({ sender: bot('bot-a', '旧名字'), content: '' }),
        group({ sender: user, kind: 'reaction', content: '👍' }),
        // A member who has left keeps the name it spoke under.
        group({ sender: bot('bot-gone', '离开的成员'), kind: 'progress', content: '数据已经汇总。' }),
      ],
    },
    { ...options, title: '周报群' },
  );
  assert.equal(
    text,
    [
      '# 周报群',
      '成员：小周、阿尔法、Beta  \n导出时间：2026-10-01 08:59',
      '> 小周创建了群聊',
      '**小周** · 2026-10-01 08:02',
      '谁来写周报？',
      '**阿尔法** · 2026-10-01 08:03',
      '我来写。',
      '附件：周报.md',
      '**离开的成员** · 2026-10-01 08:06',
      '数据已经汇总。',
    ].join('\n\n') + '\n',
  );
});

test('the offered file name is the title and the day, without characters a file system refuses', () => {
  const day = (() => {
    const date = new Date(at(59));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  })();
  assert.equal(conversationExportName('阿尔法 · 发布/上线: "v2"?', at(59)), `阿尔法 · 发布 上线 v2 ${day}.md`);
  assert.equal(conversationExportName(' ... ', at(59)), `chat ${day}.md`);
  assert.ok(conversationExportName('长'.repeat(300), at(59)).length <= 80 + 14);
});

test('each chat exports its own messages, and a chat that does not exist is refused', (t) => {
  const store = new Store(tempDir(t, 'aelion-export-')),
    bot = store.data.bots[0];
  store.data.workSessions!.push({ id: 's1', botId: bot.id, name: '官网改版', createdAt: at(0), updatedAt: at(0) });
  store.message(bot.id, 'user', '主聊天里的话');
  store.message(bot.id, 'user', '会话里的话', { sessionId: 's1' });
  const main = conversationMarkdown(store, { kind: 'bot', id: bot.id }),
    session = conversationMarkdown(store, { kind: 'bot', id: bot.id, sessionId: 's1' });
  assert.ok(main.text.startsWith(`# ${bot.name}\n`));
  assert.ok(main.text.includes('主聊天里的话') && !main.text.includes('会话里的话'));
  assert.ok(session.text.startsWith(`# ${bot.name} · 官网改版\n`));
  assert.ok(session.text.includes('会话里的话') && !session.text.includes('主聊天里的话'));
  assert.ok(session.name.startsWith(`${bot.name} · 官网改版 `) && session.name.endsWith('.md'));
  const code = (scope: Parameters<typeof conversationMarkdown>[1]) => {
    try {
      conversationMarkdown(store, scope);
    } catch (error) {
      return errorCode(error);
    }
    return undefined;
  };
  assert.equal(code({ kind: 'bot', id: 'missing' }), 'bot.not_found');
  assert.equal(code({ kind: 'bot', id: bot.id, sessionId: 'missing' }), 'session.not_found');
  assert.equal(code({ kind: 'group', id: 'missing' }), 'group.not_found');
  assert.equal(code(undefined), 'chat.export_scope_invalid');
});
