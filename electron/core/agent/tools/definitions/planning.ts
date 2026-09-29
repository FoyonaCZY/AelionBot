import type { ToolDefinition } from '../../../model/model';
import { string, tool } from './shared';
export const GOAL_TOOLS: ToolDefinition[] = [
  tool('goal_read', '读取本次计划或目标的状态与完成依据。', {}, []),
  tool(
    'goal_set',
    '在用户已经授权的当前任务范围内设置持续执行目标。设置后实际执行，直至有证据完成或遇到明确阻碍；不能扩大任务范围。',
    { objective: string },
    ['objective'],
  ),
  tool(
    'goal_update',
    '报告目标或计划无法继续的阻碍；目标完成时必须引用实际成功执行的证据并给出完成依据。',
    {
      status: { type: 'string', enum: ['completed', 'blocked'] },
      reason: string,
      summary: string,
      evidenceIds: { type: 'array', items: string, maxItems: 10 },
    },
    ['status'],
  ),
];
export const TASK_TOOLS: ToolDefinition[] = [
  tool(
    'task_read',
    '读取当前任务的目标、步骤、验收条件和执行进展。多步任务先规划，完成后引用实际执行证据更新状态。',
    {},
    [],
  ),
  tool(
    'task_update',
    '更新本任务清单，与 plan_update 是同一操作，选一个使用。revision 使用 task_read 或冲突返回的 details.currentPlan.revision；保留已有 ID，取消步骤需标记 skipped 并解释。done 步骤必须有本次成功执行的 executionId。',
    {
      revision: { type: 'integer', minimum: 0 },
      goal: string,
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            id: string,
            title: string,
            acceptance: string,
            status: { type: 'string', enum: ['pending', 'working', 'done', 'skipped'] },
            evidenceIds: { type: 'array', items: string },
            note: string,
          },
          required: ['id', 'title', 'acceptance', 'status', 'evidenceIds'],
          additionalProperties: false,
        },
      },
    },
    ['revision', 'goal', 'steps'],
  ),
  tool(
    'execution_list',
    '精简分页查询当前任务执行记录，默认最新记录优先。返回 items、blockingCount、eof、nextBefore；证据使用 items[].executionId，读取原结果使用 resultId；翻页把 nextBefore 原样传给 before，不要用字符 offset。filter=blocking 只看真正阻碍完成的记录，evidence 只看可用验收证据；executionId 精确查询单条完整记录。不要读取无关文件来修复过期计划。',
    {
      filter: { type: 'string', enum: ['recent', 'blocking', 'evidence', 'all'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      before: string,
      executionId: string,
    },
    [],
  ),
  tool(
    'execution_resolve',
    '用当前任务中后续成功执行的证据处理一条失败记录。resolved 表示问题已修复；unnecessary 表示已验证该步骤不再需要。不能用无关结果代替验收。',
    {
      executionId: string,
      kind: { type: 'string', enum: ['resolved', 'unnecessary'] },
      reason: string,
      evidenceIds: { type: 'array', items: string, minItems: 1, maxItems: 8 },
    },
    ['executionId', 'kind', 'reason', 'evidenceIds'],
  ),
];
const planTool = TASK_TOOLS.find((t) => t.function.name === 'task_update')!;
export const PLAN_UPDATE_TOOL: ToolDefinition = {
  ...planTool,
  function: {
    ...planTool.function,
    name: 'plan_update',
    description:
      '设置或更新计划。可为当前已授权任务主动规划并执行。/plan 模式下先保存 pending 步骤并等用户确认。revision 使用 task_read 返回值；done 步骤引用当前目标内成功执行的 executionId。',
  },
};
