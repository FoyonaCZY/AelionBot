import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDesktopBotId } from '../src/computer/group-desktop';

const group = {
  id: 'g',
  members: [
    { id: 'gone', name: 'G', color: '#000', joinedAt: '', leftAt: '2026-01-02' },
    { id: 'a', name: 'A', color: '#000', joinedAt: '' },
    { id: 'b', name: 'B', color: '#000', joinedAt: '' },
  ],
} as any;
const bots = [{ id: 'gone' }, { id: 'a' }, { id: 'b' }] as any[];
const groupRun = (id: string, botId: string, groupId = 'g') => ({ id, botId, groupOrigin: { groupId } }) as any;
const tool = (botId: string, runId: string, name = 'computer') => ({ role: 'tool', tool: name, runId, botId }) as any;

test('a group desktop follows the member that last acted on its desktop in that group', () => {
  const runs = [groupRun('ra', 'a'), groupRun('rb', 'b'), groupRun('other', 'a', 'h'), { id: 'private', botId: 'a' }];
  assert.equal(groupDesktopBotId(group, runs, [tool('a', 'ra'), tool('b', 'rb')], bots), 'b');
  assert.equal(groupDesktopBotId(group, runs, [tool('b', 'rb'), tool('a', 'ra', 'request_user_control')], bots), 'a');
  // Shell work, private runs and other groups do not move the card.
  assert.equal(
    groupDesktopBotId(
      group,
      runs,
      [tool('b', 'rb'), tool('a', 'ra', 'exec_command'), tool('a', 'private'), tool('a', 'other')],
      bots,
    ),
    'b',
  );
});

test('without desktop work a group shows its first current member that has a desktop', () => {
  assert.equal(groupDesktopBotId(group, [], [], bots), 'a');
  assert.equal(groupDesktopBotId({ id: 'g', members: [] } as any, [], [], bots), undefined);
});
