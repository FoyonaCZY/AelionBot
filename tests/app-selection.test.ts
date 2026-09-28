import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from '../shared/types/core';
import { selectionFallback } from '../src/app/use-app-snapshot';

const bot = (id: string) => ({ id }) as Bot;

test('a newly created bot stays selected until the snapshot that lists it arrives', () => {
  const before = [bot('old'), bot('recent')],
    after = [...before, bot('created')];
  // createBot resolved; the main process has not sent the snapshot with the new bot yet.
  assert.equal(selectionFallback(before, 'created', before), undefined);
  assert.equal(selectionFallback(after, 'created', before), undefined);
});

test('a selection still missing from a newer snapshot falls back to the first bot', () => {
  const before = [bot('old'), bot('deleted')],
    after = [bot('old')];
  assert.equal(selectionFallback(after, 'deleted', before), 'old');
  assert.equal(selectionFallback([], 'deleted', before), '');
  assert.equal(selectionFallback(after, '', after), 'old');
  assert.equal(selectionFallback(after, 'old', after), undefined);
});
