import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { updateBotProfile } from '../electron/core/agent/bot-profile';
import { DesignStore } from '../electron/core/designer/design-store';
import { DesignSystems } from '../electron/core/designer/design-systems';
import { Harness } from '../electron/core/agent/harness';
import { BotRuntime } from '../electron/core/agent/bot-runtime';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'aelion-retired-designer-')),
    store = new Store(root),
    bot = store.data.bots[0];
  store.data.model.model = 'fixture';
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, bot };
}

test('an older designer Bot keeps its saved type, memories and design tasks after load and profile edits', (t) => {
  const { store, bot } = fixture(t);
  // Written by an older version: the field stays on disk so that version still finds its designer.
  (bot as any).type = 'designer';
  bot.memories = ['prefers serif headlines'];
  store.message(bot.id, 'user', 'keep me');
  store.save();
  const designs = new DesignStore(store, new DesignSystems(resolve('assets/design-systems')));
  const task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Landing page' });
  updateBotProfile(store, {} as any, { id: bot.id, name: 'Renamed', soul: bot.soul });
  const restarted = new Store(store.dir);
  assert.equal((restarted.bot(bot.id) as any).type, 'designer');
  assert.equal(restarted.bot(bot.id).name, 'Renamed');
  assert.deepEqual(restarted.bot(bot.id).memories, ['prefers serif headlines']);
  assert.equal(restarted.data.messages.filter((m) => m.botId === bot.id && m.role === 'user').length, 1);
  assert.deepEqual(
    new DesignStore(restarted, designs.systems).data.sessions.map((s) => s.id),
    [task.id],
  );
});

test('any Bot can own a design task; settings and profiles no longer pick its design system or fonts', (t) => {
  const { store, bot } = fixture(t);
  const systems = new DesignSystems(resolve('assets/design-systems')),
    designs = new DesignStore(store, systems),
    [first] = systems.list();
  // Defaults and preferred fonts saved by earlier builds are dropped: the Bot chooses, works without one, or asks.
  (bot as any).defaultDesignSystemId = first.id;
  (designs.data as any).preferences = { defaultSystemId: first.id, fonts: { body: 'inter' } };
  designs.save();
  const reloaded = new DesignStore(store, systems);
  assert.equal('preferences' in reloaded.data, false);
  assert.equal('preferences' in reloaded.snapshot(), false);
  assert.equal(reloaded.create({ botId: bot.id, kind: 'ppt', brief: 'Without a system' }).systemId, null);
  const task = reloaded.create({ botId: bot.id, kind: 'ppt', brief: 'Quarterly review', systemId: first.id });
  assert.equal(task.systemId, first.id);
});

test('every Bot runs the general engine, with design tools offered on its first call', async (t) => {
  const { store, bot } = fixture(t);
  (bot as any).type = 'designer';
  let calls = 0;
  const general = new Harness(
    store,
    {} as any,
    {
      complete: async (_messages: any, tools: any[]) => {
        calls++;
        assert.ok(tools.some((tool) => tool.function.name === 'exec_command'));
        assert.ok(!tools.some((tool) => ['continue_general', 'design_handoff'].includes(tool.function.name)));
        return { content: '请提供材料。', calls: [], finishReason: 'stop' };
      },
    } as any,
    () => {},
  );
  t.after(() => general.disposeTools());
  await new BotRuntime(store, general, () => {}).run(bot.id, '收集行业数据，然后做 PPT');
  assert.equal(calls, 1);
  assert.equal(store.data.runs[0].engine, 'general');
  assert.equal(store.data.runs[0].status, 'completed');
});

test('private and group requests keep their collaboration origin', async (t) => {
  const { store, bot } = fixture(t),
    seen: any[] = [];
  const general = {
    streams: { snapshot: () => [] },
    busy: false,
    isRunning: () => false,
    run: async (id: string, text: string, options: any) => seen.push({ id, text, options }),
  };
  const runtime = new BotRuntime(store, general as any, () => {});
  const peer = { peerOrigin: { kind: 'peer_request' as const, exchangeId: 'exchange' } },
    group = { groupOrigin: { groupId: 'group', rootId: 'root', deliveryId: 'delivery' } };
  await runtime.run(bot.id, 'private work', peer);
  await runtime.run(bot.id, 'group work', group);
  assert.deepEqual(seen[0].options.peerOrigin, peer.peerOrigin);
  assert.deepEqual(seen[1].options.groupOrigin, group.groupOrigin);
});

test('a run of the retired designer engine is kept but cannot be resumed as it was', async (t) => {
  const { store, bot } = fixture(t);
  store.data.runs.push({
    id: 'old-designer-run',
    botId: bot.id,
    status: 'interrupted',
    engine: 'designer',
    startedAt: '2026-09-01T00:00:00.000Z',
    modelCalls: 1,
    toolCalls: 1,
  });
  const runtime = new BotRuntime(
    store,
    { streams: { snapshot: () => [] }, busy: false, isRunning: () => false, run: async () => {} } as any,
    () => {},
  );
  await assert.rejects(runtime.resume(bot.id, 'old-designer-run'), { code: 'bot.designer_retired' });
  await assert.rejects(runtime.run(bot.id, 'continue', { resumeRunId: 'old-designer-run' }), {
    code: 'bot.designer_retired',
  });
  assert.ok(store.data.runs.some((run) => run.id === 'old-designer-run'));
});
