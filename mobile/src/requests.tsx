// A Bot waiting on the user: a permission, a question, the work computer. In a chat it replaces the composer, under
// the thumb; on the home list it is a card that can be answered without opening the chat.
import { useState } from 'react';
import type { InteractionAction } from '../../shared/types/core';
import type { RemoteBot, RemoteRequest } from '../../shared/remote/protocol';
import { Avatar } from '../../src/ui/Avatar';
import { useI18n } from '../../src/i18n';
import { connection } from './connection';
import { I } from './icons';
import { toast } from './ui';

function describeRequest(request: RemoteRequest, t: (key: string) => string) {
  if (request.kind === 'host_permission') {
    const details = request.details;
    const title = {
      command: t('运行本机命令'),
      read_file: t('读取本机文件'),
      write_file: t('修改本机文件'),
      delete_file: t('删除本机文件'),
      mcp: t('调用外部工具'),
    }[details.operation];
    const main =
      details.operation === 'command'
        ? details.command
        : details.operation === 'mcp'
          ? [details.server, details.tool].filter(Boolean).join(' · ')
          : details.path;
    return { title, main, code: details.operation === 'command', quick: true };
  }
  if (request.kind === 'computer_use') return { title: t('想操作你的电脑'), quick: true };
  if (request.kind === 'user_input') return { title: t('有问题想问你'), main: request.questions[0]?.title };
  return { title: t('需要你处理工作电脑'), main: request.reason };
}

async function respond(id: string, action: InteractionAction, answers?: Record<string, string>) {
  try {
    await connection.call('request.respond', { id, action, ...(answers ? { answers } : {}) });
  } catch (error) {
    toast((error as Error).message);
  }
}

/** On the home list: who asks and what; permissions are answered right here. */
export function RequestCard({ request, bot, onOpen }: { request: RemoteRequest; bot?: RemoteBot; onOpen: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const text = describeRequest(request, t);
  return (
    <div className="h-ask" style={bot ? ({ '--bot': bot.color } as React.CSSProperties) : undefined}>
      <button className="h-ask-head" onClick={onOpen}>
        {bot && <Avatar bot={bot} size={26} activity="waiting" />}
        <span className="h-ask-text">
          <b>{bot?.name}</b> {text.title}
        </span>
        <I name="right" size={16} />
      </button>
      {text.main && (text.code ? <code>{text.main}</code> : <p>{text.main}</p>)}
      {text.quick ? (
        <div className="x-pair">
          <button
            className="x-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void respond(request.id, 'deny').finally(() => setBusy(false));
            }}
          >
            {t('拒绝')}
          </button>
          <button
            className="x-btn is-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void respond(request.id, 'allow').finally(() => setBusy(false));
            }}
          >
            {t('允许')}
          </button>
        </div>
      ) : (
        <button className="x-btn is-wide" onClick={onOpen}>
          {request.kind === 'user_input' ? t('去回答') : t('去处理')}
        </button>
      )}
    </div>
  );
}

/** In a chat: takes the composer's place until answered. */
export function RequestDock({ request, onComputer }: { request: RemoteRequest; onComputer: () => void }) {
  const { t } = useI18n();
  const [details, setDetails] = useState(false);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const text = describeRequest(request, t);
  const act = (action: InteractionAction, values?: Record<string, string>) => {
    setBusy(true);
    void respond(request.id, action, values).finally(() => setBusy(false));
  };
  const head = (
    <div className="c-dock-head">
      <span className="c-dock-icon">
        <I
          name={request.kind === 'user_input' ? 'user' : request.kind === 'host_permission' ? 'terminal' : 'computer'}
          size={20}
        />
      </span>
      <b>{text.title}</b>
      {request.kind === 'host_permission' && (
        <button className="x-link" onClick={() => setDetails(!details)}>
          {details ? t('收起') : t('详情')}
        </button>
      )}
    </div>
  );
  if (request.kind === 'user_input') {
    const complete = request.questions.every((question) => answers[question.id]?.trim());
    return (
      <div className="c-dock">
        {head}
        <div className="c-questions">
          {request.questions.map((question) => (
            <div key={question.id} className="c-question">
              <p>{question.title}</p>
              {question.options?.length ? (
                <div className="c-options">
                  {question.options.map((option) => (
                    <button
                      key={option}
                      className={'c-option' + (answers[question.id] === option ? ' is-picked' : '')}
                      onClick={() => setAnswers({ ...answers, [question.id]: option })}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                rows={1}
                placeholder={question.options?.length ? t('或者写你的回答') : t('写你的回答')}
                value={question.options?.includes(answers[question.id]) ? '' : answers[question.id] || ''}
                onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
              />
            </div>
          ))}
        </div>
        <button
          className="x-btn is-primary is-wide"
          disabled={busy || !complete}
          onClick={() => act('answer', answers)}
        >
          {t('发送回答')}
        </button>
      </div>
    );
  }
  if (request.kind === 'vm_takeover')
    return (
      <div className="c-dock">
        {head}
        {text.main && <p className="c-dock-text">{text.main}</p>}
        {request.phase === 'controlling' ? (
          <div className="x-pair">
            <button className="x-btn" onClick={onComputer}>
              {t('打开工作电脑')}
            </button>
            <button className="x-btn is-primary" disabled={busy} onClick={() => act('resume')}>
              {t('交还给 Bot')}
            </button>
          </div>
        ) : (
          <div className="x-pair">
            <button className="x-btn" disabled={busy} onClick={() => act('cancel')}>
              {t('取消')}
            </button>
            <button
              className="x-btn is-primary"
              disabled={busy}
              onClick={() => {
                act('takeover');
                onComputer();
              }}
            >
              {t('去处理')}
            </button>
          </div>
        )}
      </div>
    );
  const permission = request.kind === 'host_permission' ? request.details : undefined;
  return (
    <div className="c-dock">
      {head}
      {text.main && <code className="c-cmd">{text.main}</code>}
      {details && permission && (
        <dl className="c-details">
          {permission.reason && (
            <>
              <dt>{t('原因')}</dt>
              <dd>{permission.reason}</dd>
            </>
          )}
          {permission.cwd && (
            <>
              <dt>{t('目录')}</dt>
              <dd>{permission.cwd}</dd>
            </>
          )}
          {request.kind === 'host_permission' && request.approval?.reason && (
            <>
              <dt>{t('审核')}</dt>
              <dd>{request.approval.reason}</dd>
            </>
          )}
          {permission.commandPattern && (
            <dd className="c-always">
              {always ? (
                <span className="c-always-confirm">
                  {t('以后在这个目录自动允许：{pattern}', {
                    pattern:
                      permission.commandPattern.pattern + (permission.commandPattern.kind === 'prefix' ? ' …' : ''),
                  })}
                  <span>
                    <button className="x-link" onClick={() => setAlways(false)}>
                      {t('取消')}
                    </button>
                    <button className="x-link is-strong" disabled={busy} onClick={() => act('allow-always')}>
                      {t('确定')}
                    </button>
                  </span>
                </span>
              ) : (
                <button className="x-link is-underline" onClick={() => setAlways(true)}>
                  {t('以后都允许这类命令')}
                </button>
              )}
            </dd>
          )}
        </dl>
      )}
      <div className="x-pair">
        <button className="x-btn" disabled={busy} onClick={() => act('deny')}>
          {t('拒绝')}
        </button>
        <button className="x-btn is-primary" disabled={busy} onClick={() => act('allow')}>
          {t('允许')}
        </button>
      </div>
    </div>
  );
}
