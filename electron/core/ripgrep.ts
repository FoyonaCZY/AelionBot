import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ignoredDirectories, type FileSearchRequest } from './file-search-types';
import { findExecutable } from './host-platform';

// AELION_RIPGREP selects a binary (absolute path) or disables the prefilter with "off".
export function findRipgrep(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const override = env.AELION_RIPGREP;
  if (override === 'off') return;
  if (override) return isAbsolute(override) && existsSync(override) ? override : undefined;
  return findExecutable('rg', env, platform);
}
// JS \b is ASCII-only; Rust's default \b is Unicode-aware and would drop matches such as "éword" for \bword.
export function ripgrepPattern(source: string) {
  let result = '',
    klass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && i + 1 < source.length) {
      const next = source[++i];
      result += !klass && (next === 'b' || next === 'B') ? `(?-u:\\${next})` : '\\' + next;
      continue;
    }
    if (char === '[') klass = true;
    else if (char === ']') klass = false;
    result += char;
  }
  return result;
}
function globArgs(glob: string, platform: NodeJS.Platform) {
  // Only single-segment globs are passed through; everything else is filtered exactly by the worker.
  // A file type rather than --glob: an rg glob whitelist would override .gitignore.
  const name = glob.replace(/^(?:\*\*\/)+/, '');
  if (!name || name === '*' || name === '**' || name.includes('/') || /[[\]{}!\\,:]/.test(name)) return [];
  // The walker compares lowercase paths on Windows; type globs are case-sensitive.
  const pattern =
    platform === 'win32' ? name.replace(/[a-z]/gi, (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`) : name;
  return ['--type-add', `aelion:${pattern}`, '--type', 'aelion'];
}
function ripgrepArgs(request: FileSearchRequest, platform = process.platform) {
  // No config file, and no ignore sources the JS walker does not read either: the list must stay a superset.
  const args = [
    '--no-config',
    '--no-messages',
    '--null',
    '--hidden',
    '--no-ignore-dot',
    '--no-ignore-global',
    '--no-ignore-exclude',
    '--no-ignore-parent',
    '--no-require-git',
  ];
  if (!request.respectIgnore) args.push('--no-ignore-vcs');
  args.push(...globArgs(request.glob, platform));
  for (const name of ['.git', ...ignoredDirectories]) args.push('--glob', '!' + name);
  if (request.kind === 'find') args.push('--files');
  else {
    args.push(
      '--files-with-matches',
      '--crlf',
      '--engine',
      'auto',
      '--max-filesize',
      '2M',
      request.caseSensitive ? '--case-sensitive' : '--ignore-case',
    );
    if (request.regex) args.push('-e', ripgrepPattern(request.query!));
    else args.push('--fixed-strings', '-e', request.query!);
  }
  args.push('--', '.');
  return args;
}
export interface RipgrepCandidates {
  paths: string[];
  limitReason?: string;
}
// Resolves undefined whenever the list may be incomplete for a reason other than a limit, so the caller walks instead.
export function ripgrepCandidates(
  binary: string,
  request: FileSearchRequest,
  signal: AbortSignal,
  timeoutMs: number,
  maxPaths = 50000,
): Promise<RipgrepCandidates | undefined> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.RIPGREP_CONFIG_PATH;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ripgrepArgs(request), {
        cwd: request.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const paths: string[] = [];
    let pending: Buffer = Buffer.alloc(0),
      bytes = 0,
      limitReason: string | undefined,
      done = false;
    const stop = (reason: string) => {
      limitReason ??= reason;
      child.kill();
    };
    const finish = (value: RipgrepCandidates | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => {
      child.kill();
      finish(undefined);
    };
    const timer = setTimeout(() => stop('达到检索时间上限，请缩小 path 或 glob'), timeoutMs);
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (limitReason) return;
      bytes += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let index: number;
      while ((index = pending.indexOf(0)) >= 0) {
        paths.push(join(request.root, pending.subarray(0, index).toString('utf8')));
        pending = pending.subarray(index + 1);
      }
      if (paths.length >= maxPaths || bytes > 32 * 1024 * 1024) stop(`候选文件超过 ${maxPaths}，请缩小 path 或 glob`);
    });
    child.stderr!.resume();
    child.once('error', () => finish(undefined));
    child.once('close', (code) => {
      if (limitReason) finish({ paths: paths.slice(0, maxPaths), limitReason });
      // 0 = matches, 1 = none. 2 means an error (bad pattern, unreadable path): the walk reports it precisely.
      else finish(code === 0 || code === 1 ? { paths } : undefined);
    });
  });
}
