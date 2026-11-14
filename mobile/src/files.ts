// Files on the computer, read through the connection and kept as blob URLs while the app runs; uploads from the phone.
import { useEffect, useState } from 'react';
import type { Attachment } from '../../shared/types/attachment-types';
import { REMOTE_FILE_BYTES } from '../../shared/remote/protocol';
import { translate } from '../../shared/i18n';
import { connection } from './connection';

interface LoadedFile {
  url: string;
  mime: string;
  name: string;
  blob: Blob;
}
const loaded = new Map<string, Promise<LoadedFile>>();

function loadFile(id: string) {
  let entry = loaded.get(id);
  if (!entry) {
    entry = connection.call('files.read', { id }).then(({ name, mime, bytes }) => {
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime || 'application/octet-stream' });
      return { url: URL.createObjectURL(blob), mime, name, blob };
    });
    // A failed read can be tried again later.
    entry.catch(() => loaded.delete(id));
    loaded.set(id, entry);
  }
  return entry;
}

/** An image attachment's address once it has loaded. */
export function useFileUrl(id: string | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!id) return;
    let alive = true;
    loadFile(id).then(
      (file) => alive && setUrl(file.url),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

/** Shows a file the way the phone does best: the share sheet (save, open in an app), or a new tab. */
export async function openFile(id: string) {
  const file = await loadFile(id);
  const shared = new File([file.blob], file.name, { type: file.mime });
  if (navigator.canShare?.({ files: [shared] })) {
    try {
      await navigator.share({ files: [shared] });
      return;
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
    }
  }
  window.open(file.url, '_blank', 'noopener');
}

/** Photos are sent as JPEG at most 2560 px wide: a phone photo is otherwise many megabytes through the relay. */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 1_500_000) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function uploadFile(scope: { kind: 'bot' | 'group'; id: string; sessionId?: string }, file: File) {
  const blob = await shrink(file);
  if (blob.size > REMOTE_FILE_BYTES) throw new Error(translate('文件不能超过 25 MB'));
  const name = blob === file ? file.name : file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return connection.call('files.upload', {
    scope,
    name,
    bytes: new Uint8Array(await blob.arrayBuffer()),
  }) as Promise<Attachment>;
}
