import { createHash } from 'node:crypto';

const groupNonProgressTools = new Set([
  'group_tasks',
  'group_outbox',
  'group_send_message',
  'group_pin',
  'chat_pin',
  'execution_list',
  'task_read',
  'goal_read',
  'goal_set',
  'goal_update',
  'start_main_task',
  'bot_send_message',
  'groups_list',
]);

export function groupProgressFingerprint(name: string, args: unknown, output: unknown) {
  if (groupNonProgressTools.has(name)) return;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'string' && value.length > 12000)
      return { length: value.length, sha256: createHash('sha256').update(value).digest('hex') };
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key, item]) =>
            ![
              'revision',
              'durationMs',
              'elapsedMs',
              'createdAt',
              'updatedAt',
              'startedAt',
              'endedAt',
              'requestId',
              'resultId',
              'executionId',
            ].includes(key) && !(key === 'id' && typeof item === 'string' && /^[\da-f-]{36}$/i.test(item)),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    );
  };
  return createHash('sha256')
    .update(JSON.stringify([name, normalize(args), normalize(output)]))
    .digest('hex');
}
