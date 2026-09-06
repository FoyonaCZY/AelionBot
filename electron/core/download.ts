import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function fileHash(path: string, algorithm = 'sha512') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifiedDownload(url: string, destination: string, expectedHash: string, progress: (fraction: number, detail: string) => void, algorithm:'sha512'|'sha256'='sha512') {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    progress(0, '正在验证已下载的镜像');
    if (await fileHash(destination,algorithm) === expectedHash) return;
    throw new Error('镜像校验失败。原文件已保留，请检查下载缓存。');
  }
  const partial = `${destination}.part`;
  const offset = existsSync(partial) ? statSync(partial).size : 0;
  const response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(1_800_000) });
  if (!response.ok || !response.body) throw new Error(`镜像下载失败：HTTP ${response.status}`);
  const resumed = response.status === 206;
  let bytes = resumed ? offset : 0;
  const total = bytes + Number(response.headers.get('content-length') || 0);
  const stream = Readable.fromWeb(response.body as never);
  let last = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (Date.now() - last > 700) { last = Date.now(); progress(total ? bytes/total : 0, `下载镜像 ${Math.round(bytes/1048576)} / ${Math.round(total/1048576)} MB`); }
  });
  await pipeline(stream, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }));
  progress(1, '正在校验镜像完整性');
  if (await fileHash(partial,algorithm) !== expectedHash) throw new Error(`资源 ${algorithm} 校验不匹配，未使用该资源。`);
  renameSync(partial, destination);
}
