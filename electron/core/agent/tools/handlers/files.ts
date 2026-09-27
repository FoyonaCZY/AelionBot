import { expectedHash } from '../../../tools/file-text';
import { applyHostPatch, applyVmPatch, parsePatch } from '../../../tools/multi-patch';
import { readVmFile, patchVmFile, VM_WRITE } from '../../../vm/vm-files';
import { vmPython } from '../../../vm/vm-python';
import type { PrefixHandler, ToolHandler } from '../context';
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

export const FILE_HANDLERS: Record<string, ToolHandler> = {
  apply_patch: async ({ bot, args, signal, runId, workspace, deps }) => {
    if (args.location === 'vm') {
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
  file_read: vmFile,
  file_write: vmFile,
  file_patch: vmFile,
};

export const HOST_HANDLER: PrefixHandler = {
  matches: (name) => name.startsWith('host_'),
  handler: ({ bot, args, name, signal, runId, run, deps }) => {
    if (!deps.host || !deps.interactions) throw new Error('本机操作尚未启用');
    if (name === 'host_list_directory') return deps.host.listDirectory(bot.id, runId, args, signal, run!.workspaceDir);
    if (name === 'host_find_files' || name === 'host_search_files')
      return deps.host.searchFiles(
        bot.id,
        runId,
        args,
        signal,
        run!.workspaceDir,
        name === 'host_find_files' ? 'find' : 'search',
      );
    if (name === 'host_execute') return deps.host.execute(bot.id, runId, args, signal, run!.workspaceDir);
    if (name === 'host_file_read') return deps.host.readFile(bot.id, runId, args, signal, run!.workspaceDir);
    if (name === 'host_file_write') return deps.host.writeFile(bot.id, runId, args, signal, run!.workspaceDir);
    if (name === 'host_file_patch') return deps.host.patchFile(bot.id, runId, args, signal, run!.workspaceDir);
    throw new Error('未注册的本机工具');
  },
};
