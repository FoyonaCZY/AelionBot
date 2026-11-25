import { useEffect, useRef, useState } from 'react';
import { ATTACHMENT_LIMITS } from '../../shared/types/attachment-types';
import { useI18n } from '../i18n';
import { Select } from '../ui/Select';
import { ipcErrorText } from '../ui/ipc-error';

export function VideoTest() {
  const { t } = useI18n(),
    [sourceMode, setSourceMode] = useState<'text' | 'file' | 'image' | 'video'>('text'),
    [url, setUrl] = useState(''),
    [prompt, setPrompt] = useState(''),
    [file, setFile] = useState<File>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState('');
  const current = useRef(''),
    objectUrl = useRef('');
  useEffect(
    () => () => {
      const id = current.current;
      current.current = '';
      if (id) void window.aelion.cancelVideoTest(id).catch(() => {});
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  const start = async () => {
    if (!prompt.trim() || current.current) return;
    if (sourceMode === 'file' && file && file.size > ATTACHMENT_LIMITS.fileBytes) {
      setError(t('单个附件不能超过 25 MB'));
      return;
    }
    const id = crypto.randomUUID();
    current.current = id;
    setPending(true);
    setError('');
    try {
      const source =
        sourceMode === 'file' && file
          ? { mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
          : sourceMode === 'image' || sourceMode === 'video'
            ? { kind: sourceMode, url: url.trim() }
            : undefined;
      if (current.current !== id) return;
      const result = await window.aelion.testVideoModel({ id, prompt, source });
      if (current.current !== id) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mime }));
      setPreview(objectUrl.current);
    } catch (e) {
      if (current.current === id) setError(ipcErrorText(e));
    } finally {
      if (current.current === id) {
        current.current = '';
        setPending(false);
      }
    }
  };
  const stop = () => {
    const id = current.current;
    current.current = '';
    setPending(false);
    if (id) void window.aelion.cancelVideoTest(id).catch((e) => setError(ipcErrorText(e)));
  };
  return (
    <section className="media-test">
      <div className="settings-card">
        <label className="settings-row">
          <span>{t('提示词')}</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={32000} disabled={pending} />
        </label>
        <label className="settings-row">
          <span>{t('输入素材')}</span>
          <Select
            value={sourceMode}
            disabled={pending}
            onChange={(e) => setSourceMode(e.target.value as typeof sourceMode)}
          >
            <option value="text">{t('仅文字')}</option>
            <option value="file">{t('本地图片或视频')}</option>
            <option value="image">{t('图片 URL')}</option>
            <option value="video">{t('视频 URL')}</option>
          </Select>
        </label>
        {sourceMode === 'file' && (
          <label className="settings-row">
            <span>{t('本地文件')}</span>
            <input
              type="file"
              accept="image/*,video/*"
              disabled={pending}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
        )}
        {(sourceMode === 'image' || sourceMode === 'video') && (
          <label className="settings-row">
            <span>URL</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={pending}
              placeholder="https://"
            />
          </label>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={
            !pending &&
            (!prompt.trim() ||
              (sourceMode === 'file' && !file) ||
              (['image', 'video'].includes(sourceMode) && !url.trim()))
          }
          onClick={pending ? stop : () => void start()}
        >
          {t(pending ? '停止等待' : '提交生成任务')}
        </button>
        {error && (
          <p className="provider-error" role="alert">
            {error}
          </p>
        )}
        {preview && <video controls src={preview} />}
      </div>
    </section>
  );
}
