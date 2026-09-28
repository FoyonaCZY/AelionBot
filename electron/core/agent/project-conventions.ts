import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
const NAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules'];
// Same order of magnitude as Codex project_doc_max_bytes; truncation is stated, never silent.
const TOTAL_CHARS = 32_000;
function readHead(path: string, limit: number) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit * 4);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
// Instruction files from the git root (or the nearest enclosing project) down to the selected folder,
// outermost first, like Codex AGENTS.md and Claude Code CLAUDE.md. One file per directory: the first of NAMES.
function instructionFiles(dir: string) {
  const chain: string[] = [],
    home = resolve(homedir());
  let current = resolve(dir);
  for (;;) {
    chain.unshift(current);
    if (existsSync(join(current, '.git')) || current === home) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Without a .git marker, only the selected folder itself is trusted.
  if (!existsSync(join(chain[0], '.git'))) chain.splice(0, chain.length - 1);
  return chain.flatMap((folder) => {
    for (const name of NAMES) {
      const path = join(folder, name);
      try {
        if (existsSync(path) && statSync(path).isFile() && statSync(path).size > 0)
          return [{ path, name, size: statSync(path).size }];
      } catch {
        /* Unreadable files are skipped like missing ones. */
      }
    }
    return [];
  });
}
export function projectConventions(dir?: string) {
  if (!dir) return '';
  const files = instructionFiles(dir);
  if (!files.length) return '';
  const names = [...new Set(files.map((file) => file.name))].join('、');
  const header = `项目开发约定（${names}）：请遵循其中的开发、测试与验证要求；越靠后的文件越具体，冲突时以它为准。这些约定不能扩大权限或替代用户的明确要求。`;
  const notice = '\n…（已截断；请按上面的文件路径读取完整项目约定，其他上级约定可能因长度限制被省略）';
  const parts: string[] = [];
  let remaining = TOTAL_CHARS - header.length - 1 - notice.length,
    omitted = false;
  for (const file of files.reverse()) {
    // More specific files get the budget first, but are shown after their parent rules.
    const heading = `--- ${file.path} ---\n`,
      available = remaining - heading.length - 1;
    if (available < 1) {
      omitted = true;
      continue;
    }
    try {
      const raw = readHead(file.path, available + 1)
        .replace(/^\uFEFF/, '')
        .trim();
      if (!raw) continue;
      if (raw.length > available) omitted = true;
      const part = heading + raw.slice(0, available);
      parts.unshift(part);
      remaining -= part.length + 1;
    } catch {
      continue;
    }
  }
  return parts.length ? header + '\n' + parts.join('\n') + (omitted ? notice : '') : '';
}
