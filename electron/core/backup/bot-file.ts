// A Bot as one .aelionbot file (a zip): its name, SOUL.md, look, voice, the model it used (as a hint, never a key),
// its own skills, its personality and, when asked for, its long-term memories. Chat history never goes in.
// A file may come from anyone, so reading one checks every size, name and path before anything is used.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { normalizeBotPalette, type BotPalette } from '../../../shared/chat/bot-colors';
import { normalizeSoul } from '../../../shared/chat/bot-soul';
import { reasoningEffort as cleanReasoning } from '../../../shared/chat/reasoning';
import { AppError } from '../../../shared/errors';
import { parseSkill } from '../extensions/skill-library';
import { parsePortablePersona, type PortablePersona } from '../persona/persona-transfer';

export const BOT_FILE_EXTENSION = 'aelionbot';

/** The model a Bot used: enough to find the same one on another computer. */
export interface PortableModel {
  provider: string;
  model: string;
  contextTokens?: number;
  reasoningEffort?: string;
}
interface PortableSkill {
  /** Its folder name. */
  folder: string;
  name: string;
  description: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
}
export interface BotFileContent {
  name: string;
  soul: string;
  palette: BotPalette;
  voice?: string;
  reasoningEffort?: string;
  model?: PortableModel;
  imageModel?: PortableModel;
  persona?: PortablePersona;
  skills: PortableSkill[];
  /** An aelion-memories document (see MemoryAdmin.exportData). */
  memories?: string;
}

const MAX_FILE = 48 * 1024 * 1024,
  MAX_ENTRY = 16 * 1024 * 1024,
  MAX_TOTAL = 64 * 1024 * 1024,
  MAX_ENTRIES = 4000,
  MAX_SKILLS = 200,
  MAX_SKILL_FILES = 500;
const invalid = (detail: string) => new AppError('bot_file.invalid', '这不是有效的 Bot 文件', { cause: detail });

export function packBotFile(content: BotFileContent, meta: { appVersion: string; exportedAt: string }) {
  const files: Record<string, Uint8Array> = {
    'bot.json': strToU8(
      JSON.stringify(
        {
          format: 'aelion-bot',
          version: 1,
          appVersion: meta.appVersion,
          exportedAt: meta.exportedAt,
          bot: {
            name: content.name,
            ...content.palette,
            ...(content.voice ? { voice: content.voice } : {}),
            ...(content.reasoningEffort ? { reasoningEffort: content.reasoningEffort } : {}),
            ...(content.model ? { model: content.model } : {}),
            ...(content.imageModel ? { imageModel: content.imageModel } : {}),
          },
          ...(content.persona ? { persona: content.persona } : {}),
          skills: content.skills.map(({ folder, name, description }) => ({ folder, name, description })),
        },
        null,
        2,
      ),
    ),
    'SOUL.md': strToU8(content.soul),
  };
  for (const skill of content.skills)
    for (const file of skill.files) files[`skills/${skill.folder}/${file.path}`] = file.bytes;
  if (content.memories) files['memories.json'] = strToU8(content.memories);
  return zipSync(files, { level: 6 });
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const sensitive = (name: string) =>
  name === '.env' || (name.startsWith('.env.') && name !== '.env.example') || /\.(key|pem|p12|pfx)$/i.test(name);
/** A file's path inside its skill folder, or undefined when it must not be written. */
function skillPath(path: string) {
  const segments = path.split('/');
  if (
    !path ||
    path.length > 400 ||
    segments.length > 10 ||
    segments.some(
      (segment) =>
        !segment ||
        segment.length > 120 ||
        segment === '.' ||
        segment === '..' ||
        /[\\:*?"<>|\u0000-\u001f]/.test(segment) ||
        /[. ]$/.test(segment) ||
        (segment.startsWith('.') && segment !== '.env.example') ||
        ['node_modules', '__pycache__', 'venv'].includes(segment),
    ) ||
    sensitive(segments[segments.length - 1])
  )
    return undefined;
  return segments.join('/');
}
function model(value: unknown): PortableModel | undefined {
  const input = record(value);
  if (!input || typeof input.provider !== 'string' || typeof input.model !== 'string') return;
  const provider = input.provider.trim().slice(0, 80),
    name = input.model.trim().slice(0, 256),
    effort = cleanReasoning(input.reasoningEffort);
  if (!provider || !name) return;
  return {
    provider,
    model: name,
    ...(Number.isInteger(input.contextTokens) ? { contextTokens: input.contextTokens as number } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/** Reads a Bot file. Whatever it returns is safe to create a Bot from; what is not is left out or refused. */
export function unpackBotFile(bytes: Uint8Array): BotFileContent {
  if (bytes.length > MAX_FILE) throw new AppError('bot_file.too_large', 'Bot 文件超过 48 MB');
  let entries: Record<string, Uint8Array>;
  let count = 0,
    total = 0;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith('/')) return false;
        total += file.originalSize;
        if (++count > MAX_ENTRIES || file.originalSize > MAX_ENTRY || total > MAX_TOTAL)
          throw new AppError('bot_file.too_large', 'Bot 文件里的内容太多或太大');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid('不是 zip 文件或已损坏');
  }
  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = record(JSON.parse(strFromU8(entries['bot.json'] || new Uint8Array())));
  } catch {
    /* Reported below. */
  }
  if (!manifest || manifest.format !== 'aelion-bot') throw invalid('缺少 bot.json');
  if (typeof manifest.version !== 'number' || manifest.version > 1)
    throw new AppError('bot_file.newer', '这个 Bot 文件来自更新的版本，请先更新 AelionBot');
  const bot = record(manifest.bot),
    name = typeof bot?.name === 'string' ? bot.name.trim() : '',
    soul = normalizeSoul(entries['SOUL.md'] ? strFromU8(entries['SOUL.md']) : '');
  if (!bot || !name || name.length > 80) throw invalid('名字无效');
  if (soul === undefined) throw invalid('SOUL.md 过长');
  let palette: BotPalette | undefined;
  try {
    palette = normalizeBotPalette({ color: bot.color, avatarStyle: bot.avatarStyle });
  } catch {
    /* An unknown look falls back to a colour the app picks. */
  }
  const voice = typeof bot.voice === 'string' ? bot.voice.trim() : '',
    effort = cleanReasoning(bot.reasoningEffort);

  const folders = new Map<string, Array<{ path: string; bytes: Uint8Array }>>();
  for (const [path, data] of Object.entries(entries)) {
    const match = /^skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,80})\/(.+)$/.exec(path),
      inner = match && skillPath(match[2]);
    if (!match || !inner || /[. ]$/.test(match[1])) continue;
    const files = folders.get(match[1]) || [];
    folders.set(match[1], files);
    files.push({ path: inner, bytes: data });
  }
  const skills: PortableSkill[] = [];
  for (const [folder, files] of folders) {
    if (skills.length >= MAX_SKILLS) break;
    const main = files.find((file) => file.path === 'SKILL.md');
    if (!main || main.bytes.length > 256 * 1024 || files.length > MAX_SKILL_FILES) continue;
    try {
      const parsed = parseSkill(strFromU8(main.bytes), folder),
        display = parsed.metadata['aelion-display-name'];
      skills.push({
        folder,
        name: typeof display === 'string' && display.trim() ? display.trim().slice(0, 150) : parsed.name,
        description: parsed.description,
        files,
      });
    } catch {
      /* A skill that cannot be read is left out. */
    }
  }
  let memories: string | undefined;
  if (entries['memories.json'] && entries['memories.json'].length <= 8 * 1024 * 1024) {
    const text = strFromU8(entries['memories.json']);
    if (memoryCount(text)) memories = text;
  }
  const persona = parsePortablePersona(manifest.persona);
  return {
    name,
    soul,
    palette: palette || { color: '#8b6bea' },
    ...(voice && voice.length <= 120 && !/[\u0000-\u001f]/.test(voice) ? { voice } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(model(bot.model) ? { model: model(bot.model) } : {}),
    ...(model(bot.imageModel) ? { imageModel: model(bot.imageModel) } : {}),
    ...(persona ? { persona } : {}),
    skills,
    ...(memories ? { memories } : {}),
  };
}

/** How many memories an aelion-memories document holds; 0 when it is not one. */
export function memoryCount(text: string | undefined) {
  if (!text) return 0;
  try {
    const value = record(JSON.parse(text));
    return value?.format === 'aelion-memories' && Array.isArray(value.items) ? value.items.length : 0;
  } catch {
    return 0;
  }
}

/** A name no Bot has yet: the wanted one, or it with the first free number. */
export function freeBotName(wanted: string, taken: readonly string[]) {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(wanted.toLowerCase())) return wanted;
  for (let index = 2; ; index++) {
    const suffix = ' ' + index,
      name = wanted.slice(0, 80 - suffix.length) + suffix;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/**
 * A skill's SKILL.md for a Bot that was just created from a file: the IDs the file's Bot gave it would collide with
 * that Bot's own skills when both are on one computer, so they are dropped and the app assigns new ones.
 */
export function detachSkillText(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ''));
  if (!match) return text;
  const cleaned = match[1]
    .split(/\r?\n/)
    .filter((line) => !/^\s+aelion-(id|bot-id)\s*:/.test(line))
    .join('\n');
  return text.replace(/^﻿/, '').replace(match[1], () => cleaned);
}
