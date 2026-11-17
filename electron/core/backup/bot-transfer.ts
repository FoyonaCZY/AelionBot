// Turns a Bot of this computer into the content of a Bot file, and such content into a new Bot.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Bot, ModelProvider, ModelSelection } from '../../../shared/types/core';
import type { SkillLibrary } from '../extensions/skill-library';
import { botScope } from '../memory/memory-scope';
import type { PersonaService } from '../persona/persona-service';
import { adoptPersona, portablePersona } from '../persona/persona-transfer';
import type { Store } from '../storage/store';
import { detachSkillText, freeBotName, memoryCount, type BotFileContent, type PortableModel } from './bot-file';

export interface BotTransferDeps {
  store: Store;
  dataDir: string;
  skills: SkillLibrary;
  providers: { list(): ModelProvider[]; selection(value: unknown): ModelSelection | undefined };
  persona?: PersonaService;
  memory: { exportData(scope?: string): string; importData(text: string, scope: string): unknown };
}

function portableModel(deps: BotTransferDeps, selection?: ModelSelection): PortableModel | undefined {
  const provider = selection && deps.providers.list().find((item) => item.id === selection.providerId);
  return provider && selection
    ? {
        provider: provider.name,
        model: selection.model,
        contextTokens: selection.contextTokens,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    : undefined;
}
/** The same model on this computer: a provider of that name that lists it. */
export function localModel(deps: BotTransferDeps, hint?: PortableModel): ModelSelection | undefined {
  if (!hint) return;
  const provider = deps.providers
      .list()
      .find(
        (item) =>
          item.name.trim().toLowerCase() === hint.provider.toLowerCase() &&
          item.models.some((entry) => entry.id === hint.model),
      ),
    known = provider?.models.find((entry) => entry.id === hint.model);
  if (!provider) return;
  try {
    return deps.providers.selection({
      providerId: provider.id,
      model: hint.model,
      contextTokens: known?.contextTokens || hint.contextTokens || 128000,
      ...(hint.reasoningEffort ? { reasoningEffort: hint.reasoningEffort } : {}),
    });
  } catch {
    return;
  }
}

/** What a Bot file of this Bot holds. Its memories go in only when asked for. */
export function exportBotContent(deps: BotTransferDeps, botId: string, memories: boolean): BotFileContent {
  const bot = deps.store.bot(botId),
    model = portableModel(deps, bot.model),
    imageModel = portableModel(deps, bot.imageModel),
    persona = deps.persona && portablePersona(deps.persona, bot.id),
    text = memories ? deps.memory.exportData(botScope(bot.id)) : undefined;
  return {
    name: bot.name,
    soul: bot.soul,
    palette: { color: bot.color, ...(bot.avatarStyle ? { avatarStyle: bot.avatarStyle } : {}) },
    ...(bot.voice ? { voice: bot.voice } : {}),
    ...(bot.reasoningEffort ? { reasoningEffort: bot.reasoningEffort } : {}),
    ...(model ? { model } : {}),
    ...(imageModel ? { imageModel } : {}),
    ...(persona ? { persona } : {}),
    skills: deps.skills
      .list(bot.id, true)
      .filter((skill) => skill.botId === bot.id)
      .map((skill) => {
        const bundle = deps.skills.bundle(bot.id, skill.id);
        return {
          folder: bundle.folder,
          name: skill.name,
          description: skill.description,
          files: bundle.files.map((file) => ({ path: file.path, bytes: file.bytes })),
        };
      }),
    ...(memoryCount(text) ? { memories: text } : {}),
  };
}

/**
 * Creates a Bot from the content of a Bot file. The Bot itself is what matters: a skill, the personality or the
 * memories that cannot be brought over are left out instead of undoing it.
 */
export function importBotContent(deps: BotTransferDeps, content: BotFileContent, memories: boolean): Bot {
  const model = localModel(deps, content.model),
    imageModel = localModel(deps, content.imageModel),
    reasoningEffort = content.reasoningEffort ?? deps.store.data.defaultModel?.reasoningEffort;
  const bot = deps.store.createBot(
    freeBotName(
      content.name,
      deps.store.data.bots.map((item) => item.name),
    ),
    content.soul,
    content.palette.color,
    content.palette.avatarStyle,
    {
      ...(model ? { model } : {}),
      ...(imageModel ? { imageModel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(content.voice ? { voice: content.voice } : {}),
    },
  );
  const root = join(deps.dataDir, 'bots', bot.id, 'skills');
  for (const skill of content.skills)
    try {
      for (const file of skill.files) {
        const target = join(root, skill.folder, ...file.path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          file.path === 'SKILL.md' ? detachSkillText(Buffer.from(file.bytes).toString('utf8')) : file.bytes,
          { mode: 0o600 },
        );
      }
    } catch {
      /* This skill stays behind. */
    }
  if (content.skills.length) deps.skills.refresh();
  try {
    if (content.persona && deps.persona) adoptPersona(deps.persona, bot.id, content.persona);
  } catch {
    /* The Bot starts with a default personality. */
  }
  try {
    if (memories && content.memories) deps.memory.importData(content.memories, botScope(bot.id));
  } catch {
    /* The Bot starts without them. */
  }
  return bot;
}
