// Zero-dependency RFC 6238 TOTP generator using node:crypto.
import { createHmac } from 'node:crypto';
import { AppError } from '../../../shared/errors';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_PADDING_LENGTHS = new Set([0, 1, 3, 4, 6]);
const INVALID_UNPADDED_REMAINDERS = new Set([1, 3, 6]);

export interface TotpOptions {
  timestampMs?: number;
  period?: number;
  digits?: number;
  algorithm?: 'sha1' | 'sha256';
}

/** Decodes an RFC 4648 Base32 secret (ignoring spaces/hyphens and case), throwing `vault.totp_invalid` on bad input. */
function decodeBase32(secret: string): Buffer {
  if (typeof secret !== 'string') {
    throw new AppError('vault.totp_invalid', 'TOTP 密钥必须是 Base32 字符串');
  }
  const normalized = secret.replace(/[\s-]+/g, '').toUpperCase();
  if (!normalized || !/^[A-Z2-7]+=*$/.test(normalized)) {
    throw new AppError('vault.totp_invalid', 'TOTP 密钥不是有效的 Base32 格式');
  }
  const firstPad = normalized.indexOf('=');
  const data = firstPad === -1 ? normalized : normalized.slice(0, firstPad);
  const padCount = firstPad === -1 ? 0 : normalized.length - firstPad;
  if (
    !data ||
    (padCount > 0 && (normalized.length % 8 !== 0 || !VALID_PADDING_LENGTHS.has(padCount))) ||
    (padCount === 0 && INVALID_UNPADDED_REMAINDERS.has(data.length % 8))
  ) {
    throw new AppError('vault.totp_invalid', 'TOTP 密钥填充或长度无效');
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of data) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new AppError('vault.totp_invalid', 'TOTP 密钥包含非法 Base32 字符');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (!bytes.length) {
    throw new AppError('vault.totp_invalid', 'TOTP 密钥解码结果为空');
  }
  return Buffer.from(bytes);
}

/** Validates that a TOTP secret is a decodable Base32 string. */
export function validateTotpSecret(secret: string): void {
  decodeBase32(secret);
}

/** Generates a current RFC 6238 TOTP code (default: 30s period, 6 digits, HMAC-SHA1). */
export function generateTotp(secret: string, options: TotpOptions = {}): string {
  const key = decodeBase32(secret);
  const period = options.period ?? 30;
  const digits = options.digits ?? 6;
  const algorithm = options.algorithm ?? 'sha1';
  const timestampMs = options.timestampMs ?? Date.now();

  if (!Number.isInteger(period) || period <= 0) {
    throw new AppError('vault.totp_invalid', 'TOTP 时间步长无效');
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new AppError('vault.totp_invalid', 'TOTP 位数必须为 6 到 8 位');
  }
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new AppError('vault.totp_invalid', 'TOTP 时间戳无效');
  }
  if (algorithm !== 'sha1' && algorithm !== 'sha256') {
    throw new AppError('vault.totp_invalid', '不支持的 TOTP 哈希算法');
  }

  const counter = BigInt(Math.floor(timestampMs / 1000 / period));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const hmac = createHmac(algorithm, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const mod = 10 ** digits;
  return (binary % mod).toString().padStart(digits, '0');
}
