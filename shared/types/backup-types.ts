import type { BotPalette } from '../chat/bot-colors';

/** A backup file the person picked to restore. */
export interface BackupInfo {
  /** Names the picked file in the following restoreBackup call. */
  id: string;
  name: string;
  createdAt: string;
  appVersion: string;
  /** The computer it was made on. */
  device: string;
  bytes: number;
  /** API keys and sign-ins are inside, sealed with a password. */
  secrets: boolean;
}
/** A backup being written or read. */
export interface BackupProgress {
  kind: 'export' | 'restore';
  done: number;
  total: number;
}
/** The data that was current before a restore replaced it. */
interface BackupCopy {
  id: string;
  path: string;
  createdAt: string;
}
/** Settings → 数据. */
export interface BackupOverview {
  /** What a backup made now would hold, before compression. */
  bytes: number;
  files: number;
  copies: BackupCopy[];
  lastRestore?: { at: string; ok: boolean; backupCreatedAt?: string };
}

/** What a Bot file holds, shown before it is imported. */
export interface BotFilePreview {
  /** Names the picked file in the following importBot call. */
  id: string;
  name: string;
  soul: string;
  palette: BotPalette;
  skills: Array<{ name: string; description: string }>;
  /** Long-term memories in the file. */
  memories: number;
  persona: boolean;
  /** The model the Bot used, and whether this computer has it. */
  model?: { provider: string; model: string; available: boolean };
}
