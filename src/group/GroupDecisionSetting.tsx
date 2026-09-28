import { useState } from 'react';
import { DECISION_MODELS, type LayaFeatureState } from '../../shared/types/laya-types';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
export function GroupDecisionSetting({ laya }: { laya: LayaFeatureState }) {
  const { t } = useI18n();
  const [layaPending, setLayaPending] = useState(false),
    [layaError, setLayaError] = useState('');
  const downloading = Boolean(laya.downloading),
    cancelling = laya.phase === 'cancelling',
    variant = laya.active || laya.recommended,
    installed = Boolean(variant && laya.installed.includes(variant)),
    active = Boolean(variant && laya.active === variant && laya.enabled);
  const modelName = t(DECISION_MODELS.find((model) => model.id === variant)?.name || 'Laya');
  const changeLaya = async () => {
    if (layaPending && !downloading) return;
    setLayaError('');
    setLayaPending(true);
    try {
      if (downloading) await window.aelion.cancelLayaInstall();
      else if (active) await window.aelion.setLayaEnabled(false);
      else if (laya.active && installed) await window.aelion.setLayaEnabled(true);
      else if (variant && installed) await window.aelion.selectLaya(variant);
      else await window.aelion.installLaya();
    } catch (error) {
      setLayaError(ipcErrorText(error));
    } finally {
      setLayaPending(false);
    }
  };
  const layaStatus = cancelling
    ? t('正在取消下载…')
    : downloading
      ? (
          {
            preparing: t('正在准备下载组件…'),
            installing: t('正在安装模型环境…'),
            loading: t('正在加载模型…'),
          } as Record<string, string>
        )[laya.phase] || t('正在下载…')
      : active && laya.phase === 'ready'
        ? t('{model} 已启用，适用于所有群聊', { model: modelName })
        : active && laya.phase === 'loading'
          ? t('{model} 正在加载…', { model: modelName })
          : active && laya.phase === 'error'
            ? t(laya.error || '模型加载失败')
            : installed
              ? t('{model} 已下载，当前未启用', { model: modelName })
              : undefined;
  return (
    <div className="group-laya-setting">
      <div className="group-laya-setting-row">
        <div className="group-laya-setting-copy">
          <strong>{t('实验 · 决策模型')}</strong>
          <small>{t('本地判断 Bot 是否需要参与群聊')}</small>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={cancelling || (layaPending && !downloading) || !laya.supported}
          onClick={() => void changeLaya()}
        >
          {cancelling
            ? t('取消中…')
            : downloading
              ? t('取消下载')
              : active
                ? t('暂停')
                : installed
                  ? t('启用')
                  : t('一键下载并启用')}
        </button>
      </div>
      {(layaError || !laya.supported || layaStatus) && (
        <small role="status">
          {layaError ? t(layaError) : !laya.supported ? t('当前系统暂不支持本地决策模型') : layaStatus}
        </small>
      )}
    </div>
  );
}
