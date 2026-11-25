import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { dialog } from 'electron';
import { AppError } from '../../shared/errors';
import { maskPreview } from '../../shared/vault-refs';
import type { IpcContext } from './context';

const MAX_SSH_KEY_BYTES = 256 * 1024;
const MAX_SSH_PUB_BYTES = 32 * 1024;

const OPENSSH_KEY_RE = new RegExp(
  `${'-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'}([\\s\\S]*?)${'-----END ' + 'OPENSSH PRIVATE KEY-----'}`,
);

function isEncryptedPrivateKey(content: string): boolean {
  if (/Proc-Type:\s*4,\s*ENCRYPTED/i.test(content)) return true;
  const openSshMatch = OPENSSH_KEY_RE.exec(content);
  if (!openSshMatch) return false;
  try {
    const raw = Buffer.from(openSshMatch[1].replace(/\s+/g, ''), 'base64');
    const magic = 'openssh-key-v1\0';
    if (!raw.subarray(0, magic.length).equals(Buffer.from(magic, 'utf8'))) return false;
    let offset = magic.length;
    if (offset + 4 > raw.length) return false;
    const cipherLen = raw.readUInt32BE(offset);
    offset += 4;
    if (offset + cipherLen > raw.length) return false;
    const cipherName = raw.subarray(offset, offset + cipherLen).toString('utf8');
    return Boolean(cipherName && cipherName !== 'none');
  } catch {
    return false;
  }
}

function sshFingerprint(privateKeyContent: string, publicKey?: string): string {
  if (publicKey) {
    const line = publicKey
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item && !item.startsWith('#'));
    const parts = line?.split(/\s+/);
    if (parts && parts.length >= 2) {
      try {
        const blob = Buffer.from(parts[1], 'base64');
        if (blob.length) {
          const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
          return `SHA256:${digest}`;
        }
      } catch {}
    }
  }
  const digest = createHash('sha256').update(privateKeyContent.trim(), 'utf8').digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export function registerVault(ctx: IpcContext) {
  const { handle } = ctx;

  handle('vaultOverview', () => {
    if (!ctx.vault) return { available: false, items: [] };
    return ctx.vault.overview();
  });

  handle('vaultSave', (input) => {
    if (!ctx.vault) throw new AppError('vault.encryption_unavailable', '保险库服务未启用');
    const saved = ctx.vault.save(input);
    ctx.changed();
    return saved;
  });

  handle('vaultDelete', (id) => {
    if (!ctx.vault) throw new AppError('vault.encryption_unavailable', '保险库服务未启用');
    if (typeof id !== 'string' || !id.trim()) throw new AppError('vault.ref_invalid', '无效的保险库条目 ID');
    ctx.vault.delete(id);
    ctx.changed();
  });

  handle('vaultReveal', (id) => {
    if (!ctx.vault) throw new AppError('vault.encryption_unavailable', '保险库服务未启用');
    if (typeof id !== 'string' || !id.trim()) throw new AppError('vault.ref_invalid', '无效的保险库条目 ID');
    return ctx.vault.reveal(id);
  });

  handle('vaultAudit', (query) => {
    if (!ctx.vault) return [];
    return ctx.vault.audit(query);
  });

  handle('vaultImportSshKey', async () => {
    if (!ctx.vault) throw new AppError('vault.encryption_unavailable', '保险库服务未启用');
    if (!ctx.window || ctx.window.isDestroyed()) throw new AppError('vault.ref_invalid', '当前窗口不可用');

    const defaultSsh = join(homedir(), '.ssh');
    const selected = await dialog.showOpenDialog(ctx.window, {
      title: '选择 SSH 私钥文件',
      defaultPath: existsSync(defaultSsh) ? defaultSsh : homedir(),
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;

    const filePath = selected.filePaths[0];
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SSH_KEY_BYTES) {
      throw new AppError('vault.ref_invalid', 'SSH 私钥文件为空或超过 256 KB 限制');
    }
    const content = readFileSync(filePath, 'utf8');
    if (!content.trim() || content.includes('\0')) {
      throw new AppError('vault.ref_invalid', '所选文件不是有效的文本私钥文件');
    }

    let publicKey: string | undefined;
    const pubPath = `${filePath}.pub`;
    try {
      if (existsSync(pubPath)) {
        const pubStat = statSync(pubPath);
        if (pubStat.isFile() && pubStat.size > 0 && pubStat.size <= MAX_SSH_PUB_BYTES) {
          const pubRaw = readFileSync(pubPath, 'utf8').trim();
          if (pubRaw && !pubRaw.includes('\0')) publicKey = pubRaw;
        }
      }
    } catch {}

    const token = ctx.vault.stageImportSecret(content);
    const preview = maskPreview(content, 'multiline_key');
    const fingerprint = sshFingerprint(content, publicKey);
    const encrypted = isEncryptedPrivateKey(content);

    return {
      token,
      fileName: basename(filePath),
      fingerprint,
      preview,
      ...(publicKey ? { publicKey } : {}),
      encrypted,
    };
  });
}
