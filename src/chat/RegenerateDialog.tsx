import { useState } from 'react';
import type { ModelConfig, ModelProvider, ModelSelection } from '../../shared/types/core';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { useI18n } from '../i18n';
import './regenerate-dialog.css';

const keyOf = (providerId: string | undefined, model: string) => (providerId || '') + '\n' + model;

/**
 * Confirms making the last answer again: with the Bot's model, or with another one, which the Bot then keeps using.
 * Resolves `onConfirm` with the new selection, or with nothing when the model stays.
 */
export function RegenerateDialog({
  providers,
  current,
  onClose,
  onConfirm,
}: {
  providers: ModelProvider[];
  /** The model the Bot answers with now. */
  current?: ModelConfig;
  onClose: () => void;
  onConfirm: (selection?: ModelSelection) => Promise<void>;
}) {
  const { t } = useI18n();
  const currentKey = keyOf(current?.providerId, current?.model || '');
  const [choice, setChoice] = useState(currentKey),
    [pending, setPending] = useState(false);
  const listed = providers.filter((provider) => provider.models.length);
  const known = listed.some((provider) => provider.models.some((model) => keyOf(provider.id, model.id) === currentKey));
  const confirm = async () => {
    const [providerId, id] = choice.split('\n');
    const entry = providers.find((provider) => provider.id === providerId)?.models.find((model) => model.id === id);
    setPending(true);
    try {
      await onConfirm(
        choice === currentKey || !entry
          ? undefined
          : {
              providerId,
              model: entry.id,
              contextTokens: entry.contextTokens || current?.contextTokens || 32000,
              ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
              ...(entry.supportsImages !== undefined ? { supportsImages: entry.supportsImages } : {}),
            },
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="modal regenerate-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('重新生成')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <h2>{t('重新生成')}</h2>
          <div className="modal-header-actions">
            <button className="icon-button" aria-label={t('关闭对话框')} disabled={pending} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) void confirm();
          }}
        >
          <p>{t('这条回复会被新的回复替换。已经写好的文件、执行过的操作不会撤销。')}</p>
          {listed.length > 0 && (
            <label>
              {t('模型')}
              <Select value={choice} disabled={pending} onChange={(event) => setChoice(event.target.value)}>
                {!known && current?.model && <option value={currentKey}>{current.model}</option>}
                {listed.map((provider) => (
                  <optgroup key={provider.id} label={provider.name}>
                    {provider.models.map((model) => (
                      <option key={model.id} value={keyOf(provider.id, model.id)}>
                        {model.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </label>
          )}
          {choice !== currentKey && <p>{t('这个 Bot 之后也用这个模型。')}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>
              {t('取消')}
            </button>
            <button type="submit" className="primary-button" autoFocus disabled={pending}>
              {t('重新生成')}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
