import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
  realpathSync,
  chmodSync,
  linkSync,
  copyFileSync,
  constants,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decodeText, FileToolError, indentOf, reindent, seekLines, similarLines } from './file-text';
import type { HostComputer } from './host';
import type { Interactions } from './interactions';
import type { VmController } from './vm';
import { vmPython } from './vm-python';
interface HunkOp {
  op: ' ' | '-' | '+';
  text: string;
}
interface Hunk {
  before: string[];
  after: string[];
  eof: boolean;
  ops?: HunkOp[];
  anchor?: string;
}
export interface FilePatch {
  kind: 'add' | 'update' | 'delete';
  path: string;
  moveTo?: string;
  content?: string;
  hunks: Hunk[];
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function parsePatch(value: unknown): FilePatch[] {
  if (typeof value !== 'string' || value.length > 256000)
    throw new FileToolError('INVALID_PATCH', '补丁需要最多 256000 字符的文本');
  const lines = value.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch')
    throw new FileToolError('INVALID_PATCH', '补丁需要 *** Begin Patch 和 *** End Patch');
  const files: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index++]);
    if (!match) throw new FileToolError('INVALID_PATCH', '缺少 Add/Update/Delete File 文件头');
    const kind = match[1].toLowerCase() as FilePatch['kind'],
      file: FilePatch = { kind, path: match[2], hunks: [] };
    if (/[\0\r\n]/.test(file.path) || file.path.length > 1500) throw Error('补丁路径无效');
    if (kind === 'add') {
      const content: string[] = [];
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        const line = lines[index++];
        if (!line.startsWith('+')) throw new FileToolError('INVALID_PATCH', '新增文件内容每行必须以 + 开头');
        content.push(line.slice(1));
      }
      file.content = content.join('\n') + (content.length ? '\n' : '');
    }
    if (kind === 'update') {
      if (lines[index]?.startsWith('*** Move to: ')) file.moveTo = lines[index++].slice(13);
      while (index < lines.length && (!lines[index].startsWith('*** ') || lines[index] === '*** End of File')) {
        if (!lines[index].startsWith('@@')) throw new FileToolError('INVALID_PATCH', '修改片段需要 @@ 标记');
        const anchor = lines[index++].slice(2).trim();
        const hunk: Hunk = { before: [], after: [], eof: false, ops: [], ...(anchor ? { anchor } : {}) };
        // A bare empty line is an empty context line; patch generators often drop its leading space.
        while (index < lines.length && !lines[index].startsWith('@@') && !lines[index].startsWith('*** ')) {
          const line = lines[index++],
            prefix = line === '' ? ' ' : line[0],
            text = line.slice(1);
          if (![' ', '+', '-'].includes(prefix))
            throw new FileToolError('INVALID_PATCH', '片段行需要空格、+ 或 - 前缀');
          if (prefix !== '+') hunk.before.push(text);
          if (prefix !== '-') hunk.after.push(text);
          hunk.ops!.push({ op: prefix as HunkOp['op'], text });
        }
        if (lines[index] === '*** End of File') {
          hunk.eof = true;
          index++;
        }
        if (!hunk.before.length && !hunk.after.length) throw Error('补丁片段为空');
        file.hunks.push(hunk);
      }
      if (!file.hunks.length && !file.moveTo) throw new FileToolError('INVALID_PATCH', '修改文件需要片段或重命名目标');
    }
    files.push(file);
    if (files.length > 40) throw Error('一次补丁最多修改 40 个文件');
  }
  if (!files.length) throw Error('补丁没有文件操作');
  return files;
}
type Row = { text: string; eol: string };
const hunkOps = (hunk: Hunk) =>
  hunk.ops || [
    ...hunk.before.map((text) => ({ op: '-' as const, text })),
    ...hunk.after.map((text) => ({ op: '+' as const, text })),
  ];
const patternOf = (ops: HunkOp[]) => ops.filter((item) => item.op !== '+').map((item) => item.text);
export function applyHunks(bytes: Buffer, hunks: Hunk[]) {
  const decoded = decodeText(bytes),
    parts = decoded.text ? decoded.text.split(/(?<=\n)/) : [];
  // Each line keeps its own ending, so a patch never rewrites the endings of untouched lines.
  const rows: Row[] = parts.map((part) => {
    const eol = part.endsWith('\r\n') ? '\r\n' : part.endsWith('\n') ? '\n' : '';
    return { text: part.slice(0, part.length - eol.length), eol };
  });
  const trailing = rows.length > 0 && rows.at(-1)!.eol !== '',
    newline =
      rows.filter((row) => row.eol === '\r\n').length > rows.filter((row) => row.eol === '\n').length ? '\r\n' : '\n';
  let cursor = 0;
  for (const hunk of hunks) {
    // An @@ anchor line (e.g. a function signature) narrows where the hunk starts, as in Codex.
    const anchored = hunk.anchor
      ? seekLines(
          rows.map((row) => row.text),
          [hunk.anchor],
          cursor,
        )
      : undefined;
    if (anchored) cursor = anchored.matches[0] + 1;
    let ops = hunkOps(hunk),
      seek = seekLines(
        rows.map((row) => row.text),
        patternOf(ops),
        cursor,
        hunk.eof,
      );
    // A bare blank line closing a hunk is often a separator rather than real context.
    while (!seek && ops.length > 1 && ops.at(-1)!.op === ' ' && ops.at(-1)!.text === '') {
      ops = ops.slice(0, -1);
      seek = seekLines(
        rows.map((row) => row.text),
        patternOf(ops),
        cursor,
        hunk.eof,
      );
    }
    if (!seek || seek.matches.length !== 1)
      throw new FileToolError(
        seek ? 'PATCH_AMBIGUOUS' : 'PATCH_NOT_FOUND',
        seek
          ? '补丁上下文匹配多处，请增加上下文'
          : '补丁上下文与当前文件不匹配（已尝试忽略空白和常见 Unicode 标点差异），请重新读取',
        seek
          ? undefined
          : {
              similarLines: similarLines(
                rows.map((row) => row.text),
                patternOf(ops),
              ),
            },
      );
    const at = seek.matches[0],
      pattern = patternOf(ops),
      first = pattern.findIndex((line) => line.trim()),
      fuzzy = first >= 0 && (seek.strategy === 'trim' || seek.strategy === 'unicode');
    const from = fuzzy ? indentOf(pattern[first]) : '',
      to = fuzzy ? indentOf(rows[at + first].text) : '',
      replaced: Row[] = [];
    let source = at;
    // Context keeps the file's exact text; only added lines come from the patch.
    for (const item of ops) {
      if (item.op === ' ') replaced.push(rows[source++]);
      else if (item.op === '-') source++;
      else replaced.push({ text: reindent([item.text], from, to)[0], eol: newline });
    }
    rows.splice(at, pattern.length, ...replaced);
    cursor = at + replaced.length;
  }
  rows.forEach((row, index) => {
    if (index < rows.length - 1 && !row.eol) row.eol = newline;
  });
  if (rows.length) rows.at(-1)!.eol = trailing ? rows.at(-1)!.eol || newline : '';
  return Buffer.from((decoded.bom ? '\uFEFF' : '') + rows.map((row) => row.text + row.eol).join(''), 'utf8');
}
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(canonical(parent), path.slice(parent.length).replace(/^[\\/]+/, ''));
}
export async function applyHostPatch(
  host: HostComputer,
  interactions: Interactions,
  botId: string,
  runId: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  workspace?: string,
) {
  const files = parsePatch(args.patch);
  if (typeof args.reason !== 'string' || !args.reason.trim()) throw Error('本机补丁需要操作原因');
  const operations = files.map((file) => ({
      ...file,
      path: canonical(host.resolveFilePath(file.path, workspace)),
      moveTo: file.moveTo ? canonical(host.resolveFilePath(file.moveTo, workspace)) : undefined,
    })),
    targets = new Set<string>();
  for (const file of operations)
    for (const path of [file.path, ...(file.moveTo ? [file.moveTo] : [])]) {
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (targets.has(key))
        throw new FileToolError('PATCH_OVERLAP', '同一批补丁不能多次操作同一路径，请合并片段或拆分重命名链');
      targets.add(key);
    }
  for (const file of operations) {
    await interactions.permission(
      botId,
      runId,
      {
        operation: file.kind === 'delete' || file.moveTo ? 'delete_file' : 'write_file',
        reason: args.reason,
        path: file.path,
        overwrite: file.kind !== 'add',
        content: String(args.patch),
        tool: 'apply_patch',
      },
      signal,
    );
    if (file.moveTo)
      await interactions.permission(
        botId,
        runId,
        {
          operation: 'write_file',
          reason: args.reason,
          path: file.moveTo,
          overwrite: false,
          content: String(args.patch),
          tool: 'apply_patch',
        },
        signal,
      );
  }
  signal.throwIfAborted();
  const before = new Map<string, Buffer | null>(),
    after = new Map<string, Buffer | null>(),
    modes = new Map<string, number>();
  let total = 0;
  for (const file of operations) {
    if (canonical(file.path) !== file.path || (file.moveTo && canonical(file.moveTo) !== file.moveTo))
      throw Error('补丁路径在确认后变化');
    const exists = existsSync(file.path);
    if (file.kind === 'add' ? exists : !exists)
      throw new FileToolError('PATCH_FILE_STATE', file.kind === 'add' ? '新增文件已存在' : '要修改或删除的文件不存在');
    if (exists && (!statSync(file.path).isFile() || statSync(file.path).size > 2 * 1024 * 1024))
      throw Error('补丁仅支持 2 MB 以内的普通文件');
    const bytes = exists ? readFileSync(file.path) : null;
    total += bytes?.length || 0;
    if (total > 8 * 1024 * 1024) throw Error('本次补丁原文件总量超过 8 MB');
    before.set(file.path, bytes);
    if (exists) modes.set(file.path, statSync(file.path).mode);
    if (file.moveTo) {
      if (existsSync(file.moveTo)) throw Error('重命名目标已存在');
      before.set(file.moveTo, null);
      modes.set(file.moveTo, modes.get(file.path)!);
    }
    const content =
      file.kind === 'delete' ? null : file.kind === 'add' ? Buffer.from(file.content!) : applyHunks(bytes!, file.hunks);
    if (content && host.redact(content.toString()) !== content.toString() && content.toString().includes('[redacted'))
      throw Error('不能将脱敏占位符写回文件');
    after.set(file.path, file.moveTo ? null : content);
    if (file.moveTo) after.set(file.moveTo, content);
  }
  const snapshots = new Map([...before].map(([path]) => [path, host.options.beforeWrite?.(botId, runId, path)])),
    applied: string[] = [];
  const matches = (path: string, bytes: Buffer | null) =>
    canonical(path) === path &&
    (bytes
      ? existsSync(path) && statSync(path).isFile() && hash(readFileSync(path)) === hash(bytes)
      : !existsSync(path));
  const write = (path: string, bytes: Buffer | null, exclusive = false) => {
    if (bytes === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), '.aelion-patch-' + randomUUID());
    try {
      writeFileSync(tmp, bytes, { flag: 'wx', mode: modes.get(path) });
      if (modes.has(path) && process.platform !== 'win32') chmodSync(tmp, modes.get(path)!);
      if (exclusive) {
        try {
          linkSync(tmp, path);
        } catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code || ''))
            throw error;
          copyFileSync(tmp, path, constants.COPYFILE_EXCL);
        }
      } else renameSync(tmp, path);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  };
  try {
    for (const [path, bytes] of before)
      if (!matches(path, bytes)) throw new FileToolError('FILE_CHANGED', '文件在补丁准备期间变化，未写入');
    for (const [path, bytes] of after) {
      signal.throwIfAborted();
      if (!matches(path, before.get(path)!)) throw new FileToolError('FILE_CHANGED', '文件在补丁写入前变化');
      write(path, bytes, before.get(path) === null);
      applied.push(path);
    }
  } catch (error) {
    const incomplete: string[] = [];
    for (const path of applied.reverse())
      try {
        if (!matches(path, after.get(path)!)) {
          incomplete.push(path);
          continue;
        }
        write(path, before.get(path)!, after.get(path) === null);
      } catch {
        incomplete.push(path);
      }
    if (incomplete.length)
      throw Object.assign(new Error('补丁未完成，部分文件在回滚时发生变化：' + incomplete.join(', ')), {
        outcomeUnknown: true,
      });
    throw error;
  }
  for (const [path, bytes] of after)
    host.options.afterWrite?.(snapshots.get(path), path, bytes?.toString('utf8') ?? null);
  return {
    applied: true,
    location: 'host',
    files: [...after].map(([path, bytes]) => ({
      path,
      operation: bytes === null ? 'deleted' : before.get(path) === null ? 'created' : 'updated',
      sha256: bytes ? hash(bytes) : null,
    })),
  };
}

export const VM_PATCH_SCRIPT = String.raw`
import pathlib,hashlib,os,uuid,json,re
root=pathlib.Path.cwd().resolve(); before={}; after={}; modes={}
def path(value):
 p=(root/value).resolve(); assert p.is_relative_to(root), 'path outside Bot workspace'; return p
PUNCT={**{c:'-' for c in (0x2010,0x2011,0x2012,0x2013,0x2014,0x2015,0x2212)},**{c:"'" for c in (0x2018,0x2019,0x201A,0x201B)},**{c:'"' for c in (0x201C,0x201D,0x201E,0x201F)},**{c:' ' for c in (0x00A0,0x2002,0x2003,0x2004,0x2005,0x2006,0x2007,0x2008,0x2009,0x200A,0x202F,0x205F,0x3000)}}
PASSES=[('exact',lambda s:s),('trim-end',lambda s:s.rstrip()),('trim',lambda s:s.strip()),('unicode',lambda s:s.strip().translate(PUNCT))]
def seek(lines,pattern,cursor,eof=False):
 for name,key in PASSES:
  want=[key(p) for p in pattern]; found=[i for i in range(cursor,len(lines)-len(pattern)+1) if (not eof or i+len(pattern)==len(lines)) and all(key(lines[i+k])==want[k] for k in range(len(pattern)))]
  if found: return name,found
 return None
def indent(s): return s[:len(s)-len(s.lstrip(' \t'))]
def changed(old,hunks):
 text=old.decode('utf-8'); bom=text.startswith('\ufeff'); text=text[1:] if bom else text
 rows=[[p[:-2],'\r\n'] if p.endswith('\r\n') else [p[:-1],'\n'] if p.endswith('\n') else [p,''] for p in re.findall(r'[^\n]*\n|[^\n]+\Z',text)]
 trailing=bool(rows) and rows[-1][1]!=''; nl='\r\n' if sum(r[1]=='\r\n' for r in rows)>sum(r[1]=='\n' for r in rows) else '\n'
 cursor=0
 for h in hunks:
  ops=h.get('ops') or [{'op':'-','text':t} for t in h['before']]+[{'op':'+','text':t} for t in h['after']]
  pattern=lambda: [o['text'] for o in ops if o['op']!='+']
  if h.get('anchor'):
   anchored=seek([r[0] for r in rows],[h['anchor']],cursor)
   if anchored: cursor=anchored[1][0]+1
  found=seek([r[0] for r in rows],pattern(),cursor,h['eof'])
  while not found and len(ops)>1 and ops[-1]['op']==' ' and ops[-1]['text']=='':
   ops=ops[:-1]; found=seek([r[0] for r in rows],pattern(),cursor,h['eof'])
  assert found and len(found[1])==1, 'patch context missing or ambiguous'
  name,at=found[0],found[1][0]; lines=pattern(); first=next((i for i,l in enumerate(lines) if l.strip()),-1); fuzzy=first>=0 and name in ('trim','unicode')
  src=indent(lines[first]) if fuzzy else ''; dst=indent(rows[at+first][0]) if fuzzy else ''; out=[]; s=at
  for o in ops:
   if o['op']==' ': out.append(rows[s]); s+=1
   elif o['op']=='-': s+=1
   else:
    t=o['text']
    if src!=dst and t.strip() and t.startswith(src): t=dst+t[len(src):]
    out.append([t,nl])
  rows[at:at+len(lines)]=out; cursor=at+len(out)
 for r in rows[:-1]:
  if not r[1]: r[1]=nl
 if rows: rows[-1][1]=(rows[-1][1] or nl) if trailing else ''
 return (('\ufeff' if bom else '')+''.join(t+e for t,e in rows)).encode('utf-8')
for f in a['files']:
 p=path(f['path']); target=path(f['moveTo']) if f.get('moveTo') else p
 assert p not in before and (target==p or target not in before), 'overlapping paths'
 assert (not p.exists()) if f['kind']=='add' else p.is_file(), 'file state changed'
 assert not p.exists() or p.stat().st_size<=2097152, 'file too large'
 old=p.read_bytes() if p.exists() else None; before[p]=old; modes[p]=p.stat().st_mode if p.exists() else 0o644
 assert sum(len(b or b'') for b in before.values())<=8388608, 'patch too large'
 if target!=p:
  assert not target.exists(), 'rename target exists'
  before[target]=None; modes[target]=modes[p]
 content=None if f['kind']=='delete' else f['content'].encode('utf-8') if f['kind']=='add' else changed(old,f['hunks'])
 after[p]=None if target!=p else content
 if target!=p: after[target]=content
def matches(p,b):
 return p.resolve()==p and ((p.is_file() and p.read_bytes()==b) if b is not None else not p.exists())
def write(p,b):
 if b is None: p.unlink(missing_ok=True); return
 p.parent.mkdir(parents=True,exist_ok=True); temp=p.parent/('.aelion-patch-'+uuid.uuid4().hex)
 try: temp.write_bytes(b); temp.chmod(modes[p]); os.replace(temp,p)
 finally: temp.unlink(missing_ok=True)
applied=[]
try:
 assert all(matches(p,b) for p,b in before.items()), 'file changed before patch'
 for p,b in after.items():
  assert matches(p,before[p]), 'file changed during patch'
  write(p,b); applied.append(p)
except Exception:
 for p in reversed(applied):
  if matches(p,after[p]): write(p,before[p])
 raise
print(json.dumps({'applied':True,'location':'vm','files':[{'path':str(p),'operation':'deleted' if b is None else 'created' if before[p] is None else 'updated','sha256':hashlib.sha256(b).hexdigest() if b is not None else None} for p,b in after.items()]}))
`;
export async function applyVmPatch(
  vm: VmController,
  botId: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const files = parsePatch(args.patch),
    result = await vmPython(vm, botId, { files }, VM_PATCH_SCRIPT, signal);
  if (result.exitCode !== 0) throw new FileToolError('PATCH_FAILED', result.stderr || result.stdout || '补丁未应用');
  return JSON.parse(result.stdout);
}
