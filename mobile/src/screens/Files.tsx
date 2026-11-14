// Files that came up in a Bot's chats, newest first; opening one saves or shares it on the phone.
import { useEffect, useState } from 'react';
import type { RecentFile } from '../../../shared/remote/protocol';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { openFile, useFileUrl } from '../files';
import { back, useEdgeBack } from '../router';
import { I } from '../icons';
import { ConnectionBanner, Spinner, timeLabel, toast } from '../ui';

function Row({ file }: { file: RecentFile }) {
  const image = file.mime.startsWith('image/');
  const url = useFileUrl(image ? file.id : undefined);
  const extension = (file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
  return (
    <li>
      <button className="f-row" onClick={() => void openFile(file.id).catch((error: Error) => toast(error.message))}>
        {image ? (
          <span className="f-thumb">{url && <img src={url} alt="" />}</span>
        ) : (
          <span className={'c-file-icon is-' + extension.toLowerCase()}>{extension}</span>
        )}
        <span className="s-text">
          <b>{file.name}</b>
          <small>
            {timeLabel(file.time)} ·{' '}
            {file.size < 1024 * 1024
              ? Math.ceil(file.size / 1024) + ' KB'
              : (file.size / 1024 / 1024).toFixed(1) + ' MB'}
          </small>
        </span>
        <I name="right" size={16} />
      </button>
    </li>
  );
}

export function FilesScreen({ botId }: { botId: string }) {
  const { t } = useI18n();
  const { home, status } = useConnection();
  const [files, setFiles] = useState<RecentFile[]>();
  const edge = useEdgeBack();
  const bot = home?.bots.find((item) => item.id === botId);
  useEffect(() => {
    if (status !== 'ready') return;
    let alive = true;
    connection.call('files.recent', { botId }).then(
      (list) => alive && setFiles(list),
      (error: Error) => toast(error.message),
    );
    return () => {
      alive = false;
    };
  }, [botId, status]);
  return (
    <div
      className="c-screen"
      {...edge.handlers}
      style={edge.offset ? { transform: `translateX(${edge.offset}px)` } : undefined}
    >
      <header className="c-nav">
        <button className="x-round" aria-label={t('返回')} onClick={back}>
          <I name="back" size={26} stroke={2.2} />
        </button>
        <div className="c-title is-static">
          <b>{t('文件')}</b>
          <small>{bot?.name}</small>
        </div>
        <span className="x-round" />
      </header>
      <ConnectionBanner />
      <div className="f-scroll">
        {!files ? (
          <div className="c-loading">
            <Spinner />
          </div>
        ) : files.length ? (
          <ul className="f-list">
            {files.map((file) => (
              <Row key={file.id} file={file} />
            ))}
          </ul>
        ) : (
          <p className="s-note">{t('对话里还没有文件。')}</p>
        )}
      </div>
    </div>
  );
}
