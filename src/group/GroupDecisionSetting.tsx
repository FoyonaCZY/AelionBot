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
  let statusText: string | undefined;
  let buttonText = t('一键下载并启用');
  if (cancelling) {
    buttonText = t('取消中…');
    statusText = t('正在取消下载…');
  } else if (downloading) {
    buttonText = t('取消下载');
    if (laya.phase === 'preparing') statusText = t('正在准备下载组件…');
    else if (laya.phase === 'installing') statusText = t('正在安装模型环境…');
    else if (laya.phase === 'loading') statusText = t('正在加载模型…');
    else statusText = t('正在下载…');
  } else if (active) {
    buttonText = t('暂停');
    if (laya.phase === 'ready') statusText = t('{model} 已启用，适用于所有群聊', { model: modelName });
    else if (laya.phase === 'loading') statusText = t('{model} 正在加载…', { model: modelName });
    else if (laya.phase === 'error') statusText = t(laya.error || '模型加载失败');
    else if (installed) statusText = t('{model} 已下载，当前未启用', { model: modelName });
  } else if (installed) {
    buttonText = t('启用');
    statusText = t('{model} 已下载，当前未启用', { model: modelName });
  }
  if (!laya.supported) statusText = t('当前系统暂不支持本地决策模型');
  if (layaError) statusText = t(layaError);
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
          {buttonText}
        </button>
      </div>
      {statusText && <small role="status">{statusText}</small>}
    </div>
  );
}
