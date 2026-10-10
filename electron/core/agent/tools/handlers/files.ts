import { expectedHash, FileToolError } from '../../../tools/file-text';
import { applyHostPatch, applyVmPatch, interceptedShellPatch, parsePatch } from '../../../tools/multi-patch';
import { toolLocation } from '../../../tools/approval-reason';
import { readVmFile, patchVmFile, VM_WRITE } from '../../../vm/vm-files';
import { vmPython } from '../../../vm/vm-python';
import type { ToolContext, ToolHandler } from '../context';
import { requiredText, workspacePath } from '../validation';

const vmFile: ToolHandler = async ({ bot, args, name, signal, runId, deps }) => {
  const path = workspacePath(requiredText(args, 'path', 500), bot.id),
    redact = (value: string) => (deps.host ? deps.host.redact(value, true) : value);
  if (name === 'file_read') return readVmFile(deps.vm, bot.id, path, args, signal, redact);
  if (name === 'file_patch')
    return patchVmFile(deps.vm, deps.fileCheckpoints, bot.id, runId, path, args, signal, redact);
  const content = args.content;
  if (typeof content !== 'string' || content.length > 200000) throw new Error('无效文件内容');
  const expected = expectedHash(args.expectedSha256);
  const checkpoint = await deps.fileCheckpoints.vmBefore(bot.id, runId, path, signal);
  const result = await vmPython(deps.vm, bot.id, { path, content, expectedSha256: expected }, VM_WRITE, signal);
  if (!signal.aborted && result.exitCode === 0) await deps.fileCheckpoints.vmAfter(checkpoint, signal, content);
  return result;
};

const VM_BROWSE = String.raw`
import fnmatch, json, os, pathlib, re
root = pathlib.Path.cwd().resolve()
kind = a.get('kind')
raw = a.get('path') or '.'
target = (root / raw).resolve()
def fail(code, message):
    print(json.dumps({'errorCode': code, 'error': message}, ensure_ascii=False))
    raise SystemExit
if not target.is_relative_to(root):
    fail('PATH_OUTSIDE_WORKSPACE', '路径超出当前 Bot 工作目录')
else:
    offset = max(0, int(a.get('offset') or 0))
    limit = int(a.get('limit') or (250 if kind == 'list' else 100))
    limit = max(1, min(limit, 1000 if kind == 'list' else 200))
    skip = {'.git', 'node_modules', '.aelion'}
    def allowed(path):
        try:
            resolved = path.resolve()
        except OSError:
            return False
        return resolved.is_relative_to(root) and not any(part in skip for part in resolved.relative_to(root).parts)
    if kind == 'list':
        if not target.is_dir():
            fail('NOT_DIRECTORY', '这不是目录')
        else:
            rows = []
            for child in sorted(target.iterdir(), key=lambda item: item.name):
                if child.is_symlink():
                    rows.append({'name': child.name, 'kind': 'link'})
                elif child.is_dir():
                    rows.append({'name': child.name, 'kind': 'directory'})
                else:
                    rows.append({'name': child.name, 'kind': 'file'})
            nxt = min(len(rows), offset + limit)
            print(json.dumps({'path': str(target), 'location': 'vm', 'items': rows[offset:nxt], 'total': len(rows), 'nextOffset': nxt, 'truncated': nxt < len(rows), 'eof': nxt >= len(rows)}, ensure_ascii=False))
    else:
        pattern = str(a.get('pattern') or a.get('glob') or '**/*')
        if len(pattern) > 500:
            fail('INVALID_ARGUMENT', 'glob 过长')
        else:
            paths = []
            scanned = 0
            limited = False
            walker = target.rglob('*') if '**' in pattern else target.glob(pattern if any(ch in pattern for ch in '*?[') else '**/*')
            try:
                for path in walker:
                    scanned += 1
                    if scanned > 5000:
                        limited = True
                        break
                    if not path.is_file() or path.is_symlink() or not allowed(path):
                        continue
                    rel = path.relative_to(root).as_posix()
                    if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(path.name, pattern):
                        paths.append(path)
            except OSError:
                pass
            paths.sort(key=lambda path: path.as_posix())
            if kind == 'find':
                nxt = min(len(paths), offset + limit)
                print(json.dumps({'location': 'vm', 'files': [item.relative_to(root).as_posix() for item in paths[offset:nxt]], 'total': len(paths), 'nextOffset': nxt, 'eof': nxt >= len(paths), 'scanLimited': limited}, ensure_ascii=False))
            else:
                query = str(a.get('query') or '')
                flags = 0 if a.get('caseSensitive', True) else re.IGNORECASE
                try:
                    matcher = re.compile(query if a.get('regex') else re.escape(query), flags)
                except re.error:
                    fail('INVALID_ARGUMENT', '正则无效')
                    matcher = None
                matches = []
                if matcher is not None:
                    mode = a.get('outputMode') or 'content'
                    for path in paths:
                        if len(matches) >= offset + limit:
                            break
                        try:
                            blob = path.read_bytes()[:262144]
                        except OSError:
                            continue
                        if b'\0' in blob[:1024]:
                            continue
                        text = blob.decode('utf-8', 'replace')
                        lines = text.splitlines()
                        hits = [index for index, line in enumerate(lines, 1) if matcher.search(line)]
                        rel = path.relative_to(root).as_posix()
                        if mode == 'files' and hits:
                            matches.append({'path': rel, 'line': hits[0]})
                        elif mode == 'count':
                            if hits:
                                matches.append({'path': rel, 'count': len(hits)})
                        else:
                            for line in hits:
                                matches.append({'path': rel, 'line': line, 'text': lines[line - 1][:500]})
                                if len(matches) >= offset + limit:
                                    break
                page = matches[offset:offset + limit]
                print(json.dumps({'location': 'vm', 'matches': page, 'nextOffset': offset + len(page), 'eof': offset + len(page) >= len(matches), 'scanLimited': limited}, ensure_ascii=False))
`;

async function browseVm(ctx: ToolContext, kind: 'list' | 'find' | 'search') {
  const path = ctx.args.path === undefined ? '.' : workspacePath(requiredText(ctx.args, 'path', 500), ctx.bot.id);
  const command = await vmPython(
    ctx.deps.vm,
    ctx.bot.id,
    {
      kind,
      path,
      pattern: ctx.args.pattern,
      glob: ctx.args.glob,
      query: ctx.args.query,
      regex: ctx.args.regex === true,
      caseSensitive: ctx.args.caseSensitive !== false,
      outputMode: ctx.args.outputMode,
      offset: ctx.args.offset,
      limit: ctx.args.limit,
    },
    VM_BROWSE,
    ctx.signal,
  );
  ctx.signal.throwIfAborted();
  if (command.exitCode !== 0) throw new FileToolError('VM_FILE_ERROR', command.stderr || '工作电脑检索失败');
  let result: any;
  try {
    result = JSON.parse(command.stdout);
  } catch {
    throw new FileToolError('VM_FILE_ERROR', '工作电脑未返回完整的检索结果');
  }
  if (result.errorCode) throw new FileToolError(result.errorCode, result.error);
  const redact = (value: string) => (ctx.deps.host ? ctx.deps.host.redact(value, true) : value);
  if (Array.isArray(result.matches))
    for (const match of result.matches) if (typeof match.text === 'string') match.text = redact(match.text);
  return result;
}

function hostReady(ctx: ToolContext) {
  if (!ctx.deps.host || !ctx.deps.interactions) throw new Error('本机操作尚未启用');
  return ctx.deps.host;
}

const fileTool =
  (name: 'file_read' | 'file_write' | 'file_patch'): ToolHandler =>
  (ctx) => {
    if (toolLocation(ctx.args) === 'vm') return vmFile({ ...ctx, name });
    const host = hostReady(ctx),
      workspace = ctx.run?.workspaceDir;
    if (name === 'file_read') return host.readFile(ctx.bot.id, ctx.runId, ctx.args, ctx.signal, workspace);
    if (name === 'file_write') return host.writeFile(ctx.bot.id, ctx.runId, ctx.args, ctx.signal, workspace);
    return host.patchFile(ctx.bot.id, ctx.runId, ctx.args, ctx.signal, workspace);
  };

const searchTool =
  (kind: 'list' | 'find' | 'search'): ToolHandler =>
  (ctx) => {
    if (toolLocation(ctx.args) === 'vm') return browseVm(ctx, kind);
    const host = hostReady(ctx),
      workspace = ctx.run?.workspaceDir;
    if (kind === 'list') return host.listDirectory(ctx.bot.id, ctx.runId, ctx.args, ctx.signal, workspace);
    return host.searchFiles(
      ctx.bot.id,
      ctx.runId,
      ctx.args,
      ctx.signal,
      workspace,
      kind === 'find' ? 'find' : 'search',
    );
  };

export const FILE_HANDLERS: Record<string, ToolHandler> = {
  apply_patch: async ({ bot, args, signal, runId, workspace, deps }) => {
    if (toolLocation(args) === 'vm') {
      const checkpoints = [];
      for (const file of parsePatch(args.patch))
        for (const path of [file.path, ...(file.moveTo ? [file.moveTo] : [])])
          checkpoints.push(await deps.fileCheckpoints.vmBefore(bot.id, runId, path, signal));
      const result = await applyVmPatch(deps.vm, bot.id, args, signal);
      for (const record of checkpoints)
        if (record) {
          const file = result.files.find((file: any) => file.path === record.path);
          if (file) deps.fileCheckpoints.vmReceipt(record, file.sha256);
        }
      return result;
    }
    if (!deps.host || !deps.interactions) throw Error('本机文件工具不可用');
    return applyHostPatch(deps.host, deps.interactions, bot.id, runId, args, signal, workspace);
  },
  checkpoint_list: ({ bot, deps }) => deps.fileCheckpoints.list(bot.id),
  checkpoint_restore: ({ bot, args, signal, runId, deps }) =>
    deps.fileCheckpoints.restore(bot.id, requiredText(args, 'id', 100), signal, runId),
  file_read: fileTool('file_read'),
  file_write: fileTool('file_write'),
  file_patch: fileTool('file_patch'),
  list_directory: searchTool('list'),
  find_files: searchTool('find'),
  search_files: searchTool('search'),
};

export async function execPatch(ctx: ToolContext, command: string) {
  const patch = interceptedShellPatch(command);
  if (!patch) return;
  return FILE_HANDLERS.apply_patch({ ...ctx, name: 'apply_patch', args: { ...ctx.args, patch } });
}
