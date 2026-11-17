// A small tar writer and reader for backup files. Backups can hold many gigabytes of attachments, so both sides
// stream: nothing here holds more than one chunk of a file. Paths that ustar cannot carry (non-ASCII, longer than
// 100 bytes) and sizes over 8 GB go into a pax extended header, which 7-Zip, tar and bsdtar all read; a backup can
// be opened by hand when the app cannot restore it.
import { AppError } from '../../../shared/errors';

const BLOCK = 512;
/** The largest size an 11-digit octal field holds. */
const USTAR_MAX_SIZE = 0o77777777777;

export interface TarFile {
  /** Forward slashes, relative, no `..` segments. */
  path: string;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  mode: number;
  /** Yields exactly `size` bytes. */
  body: () => AsyncIterable<Buffer>;
}
export interface TarEntry {
  path: string;
  size: number;
  mtime: number;
  mode: number;
  type: 'file' | 'directory' | 'other';
  /** The entry's bytes; what is not read is skipped before the next entry. */
  body: () => AsyncGenerator<Buffer>;
}

/** One message for every way a file can fail to be a backup; the detail stays in `cause` for diagnostics. */
export const invalidBackup = (detail: string) =>
  new AppError('backup.invalid', '备份文件已损坏，或不是 AelionBot 的备份', { cause: detail });
const invalid = invalidBackup;

function octal(value: number, length: number) {
  return Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(length - 1, '0')
    .slice(-(length - 1));
}
function header(name: string, size: number, mtime: number, mode: number, type: string) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'latin1');
  block.write(octal(mode & 0o7777, 8) + '\0', 100, 8, 'latin1');
  block.write(octal(0, 8) + '\0', 108, 8, 'latin1');
  block.write(octal(0, 8) + '\0', 116, 8, 'latin1');
  block.write(octal(Math.min(size, USTAR_MAX_SIZE), 12) + '\0', 124, 12, 'latin1');
  block.write(octal(mtime, 12) + '\0', 136, 12, 'latin1');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'latin1');
  block.write('ustar\0' + '00', 257, 8, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + '\0 ', 148, 8, 'latin1');
  return block;
}
const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
/** A pax record is `<length> <key>=<value>\n`, where the length counts the whole record, itself included. */
function paxRecord(key: string, value: string) {
  const rest = Buffer.byteLength(` ${key}=${value}\n`);
  let length = rest + String(rest).length;
  if (String(length).length !== String(rest).length) length = rest + String(length).length;
  return `${length} ${key}=${value}\n`;
}
/** A name ustar readers without pax support still show: ASCII, at most 100 bytes. */
const fallbackName = (path: string) => path.replace(/[^\x20-\x7e]/g, '_').slice(-100);

/** The bytes of a tar archive holding `files`, in order. */
export async function* tar(files: AsyncIterable<TarFile> | Iterable<TarFile>): AsyncGenerator<Buffer> {
  for await (const file of files) {
    const plain = /^[\x20-\x7e]*$/.test(file.path) && file.path.length <= 100;
    if (!plain || file.size > USTAR_MAX_SIZE) {
      const records = Buffer.from(
        (plain ? '' : paxRecord('path', file.path)) +
          (file.size > USTAR_MAX_SIZE ? paxRecord('size', String(file.size)) : ''),
      );
      yield header(('PaxHeader/' + fallbackName(file.path)).slice(0, 100), records.length, file.mtime, 0o644, 'x');
      yield records;
      yield padding(records.length);
    }
    yield header(fallbackName(file.path), file.size, file.mtime, file.mode, '0');
    let written = 0;
    for await (const chunk of file.body()) {
      written += chunk.length;
      if (written > file.size) throw new Error('tar entry is longer than its declared size: ' + file.path);
      yield chunk;
    }
    if (written !== file.size) throw new Error('tar entry is shorter than its declared size: ' + file.path);
    yield padding(file.size);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Hands out exact byte counts from a stream of arbitrary chunks. */
class ChunkReader {
  private iterator: AsyncIterator<Buffer>;
  private current: Buffer = Buffer.alloc(0);
  private ended = false;
  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  private async more() {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.current = this.current.length ? Buffer.concat([this.current, next.value]) : next.value;
    return true;
  }
  /** Exactly `length` bytes, or undefined when the stream ends before the first of them. */
  async take(length: number) {
    while (this.current.length < length) {
      if (await this.more()) continue;
      if (!this.current.length) return undefined;
      throw invalid('文件不完整');
    }
    const value = this.current.subarray(0, length);
    this.current = this.current.subarray(length);
    return value;
  }
  /** `length` bytes as they arrive. */
  async *stream(length: number): AsyncGenerator<Buffer> {
    let left = length;
    while (left > 0) {
      if (!this.current.length && !(await this.more())) throw invalid('文件不完整');
      const chunk = this.current.subarray(0, Math.min(left, this.current.length));
      this.current = this.current.subarray(chunk.length);
      left -= chunk.length;
      yield chunk;
    }
  }
  async close() {
    await this.iterator.return?.();
  }
}

function field(block: Buffer, start: number, length: number) {
  const raw = block.subarray(start, start + length),
    end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString('utf8');
}
function number(block: Buffer, start: number, length: number) {
  // GNU tar writes large numbers in base 256 with the top bit set.
  if (block[start] & 0x80) {
    let value = 0;
    for (let index = start + 1; index < start + length; index++) value = value * 256 + block[index];
    return value;
  }
  const value = parseInt(field(block, start, length).trim() || '0', 8);
  if (!Number.isFinite(value)) throw invalid('文件头无效');
  return value;
}
function parsePax(data: Buffer) {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number(data.subarray(offset, space).toString('latin1'));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) throw invalid('扩展头无效');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8'),
      equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** The entries of a tar archive, in order. Each body must be read (or left alone) before asking for the next. */
export async function* untar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const reader = new ChunkReader(source);
  try {
    let pax: Record<string, string> = {};
    for (;;) {
      const block = await reader.take(BLOCK);
      if (!block || block.every((byte) => byte === 0)) return;
      const stored = number(block, 148, 8);
      let sum = 0;
      for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index];
      if (sum !== stored) throw invalid('校验和不符');
      const type = String.fromCharCode(block[156] || 0x30),
        size = number(block, 124, 12),
        padded = size + ((BLOCK - (size % BLOCK)) % BLOCK);
      if (type === 'x' || type === 'g') {
        if (size > 1024 * 1024) throw invalid('扩展头过大');
        const data = await reader.take(padded);
        if (!data) throw invalid('文件不完整');
        if (type === 'x') pax = parsePax(data.subarray(0, size));
        continue;
      }
      const prefix = field(block, 345, 155),
        name = field(block, 0, 100),
        entrySize = pax.size !== undefined ? Number(pax.size) : size;
      if (!Number.isSafeInteger(entrySize) || entrySize < 0) throw invalid('文件大小无效');
      const entryPadded = entrySize + ((BLOCK - (entrySize % BLOCK)) % BLOCK);
      let left = entryPadded;
      const entry: TarEntry = {
        path: pax.path ?? (prefix ? prefix + '/' + name : name),
        size: entrySize,
        mtime: pax.mtime !== undefined ? Number(pax.mtime) || 0 : number(block, 136, 12),
        mode: number(block, 100, 8) & 0o7777,
        type: type === '0' || type === '7' ? 'file' : type === '5' ? 'directory' : 'other',
        body: async function* () {
          let content = entrySize;
          for await (const chunk of reader.stream(left)) {
            left -= chunk.length;
            if (content <= 0) continue;
            const part = chunk.length > content ? chunk.subarray(0, content) : chunk;
            content -= part.length;
            yield part;
          }
        },
      };
      pax = {};
      yield entry;
      // Whatever the consumer left unread, including the padding.
      for await (const _ of reader.stream(left)) void _;
      left = 0;
    }
  } finally {
    await reader.close();
  }
}
