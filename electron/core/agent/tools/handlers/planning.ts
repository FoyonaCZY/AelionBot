import { RunPolicy } from '../../runtime-policy';
import { WorkItems } from '../../work-items';
import type { ToolHandler } from '../context';

const workItem: ToolHandler = ({ args, name, run, deps }) => new WorkItems(deps.store).invoke(run!, name, args);

export const PLANNING_HANDLERS: Record<string, ToolHandler> = {
  task_read: ({ bot, runId, deps }) => new RunPolicy(deps.store).read(bot.id, runId),
  task_update: ({ args, run, deps }) => new WorkItems(deps.store).updatePlan(run!, args),
  plan_update: workItem,
  goal_set: workItem,
  goal_read: workItem,
  goal_update: workItem,
  execution_list: ({ bot, args, runId, deps }) => deps.ledger.query(bot.id, runId, args),
  execution_resolve: ({ bot, args, runId, deps }) => deps.ledger.resolve(bot.id, runId, args),
};
