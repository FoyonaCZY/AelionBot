import test from 'node:test';
import assert from 'node:assert/strict';
import { slowOperations } from '../electron/core/app/slow-operations';

test('slow operations are recorded above the threshold, at most once per source every ten seconds', () => {
  const records: Array<[string, string]> = [];
  let now = 0;
  const slow = slowOperations(
    (source, message) => records.push([source, message]),
    () => now,
  );
  slow('state-write', 20);
  assert.equal(records.length, 0, 'fast work is not recorded');
  slow('state-write', 120, 'quick');
  assert.deepEqual(records.at(-1), ['slow.state-write', '120 ms quick']);
  now = 3000;
  slow('state-write', 300);
  slow('state-push', 80);
  assert.equal(records.length, 2, 'another source is not held back');
  now = 11_000;
  slow('state-write', 60);
  assert.deepEqual(records.at(-1), ['slow.state-write', '60 ms; 1 more since last report, worst 300 ms']);
});
