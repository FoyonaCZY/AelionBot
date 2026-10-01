import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { HostPermissionDetails } from '../../../shared/types/core';
import { hostPathKey } from './host-platform';
import {
  canonical,
  classifyHostOperation,
  ordinaryProjectPath,
  pathApi,
  sensitiveParts,
  type HostRiskContext,
} from './permission-risk';
import type { PsNode } from './powershell-parser';

// Everything here answers one question: is this command a read-only query inside the project? Anything not
// positively recognized is "no", and the operation goes to normal review. Nothing here ever denies.

type Verdict = { lowRisk: boolean; reason: string };
class Rejected extends Error {}
const reject = (): never => {
  throw new Rejected();
};

// --- paths ---------------------------------------------------------------------------------------------------

/** A relative (or unexpanded) PATH entry would let a project file shadow a known tool. */
function relativePath(context: HostRiskContext) {
  const env = context.env || process.env,
    windows = context.platform === 'win32',
    value = Object.entries(env).find(([key]) => (windows ? key.toLowerCase() === 'path' : key === 'PATH'))?.[1] || '';
  return value
    .split(windows ? ';' : ':')
    .some((entry) => (windows ? entry !== '' && !pathApi(context).isAbsolute(entry) : !entry.startsWith('/')));
}
function commandCwd(details: HostPermissionDetails, context: HostRiskContext) {
  const cwd = details.cwd || context.workspaceDir;
  return cwd && pathApi(context).isAbsolute(cwd) && ordinaryProjectPath('.', context, cwd) ? cwd : undefined;
}
/** A literal path inside the project. With `pattern`, the last segment may hold `*`/`?` (names only, never content). */
function projectPath(value: string, context: HostRiskContext, cwd: string, pattern = false) {
  if (!value || value.startsWith('-')) return false;
  if (!/[*?[\]]/.test(value)) return ordinaryProjectPath(value, context, cwd);
  if (!pattern || /[[\]]/.test(value)) return false;
  const parts = value.split(/[\\/]/);
  parts.pop();
  if (parts.some((part) => /[*?]/.test(part))) return false;
  return ordinaryProjectPath(parts.length ? parts.join('/') || '/' : '.', context, cwd);
}
/** An existing regular file in the project (not a directory a tool would recurse into). */
function projectFile(value: string, context: HostRiskContext, cwd: string) {
  if (!projectPath(value, context, cwd) || context.platform !== process.platform) return false;
  try {
    return statSync(pathApi(context).resolve(cwd, value)).isFile();
  } catch {
    return false;
  }
}
/** A file this run wrote with a host file tool, read back from the same, non-aliased path. */
function ownWrite(path: string | undefined, context: HostRiskContext) {
  if (!path || !context.ownWrites?.size || !pathApi(context).isAbsolute(path)) return false;
  const resolved = canonical(path, context),
    key = hostPathKey(path, context.platform);
  if (!resolved || hostPathKey(resolved, context.platform) !== key) return false;
  return context.ownWrites.has(key) && !sensitiveParts(resolved.split(/[\\/]/).filter(Boolean));
}

// --- git -----------------------------------------------------------------------------------------------------

// Repository config can make even `git status` run programs (fsmonitor, hooks, filters, textconv, drivers).
const dangerousGitKey =
  /^(?:fsmonitor|hookspath|sshcommand|pager|editor|askpass|textconv|clean|smudge|process|command|program|helper|cmd|external|gitproxy|uploadpack|receivepack|worktree)$/i;
function gitDirectories(cwd: string, context: HostRiskContext) {
  const api = pathApi(context);
  let directory = canonical(cwd, context);
  for (let depth = 0; directory && depth < 40; depth++) {
    const marker = api.join(directory, '.git');
    if (existsSync(marker)) {
      if (statSync(marker).isDirectory()) return [marker];
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'))?.[1]?.trim();
      if (!pointer) return;
      const gitDir = api.resolve(directory, pointer),
        commonFile = api.join(gitDir, 'commondir');
      return existsSync(commonFile) ? [gitDir, api.resolve(gitDir, readFileSync(commonFile, 'utf8').trim())] : [gitDir];
    }
    const parent = api.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
/** The repository has no config or hooks that would run a program during a read-only git command. */
function gitRepositorySafe(cwd: string, context: HostRiskContext) {
  if (context.platform !== process.platform) return false;
  try {
    const directories = gitDirectories(cwd, context);
    if (!directories) return false;
    const api = pathApi(context);
    for (const directory of directories) {
      for (const name of ['config', 'config.worktree']) {
        const file = api.join(directory, name);
        if (!existsSync(file)) continue;
        for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || /^[#;]/.test(line)) continue;
          if (line.startsWith('[')) {
            if (/^\[\s*include/i.test(line)) return false;
            continue;
          }
          if (dangerousGitKey.test(line.split('=')[0].trim())) return false;
        }
      }
      const hooks = api.join(directory, 'hooks');
      if (existsSync(hooks) && readdirSync(hooks).some((name) => !name.endsWith('.sample'))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
const GIT_DENY =
  /^(?:--output|--ext-diff|--textconv|--open-files-in-pager|-O|--no-index|--untracked|--no-exclude-standard|--exec|--upload-pack|--contents|--batch|--stdin|--paginate|--exclude-from|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--follow-symlinks|--file)/;
const GIT_FLAG = /^(?:-[A-Za-z0-9]{1,4}|-\d+|--[a-z][a-z0-9-]*(?:=.*)?)$/;
const gitSubcommands: Record<string, (args: string[]) => boolean> = {
  status: (args) =>
    args.every(
      (a) =>
        !a.startsWith('-') ||
        /^(?:-s|-b|-sb|--short|--branch|--porcelain(?:=v[12])?|--untracked-files(?:=(?:no|normal|all))?|-u(?:no|normal|all)?|--ignored|--no-renames|--ahead-behind|--show-stash|-z)$/.test(
          a,
        ),
    ),
  log: () => true,
  show: () => true,
  diff: () => true,
  shortlog: (args) => args.some((a) => !a.startsWith('-')),
  whatchanged: () => true,
  'rev-list': () => true,
  'rev-parse': () => true,
  'ls-files': () => true,
  'ls-tree': () => true,
  blame: () => true,
  annotate: () => true,
  describe: () => true,
  'merge-base': () => true,
  'count-objects': () => true,
  'show-ref': () => true,
  'cat-file': (args) => args.some((a) => /^-[tspe]$/.test(a)),
  grep: (args) => !args.some((a) => a === '-f'),
  branch: (args) =>
    !args.some((a) =>
      /^-[dDmMcCfu]$|^--(?:delete|move|copy|force|set-upstream|unset-upstream|edit-description|track|no-track)/.test(a),
    ) &&
    (args.every((a) => a.startsWith('-')) ||
      args.some((a) => /^(?:-l|--list|--contains|--merged|--no-merged|--points-at)$/.test(a))),
  tag: (args) =>
    !args.length ||
    (args.some((a) => /^(?:-l|--list)$/.test(a)) &&
      !args.some((a) => /^-[dfsuam]$|^--(?:delete|force|sign|annotate|message|file)/.test(a))),
  remote: (args) =>
    !args.length ||
    (args.length === 1 && /^(?:-v|--verbose)$/.test(args[0])) ||
    (args[0] === 'get-url' && args.length <= 3),
  stash: (args) => ['list', 'show'].includes(args[0]),
  config: (args) =>
    (/^(?:--get|--get-all|--get-regexp)$/.test(args[0] || '') || args[0] === 'get') &&
    args.slice(1).every((a) => /^(?:--(?:local|global|system|show-origin|default=\S*|type=\w+|null)|[\w.-]+)$/.test(a)),
  reflog: (args) => !['expire', 'delete', 'exists', 'drop'].includes(args[0]),
};
function gitReadOnly(args: string[], cwd: string, context: HostRiskContext) {
  if (args.length === 1 && /^(?:--version|version)$/.test(args[0])) return true;
  const [sub, ...rest] = args,
    check = sub ? gitSubcommands[sub] : undefined;
  if (!check || !gitRepositorySafe(cwd, context)) return false;
  let pathspec = false;
  for (const arg of rest) {
    if (arg === '--') {
      pathspec = true;
      continue;
    }
    if (!pathspec && arg.startsWith('-')) {
      if (GIT_DENY.test(arg) || !GIT_FLAG.test(arg)) return false;
      continue;
    }
    // Revisions, values and paths: stay inside the project, away from pathspec magic and credential files.
    if (
      /^[:~\\/]|^[a-z]:/i.test(arg) ||
      arg.split(/[\\/]/).includes('..') ||
      sensitiveParts(arg.split(/[\\/:]/).filter(Boolean))
    )
      return false;
    if (pathspec && !ordinaryProjectPath(arg.replace(/[*?]/g, 'x'), context, cwd)) return false;
  }
  return check(rest);
}

// --- ripgrep -------------------------------------------------------------------------------------------------

const RG_FLAG =
  /^(?:-[nNiIswxFvcloqSH0]{1,6}|-[ABCm]\d+|--(?:line-number|no-line-number|ignore-case|smart-case|case-sensitive|word-regexp|line-regexp|fixed-strings|invert-match|count|count-matches|files-with-matches|files-without-match|only-matching|quiet|no-heading|heading|with-filename|no-filename|column|vimgrep|no-messages|stats|trim|null|files|type-list|json|no-config|color=never|max-columns=\d+|max-count=\d+|max-depth=\d+|context=\d+|before-context=\d+|after-context=\d+|glob=.+|iglob=.+|type=\w+|type-not=\w+|regexp=.+|sort=\w+|sortr=\w+|max-filesize=\w+|encoding=[\w-]+))$/;
const RG_VALUE =
  /^(?:-[eABCmgtT]|--(?:regexp|glob|iglob|type|type-not|context|before-context|after-context|max-count|max-depth|max-columns|sort|sortr|encoding))$/;
function rgReadOnly(args: string[], cwd: string, context: HostRiskContext, piped: boolean) {
  const positional: string[] = [];
  let pattern = false,
    files = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (RG_VALUE.test(arg)) {
      if (args[++i] === undefined) return false;
      if (/^-e$|^--regexp$/.test(arg)) pattern = true;
    } else if (arg.startsWith('-')) {
      if (!RG_FLAG.test(arg)) return false;
      if (arg.startsWith('--regexp=')) pattern = true;
      if (arg === '--files') files = true;
    } else positional.push(arg);
  }
  // --files lists names only (honouring ignore files and skipping hidden ones).
  if (files) return !piped && positional.every((path) => projectPath(path, context, cwd));
  if (!pattern && !positional.length) return false;
  const paths = pattern ? positional : positional.slice(1);
  // A bare recursive search could print matches from credential files: explicit files only, or piped text.
  if (piped) return !paths.length;
  return paths.length > 0 && paths.every((path) => projectFile(path, context, cwd));
}

// --- native commands -----------------------------------------------------------------------------------------

// Version flags that print and exit without reading the project, using the network or switching toolchains.
// Excluded on purpose: go/cargo/rustc (toolchain files can download toolchains), pnpm/yarn (corepack).
const VERSION_FLAGS: Record<string, RegExp> = {
  node: /^(?:--version|-v)$/,
  npm: /^(?:--version|-v)$/,
  python: /^(?:--version|-V)$/,
  python3: /^(?:--version|-V)$/,
  py: /^(?:--version|-V)$/,
  pip: /^(?:--version|-V)$/,
  pip3: /^(?:--version|-V)$/,
  uv: /^(?:--version|-V)$/,
  deno: /^(?:--version|-V)$/,
  bun: /^(?:--version|-v)$/,
  git: /^--version$/,
  gh: /^--version$/,
  rg: /^(?:--version|-V)$/,
  java: /^(?:-version|--version)$/,
  javac: /^(?:-version|--version)$/,
  dotnet: /^--version$/,
  ruby: /^(?:--version|-v)$/,
  php: /^(?:--version|-v)$/,
  perl: /^(?:--version|-v)$/,
  cmake: /^--version$/,
  make: /^--version$/,
  gcc: /^--version$/,
  clang: /^--version$/,
  pwsh: /^(?:--version|-v)$/,
};
const toolName = /^[A-Za-z0-9][\w.+-]{0,63}$/;
interface Util {
  flags?: RegExp;
  /** Flags that take the next word as their value. */
  values?: RegExp;
  paths: 'none' | 'any' | 'required';
  /** May read the previous command's output. */
  filter?: boolean;
  /** The first operand is a pattern, unless `-e` gave one. */
  pattern?: boolean;
  max?: number;
}
// POSIX utilities that only read. `required` keeps a bare command from reading stdin or recursing.
const posixUtils: Record<string, Util> = {
  pwd: { paths: 'none' },
  true: { paths: 'none' },
  whoami: { paths: 'none' },
  uname: { flags: /^-[asnrvmpio]{1,8}$/, paths: 'none' },
  ls: { flags: /^-[alhAR1tSrdFGp]{1,10}$|^--(?:color=never|all|almost-all|human-readable|directory)$/, paths: 'any' },
  cat: { flags: /^-[nbsvAET]{1,4}$/, paths: 'required', filter: true },
  head: { flags: /^-(?:[nc]?\d+)$/, values: /^-[nc]$/, paths: 'any', filter: true },
  tail: { flags: /^-(?:[nc]?\+?\d+)$/, values: /^-[nc]$/, paths: 'any', filter: true },
  wc: { flags: /^-[lwcm]{1,4}$/, paths: 'any', filter: true },
  stat: { flags: /^-[Lc]$|^--format=\S+$/, values: /^-[fc]$/, paths: 'required' },
  file: { flags: /^-[bLi]{1,3}$/, paths: 'required' },
  grep: {
    flags: /^-[inlcvwxEFHhosq]{1,8}$|^-[ABCm]\d+$|^--(?:color=never|count|ignore-case)$/,
    values: /^-[eABCm]$/,
    paths: 'required',
    filter: true,
    pattern: true,
  },
  sort: { flags: /^-[nrufbdhVkt]{1,6}$/, values: /^-[kt]$/, paths: 'any', filter: true },
  uniq: { flags: /^-[cdui]{1,3}$/, paths: 'any', filter: true, max: 1 },
  cut: { flags: /^-[dfcbs]\S*$/, values: /^-[dfcb]$/, paths: 'any', filter: true },
  realpath: { paths: 'required' },
};
const FIND_VALUE = /^-(?:name|iname|path|ipath|type|maxdepth|mindepth|newer|size|mtime|mmin)$/;
function findReadOnly(args: string[], cwd: string, context: HostRiskContext) {
  let i = 0;
  for (; i < args.length && !args[i].startsWith('-') && !/^[()!]$/.test(args[i]); i++)
    if (!projectPath(args[i], context, cwd)) return false;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (/^[()!]$/.test(arg) || /^-(?:empty|print|not|and|or|o|a)$/.test(arg)) continue;
    if (!FIND_VALUE.test(arg) || args[++i] === undefined) return false;
    if (arg === '-newer' && !projectPath(args[i], context, cwd)) return false;
  }
  return true;
}
function utilReadOnly(name: string, spec: Util, args: string[], cwd: string, context: HostRiskContext, piped: boolean) {
  const operands: string[] = [];
  let pattern = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-') && arg !== '-') {
      if (spec.values?.test(arg)) {
        if (args[++i] === undefined) return false;
        if (arg === '-e') pattern = true;
      } else if (!spec.flags?.test(arg)) return false;
    } else operands.push(arg);
  }
  if (spec.pattern && !pattern && !operands.shift()) return false;
  if (spec.paths === 'none') return operands.length === 0;
  if (spec.max !== undefined && operands.length > spec.max) return false;
  if (piped) return Boolean(spec.filter) && !operands.length;
  if (spec.paths === 'required' && !operands.length) return false;
  return operands.every((path) => projectPath(path, context, cwd));
}
/** One native command (argv) that only reads project data. `piped` means it reads the previous command's output. */
function nativeReadOnly(argv: string[], cwd: string, context: HostRiskContext, piped = false): boolean {
  const [raw, ...args] = argv;
  if (!raw || !toolName.test(raw)) return false;
  const windows = context.platform === 'win32',
    name = (windows ? raw.replace(/\.exe$/i, '') : raw).toLowerCase();
  if (name === 'git') return !piped && gitReadOnly(args, cwd, context);
  if (name === 'rg') return rgReadOnly(args, cwd, context, piped);
  if (VERSION_FLAGS[name] && args.length === 1 && VERSION_FLAGS[name].test(args[0])) return !piped;
  if (windows)
    // where.exe NAME is a PATH lookup. Plain `where` is the Where-Object alias, handled with the syntax tree.
    return raw.toLowerCase() === 'where.exe' && !piped && args.length > 0 && args.every((a) => toolName.test(a));
  if (name === 'echo') return args.every((a) => !a.startsWith('-') || /^-[neE]{1,3}$/.test(a));
  if (name === 'which' || name === 'type')
    return !piped && args.length > 0 && args.every((a) => toolName.test(a) || a === '-a');
  if (name === 'command')
    return !piped && args[0] === '-v' && args.length > 1 && args.slice(1).every((a) => toolName.test(a));
  if (name === 'basename' || name === 'dirname') return args.length > 0 && args.every((a) => !a.startsWith('-'));
  if (name === 'tr')
    return piped && args.length <= 2 && args.every((a) => !a.startsWith('-') || /^-[dsc]{1,3}$/.test(a));
  if (name === 'find') return !piped && findReadOnly(args, cwd, context);
  const spec = posixUtils[name];
  return Boolean(spec) && utilReadOnly(name, spec, args, cwd, context, piped);
}

// --- shell words ---------------------------------------------------------------------------------------------

type Segment = { argv: string[]; piped: boolean };
/**
 * Splits a command into simple commands joined by `|`, `&&`, `||` and `;` (POSIX), or a single command (Windows,
 * whose compound forms go through the PowerShell parser). Words are literal: no variables, globs, escapes,
 * substitution, redirection, backgrounding or subshells. Returns undefined for anything else.
 */
function splitCommand(command: string, platform: NodeJS.Platform): Segment[] | undefined {
  if (!command || command.length > 6000 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(command)) return;
  const windows = platform === 'win32',
    plain = windows ? /[A-Za-z0-9_./:=+%^~\\-]/ : /[A-Za-z0-9_./:=+,@%^~-]/;
  const segments: Segment[] = [];
  let argv: string[] = [],
    word = '',
    inWord = false,
    piped = false;
  const end = () => {
    if (!inWord) return;
    // Tilde/`=`/`^` expansion at a word start; PowerShell `-name:value` binding and stop-parsing.
    if (
      /^[~^]/.test(word) ||
      (!windows && word.startsWith('=')) ||
      (windows && (/^-[^:]*:/.test(word) || word === '--%'))
    )
      reject();
    argv.push(word);
    word = '';
    inWord = false;
  };
  const finish = (next: boolean) => {
    end();
    if (!argv.length) reject();
    segments.push({ argv, piped });
    argv = [];
    piped = next;
  };
  try {
    for (let i = 0; i < command.length; i++) {
      const char = command[i];
      if (char === ' ' || char === '\t') end();
      else if (char === "'" || char === '"') {
        if (inWord) return;
        const quoteEnd = command.indexOf(char, i + 1);
        if (quoteEnd < 0) return;
        const value = command.slice(i + 1, quoteEnd),
          after = command[quoteEnd + 1];
        if (!value || (char === '"' ? (windows ? /[$`"]|\\$/ : /[$`\\!"]/).test(value) : value.includes("'"))) return;
        if (after !== undefined && after !== ' ' && after !== '\t' && (windows || !/[|;&]/.test(after))) return;
        word = value;
        inWord = true;
        i = quoteEnd;
      } else if (!windows && (char === '|' || char === ';' || char === '&')) {
        const two = command.slice(i, i + 2);
        if (two === '&&' || two === '||') {
          finish(false);
          i++;
        } else if (char === '|' && command[i + 1] !== '&') finish(true);
        else if (char === ';' && command[i + 1] !== ';') finish(false);
        else return;
      } else if (plain.test(char)) {
        if (windows && char === '\\' && word.endsWith('\\')) return;
        word += char;
        inWord = true;
      } else return;
    }
    finish(false);
  } catch (error) {
    if (error instanceof Rejected) return;
    throw error;
  }
  return segments;
}

// --- PowerShell syntax tree ----------------------------------------------------------------------------------

/** What flows down a pipeline: text, file objects (whose content cmdlets like Select-String would read), or unknown. */
type Stream = 'content' | 'items' | 'unknown';
type ParamKind =
  'switch' | 'path' | 'literalpath' | 'listpath' | 'any' | 'int' | 'enc' | 'name' | 'block' | 'props' | 'text';
interface CmdletSpec {
  params: Record<string, ParamKind>;
  /** Parameter names bound by position, in order. */
  positional?: string[];
  /** Parameter that takes any further positional arguments. */
  rest?: string;
  /** Only valid after `|`. */
  downstream?: boolean;
  /** Only valid as the first command. */
  source?: boolean;
  /** Reads file content from input objects, so it needs text input rather than file objects. */
  needsContent?: boolean;
  /** Needs an explicit path when it is the first command. */
  needsPath?: boolean;
  out: Stream | 'pass';
}
const cmdlets: Record<string, CmdletSpec> = {
  'get-childitem': {
    params: {
      path: 'listpath',
      literalpath: 'literalpath',
      filter: 'any',
      include: 'any',
      exclude: 'any',
      recurse: 'switch',
      depth: 'int',
      force: 'switch',
      name: 'switch',
      file: 'switch',
      directory: 'switch',
      hidden: 'switch',
    },
    positional: ['path', 'filter'],
    source: true,
    out: 'items',
  },
  'get-content': {
    params: {
      path: 'path',
      literalpath: 'literalpath',
      raw: 'switch',
      totalcount: 'int',
      first: 'int',
      head: 'int',
      tail: 'int',
      last: 'int',
      encoding: 'enc',
      readcount: 'int',
    },
    positional: ['path'],
    source: true,
    needsPath: true,
    out: 'content',
  },
  'select-string': {
    params: {
      pattern: 'any',
      path: 'path',
      literalpath: 'literalpath',
      simplematch: 'switch',
      casesensitive: 'switch',
      quiet: 'switch',
      list: 'switch',
      notmatch: 'switch',
      allmatches: 'switch',
      context: 'any',
      encoding: 'enc',
      raw: 'switch',
    },
    positional: ['pattern', 'path'],
    needsContent: true,
    needsPath: true,
    out: 'content',
  },
  'test-path': {
    params: { path: 'listpath', literalpath: 'literalpath', pathtype: 'name' },
    positional: ['path'],
    source: true,
    needsPath: true,
    out: 'content',
  },
  'resolve-path': {
    params: { path: 'path', literalpath: 'literalpath', relative: 'switch' },
    positional: ['path'],
    source: true,
    needsPath: true,
    out: 'unknown',
  },
  'get-item': {
    params: { path: 'path', literalpath: 'literalpath', force: 'switch' },
    positional: ['path'],
    source: true,
    needsPath: true,
    out: 'items',
  },
  'get-filehash': {
    params: { path: 'path', literalpath: 'literalpath', algorithm: 'name' },
    positional: ['path'],
    source: true,
    needsPath: true,
    out: 'unknown',
  },
  'split-path': {
    params: {
      path: 'any',
      parent: 'switch',
      leaf: 'switch',
      leafbase: 'switch',
      extension: 'switch',
      qualifier: 'switch',
      noqualifier: 'switch',
      isabsolute: 'switch',
    },
    positional: ['path'],
    out: 'content',
  },
  'join-path': {
    params: { path: 'any', childpath: 'any', additionalchildpath: 'any' },
    positional: ['path', 'childpath'],
    rest: 'additionalchildpath',
    out: 'content',
  },
  'get-location': { params: {}, source: true, out: 'unknown' },
  'get-date': { params: { format: 'any', uformat: 'any' }, source: true, out: 'content' },
  'get-command': {
    params: { name: 'any', all: 'switch', commandtype: 'name' },
    positional: ['name'],
    source: true,
    out: 'unknown',
  },
  'select-object': {
    params: {
      property: 'props',
      first: 'int',
      last: 'int',
      skip: 'int',
      unique: 'switch',
      expandproperty: 'name',
      excludeproperty: 'any',
      index: 'any',
    },
    positional: ['property'],
    downstream: true,
    out: 'pass',
  },
  'sort-object': {
    params: {
      property: 'props',
      descending: 'switch',
      unique: 'switch',
      casesensitive: 'switch',
      top: 'int',
      bottom: 'int',
    },
    positional: ['property'],
    downstream: true,
    out: 'pass',
  },
  'where-object': { params: { filterscript: 'block' }, positional: ['filterscript'], downstream: true, out: 'pass' },
  'foreach-object': {
    params: { process: 'block', begin: 'block', end: 'block' },
    positional: ['process'],
    downstream: true,
    out: 'unknown',
  },
  'group-object': {
    params: { property: 'props', noelement: 'switch', casesensitive: 'switch' },
    positional: ['property'],
    downstream: true,
    out: 'unknown',
  },
  'measure-object': {
    params: {
      property: 'props',
      sum: 'switch',
      average: 'switch',
      maximum: 'switch',
      minimum: 'switch',
      line: 'switch',
      word: 'switch',
      character: 'switch',
    },
    positional: ['property'],
    downstream: true,
    out: 'unknown',
  },
  'format-table': {
    params: { property: 'props', autosize: 'switch', wrap: 'switch', hidetableheaders: 'switch' },
    positional: ['property'],
    downstream: true,
    out: 'unknown',
  },
  'format-list': { params: { property: 'props' }, positional: ['property'], downstream: true, out: 'unknown' },
  'out-string': { params: { width: 'int', stream: 'switch' }, downstream: true, out: 'content' },
  'out-null': { params: {}, downstream: true, out: 'unknown' },
  'convertfrom-json': { params: { depth: 'int', ashashtable: 'switch' }, downstream: true, out: 'unknown' },
  'convertto-json': { params: { depth: 'int', compress: 'switch' }, downstream: true, out: 'content' },
  'get-member': { params: { membertype: 'name', name: 'any' }, positional: ['name'], downstream: true, out: 'unknown' },
  'write-output': {
    params: { inputobject: 'text', noenumerate: 'switch' },
    positional: ['inputobject'],
    rest: 'inputobject',
    out: 'pass',
  },
  'write-host': {
    params: { object: 'text', nonewline: 'switch', foregroundcolor: 'name', backgroundcolor: 'name', separator: 'any' },
    positional: ['object'],
    rest: 'object',
    out: 'unknown',
  },
};
const aliases: Record<string, string> = {
  ls: 'get-childitem',
  dir: 'get-childitem',
  gci: 'get-childitem',
  cat: 'get-content',
  type: 'get-content',
  gc: 'get-content',
  sls: 'select-string',
  gi: 'get-item',
  pwd: 'get-location',
  gl: 'get-location',
  select: 'select-object',
  sort: 'sort-object',
  where: 'where-object',
  '?': 'where-object',
  foreach: 'foreach-object',
  '%': 'foreach-object',
  group: 'group-object',
  measure: 'measure-object',
  ft: 'format-table',
  fl: 'format-list',
  gm: 'get-member',
  gcm: 'get-command',
  echo: 'write-output',
  write: 'write-output',
};
const pathKinds = new Set<ParamKind>(['path', 'literalpath', 'listpath']);
/** Common parameters every cmdlet accepts that only change how errors and messages are reported. */
const commonParameters: Record<string, RegExp> = {
  erroraction: /^(?:silentlycontinue|continue|stop|ignore)$/i,
  warningaction: /^(?:silentlycontinue|continue|stop|ignore)$/i,
  informationaction: /^(?:silentlycontinue|continue|stop|ignore)$/i,
};
const reservedVariables = new Set([
  '_',
  'psitem',
  'true',
  'false',
  'null',
  'args',
  'input',
  'this',
  'pscmdlet',
  'psboundparameters',
  'myinvocation',
  'executioncontext',
  'host',
  'error',
  'pshome',
  'home',
  'pwd',
  'psscriptroot',
  'pscommandpath',
  'erroractionpreference',
  'warningpreference',
  'verbosepreference',
  'debugpreference',
  'informationpreference',
  'progresspreference',
  'confirmpreference',
  'whatifpreference',
  'outputencoding',
  'psdefaultparametervalues',
  'psmoduleautoloadingpreference',
  'pssessionconfigurationname',
  'psnativecommandargumentpassing',
  'psnativecommanduseerroractionpreference',
  'ofs',
  'maximumhistorycount',
  'nestedpromptlevel',
  'stacktrace',
  'lastexitcode',
  'matches',
  'foreach',
  'switch',
  'event',
  'sender',
  'eventargs',
  'profile',
  'shellid',
  'pid',
  'isglobal',
]);
const blockedReads = new Set(['executioncontext', 'host']);
const safeTypes = new Set([
  'int',
  'int32',
  'int64',
  'long',
  'double',
  'decimal',
  'float',
  'single',
  'string',
  'bool',
  'boolean',
  'char',
  'byte',
  'datetime',
  'timespan',
  'array',
  'object[]',
  'string[]',
  'int[]',
  'hashtable',
  'ordered',
  'pscustomobject',
  'version',
  'system.int32',
  'system.int64',
  'system.string',
  'system.double',
  'system.boolean',
  'system.datetime',
]);
// Range and repetition can allocate without bound; nothing a read-only query needs.
const blockedOperators = new Set(['DotDot', 'Multiply']);
// String methods only. `Replace`, `Delete`, `MoveTo` and friends are excluded: the object could be a FileInfo,
// where FileInfo.Replace would replace a file. The method name alone must be harmless for any object.
const safeMethods = new Set([
  'trim',
  'trimstart',
  'trimend',
  'substring',
  'tolower',
  'toupper',
  'tolowerinvariant',
  'toupperinvariant',
  'split',
  'contains',
  'startswith',
  'endswith',
  'indexof',
  'lastindexof',
  'padleft',
  'padright',
  'tostring',
]);
const mergeStreams = new Set(['Error', 'Warning', 'Verbose', 'Debug', 'Information', 'All']);
interface Scope {
  vars: Map<string, string | undefined>;
  cwd: string;
  context: HostRiskContext;
  /** Inside if/foreach: assignments are no longer known constants. */
  conditional: boolean;
}
const isNode = (value: unknown): value is PsNode =>
  Boolean(value && typeof value === 'object' && typeof (value as PsNode).t === 'string');
const node = (value: unknown): PsNode => (isNode(value) ? value : reject());
const nodes = (value: unknown): PsNode[] => (Array.isArray(value) ? value.map(node) : reject());
const variableName = /^[a-z_][a-z0-9_]{0,63}$/;
function scriptBody(ast: PsNode) {
  if (ast.t !== 'ScriptBlock' || ast.param || ast.dynamic || ast.begin || ast.process || ast.using || ast.requires)
    reject();
  const end = node(ast.end);
  if (end.t !== 'NamedBlock' || end.traps) reject();
  return nodes(end.statements);
}
function statementBlock(value: unknown, scope: Scope) {
  const body = node(value);
  if (body.t !== 'StatementBlock' || body.traps) reject();
  for (const statement of nodes(body.statements)) walkStatement(statement, { ...scope, conditional: true });
}
function walkStatement(statement: PsNode, scope: Scope): void {
  switch (statement.t) {
    case 'Pipeline':
      walkPipeline(statement, scope);
      return;
    case 'PipelineChain':
      if (statement.background || !['AndAnd', 'OrOr'].includes(String(statement.op))) reject();
      walkStatement(node(statement.lhs), scope);
      walkPipeline(node(statement.rhs), { ...scope, conditional: true });
      return;
    case 'Assignment': {
      const left = node(statement.left),
        name = String(left.name ?? '').toLowerCase();
      if (
        statement.op !== 'Equals' ||
        left.t !== 'Variable' ||
        left.splatted ||
        !variableName.test(name) ||
        reservedVariables.has(name)
      )
        reject();
      const right = node(statement.right),
        single = right.t === 'Pipeline' ? nodes(right.elements) : undefined,
        expression =
          right.t === 'CommandExpression'
            ? right
            : single?.length === 1 && single[0].t === 'CommandExpression'
              ? single[0]
              : undefined;
      let value: string | undefined;
      if (expression) {
        redirections(expression.redirections);
        const inner = node(expression.expression);
        value = literal(inner, scope);
        if (value === undefined) expressionNode(inner, scope);
      } else walkStatement(right, scope);
      scope.vars.set(name, scope.conditional ? undefined : value);
      return;
    }
    case 'If':
      for (const clause of (Array.isArray(statement.clauses) ? statement.clauses : reject()) as Array<
        Record<string, unknown>
      >) {
        walkStatement(node(clause.condition), scope);
        statementBlock(clause.body, scope);
      }
      if (statement.else) statementBlock(statement.else, scope);
      return;
    case 'ForEach': {
      if (statement.parallel || !['None', ''].includes(String(statement.flags))) reject();
      const variable = node(statement.variable),
        name = String(variable.name ?? '').toLowerCase();
      if (variable.t !== 'Variable' || !variableName.test(name) || reservedVariables.has(name)) reject();
      walkStatement(node(statement.condition), scope);
      scope.vars.set(name, undefined);
      statementBlock(statement.body, scope);
      return;
    }
    case 'Exit':
    case 'Return':
      if (statement.pipeline) walkStatement(node(statement.pipeline), scope);
      return;
    default:
      reject();
  }
}
function redirections(list: unknown) {
  // `2>&1` merges a stream into output; `2>$null` discards it. Any redirection to a file is rejected.
  for (const item of nodes(list))
    if (item.t === 'NullRedirect') continue;
    else if (item.t !== 'MergeRedirect' || !mergeStreams.has(String(item.from)) || item.to !== 'Output') reject();
}
function walkPipeline(pipeline: PsNode, scope: Scope, pure = false): Stream {
  if (pipeline.t !== 'Pipeline' || pipeline.background) reject();
  const elements = nodes(pipeline.elements);
  if (!elements.length) reject();
  let stream: Stream = 'unknown';
  elements.forEach((element, index) => {
    if (element.t === 'CommandExpression' && index === 0) {
      redirections(element.redirections);
      stream = expressionNode(node(element.expression), scope, false, pure);
    } else if (element.t === 'Command' && !pure) stream = command(element, index, stream, scope);
    else reject();
  });
  return stream;
}
/** The constant text of an expression, when it has one. */
function literal(expression: PsNode, scope: Scope): string | undefined {
  if (expression.t === 'String' || expression.t === 'Constant') return String(expression.value ?? '');
  if (expression.t === 'Variable')
    return expression.splatted ? undefined : scope.vars.get(String(expression.name ?? '').toLowerCase());
  if (expression.t !== 'Expandable') return;
  const text = String(expression.text ?? '');
  if (text.includes('`') || !text.startsWith('"') || !text.endsWith('"')) return;
  let value = text.slice(1, -1);
  for (const nested of nodes(expression.nested)) {
    if (nested.t !== 'Variable' || nested.splatted) return;
    const known = scope.vars.get(String(nested.name ?? '').toLowerCase());
    if (known === undefined) return;
    value = value.split(String(nested.text)).join(known);
  }
  return value.includes('$') ? undefined : value;
}
function variableRead(expression: PsNode) {
  const name = String(expression.name ?? '').toLowerCase();
  if (expression.splatted || blockedReads.has(name)) reject();
  // `${C:\file}` reads a file through its provider; only environment and scope prefixes are plain variables.
  if (name.includes(':') && !/^(?:env|global|script|local):[a-z0-9_]+$/.test(name)) reject();
}
/** Walks an expression; returns 'content' when it evaluates to text. */
function expressionNode(expression: PsNode, scope: Scope, blocks = false, pure = false): Stream {
  switch (expression.t) {
    case 'String':
    case 'Constant':
      return 'content';
    case 'Expandable':
      // "$x" and "$($_.Name): $($_.Line)": each embedded part is walked like any other expression.
      for (const nested of nodes(expression.nested))
        nested.t === 'Variable'
          ? variableRead(nested)
          : nested.t === 'SubExpression'
            ? expressionNode(nested, scope, false, pure)
            : reject();
      return 'content';
    case 'Variable':
      variableRead(expression);
      return 'unknown';
    case 'Member':
      if (expression.static || node(expression.member).t !== 'String') reject();
      expressionNode(node(expression.target), scope, false, pure);
      return 'unknown';
    case 'Invoke': {
      const member = node(expression.member);
      if (expression.static || member.t !== 'String' || !safeMethods.has(String(member.value).toLowerCase())) reject();
      expressionNode(node(expression.target), scope, false, pure);
      for (const arg of nodes(expression.args)) expressionNode(arg, scope, false, pure);
      return 'unknown';
    }
    case 'Index':
      expressionNode(node(expression.target), scope, false, pure);
      expressionNode(node(expression.index), scope, false, pure);
      return 'unknown';
    case 'ArrayLiteral':
      for (const item of nodes(expression.elements)) expressionNode(item, scope, blocks, pure);
      return 'unknown';
    case 'Paren':
      walkPipeline(node(expression.pipeline), scope, pure);
      return 'unknown';
    case 'SubExpression':
    case 'ArrayExpression': {
      const body = node(expression.body);
      if (body.t !== 'StatementBlock' || body.traps) reject();
      for (const statement of nodes(body.statements)) walkPipeline(statement, scope, pure);
      return 'unknown';
    }
    case 'Binary':
      if (blockedOperators.has(String(expression.op))) reject();
      expressionNode(node(expression.left), scope, false, pure);
      expressionNode(node(expression.right), scope, false, pure);
      return 'unknown';
    case 'Unary':
      expressionNode(node(expression.child), scope, false, pure);
      return 'unknown';
    case 'Convert':
      if (!safeTypes.has(String(expression.type).toLowerCase())) reject();
      expressionNode(node(expression.child), scope, blocks, pure);
      return 'unknown';
    case 'Hashtable':
      for (const pair of (Array.isArray(expression.pairs) ? expression.pairs : reject()) as Array<
        Record<string, unknown>
      >) {
        expressionNode(node(pair.key), scope, false, true);
        const value = node(pair.value);
        if (value.t === 'Pipeline') {
          const elements = nodes(value.elements);
          if (elements.length !== 1 || elements[0].t !== 'CommandExpression') reject();
          redirections(elements[0].redirections);
          expressionNode(node(elements[0].expression), scope, blocks, true);
        } else expressionNode(value, scope, blocks, true);
      }
      return 'unknown';
    case 'Block':
      if (!blocks) reject();
      // A script block that only computes values: every statement is an expression, never a command.
      for (const statement of scriptBody(node(expression.body))) walkPipeline(statement, scope, true);
      return 'unknown';
    default:
      return reject();
  }
}
function command(element: PsNode, index: number, upstream: Stream, scope: Scope): Stream {
  if (element.invocation !== 'Unknown') reject();
  redirections(element.redirections);
  const [first, ...args] = nodes(element.elements);
  if (!first || first.t !== 'String' || first.kind !== 'BareWord') reject();
  const raw = String(first.value).toLowerCase();
  if (!/^(?:[a-z0-9][\w.+-]{0,63}|[%?])$/.test(raw)) reject();
  const name = aliases[raw] || raw,
    spec = cmdlets[name];
  if (spec) return cmdlet(spec, name, args, index, upstream, scope);
  // Not a known cmdlet: Verb-Noun names are cmdlets or functions we do not know; anything else is a program.
  if (raw.includes('-') && !raw.endsWith('.exe')) reject();
  const argv = [raw, ...args.map((arg) => nativeArgument(arg, scope))];
  if (!nativeReadOnly(argv, scope.cwd, scope.context, index > 0)) reject();
  return 'content';
}
function nativeArgument(arg: PsNode, scope: Scope) {
  if (String(arg.text ?? '').includes('`')) reject();
  const value =
    arg.t === 'Parameter'
      ? arg.argument
        ? undefined
        : String(arg.text ?? '')
      : arg.t === 'Constant'
        ? String(arg.text ?? '')
        : literal(arg, scope);
  // Windows PowerShell passes embedded quotes and trailing backslashes unescaped and drops empty strings, so
  // such arguments could reach the program as different words.
  if (!value || /["\u0000-\u001f]/.test(value) || value.endsWith('\\') || /^-[^:=]*:/.test(value)) reject();
  return value!;
}
function cmdlet(spec: CmdletSpec, name: string, args: PsNode[], index: number, upstream: Stream, scope: Scope): Stream {
  if ((spec.downstream && index === 0) || (spec.source && index > 0)) reject();
  if (spec.needsContent && index > 0 && upstream !== 'content') reject();
  const bound = new Map<string, PsNode | true>();
  const nextPositional = () => {
    const positional = spec.positional?.find((key) => !bound.has(key));
    return positional || (spec.rest && spec.params[spec.rest] ? spec.rest : undefined);
  };
  let restCount = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let key: string | undefined, value: PsNode | true;
    if (arg.t === 'Parameter') {
      key = String(arg.name ?? '').toLowerCase();
      if (commonParameters[key] && !arg.argument) {
        const next = args[++i];
        if (!next || !commonParameters[key].test(literal(next, scope) ?? '')) reject();
        continue;
      }
      if (!spec.params[key] || bound.has(key) || arg.argument) reject();
      if (spec.params[key] === 'switch') value = true;
      else {
        const next = args[++i];
        if (!next || next.t === 'Parameter') reject();
        value = next;
      }
    } else {
      key = nextPositional();
      if (!key) reject();
      value = arg;
    }
    const kind = spec.params[key!];
    if (value !== true) check(kind, value, scope);
    if (key === spec.rest && bound.has(key!)) bound.set(key + ':' + ++restCount, value);
    else bound.set(key!, value);
  }
  const hasPath = [...bound.keys()].some((key) => pathKinds.has(spec.params[key.split(':')[0]]));
  if (index > 0 && hasPath) reject();
  if (index === 0 && (spec.needsPath || spec.needsContent) && !hasPath) reject();
  if (name === 'write-output') {
    if (index > 0) return upstream;
    // Text only when every argument is constant text; a variable may hold file objects.
    return [...bound.values()].every((value) => value !== true && literal(value, scope) !== undefined)
      ? 'content'
      : 'unknown';
  }
  return spec.out === 'pass' ? upstream : spec.out;
}
function check(kind: ParamKind, value: PsNode, scope: Scope) {
  switch (kind) {
    case 'path':
    case 'listpath':
    case 'literalpath':
      for (const item of value.t === 'ArrayLiteral' ? nodes(value.elements) : [value]) {
        const path = literal(item, scope);
        if (path === undefined) reject();
        const ok =
          kind === 'literalpath'
            ? !path!.startsWith('-') && ordinaryProjectPath(path!, scope.context, scope.cwd)
            : projectPath(path!, scope.context, scope.cwd, kind === 'listpath');
        if (!ok) reject();
      }
      return;
    case 'int':
      if (!/^-?\d{1,9}$/.test(literal(value, scope) ?? '')) reject();
      return;
    case 'enc':
      if (
        !/^(?:utf8|utf8bom|utf8nobom|ascii|unicode|bigendianunicode|utf32|default|oem)$/i.test(
          literal(value, scope) ?? '',
        )
      )
        reject();
      return;
    case 'name':
      if (!/^[\w.*-]{1,64}$/.test(literal(value, scope) ?? '')) reject();
      return;
    case 'block':
      if (value.t !== 'Block') reject();
      expressionNode(value, scope, true);
      return;
    case 'props':
      expressionNode(value, scope, true);
      return;
    case 'any':
    case 'text':
      expressionNode(value, scope);
      return;
    default:
      reject();
  }
}

// --- entry points ----------------------------------------------------------------------------------------------

/**
 * A PowerShell script, as parsed by PowerShellParser, made only of read-only project queries: listing, reading
 * and searching project files, git and other known read-only tools, filters, formatting and constant variables.
 */
export function assessPowerShell(ast: PsNode, details: HostPermissionDetails, context: HostRiskContext): Verdict {
  const no = { lowRisk: false, reason: '操作超出可直接放行的项目操作范围' };
  if (details.operation !== 'command' || details.stdin !== undefined || context.platform !== 'win32') return no;
  const cwd = commandCwd(details, context);
  if (!cwd || relativePath(context)) return no;
  try {
    const body = scriptBody(ast);
    if (!body.length) return no;
    const scope: Scope = { vars: new Map(), cwd, context, conditional: false };
    for (const statement of body) walkStatement(statement, scope);
    return { lowRisk: true, reason: '解析后的命令只包含当前工作目录内的只读查询' };
  } catch {
    // Rejected, or a tree this policy does not understand: either way not a recognized read-only query.
    return no;
  }
}
/** classifyHostOperation plus read-only native commands (and POSIX pipelines of them) and reads of this run's own files. */
export function classifyHostCommand(details: HostPermissionDetails, context: HostRiskContext): Verdict {
  const base = classifyHostOperation(details, context);
  if (base.lowRisk) return base;
  if (details.operation === 'read_file' && ownWrite(details.path, context))
    return { lowRisk: true, reason: '读取本次任务刚写入的文件' };
  if (details.operation !== 'command' || !details.command || details.stdin !== undefined) return base;
  const cwd = commandCwd(details, context);
  if (!cwd || relativePath(context)) return base;
  const segments = splitCommand(details.command.trim(), context.platform);
  try {
    if (segments?.length && segments.every((segment) => nativeReadOnly(segment.argv, cwd, context, segment.piped)))
      return { lowRisk: true, reason: '只读查询命令，范围在当前工作目录内' };
  } catch {}
  return base;
}
