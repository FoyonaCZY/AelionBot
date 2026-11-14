// What the phone keeps: its device key (non-extractable, in IndexedDB), the computers it paired with, and messages
// written while a computer was offline. Small view state (what was last read) lives in localStorage.
import { generateAgreementKey } from '../../shared/remote/crypto';
import type { ComputerLink } from '../../shared/remote/client';

export interface StoredComputer extends ComputerLink {
  addedAt: string;
  /** Kept until the computer allowed this phone; proves the QR code on the first connection. */
  pairing?: { id: string; secret: string };
}
export interface QueuedMessage {
  id: string;
  botId: string;
  sessionId?: string;
  text: string;
  createdAt: string;
}

const DB = 'aelion-remote';
let database: Promise<IDBDatabase> | undefined;
function open() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function read<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('kv').objectStore('kv').get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
async function write(key: string, value: unknown) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('kv', 'readwrite');
    if (value === undefined) transaction.objectStore('kv').delete(key);
    else transaction.objectStore('kv').put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** This phone's key pair; the private half never leaves the browser's key store. */
export async function deviceKey(): Promise<CryptoKeyPair> {
  const saved = await read<CryptoKeyPair>('device');
  if (saved?.privateKey && saved.publicKey) return saved;
  const created = await generateAgreementKey(false);
  await write('device', created);
  return created;
}

export const loadComputers = async () => (await read<StoredComputer[]>('computers')) || [];
export const saveComputers = (computers: StoredComputer[]) => write('computers', computers);
export const loadCurrent = () => read<string>('current');
export const saveCurrent = (room: string | undefined) => write('current', room);
export const loadQueue = async (room: string) => (await read<QueuedMessage[]>('queue:' + room)) || [];
export const saveQueue = (room: string, queue: QueuedMessage[]) =>
  write('queue:' + room, queue.length ? queue : undefined);

const SEEN_KEY = 'aelion-remote-seen';
/** When the user last looked at each chat, for the unread dots. */
export function lastSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
  } catch {
    return {};
  }
}
export function markSeen(key: string, time = new Date().toISOString()) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...lastSeen(), [key]: time }));
  } catch {
    // Storage is full or unavailable: unread dots are a convenience.
  }
}
