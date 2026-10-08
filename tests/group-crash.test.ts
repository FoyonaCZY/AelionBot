import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';

// Kill only the child created by this test, after the API acknowledges publication.
// No close(), debounce timer or cleanup handler can supply the missing disk write.
for (const kind of ['message', 'reaction'] as const) {
  test(`desktop ${kind} survives SIGKILL immediately after publication`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aelion-group-crash-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const code = `
      import { Store } from ${JSON.stringify(new URL('../electron/core/storage/store.ts', import.meta.url).href)};
      import { GroupChats } from ${JSON.stringify(new URL('../electron/core/group/group-chats.ts', import.meta.url).href)};
      import { writeSync } from 'node:fs';
      const store = new Store(${JSON.stringify(dir)}, { incremental: true, deferWrites: true });
      const a = store.data.bots[0], b = store.createBot('B', '');
      const groups = new GroupChats(store, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
      const room = groups.create({ name: 'Crash test', botIds: [a.id, b.id] });
      groups.send({ id: room.id, message: 'Please check this.' });
      const source = store.data.groups[0].messages.at(-1);
      const delivery = store.data.groupDeliveries.find(d => d.messageId === source.id && d.recipientId === a.id);
      const run = { id: 'crash-run', botId: a.id, status: 'running', modelCalls: 0, toolCalls: 0, startedAt: new Date().toISOString(),
        groupOrigin: { groupId: room.id, rootId: source.rootId, deliveryId: delivery.id } };
      store.data.runs.push(run);
      const kind = ${JSON.stringify(kind)};
      const result = groups.invoke(a.id, run.id, kind === 'message' ? 'group_send_message' : 'group_react',
        kind === 'message' ? { groupId: room.id, message: 'Checked.' } : { groupId: room.id, messageId: source.id, emoji: '👍' },
        new AbortController().signal, { groupOrigin: run.groupOrigin });
      writeSync(1, JSON.stringify({ groupId: room.id, sourceId: source.id, messageId: result.eventId || result.messageId }));
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const receipt = JSON.parse(child.stdout);
    const store = new Store(dir, { incremental: true });
    try {
      const room = store.data.groups.find((group) => group.id === receipt.groupId)!;
      assert.equal(room.messages.filter((message) => message.id === receipt.messageId).length, 1);
      if (kind === 'reaction') assert.equal(room.messages.find((m) => m.id === receipt.sourceId)?.pins?.length, 1);
      else assert.equal(store.data.groupOutbox?.find((entry) => entry.messageId === receipt.messageId)?.status, 'sent');
    } finally {
      store.close();
    }
  });
}
