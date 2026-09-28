import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedInteger, toolFailure } from '../../../tools/file-text';
import { readPipeline } from '../../../tools/tool-pipeline';
import { readToolResult } from '../../../tools/tool-results';
import { validateToolArguments } from '../../../tools/tool-schema';
import { discoverTools } from '../../../tools/tool-discovery';
import { commandResultFailed, executionBlocksCompletion } from '../../execution-ledger';
import { InteractionDenied } from '../../interactions';
import { RunPolicy } from '../../runtime-policy';
import { WorkItems, PLANNING_TOOLS } from '../../work-items';
import type { ToolHandler } from '../context';
import { TOOLS } from '../index';
import { requiredText } from '../validation';

export const MISC_HANDLERS: Record<string, ToolHandler> = {
  tool_search: ({ args, signal, runId, deps }) =>
    discoverTools(args, deps.callableTools(runId) || [], deps.integrations?.mcp, signal),
  request_user_input: ({ bot, args, signal, runId, deps }) => {
    if (!deps.interactions) throw Error('用户交互尚未就绪');
    return deps.interactions.ask(bot.id, runId, args.questions, signal, args.wait === true);
  },
  user_input_wait: ({ bot, args, signal, deps }) => {
    if (!deps.interactions) throw Error('用户交互尚未就绪');
    return deps.interactions.waitQuestion(
      bot.id,
      requiredText(args, 'id', 100),
      signal,
      boundedInteger(args.waitMs, 10000, 0, 30000, 'waitMs'),
    );
  },
  code_exec: ({ bot, args, signal, runId, options, deps }) =>
    deps.code.run(
      args,
      (deps.callableTools(runId) || []).map((tool) => tool.function.name).filter((name) => name !== 'code_exec'),
      signal,
      (name, args, signal) => deps.invokeNested(bot, name, args, signal, runId, options),
    ),
  tools_batch: ({ bot, args, signal, runId, options, deps }) =>
    readPipeline(
      args.steps,
      new RunPolicy(deps.store).settings().parallelReads,
      signal,
      async (name, input, batchSignal) => {
        validateToolArguments(
          TOOLS.find((t) => t.function.name === name)!,
          input,
        );
        const entry = deps.ledger.begin(
            bot.id,
            runId,
            { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } },
            input,
            deps.store.data.runs.find((run) => run.id === runId)?.workspaceDir ||
              deps.host?.workspaceSettings().workspaceDir,
          ),
          resultId = randomUUID();
        try {
          const output = await deps.executeTool(bot, input, name, batchSignal, runId, options);
          const failed = commandResultFailed(output);
          const dir = join(deps.store.dir, 'results');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, resultId + '.json'), JSON.stringify(output));
          deps.ledger.finish(entry, failed ? 'failed' : 'succeeded', output, resultId);
          if (failed && executionBlocksCompletion(entry)) throw Error(JSON.stringify(output).slice(0, 1200));
          return { executionId: entry.id, resultId, result: output };
        } catch (error) {
          if (entry.status === 'running') {
            const output = {
              ...toolFailure(error),
              ...(error instanceof InteractionDenied ? { denied: true, executed: false } : {}),
              ...(batchSignal.aborted ? { cancelled: true } : {}),
            };
            const dir = join(deps.store.dir, 'results');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, resultId + '.json'), JSON.stringify(output));
            deps.ledger.finish(
              entry,
              batchSignal.aborted || error instanceof InteractionDenied ? 'cancelled' : 'failed',
              output,
              resultId,
            );
          }
          throw error;
        }
      },
      {
        stopOnError: (error) => error instanceof InteractionDenied,
        allowedTools:
          new WorkItems(deps.store).forRun(deps.store.data.runs.find((run) => run.id === runId)!)?.status === 'planning'
            ? PLANNING_TOOLS
            : undefined,
      },
    ),
  read_result: ({ bot, args, options, deps }) =>
    readToolResult(
      deps.store,
      bot.id,
      args,
      options.groupOrigin ? { kind: 'group', id: options.groupOrigin.groupId } : { kind: 'private' },
    ),
};
