import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { GroupChats } from '../electron/core/group/group-chats';
import { PersonaService } from '../electron/core/persona/persona-service';
import { until } from './helpers';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona-group-'));
  const store = new Store(dir);
  const persona = new PersonaService(dir);
  const contexts: string[] = [];
  const groups = new GroupChats(
    store,
    {
      isRunning: () => false,
      run: async (_id, _input, options) => {
        contexts.push(options?.groupContext || '');
      },
      cancel: () => {},
    },
    () => {},
    undefined,
    undefined,
    undefined,
    (botId, people) => persona.groupFragment(botId, people),
  );
  groups.start();
  t.after(() => {
    groups.dispose();
    persona.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, persona, groups, contexts };
}

test('a game report is posted to its group as a notice that wakes no Bot', (t) => {
  const { store, groups } = fixture(t);
  const a = store.createBot('阿岩', 'bold', '#aa5500'),
    b = store.createBot('小周', 'calm', '#0055aa');
  const room = groups.create({ name: '狼人杀群', botIds: [a.id, b.id] });
  const before = store.data.groupDeliveries.length;
  groups.postGameResult(room.id, '狼人杀战报：好人阵营获胜。');
  const posted = store.data.groups.find((g) => g.id === room.id)!.messages.at(-1)!;
  assert.equal(posted.sender.kind, 'system');
  assert.equal(posted.content, '狼人杀战报：好人阵营获胜。');
  assert.equal(store.data.groupDeliveries.length, before, 'no Bot is woken by the report');
  groups.postGameResult('missing', 'x'); // an unknown group is ignored
});

test('a woken Bot receives its relation and one shared memory about the sender', async (t) => {
  const { store, persona, groups, contexts } = fixture(t);
  const a = store.createBot('阿岩', 'bold', '#aa5500'),
    b = store.createBot('小周', 'calm', '#0055aa');
  const room = groups.create({ name: '狼人杀群', botIds: [a.id, b.id] });
  persona.settle({
    id: 'm1',
    groupId: room.id,
    winner: 'village',
    seats: [
      { id: 's1', name: '1号', human: false, botId: a.id, role: 'wolf' },
      { id: 's2', name: '2号', human: false, botId: b.id, role: 'wolf' },
      { id: 's3', name: '3号', human: true, role: 'villager' },
    ],
    events: [{ type: 'save', day: 1, witchId: 's3', seatId: 's1' }],
  });
  groups.send({ id: room.id, message: '上局怎么样' });
  await until(() => contexts.length > 0, { timeoutMs: 5000 });
  assert.ok(
    contexts.some((c) => c.includes('[你的关系与记忆，仅供参考]') && c.includes('一局狼人杀')),
    'the persona lines reach the group run',
  );
});
