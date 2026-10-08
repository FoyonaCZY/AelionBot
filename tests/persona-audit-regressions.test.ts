import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaService } from '../electron/core/persona/persona-service';
import { NEUTRAL, type Traits } from '../shared/persona/persona-model';
import type { SettleMatch } from '../electron/core/persona/settle';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-persona-audit-'));
  const svc = new PersonaService(dir, () => 1000);
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
test('rejected manual settings never create or mutate a profile', (t) => {
  const svc = fixture(t);
  svc.setTraits('existing', { ...NEUTRAL, E: 0.7 });
  const before = svc.view('existing');
  for (const E of [NaN, Infinity, null, false, '0.9', -0.1, 1.1, undefined]) {
    assert.throws(() => svc.setTraits('new', { ...NEUTRAL, E } as Traits));
    assert.equal(svc.store.profile('new'), undefined);
    assert.equal(svc.store.history('new').length, 0);
    assert.throws(() => svc.setTraits('existing', { ...NEUTRAL, E } as Traits));
    assert.deepEqual(svc.view('existing'), before);
  }
});
test('same-millisecond history ends at the current saved personality, including limited reads', (t) => {
  const svc = fixture(t);
  svc.confirm('A');
  svc.setTraits('A', { ...NEUTRAL, E: 0.7 });
  svc.setTraits('A', { ...NEUTRAL, E: 0.8 });
  assert.deepEqual(
    svc.view('A').history.map((p) => p.traits.E),
    [0.5, 0.7, 0.8],
  );
  assert.deepEqual(
    svc.store.history('A', 2).map((p) => p.traits.E),
    [0.7, 0.8],
  );
});
test('a settlement write failure rolls back relationship changes and can be retried once', (t) => {
  const svc = fixture(t);
  const match: SettleMatch = {
    id: 'fault',
    groupId: 'g',
    winner: 'village',
    seats: [
      { id: 'a', name: 'A', human: false, botId: 'A', role: 'wolf' },
      { id: 'b', name: 'B', human: false, botId: 'B', role: 'wolf' },
      { id: 'c', name: 'C', human: false, botId: 'C', role: 'villager' },
    ],
    events: [{ type: 'exile', day: 1, seatId: 'a', voters: ['b'] }],
  };
  const original = svc.store.addHighlight;
  svc.store.addHighlight = () => {
    throw Error('simulated write failure');
  };
  assert.throws(() => svc.settle(match), /simulated write failure/);
  svc.store.addHighlight = original;
  assert.equal(svc.affinity('A', 'B'), 0, 'partial settlement must not survive');
  assert.ok(svc.settle(match), 'failed settlement must remain retryable');
  const score = svc.affinity('A', 'B');
  assert.ok(score < 0);
  assert.equal(svc.settle(match), undefined);
  assert.equal(svc.affinity('A', 'B'), score, 'successful settlement must not be duplicated');
});
