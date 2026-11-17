import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationSearch } from '../electron/core/app/conversations';
import { GroupChats } from '../electron/core/group/group-chats';
import { Store } from '../electron/core/storage/store';
import {
  highlightParts,
  scanConversations,
  searchSnippet,
  searchTerms,
  type ConversationSearchSource,
} from '../shared/chat/conversation-search';
import { errorCode } from '../shared/errors';
import type { ChatMessage, RunRecord } from '../shared/types/core';
import type { GroupMessage } from '../shared/types/group-types';
import { tempDir } from './helpers';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 8, minute)).toISOString();
let serial = 0;
const message = (fields: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage => ({
  id: 'm' + ++serial,
  botId: 'bot-a',
  time: at(serial),
  ...fields,
});
const groupMessage = (fields: Partial<GroupMessage> & Pick<GroupMessage, 'sender' | 'content'>): GroupMessage => ({
  id: 'g' + ++serial,
  seq: serial,
  groupId: 'room-1',
  kind: 'message',
  time: at(serial),
  ...fields,
});
const USER = { kind: 'user', id: 'user', name: '你' } as const;
const botSender = (id: string, name: string) => ({ kind: 'bot' as const, id, name, color: '#8b6bea' });
const source = (fields: Partial<ConversationSearchSource>): ConversationSearchSource => ({
  bots: [
    { id: 'bot-a', name: '阿尔法' },
    { id: 'bot-b', name: 'Beta' },
  ],
  sessionIds: new Set(['s1']),
  messages: [],
  runs: [],
  groups: [],
  ...fields,
});
/** Runs a scan to its end, counting how often it offered to pause. */
function scan(input: ConversationSearchSource, query: string, limit = 40) {
  const run = scanConversations(input, query, limit);
  let pauses = 0;
  for (;;) {
    const step = run.next();
    if (step.done) return { ...step.value, pauses };
    pauses++;
  }
}

test('a short Chinese query finds messages in main chats, work sessions and groups, newest first', () => {
  const main = message({ role: 'user', content: '帮我核对一下预算表' }),
    inSession = message({ role: 'assistant', content: '预算已经更新，共三处改动。', sessionId: 's1', runId: 'r1' }),
    inGroup = groupMessage({ sender: botSender('bot-b', '旧名字'), content: '我来负责预算部分。' }),
    fromUser = groupMessage({ sender: USER, content: '预算谁来看？' });
  const result = scan(
    source({
      messages: [main, inSession, message({ role: 'user', content: '另一件事' })],
      groups: [{ id: 'room-1', messages: [inGroup, fromUser] }],
    }),
    '预算',
  );
  assert.equal(result.total, 4);
  assert.deepEqual(
    result.hits.map((hit) => hit.messageId),
    [fromUser.id, inGroup.id, inSession.id, main.id],
  );
  assert.deepEqual(result.hits[0].scope, { kind: 'group', id: 'room-1' });
  assert.deepEqual(result.hits[0].sender, { kind: 'user' });
  // A Bot is named as it is called now, not as it was when it spoke.
  assert.deepEqual(result.hits[1].sender, { kind: 'bot', id: 'bot-b', name: 'Beta' });
  assert.deepEqual(result.hits[2].scope, { kind: 'bot', id: 'bot-a', sessionId: 's1' });
  assert.deepEqual(result.hits[2].sender, { kind: 'bot', id: 'bot-a', name: '阿尔法' });
  assert.deepEqual(result.hits[3].scope, { kind: 'bot', id: 'bot-a' });
  // One character is enough.
  assert.equal(scan(source({ messages: [main] }), '核').total, 1);
});

test('matching ignores letter case and needs every word of the query', () => {
  const both = message({ role: 'assistant', content: 'Deploy the Staging build tonight' }),
    one = message({ role: 'assistant', content: 'the staging server is down' });
  const input = source({ messages: [both, one] });
  assert.deepEqual(
    scan(input, 'STAGING deploy').hits.map((hit) => hit.messageId),
    [both.id],
  );
  assert.equal(scan(input, 'staging').total, 2);
  assert.equal(scan(input, '   ').total, 0);
  assert.deepEqual(searchTerms('  Foo  bar FOO '), ['foo', 'bar']);
});

test('only what the user and the Bots said is searched', () => {
  const said = message({ role: 'assistant', content: '部署完成' });
  const input = source({
    runs: [{ id: 'private', peerOrigin: { kind: 'peer_reply' } } as unknown as RunRecord],
    messages: [
      said,
      message({ role: 'tool', content: '部署日志', tool: 'run_command' }),
      message({ role: 'event', content: '部署事件' }),
      message({ role: 'assistant', content: '部署中', status: 'running' }),
      message({ role: 'assistant', content: '部署草稿', status: 'cancelled' }),
      message({ role: 'user', content: '部署', reaction: {} as ChatMessage['reaction'] }),
      // Reasoning a provider put in the content is not part of the answer.
      message({ role: 'assistant', content: '<think>先想想部署</think>好的。' }),
      // A Bot's private exchange with another Bot, the task it was handed, and a chat that no longer exists.
      message({ role: 'assistant', content: '部署私聊', runId: 'private' }),
      message({ role: 'user', content: '部署任务', taskSource: { botId: 'bot-b', name: 'Beta', exchangeId: 'x' } }),
      message({ role: 'user', content: '部署旧会话', sessionId: 'deleted' }),
      message({ role: 'user', content: '部署旧 Bot', botId: 'gone' }),
    ],
    groups: [
      {
        id: 'room-1',
        messages: [
          groupMessage({ sender: { kind: 'system', id: 'system', name: '系统' }, content: '部署通知', kind: 'system' }),
          groupMessage({ sender: USER, content: '部署', kind: 'reaction' }),
        ],
      },
    ],
  });
  assert.deepEqual(
    scan(input, '部署').hits.map((hit) => hit.messageId),
    [said.id],
  );
});

test('the newest matches are returned up to the limit, with the count of all of them', () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    message({ role: 'user', content: `第 ${index} 次提到发票` }),
  );
  const result = scan(source({ messages }), '发票', 5);
  assert.equal(result.total, 30);
  assert.deepEqual(
    result.hits.map((hit) => hit.messageId),
    messages
      .slice(-5)
      .reverse()
      .map((item) => item.id),
  );
});

test('a long history is scanned in batches a caller can pause between', () => {
  const messages = Array.from({ length: 3000 }, (_, index) =>
    message({ role: index % 2 ? 'assistant' : 'user', content: index === 1234 ? '只有这里有暗号' : '平常的一句话' }),
  );
  const result = scan(source({ messages }), '暗号');
  assert.equal(result.total, 1);
  assert.equal(result.hits[0].messageId, messages[1234].id);
  assert.ok(result.pauses >= 5, `paused ${result.pauses} times`);
});

test('a snippet is one line around the first match, and its matches can be highlighted', () => {
  const text =
    '开头的一段铺垫文字，写得比较长，为了让匹配落在后面。\n\n## 结论\n这里提到了 **Kubernetes** 集群的升级计划，后面还有很多很多说明文字，一直写到超过片段的长度为止，这样结尾也会被截断，然后再多写几句凑够字数。' +
    '后面还有内容。'.repeat(12);
  const terms = searchTerms('kubernetes');
  const snippet = searchSnippet(text, terms);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), snippet);
  assert.ok(!/[\n#*]/.test(snippet), snippet);
  assert.ok(snippet.includes('Kubernetes 集群'), snippet);
  assert.deepEqual(
    highlightParts('从 Kubernetes 到 kubernetes', terms)
      .filter((part) => part.hit)
      .map((part) => part.text),
    ['Kubernetes', 'kubernetes'],
  );
  assert.equal(
    highlightParts(snippet, terms)
      .map((part) => part.text)
      .join(''),
    snippet,
  );
  // A short message is shown whole.
  assert.equal(searchSnippet('预算表', ['预算']), '预算表');
});

test('the stored conversations are searched, and a group reads back to a found message', async (t) => {
  const store = new Store(tempDir(t, 'aelion-search-')),
    bot = store.data.bots[0];
  store.message(bot.id, 'user', '请整理季度复盘');
  store.message(bot.id, 'assistant', '季度复盘已经整理好。');
  const groups = new GroupChats(store, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  // Disposed here, not in t.after: it saves, and the temp folder is removed first there.
  try {
    const second = store.createBot('第二位', '认真工作。');
    const room = groups.create({ name: '项目群', botIds: [bot.id, second.id] }),
      stored = store.data.groups.find((item) => item.id === room.id)!;
    for (let index = 0; index < 150; index++)
      stored.messages.push(
        groupMessage({ groupId: room.id, sender: USER, content: index === 20 ? '别忘了季度复盘' : `第 ${index} 条` }),
      );
    const target = stored.messages.find((item) => item.content === '别忘了季度复盘')!;
    const result = await new ConversationSearch(store).search({ query: '季度复盘' });
    assert.equal(result.total, 3);
    assert.ok(result.hits.some((hit) => hit.scope.kind === 'group' && hit.messageId === target.id));
    assert.equal(result.hits.filter((hit) => hit.scope.kind === 'bot' && hit.scope.id === bot.id).length, 2);

    // The newest page does not hold the message; reading through it does, with everything after it.
    assert.ok(!groups.read({ id: room.id }).messages.some((item) => item.id === target.id));
    const page = groups.read({ id: room.id, through: target.id });
    assert.ok(page.messages.some((item) => item.id === target.id));
    assert.equal(page.messages.at(-1)!.id, stored.messages.at(-1)!.id);
    assert.ok(page.before, 'earlier messages can still be loaded');
    assert.ok(page.messages.length < stored.messages.length);
    assert.throws(
      () => groups.read({ id: room.id, through: 'missing' }),
      (error) => errorCode(error) === 'group.message_not_found',
    );
  } finally {
    groups.dispose();
  }
});
