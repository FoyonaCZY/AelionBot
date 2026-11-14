// What a phone is shown, derived from the app's state: the home list (Bots, sessions, groups, requests) and the
// window of one chat. Messages and runs are sent trimmed of what the phone never shows (full tool output, diff
// lines, context details); trimmed copies are cached per entry so unchanged entries keep their identity, which is
// what the per-connection diff compares.
import type { Attachment } from '../../../shared/types/attachment-types';
import type {
  ChatMessage,
  ComputerState,
  InteractionRequest,
  RunRecord,
  StreamingReply,
} from '../../../shared/types/core';
import type { GroupsView } from '../../../shared/types/group-types';
import { isPrivatePeerOrigin } from '../../../shared/types/peer-types';
import { triggerLabel } from '../../../shared/types/scheduled-types';
import { isLiveEntry } from '../../../shared/state-sync';
import { liveBotStep, readableContent } from '../../../shared/chat/activity';
import type {
  HomeView,
  RecentFile,
  RemoteBot,
  RemoteLast,
  RemoteRequest,
  RemoteSessionRow,
} from '../../../shared/remote/protocol';
import type { Store } from '../storage/store';

export interface ViewSources {
  store: Store;
  name: string;
  streams: StreamingReply[];
  interactions: InteractionRequest[];
  computer: ComputerState;
  vmStatus: string;
  groups?: GroupsView;
  speech: { input: boolean; output: boolean };
}

const time = (value?: string) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

/** One line of a message for a list: no Markdown, no fenced blocks, no reasoning tags. */
export function previewText(content: string, attachments?: Attachment[]) {
  const text = readableContent(content)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || attachments?.map((file) => file.name).join('、') || '').slice(0, 160);
}

/** Messages that belong in a chat list or chat, by the same rules as the desktop's conversation list. */
function listed(message: ChatMessage, privateRuns: Set<string>) {
  return !(
    message.role === 'tool' ||
    message.reaction ||
    (!message.content.trim() && !message.attachments?.length) ||
    (privateRuns.has(message.runId || '') && message.audience !== 'user')
  );
}
const last = (message: ChatMessage): RemoteLast => ({
  text: previewText(message.content, message.attachments),
  fromUser: message.role === 'user',
  time: message.time,
});

/** Where a request waits: its run's chat or group. */
function locateRequest(request: InteractionRequest, runs: Map<string, RunRecord>): RemoteRequest {
  const run = runs.get(request.runId);
  return {
    ...request,
    ...(run?.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run?.groupOrigin ? { groupId: run.groupOrigin.groupId } : {}),
  };
}

export function homeView(sources: ViewSources): HomeView {
  const { store } = sources;
  const runs = new Map(store.data.runs.map((run) => [run.id, run]));
  const privateRuns = new Set(
    store.data.runs.filter((run) => isPrivatePeerOrigin(run.peerOrigin)).map((run) => run.id),
  );
  // The latest listed message per chat, and the running tool of each run.
  const latest = new Map<string, ChatMessage>(),
    runningTool = new Map<string, ChatMessage>();
  for (const message of store.data.messages) {
    if (message.role === 'tool' && message.status === 'running' && message.runId)
      runningTool.set(message.runId, message);
    if (!listed(message, privateRuns)) continue;
    const key = message.sessionId ? 'session:' + message.sessionId : message.botId;
    const previous = latest.get(key);
    if (!previous || time(message.time) >= time(previous.time)) latest.set(key, message);
  }
  const running = store.data.runs.filter(
    (run) => run.status === 'running' && !run.groupOrigin && !isPrivatePeerOrigin(run.peerOrigin),
  );
  const requests = sources.interactions.map((request) => locateRequest(request, runs));
  const sessions = (store.data.workSessions || []).filter((session) => !session.archivedAt);
  const sessionRows: RemoteSessionRow[] = sessions.map((session) => {
    const message = latest.get('session:' + session.id);
    return {
      id: session.id,
      botId: session.botId,
      name: session.name,
      ...(message ? { last: last(message) } : {}),
      time: message && time(message.time) > time(session.updatedAt) ? message.time : session.updatedAt,
      ...(running.some((run) => run.sessionId === session.id) ? { working: true } : {}),
    };
  });
  const bots: RemoteBot[] = store.data.bots.map((bot) => {
    const lanes = [
      { sessionId: undefined as string | undefined, message: latest.get(bot.id) },
      ...sessionRows
        .filter((row) => row.botId === bot.id)
        .map((row) => ({ sessionId: row.id as string | undefined, message: latest.get('session:' + row.id) })),
    ];
    const newest = lanes.reduce<(typeof lanes)[number] | undefined>(
      (best, lane) =>
        lane.message && (!best?.message || time(lane.message.time) > time(best.message.time)) ? lane : best,
      undefined,
    );
    const run = running
      .filter((item) => item.botId === bot.id)
      .sort((a, b) => time(b.startedAt) - time(a.startedAt))[0];
    const request = requests.find((item) => item.botId === bot.id && !item.groupId);
    const step = run ? liveBotStep(runningTool.has(run.id) ? [runningTool.get(run.id)!] : [], run) : undefined;
    const state: RemoteBot['state'] = request
      ? 'waiting'
      : step
        ? step.phase === 'working'
          ? 'working'
          : 'thinking'
        : undefined;
    const sessionId = request ? request.sessionId : run ? run.sessionId : newest?.sessionId;
    return {
      id: bot.id,
      name: bot.name,
      color: bot.color,
      ...(bot.avatarStyle ? { avatarStyle: bot.avatarStyle } : {}),
      ...(state ? { state } : {}),
      ...(step && !request ? { activity: { label: step.label, ...(step.detail ? { detail: step.detail } : {}) } } : {}),
      ...(newest?.message ? { last: last(newest.message) } : {}),
      time:
        run && time(run.startedAt) > time(newest?.message?.time)
          ? run.startedAt
          : newest?.message?.time || bot.createdAt,
      ...(sessionId ? { sessionId } : {}),
    };
  });
  bots.sort((a, b) => Number(Boolean(b.state)) - Number(Boolean(a.state)) || time(b.time) - time(a.time));
  return {
    name: sources.name,
    bots,
    sessions: sessionRows.sort((a, b) => time(b.time) - time(a.time)),
    groups: (sources.groups?.rooms || []).map((room) => ({
      id: room.id,
      name: room.name,
      members: room.members.map((member) => member.id),
      line: room.preview,
      time: room.updatedAt,
      unread: room.unread,
      active: Boolean(room.activities?.length || room.activity || room.round?.status === 'active'),
    })),
    requests,
    automations: (store.data.scheduledTasks || []).map((task) => ({
      id: task.id,
      title: task.title,
      target: task.target,
      trigger: triggerLabel(task.trigger),
      status: task.status,
      ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
      ...(task.lastRun
        ? { lastRun: { status: task.lastRun.status, at: task.lastRun.finishedAt || task.lastRun.startedAt } }
        : {}),
      ...(task.needsReview ? { needsReview: true } : {}),
    })),
    computer: {
      status: sources.vmStatus,
      desktops: Object.fromEntries(
        Object.entries(sources.computer.desktops).map(([botId, desktop]) => [
          botId,
          {
            status: desktop.status,
            ...(desktop.ownerBotId ? { ownerBotId: desktop.ownerBotId } : {}),
            manualControl: desktop.manualControl,
          },
        ]),
      ),
    },
    speech: sources.speech,
  };
}

/** A chat's messages, by the rules of the desktop's chat view. */
export function chatMessages(store: Store, botId: string, sessionId?: string) {
  const runs = new Map(store.data.runs.map((run) => [run.id, run]));
  return store.data.messages.filter(
    (message) =>
      message.botId === botId &&
      message.sessionId === sessionId &&
      (message.audience === 'user' || !message.runId || !isPrivatePeerOrigin(runs.get(message.runId)?.peerOrigin)),
  );
}

/** How many of the user's turns a chat window starts with, and how many more each `chat.more` adds. */
export const WINDOW_TURNS = 12;
/** The index a window of the last `turns` user turns starts at. */
export function windowStart(messages: ChatMessage[], end: number, turns = WINDOW_TURNS) {
  let seen = 0;
  for (let index = end - 1; index >= 0; index--) if (messages[index].role === 'user' && ++seen === turns) return index;
  return 0;
}

const trimmed = new WeakMap<object, object>();
/** Forgets trimmed copies of entries edited in place, so the next diff sends them again. */
export function forgetTrimmed(entries: Iterable<object>) {
  for (const entry of entries) trimmed.delete(entry);
}
function cached<T extends object>(entry: T, make: () => T): T {
  // Live entries change in place: trim them again every time.
  if (isLiveEntry(entry)) return make();
  let copy = trimmed.get(entry) as T | undefined;
  if (!copy) trimmed.set(entry, (copy = make()));
  return copy;
}
export function trimMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool' && !message.diff) return message;
  return cached(message, () => ({
    ...message,
    ...(message.role === 'tool' ? { content: message.activity ? '' : message.content.slice(0, 2000) } : {}),
    ...(message.diff
      ? { diff: { ...message.diff, files: message.diff.files.map((file) => ({ ...file, lines: [] })) } }
      : {}),
  }));
}
function trimRun(run: RunRecord): RunRecord {
  return cached(run, () => ({
    id: run.id,
    botId: run.botId,
    status: run.status,
    startedAt: run.startedAt,
    modelCalls: run.modelCalls,
    toolCalls: run.toolCalls,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.blocks ? { blocks: run.blocks } : {}),
    ...(run.attachments ? { attachments: run.attachments } : {}),
    ...(run.retracted ? { retracted: true } : {}),
    ...(run.executions ? { executions: run.executions.filter((item) => item.status === 'running') } : {}),
  }));
}
/** The runs a window of messages belongs to, oldest first. */
export function windowRuns(store: Store, messages: ChatMessage[]) {
  const ids = new Set(messages.map((message) => message.runId).filter(Boolean));
  return store.data.runs.filter((run) => ids.has(run.id) && !run.groupOrigin).map(trimRun);
}
export function chatStreams(streams: StreamingReply[], botId: string, sessionId?: string): StreamingReply[] {
  return streams
    .filter((reply) => reply.botId === botId && reply.sessionId === sessionId && !reply.groupId && !reply.peerThreadId)
    .map(({ reasoning: _reasoning, ...reply }) => reply);
}

/** Files that came up in a Bot's chats, newest first. */
export function recentFiles(store: Store, botId: string, limit = 40): RecentFile[] {
  const seen = new Set<string>(),
    files: RecentFile[] = [];
  for (let index = store.data.messages.length - 1; index >= 0 && files.length < limit; index--) {
    const message = store.data.messages[index];
    if (message.botId !== botId || !message.attachments?.length) continue;
    for (const file of message.attachments)
      if (!seen.has(file.id)) {
        seen.add(file.id);
        files.push({ ...file, time: message.time, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
      }
  }
  return files;
}
