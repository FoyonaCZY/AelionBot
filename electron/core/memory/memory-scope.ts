import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Where a run happens, which decides the memory it may read and where what it learns is kept. */
export interface MemoryContext {
  botId: string;
  /** main and session are the owner's own chats; connector is an IM chat with someone else than the owner. */
  channel: 'main' | 'session' | 'group' | 'connector' | 'peer';
  projectScope?: string;
  groupId?: string;
  /** False for a Bot set apart from the facts about the user, such as a role-play character. */
  shareUser: boolean;
}
export const botScope = (botId: string) => 'bot:' + botId;
export const groupScope = (groupId: string) => 'group:' + groupId;
export const USER_SCOPE = 'user';
/** One conversation's identity, for its capture progress and its episodes. */
export const conversationKey = (where: { botId: string; sessionId?: string; groupId?: string }) =>
  where.groupId ? 'group:' + where.groupId : where.sessionId ? 'session:' + where.sessionId : 'main:' + where.botId;

/** The scopes a context reads, in the order the core block shows them, and whether private facts may appear. */
export function visibleScopes(context: MemoryContext) {
  const scopes: string[] = [];
  const owner = context.channel === 'main' || context.channel === 'session' || context.channel === 'group';
  if (owner && context.shareUser) scopes.push(USER_SCOPE);
  if (context.projectScope && context.channel !== 'peer') scopes.push(context.projectScope);
  scopes.push(botScope(context.botId));
  if (context.groupId && context.channel === 'group') scopes.push(groupScope(context.groupId));
  return { scopes, privateOk: context.channel === 'main' || context.channel === 'session' };
}

function gitRoot(start: string) {
  const home = resolve(homedir());
  for (let current = resolve(start); ;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current || current === home) return undefined;
    current = parent;
  }
}
// The remote of a checkout, read from its config so no git process is started. Worktrees keep a `.git` file
// pointing at their own directory, whose `commondir` leads to the shared config.
function remoteUrl(root: string) {
  try {
    let gitDir = join(root, '.git');
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
      const common = join(gitDir, 'commondir');
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, 'utf8').trim());
    }
    const config = readFileSync(join(gitDir, 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config)?.[1];
    return section ? /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() : undefined;
  } catch {
    return undefined;
  }
}
/** `git@github.com:Org/Repo.git` and `https://github.com/org/repo` name the same project. */
export function normalizedRemote(url: string) {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/:\d+\//, '/')
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}
const projects = new Map<string, { scope: string; label: string; root: string } | undefined>();

/**
 * The project of a working folder: its git checkout, identified by the remote so several clones share their
 * memories, or the folder itself when it is not in one.
 */
export function projectOf(dir?: string) {
  // The home folder is where a Bot works when no project was chosen; it is not a project.
  if (!dir || resolve(dir) === resolve(homedir())) return undefined;
  if (projects.has(dir)) return projects.get(dir);
  let value: { scope: string; label: string; root: string } | undefined;
  try {
    const root = gitRoot(dir) || resolve(dir);
    let real = root;
    try {
      real = realpathSync.native(root);
    } catch {
      /* A folder that went away keeps the path it had. */
    }
    const remote = remoteUrl(root),
      identity = remote
        ? 'remote:' + normalizedRemote(remote)
        : 'path:' + (process.platform === 'linux' ? real : real.toLowerCase());
    value = {
      scope: 'project:' + createHash('sha256').update(identity).digest('hex').slice(0, 16),
      label: basename(real) || real,
      root: real,
    };
  } catch {
    value = undefined;
  }
  projects.set(dir, value);
  return value;
}
