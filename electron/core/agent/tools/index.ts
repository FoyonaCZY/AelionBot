import type { ToolDefinition } from '../../model/model';
import { FOUNDATION_TOOLS } from '../../tools/foundation-tools';
import { SCHEDULED_TOOLS } from '../../tools/scheduled-tools';
import { GROUP_PROTOCOL_TOOLS } from '../../group/group-protocol-tools';
import { SKILLS_LIST_TOOL } from '../../extensions/skill-catalog';
import { ATTACHMENT_TOOLS } from './definitions/attachments';
import { CHAT_TOOLS, GROUP_READ_TOOLS } from './definitions/chat';
import { COMPUTER_TOOLS, PYTHON_SESSION_TOOLS } from './definitions/computer';
import { DELEGATION_TOOLS, PEER_TOOLS } from './definitions/delegation';
import { CHECKPOINT_TOOLS, FILE_TOOLS, SEARCH_TOOLS } from './definitions/files';
import { MCP_TOOLS } from './definitions/mcp';
import { PREVIEW_TOOLS } from './definitions/media';
import { MEMORY_TOOLS, SKILL_TOOLS } from './definitions/memory';
import { BATCH_TOOLS, READ_RESULT_TOOLS } from './definitions/misc';
import { GOAL_TOOLS, PLAN_UPDATE_TOOL, TASK_TOOLS } from './definitions/planning';
import { DESIGN_TOOLS } from '../../designer/designer-tools';

// The order is part of the model request (and its prompt cache); append new tools instead of reordering.
export const TOOLS: ToolDefinition[] = [
  ...FOUNDATION_TOOLS,
  ...PREVIEW_TOOLS,
  ...PYTHON_SESSION_TOOLS,
  ...DELEGATION_TOOLS,
  ...CHECKPOINT_TOOLS,
  ...BATCH_TOOLS,
  ...GOAL_TOOLS,
  ...SEARCH_TOOLS,
  ...TASK_TOOLS,
  ...ATTACHMENT_TOOLS,
  ...SCHEDULED_TOOLS,
  ...CHAT_TOOLS,
  ...GROUP_PROTOCOL_TOOLS,
  ...GROUP_READ_TOOLS,
  ...PEER_TOOLS,
  ...FILE_TOOLS,
  ...COMPUTER_TOOLS,
  ...MEMORY_TOOLS,
  SKILLS_LIST_TOOL,
  ...SKILL_TOOLS,
  ...MCP_TOOLS,
  ...READ_RESULT_TOOLS,
  PLAN_UPDATE_TOOL,
  ...DESIGN_TOOLS,
];
