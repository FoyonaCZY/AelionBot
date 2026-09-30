import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { triage, sinceUser, type TriageContext } from '../electron/core/group/group-triage';
import { unanswered } from '../shared/chat/group-answers';
import { GROUP_LIMITS, type GroupDelivery, type GroupMessage, type GroupRoom } from '../shared/types/group-types';

const bot = (id: string) => ({ kind: 'bot' as const, id, name: id.toUpperCase(), color: '#000' });
const user = { kind: 'user' as const, id: 'user' as const, name: '你' };
const system = { kind: 'system' as const, id: 'system' as const, name: '系统' };
const mention = (id: string) => ({ ...bot(id), start: 0, end: id.length + 1 });

function room() {
  const value: GroupRoom = {
    id: 'g',
    name: 'g',
    members: ['a', 'b', 'c'].map((id) => ({ ...bot(id), joinedAt: '' })),
    createdBy: user,
    createdAt: '',
    updatedAt: '',
    messages: [],
    lastReadSeq: 0,
  };
  const deliveries: GroupDelivery[] = [];
  let time = Date.parse('2026-09-30T00:00:00Z');
  const post = (sender: GroupMessage['sender'], fields: Partial<GroupMessage> = {}) => {
    const message: GroupMessage = {
      id: randomUUID(),
      seq: value.messages.length + 1,
      groupId: 'g',
      sender,
      kind: sender.kind === 'system' ? 'system' : 'message',
      content: 'text',
      time: new Date((time += 1000)).toISOString(),
      ...fields,
    };
    value.messages.push(message);
    for (const recipientId of ['user', 'a', 'b', 'c'].filter((id) => id !== sender.id))
      deliveries.push({
        id: randomUUID(),
        groupId: 'g',
        messageId: message.id,
        recipientId,
        rootId: 'r',
        status: recipientId === 'user' ? 'delivered' : 'queued',
        createdAt: message.time,
      });
    return message;
  };
  const delivery = (message: GroupMessage, recipientId: string) =>
    deliveries.find((item) => item.messageId === message.id && item.recipientId === recipientId)!;
  const context = (fields: Partial<TriageContext> = {}): TriageContext => ({
    room: value,
    deliveries,
    now: time,
    holdMs: GROUP_LIMITS.holdSeconds * 1000,
    ...fields,
  });
  const judge = (message: GroupMessage, recipientId: string, fields?: Partial<TriageContext>) =>
    triage(delivery(message, recipientId), context(fields));
  return { room: value, deliveries, post, delivery, judge, later: (ms: number) => (time += ms) };
}

test('events wake members: a user reaction wakes its target, membership changes wake everyone', () => {
  const f = room();
  const target = f.post(user),
    mine = f.post(bot('a'));
  const reaction = (sender: GroupMessage['sender'], messageId: string) =>
    f.post(sender, { kind: 'reaction', reaction: { messageId, emoji: '👍', removed: false } });
  // Bot reactions wake nobody, so reactions cannot loop.
  assert.equal(f.judge(reaction(bot('b'), mine.id), 'a').kind, 'skip');
  assert.equal(f.judge(reaction(bot('a'), target.id), 'b').kind, 'skip');
  const liked = reaction(user, mine.id);
  assert.deepEqual(f.judge(liked, 'a'), { kind: 'wake', must: false });
  assert.equal(f.judge(liked, 'b').kind, 'skip');
  const withdrawn = f.post(user, { kind: 'reaction', reaction: { messageId: mine.id, emoji: '👍', removed: true } });
  assert.equal(f.judge(withdrawn, 'a').kind, 'skip');
  const created = f.post(system, { event: { type: 'created', actor: user, joined: [], left: [], members: [] } });
  assert.deepEqual(f.judge(created, 'a'), { kind: 'wake', must: false });
  assert.deepEqual(f.judge(created, 'b'), { kind: 'wake', must: false });
  assert.equal(f.judge(f.post(system, { content: '群名称已修改' }), 'a').kind, 'skip');
  assert.deepEqual(f.judge(f.post(system, { mentions: [mention('a')] }), 'a'), { kind: 'wake', must: true });
});

test('@ and replies to my message wake me; only users and @ make an answer mandatory', () => {
  const f = room();
  assert.deepEqual(f.judge(f.post(user, { mentions: [mention('a')] }), 'a'), { kind: 'wake', must: true });
  assert.deepEqual(f.judge(f.post(bot('b'), { mentions: [mention('a')] }), 'a'), { kind: 'wake', must: true });
  const mine = f.post(bot('a'));
  // Nobody else is still answering it, so a reply reaches me at once.
  for (const id of ['b', 'c']) Object.assign(f.delivery(mine, id), { status: 'ignored', triage: 'skip' });
  assert.deepEqual(f.judge(f.post(user, { reply: { messageId: mine.id } as never }), 'a'), {
    kind: 'wake',
    must: true,
  });
  assert.deepEqual(f.judge(f.post(bot('b'), { replyTo: mine.id }), 'a'), { kind: 'wake', must: false });
});

test('others wait for the addressed Bot, then judge relevance with its answer', () => {
  const f = room();
  const question = f.post(user, { mentions: [mention('a')] });
  const held = f.judge(question, 'b');
  assert.equal(held.kind, 'hold');
  f.delivery(question, 'a').status = 'running';
  assert.equal(f.judge(question, 'b').kind, 'hold');
  const answer = f.post(bot('a'), { replyTo: question.id, answers: question.id });
  assert.deepEqual(f.judge(question, 'b'), { kind: 'ask', answer });
});

test('waiting for an addressed Bot ends when it gives up or the hold expires', () => {
  const f = room();
  const question = f.post(user, { mentions: [mention('a')] });
  f.delivery(question, 'a').status = 'ignored';
  assert.deepEqual(f.judge(question, 'b'), { kind: 'ask', answer: undefined });
  const second = f.post(user, { mentions: [mention('a')] });
  f.later(GROUP_LIMITS.holdSeconds * 1000 + 1);
  assert.equal(f.judge(second, 'b').kind, 'ask');
});

test('a reply to my question waits for the others still answering the same question', () => {
  const f = room();
  const question = f.post(bot('a'));
  f.delivery(question, 'b').triage = 'wake';
  f.delivery(question, 'c').triage = 'wake';
  const first = f.post(bot('b'), { replyTo: question.id, answers: question.id });
  assert.equal(f.judge(first, 'a').kind, 'hold');
  f.post(bot('c'), { replyTo: question.id, answers: question.id });
  assert.deepEqual(f.judge(first, 'a'), { kind: 'wake', must: false });
});

test('unaddressed messages go to Laya for a busy Bot; scheduled tasks wake their owner only', () => {
  const f = room();
  assert.equal(f.judge(f.post(user), 'a', { idle: false }).kind, 'ask');
  const scheduled = f.post(system, {
    scheduled: { taskId: 't', occurrenceId: 'o', title: '日报', scheduledFor: '' },
  });
  assert.deepEqual(f.judge(scheduled, 'a', { scheduledBy: 'a' }), { kind: 'wake', must: true });
  assert.equal(f.judge(scheduled, 'b', { scheduledBy: 'a' }).kind, 'skip');
  assert.deepEqual(f.judge(scheduled, 'b'), { kind: 'wake', must: false });
});

test('two Bots stop waking each other after two rounds; the whole group after ten Bot messages', () => {
  const f = room();
  f.post(user);
  let last: GroupMessage | undefined;
  for (let i = 0; i < GROUP_LIMITS.pairStreak; i++) {
    const [from, to] = i % 2 ? ['b', 'a'] : ['a', 'b'];
    last = f.post(bot(from), { mentions: [mention(to)] });
    assert.equal(f.judge(last, to).kind, 'wake', `message ${i + 1}`);
  }
  const fifth = f.post(bot('a'), { mentions: [mention('b')] });
  assert.deepEqual(f.judge(fifth, 'b'), { kind: 'limited', peerId: 'a', reason: 'pair' });
  // The pair limit does not stop them from waking a third member.
  assert.equal(f.judge(f.post(bot('a'), { mentions: [mention('c')] }), 'c').kind, 'wake');
  // The user speaking resets every limit.
  f.post(user);
  assert.equal(f.judge(f.post(bot('a'), { mentions: [mention('b')] }), 'b').kind, 'wake');
  for (let i = 0; i < GROUP_LIMITS.botStreak; i++)
    f.post(bot(['a', 'b', 'c'][i % 3]), { mentions: [mention(['b', 'c', 'a'][i % 3])] });
  assert.deepEqual(f.judge(f.post(bot('c'), { mentions: [mention('a')] }), 'a'), { kind: 'limited', reason: 'bot' });
  assert.equal(sinceUser(f.room).length, GROUP_LIMITS.botStreak + 2);
});

test('an unaddressed user message is unanswered only when every Bot looked and none answered', () => {
  const f = room();
  const question = f.post(user);
  for (const id of ['a', 'b', 'c']) f.delivery(question, id).status = 'ignored';
  assert.equal(unanswered(f.room.messages, f.deliveries, question), true);
  f.post(bot('a'), { kind: 'reaction', reaction: { messageId: question.id, emoji: '👀', removed: false } });
  assert.equal(unanswered(f.room.messages, f.deliveries, question), false);
  const addressed = f.post(user, { mentions: [mention('a')] });
  for (const id of ['a', 'b', 'c']) f.delivery(addressed, id).status = 'ignored';
  assert.equal(unanswered(f.room.messages, f.deliveries, addressed), false);
});

test('user feedback on a design goes to its owner; the designer’s own messages follow the normal rules', () => {
  const f = room();
  const feedback = f.post(user, { designSessionId: 'd' });
  assert.deepEqual(f.judge(feedback, 'a', { designOwner: 'a' }), { kind: 'wake', must: true });
  assert.equal(f.judge(feedback, 'b', { designOwner: 'a' }).kind, 'skip');
  const draft = f.post(bot('a'), { designSessionId: 'd' });
  assert.equal(f.judge(draft, 'b', { designOwner: 'a' }).kind, 'ask');
});

test('a user message to the whole group must be answered by idle Bots; busy Bots ask Laya', () => {
  const f = room();
  const open = f.post(user);
  assert.deepEqual(f.judge(open, 'a', { idle: true }), { kind: 'wake', must: true });
  assert.equal(f.judge(open, 'b', { idle: false }).kind, 'ask');
  // Addressed to someone else, or written by a Bot: the idle rule does not apply.
  const toA = f.post(user, { mentions: [mention('a')] });
  f.delivery(toA, 'a').status = 'replied';
  f.post(bot('a'), { replyTo: toA.id, answers: toA.id });
  assert.equal(f.judge(toA, 'b', { idle: true }).kind, 'ask');
  assert.equal(f.judge(f.post(bot('c')), 'a', { idle: true }).kind, 'ask');
});
