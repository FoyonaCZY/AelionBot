import { Select } from '../ui/Select';
import { useState } from 'react';
import type { IntegrationSource, Skill } from '../../shared/types/core';
import { Icon } from '../ui';
import { useI18n } from '../i18n';
import './mcp-snippet.css';

type Act = (operation: () => Promise<unknown>) => Promise<void>;
const MCP_SNIPPET = `"my-node-tool": {
  "command": "npx",
  "args": ["-y", "@username/mcp-server-example"],
  "env": {
    "API_KEY": "your_api_key_here"
  }
}`;
export function McpSnippetDialog({
  busy,
  onClose,
  onImport,
}: {
  busy: boolean;
  onClose: () => void;
  onImport: (text: string) => Promise<unknown>;
}) {
  const { t, language } = useI18n(),
    label = (cn: string, en: string, tw = cn) => (language === 'en' ? en : language === 'zh-TW' ? tw : cn);
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await onImport(text);
      onClose();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="mcp-snippet-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div className="mcp-snippet-dialog" role="dialog" aria-labelledby="mcp-snippet-title">
        <h2 id="mcp-snippet-title">{label('添加 MCP', 'Add MCP', '新增 MCP')}</h2>
        <p>
          {label(
            '粘贴服务配置。可以是单个服务，也可以是完整的 mcpServers 对象。',
            'Paste a server snippet, or a full mcpServers object.',
            '貼上服務設定。可以是單一服務，也可以是完整的 mcpServers 物件。',
          )}
        </p>
        <textarea
          aria-label={label('MCP 配置', 'MCP configuration', 'MCP 設定')}
          spellCheck={false}
          value={text}
          placeholder={MCP_SNIPPET}
          disabled={busy || saving}
          onChange={(event) => setText(event.target.value)}
        />
        {error && (
          <p className="mcp-snippet-error" role="alert">
            {error}
          </p>
        )}
        <div className="mcp-snippet-actions">
          <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>
            {t('取消')}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || saving || !text.trim()}
            onClick={() => void submit()}
          >
            {saving ? t('保存中…') : label('添加', 'Add', '新增')}
          </button>
        </div>
      </div>
    </div>
  );
}
export function IntegrationSources({ sources, busy, act }: { sources: IntegrationSource[]; busy: boolean; act: Act }) {
  const { t } = useI18n();
  return (
    <details className="integration-sources">
      <summary>
        {t('扫描位置与来源')}{' '}
        <span>{t('{count} 个可访问位置', { count: sources.filter((source) => source.exists).length })}</span>
        <Icon name="down" size={15} />
      </summary>
      {sources
        .filter((source) => source.exists || source.label === 'Aelion' || source.label === '共享技能')
        .map((source) => (
          <div className="integration-source" key={source.id}>
            <div>
              <strong>{source.label}</strong>
              <code>{source.path}</code>
              {source.issue && <p>{source.issue}</p>}
            </div>
            <span>{t('{count} 项', { count: source.count })}</span>
            <button
              className="text-button"
              disabled={busy || !source.exists}
              onClick={() => act(() => window.aelion.openIntegrationPath({ kind: 'source', id: source.id }))}
            >
              {t('打开')}
            </button>
          </div>
        ))}
    </details>
  );
}
export function SkillControls({
  skill,
  botId,
  onChanged,
  hideArchive = false,
}: {
  skill: Skill;
  botId: string;
  onChanged: () => Promise<void>;
  hideArchive?: boolean;
}) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [versions, setVersions] = useState<Array<{ revision: number; createdAt: string }>>([]),
    [revision, setRevision] = useState('');
  const manage = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await window.aelion.manageSkill({
        botId,
        id: skill.id,
        action,
        ...(action === 'restore_revision' ? { revision: Number(revision) } : {}),
      });
      if (action === 'revisions') setVersions(result as typeof versions);
      else await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="settings-actions">
        <button className="text-button" disabled={busy} onClick={() => void manage(skill.pinned ? 'unpin' : 'pin')}>
          {skill.pinned ? t('取消置顶') : t('置顶')}
        </button>
        {!hideArchive && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void manage(skill.archived ? 'restore' : 'archive')}
          >
            {skill.archived ? t('恢复') : t('归档')}
          </button>
        )}
        {skill.botId && (
          <button className="text-button" disabled={busy} onClick={() => void manage('revisions')}>
            {t('历史版本')}
          </button>
        )}
      </div>
      {Boolean(versions.length) && (
        <div className="settings-actions">
          <Select aria-label={t('技能历史版本')} value={revision} onChange={(e) => setRevision(e.target.value)}>
            <option value="">{t('选择版本')}</option>
            {versions.map((v) => (
              <option key={v.revision} value={v.revision}>
                {v.revision} · {new Date(v.createdAt).toLocaleString(language)}
              </option>
            ))}
          </Select>
          <button
            className="secondary-button"
            disabled={busy || revision === ''}
            onClick={() => void manage('restore_revision')}
          >
            {t('恢复此版本')}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
