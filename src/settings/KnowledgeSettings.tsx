import { useState } from 'react';
import type { Bot } from '../../shared/types/core';
import {
  KNOWLEDGE_FILE_LIMIT,
  type KnowledgeBaseView,
  type KnowledgeIssue,
  type KnowledgeSource,
  type KnowledgeView,
} from '../../shared/types/knowledge-types';
import { SettingsEmpty, SettingsSection } from './SettingsWindow';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import { ipcErrorText } from '../ui/ipc-error';
import './knowledge-settings.css';

interface Draft {
  id?: string;
  name: string;
  description: string;
  sources: KnowledgeSource[];
  /** Absent: every Bot may search it. */
  botIds?: string[];
}
/** Why a file is not in the index, by the reason the indexer recorded. */
const REASONS: Record<string, string> = {
  too_large: '文件过大',
  no_text: '没有可提取的文字',
  unsupported: '不支持的文件类型',
  pdf_password: '有密码保护',
  file_damaged: '文件已损坏',
  not_text: '不是文本文件',
  encoding_unsupported: '无法识别文字编码',
};

/** The end of a path says more than its start: a long one is shown by its last folders. */
function shortPath(path: string) {
  const separator = path.includes('\\') ? '\\' : '/',
    parts = path.split(separator).filter(Boolean);
  return parts.length > 4 ? '…' + separator + parts.slice(-3).join(separator) : path;
}

/** Settings → 知识库: folders and files a Bot can search when it answers. */
export function KnowledgeSettings({
  view,
  bots,
  onNotify,
  onOpenMemory,
}: {
  view?: KnowledgeView;
  bots: Bot[];
  onNotify: (message: string) => void;
  onOpenMemory: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [issues, setIssues] = useState<Record<string, KnowledgeIssue[]>>({});
  if (!view) return null;
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      return true;
    } catch (error) {
      onNotify(ipcErrorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const edit = (value?: Draft) => {
    setConfirming(false);
    setDraft(value);
  };
  const addSources = (kind: 'folder' | 'files') =>
    act(async () => {
      const paths = await window.aelion.pickKnowledgeSources(kind);
      if (!paths.length) return;
      setDraft(
        (current) =>
          current && {
            ...current,
            sources: [
              ...current.sources,
              ...paths
                .filter((path) => !current.sources.some((source) => source.path === path))
                .map((path) => ({ path, kind: kind === 'folder' ? ('folder' as const) : ('file' as const) })),
            ],
          },
      );
    });
  const save = async () => {
    if (!draft) return;
    const saved = await act(() =>
      window.aelion.saveKnowledgeBase({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        description: draft.description,
        sources: draft.sources,
        botIds: draft.botIds ?? null,
      }),
    );
    if (saved) edit(undefined);
  };
  const remove = async () => {
    if (!draft?.id) return;
    if (!confirming) return setConfirming(true);
    if (await act(() => window.aelion.removeKnowledgeBase(draft.id!))) edit(undefined);
  };
  const status = (base: KnowledgeBaseView) => {
    if (base.state === 'indexing')
      return base.progress?.total
        ? t('正在索引 {done}/{total}', { done: base.progress.done, total: base.progress.total })
        : t('正在索引…');
    if (base.state === 'queued') return t('等待索引');
    return [
      t('{count} 个文件', { count: base.files }),
      base.botIds ? t('{count} 个 Bot 可用', { count: base.botIds.length }) : t('所有 Bot 可用'),
      ...(base.indexedAt ? [t('索引于 {time}', { time: new Date(base.indexedAt).toLocaleString() })] : []),
    ].join(' · ');
  };
  const editor = draft && (
    <form
      className="settings-card knowledge-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="settings-row">
        <span>{t('名称')}</span>
        <input
          autoFocus
          value={draft.name}
          maxLength={60}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="settings-row">
        <span>{t('说明')}</span>
        <input
          value={draft.description}
          maxLength={200}
          disabled={busy}
          placeholder={t('可选，告诉 Bot 里面有什么')}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <div className="settings-row knowledge-sources">
        <span>{t('来源')}</span>
        <div>
          {draft.sources.map((source) => (
            <div className="knowledge-source" key={source.path}>
              <Icon name={source.kind === 'folder' ? 'folder' : 'file'} size={14} />
              <span title={source.path}>{shortPath(source.path)}</span>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() =>
                  setDraft({ ...draft, sources: draft.sources.filter((item) => item.path !== source.path) })
                }
              >
                {t('移除')}
              </button>
            </div>
          ))}
          <div className="knowledge-source-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => addSources('folder')}>
              {t('添加文件夹')}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => addSources('files')}>
              {t('添加文件')}
            </button>
          </div>
        </div>
      </div>
      <div className="settings-switch-row">
        <div className="settings-row-copy">
          <span>{t('所有 Bot 都可以用')}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-label={t('所有 Bot 都可以用')}
          aria-checked={!draft.botIds}
          className={draft.botIds ? 'learning-switch' : 'learning-switch enabled'}
          disabled={busy}
          onClick={() => setDraft({ ...draft, botIds: draft.botIds ? undefined : bots.map((bot) => bot.id) })}
        >
          <i />
        </button>
      </div>
      {draft.botIds && (
        <div className="knowledge-bots">
          {bots.map((bot) => (
            <label className="knowledge-bot" key={bot.id}>
              <input
                type="checkbox"
                checked={draft.botIds!.includes(bot.id)}
                disabled={busy}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    botIds: event.target.checked
                      ? [...draft.botIds!, bot.id]
                      : draft.botIds!.filter((id) => id !== bot.id),
                  })
                }
              />
              <Avatar bot={bot} size={20} />
              <span>{bot.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="knowledge-editor-footer">
        {draft.id && (
          <button type="button" className="secondary-button danger-text" disabled={busy} onClick={() => void remove()}>
            {confirming ? t('确认删除') : t('删除')}
          </button>
        )}
        <span />
        <button type="button" className="secondary-button" disabled={busy} onClick={() => edit(undefined)}>
          {t('取消')}
        </button>
        <button className="primary-button" disabled={busy || !draft.name.trim() || !draft.sources.length}>
          {t('保存')}
        </button>
      </div>
    </form>
  );
  return (
    <SettingsSection
      title={t('知识库')}
      aside={
        !draft && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => edit({ name: '', description: '', sources: [] })}
          >
            <Icon name="plus" size={14} />
            {t('新建')}
          </button>
        )
      }
    >
      {!view.semantic && (
        <p className="knowledge-note">
          {t('现在按关键词检索。')}
          <button type="button" className="text-button" onClick={onOpenMemory}>
            {t('开启语义检索')}
          </button>
        </p>
      )}
      {draft && !draft.id && editor}
      {view.bases.map((base) =>
        draft?.id === base.id ? (
          <div key={base.id}>{editor}</div>
        ) : (
          <div className="settings-card knowledge-base" key={base.id}>
            <div className="settings-switch-row">
              <Icon name="book" size={18} />
              <div className="settings-row-copy">
                <span>{base.name}</span>
                <small>{status(base)}</small>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={busy || base.state !== 'idle'}
                onClick={() => act(() => window.aelion.reindexKnowledgeBase(base.id))}
              >
                {t('重新索引')}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy || Boolean(draft)}
                onClick={() =>
                  edit({
                    id: base.id,
                    name: base.name,
                    description: base.description || '',
                    sources: base.sources,
                    ...(base.botIds ? { botIds: base.botIds } : {}),
                  })
                }
              >
                {t('编辑')}
              </button>
            </div>
            {(base.error || base.missing?.length || base.truncated || base.issues > 0) && (
              <div className="knowledge-warnings">
                {base.error && <p>{t('索引没有完成：{reason}', { reason: base.error })}</p>}
                {base.missing?.slice(0, 3).map((path) => (
                  <p key={path} title={path}>
                    {t('找不到来源：{path}', { path: shortPath(path) })}
                  </p>
                ))}
                {base.truncated && (
                  <p>{t('文件超过 {limit} 个，只收录了前 {limit} 个', { limit: KNOWLEDGE_FILE_LIMIT })}</p>
                )}
                {base.issues > 0 && (
                  <details
                    onToggle={(event) => {
                      if (!event.currentTarget.open) return;
                      void window.aelion.knowledgeIssues(base.id).then(
                        (list) => setIssues((current) => ({ ...current, [base.id]: list })),
                        (error) => onNotify(ipcErrorText(error)),
                      );
                    }}
                  >
                    <summary>{t('{count} 个文件未收录', { count: base.issues })}</summary>
                    <ul>
                      {(issues[base.id] || []).map((issue) => (
                        <li key={issue.path}>
                          <span title={issue.path}>{shortPath(issue.path)}</span>
                          <small>{t(REASONS[issue.reason] || '无法读取')}</small>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        ),
      )}
      {!view.bases.length && !draft && (
        <SettingsEmpty
          icon="book"
          title={t('还没有知识库')}
          description={t('把文件夹加进来，Bot 回答时就能检索里面的文档。')}
        />
      )}
    </SettingsSection>
  );
}
