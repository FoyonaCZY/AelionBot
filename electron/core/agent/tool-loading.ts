import type { WireMessage } from '../../../shared/types/core';
import type { ToolDefinition } from '../model/model';
import { MCP_NATIVE_PREFIX } from '../extensions/mcp-native';

/** Context window threshold below which small models receive only the compact tool menu. */
export const COMPACT_CONTEXT_THRESHOLD = 32000;

/**
 * Connected native MCP tools at or below this total are offered immediately on turn 1; larger MCP tool sets are
 * deferred until discovered via `tool_search` (or already referenced in conversation history).
 */
export const EAGER_MCP_TOOL_THRESHOLD = 4;

/** Compact tool subset for `< 32000` context models outside private peer sessions. */
export const COMPACT_TOOLS: ReadonlySet<string> = new Set([
  'open_preview',
  'preview_mark',
  'code_exec',
  'tool_search',
  'groups_list',
  'group_send_message',
  'read_result',
  'file_read',
  'exec_command',
  'write_stdin',
  'request_user_input',
  'generate_image',
  'generate_video',
  'list_media_models',
  'knowledge_search',
  'vault_list',
]);

/**
 * Everyday high-frequency tools offered upfront on `>= 32000` context models whenever they are in `availableTools`.
 * Low-frequency management/admin tools are deferred until discovered via `tool_search` or activated contextually.
 */
export const CORE_ACTIVE_TOOLS: ReadonlySet<string> = new Set([
  // Command execution, patches, code orchestration, discovery, batching & paging
  'exec_command',
  'write_stdin',
  'exec_stop',
  'exec_list',
  'apply_patch',
  'code_exec',
  'tool_search',
  'tools_batch',
  'read_result',
  // User interaction, media, web, previews & attachments
  'request_user_input',
  'view_image',
  'generate_image',
  'generate_video',
  'list_media_models',
  'video_frames',
  'transcribe_audio',
  'text_to_speech',
  'web_read',
  'open_preview',
  'widgets_list',
  'widget_save',
  'attachment_read',
  'message_attach',
  // Filesystem inspection & editing
  'list_directory',
  'find_files',
  'search_files',
  'file_read',
  'file_write',
  'file_patch',
  // Desktop & Python
  'computer',
  'host_computer',
  'python_execute',
  // Memory, history, knowledge & skill reading
  'memory',
  'history_search',
  'history_read',
  'knowledge_search',
  'skills_list',
  'skill_read',
  // Plans & goals
  'plan_update',
  'goal_set',
  'goal_update',
  // Design entry tools (only in availableTools when DesignWork is wired)
  'design_start',
  'design_use',
  'design_tasks',
  'design_font_library',
  // Active conversation-origin protocol tools
  'chat_pin',
  'groups_list',
  'group_react',
  'group_pass',
  'group_send_message',
  'group_outbox',
  'group_read',
  'delegation_receipt',
  'start_main_task',
  // Vault tools
  'vault_list',
  'vault_save',
  'vault_request',
  // Video Studio entry tool (remaining video_* tools auto-activate on project creation or when video projects exist)
  'video_project_create',
]);

/** Video Studio tools auto-activated once video_project_create runs or when the Bot has existing video projects. */
export const VIDEO_STUDIO_TOOLS: ReadonlySet<string> = new Set([
  'video_project_inspect',
  'video_asset_import',
  'video_edit',
  'video_preview_frame',
  'video_export',
  'video_export_status',
]);

/** Automation tools auto-activated when a run is triggered by an automation schedule. */
const AUTOMATION_TOOLS: ReadonlySet<string> = new Set([
  'automations_list',
  'automation_create',
  'automation_update',
  'automation_delete',
]);

/** Work-item inspection/update tools auto-activated when a run begins bound to an existing plan or goal. */
const WORK_CONTEXT_TOOLS: ReadonlySet<string> = new Set(['goal_read', 'task_read', 'task_update']);

/** Skill authoring tools auto-activated on turn 1 when a run receives a Teach-by-Showing demonstration packet. */
const SKILL_AUTHORING_TOOLS: ReadonlySet<string> = new Set(['skill_save', 'skill_patch', 'skill_file_write']);

/** Execution ledger tools auto-activated once a run has unresolved blocking failures. */
export const EXECUTION_RECOVERY_TOOLS: ReadonlySet<string> = new Set(['execution_list', 'execution_resolve']);

export interface SelectModelToolsOptions {
  contextTokens: number;
  privateSession: boolean;
  groupOrigin: boolean;
  planning: boolean;
  designBound: boolean;
  hasVideoProjects?: boolean;
  scheduledRun: boolean;
  teachingRun?: boolean;
  hasInitialWork: boolean;
  historyToolNames?: ReadonlySet<string>;
  activatedTools?: ReadonlySet<string>;
  eagerMcpToolLimit?: number;
}

/** Whether a run uses on-demand deferred tool loading (rather than compact or restricted mode). */
export function usesDeferredToolLoading(contextTokens: number, privateSession: boolean, planning: boolean): boolean {
  return contextTokens >= COMPACT_CONTEXT_THRESHOLD && !privateSession && !planning;
}

/** Collects every tool name previously called in assistant messages of `history`. */
export function extractHistoryToolNames(history: readonly WireMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of history) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) if (call.function?.name) names.add(call.function.name);
  }
  return names;
}

/**
 * Selects the tool definitions sent to the model for this turn, preserving the canonical `availableTools` order
 * so prompt-cache prefixes stay stable.
 */
export function selectModelTools(
  availableTools: readonly ToolDefinition[],
  options: SelectModelToolsOptions,
): ToolDefinition[] {
  if (options.contextTokens < COMPACT_CONTEXT_THRESHOLD && !options.privateSession)
    return availableTools.filter(
      (tool) =>
        COMPACT_TOOLS.has(tool.function.name) ||
        (options.groupOrigin && (/^groups?_/.test(tool.function.name) || tool.function.name.startsWith('history_'))),
    );
  if (options.privateSession || options.planning) return [...availableTools];

  const limit = options.eagerMcpToolLimit ?? EAGER_MCP_TOOL_THRESHOLD;
  let mcpCount = 0;
  for (const tool of availableTools) if (tool.function.name.startsWith(MCP_NATIVE_PREFIX)) mcpCount++;
  const eagerMcp = mcpCount <= limit;

  return availableTools.filter((tool) => {
    const name = tool.function.name;
    if (CORE_ACTIVE_TOOLS.has(name)) return true;
    if (options.designBound && name.startsWith('design_')) return true;
    if (options.hasVideoProjects && VIDEO_STUDIO_TOOLS.has(name)) return true;
    if (options.scheduledRun && AUTOMATION_TOOLS.has(name)) return true;
    if (options.teachingRun && SKILL_AUTHORING_TOOLS.has(name)) return true;
    if (options.hasInitialWork && WORK_CONTEXT_TOOLS.has(name)) return true;
    if (eagerMcp && name.startsWith(MCP_NATIVE_PREFIX)) return true;
    if (options.historyToolNames?.has(name)) return true;
    if (options.activatedTools?.has(name)) return true;
    return false;
  });
}

/** Adds an on-demand loading note to the MCP server prompt when native MCP tools are deferred. */
export function deferredMcpPromptNote(
  prompt: string,
  mcpToolCount: number,
  eagerLimit = EAGER_MCP_TOOL_THRESHOLD,
): string {
  if (!prompt || mcpToolCount <= eagerLimit) return prompt;
  return (
    prompt +
    '\n以上已连接的 MCP 工具当前按需加载，未全部放入初始工具菜单；需要时先用 tool_search 按服务名或用途搜索，匹配到的原生 mcp__* 工具会在下一轮直接加入工具菜单。'
  );
}
