import type { ToolDefinition } from '../../../model/model';
import { tool } from './shared';

export const WIDGET_TOOLS: ToolDefinition[] = [
  tool(
    'widgets_list',
    '查看当前会话中已固定在右侧的交互小工具（Pinned Widgets）列表，返回每个小工具的 id、title、state（用户当前填写或勾选的最新状态）和 updatedAt。读取用户在小工具里的输入或更新已有小工具前调用。',
    {},
    [],
  ),
  tool(
    'widget_save',
    '在当前会话右侧固定或更新一个交互小工具（Pinned Live Widget），适合待办清单、表单、参数面板、进度看板等需要持续驻留在对话旁的工具。新建时必须提供 html（自包含的无网络 HTML，可用 aelion.getState()/aelion.setState(obj)/aelion.onState(fn) 读写持久状态）；更新已有小工具时传入 id，可只更新 state、title 或同时更新 html。html 与 state JSON 各自不超过 64 KB。',
    {
      id: { type: 'string', description: '已有小工具的 ID；省略则新建并固定一个小工具' },
      title: { type: 'string', description: '小工具标题（最多 80 字）；省略时从 HTML 自动提取' },
      html: {
        type: 'string',
        description: '自包含无网络 HTML 片段（可含 <style> 和 <script>），不超过 64 KB。新建时必填，更新时可选',
      },
      state: {
        type: 'object',
        description: '持久化 JSON 状态对象（不超过 64 KB）',
        additionalProperties: true,
      },
      mergeState: {
        type: 'boolean',
        description: '更新已有小工具并传入 state 时，是否浅合并到原有 state（默认 false，整对象替换）',
      },
    },
    [],
  ),
];
