import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameRuntime, type GameHooks } from '../electron/core/games/runtime';
import { createWerewolf, acceptAction, view, type WerewolfState } from '../electron/core/games/werewolf';
import { gamePrompt } from '../electron/core/games/model-player';
import { assignPersonas } from '../electron/core/games/persona-play';
import { settleFinishedGame } from '../electron/core/games/settlement';
import { PersonaService } from '../electron/core/persona/persona-service';
import { GroupChats } from '../electron/core/group/group-chats';
import { Store } from '../electron/core/storage/store';
import type { GameAction, GameRequest } from '../shared/types/game-types';

const players = Array.from({ length: 7 }, (_, i) => ({
  id: String(i),
  name: `P${i}`,
  human: false,
  color: '#888',
  botId: `B${i}`,
}));
const answer = (r: GameRequest): GameAction =>
  ['speak', 'wolf_plan'].includes(r.kind)
    ? { text: '我先听听。' }
    : r.kind === 'witch'
      ? { potion: 'skip' }
      : { target: r.targets[0] };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function finishedMatch(prepare?: (s: WerewolfState) => void) {
  const s = createWerewolf(
    'g',
    players,
    ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
    undefined,
    7,
  );
  s.personaPolicy = 'model_semantic_v1';
  s.trace = [];
  prepare?.(s);
  for (let steps = 0; s.status === 'running' && steps < 300; steps++) {
    const r = s.requests[0];
    const action = answer(r),
      day = s.day,
      phase = s.phase;
    s.trace.push({
      seq: s.trace.length + 1,
      time: Date.now(),
      type: 'model_started',
      day,
      phase,
      seatId: r.seatId,
      requestId: r.id,
      kind: r.kind,
      requestCaptured: true,
      input: gamePrompt(view(s, r.seatId), r),
    });
    acceptAction(s, r.id, action);
    s.trace.push({
      seq: s.trace.length + 1,
      time: Date.now(),
      type: 'action_accepted',
      day,
      phase,
      seatId: r.seatId,
      requestId: r.id,
      kind: r.kind,
      action,
    });
  }
  assert.equal(s.status, 'finished', 'fixture reaches a winner through legal rules-engine actions');
  assert.ok(s.winner);
  return s;
}
function fixture(t: test.TestContext, states: WerewolfState[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'game-settlement-'));
  writeFileSync(join(dir, 'matches.json'), JSON.stringify(states));
  const runtimes: GameRuntime[] = [];
  const cleanups: Array<() => void> = [];
  t.after(() => {
    for (const runtime of runtimes) runtime.dispose();
    for (const cleanup of cleanups) cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    cleanup: (run: () => void) => {
      cleanups.push(run);
    },
    saved: (): WerewolfState[] => JSON.parse(readFileSync(join(dir, 'matches.json'), 'utf8')),
    open(hooks: GameHooks) {
      const runtime = new GameRuntime(
        dir,
        async (_p, _v, _r, signal) =>
          new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        undefined,
        undefined,
        hooks,
      );
      runtimes.push(runtime);
      return runtime;
    },
  };
}

test('startup completes a match saved before the finished callback and acknowledges it across restarts', async (t) => {
  const match = finishedMatch(),
    f = fixture(t, [match]);
  const completed: string[] = [];
  const hooks = {
    finished: (s: WerewolfState) => {
      completed.push(s.id);
    },
  };
  const first = f.open(hooks);
  await flush();
  assert.deepEqual(completed, [match.id], 'startup owns completion of the durable finished match');
  first.dispose();
  f.open(hooks);
  await flush();
  assert.deepEqual(completed, [match.id], 'an acknowledged completion is not replayed');
});

test('failed completion survives starting another match in the same group and then restarting', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const first = f.open({
    finished: () => {
      attempts++;
      throw Error('persona store unavailable');
    },
  });
  const match = first.create({ groupId: 'g', players });
  first.control(match.id, 'stop');
  await flush();
  const next = first.create({ groupId: 'g', players });
  first.control(next.id, 'pause');
  first.dispose();
  assert.equal(attempts, 1, 'a failed completion was attempted');
  assert.ok(
    f.saved().some((s) => s.id === match.id),
    'new matches must not erase pending settlement',
  );
  const completed: string[] = [];
  const reopened = f.open({
    finished: (s) => {
      completed.push(s.id);
    },
  });
  await flush();
  assert.deepEqual(completed, [match.id]);
  assert.equal(reopened.read('g')?.id, next.id, 'the latest match remains the visible match');
});

test('normal completion calls the observer once and keeps the finished game available', async (t) => {
  const f = fixture(t),
    completed: string[] = [];
  const runtime = f.open({
    finished: (s) => {
      completed.push(s.id);
    },
  });
  const match = runtime.create({ groupId: 'g', players });
  runtime.control(match.id, 'stop');
  await flush();
  assert.deepEqual(completed, [match.id]);
  assert.equal(runtime.read('g')?.status, 'finished');
});

test('legacy archives migrate only the latest match while explicit pending completions are retained', async (t) => {
  const old = finishedMatch(),
    pending = { ...finishedMatch(), settlementComplete: false },
    latest = finishedMatch();
  const f = fixture(t, [old, pending, latest]),
    completed: string[] = [];
  const runtime = f.open({
    finished: (s) => {
      completed.push(s.id);
    },
  });
  await flush();
  assert.deepEqual(completed, [pending.id, latest.id], 'legacy superseded archives must not acquire new effects');
  assert.equal(runtime.read('g')?.id, latest.id);
});

test('the runtime timer retries repeated failures and never overlaps an async completion', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const match = finishedMatch(),
    f = fixture(t, [match]);
  let attempts = 0,
    release!: () => void;
  const runtime = f.open({
    finished: async () => {
      attempts++;
      if (attempts <= 2) throw Error('store unavailable');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  await flush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(29_000);
  await flush();
  assert.equal(attempts, 1, 'failures are not retried every 250 ms');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(attempts, 2);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(attempts, 3);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(attempts, 3, 'only one async settlement may be in flight');
  assert.ok(!f.saved()[0].settlementComplete, 'unfinished async effects are never acknowledged');
  release();
  await flush();
  assert.equal(f.saved()[0].settlementComplete, true);
  runtime.dispose();
});

for (const boundary of ['hook', 'receipt'] as const)
  test(`a ${boundary} failure is diagnosed once with its match and retries even when diagnostics fail`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    const match = finishedMatch(),
      f = fixture(t, [match]),
      hookError = Error('persona store unavailable');
    const failures: Array<{ id: string; error: unknown }> = [];
    let attempts = 0;
    f.open({
      finished: () => {
        if (++attempts !== 1) return;
        if (boundary === 'hook') throw hookError;
        mkdirSync(join(f.dir, 'matches.json.tmp'));
      },
      settlementFailed: (id: string, error: unknown) => {
        failures.push({ id, error });
        throw Error('diagnostics unavailable');
      },
    });
    await flush();
    assert.equal(failures.length, 1, 'the failed attempt produces one diagnostic');
    assert.equal(failures[0].id, match.id);
    if (boundary === 'hook') assert.equal(failures[0].error, hookError);
    else assert.equal((failures[0].error as NodeJS.ErrnoException).code, 'EISDIR');
    assert.ok(!f.saved()[0].settlementComplete, 'diagnostics cannot acknowledge failed effects');
    if (boundary === 'receipt') rmSync(join(f.dir, 'matches.json.tmp'), { recursive: true });
    t.mock.timers.tick(29_000);
    await flush();
    assert.equal(attempts, 1, 'diagnostics failure preserves the retry delay');
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(attempts, 2);
    assert.equal(f.saved()[0].settlementComplete, true, 'the real timer recovers despite diagnostic failure');
    assert.equal(failures.length, 1, 'successful recovery does not emit another failure');
  });

function services(t: test.TestContext) {
  const f = fixture(t),
    store = new Store(f.dir),
    persona = new PersonaService(f.dir);
  const groups = new GroupChats(store, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  const bots = players.map((p) => store.createBot(p.name, 'calm', '#888888'));
  const room = groups.create({ name: '对局恢复', botIds: bots.map((b) => b.id) });
  const match = finishedMatch((s) => {
    s.groupId = room.id;
    s.seats.forEach((seat, i) => {
      seat.botId = bots[i].id;
    });
    assignPersonas(
      s,
      persona.seeds(
        s.seats.map((seat) => ({ botId: seat.botId! })),
        bots.map((b) => b.id),
      ),
    );
  });
  writeFileSync(join(f.dir, 'matches.json'), JSON.stringify([match]));
  f.cleanup(() => {
    groups.dispose();
    persona.close();
    store.close();
  });
  return { ...f, store, persona, groups, room: store.data.groups.find((g) => g.id === room.id)!, match, bots };
}

for (const boundary of ['settled', 'growth', 'report'] as const)
  test(`real completion recovers after ${boundary} commits without duplicating any durable effect`, async (t) => {
    const f = services(t);
    const deliveriesBefore = f.store.data.groupDeliveries.length;
    let interrupted = false;
    const finished = (s: WerewolfState) => {
      if (!interrupted) {
        interrupted = true;
        if (boundary === 'settled') {
          const original = f.persona.recordGrowthObservations.bind(f.persona);
          f.persona.recordGrowthObservations = () => {
            throw Error('growth unavailable');
          };
          try {
            settleFinishedGame(s, f.persona, f.groups);
          } finally {
            f.persona.recordGrowthObservations = original;
          }
        } else if (boundary === 'growth') {
          const original = f.groups.postGameResult.bind(f.groups);
          f.groups.postGameResult = () => {
            throw Error('group store unavailable');
          };
          try {
            settleFinishedGame(s, f.persona, f.groups);
          } finally {
            f.groups.postGameResult = original;
          }
        } else {
          settleFinishedGame(s, f.persona, f.groups);
          // The report is durable, but writing the runtime's completion receipt fails.
          mkdirSync(join(f.dir, 'matches.json.tmp'));
        }
        return;
      }
      settleFinishedGame(s, f.persona, f.groups);
    };
    const first = f.open({ finished });
    await flush();
    const memories = f.bots.map((b) => f.persona.view(b.id).highlights.length);
    assert.ok(
      memories.every((count) => count > 0),
      'persona settlement committed before the injected failure',
    );
    assert.ok(!f.saved()[0].settlementComplete, 'each failed boundary leaves the completion pending');
    if (boundary === 'report') rmSync(join(f.dir, 'matches.json.tmp'), { recursive: true });
    first.dispose();
    const second = f.open({ finished });
    await flush();
    assert.equal(f.saved()[0].settlementComplete, true);
    assert.deepEqual(
      f.bots.map((b) => f.persona.view(b.id).highlights.length),
      memories,
    );
    const observations = f.bots.flatMap((b) => f.persona.store.pendingGrowthObservations(b.id));
    assert.ok(observations.length > 0, 'growth evidence eventually reaches the persona store');
    assert.equal(new Set(observations.map((o) => o.id)).size, observations.length);
    const restored = new Store(f.dir);
    try {
      const reports = restored.data.groups
        .find((g) => g.id === f.room.id)!
        .messages.filter((m) => m.id === `game-result:${f.match.id}`);
      assert.equal(reports.length, 1, 'one visible report survives restart of the group store');
      assert.equal(reports[0].kind, 'system');
      assert.equal(restored.data.groupDeliveries.length, deliveriesBefore, 'the report wakes no bot');
    } finally {
      restored.close();
    }
    second.dispose();
    f.open({ finished });
    await flush();
    assert.equal(f.bots.flatMap((b) => f.persona.store.pendingGrowthObservations(b.id)).length, observations.length);
  });

test('a finished match waits for downstream startup and cancelled matches produce no settlement', async (t) => {
  const match = finishedMatch();
  assert.throws(() => settleFinishedGame(match, undefined, undefined), /尚未就绪/);
  assert.doesNotThrow(() => settleFinishedGame({ ...match, winner: undefined }, undefined, undefined));
  const f = fixture(t, [match]);
  f.open({ finished: (s) => settleFinishedGame(s, undefined, undefined) });
  await flush();
  assert.ok(!f.saved()[0].settlementComplete);
});

test('legacy completion adopts an already published unkeyed report but explicit pending matches still publish', async (t) => {
  const f = services(t);
  const report = f.persona.settle({ ...f.match, events: f.match.events || [] })!;
  f.groups.postGameResult(f.room.id, report);
  const oldMessageId = f.room.messages.at(-1)!.id;
  const first = f.open({ finished: (s) => settleFinishedGame(s, f.persona, f.groups) });
  await flush();
  const reports = () => f.room.messages.filter((m) => m.content === report.slice(0, 4000));
  assert.equal(reports().length, 1, 'upgrade must not repeat a report already published by the old finished hook');
  assert.equal(reports()[0].id, oldMessageId, 'migration preserves existing message references');
  first.dispose();
  const pending = { ...f.match, id: 'new-match-with-identical-report', settlementComplete: false };
  writeFileSync(join(f.dir, 'matches.json'), JSON.stringify([pending]));
  f.open({ finished: (s) => settleFinishedGame(s, f.persona, f.groups) });
  await flush();
  assert.equal(reports().length, 2, 'new pending matches never use legacy body deduplication');
});

for (const change of ['reset', 'setTraits'] as const)
  test(`${change} after settlement but before the first growth write rejects old evidence on recovery`, async (t) => {
    const f = services(t);
    const original = f.persona.recordGrowthObservations.bind(f.persona);
    f.persona.recordGrowthObservations = () => {
      throw Error('growth write failed before inserting any observation');
    };
    const first = f.open({ finished: (s) => settleFinishedGame(s, f.persona, f.groups) });
    await flush();
    assert.ok(!f.saved()[0].settlementComplete);
    assert.equal(f.persona.store.pendingGrowthObservations(f.bots[0].id).length, 0);
    first.dispose();
    f.persona.recordGrowthObservations = original;
    if (change === 'reset') f.persona.resetGrowth(f.bots[0].id);
    else f.persona.setTraits(f.bots[0].id, { E: 0.5, A: 0.5, C: 0.5, N: 0.5, O: 0.5 }, 'user');
    f.open({ finished: (s) => settleFinishedGame(s, f.persona, f.groups) });
    await flush();
    assert.equal(f.saved()[0].settlementComplete, true);
    assert.equal(
      f.persona.store.pendingGrowthObservations(f.bots[0].id).length,
      0,
      'reset invalidates even evidence whose first write failed',
    );
    assert.ok(
      f.persona.store.pendingGrowthObservations(f.bots[1].id).length > 0,
      'another Bot still receives the same match evidence',
    );
  });
