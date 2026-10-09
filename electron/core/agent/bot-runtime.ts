import { resumableRun } from './resume-run';
import type { Harness } from './harness';
import type { Store } from '../storage/store';
import type { HarnessRunOptions, PeerGateway } from './peer-runtime-types';
import type { GroupGateway } from '../group/group-runtime-types';
import type { TaskScheduler } from '../scheduler/task-scheduler';
import type { AgentPreviews } from '../preview/agent-previews';
import type { VideoFrames } from '../preview/video-frames';
import { AppError } from '../../../shared/errors';
import { laneMatches, runLane } from './run-lanes';
/** One dispatch boundary for private chat, groups, delegated work and schedules. Every Bot runs the general agent. */
export class BotRuntime {
  private dispatching = new Set<string>();
  readonly streams: { snapshot: () => ReturnType<Harness['streams']['snapshot']> };
  constructor(
    private store: Store,
    readonly general: Harness,
    private changed: () => void,
  ) {
    this.streams = { snapshot: () => general.streams.snapshot() };
  }
  get busy() {
    return this.dispatching.size > 0 || this.general.busy;
  }
  /**
   * Whether the Bot is working: in any of its chats (`sessionId` undefined), its main chat with its group and
   * delegated work (null), or one work session.
   */
  isRunning(id: string, sessionId?: string | null) {
    for (const lane of this.dispatching) if (laneMatches(lane, id, sessionId)) return true;
    return this.general.isRunning(id, sessionId);
  }
  async run(id: string, input: string, options: HarnessRunOptions = {}) {
    const resumedSession = options.resumeRunId
      ? this.store.data.runs.find((r) => r.id === options.resumeRunId && r.botId === id)?.sessionId
      : undefined;
    const lane = runLane(id, options.sessionId ?? resumedSession);
    if (this.isRunning(id, options.sessionId ?? resumedSession ?? null))
      throw Error('这个 Bot 仍在工作，请等待或停止当前任务');
    // A group follow-up may carry an old designer run's task forward; only resuming that run itself is refused.
    const resumed = options.resumeRunId
      ? this.store.data.runs.find((r) => r.id === options.resumeRunId && r.botId === id)
      : undefined;
    if (resumed?.engine === 'designer') throw retiredDesignerRun();
    this.dispatching.add(lane);
    try {
      await this.general.run(id, input, options);
    } finally {
      this.dispatching.delete(lane);
    }
  }
  async resume(botId: string, runId: string) {
    const run = this.store.data.runs.find((r) => r.id === runId && r.botId === botId);
    if (!run) throw Error('任务不存在');
    if (run.engine === 'designer') throw retiredDesignerRun();
    const previous = resumableRun(this.store, botId, runId),
      source = this.store.humanRunMessage(previous.id),
      work = this.store.data.workItems?.find((item) => item.id === previous.workItemId);
    if (previous.groupOrigin || previous.peerOrigin) throw Error('协作任务需要通过原会话恢复');
    const input = source?.content || work?.objective || (source?.attachments?.length ? '继续处理用户已发送的附件' : '');
    if (!input) throw Error('未找到原任务要求，请重新发送任务范围');
    return this.run(botId, input, {
      resumeRunId: previous.id,
      workItemId: previous.workItemId,
      workspaceDir: previous.workspaceDir,
      attachments: source?.attachments,
    });
  }

  /** Stops the Bot's work: everywhere, in its main chat (`sessionId` null) or in one work session. */
  cancel(id: string, sessionId?: string | null) {
    this.general.cancel(id, sessionId);
  }
  liveWork() {
    return this.general.liveWork();
  }
  stopLiveWork(botId: string, kind: 'terminal' | 'process', id: string) {
    return this.general.stopLiveWork(botId, kind, id);
  }
  refreshInput(id: string, sessionId?: string | null) {
    return this.general.refreshInput(id, sessionId);
  }
  refreshGroup(id: string) {
    this.general.refreshGroup(id);
  }
  setPeerGateway(gateway: PeerGateway) {
    this.general.setPeerGateway(gateway);
  }
  setGroupGateway(gateway: GroupGateway) {
    this.general.setGroupGateway(gateway);
  }
  setPreviewGateway(gateway: AgentPreviews) {
    this.general.setPreviewGateway(gateway);
  }
  setTaskScheduler(scheduler: TaskScheduler) {
    this.general.setTaskScheduler(scheduler);
  }
  setVideoFrames(video: VideoFrames) {
    this.general.setVideoFrames(video);
  }
  disposeTools() {
    this.general.disposeTools();
  }
  closeProcesses() {
    return this.general.closeProcesses();
  }
  stopBotProcesses(botId: string) {
    return this.general.stopBotProcesses(botId);
  }
}
/** Runs of the retired designer engine keep their records and files but cannot be continued as they were. */
const retiredDesignerRun = () =>
  new AppError('bot.designer_retired', '这是旧版设计师的任务，请在对话里重新发送修改意见，Bot 会接着这个设计任务继续');
