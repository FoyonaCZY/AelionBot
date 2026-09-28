import { useEffect, useState } from 'react';
import type { ChatMessage, RunRecord } from '../../shared/types/core';
import type { DesignSession } from '../../shared/types/designer-types';
import { toolOperation } from '../../shared/chat/activity';
import { liveBotProgress, waitingExplanation } from '../app/live-bot-progress';
import { translate } from '../../shared/i18n';
import { Icon } from '../ui/Icon';
const designLabels: Record<string, string> = {
  design_tasks: '查看设计任务',
  design_start: '创建设计任务',
  design_use: '读取任务状态',
  design_system: '选择设计系统',
  design_spec: '保存设计约定',
  design_resource: '读取设计资料',
  design_check: '检查实际画面',
  design_publish: '整理交付文件',
  design_deck: '生成演示文稿',
  design_file_create: '写入设计文件',
  design_image: '生成插图',
  design_export_pdf: '导出 PDF',
  design_plugin: '读取设计插件',
};
function designOperationLabel(tool: string) {
  return designLabels[tool] ? translate(designLabels[tool]) : toolOperation(tool).label;
}
function designRecentOperations(messages: ChatMessage[], run: RunRecord) {
  return messages
    .filter(
      (m) =>
        m.botId === run.botId &&
        m.runId === run.id &&
        m.role === 'tool' &&
        m.status === 'done' &&
        (!m.executionId || !run.executions?.some((e) => e.id === m.executionId && e.status !== 'succeeded')),
    )
    .slice(-3);
}
export function DesignerProgress({
  task,
  run,
  messages,
  waiting,
  reviewing = false,
}: {
  task: DesignSession;
  run: RunRecord;
  messages: ChatMessage[];
  waiting?: 'host_permission' | 'vm_takeover' | 'user_input';
  reviewing?: boolean;
}) {
  const [now, setNow] = useState(Date.now()),
    [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.id]);
  const scoped = messages.filter((m) => m.botId === run.botId && m.runId === run.id),
    step = liveBotProgress(scoped, run, waiting, reviewing),
    current = [...scoped].reverse().find((m) => m.role === 'tool' && m.status === 'running'),
    recent = designRecentOperations(scoped, run);
  const seconds = Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 1000)),
    elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const fallback =
    task.stage === 'delivery'
      ? translate('正在整理初版')
      : task.stage === 'verify'
        ? translate('正在核对文件')
        : translate('正在准备下一步');
  const label =
    waiting || step?.retry
      ? step?.label
      : current
        ? translate('正在{label}', { label: designOperationLabel(current.tool || '') })
        : run.modelRequest?.phase === 'streaming'
          ? step?.label || translate('正在生成内容')
          : fallback;
  const note = step && (waitingExplanation(step, now) || (waiting || step.retry ? step.description : undefined));
  return (
    <section className="designer-activity" aria-label={translate('任务进度')}>
      <div className="designer-activity-line">
        <div className="designer-activity-copy">
          <div role="status" aria-live="polite">
            <strong>{label || fallback}</strong>
            {note && <p>{note}</p>}
          </div>
          <div className="designer-activity-meta">
            <time aria-label={translate('已用时间')}>{elapsed}</time>
            {recent.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                  {translate('查看进展')}
                  <Icon name="down" size={11} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="studio-working-collage" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
      {expanded && (
        <ol className="designer-activity-history">
          {recent.map((m) => (
            <li key={m.id}>
              <span className="designer-activity-pin" aria-hidden="true" />
              {designOperationLabel(m.tool || '')}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
