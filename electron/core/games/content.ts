import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Word lists and puzzles shipped with the app (assets/game-content), versioned by content hash. */
const roots = [
  resolve(typeof __dirname === 'string' ? __dirname : process.cwd(), '../assets/game-content'),
  resolve(process.cwd(), 'assets/game-content'),
];
const cache = new Map<string, { data: unknown; version: string }>();
export function gameContent<T>(file: string): { data: T; version: string } {
  let entry = cache.get(file);
  if (!entry) {
    const root = roots.find((p) => existsSync(join(p, file)));
    if (!root) throw Error('游戏题库文件缺失，请检查安装资源');
    const text = readFileSync(join(root, file), 'utf8');
    entry = { data: JSON.parse(text), version: createHash('sha256').update(text).digest('hex').slice(0, 12) };
    cache.set(file, entry);
  }
  return entry as { data: T; version: string };
}
