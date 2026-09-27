import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../electron/core/agent/harness';
import { PREFIX_HANDLERS, TOOL_HANDLERS, dispatchTool } from '../electron/core/agent/tools/handlers';
import type { ToolContext } from '../electron/core/agent/tools/context';
import { DESIGN_TOOLS } from '../electron/core/designer/designer-tools';

const names = TOOLS.map((tool) => tool.function.name);
// Handled by the run loop (it moves a private chat into the main task) and never dispatched.
const RUN_LOOP_TOOLS = new Set(['start_main_task']);

test('tool names are unique', () => {
  assert.equal(new Set(names).size, names.length);
});

test('every registered tool has exactly one handler', () => {
  for (const name of names) {
    const handlers =
      Number(Object.hasOwn(TOOL_HANDLERS, name)) + PREFIX_HANDLERS.filter((entry) => entry.matches(name)).length;
    assert.equal(handlers, RUN_LOOP_TOOLS.has(name) ? 0 : 1, name);
  }
});

test('handlers exist only for registered tools', () => {
  // MCP server tools are reached through mcp_call rather than as their own tool names,
  // so the static TOOLS list is the complete set of names the harness dispatches.
  for (const name of Object.keys(TOOL_HANDLERS)) assert.ok(names.includes(name), name);
  for (const [index, entry] of PREFIX_HANDLERS.entries())
    assert.ok(
      names.some((name) => entry.matches(name)),
      `prefix handler ${index} matches no tool`,
    );
});

test('designer tools stay with the designer loop', () => {
  // The designer loop handles its own tools and passes shared ones (TOOLS) to the harness.
  for (const { function: tool } of DESIGN_TOOLS) {
    assert.ok(!names.includes(tool.name), tool.name);
    assert.ok(!Object.hasOwn(TOOL_HANDLERS, tool.name), tool.name);
    assert.ok(!PREFIX_HANDLERS.some((entry) => entry.matches(tool.name)), tool.name);
  }
});

test('unknown tool names keep their error messages', () => {
  const dispatch = (name: string) => () => dispatchTool({ name, args: {} } as unknown as ToolContext);
  for (const name of ['unknown_tool', 'constructor', '__proto__', 'host_unknown', 'mcp_unknown', 'group_unknown'])
    assert.throws(dispatch(name), { code: 'tool.unknown' }, name);
  assert.throws(dispatch('start_main_task'), { code: 'tool.unregistered', message: /start_main_task$/ });
});
