// API keys, connector credentials, sign-ins and the phone-access keys are stored encrypted with the system key
// store, which only this computer and this user can open. A backup carries those files as they are, so they keep
// working when it is restored here. To move them to another computer, the person sets a password: every secret is
// then also written to the backup sealed with that password, and a restore encrypts them again with the key store
// of the computer it runs on.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../../shared/errors';
import { atomicJson } from '../storage/store';
import { invalidBackup } from './tar';

export interface SecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}
/** Where one of the files holding secrets is; undefined when there is none. */
type Locate = (
  name: 'state.sqlite' | 'connectors.json' | 'mcp-auth.json' | 'remote.json' | 'vault.json',
) => string | undefined;
/** Returns the text to store in place of a secret, or undefined to leave it. */
type Replace = (cipher: string) => string | undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Visits the secret at `key` of `holder`; true when it was replaced. */
function visit(holder: Record<string, unknown> | undefined, key: string, replace: Replace) {
  const cipher = holder?.[key];
  if (!holder || typeof cipher !== 'string' || !cipher) return false;
  const next = replace(cipher);
  if (next === undefined || next === cipher) return false;
  holder[key] = next;
  return true;
}

/** Model API keys: the provider list and the legacy single model, in the state database's root row. */
function visitState(file: string, replace: Replace) {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT value FROM parts WHERE key='layout'").get() as { value: string } | undefined;
    if (!row) return;
    const layout = JSON.parse(row.value) as { root?: Record<string, unknown> },
      root = record(layout.root);
    let changed = visit(record(root?.model), 'encryptedKey', replace);
    for (const provider of Array.isArray(root?.providers) ? root.providers : [])
      changed = visit(record(provider), 'encryptedKey', replace) || changed;
    if (changed) db.prepare("UPDATE parts SET value=? WHERE key='layout'").run(JSON.stringify(layout));
  } finally {
    db.close();
  }
}
function visitJson(file: string, each: (data: Record<string, unknown>) => boolean) {
  let data: Record<string, unknown> | undefined;
  try {
    data = record(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')));
  } catch {
    return;
  }
  if (data && each(data)) atomicJson(file, data);
}
function visitAll(locate: Locate, replace: Replace) {
  const state = locate('state.sqlite');
  if (state && existsSync(state)) visitState(state, replace);
  const connectors = locate('connectors.json');
  if (connectors && existsSync(connectors))
    visitJson(connectors, (data) => {
      let changed = false;
      for (const connector of Array.isArray(data.connectors) ? data.connectors : [])
        changed = visit(record(connector), 'secret', replace) || changed;
      return changed;
    });
  const auth = locate('mcp-auth.json');
  if (auth && existsSync(auth))
    visitJson(auth, (data) => {
      let changed = false;
      for (const group of [record(data.servers), record(data.clients)])
        for (const key of Object.keys(group || {})) changed = visit(group, key, replace) || changed;
      return changed;
    });
  const remote = locate('remote.json');
  if (remote && existsSync(remote))
    visitJson(remote, (data) => {
      let changed = visit(record(data.keys), 'secret', replace);
      for (const device of Array.isArray(data.devices) ? data.devices : [])
        changed = visit(record(device), 'push', replace) || changed;
      return changed;
    });
  const vault = locate('vault.json');
  if (vault && existsSync(vault))
    visitJson(vault, (data) => {
      let changed = false;
      for (const item of Array.isArray(data.items) ? data.items : [])
        changed = visit(record(item), 'encryptedFields', replace) || changed;
      return changed;
    });
}

/** Every stored secret this computer can read, by its stored text. */
export function collectSecrets(locate: Locate, codec: SecretCodec) {
  const plain: Record<string, string> = {};
  visitAll(locate, (cipher) => {
    try {
      plain[cipher] = codec.decrypt(cipher);
    } catch {
      /* Already unreadable here: there is nothing to carry over. */
    }
    return undefined;
  });
  return plain;
}

/**
 * Makes the secrets of restored files readable on this computer: those found in `plain` are encrypted again with
 * its key store. The rest are left as they are; what cannot be read is counted, and the app asks for it again.
 */
export function rewrapSecrets(locate: Locate, codec: SecretCodec, plain: Record<string, string>) {
  let rewrapped = 0,
    unreadable = 0;
  visitAll(locate, (cipher) => {
    if (Object.hasOwn(plain, cipher)) {
      rewrapped++;
      return codec.encrypt(plain[cipher]);
    }
    try {
      codec.decrypt(cipher);
    } catch {
      unreadable++;
    }
    return undefined;
  });
  return { rewrapped, unreadable };
}

export interface SealedSecrets {
  version: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}
const SCRYPT = { n: 1 << 15, r: 8, p: 1 };
const deriveKey = (password: string, salt: Buffer, cost: { n: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      32,
      { N: cost.n, r: cost.r, p: cost.p, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

/** The secrets encrypted with a key derived from `password` (scrypt, AES-256-GCM). */
export async function sealSecrets(plain: Record<string, string>, password: string): Promise<SealedSecrets> {
  const salt = randomBytes(16),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', await deriveKey(password, salt, SCRYPT), iv),
    data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return {
    version: 1,
    kdf: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export async function openSecrets(sealed: SealedSecrets, password: string): Promise<Record<string, string>> {
  const cost = { n: sealed?.n, r: sealed?.r, p: sealed?.p };
  if (
    sealed?.version !== 1 ||
    sealed.kdf !== 'scrypt' ||
    ![sealed.salt, sealed.iv, sealed.tag, sealed.data].every((value) => typeof value === 'string') ||
    // The cost comes from the file: refuse values that would only waste memory and time.
    !Number.isInteger(cost.n) ||
    cost.n < 1 << 14 ||
    cost.n > 1 << 17 ||
    cost.r !== 8 ||
    cost.p !== 1
  )
    throw invalidBackup('secrets.json');
  const key = await deriveKey(password, Buffer.from(sealed.salt, 'base64'), cost);
  let text: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    text = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError('backup.password_wrong', '密码不正确');
  }
  const plain = record(JSON.parse(text));
  if (!plain || Object.values(plain).some((value) => typeof value !== 'string')) throw invalidBackup('secrets.json');
  return plain as Record<string, string>;
}
