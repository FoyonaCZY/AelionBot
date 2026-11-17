// Notifications of the operating system for what happens while nobody looks at the window: a Bot waits for an
// approval or an answer, a task ended, an automation ran. Phones get the same events from RemoteHub.
import { translate } from '../../../shared/i18n';
import type { InteractionRequest } from '../../../shared/types/core';
import {
  normalizeDesktopNotify,
  type ChatTarget,
  type DesktopNotifySettings,
} from '../../../shared/types/notification-types';
import { previewText } from '../remote/remote-view';
import type { Store } from '../storage/store';

export interface DesktopNotice {
  title: string;
  body: string;
  /** A notice replaces the one shown earlier with the same tag. */
  tag: string;
  target?: ChatTarget;
}

interface Deps {
  store: Pick<Store, 'data'>;
  interactions: () => InteractionRequest[];
  /** The person is looking at the window: the app shows the change itself. */
  attentive: () => boolean;
  groupName?: (id: string) => string | undefined;
  show: (notice: DesktopNotice) => void;
  now?: () => number;
}

/** State changes arrive in bursts; one look per burst is enough. */
const CHECK_DELAY_MS = 400;
/** The same notice is not repeated within this time. */
const REPEAT_MS = 10_000;

/** Whether the request is waiting for the person rather than for the approval model or an ongoing takeover. */
const needsPerson = (request: InteractionRequest) =>
  request.kind === 'host_permission' ? request.approval?.phase !== 'reviewing' : request.phase === 'waiting';

export class DesktopNotices {
  private waiting?: Set<string>;
  private running?: Set<string>;
  private readonly shownAt = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: Deps) {}

  settings(): DesktopNotifySettings {
    return normalizeDesktopNotify(this.deps.store.data.desktopNotify);
  }

  /** Called after every change of the app's state. */
  changed() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.check();
    }, CHECK_DELAY_MS);
    this.timer.unref?.();
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Compares the requests and runs with the last look and announces what is new. */
  check() {
    const { store } = this.deps,
      requests = this.deps.interactions().filter(needsPerson);
    const running = new Set(store.data.runs.filter((run) => run.status === 'running').map((run) => run.id));
    // What was already there when the app started is not news.
    const firstLook = !this.waiting || !this.running;
    const asked = firstLook ? [] : requests.filter((request) => !this.waiting!.has(request.id));
    const ended = firstLook ? [] : [...this.running!].filter((id) => !running.has(id));
    this.waiting = new Set(requests.map((request) => request.id));
    this.running = running;
    if (this.deps.attentive()) return;
    const settings = this.settings();
    if (settings.requests) for (const request of asked) this.announceRequest(request, settings);
    for (const id of ended) {
      const run = store.data.runs.find((item) => item.id === id);
      if (run && !run.groupOrigin && !run.peerOrigin && !run.retracted && run.status !== 'cancelled')
        this.announceRun(run, settings);
    }
  }

  /** A notice from another service (a budget alert); shown whether or not the window is in front. */
  announce(notice: DesktopNotice) {
    const now = (this.deps.now ?? Date.now)(),
      last = this.shownAt.get(notice.tag);
    if (last !== undefined && now - last < REPEAT_MS) return;
    this.shownAt.set(notice.tag, now);
    this.deps.show(notice);
  }

  private title(botId: string, sessionId?: string, groupId?: string) {
    const { store } = this.deps,
      bot = store.data.bots.find((item) => item.id === botId);
    const place = groupId
      ? this.deps.groupName?.(groupId)
      : sessionId
        ? store.data.workSessions?.find((item) => item.id === sessionId)?.name
        : undefined;
    return (bot?.name || 'AelionBot') + (place ? ' · ' + place : '');
  }

  private announceRequest(request: InteractionRequest, settings: DesktopNotifySettings) {
    const run = this.deps.store.data.runs.find((item) => item.id === request.runId),
      sessionId = run?.sessionId,
      groupId = run?.groupOrigin?.groupId;
    const detail =
      request.kind === 'host_permission'
        ? request.details.command || request.details.path || request.details.tool || ''
        : request.kind === 'user_input'
          ? request.questions[0]?.title || ''
          : '';
    const general =
      request.kind === 'user_input'
        ? translate('有问题想问你')
        : request.kind === 'vm_takeover'
          ? translate('需要你处理工作电脑')
          : translate('需要你批准一个操作');
    this.announce({
      title: this.title(request.botId, sessionId, groupId),
      body: settings.content && detail ? general + '：' + detail.replace(/\s+/g, ' ').slice(0, 160) : general,
      tag: 'request-' + request.id,
      target: { botId: request.botId, sessionId, groupId, requestId: request.id },
    });
  }

  private announceRun(
    run: { id: string; botId: string; sessionId?: string; status: string; startedAt: string },
    settings: DesktopNotifySettings,
  ) {
    const { store } = this.deps;
    const automation = store.data.scheduledTasks?.some(
      (task) =>
        task.lastRun &&
        task.target.kind === 'bot' &&
        task.target.id === run.botId &&
        (task.target.sessionId || undefined) === run.sessionId &&
        Math.abs(Date.parse(task.lastRun.startedAt) - Date.parse(run.startedAt)) < 15_000,
    );
    if (!(automation ? settings.automations : settings.finished)) return;
    let answer;
    for (let index = store.data.messages.length - 1; index >= 0 && !answer; index--) {
      const message = store.data.messages[index];
      if (message.runId === run.id && message.role === 'assistant' && message.status !== 'running') answer = message;
    }
    const general = run.status === 'completed' ? translate('任务完成了') : translate('任务没有完成');
    const preview = settings.content && answer ? previewText(answer.content, answer.attachments) : '';
    this.announce({
      title: this.title(run.botId, run.sessionId),
      body: preview || general,
      // One notice per chat: a later answer replaces the earlier one.
      tag: 'chat-' + run.botId + (run.sessionId ? '/' + run.sessionId : ''),
      target: { botId: run.botId, sessionId: run.sessionId },
    });
  }
}
