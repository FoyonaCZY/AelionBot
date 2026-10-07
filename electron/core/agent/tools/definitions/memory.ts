import type { ToolDefinition } from '../../../model/model';
import { string, tool } from './shared';
export const MEMORY_TOOLS: ToolDefinition[] = [
  tool(
    'memory',
    '管理当前 Bot 的有界长期记忆。工作知识 target=memory，用户明确偏好 target=user。只保存可复用事实，不保存秘密、临时进度或权限。replace 需 oldContent 原文；sourceRefs 为来源消息 ID。',
    {
      action: { type: 'string', enum: ['add', 'replace', 'remove'] },
      content: string,
      target: { type: 'string', enum: ['memory', 'user'] },
      oldContent: string,
      sourceRefs: { type: 'array', items: string, maxItems: 8 },
    },
    ['action', 'content'],
  ),
  tool(
    'history_search',
    '搜索当前 Bot 的私聊历史、工具结果，以及它自己在各群聊里的工作记录，返回来源消息 ID；source 标明来自私聊（private）还是哪个群（group）。适合压缩后找回细节，或回想在别处做过的事；不会搜索其他 Bot 的私有记录。',
    { query: string, limit: { type: 'integer', minimum: 1, maximum: 20 } },
    ['query'],
  ),
  tool(
    'history_read',
    '读取当前 Bot 的一条来源消息及少量相邻记录。messageId 来自 history_search。',
    {
      messageId: string,
      before: { type: 'integer', minimum: 0, maximum: 3 },
      after: { type: 'integer', minimum: 0, maximum: 3 },
    },
    ['messageId'],
  ),
];
export const SKILL_TOOLS: ToolDefinition[] = [
  tool(
    'skill_read',
    '读取一项有权使用的技能。id 优先使用 skills_list 或 skill_save 返回的稳定 ID，也支持当前可见范围内的唯一技能名称。',
    { id: string },
    ['id'],
  ),
  tool(
    'skill_patch',
    '精确修改自己的私有技能。先读取正文与 hash，oldText 必须唯一。',
    { id: string, oldText: string, newText: string, expectedHash: string },
    ['id', 'oldText', 'newText', 'expectedHash'],
  ),
  tool(
    'skill_file_write',
    '维护自己的私有技能参考资料或脚本，只支持 scripts、references、assets 内的相对路径。覆盖已有文件必须提供先前读取的 hash。',
    { id: string, path: string, content: string, expectedHash: string },
    ['id', 'path', 'content'],
  ),
  tool(
    'skill_manage',
    '置顶、取消置顶、归档、恢复技能，或查看/恢复自己的历史版本。归档保留原文件；不要无理由整理技能。',
    {
      id: string,
      action: { type: 'string', enum: ['pin', 'unpin', 'archive', 'restore', 'revisions', 'restore_revision'] },
      revision: { type: 'integer', minimum: 0 },
    },
    ['id', 'action'],
  ),
  tool(
    'skill_file_read',
    '读取技能包内的相对文本资源，例如 references/guide.md。只能读取选定技能目录内的文件。',
    { id: string, path: string },
    ['id', 'path'],
  ),
  tool(
    'skill_materialize',
    '将选定技能的 SKILL.md、scripts、references、assets 同步到工作电脑，返回可执行相对脚本的 VM 路径。原 Agent 目录保持只读；依赖必须在 VM 中可用。',
    { id: string },
    ['id'],
  ),
  tool(
    'skill_save',
    '保存当前 Bot 私有的可复用流程。先搜索已有技能，修改前读取正文。写清适用条件、步骤、验证和已知限制，不固化临时路径或秘密。每次修改保留版本；sourceRefs 为实际执行证据的消息 ID。',
    { name: string, description: string, body: string, sourceRefs: { type: 'array', items: string, maxItems: 8 } },
    ['name', 'description', 'body'],
  ),
];
