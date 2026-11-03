import type { ChatMessage } from '../../../shared/types/core';
import type { MemoryKind, MemoryOrigin, MemorySensitivity } from '../../../shared/types/memory-types';

// What the app trusts a memory to be is decided here from its evidence, never from what a model says about it.
// Sources: docs/design/Memory-System-20261103.md §6.3 and §10.

/** Tools whose results carry content from outside: webpages, services, files from others, screens, other Bots. */
const EXTERNAL_TOOL =
  /^(?:web_|mcp_|mcp__|attachment_read|computer|host_computer|view_image|video_frames|bot_|bots_list|group_read|groups_|read_result|skill_read|skill_file_read|delegation_receipt)/;
export const externalTool = (name?: string) => Boolean(name && EXTERNAL_TOOL.test(name));
/** Local tools whose successful results are evidence of the environment: commands run, files read or written. */
const LOCAL_EVIDENCE = new Set([
  'exec_command',
  'write_stdin',
  'python_execute',
  'file_read',
  'file_write',
  'file_patch',
  'apply_patch',
  'list_directory',
  'find_files',
  'search_files',
  'code_exec',
  'tools_batch',
]);
export const localEvidence = (message: ChatMessage) =>
  message.role === 'tool' && message.status === 'done' && LOCAL_EVIDENCE.has(message.tool || '');

/** Rules about how to behave are only ever taken from a person. */
const BEHAVIOR = new Set<MemoryKind>(['preference', 'lesson', 'commitment']);
const TOOL_KINDS = new Set<MemoryKind>(['environment', 'project', 'event', 'decision']);

export interface Verdict {
  origin: MemoryOrigin;
  /** False: kept as a candidate waiting for the user. */
  active: boolean;
  note?: string;
}
/**
 * The trust a fact gets from its evidence. `explicit` is a person asking to remember it; `owner` is whether the
 * person speaking is the one the app belongs to; `tainted` is a run that read outside content first.
 */
export function judge(input: {
  kind: MemoryKind;
  scope: string;
  evidence: ChatMessage[];
  explicit: boolean;
  owner: boolean;
  tainted: boolean;
}): Verdict | undefined {
  // A schedule's prompt or a Bot's relayed task is not a person speaking now.
  const people = input.evidence.filter(
      (message) => message.role === 'user' && !message.reaction && !message.scheduled && !message.peer,
    ),
    tools = input.evidence.filter(localEvidence);
  if (input.explicit && people.length) return { origin: 'user_explicit', active: true };
  if (people.length) {
    if (input.scope === 'user' && !input.owner) return undefined;
    if (input.tainted)
      return { origin: 'user_stated', active: false, note: '这次对话读取过外部内容，需要你确认后才会使用' };
    return { origin: 'user_stated', active: true };
  }
  if (tools.length) {
    if (input.scope === 'user' || !TOOL_KINDS.has(input.kind)) return undefined;
    return {
      origin: 'tool_verified',
      active: !input.tainted,
      ...(input.tainted ? { note: '这次对话读取过外部内容' } : {}),
    };
  }
  // Nothing a person said or a local tool showed: only a suggestion, never a rule.
  if (BEHAVIOR.has(input.kind) || input.scope === 'user') return undefined;
  return { origin: 'model_inferred', active: false, note: '没有直接证据，需要你确认' };
}

const PRIVATE: RegExp[] = [
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/,
  /(?<!\d)\d{17}[\dxX](?!\d)/,
  /(?<!\d)\d{16,19}(?!\d)/,
  /身份证|护照号|银行卡|社保|住址|家庭地址|门牌|小区|号楼|单元\d|室\b/,
  /病情|诊断|确诊|服药|处方|怀孕|抑郁|焦虑症|手术|体检报告/,
  /工资|薪水|年薪|收入|存款|负债|贷款|欠款|信用卡账单/,
  /\b(?:salary|diagnos|prescription|pregnan|passport|home address|bank account)/i,
];
/** Facts kept out of groups, IM chats and the always-present core block. */
export function sensitivity(text: string, claimed?: boolean): MemorySensitivity {
  return claimed || PRIVATE.some((pattern) => pattern.test(text)) ? 'private' : 'normal';
}

/** Default lifetimes for ranking and archiving, in days; preferences and the user's profile do not fade. */
export const HALF_LIFE: Record<MemoryKind, number | undefined> = {
  preference: undefined,
  profile: undefined,
  commitment: 60,
  project: 180,
  lesson: 180,
  environment: 120,
  decision: 120,
  event: 30,
};
/** How much each kind counts for the always-present core block. */
export const CORE_WEIGHT: Record<MemoryKind, number> = {
  preference: 3,
  profile: 2.5,
  lesson: 2,
  project: 1.8,
  environment: 1.6,
  decision: 1.4,
  commitment: 1.2,
  event: 0.6,
};
